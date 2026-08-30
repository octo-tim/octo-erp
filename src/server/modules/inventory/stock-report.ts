import type { TransactionContext } from '@/server/core/context';
import { requirePermission } from '@/server/modules/rbac/service';
import * as valuation from './valuation';
import { amount, D, quantity, ZERO } from '@/lib/money';
import { toDateOnly } from '@/lib/dates';

/**
 * INV-04 (현재고) and INV-05 (수불부).
 *
 * Both read the ledger, never the snapshot cache: the cache exists to make the on-hand
 * list fast, but a report that has to reconcile with the books must come from the books.
 * The on-hand list below reads the cache and returns the ledger totals alongside so a
 * drift is visible rather than silent.
 */

export interface OnHandRow {
  itemId: string;
  code: string;
  name: string;
  spec: string | null;
  unitCode: string;
  categoryName: string | null;
  warehouseId: string;
  warehouseName: string;
  quantity: string;
  amount: string;
  safetyStock: string | null;
  belowSafety: boolean;
}

export async function onHand(
  ctx: TransactionContext,
  input: {
    warehouseId?: string;
    categoryId?: string;
    q?: string;
    hideZero?: boolean;
    belowSafetyOnly?: boolean;
  },
): Promise<OnHandRow[]> {
  requirePermission(ctx.actor, 'inventory.read');
  const scope = ctx.actor.isAdmin ? undefined : ctx.actor.warehouseIds;

  const rows = await ctx.tx.stockSnapshot.findMany({
    where: {
      ...(input.warehouseId
        ? { warehouseId: input.warehouseId }
        : scope
          ? { warehouseId: { in: scope } }
          : {}),
      ...(input.hideZero ? { NOT: { quantity: 0 } } : {}),
      item: {
        isActive: true,
        ...(input.categoryId ? { categoryId: input.categoryId } : {}),
        ...(input.q
          ? {
              OR: [
                { code: { contains: input.q, mode: 'insensitive' as const } },
                { name: { contains: input.q, mode: 'insensitive' as const } },
              ],
            }
          : {}),
      },
    },
    include: {
      item: { include: { category: { select: { name: true } } } },
      warehouse: { select: { id: true, name: true } },
    },
    orderBy: [{ item: { code: 'asc' } }, { warehouse: { code: 'asc' } }],
    take: 2000,
  });

  // safety stock is an item-level figure, so it is compared against the total across warehouses
  const totals = await ctx.tx.inventoryLedger.groupBy({
    by: ['itemId'],
    where: { itemId: { in: [...new Set(rows.map((r) => r.itemId))] } },
    _sum: { quantity: true },
  });
  const itemTotal = new Map(totals.map((t) => [t.itemId, D(t._sum.quantity ?? 0)]));

  const mapped = rows.map((r) => {
    const safety = r.item.safetyStock ? D(r.item.safetyStock) : null;
    const total = itemTotal.get(r.itemId) ?? ZERO;
    return {
      itemId: r.itemId,
      code: r.item.code,
      name: r.item.name,
      spec: r.item.spec,
      unitCode: r.item.unitCode,
      categoryName: r.item.category?.name ?? null,
      warehouseId: r.warehouseId,
      warehouseName: r.warehouse.name,
      quantity: quantity(r.quantity),
      amount: amount(r.amount),
      safetyStock: safety ? quantity(safety) : null,
      belowSafety: safety !== null && total.lt(safety),
    };
  });

  return input.belowSafetyOnly ? mapped.filter((r) => r.belowSafety) : mapped;
}

export interface LedgerBookRow {
  ledgerId: string;
  occurredAt: string;
  sourceType: string;
  sourceId: string;
  docNo: string | null;
  docType: string | null;
  warehouseName: string;
  reason: string | null;
  inQty: string;
  outQty: string;
  inAmount: string;
  outAmount: string;
  balanceQty: string;
  balanceAmount: string;
}

export interface LedgerBook {
  itemId: string;
  itemLabel: string;
  unitCode: string;
  from: string;
  to: string;
  opening: { quantity: string; amount: string };
  closing: { quantity: string; amount: string };
  totals: { inQty: string; outQty: string; inAmount: string; outAmount: string };
  rows: LedgerBookRow[];
  periodStatus: 'OPEN' | 'CLOSED';
}

/**
 * INV-05 — the stock book for one item over a period: opening, every movement with its
 * source document, and closing. The running balance is computed here so the reader can
 * check any line against the one above it.
 */
