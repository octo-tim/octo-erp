import type { TransactionContext } from '@/server/core/context';
import { AppError } from '@/server/core/errors';
import { requirePermission, requirePermissionUnlessApproval } from '@/server/modules/rbac/service';
import * as audit from '@/server/modules/audit/service';
import * as matrix from '@/server/modules/approval/matrix';
import * as ledger from '@/server/modules/inventory/ledger';
import * as valuation from '@/server/modules/inventory/valuation';
import { checkSafetyStock } from '@/server/modules/inventory/safety-stock';
import * as accountingPeriod from '@/server/modules/accounting/period';
import * as postingRule from '@/server/modules/accounting/posting-rule';
import * as journal from '@/server/modules/accounting/journal';
import * as receivables from './receivable';
import * as conversion from './conversion';
import { priceLines, type PricedLineInput } from './pricing';
import { nextDocNo, DOC_TYPES } from '@/server/modules/numbering/service';
import * as reversal from '@/server/modules/documents/reversal';
import * as approvalState from '@/server/modules/documents/approval-state';
import { idempotent } from '@/server/core/idempotency';
import { assertVersion } from '@/server/core/state-machine';
import { amount, D, floorTo, quantity, ZERO } from '@/lib/money';
import { businessDate, toDateOnly } from '@/lib/dates';

/**
 * SLS-05 / SLS-11 — sales documents and sales returns.
 *
 * E2E-01: confirming a sales document does four things in ONE transaction (INT-06) — it
 * issues the stock, raises the receivable, posts the journal entry, and writes the audit
 * trail. A failure in any of them leaves none of them.
 *
 * A return (RETURN_SALES) is the same shape with positive quantities and the opposite
 * effects, linked to the original document and line (SLS-11). It is never a negative sale.
 */

export type SalesDocType = 'SALES' | 'RETURN_SALES';

export interface LineInput extends PricedLineInput {
  itemId: string;
  description?: string;
  /** SLS-04: the sales-order line this line delivers against */
  sourceLineId?: string;
  /** SLS-11: the original sales line being returned */
  originalLineId?: string;
}

export interface DocumentInput {
  docType?: SalesDocType;
  docDate?: string;
  partnerId: string;
  warehouseId: string;
  divisionId?: string;
  note?: string;
  originalId?: string;
  lines: LineInput[];
}

const NUMBERING: Record<SalesDocType, string> = {
  SALES: DOC_TYPES.SALES,
  RETURN_SALES: DOC_TYPES.RETURN_SALES,
};

// ── write ──

export async function create(ctx: TransactionContext, input: DocumentInput) {
  requirePermission(ctx.actor, 'sales.write');
  const docType = input.docType ?? 'SALES';
  const docDate = input.docDate ?? businessDate(ctx.now);

  // SLS-12 / DEC-04: a closed period refuses creation as well as confirmation
  await accountingPeriod.assertOpen(ctx, docDate);
  await assertScope(ctx, input.warehouseId, input.divisionId);
  await validateLines(ctx, input.lines);

  if (docType === 'RETURN_SALES') await validateReturn(ctx, input);

  const { lines, totals } = priceLines(input.lines);
  const docNo = await nextDocNo(ctx, NUMBERING[docType], docDate);

  const doc = await ctx.tx.salesDocument.create({
    data: {
      docNo,
      docType,
      docDate: toDateOnly(docDate),
      partnerId: input.partnerId,
      warehouseId: input.warehouseId,
      divisionId: input.divisionId ?? null,
      status: 'DRAFT',
      note: input.note ?? null,
      originalId: input.originalId ?? null,
      supplyAmount: totals.supplyAmount,
      vatAmount: totals.vatAmount,
      totalAmount: totals.totalAmount,
      createdById: ctx.actor.userId,
      lines: {
        create: lines.map((l, i) => ({
          lineNo: i + 1,
          itemId: input.lines[i]!.itemId,
          description: input.lines[i]!.description ?? null,
          quantity: l.quantity,
          unitPrice: l.unitPrice,
          taxType: l.taxType,
          supplyAmount: l.supplyAmount,
          vatAmount: l.vatAmount,
          originalLineId: input.lines[i]!.originalLineId ?? null,
        })),
      },
    },
    include: { lines: { orderBy: { lineNo: 'asc' } } },
  });

  // SLS-04: record the conversion from the sales order, which is what makes the order's
  // remaining quantity move. Done after creation so the target line ids exist.
  for (const [i, line] of input.lines.entries()) {
    if (!line.sourceLineId) continue;
    const orderLine = await ctx.tx.salesOrderLine.findUniqueOrThrow({
      where: { id: line.sourceLineId },
    });
    await conversion.reserve(
      ctx,
      {
        sourceType: 'SALES_ORDER',
        sourceId: orderLine.orderId,
        sourceLineId: line.sourceLineId,
        targetType: 'SALES',
        targetId: doc.id,
        targetLineId: doc.lines[i]!.id,
        quantity: line.quantity,
        label: `${i + 1}행`,
      },
      orderLine.quantity.toString(),
    );
    await refreshOrderStatus(ctx, orderLine.orderId);
  }

  await audit.record(ctx, {
    action: 'sales.create',
    entityType: 'SalesDocument',
    entityId: doc.id,
    after: { docNo, docType, docDate, totalAmount: totals.totalAmount, lines: lines.length },
  });
  return doc;
}

