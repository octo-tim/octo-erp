import type { TransactionContext } from '@/server/core/context';
import { AppError } from '@/server/core/errors';
import { requirePermission, requirePermissionUnlessApproval } from '@/server/modules/rbac/service';
import * as audit from '@/server/modules/audit/service';
import * as matrix from '@/server/modules/approval/matrix';
import { nextDocNo, DOC_TYPES } from '@/server/modules/numbering/service';
import * as accountingPeriod from '@/server/modules/accounting/period';
import * as reversal from '@/server/modules/documents/reversal';
import * as approvalState from '@/server/modules/documents/approval-state';
import { idempotent } from '@/server/core/idempotency';
import { assertTransition, assertVersion, type DocStatus } from '@/server/core/state-machine';
import * as ledger from './ledger';
import * as valuation from './valuation';
import { checkSafetyStock } from './safety-stock';
import { amount, D, floorTo, quantity, unitPrice, ZERO, type Numeric } from '@/lib/money';
import { businessDate, toDateOnly } from '@/lib/dates';

/**
 * INV-01/02/03/04/06 — receipts, issues and transfers.
 *
 * One document type covers all three because they share everything that matters: lines,
 * confirmation into the ledger, cancellation by opposite rows, and the approval gate.
 * What differs is which warehouse field is set and, for transfers only, the movement
 * state machine (INV-03).
 */

export type StockDocType = 'RECEIPT' | 'ISSUE' | 'TRANSFER' | 'ADJUST';
export type MovementState = 'REQUESTED' | 'IN_TRANSIT' | 'COMPLETED' | 'CANCELED';

const movementTransitions: Record<MovementState, readonly MovementState[]> = {
  REQUESTED: ['IN_TRANSIT', 'CANCELED'],
  IN_TRANSIT: ['COMPLETED', 'CANCELED'],
  COMPLETED: [],
  CANCELED: [],
};

const NUMBERING: Record<StockDocType, string> = {
  RECEIPT: DOC_TYPES.STOCK_IN,
  ISSUE: DOC_TYPES.STOCK_OUT,
  TRANSFER: DOC_TYPES.STOCK_MOVE,
  ADJUST: DOC_TYPES.STOCK_ADJUST,
};

/** the docType the DEC-03 approval matrix is keyed by */
const MATRIX_TYPE: Record<StockDocType, string> = {
  RECEIPT: 'STOCK_IN',
  ISSUE: 'STOCK_OUT',
  TRANSFER: 'STOCK_IN',
  ADJUST: 'STOCK_ADJUST',
};

export interface LineInput {
  itemId: string;
  quantity: string;
  unitCost?: string;
  note?: string;
}

export interface DocumentInput {
  docType: StockDocType;
  docDate?: string;
  fromWarehouseId?: string;
  toWarehouseId?: string;
  partnerId?: string;
  reasonCode?: string;
  divisionId?: string;
  note?: string;
  lines: LineInput[];
}

// ── validation ──

function warehousesFor(input: {
  docType: StockDocType;
  fromWarehouseId?: string | null;
  toWarehouseId?: string | null;
}): { from: string | null; to: string | null } {
  const from = input.fromWarehouseId ?? null;
  const to = input.toWarehouseId ?? null;
  switch (input.docType) {
    case 'RECEIPT':
      if (!to) throw new AppError('VALIDATION', '입고 창고를 선택하세요.');
      return { from: null, to };
    case 'ISSUE':
      if (!from) throw new AppError('VALIDATION', '출고 창고를 선택하세요.');
      return { from, to: null };
    case 'TRANSFER':
      if (!from || !to) throw new AppError('VALIDATION', '출발 창고와 도착 창고를 모두 선택하세요.');
      if (from === to) throw new AppError('VALIDATION', '출발 창고와 도착 창고가 같을 수 없습니다.');
      return { from, to };
    case 'ADJUST':
      if (!to) throw new AppError('VALIDATION', '조정 대상 창고를 선택하세요.');
      return { from: null, to };
  }
}