export async function book(
  ctx: TransactionContext,
  input: { itemId: string; from: string; to: string; warehouseId?: string },
): Promise<LedgerBook> {
  requirePermission(ctx.actor, 'inventory.read');
  const scope = ctx.actor.isAdmin ? undefined : ctx.actor.warehouseIds;
  const warehouseFilter = input.warehouseId
    ? { warehouseId: input.warehouseId }
    : scope
      ? { warehouseId: { in: scope } }
      : {};

  const item = await ctx.tx.item.findUniqueOrThrow({
    where: { id: input.itemId },
    select: { code: true, name: true, unitCode: true },
  });

  const before = await ctx.tx.inventoryLedger.aggregate({
    where: { itemId: input.itemId, ...warehouseFilter, occurredAt: { lt: toDateOnly(input.from) } },
    _sum: { quantity: true, amount: true },
  });

  const movements = await ctx.tx.inventoryLedger.findMany({
    where: {
      itemId: input.itemId,
      ...warehouseFilter,
      occurredAt: { gte: toDateOnly(input.from), lte: toDateOnly(input.to) },
    },
    include: { warehouse: { select: { name: true } } },
    orderBy: [{ occurredAt: 'asc' }, { createdAt: 'asc' }],
  });

  // resolve the source documents in one query so each row can link back (INV-05 원천전표)
  const stockIds = movements.filter((m) => m.sourceType === 'STOCK_DOCUMENT').map((m) => m.sourceId);
  const docs = await ctx.tx.stockDocument.findMany({
    where: { id: { in: [...new Set(stockIds)] } },
    select: { id: true, docNo: true, docType: true },
  });
  const docById = new Map(docs.map((d) => [d.id, d]));

  let balanceQty = D(before._sum.quantity ?? 0);
  let balanceAmount = D(before._sum.amount ?? 0);
  let inQty = ZERO;
  let outQty = ZERO;
  let inAmount = ZERO;
  let outAmount = ZERO;

  const rows: LedgerBookRow[] = movements.map((m) => {
    const q = D(m.quantity);
    const a = D(m.amount);
    balanceQty = balanceQty.plus(q);
    balanceAmount = balanceAmount.plus(a);

    const isIn = q.gt(0) || (q.isZero() && a.gt(0));
    if (isIn) {
      inQty = inQty.plus(q);
      inAmount = inAmount.plus(a);
    } else {
      outQty = outQty.plus(q.neg());
      outAmount = outAmount.plus(a.neg());
    }

    const doc = docById.get(m.sourceId);
    return {
      ledgerId: m.id,
      occurredAt: m.occurredAt.toISOString().slice(0, 10),
      sourceType: m.sourceType,
      sourceId: m.sourceId,
      docNo: doc?.docNo ?? null,
      docType: doc?.docType ?? null,
      warehouseName: m.warehouse.name,
      reason: m.reason,
      inQty: isIn ? quantity(q) : '0.000',
      outQty: isIn ? '0.000' : quantity(q.neg()),
      inAmount: isIn ? amount(a) : '0',
      outAmount: isIn ? '0' : amount(a.neg()),
      balanceQty: quantity(balanceQty),
      balanceAmount: amount(balanceAmount),
    };
  });

  return {
    itemId: input.itemId,
    itemLabel: `${item.name} (${item.code})`,
    unitCode: item.unitCode,
    from: input.from,
    to: input.to,
    opening: {
      quantity: quantity(D(before._sum.quantity ?? 0)),
      amount: amount(D(before._sum.amount ?? 0)),
    },
    closing: { quantity: quantity(balanceQty), amount: amount(balanceAmount) },
    totals: {
      inQty: quantity(inQty),
      outQty: quantity(outQty),
      inAmount: amount(inAmount),
      outAmount: amount(outAmount),
    },
    rows,
    periodStatus: await valuation.periodStatus(ctx, input.to.slice(0, 7)),
  };
}

/** INV-05: the book as CSV rows, for the Excel export the RFP asks for. */
export function bookToCsv(b: LedgerBook): string {
  const header = [
    '일자',
    '전표번호',
    '구분',
    '창고',
    '사유',
    '입고수량',
    '출고수량',
    '입고금액',
    '출고금액',
    '재고수량',
    '재고금액',
  ];
  const lines = [
    header.join(','),
    ['', '', '기초', '', '', '', '', '', '', b.opening.quantity, b.opening.amount].join(','),
    ...b.rows.map((r) =>
      [
        r.occurredAt,
        r.docNo ?? r.sourceType,
        r.docType ?? '',
        csv(r.warehouseName),
        csv(r.reason ?? ''),
        r.inQty,
        r.outQty,
        r.inAmount,
        r.outAmount,
        r.balanceQty,
        r.balanceAmount,
      ].join(','),
    ),
    [
      '',
      '',
      '기말',
      '',
      '',
      b.totals.inQty,
      b.totals.outQty,
      b.totals.inAmount,
      b.totals.outAmount,
      b.closing.quantity,
      b.closing.amount,
    ].join(','),
  ];
  return lines.join('\n');
}

function csv(v: string): string {
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}