export async function update(ctx: TransactionContext, id: string, input: DocumentInput, version: number) {
  requirePermission(ctx.actor, 'sales.write');
  const before = await ctx.tx.salesDocument.findUniqueOrThrow({ where: { id } });
  assertVersion('매출전표', before.version, version);
  if (before.status !== 'DRAFT') {
    throw new AppError('IMMUTABLE', '작성 중인 전표만 수정할 수 있습니다.', { status: before.status });
  }

  const docDate = input.docDate ?? before.docDate.toISOString().slice(0, 10);
  await accountingPeriod.assertOpen(ctx, docDate);
  await assertScope(ctx, input.warehouseId, input.divisionId);
  await validateLines(ctx, input.lines);

  const { lines, totals } = priceLines(input.lines);

  // the old lines' conversions are released before the new ones are recorded
  await conversion.release(ctx, 'SALES', id);
  await ctx.tx.salesDocumentLine.deleteMany({ where: { documentId: id } });

  const after = await ctx.tx.salesDocument.update({
    where: { id },
    data: {
      docDate: toDateOnly(docDate),
      partnerId: input.partnerId,
      warehouseId: input.warehouseId,
      divisionId: input.divisionId ?? null,
      note: input.note ?? null,
      supplyAmount: totals.supplyAmount,
      vatAmount: totals.vatAmount,
      totalAmount: totals.totalAmount,
      version: { increment: 1 },
      lines: {
        create: lines.map((l, i) => ({
          lineNo: i + 1,
          itemId: input.lines[i]!.itemId,
          description: input.lines[i]!.description ?? null,
          quantity: l.quantity,
          unitPrice: l.unitPrice,
          taxType: l.taxType,
          supplyAmount: l.supplyAmount,
          vatAmount: l.vatAmount,
          originalLineId: input.lines[i]!.originalLineId ?? null,
        })),
      },
    },
    include: { lines: { orderBy: { lineNo: 'asc' } } },
  });

  for (const [i, line] of input.lines.entries()) {
    if (!line.sourceLineId) continue;
    const orderLine = await ctx.tx.salesOrderLine.findUniqueOrThrow({
      where: { id: line.sourceLineId },
    });
    await conversion.reserve(
      ctx,
      {
        sourceType: 'SALES_ORDER',
        sourceId: orderLine.orderId,
        sourceLineId: line.sourceLineId,
        targetType: 'SALES',
        targetId: id,
        targetLineId: after.lines[i]!.id,
        quantity: line.quantity,
        label: `${i + 1}행`,
      },
      orderLine.quantity.toString(),
    );
    await refreshOrderStatus(ctx, orderLine.orderId);
  }

  await audit.record(ctx, {
    action: 'sales.update',
    entityType: 'SalesDocument',
    entityId: id,
    before: { totalAmount: before.totalAmount.toString() },
    after: { totalAmount: totals.totalAmount },
  });
  return after;
}

/**
 * E2E-01 — the whole effect of a sale, in one transaction:
 * stock ledger, receivable, journal entry, audit, notification.
 */
