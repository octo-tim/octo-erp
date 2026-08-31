import type { TransactionContext } from '@/server/core/context';
import { AppError } from '@/server/core/errors';
import {
  requirePermission,
  requirePermissionUnlessApproval,
  divisionScopeWhere,
} from '@/server/modules/rbac/service';
import * as audit from '@/server/modules/audit/service';
import * as matrix from '@/server/modules/approval/matrix';
import * as ledger from '@/server/modules/inventory/ledger';
import * as valuation from '@/server/modules/inventory/valuation';
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
import { buildCsvExport, type CsvExport } from '@/server/core/list-export';

/**
 * SLS-06 / SLS-11 / SLS-13 — purchase requests, purchase orders and purchase documents.
 *
 * E2E-02: confirming a purchase receives the stock at the price actually paid, raises the
 * payable, and posts the journal entry — all in one transaction. Unlike a sale, the unit
 * cost is not derived from the valuation policy: a receipt is what SETS the cost.
 */

export type PurchaseDocType = 'PURCHASE' | 'RETURN_PURCHASE';

export interface LineInput extends PricedLineInput {
  itemId: string;
  description?: string;
  sourceLineId?: string;
  originalLineId?: string;
  suggestedSupplierId?: string;
}

// ── SLS-13 purchase requests ──

export interface RequestInput {
  docDate?: string;
  requiredDate?: string;
  divisionId?: string;
  purpose?: string;
  note?: string;
  lines: LineInput[];
}

export async function createRequest(ctx: TransactionContext, input: RequestInput) {
  requirePermission(ctx.actor, 'purchase.write');
  if (input.lines.length === 0) throw new AppError('VALIDATION', '품목을 한 건 이상 입력하세요.');

  const docDate = input.docDate ?? businessDate(ctx.now);
  const { lines, totals } = priceLines(input.lines);
  const docNo = await nextDocNo(ctx, DOC_TYPES.PURCHASE_REQUEST, docDate);

  const request = await ctx.tx.purchaseRequest.create({
    data: {
      docNo,
      docDate: toDateOnly(docDate),
      requiredDate: input.requiredDate ? toDateOnly(input.requiredDate) : null,
      divisionId: input.divisionId ?? null,
      status: 'DRAFT',
      purpose: input.purpose ?? null,
      note: input.note ?? null,
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
          suggestedSupplierId: input.lines[i]!.suggestedSupplierId ?? null,
        })),
      },
    },
    include: { lines: { orderBy: { lineNo: 'asc' } } },
  });

  await audit.record(ctx, {
    action: 'purchaseRequest.create',
    entityType: 'PurchaseRequest',
    entityId: request.id,
    after: { docNo, docDate, totalAmount: totals.totalAmount },
  });
  return request;
}

/**
 * APV-09: called by the approval handler when a purchase request is approved. Approval is
 * what makes it orderable; the order itself is created separately, possibly in parts.
 */
export async function markRequestApproved(ctx: TransactionContext, id: string) {
  const request = await ctx.tx.purchaseRequest.findUniqueOrThrow({ where: { id } });
  if (request.status === 'APPROVED' || request.status === 'ORDERED') return request;
  return ctx.tx.purchaseRequest.update({
    where: { id },
    data: { status: 'APPROVED', approvedAt: ctx.now, version: { increment: 1 } },
  });
}

export interface ConvertLine {
  sourceLineId: string;
  quantity: string;
  unitPrice?: string;
}

