import type { TransactionContext } from '@/server/core/context';
import { AppError } from '@/server/core/errors';
import { add, amount, cmp, D, quantity, ZERO } from '@/lib/money';
import type Decimal from 'decimal.js';

/**
 * INV-04 / INT-04: stock on hand is the sum of InventoryLedger. Nothing else is
 * authoritative — StockSnapshot is a cache that this module keeps in step and that
 * `rebuild` can recreate from scratch.
 *
 * INT-07: a cancellation writes an opposite row. Rows are never updated or deleted
 * (enforced by the erp_append_only_InventoryLedger trigger).
 */

export interface LedgerRow {
  sourceType: string;
  sourceId: string;
  sourceLineId?: string | null;
  sourceVersion?: number;
  itemId: string;
  warehouseId: string;
  /** signed: positive inbound, negative outbound */
  quantity: string;
  unitCost?: string | null;
  amount?: string | null;
  reason?: string | null;
  occurredAt: Date;
}

export interface StockKey {
  itemId: string;
  warehouseId: string;
}

/**
 * INT-08: acquire row locks in a deterministic (itemId, warehouseId) order so
 * concurrent issues serialise instead of deadlocking. Returns the locked balances.
 *
 * The lock is taken on StockSnapshot rows, which exist for every touched pair — the
 * caller must have created them via `ensureSnapshotRows` first. Locking the cache row
 * rather than the ledger gives us a single row per key to contend on; the balance we
 * then read still comes from the ledger, so correctness never depends on the cache.
 */
export async function lockAndRead(
  ctx: TransactionContext,
  keys: StockKey[],
): Promise<Map<string, { quantity: Decimal; amount: Decimal }>> {
  const unique = dedupe(keys);
  if (unique.length === 0) return new Map();

  await ensureSnapshotRows(ctx, unique);

  // deterministic lock order (INT-08)
  const sorted = [...unique].sort((a, b) =>
    a.itemId === b.itemId ? a.warehouseId.localeCompare(b.warehouseId) : a.itemId.localeCompare(b.itemId),
  );

  for (const k of sorted) {
    await ctx.tx.$queryRawUnsafe(
      'SELECT id FROM "StockSnapshot" WHERE "itemId" = $1 AND "warehouseId" = $2 FOR UPDATE',
      k.itemId,
      k.warehouseId,
    );
  }

  return balances(ctx, sorted);
}

/** The authoritative balance for each key, summed from the ledger. */
export async function balances(
  ctx: TransactionContext,
  keys: StockKey[],
): Promise<Map<string, { quantity: Decimal; amount: Decimal }>> {
  const out = new Map<string, { quantity: Decimal; amount: Decimal }>();
  const unique = dedupe(keys);
  if (unique.length === 0) return out;

  const rows = await ctx.tx.inventoryLedger.groupBy({
    by: ['itemId', 'warehouseId'],
    where: { OR: unique.map((k) => ({ itemId: k.itemId, warehouseId: k.warehouseId })) },
    _sum: { quantity: true, amount: true },
  });

  for (const k of unique) out.set(key(k), { quantity: ZERO, amount: ZERO });
  for (const r of rows) {
    out.set(key(r), {
      quantity: D(r._sum.quantity ?? 0),
      amount: D(r._sum.amount ?? 0),
    });
  }
  return out;
}

/**
 * Appends ledger rows and moves the snapshot cache by the same delta.
 *
 * `sourceVersion` separates an original posting (1) from its reversal (2), so the
 * (sourceType, sourceId, sourceLineId, sourceVersion) unique index makes a repeated
 * confirm or a repeated cancel fail loudly rather than double-post (INT-05).
 */
export async function post(ctx: TransactionContext, rows: LedgerRow[]): Promise<void> {
  if (rows.length === 0) return;

  try {
    await ctx.tx.inventoryLedger.createMany({
      data: rows.map((r) => ({
        sourceType: r.sourceType,
        sourceId: r.sourceId,
        sourceLineId: r.sourceLineId ?? null,
        sourceVersion: r.sourceVersion ?? 1,
        itemId: r.itemId,
        warehouseId: r.warehouseId,
        quantity: quantity(r.quantity),
        unitCost: r.unitCost ?? null,
        amount: amount(r.amount ?? 0),
        reason: r.reason ?? null,
        occurredAt: r.occurredAt,
        createdById: ctx.actor.userId === 'system' ? null : ctx.actor.userId,
      })),
    });
  } catch (e) {
    if ((e as { code?: string }).code === 'P2002') {
      throw new AppError(
        'DUPLICATE_EFFECT',
        '이미 원장에 반영된 전표입니다. 새로 고친 뒤 상태를 확인하세요.',
        { sourceType: rows[0]!.sourceType, sourceId: rows[0]!.sourceId },
      );
    }
    throw e;
  }

  await applyToSnapshot(ctx, rows);
}