export async function confirm(ctx: TransactionContext, id: string, version: number) {
  requirePermissionUnlessApproval(ctx, 'sales.confirm');

  return idempotent(ctx, `sales.confirm:${id}`, async () => {
    await ctx.tx.$queryRawUnsafe('SELECT id FROM "SalesDocument" WHERE id = $1 FOR UPDATE', id);

    const doc = await ctx.tx.salesDocument.findUniqueOrThrow({
      where: { id },
      include: { lines: { orderBy: { lineNo: 'asc' } }, partner: true },
    });
    assertVersion('매출전표', doc.version, version);
    if (doc.status !== 'DRAFT' && doc.status !== 'PENDING_APPROVAL') {
      throw new AppError('INVALID_TRANSITION', `현재 상태(${doc.status})의 전표는 확정할 수 없습니다.`);
    }

    const docDate = doc.docDate.toISOString().slice(0, 10);
    await accountingPeriod.assertOpen(ctx, docDate);
    await valuation.assertPeriodOpen(ctx, docDate);

    // DEC-03: an approval-required document is confirmed by the approval module, not here
    const req = await matrix.requirement(ctx, doc.docType, doc.totalAmount.toString(), docDate);
    if (req.required && !ctx.viaApproval) {
      throw new AppError('APPROVAL_REQUIRED', `${req.reason}. 결재 상신 후 승인되면 확정됩니다.`, {
        policyVersionId: req.policyVersionId,
      });
    }

    const isReturn = doc.docType === 'RETURN_SALES';

    // SLS-08 / DEC-03: the credit limit is checked against what the balance WILL be
    if (!isReturn) await assertCreditLimit(ctx, doc.partnerId, doc.totalAmount.toString());

    // 1. stock: a sale issues, a return receives back
    const cost = await postStock(ctx, doc, isReturn);

    // 2. receivable: a sale raises one, a return reduces the original
    await receivables.raise(ctx, {
      documentId: doc.id,
      partnerId: doc.partnerId,
      docDate: doc.docDate,
      amount: doc.totalAmount.toString(),
      isReturn,
      originalDocumentId: doc.originalId,
    });

    // 3. accounting (ACC-03): the rule decides the shape, we supply the figures
    await postingRule.post(ctx, isReturn ? 'RETURN_SALES' : 'SALES', {
      source: { sourceType: doc.docType, sourceId: doc.id },
      entryDate: docDate,
      amounts: {
        supply: doc.supplyAmount.toString(),
        vat: doc.vatAmount.toString(),
        total: doc.totalAmount.toString(),
        cost: amount(cost),
      },
      description: `${isReturn ? '매출반품' : '매출'} ${doc.docNo} ${doc.partner.name}`,
      ...(doc.divisionId ? { divisionId: doc.divisionId } : {}),
      partnerId: doc.partnerId,
    });

    const updated = await ctx.tx.salesDocument.update({
      where: { id },
      data: {
        status: 'CONFIRMED',
        confirmedAt: ctx.now,
        confirmedById: ctx.actor.userId,
        version: { increment: 1 },
      },
    });

    await audit.record(ctx, {
      action: 'sales.confirm',
      entityType: 'SalesDocument',
      entityId: id,
      before: { status: doc.status },
      after: { status: 'CONFIRMED', docNo: doc.docNo, totalAmount: doc.totalAmount.toString() },
    });

    if (!isReturn)
      await checkSafetyStock(
        ctx,
        doc.lines.map((l) => l.itemId),
      );

    return { id: updated.id, docNo: updated.docNo, status: updated.status };
  });
}

/**
 * E2E-04 / INT-07 — cancelling reverses all three effects in one transaction: the stock
 * ledger gets opposite rows, the receivable is reversed, and the journal is reversed.
 */