async function validateLines(ctx: TransactionContext, docType: StockDocType, lines: LineInput[]) {
  if (lines.length === 0) throw new AppError('VALIDATION', '품목을 한 건 이상 입력하세요.');

  const errors: string[] = [];
  const seen = new Set<string>();
  for (const [i, l] of lines.entries()) {
    const label = `${i + 1}행`;
    if (seen.has(l.itemId)) errors.push(`${label}: 같은 품목이 중복 입력되었습니다.`);
    seen.add(l.itemId);

    const q = D(l.quantity);
    // an adjustment may be negative (a shortfall); everything else moves a positive amount
    if (docType === 'ADJUST') {
      if (q.isZero()) errors.push(`${label}: 조정 수량이 0일 수 없습니다.`);
    } else if (q.lte(0)) {
      errors.push(`${label}: 수량은 0보다 커야 합니다.`);
    }
    if (l.unitCost !== undefined && D(l.unitCost).isNegative())
      errors.push(`${label}: 단가는 0 이상이어야 합니다.`);
  }

  const items = await ctx.tx.item.findMany({
    where: { id: { in: [...seen] } },
    select: { id: true, name: true, isActive: true },
  });
  const found = new Map(items.map((i) => [i.id, i]));
  for (const [i, l] of lines.entries()) {
    const item = found.get(l.itemId);
    if (!item) errors.push(`${i + 1}행: 존재하지 않는 품목입니다.`);
    else if (!item.isActive) errors.push(`${i + 1}행: 사용중지된 품목입니다(${item.name}).`);
  }

  if (errors.length) throw new AppError('VALIDATION', errors.join('\n'), { errors });
}

/**
 * INT-12: a user may only move stock in warehouses within their data scope.
 *
 * This checks several warehouses at once — a transfer has both a source and a destination —
 * which is why it exists alongside rbac's single-warehouse `assertWarehouseScope`. It used
 * to raise FORBIDDEN, so the same violation reported one code through the inventory screens
 * and OUT_OF_SCOPE through the reports, and a client branching on `appCode` was right only
 * half the time. The security model names OUT_OF_SCOPE for a scope violation; a missing
 * permission is the other thing.
 */
function assertWarehousesInScope(ctx: TransactionContext, ids: (string | null)[]): void {
  if (ctx.actor.isAdmin) return;
  const allowed = new Set(ctx.actor.warehouseIds);
  const denied = ids.filter((id): id is string => !!id && !allowed.has(id));
  if (denied.length) {
    throw new AppError('OUT_OF_SCOPE', '해당 창고의 자료에 접근할 수 없습니다.', {
      warehouseIds: denied,
    });
  }
}

// ── write ──

export async function create(ctx: TransactionContext, input: DocumentInput) {
  requirePermission(ctx.actor, 'inventory.write');
  const { from, to } = warehousesFor(input);
  assertWarehousesInScope(ctx, [from, to]);
  await validateLines(ctx, input.docType, input.lines);

  const docDate = input.docDate ?? businessDate(ctx.now);
  // DEC-04: a closed period refuses creation and editing as well as confirmation
  await accountingPeriod.assertOpen(ctx, docDate);
  await valuation.assertPeriodOpen(ctx, docDate);

  if ((input.docType === 'RECEIPT' || input.docType === 'ISSUE') && !input.reasonCode) {
    throw new AppError('VALIDATION', '수동 입출고는 사유를 선택해야 합니다.');
  }

  const totals = totalsOf(input.lines);
  const docNo = await nextDocNo(ctx, NUMBERING[input.docType], docDate);

  const doc = await ctx.tx.stockDocument.create({
    data: {
      docNo,
      docType: input.docType,
      docDate: toDateOnly(docDate),
      status: 'DRAFT',
      movementState: input.docType === 'TRANSFER' ? 'REQUESTED' : null,
      fromWarehouseId: from,
      toWarehouseId: to,
      partnerId: input.partnerId ?? null,
      reasonCode: input.reasonCode ?? null,
      divisionId: input.divisionId ?? null,
      note: input.note ?? null,
      totalQuantity: totals.quantity,
      totalAmount: totals.amount,
      createdById: ctx.actor.userId,
      lines: {
        create: input.lines.map((l, i) => ({
          lineNo: i + 1,
          itemId: l.itemId,
          quantity: quantity(l.quantity),
          unitCost: l.unitCost ? unitPrice(l.unitCost) : null,
          amount: lineAmount(l),
          note: l.note ?? null,
        })),
      },
    },
    include: { lines: true },
  });

  await audit.record(ctx, {
    action: 'stock.create',
    entityType: 'StockDocument',
    entityId: doc.id,
    after: { docNo, docType: input.docType, docDate, lines: input.lines.length },
  });
  return doc;
}