/** Writes the reversing rows for a source that was already posted (INT-07). */
export async function reverse(
  ctx: TransactionContext,
  sourceType: string,
  sourceId: string,
  input: { occurredAt: Date; reason: string },
): Promise<void> {
  const original = await ctx.tx.inventoryLedger.findMany({
    where: { sourceType, sourceId, sourceVersion: 1 },
    orderBy: { id: 'asc' },
  });
  if (original.length === 0) return;

  await post(
    ctx,
    original.map((r) => ({
      sourceType,
      sourceId,
      sourceLineId: r.sourceLineId,
      sourceVersion: 2,
      itemId: r.itemId,
      warehouseId: r.warehouseId,
      quantity: D(r.quantity).neg().toString(),
      unitCost: r.unitCost?.toString() ?? null,
      amount: D(r.amount).neg().toString(),
      reason: input.reason,
      occurredAt: input.occurredAt,
    })),
  );
}

/**
 * INV-06: negative stock is refused or warned about according to the setting, checked
 * inside the confirming transaction after the rows are locked. `allowNegative` comes
 * from SystemSetting so the behaviour can be switched without a deploy.
 */
export interface NegativeStockIssue {
  itemId: string;
  warehouseId: string;
  itemName: string;
  warehouseName: string;
  current: string;
  requested: string;
  resulting: string;
}

export async function checkNegative(
  ctx: TransactionContext,
  after: Map<string, { quantity: Decimal; amount: Decimal }>,
  requested: Map<string, Decimal>,
): Promise<NegativeStockIssue[]> {
  const offending = [...after.entries()].filter(([, v]) => v.quantity.isNegative());
  if (offending.length === 0) return [];

  const itemIds = [...new Set(offending.map(([k]) => k.split('::')[0]!))];
  const warehouseIds = [...new Set(offending.map(([k]) => k.split('::')[1]!))];
  const [items, warehouses] = await Promise.all([
    ctx.tx.item.findMany({ where: { id: { in: itemIds } }, select: { id: true, name: true } }),
    ctx.tx.warehouse.findMany({ where: { id: { in: warehouseIds } }, select: { id: true, name: true } }),
  ]);
  const itemName = new Map(items.map((i) => [i.id, i.name]));
  const warehouseName = new Map(warehouses.map((w) => [w.id, w.name]));

  return offending.map(([k, v]) => {
    const [itemId, warehouseId] = k.split('::') as [string, string];
    const req = requested.get(k) ?? ZERO;
    return {
      itemId,
      warehouseId,
      itemName: itemName.get(itemId) ?? itemId,
      warehouseName: warehouseName.get(warehouseId) ?? warehouseId,
      current: quantity(v.quantity.minus(req)),
      requested: quantity(req.neg()),
      resulting: quantity(v.quantity),
    };
  });
}

export async function negativeStockMode(ctx: TransactionContext): Promise<'BLOCK' | 'WARN'> {
  const row = await ctx.tx.systemSetting.findUnique({ where: { key: 'inventory.allowNegative' } });
  const allow = (row?.value as { value?: boolean } | null)?.value === true;
  return allow ? 'WARN' : 'BLOCK';
}

export function negativeStockError(issues: NegativeStockIssue[]): AppError {
  const lines = issues.map(
    (i) => `${i.itemName}(${i.warehouseName}): 현재 ${i.current}, 출고 ${i.requested} → ${i.resulting}`,
  );
  return new AppError('INSUFFICIENT_STOCK', `재고가 부족해 확정할 수 없습니다.\n${lines.join('\n')}`, {
    issues,
  });
}

// ── snapshot cache (INV-04) ──

async function ensureSnapshotRows(ctx: TransactionContext, keys: StockKey[]): Promise<void> {
  await ctx.tx.stockSnapshot.createMany({
    data: keys.map((k) => ({ itemId: k.itemId, warehouseId: k.warehouseId })),
    skipDuplicates: true,
  });
}