export async function cancel(ctx: TransactionContext, id: string, reason: string, version: number) {
  requirePermissionUnlessApproval(ctx, 'sales.cancel');
  if (reason.trim().length < 2) throw new AppError('VALIDATION', '취소 사유를 입력하세요.');

  return idempotent(ctx, `sales.cancel:${id}`, async () => {
    await ctx.tx.$queryRawUnsafe('SELECT id FROM "SalesDocument" WHERE id = $1 FOR UPDATE', id);

    const doc = await ctx.tx.salesDocument.findUniqueOrThrow({
      where: { id },
      include: { lines: true },
    });
    assertVersion('매출전표', doc.version, version);
    if (doc.status === 'CANCELED') throw new AppError('INVALID_TRANSITION', '이미 취소된 전표입니다.');

    const docDate = doc.docDate.toISOString().slice(0, 10);

    if (doc.status === 'CONFIRMED') {
      // a receivable that has been settled cannot simply vanish
      await receivables.assertReversible(ctx, doc.id);

      // the reversal touches the stock ledger and the journal, so it needs a month both accept
      const reversalDate = await reversal.reversalDate(ctx, doc.docDate, ['ACCOUNTING', 'INVENTORY']);

      await ledger.reverse(ctx, doc.docType, doc.id, {
        occurredAt: reversalDate,
        reason: `취소: ${reason}`,
      });
      await receivables.reverse(ctx, doc.id, reason);
      await journal.reverseFromSource(ctx, { sourceType: doc.docType, sourceId: doc.id }, reason);
    } else {
      await accountingPeriod.assertOpen(ctx, docDate);
    }

    // the sales order gets its quantity back
    await conversion.release(ctx, 'SALES', id);
    const orderLines = await ctx.tx.documentConversion.findMany({
      where: { targetType: 'SALES', targetId: id },
      select: { sourceId: true },
      distinct: ['sourceId'],
    });
    for (const o of orderLines) await refreshOrderStatus(ctx, o.sourceId);

    const updated = await ctx.tx.salesDocument.update({
      where: { id },
      data: {
        status: 'CANCELED',
        canceledAt: ctx.now,
        cancelReason: reason,
        version: { increment: 1 },
      },
    });

    await audit.record(ctx, {
      action: 'sales.cancel',
      entityType: 'SalesDocument',
      entityId: id,
      before: { status: doc.status },
      after: { status: 'CANCELED', reason },
    });
    return { id: updated.id, docNo: updated.docNo, status: updated.status };
  });
}

// ── helpers ──

interface DocForStock {
  id: string;
  docType: string;
  docDate: Date;
  warehouseId: string;
  lines: { id: string; itemId: string; quantity: unknown }[];
}

/** Posts the stock movement and returns the cost of goods, which the journal needs. */
async function postStock(
  ctx: TransactionContext,
  doc: DocForStock,
  isReturn: boolean,
): Promise<ReturnType<typeof ZERO.plus>> {
  const costs = await valuation.provisionalCosts(
    ctx,
    doc.lines.map((l) => l.itemId),
    doc.docDate,
  );

  const rows: ledger.LedgerRow[] = [];
  let totalCost = ZERO;

  for (const line of doc.lines) {
    const qty = D(line.quantity as never);
    const unit = costs.get(line.itemId) ?? ZERO;
    const value = floorTo(qty.times(unit), 0);
    totalCost = totalCost.plus(value);

    rows.push({
      sourceType: doc.docType,
      sourceId: doc.id,
      sourceLineId: line.id,
      itemId: line.itemId,
      warehouseId: doc.warehouseId,
      // a sale takes stock out; a return puts it back
      quantity: quantity(isReturn ? qty : qty.neg()),
      unitCost: unit.toString(),
      amount: amount(isReturn ? value : value.neg()),
      reason: isReturn ? '매출반품 입고' : '매출 출고',
      occurredAt: doc.docDate,
    });
  }

  const keys = rows.map((r) => ({ itemId: r.itemId, warehouseId: r.warehouseId }));
  const base = await ledger.lockAndRead(ctx, keys);
  const { after, requested } = ledger.applyDeltas(
    base,
    rows.map((r) => ({
      itemId: r.itemId,
      warehouseId: r.warehouseId,
      quantity: r.quantity,
      amount: r.amount ?? '0',
    })),
  );

  const issues = await ledger.checkNegative(ctx, after, requested);
  if (issues.length > 0 && (await ledger.negativeStockMode(ctx)) === 'BLOCK') {
    throw ledger.negativeStockError(issues);
  }

  await ledger.post(ctx, rows);
  return totalCost;
}