export async function update(ctx: TransactionContext, id: string, input: DocumentInput, version: number) {
  requirePermission(ctx.actor, 'inventory.write');
  const before = await ctx.tx.stockDocument.findUniqueOrThrow({ where: { id } });
  assertVersion('재고전표', before.version, version);
  if (before.status !== 'DRAFT') {
    throw new AppError('IMMUTABLE', '작성 중인 전표만 수정할 수 있습니다.', { status: before.status });
  }

  const { from, to } = warehousesFor({ ...input, docType: before.docType as StockDocType });
  assertWarehousesInScope(ctx, [from, to]);
  await validateLines(ctx, before.docType as StockDocType, input.lines);

  const docDate = input.docDate ?? businessDate(ctx.now);
  // DEC-04: a closed period refuses creation and editing as well as confirmation
  await accountingPeriod.assertOpen(ctx, docDate);
  await valuation.assertPeriodOpen(ctx, docDate);
  const totals = totalsOf(input.lines);

  await ctx.tx.stockDocumentLine.deleteMany({ where: { documentId: id } });
  const after = await ctx.tx.stockDocument.update({
    where: { id },
    data: {
      docDate: toDateOnly(docDate),
      fromWarehouseId: from,
      toWarehouseId: to,
      partnerId: input.partnerId ?? null,
      reasonCode: input.reasonCode ?? null,
      divisionId: input.divisionId ?? null,
      note: input.note ?? null,
      totalQuantity: totals.quantity,
      totalAmount: totals.amount,
      version: { increment: 1 },
      lines: {
        create: input.lines.map((l, i) => ({
          lineNo: i + 1,
          itemId: l.itemId,
          quantity: quantity(l.quantity),
          unitCost: l.unitCost ? unitPrice(l.unitCost) : null,
          amount: lineAmount(l),
          note: l.note ?? null,
        })),
      },
    },
    include: { lines: true },
  });

  await audit.record(ctx, {
    action: 'stock.update',
    entityType: 'StockDocument',
    entityId: id,
    before: { totalQuantity: before.totalQuantity.toString(), docDate: before.docDate.toISOString() },
    after: { totalQuantity: after.totalQuantity.toString(), docDate },
  });
  return after;
}

/**
 * INV-04/INV-06 — the confirming transaction.
 *
 * Order matters: lock the affected (item, warehouse) rows first, then read balances,
 * then value the issues, then check for negative stock, and only then post. Everything
 * is in the caller's transaction (INT-06), so a failure anywhere leaves no ledger rows.
 */
export async function confirm(ctx: TransactionContext, id: string, version: number) {
  requirePermissionUnlessApproval(ctx, 'inventory.confirm');

  return idempotent(ctx, `stock.confirm:${id}`, async () => {
    // lock the document itself so two confirms cannot interleave
    await ctx.tx.$queryRawUnsafe('SELECT id FROM "StockDocument" WHERE id = $1 FOR UPDATE', id);

    const doc = await ctx.tx.stockDocument.findUniqueOrThrow({
      where: { id },
      include: { lines: { orderBy: { lineNo: 'asc' } } },
    });
    assertVersion('재고전표', doc.version, version);
    assertTransition(
      {
        DRAFT: ['PENDING_APPROVAL', 'CONFIRMED'],
        PENDING_APPROVAL: ['CONFIRMED'],
        CONFIRMED: [],
        CANCELED: [],
      } as never,
      doc.status as DocStatus,
      'CONFIRMED',
      '재고전표',
    );

    const docDate = doc.docDate.toISOString().slice(0, 10);
    // both calendars, because confirming a stock document also values it: a month that is
    // closed for accounting must not gain movements any more than a closed valuation month
    await accountingPeriod.assertOpen(ctx, docDate);
    await valuation.assertPeriodOpen(ctx, docDate);

    // DEC-03: an approval-required document may only be confirmed by the approval module
    const req = await matrix.requirement(
      ctx,
      MATRIX_TYPE[doc.docType as StockDocType],
      doc.totalAmount.toString(),
      docDate,
    );
    if (req.required && !ctx.viaApproval) {
      throw new AppError('APPROVAL_REQUIRED', `${req.reason}. 결재 상신 후 승인되면 확정됩니다.`, {
        policyVersionId: req.policyVersionId,
      });
    }

    // a transfer only posts when it actually arrives (INV-03)
    if (doc.docType === 'TRANSFER' && doc.movementState !== 'IN_TRANSIT') {
      throw new AppError('INVALID_TRANSITION', '이동 전표는 이동중 상태에서 도착 처리로 확정합니다.', {
        movementState: doc.movementState,
      });
    }

    const rows = await buildLedgerRows(ctx, doc);
    await postWithChecks(ctx, rows, doc.docType as StockDocType);

    const updated = await ctx.tx.stockDocument.update({
      where: { id },
      data: {
        status: 'CONFIRMED',
        movementState: doc.docType === 'TRANSFER' ? 'COMPLETED' : null,
        confirmedAt: ctx.now,
        confirmedById: ctx.actor.userId,
        version: { increment: 1 },
      },
    });

    await audit.record(ctx, {
      action: 'stock.confirm',
      entityType: 'StockDocument',
      entityId: id,
      before: { status: doc.status },
      after: { status: 'CONFIRMED', docNo: doc.docNo },
    });

    // INV-07: warn once the movement is real, never on a draft
    await checkSafetyStock(
      ctx,
      rows.map((r) => r.itemId),
    );

    return { id: updated.id, docNo: updated.docNo, status: updated.status };
  });
}