/** SLS-13: an approved request becomes one or more purchase orders, per supplier. */
export async function convertRequestToOrder(
  ctx: TransactionContext,
  requestId: string,
  input: { partnerId: string; lines: ConvertLine[]; dueDate?: string; note?: string },
) {
  requirePermission(ctx.actor, 'purchase.write');

  const request = await ctx.tx.purchaseRequest.findUniqueOrThrow({
    where: { id: requestId },
    include: { lines: true },
  });
  if (request.status !== 'APPROVED' && request.status !== 'ORDERED') {
    throw new AppError('VALIDATION', `승인된 구매요청만 발주할 수 있습니다. 현재 상태: ${request.status}.`);
  }
  if (input.lines.length === 0) throw new AppError('VALIDATION', '발주할 라인을 선택하세요.');

  const byId = new Map(request.lines.map((l) => [l.id, l]));
  const docDate = businessDate(ctx.now);

  const orderLines = input.lines.map((l, i) => {
    const source = byId.get(l.sourceLineId);
    if (!source) throw new AppError('VALIDATION', `${i + 1}행: 구매요청에 없는 라인입니다.`);
    return {
      itemId: source.itemId,
      description: source.description,
      quantity: l.quantity,
      unitPrice: l.unitPrice ?? source.unitPrice.toString(),
      taxType: source.taxType,
    };
  });

  const { lines, totals } = priceLines(orderLines);
  const docNo = await nextDocNo(ctx, DOC_TYPES.PURCHASE_ORDER, docDate);

  const order = await ctx.tx.purchaseOrder.create({
    data: {
      docNo,
      docDate: toDateOnly(docDate),
      dueDate: input.dueDate ? toDateOnly(input.dueDate) : null,
      partnerId: input.partnerId,
      divisionId: request.divisionId,
      status: 'ORDERED',
      note: input.note ?? null,
      supplyAmount: totals.supplyAmount,
      vatAmount: totals.vatAmount,
      totalAmount: totals.totalAmount,
      createdById: ctx.actor.userId,
      lines: {
        create: lines.map((l, i) => ({
          lineNo: i + 1,
          itemId: orderLines[i]!.itemId,
          description: orderLines[i]!.description,
          quantity: l.quantity,
          unitPrice: l.unitPrice,
          taxType: l.taxType,
          supplyAmount: l.supplyAmount,
          vatAmount: l.vatAmount,
        })),
      },
    },
    include: { lines: { orderBy: { lineNo: 'asc' } } },
  });

  for (const [i, l] of input.lines.entries()) {
    const source = byId.get(l.sourceLineId)!;
    await conversion.reserve(
      ctx,
      {
        sourceType: 'PURCHASE_REQUEST',
        sourceId: requestId,
        sourceLineId: l.sourceLineId,
        targetType: 'PURCHASE_ORDER',
        targetId: order.id,
        targetLineId: order.lines[i]!.id,
        quantity: l.quantity,
        label: `${i + 1}행`,
      },
      source.quantity.toString(),
    );
  }

  const progress = await conversion.progressOf(ctx, request.lines);
  if (conversion.progressStatus(progress) === 'COMPLETE') {
    await ctx.tx.purchaseRequest.update({ where: { id: requestId }, data: { status: 'ORDERED' } });
  }

  await audit.record(ctx, {
    action: 'purchaseRequest.convert',
    entityType: 'PurchaseRequest',
    entityId: requestId,
    after: { orderId: order.id, orderNo: order.docNo, lines: input.lines.length },
  });
  return order;
}

// ── SLS-06 purchase documents ──

export interface DocumentInput {
  docType?: PurchaseDocType;
  docDate?: string;
  partnerId: string;
  warehouseId: string;
  divisionId?: string;
  note?: string;
  originalId?: string;
  lines: LineInput[];
}