/** SLS-08 / DEC-03: warn or block once this document would push the partner over. */
async function assertCreditLimit(
  ctx: TransactionContext,
  partnerId: string,
  addingAmount: string,
): Promise<void> {
  const partner = await ctx.tx.partner.findUniqueOrThrow({ where: { id: partnerId } });
  if (!partner.creditLimit) return;

  const outstanding = await receivables.outstandingOf(ctx, partnerId);
  const projected = outstanding.plus(D(addingAmount));
  const limit = D(partner.creditLimit);
  if (projected.lte(limit)) return;

  const message = `여신한도를 초과합니다. 한도 ${amount(limit)}원, 현재 미수 ${amount(outstanding)}원, 이번 전표 ${amount(D(addingAmount))}원.`;

  if ((await matrix.creditLimitMode(ctx)) === 'BLOCK') {
    throw new AppError('CREDIT_LIMIT_EXCEEDED', message, {
      partnerId,
      limit: amount(limit),
      outstanding: amount(outstanding),
    });
  }

  await ctx.tx.securityEvent.create({
    data: {
      type: 'CREDIT_LIMIT_WARNING',
      userId: ctx.actor.userId === 'system' ? null : ctx.actor.userId,
      meta: {
        partnerId,
        partnerName: partner.name,
        limit: amount(limit),
        projected: amount(projected),
      } as never,
    },
  });
}

async function validateLines(ctx: TransactionContext, lines: LineInput[]): Promise<void> {
  if (lines.length === 0) throw new AppError('VALIDATION', '품목을 한 건 이상 입력하세요.');

  const errors: string[] = [];
  const itemIds = [...new Set(lines.map((l) => l.itemId))];
  const items = await ctx.tx.item.findMany({
    where: { id: { in: itemIds } },
    select: { id: true, name: true, isActive: true },
  });
  const byId = new Map(items.map((i) => [i.id, i]));

  for (const [i, l] of lines.entries()) {
    const item = byId.get(l.itemId);
    if (!item) errors.push(`${i + 1}행: 존재하지 않는 품목입니다.`);
    else if (!item.isActive) errors.push(`${i + 1}행: 사용중지된 품목입니다(${item.name}).`);
  }
  if (errors.length) throw new AppError('VALIDATION', errors.join('\n'), { errors });
}

/** SLS-11: a return may not exceed what was sold, line by line. */
async function validateReturn(ctx: TransactionContext, input: DocumentInput): Promise<void> {
  if (!input.originalId) {
    throw new AppError('VALIDATION', '반품 전표는 원 매출전표를 지정해야 합니다.');
  }
  const original = await ctx.tx.salesDocument.findUniqueOrThrow({
    where: { id: input.originalId },
    include: { lines: true },
  });
  if (original.status !== 'CONFIRMED') {
    throw new AppError('VALIDATION', '확정된 매출전표만 반품할 수 있습니다.');
  }
  if (original.docType !== 'SALES') {
    throw new AppError('VALIDATION', '반품 전표는 다시 반품할 수 없습니다.');
  }

  const byLine = new Map(original.lines.map((l) => [l.id, l]));
  const alreadyReturned = await ctx.tx.salesDocumentLine.groupBy({
    by: ['originalLineId'],
    where: {
      originalLineId: { in: original.lines.map((l) => l.id) },
      document: { docType: 'RETURN_SALES', status: { in: ['DRAFT', 'PENDING_APPROVAL', 'CONFIRMED'] } },
    },
    _sum: { quantity: true },
  });
  const returned = new Map(alreadyReturned.map((r) => [r.originalLineId!, D(r._sum.quantity ?? 0)]));

  const errors: string[] = [];
  for (const [i, l] of input.lines.entries()) {
    if (!l.originalLineId) {
      errors.push(`${i + 1}행: 원 매출전표의 라인을 지정하세요.`);
      continue;
    }
    const source = byLine.get(l.originalLineId);
    if (!source) {
      errors.push(`${i + 1}행: 원 매출전표에 없는 라인입니다.`);
      continue;
    }
    const remaining = D(source.quantity).minus(returned.get(l.originalLineId) ?? ZERO);
    if (D(l.quantity).gt(remaining)) {
      errors.push(
        `${i + 1}행: 반품 가능 수량 ${quantity(remaining)}을(를) 초과했습니다. 요청 ${quantity(l.quantity)}.`,
      );
    }
  }
  if (errors.length) throw new AppError('OVER_ALLOCATION', errors.join('\n'), { errors });
}

async function assertScope(ctx: TransactionContext, warehouseId: string, divisionId?: string): Promise<void> {
  if (ctx.actor.isAdmin) return;
  if (!ctx.actor.warehouseIds.includes(warehouseId)) {
    throw new AppError('FORBIDDEN', '권한 범위 밖의 창고입니다.', { warehouseId });
  }
  if (divisionId && !ctx.actor.divisionIds.includes(divisionId)) {
    throw new AppError('FORBIDDEN', '권한 범위 밖의 사업부입니다.', { divisionId });
  }
}