/** INT-07: cancellation posts opposite rows; nothing is deleted. */
export async function cancel(ctx: TransactionContext, id: string, reason: string, version: number) {
  requirePermissionUnlessApproval(ctx, 'inventory.confirm');
  if (reason.trim().length < 2) throw new AppError('VALIDATION', '취소 사유를 입력하세요.');

  return idempotent(ctx, `stock.cancel:${id}`, async () => {
    await ctx.tx.$queryRawUnsafe('SELECT id FROM "StockDocument" WHERE id = $1 FOR UPDATE', id);

    const doc = await ctx.tx.stockDocument.findUniqueOrThrow({
      where: { id },
      include: { lines: true },
    });
    assertVersion('재고전표', doc.version, version);
    if (doc.status === 'CANCELED') {
      throw new AppError('INVALID_TRANSITION', '이미 취소된 전표입니다.');
    }

    // one rule for every reversal: the original date when both calendars accept it (DEC-04)
    const reversalDate = await reversal.reversalDate(ctx, doc.docDate, ['ACCOUNTING', 'INVENTORY']);

    if (doc.status === 'CONFIRMED') {
      // check the reversal itself does not drive stock negative (a transfer already moved on)
      const original = await ctx.tx.inventoryLedger.findMany({
        where: { sourceType: 'STOCK_DOCUMENT', sourceId: id, sourceVersion: 1 },
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
      await assertNoNegative(ctx, after, requested);

      await ledger.reverse(ctx, 'STOCK_DOCUMENT', id, {
        occurredAt: reversalDate,
        reason: `취소: ${reason}`,
      });
    }

    const updated = await ctx.tx.stockDocument.update({
      where: { id },
      data: {
        status: 'CANCELED',
        movementState: doc.docType === 'TRANSFER' ? 'CANCELED' : null,
        canceledAt: ctx.now,
        canceledById: ctx.actor.userId,
        cancelReason: reason,
        version: { increment: 1 },
      },
    });

    await audit.record(ctx, {
      action: 'stock.cancel',
      entityType: 'StockDocument',
      entityId: id,
      before: { status: doc.status },
      after: { status: 'CANCELED', reason },
    });
    return { id: updated.id, docNo: updated.docNo, status: updated.status };
  });
}

/** INV-03: 요청 → 이동중. The stock leaves the origin only at completion. */
export async function ship(ctx: TransactionContext, id: string, version: number) {
  requirePermission(ctx.actor, 'inventory.write');
  const doc = await ctx.tx.stockDocument.findUniqueOrThrow({ where: { id } });
  assertVersion('이동전표', doc.version, version);
  if (doc.docType !== 'TRANSFER') throw new AppError('VALIDATION', '이동 전표가 아닙니다.');
  assertMovement(doc.movementState as MovementState, 'IN_TRANSIT');

  const updated = await ctx.tx.stockDocument.update({
    where: { id },
    data: { movementState: 'IN_TRANSIT', version: { increment: 1 } },
  });
  await audit.record(ctx, {
    action: 'stock.ship',
    entityType: 'StockDocument',
    entityId: id,
    before: { movementState: doc.movementState },
    after: { movementState: 'IN_TRANSIT' },
  });
  return updated;
}

function assertMovement(from: MovementState, to: MovementState): void {
  const allowed = movementTransitions[from];
  if (!allowed?.includes(to)) {
    throw new AppError('INVALID_TRANSITION', `이동 상태를 ${from}에서 ${to}(으)로 바꿀 수 없습니다.`, {
      from,
      to,
    });
  }
}

// ── ledger construction ──

interface DocWithLines {
  id: string;
  docType: string;
  docDate: Date;
  fromWarehouseId: string | null;
  toWarehouseId: string | null;
  reasonCode: string | null;
  /** Prisma Decimal columns arrive as objects with toString(); `Numeric` accepts them. */
  lines: { id: string; itemId: string; quantity: Numeric; unitCost: Numeric | null }[];
}

/**
 * A receipt writes one positive row; an issue one negative row; a transfer writes both,
 * in the same transaction, so the two warehouses can never disagree (INV-03).
 */
async function buildLedgerRows(ctx: TransactionContext, doc: DocWithLines): Promise<ledger.LedgerRow[]> {
  const occurredAt = doc.docDate;
  const rows: ledger.LedgerRow[] = [];

  // issues are valued by the DEC-01 provisional average; receipts carry their own cost
  const needsValuation = doc.docType === 'ISSUE' || doc.docType === 'TRANSFER' || doc.docType === 'ADJUST';
  const costs = needsValuation
    ? await valuation.provisionalCosts(
        ctx,
        doc.lines.map((l) => l.itemId),
        occurredAt,
      )
    : new Map<string, ReturnType<typeof D>>();

  for (const line of doc.lines) {
    const qty = D(line.quantity);
    const cost = line.unitCost ? D(line.unitCost) : (costs.get(line.itemId) ?? ZERO);

    switch (doc.docType) {
      case 'RECEIPT':
        rows.push({
          sourceType: 'STOCK_DOCUMENT',
          sourceId: doc.id,
          sourceLineId: line.id,
          itemId: line.itemId,
          warehouseId: doc.toWarehouseId!,
          quantity: quantity(qty),
          unitCost: unitPrice(cost),
          amount: amount(floorTo(qty.times(cost), 0)),
          reason: doc.reasonCode,
          occurredAt,
        });
        break;

      case 'ISSUE':
        rows.push({
          sourceType: 'STOCK_DOCUMENT',
          sourceId: doc.id,
          sourceLineId: line.id,
          itemId: line.itemId,
          warehouseId: doc.fromWarehouseId!,
          quantity: quantity(qty.neg()),
          unitCost: unitPrice(cost),
          amount: amount(floorTo(qty.times(cost), 0).neg()),
          reason: doc.reasonCode,
          occurredAt,
        });
        break;

      case 'TRANSFER': {
        const value = floorTo(qty.times(cost), 0);
        rows.push({
          sourceType: 'STOCK_DOCUMENT',
          sourceId: doc.id,
          sourceLineId: `${line.id}:out`,
          itemId: line.itemId,
          warehouseId: doc.fromWarehouseId!,
          quantity: quantity(qty.neg()),
          unitCost: unitPrice(cost),
          amount: amount(value.neg()),
          reason: '창고이동 출고',
          occurredAt,
        });
        rows.push({
          sourceType: 'STOCK_DOCUMENT',
          sourceId: doc.id,
          sourceLineId: `${line.id}:in`,
          itemId: line.itemId,
          warehouseId: doc.toWarehouseId!,
          quantity: quantity(qty),
          unitCost: unitPrice(cost),
          amount: amount(value),
          reason: '창고이동 입고',
          occurredAt,
        });
        break;
      }

      case 'ADJUST':
        rows.push({
          sourceType: 'STOCK_DOCUMENT',
          sourceId: doc.id,
          sourceLineId: line.id,
          itemId: line.itemId,
          warehouseId: doc.toWarehouseId!,
          quantity: quantity(qty),
          unitCost: unitPrice(cost),
          amount: amount(floorTo(qty.times(cost), 0)),
          reason: doc.reasonCode ?? '재고실사 조정',
          occurredAt,
        });
        break;
    }
  }

  return rows;
}

/** INT-08 + INV-06: lock, re-read, check, then post — all inside the caller's transaction. */
async function postWithChecks(
  ctx: TransactionContext,
  rows: ledger.LedgerRow[],
  _docType: StockDocType,
): Promise<void> {
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
  await assertNoNegative(ctx, after, requested);
  await ledger.post(ctx, rows);
}

async function assertNoNegative(
  ctx: TransactionContext,
  after: Map<string, { quantity: ReturnType<typeof D>; amount: ReturnType<typeof D> }>,
  requested: Map<string, ReturnType<typeof D>>,
): Promise<void> {
  const issues = await ledger.checkNegative(ctx, after, requested);
  if (issues.length === 0) return;

  if ((await ledger.negativeStockMode(ctx)) === 'BLOCK') throw ledger.negativeStockError(issues);

  await ctx.tx.securityEvent.create({
    data: {
      type: 'NEGATIVE_STOCK_WARNING',
      userId: ctx.actor.userId === 'system' ? null : ctx.actor.userId,
      ip: ctx.ip ?? null,
      meta: { issues } as never,
    },
  });
}

// ── read ──

export async function list(
  ctx: TransactionContext,
  input: {
    docType?: StockDocType;
    status?: string;
    warehouseId?: string;
    itemId?: string;
    from?: string;
    to?: string;
    q?: string;
    skip: number;
    take: number;
  },
) {
  requirePermission(ctx.actor, 'inventory.read');
  const scope = ctx.actor.isAdmin ? undefined : ctx.actor.warehouseIds;

  const where = {
    ...(input.docType ? { docType: input.docType } : {}),
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
    ...(input.itemId ? { lines: { some: { itemId: input.itemId } } } : {}),
    ...(input.warehouseId
      ? { OR: [{ fromWarehouseId: input.warehouseId }, { toWarehouseId: input.warehouseId }] }
      : scope
        ? { OR: [{ fromWarehouseId: { in: scope } }, { toWarehouseId: { in: scope } }] }
        : {}),
  };

  const [rows, total] = await Promise.all([
    ctx.tx.stockDocument.findMany({
      where,
      include: {
        fromWarehouse: { select: { id: true, name: true } },
        toWarehouse: { select: { id: true, name: true } },
        partner: { select: { id: true, name: true } },
        _count: { select: { lines: true } },
      },
      orderBy: [{ docDate: 'desc' }, { docNo: 'desc' }],
      skip: input.skip,
      take: input.take,
    }),
    ctx.tx.stockDocument.count({ where }),
  ]);
  return { rows, total };
}

export async function detail(ctx: TransactionContext, id: string) {
  requirePermission(ctx.actor, 'inventory.read');
  const doc = await ctx.tx.stockDocument.findUnique({
    where: { id },
    include: {
      fromWarehouse: { select: { id: true, name: true } },
      toWarehouse: { select: { id: true, name: true } },
      partner: { select: { id: true, name: true } },
      lines: {
        orderBy: { lineNo: 'asc' },
        include: { item: { select: { id: true, code: true, name: true, spec: true, unitCode: true } } },
      },
    },
  });
  if (!doc) throw new AppError('NOT_FOUND', '재고 전표를 찾을 수 없습니다.');

  const req = await matrix.requirement(
    ctx,
    MATRIX_TYPE[doc.docType as StockDocType],
    doc.totalAmount.toString(),
    doc.docDate.toISOString().slice(0, 10),
  );
  const ledgerRows = await ctx.tx.inventoryLedger.findMany({
    where: { sourceType: 'STOCK_DOCUMENT', sourceId: id },
    orderBy: { createdAt: 'asc' },
    include: { warehouse: { select: { name: true } }, item: { select: { code: true, name: true } } },
  });

  const approvalInfo = await approvalState.approvalStateOf(ctx, 'STOCK_DOCUMENT', id);

  return {
    ...doc,
    approvalRequired: req.required,
    approvalReason: req.reason,
    ...approvalInfo,
    ledgerRows,
  };
}

// ── helpers ──

function lineAmount(l: LineInput): string {
  return l.unitCost ? amount(floorTo(D(l.quantity).abs().times(D(l.unitCost)), 0)) : '0';
}

function totalsOf(lines: LineInput[]): { quantity: string; amount: string } {
  let q = ZERO;
  let a = ZERO;
  for (const l of lines) {
    q = q.plus(D(l.quantity).abs());
    a = a.plus(D(lineAmount(l)));
  }
  return { quantity: quantity(q), amount: amount(a) };
}
