import type { TransactionContext } from '@/server/core/context';
import { requirePermission } from '@/server/modules/rbac/service';
import { notify } from '@/server/modules/notification/service';
import { D, quantity } from '@/lib/money';
import { businessDate } from '@/lib/dates';

/**
 * INV-07 — safety stock.
 *
 * The check runs at the end of a confirming transaction, on the items that actually moved,
 * and only notifies on the transition into shortfall: the dedup key carries the business
 * date, so one item produces at most one alert per day however many issues touch it.
 * DEC-09 decides which channels the notification then fans out to.
 */

export interface ShortfallRow {
  itemId: string;
  code: string;
  name: string;
  unitCode: string;
  safetyStock: string;
  onHand: string;
  shortage: string;
}

/** Items whose total on-hand across all warehouses is below their safety stock. */
export async function shortfalls(ctx: TransactionContext, itemIds?: string[]): Promise<ShortfallRow[]> {
  const items = await ctx.tx.item.findMany({
    where: {
      isActive: true,
      safetyStock: { not: null },
      ...(itemIds?.length ? { id: { in: [...new Set(itemIds)] } } : {}),
    },
    select: { id: true, code: true, name: true, unitCode: true, safetyStock: true },
  });
  if (items.length === 0) return [];

  const sums = await ctx.tx.inventoryLedger.groupBy({
    by: ['itemId'],
    where: { itemId: { in: items.map((i) => i.id) } },
    _sum: { quantity: true },
  });
  const onHand = new Map(sums.map((s) => [s.itemId, D(s._sum.quantity ?? 0)]));

  const rows: ShortfallRow[] = [];
  for (const item of items) {
    const have = onHand.get(item.id) ?? D(0);
    const want = D(item.safetyStock!);
    if (have.gte(want)) continue;
    rows.push({
      itemId: item.id,
      code: item.code,
      name: item.name,
      unitCode: item.unitCode,
      safetyStock: quantity(want),
      onHand: quantity(have),
      shortage: quantity(want.minus(have)),
    });
  }
  return rows;
}

/** Called from a confirming transaction. Notifies the users who can act on it. */
export async function checkSafetyStock(ctx: TransactionContext, itemIds: string[]): Promise<ShortfallRow[]> {
  const rows = await shortfalls(ctx, itemIds);
  if (rows.length === 0) return [];

  const recipients = await recipientUserIds(ctx);
  if (recipients.length === 0) return rows;

  const today = businessDate(ctx.now);
  for (const row of rows) {
    await notify(ctx, {
      userIds: recipients,
      category: 'STOCK',
      title: `안전재고 미달: ${row.name}`,
      body: `현재고 ${row.onHand} ${row.unitCode} / 안전재고 ${row.safetyStock} ${row.unitCode} (부족 ${row.shortage})`,
      linkUrl: `/inventory/stock?itemId=${row.itemId}`,
      email: true,
      // one alert per item per business day, however many movements touch it
      dedupKey: `safety-stock:${row.itemId}:${today}`,
    });
  }
  return rows;
}

/** Whoever holds inventory.write is who can do something about a shortfall. */
async function recipientUserIds(ctx: TransactionContext): Promise<string[]> {
  const rows = await ctx.tx.userRole.findMany({
    where: {
      role: { permissions: { some: { permission: { code: 'inventory.write' } } } },
      user: { isActive: true },
    },
    select: { userId: true },
  });
  return [...new Set(rows.map((r) => r.userId))];
}

/** The screen version: every shortfall, newest position, no notification. */
export async function list(ctx: TransactionContext): Promise<ShortfallRow[]> {
  requirePermission(ctx.actor, 'inventory.read');
  return shortfalls(ctx);
}