/** SLS-03: the order's status follows from how much of it has been delivered. */
export async function refreshOrderStatus(ctx: TransactionContext, orderId: string): Promise<void> {
  const order = await ctx.tx.salesOrder.findUnique({
    where: { id: orderId },
    include: { lines: true },
  });
  if (!order || order.status === 'CANCELED') return;

  const progress = await conversion.progressOf(ctx, order.lines);
  const state = conversion.progressStatus(progress);
  const status = state === 'COMPLETE' ? 'COMPLETED' : state === 'PARTIAL' ? 'IN_PROGRESS' : 'ACCEPTED';

  if (order.status !== status) {
    await ctx.tx.salesOrder.update({ where: { id: orderId }, data: { status } });
  }
}

// ── read ──

export async function list(
  ctx: TransactionContext,
  input: {
    docType?: SalesDocType;
    status?: string;
    partnerId?: string;
    from?: string;
    to?: string;
    q?: string;
    skip: number;
    take: number;
  },
) {
  requirePermission(ctx.actor, 'sales.read');
  const scope = ctx.actor.isAdmin ? undefined : ctx.actor.divisionIds;

  const where = {
    ...(input.docType ? { docType: input.docType } : {}),
    ...(input.status ? { status: input.status } : {}),
    ...(input.partnerId ? { partnerId: input.partnerId } : {}),
    ...(input.from || input.to
      ? {
          docDate: {
            ...(input.from ? { gte: toDateOnly(input.from) } : {}),
            ...(input.to ? { lte: toDateOnly(input.to) } : {}),
          },
        }
      : {}),
    ...(input.q
      ? {
          OR: [
            { docNo: { contains: input.q, mode: 'insensitive' as const } },
            { partner: { name: { contains: input.q, mode: 'insensitive' as const } } },
          ],
        }
      : {}),
    // INT-12: a division-scoped user does not see other divisions' documents
    ...(scope ? { OR: [{ divisionId: { in: scope } }, { divisionId: null }] } : {}),
  };

  const [rows, total] = await Promise.all([
    ctx.tx.salesDocument.findMany({
      where,
      include: {
        partner: { select: { id: true, name: true } },
        warehouse: { select: { id: true, name: true } },
        _count: { select: { lines: true } },
      },
      orderBy: [{ docDate: 'desc' }, { docNo: 'desc' }],
      skip: input.skip,
      take: input.take,
    }),
    ctx.tx.salesDocument.count({ where }),
  ]);
  return { rows, total };
}

export async function detail(ctx: TransactionContext, id: string) {
  requirePermission(ctx.actor, 'sales.read');
  const doc = await ctx.tx.salesDocument.findUnique({
    where: { id },
    include: {
      partner: {
        select: { id: true, name: true, businessNo: true, ceoName: true, address: true, email: true },
      },
      warehouse: { select: { id: true, name: true } },
      division: { select: { id: true, name: true } },
      original: { select: { id: true, docNo: true } },
      returns: { select: { id: true, docNo: true, status: true, totalAmount: true } },
      lines: {
        orderBy: { lineNo: 'asc' },
        include: { item: { select: { id: true, code: true, name: true, spec: true, unitCode: true } } },
      },
      taxDocuments: { orderBy: { createdAt: 'desc' } },
    },
  });
  if (!doc) throw new AppError('NOT_FOUND', '매출전표를 찾을 수 없습니다.');

  const [req, receivable, entry, approvalInfo] = await Promise.all([
    matrix.requirement(ctx, doc.docType, doc.totalAmount.toString(), doc.docDate.toISOString().slice(0, 10)),
    ctx.tx.receivable.findUnique({ where: { documentId: id }, include: { matches: true } }),
    ctx.tx.journalEntry.findFirst({
      where: { sourceType: doc.docType, sourceId: id, sourceVersion: 1 },
      select: { id: true, entryNo: true, status: true },
    }),
    approvalState.approvalStateOf(ctx, 'SALES_DOCUMENT', id),
  ]);

  return {
    ...doc,
    approvalRequired: req.required,
    approvalReason: req.reason,
    ...approvalInfo,
    receivable,
    journalEntry: entry,
  };
}