export async function createDocument(ctx: TransactionContext, input: DocumentInput) {
  requirePermission(ctx.actor, 'purchase.write');
  const docType = input.docType ?? 'PURCHASE';
  const docDate = input.docDate ?? businessDate(ctx.now);

  await accountingPeriod.assertOpen(ctx, docDate);
  if (!ctx.actor.isAdmin && !ctx.actor.warehouseIds.includes(input.warehouseId)) {
    throw new AppError('FORBIDDEN', '권한 범위 밖의 창고입니다.');
  }
  if (input.lines.length === 0) throw new AppError('VALIDATION', '품목을 한 건 이상 입력하세요.');
  if (docType === 'RETURN_PURCHASE' && !input.originalId) {
    throw new AppError('VALIDATION', '반품 전표는 원 매입전표를 지정해야 합니다.');
  }

  const { lines, totals } = priceLines(input.lines);
  const docNo = await nextDocNo(
    ctx,
    docType === 'PURCHASE' ? DOC_TYPES.PURCHASE : DOC_TYPES.RETURN_PURCHASE,
    docDate,
  );

  const doc = await ctx.tx.purchaseDocument.create({
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

  // SLS-13: link back to the purchase order so its remaining quantity moves
  for (const [i, line] of input.lines.entries()) {
    if (!line.sourceLineId) continue;
    const orderLine = await ctx.tx.purchaseOrderLine.findUniqueOrThrow({
      where: { id: line.sourceLineId },
    });
    await conversion.reserve(
      ctx,
      {
        sourceType: 'PURCHASE_ORDER',
        sourceId: orderLine.orderId,
        sourceLineId: line.sourceLineId,
        targetType: 'PURCHASE',
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
    action: 'purchase.create',
    entityType: 'PurchaseDocument',
    entityId: doc.id,
    after: { docNo, docType, docDate, totalAmount: totals.totalAmount },
  });
  return doc;
}

/** E2E-02: stock in at the price paid, payable raised, journal posted — one transaction. */
export async function confirmDocument(ctx: TransactionContext, id: string, version: number) {
  requirePermissionUnlessApproval(ctx, 'purchase.confirm');

  return idempotent(ctx, `purchase.confirm:${id}`, async () => {
    await ctx.tx.$queryRawUnsafe('SELECT id FROM "PurchaseDocument" WHERE id = $1 FOR UPDATE', id);

    const doc = await ctx.tx.purchaseDocument.findUniqueOrThrow({
      where: { id },
      include: { lines: { orderBy: { lineNo: 'asc' } }, partner: true },
    });
    assertVersion('매입전표', doc.version, version);
    if (doc.status !== 'DRAFT' && doc.status !== 'PENDING_APPROVAL') {
      throw new AppError('INVALID_TRANSITION', `현재 상태(${doc.status})의 전표는 확정할 수 없습니다.`);
    }

    const docDate = doc.docDate.toISOString().slice(0, 10);
    await accountingPeriod.assertOpen(ctx, docDate);
    await valuation.assertPeriodOpen(ctx, docDate);

    const req = await matrix.requirement(ctx, doc.docType, doc.totalAmount.toString(), docDate);
    if (req.required && !ctx.viaApproval) {
      throw new AppError('APPROVAL_REQUIRED', `${req.reason}. 결재 상신 후 승인되면 확정됩니다.`, {
        policyVersionId: req.policyVersionId,
      });
    }

    const isReturn = doc.docType === 'RETURN_PURCHASE';

    // 1. stock. A receipt sets the cost from the price paid; a return leaves at that cost.
    const returnCosts = isReturn
      ? await valuation.provisionalCosts(
          ctx,
          doc.lines.map((l) => l.itemId),
          doc.docDate,
        )
      : new Map<string, ReturnType<typeof ZERO.plus>>();

    const rows: ledger.LedgerRow[] = doc.lines.map((line) => {
      const qty = D(line.quantity);
      const unit = isReturn ? (returnCosts.get(line.itemId) ?? ZERO) : D(line.unitPrice);
      const value = floorTo(qty.times(unit), 0);
      return {
        sourceType: doc.docType,
        sourceId: doc.id,
        sourceLineId: line.id,
        itemId: line.itemId,
        warehouseId: doc.warehouseId,
        quantity: quantity(isReturn ? qty.neg() : qty),
        unitCost: unit.toString(),
        amount: amount(isReturn ? value.neg() : value),
        reason: isReturn ? '매입반품 출고' : '매입 입고',
        occurredAt: doc.docDate,
      };
    });

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

    // 2. payable
    await receivables.raisePayable(ctx, {
      documentId: doc.id,
      partnerId: doc.partnerId,
      docDate: doc.docDate,
      amount: doc.totalAmount.toString(),
      isReturn,
      originalDocumentId: doc.originalId,
    });

    // 3. accounting
    await postingRule.post(ctx, isReturn ? 'RETURN_PURCHASE' : 'PURCHASE', {
      source: { sourceType: doc.docType, sourceId: doc.id },
      entryDate: docDate,
      amounts: {
        supply: doc.supplyAmount.toString(),
        vat: doc.vatAmount.toString(),
        total: doc.totalAmount.toString(),
      },
      description: `${isReturn ? '매입반품' : '매입'} ${doc.docNo} ${doc.partner.name}`,
      ...(doc.divisionId ? { divisionId: doc.divisionId } : {}),
      partnerId: doc.partnerId,
    });

    const updated = await ctx.tx.purchaseDocument.update({
      where: { id },
      data: {
        status: 'CONFIRMED',
        confirmedAt: ctx.now,
        confirmedById: ctx.actor.userId,
        version: { increment: 1 },
      },
    });

    await audit.record(ctx, {
      action: 'purchase.confirm',
      entityType: 'PurchaseDocument',
      entityId: id,
      before: { status: doc.status },
      after: { status: 'CONFIRMED', docNo: doc.docNo, totalAmount: doc.totalAmount.toString() },
    });
    return { id: updated.id, docNo: updated.docNo, status: updated.status };
  });
}

export async function cancelDocument(ctx: TransactionContext, id: string, reason: string, version: number) {
  requirePermissionUnlessApproval(ctx, 'purchase.cancel');
  if (reason.trim().length < 2) throw new AppError('VALIDATION', '취소 사유를 입력하세요.');

  return idempotent(ctx, `purchase.cancel:${id}`, async () => {
    await ctx.tx.$queryRawUnsafe('SELECT id FROM "PurchaseDocument" WHERE id = $1 FOR UPDATE', id);

    const doc = await ctx.tx.purchaseDocument.findUniqueOrThrow({ where: { id } });
    assertVersion('매입전표', doc.version, version);
    if (doc.status === 'CANCELED') throw new AppError('INVALID_TRANSITION', '이미 취소된 전표입니다.');

    if (doc.status === 'CONFIRMED') {
      await receivables.assertPayableReversible(ctx, doc.id);
      // the reversal touches the stock ledger and the journal, so it needs a month both accept
      const reversalDate = await reversal.reversalDate(ctx, doc.docDate, ['ACCOUNTING', 'INVENTORY']);

      // the stock may already have been sold on; the reversal must not go negative
      const original = await ctx.tx.inventoryLedger.findMany({
        where: { sourceType: doc.docType, sourceId: id, sourceVersion: 1 },
      });
      const keys = original.map((r) => ({ itemId: r.itemId, warehouseId: r.warehouseId }));
      const base = await ledger.lockAndRead(ctx, keys);
      const { after, requested } = ledger.applyDeltas(
        base,
        original.map((r) => ({
          itemId: r.itemId,
          warehouseId: r.warehouseId,
          quantity: D(r.quantity).neg().toString(),
          amount: D(r.amount).neg().toString(),
        })),
      );
      const issues = await ledger.checkNegative(ctx, after, requested);
      if (issues.length > 0 && (await ledger.negativeStockMode(ctx)) === 'BLOCK') {
        throw ledger.negativeStockError(issues);
      }

      await ledger.reverse(ctx, doc.docType, id, {
        occurredAt: reversalDate,
        reason: `취소: ${reason}`,
      });
      await receivables.reversePayable(ctx, id);
      await journal.reverseFromSource(ctx, { sourceType: doc.docType, sourceId: id }, reason);
    } else {
      await accountingPeriod.assertOpen(ctx, doc.docDate.toISOString().slice(0, 10));
    }

    const orders = await ctx.tx.documentConversion.findMany({
      where: { targetType: 'PURCHASE', targetId: id },
      select: { sourceId: true },
      distinct: ['sourceId'],
    });
    await conversion.release(ctx, 'PURCHASE', id);
    for (const o of orders) await refreshOrderStatus(ctx, o.sourceId);

    const updated = await ctx.tx.purchaseDocument.update({
      where: { id },
      data: {
        status: 'CANCELED',
        canceledAt: ctx.now,
        cancelReason: reason,
        version: { increment: 1 },
      },
    });

    await audit.record(ctx, {
      action: 'purchase.cancel',
      entityType: 'PurchaseDocument',
      entityId: id,
      before: { status: doc.status },
      after: { status: 'CANCELED', reason },
    });
    return { id: updated.id, docNo: updated.docNo, status: updated.status };
  });
}

export async function refreshOrderStatus(ctx: TransactionContext, orderId: string): Promise<void> {
  const order = await ctx.tx.purchaseOrder.findUnique({
    where: { id: orderId },
    include: { lines: true },
  });
  if (!order || order.status === 'CANCELED') return;

  const progress = await conversion.progressOf(ctx, order.lines);
  const state = conversion.progressStatus(progress);
  const status = state === 'COMPLETE' ? 'COMPLETED' : state === 'PARTIAL' ? 'RECEIVING' : 'ORDERED';
  if (order.status !== status) {
    await ctx.tx.purchaseOrder.update({ where: { id: orderId }, data: { status } });
  }
}

// ── read ──

export async function listRequests(
  ctx: TransactionContext,
  input: { status?: string; from?: string; to?: string; q?: string; skip: number; take: number },
) {
  requirePermission(ctx.actor, 'purchase.read');
  // INT-12: this list never applied division scope at all — a user scoped to one division
  // could list another division's purchase requests. Composed under AND, matching the
  // divisionScopeWhere contract, so it never collides with a keyword OR added later.
  const where = {
    ...(input.status ? { status: input.status } : {}),
    ...(input.from || input.to
      ? {
          docDate: {
            ...(input.from ? { gte: toDateOnly(input.from) } : {}),
            ...(input.to ? { lte: toDateOnly(input.to) } : {}),
          },
        }
      : {}),
    ...(input.q ? { docNo: { contains: input.q, mode: 'insensitive' as const } } : {}),
    AND: [divisionScopeWhere(ctx.actor)],
  };
  const [rows, total] = await Promise.all([
    ctx.tx.purchaseRequest.findMany({
      where,
      include: { _count: { select: { lines: true } }, division: { select: { name: true } } },
      orderBy: [{ docDate: 'desc' }, { docNo: 'desc' }],
      skip: input.skip,
      take: input.take,
    }),
    ctx.tx.purchaseRequest.count({ where }),
  ]);
  return { rows, total };
}

const PURCHASE_REQUEST_CSV_HEADERS = ['요청번호', '요청일', '목적', '사업부', '필요일', '합계', '상태'];

/** UIX-03: server-side export for the 구매요청 grid — same permission and rows as `listRequests`. */
export async function listRequestsCsv(
  ctx: TransactionContext,
  input: { status?: string; from?: string; to?: string; q?: string },
): Promise<CsvExport> {
  return buildCsvExport(
    (paging) => listRequests(ctx, { ...input, ...paging }),
    PURCHASE_REQUEST_CSV_HEADERS,
    (r) => [
      r.docNo,
      r.docDate.toISOString().slice(0, 10),
      r.purpose ?? '',
      r.division?.name ?? '',
      r.requiredDate ? r.requiredDate.toISOString().slice(0, 10) : '',
      r.totalAmount.toString(),
      r.status,
    ],
  );
}

export async function requestDetail(ctx: TransactionContext, id: string) {
  requirePermission(ctx.actor, 'purchase.read');
  const request = await ctx.tx.purchaseRequest.findUnique({
    where: { id },
    include: {
      division: { select: { id: true, name: true } },
      lines: {
        orderBy: { lineNo: 'asc' },
        include: { item: { select: { id: true, code: true, name: true, spec: true, unitCode: true } } },
      },
    },
  });
  if (!request) throw new AppError('NOT_FOUND', '구매요청을 찾을 수 없습니다.');

  const progress = await conversion.progressOf(ctx, request.lines);
  const byLine = new Map(progress.map((p) => [p.sourceLineId, p]));

  return {
    ...request,
    lines: request.lines.map((l) => ({
      ...l,
      ordered: byLine.get(l.id)?.convertedQuantity ?? '0.000',
      remaining: byLine.get(l.id)?.remainingQuantity ?? quantity(D(l.quantity)),
    })),
  };
}

export async function listOrders(
  ctx: TransactionContext,
  input: {
    status?: string;
    partnerId?: string;
    from?: string;
    to?: string;
    q?: string;
    skip: number;
    take: number;
  },
) {
  requirePermission(ctx.actor, 'purchase.read');
  // INT-12: this list never applied division scope at all — a user scoped to one division
  // could list another division's purchase orders. Composed under AND, matching the
  // divisionScopeWhere contract, so it never collides with a keyword OR added later.
  const where = {
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
    ...(input.q ? { docNo: { contains: input.q, mode: 'insensitive' as const } } : {}),
    AND: [divisionScopeWhere(ctx.actor)],
  };
  const [rows, total] = await Promise.all([
    ctx.tx.purchaseOrder.findMany({
      where,
      include: { partner: { select: { id: true, name: true } }, _count: { select: { lines: true } } },
      orderBy: [{ docDate: 'desc' }, { docNo: 'desc' }],
      skip: input.skip,
      take: input.take,
    }),
    ctx.tx.purchaseOrder.count({ where }),
  ]);
  return { rows, total };
}

const PURCHASE_ORDER_CSV_HEADERS = ['발주번호', '발주일', '발주처', '납기일', '합계', '상태'];

/** UIX-03: server-side export for the 발주서 grid — same permission and rows as `listOrders`. */
export async function listOrdersCsv(
  ctx: TransactionContext,
  input: { status?: string; partnerId?: string; from?: string; to?: string; q?: string },
): Promise<CsvExport> {
  return buildCsvExport(
    (paging) => listOrders(ctx, { ...input, ...paging }),
    PURCHASE_ORDER_CSV_HEADERS,
    (r) => [
      r.docNo,
      r.docDate.toISOString().slice(0, 10),
      r.partner.name,
      r.dueDate ? r.dueDate.toISOString().slice(0, 10) : '',
      r.totalAmount.toString(),
      r.status,
    ],
  );
}

export async function orderDetail(ctx: TransactionContext, id: string) {
  requirePermission(ctx.actor, 'purchase.read');
  const order = await ctx.tx.purchaseOrder.findUnique({
    where: { id },
    include: {
      partner: { select: { id: true, name: true } },
      lines: {
        orderBy: { lineNo: 'asc' },
        include: { item: { select: { id: true, code: true, name: true, spec: true, unitCode: true } } },
      },
    },
  });
  if (!order) throw new AppError('NOT_FOUND', '발주서를 찾을 수 없습니다.');

  const progress = await conversion.progressOf(ctx, order.lines);
  const byLine = new Map(progress.map((p) => [p.sourceLineId, p]));

  return {
    ...order,
    lines: order.lines.map((l) => ({
      ...l,
      received: byLine.get(l.id)?.convertedQuantity ?? '0.000',
      remaining: byLine.get(l.id)?.remainingQuantity ?? quantity(D(l.quantity)),
    })),
  };
}

export async function listDocuments(
  ctx: TransactionContext,
  input: {
    docType?: PurchaseDocType;
    status?: string;
    partnerId?: string;
    from?: string;
    to?: string;
    q?: string;
    skip: number;
    take: number;
  },
) {
  requirePermission(ctx.actor, 'purchase.read');
  // INT-12: this list never applied division scope at all — a user scoped to one division
  // could list another division's purchase documents. Composed under AND so the scope can
  // never collide with the keyword search's own OR.
  const scope = divisionScopeWhere(ctx.actor);
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
    AND: [
      ...(input.q
        ? [
            {
              OR: [
                { docNo: { contains: input.q, mode: 'insensitive' as const } },
                { partner: { name: { contains: input.q, mode: 'insensitive' as const } } },
              ],
            },
          ]
        : []),
      scope,
    ],
  };
  const [rows, total] = await Promise.all([
    ctx.tx.purchaseDocument.findMany({
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
    ctx.tx.purchaseDocument.count({ where }),
  ]);
  return { rows, total };
}

const PURCHASE_DOCUMENT_CSV_HEADERS = [
  '전표번호',
  '전표일',
  '매입처',
  '입고창고',
  '공급가액',
  '세액',
  '합계',
  '상태',
];

/** UIX-03: server-side export for the 매입전표 grid — same permission and rows as `listDocuments`. */
export async function listDocumentsCsv(
  ctx: TransactionContext,
  input: {
    docType?: PurchaseDocType;
    status?: string;
    partnerId?: string;
    from?: string;
    to?: string;
    q?: string;
  },
): Promise<CsvExport> {
  return buildCsvExport(
    (paging) => listDocuments(ctx, { ...input, ...paging }),
    PURCHASE_DOCUMENT_CSV_HEADERS,
    (r) => [
      r.docNo,
      r.docDate.toISOString().slice(0, 10),
      r.partner.name,
      r.warehouse.name,
      r.supplyAmount.toString(),
      r.vatAmount.toString(),
      r.totalAmount.toString(),
      r.status,
    ],
  );
}

export async function documentDetail(ctx: TransactionContext, id: string) {
  requirePermission(ctx.actor, 'purchase.read');
  const doc = await ctx.tx.purchaseDocument.findUnique({
    where: { id },
    include: {
      partner: { select: { id: true, name: true, businessNo: true } },
      warehouse: { select: { id: true, name: true } },
      division: { select: { id: true, name: true } },
      original: { select: { id: true, docNo: true } },
      returns: { select: { id: true, docNo: true, status: true, totalAmount: true } },
      lines: {
        orderBy: { lineNo: 'asc' },
        include: { item: { select: { id: true, code: true, name: true, spec: true, unitCode: true } } },
      },
    },
  });
  if (!doc) throw new AppError('NOT_FOUND', '매입전표를 찾을 수 없습니다.');

  const [req, payable, entry, approvalInfo] = await Promise.all([
    matrix.requirement(ctx, doc.docType, doc.totalAmount.toString(), doc.docDate.toISOString().slice(0, 10)),
    ctx.tx.payable.findUnique({ where: { documentId: id } }),
    ctx.tx.journalEntry.findFirst({
      where: { sourceType: doc.docType, sourceId: id, sourceVersion: 1 },
      select: { id: true, entryNo: true, status: true },
    }),
    approvalState.approvalStateOf(ctx, 'PURCHASE_DOCUMENT', id),
  ]);

  return {
    ...doc,
    approvalRequired: req.required,
    approvalReason: req.reason,
    ...approvalInfo,
    payable,
    journalEntry: entry,
  };
}