async function applyToSnapshot(ctx: TransactionContext, rows: LedgerRow[]): Promise<void> {
  const deltas = new Map<string, { itemId: string; warehouseId: string; qty: Decimal; amt: Decimal }>();
  for (const r of rows) {
    const k = key(r);
    const cur = deltas.get(k) ?? { itemId: r.itemId, warehouseId: r.warehouseId, qty: ZERO, amt: ZERO };
    cur.qty = cur.qty.plus(D(r.quantity));
    cur.amt = cur.amt.plus(D(r.amount ?? 0));
    deltas.set(k, cur);
  }

  for (const d of deltas.values()) {
    await ctx.tx.stockSnapshot.upsert({
      where: { itemId_warehouseId: { itemId: d.itemId, warehouseId: d.warehouseId } },
      create: {
        itemId: d.itemId,
        warehouseId: d.warehouseId,
        quantity: quantity(d.qty),
        amount: amount(d.amt),
      },
      update: {
        quantity: { increment: quantity(d.qty) },
        amount: { increment: amount(d.amt) },
      },
    });
  }
}

export interface SnapshotDrift {
  itemId: string;
  warehouseId: string;
  ledgerQuantity: string;
  snapshotQuantity: string;
  ledgerAmount: string;
  snapshotAmount: string;
}

/**
 * INV-04: reports every key where the cache disagrees with the ledger. The ledger is
 * right by definition, so any row returned here is a cache bug, not a stock problem.
 */
export async function reconcile(ctx: TransactionContext): Promise<SnapshotDrift[]> {
  const rows = await ctx.tx.$queryRawUnsafe<
    {
      itemId: string;
      warehouseId: string;
      ledgerQuantity: string;
      snapshotQuantity: string;
      ledgerAmount: string;
      snapshotAmount: string;
    }[]
  >(`
    WITH l AS (
      SELECT "itemId", "warehouseId", SUM(quantity) AS qty, SUM(amount) AS amt
      FROM "InventoryLedger" GROUP BY "itemId", "warehouseId"
    )
    SELECT
      COALESCE(l."itemId", s."itemId")           AS "itemId",
      COALESCE(l."warehouseId", s."warehouseId") AS "warehouseId",
      COALESCE(l.qty, 0)::text                   AS "ledgerQuantity",
      COALESCE(s.quantity, 0)::text              AS "snapshotQuantity",
      COALESCE(l.amt, 0)::text                   AS "ledgerAmount",
      COALESCE(s.amount, 0)::text                AS "snapshotAmount"
    FROM l
    FULL OUTER JOIN "StockSnapshot" s
      ON s."itemId" = l."itemId" AND s."warehouseId" = l."warehouseId"
    WHERE COALESCE(l.qty, 0) <> COALESCE(s.quantity, 0)
       OR COALESCE(l.amt, 0) <> COALESCE(s.amount, 0)
  `);
  return rows;
}

/** Recreates the whole cache from the ledger. Safe to run at any time. */
export async function rebuild(ctx: TransactionContext): Promise<{ rows: number }> {
  await ctx.tx.$executeRawUnsafe('DELETE FROM "StockSnapshot"');
  const inserted = await ctx.tx.$executeRawUnsafe(`
    INSERT INTO "StockSnapshot" ("id", "itemId", "warehouseId", "quantity", "amount", "updatedAt")
    SELECT
      md5(random()::text || clock_timestamp()::text),
      "itemId", "warehouseId", SUM(quantity), SUM(amount), NOW()
    FROM "InventoryLedger"
    GROUP BY "itemId", "warehouseId"
  `);
  return { rows: inserted };
}

// ── helpers ──

export const key = (k: StockKey): string => `${k.itemId}::${k.warehouseId}`;

function dedupe(keys: StockKey[]): StockKey[] {
  const seen = new Map<string, StockKey>();
  for (const k of keys) seen.set(key(k), k);
  return [...seen.values()];
}

/** Applies signed deltas to a balance map, returning the resulting map. */
export function applyDeltas(
  base: Map<string, { quantity: Decimal; amount: Decimal }>,
  deltas: { itemId: string; warehouseId: string; quantity: string; amount?: string }[],
): { after: Map<string, { quantity: Decimal; amount: Decimal }>; requested: Map<string, Decimal> } {
  const after = new Map(base);
  const requested = new Map<string, Decimal>();
  for (const d of deltas) {
    const k = key(d);
    const cur = after.get(k) ?? { quantity: ZERO, amount: ZERO };
    after.set(k, {
      quantity: cur.quantity.plus(D(d.quantity)),
      amount: cur.amount.plus(D(d.amount ?? 0)),
    });
    requested.set(k, add(requested.get(k) ?? ZERO, D(d.quantity)));
  }
  return { after, requested };
}

export { cmp };
