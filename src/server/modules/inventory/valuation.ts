import type { TransactionContext } from '@/server/core/context';
import { AppError } from '@/server/core/errors';
import { requirePermission } from '@/server/modules/rbac/service';
import * as policy from '@/server/modules/policy/service';
import * as audit from '@/server/modules/audit/service';
import * as ledger from './ledger';
import { amount, D, floorTo, quantity, unitPrice, ZERO } from '@/lib/money';
import { monthRange, periodKey, toDateOnly } from '@/lib/dates';
import Decimal from 'decimal.js';

/**
 * INV-09 / DEC-01 / ADR-0003 — monthly total average.
 *
 * During the month an issue is valued at the running provisional average:
 *   (previous month-end confirmed amount + receipts so far) / (previous qty + receipts so far)
 * At month close the confirmed average uses the WHOLE month's receipts, every issue is
 * revalued at it, and the difference is posted as one VALUATION_ADJUST ledger row per item.
 *
 * This is deliberately not moving average: the unit cost of an issue does not change as
 * later receipts arrive, it is fixed once at issue time and corrected once at close.
 */

export interface ValuationConfig {
  method: string;
  provisionalWithinMonth: boolean;
  closeAdjusts: boolean;
}

/** Every unit cost is truncated to the KRW unit, per ADR-0003 ("원단위 절사"). */
export function averageOf(
  openingAmount: Decimal,
  inAmount: Decimal,
  openingQty: Decimal,
  inQty: Decimal,
): Decimal {
  const qty = openingQty.plus(inQty);
  if (qty.lte(0)) return ZERO;
  return floorTo(openingAmount.plus(inAmount).div(qty), 0);
}

interface ItemPosition {
  openingQty: Decimal;
  openingAmount: Decimal;
  inQty: Decimal;
  inAmount: Decimal;
}

/**
 * The provisional unit cost for an issue of `itemId` happening now, across all warehouses:
 * stock is valued per item, not per warehouse (a transfer must not change cost).
 */
export async function provisionalCost(
  ctx: TransactionContext,
  itemId: string,
  occurredAt: Date,
): Promise<Decimal> {
  const period = periodKey(occurredAt);
  const pos = await positionOf(ctx, itemId, period, occurredAt);
  return averageOf(pos.openingAmount, pos.inAmount, pos.openingQty, pos.inQty);
}

/** Same as `provisionalCost` for a set of items, in one pass. */
export async function provisionalCosts(
  ctx: TransactionContext,
  itemIds: string[],
  occurredAt: Date,
): Promise<Map<string, Decimal>> {
  const out = new Map<string, Decimal>();
  for (const id of [...new Set(itemIds)]) out.set(id, await provisionalCost(ctx, id, occurredAt));
  return out;
}

/**
 * Opening (everything before the period) plus receipts within the period up to `upTo`.
 * Opening amount comes from the previous close when there is one, so a closed month is
 * never recomputed from raw ledger rows.
 */
async function positionOf(
  ctx: TransactionContext,
  itemId: string,
  period: string,
  upTo?: Date,
): Promise<ItemPosition> {
  const { start, endExclusive } = monthRange(period);

  const prior = await ctx.tx.inventoryPeriodCost.findFirst({
    where: { itemId, period: { period: { lt: period }, status: 'CLOSED' } },
    orderBy: { period: { period: 'desc' } },
  });

  let openingQty: Decimal;
  let openingAmount: Decimal;
  if (prior) {
    openingQty = D(prior.closingQty);
    openingAmount = D(prior.closingAmount);
  } else {
    const before = await ctx.tx.inventoryLedger.aggregate({
      where: { itemId, occurredAt: { lt: toDateOnly(start) } },
      _sum: { quantity: true, amount: true },
    });
    openingQty = D(before._sum.quantity ?? 0);
    openingAmount = D(before._sum.amount ?? 0);
  }

  const receipts = await ctx.tx.inventoryLedger.aggregate({
    where: {
      itemId,
      quantity: { gt: 0 },
      sourceType: { not: 'VALUATION_ADJUST' },
      occurredAt: { gte: toDateOnly(start), ...(upTo ? { lte: upTo } : { lt: toDateOnly(endExclusive) }) },
    },
    _sum: { quantity: true, amount: true },
  });

  return {
    openingQty,
    openingAmount,
    inQty: D(receipts._sum.quantity ?? 0),
    inAmount: D(receipts._sum.amount ?? 0),
  };
}

export async function listPeriods(ctx: TransactionContext) {
  requirePermission(ctx.actor, 'inventory.read');
  return ctx.tx.inventoryValuationPeriod.findMany({ orderBy: { period: 'desc' }, take: 36 });
}

export async function periodStatus(ctx: TransactionContext, period: string): Promise<'OPEN' | 'CLOSED'> {
  const row = await ctx.tx.inventoryValuationPeriod.findUnique({ where: { period } });
  return row?.status === 'CLOSED' ? 'CLOSED' : 'OPEN';
}

/**
 * A movement may not be posted into a month whose valuation is already closed.
 *
 * Locked FOR SHARE for the same reason as the accounting calendar: an unlocked read lets a
 * month close underneath a confirm that is still running, and the movement lands in a month
 * whose average cost has already been fixed and reported.
 */
export async function assertPeriodOpen(ctx: TransactionContext, docDate: string): Promise<void> {
  const period = periodKey(docDate);
  await ctx.tx.$queryRawUnsafe(
    'SELECT period FROM "InventoryValuationPeriod" WHERE "period" = $1 FOR SHARE',
    period,
  );
  if ((await periodStatus(ctx, period)) === 'CLOSED') {
    throw new AppError(
      'PERIOD_CLOSED',
      `${period} 재고 평가가 마감되어 해당 월의 전표를 처리할 수 없습니다. 마감을 해제한 뒤 다시 시도하세요.`,
      { period },
    );
  }
}

export interface CloseResult {
  period: string;
  items: number;
  totalAdjustment: string;
  lines: {
    itemId: string;
    itemName: string;
    averageCost: string;
    outQty: string;
    provisionalOutAmount: string;
    finalOutAmount: string;
    adjustment: string;
    closingQty: string;
    closingAmount: string;
  }[];
}

/**
 * Computes what the close would produce without writing anything, so the screen can show
 * the adjustment before anyone commits to it.
 */
export async function preview(ctx: TransactionContext, period: string): Promise<CloseResult> {
  requirePermission(ctx.actor, 'inventory.read');
  return compute(ctx, period);
}

async function compute(ctx: TransactionContext, period: string): Promise<CloseResult> {
  const { start, endExclusive } = monthRange(period);

  const touched = await ctx.tx.inventoryLedger.groupBy({
    by: ['itemId'],
    where: { occurredAt: { gte: toDateOnly(start), lt: toDateOnly(endExclusive) } },
    _sum: { quantity: true },
  });

  const itemIds = touched.map((t) => t.itemId);
  const items = await ctx.tx.item.findMany({
    where: { id: { in: itemIds } },
    select: { id: true, name: true, code: true },
  });
  const names = new Map(items.map((i) => [i.id, `${i.name} (${i.code})`]));

  const lines: CloseResult['lines'] = [];
  let total = ZERO;

  for (const itemId of itemIds) {
    const pos = await positionOf(ctx, itemId, period);
    const averageCost = averageOf(pos.openingAmount, pos.inAmount, pos.openingQty, pos.inQty);

    const issues = await ctx.tx.inventoryLedger.aggregate({
      where: {
        itemId,
        quantity: { lt: 0 },
        sourceType: { not: 'VALUATION_ADJUST' },
        occurredAt: { gte: toDateOnly(start), lt: toDateOnly(endExclusive) },
      },
      _sum: { quantity: true, amount: true },
    });

    // issues are stored as negative quantity and negative amount
    const outQty = D(issues._sum.quantity ?? 0).neg();
    const provisionalOut = D(issues._sum.amount ?? 0).neg();
    const finalOut = floorTo(outQty.times(averageCost), 0);
    // the ledger currently carries the provisional cost, so the adjustment moves it to final.
    // a positive adjustment means the issues cost MORE than provisionally booked, which
    // reduces the closing inventory value, so the ledger row carries the negated amount.
    const adjustment = finalOut.minus(provisionalOut);

    const closingQty = pos.openingQty.plus(pos.inQty).minus(outQty);
    const closingAmount = pos.openingAmount.plus(pos.inAmount).minus(finalOut);

    total = total.plus(adjustment);
    lines.push({
      itemId,
      itemName: names.get(itemId) ?? itemId,
      averageCost: unitPrice(averageCost),
      outQty: quantity(outQty),
      provisionalOutAmount: amount(provisionalOut),
      finalOutAmount: amount(finalOut),
      adjustment: amount(adjustment),
      closingQty: quantity(closingQty),
      closingAmount: amount(closingAmount),
    });
  }

  return { period, items: lines.length, totalAdjustment: amount(total), lines };
}

/**
 * Closes the month: fixes the average, records the per-item position, and posts one
 * VALUATION_ADJUST ledger row per item where the adjustment is non-zero. The adjustment
 * rows carry quantity 0 — they move value, never stock.
 */
export async function close(ctx: TransactionContext, period: string): Promise<CloseResult> {
  requirePermission(ctx.actor, 'inventory.valuation');

  /**
   * The exclusive counterpart to the FOR SHARE in `assertPeriodOpen`. A close waits for
   * every movement already dated in this month, then no further movement can enter it.
   * The row is created first because a month with no movements yet has no row to lock.
   */
  await ctx.tx.inventoryValuationPeriod.upsert({
    where: { period },
    create: { period, status: 'OPEN' },
    update: {},
  });
  await ctx.tx.$queryRawUnsafe(
    'SELECT period FROM "InventoryValuationPeriod" WHERE "period" = $1 FOR UPDATE',
    period,
  );

  const config = await policy.resolve<ValuationConfig>(ctx, 'inventory.valuation');
  if (config.config.method !== 'MONTHLY_AVERAGE') {
    throw new AppError(
      'POLICY_MISSING',
      `재고 평가 정책이 월 총평균법이 아닙니다(${config.config.method}). DEC-01 확정 후 마감하세요.`,
    );
  }

  const existing = await ctx.tx.inventoryValuationPeriod.findUnique({ where: { period } });
  if (existing?.status === 'CLOSED') {
    throw new AppError('PERIOD_CLOSED', `${period}은(는) 이미 마감되었습니다.`, { period });
  }

  // a month cannot close while an earlier one is still open, or the opening position is wrong
  const earlierOpen = await earliestOpenBefore(ctx, period);
  if (earlierOpen) {
    throw new AppError(
      'VALIDATION',
      `이전 기간(${earlierOpen})이 아직 마감되지 않았습니다. 순서대로 마감하세요.`,
      { period, earlierOpen },
    );
  }

  const result = await compute(ctx, period);

  const row = await ctx.tx.inventoryValuationPeriod.upsert({
    where: { period },
    create: {
      period,
      status: 'CLOSED',
      policyVersionId: config.id,
      closedAt: ctx.now,
      closedById: ctx.actor.userId,
    },
    update: {
      status: 'CLOSED',
      policyVersionId: config.id,
      closedAt: ctx.now,
      closedById: ctx.actor.userId,
    },
  });

  const { endExclusive } = monthRange(period);
  const lastDay = new Date(toDateOnly(endExclusive).getTime() - 24 * 60 * 60 * 1000);

  for (const line of result.lines) {
    const pos = await positionOf(ctx, line.itemId, period);
    await ctx.tx.inventoryPeriodCost.upsert({
      where: { periodId_itemId: { periodId: row.id, itemId: line.itemId } },
      create: {
        periodId: row.id,
        itemId: line.itemId,
        openingQty: quantity(pos.openingQty),
        openingAmount: amount(pos.openingAmount),
        inQty: quantity(pos.inQty),
        inAmount: amount(pos.inAmount),
        outQty: line.outQty,
        provisionalOutAmount: line.provisionalOutAmount,
        averageCost: line.averageCost,
        finalOutAmount: line.finalOutAmount,
        adjustment: line.adjustment,
        closingQty: line.closingQty,
        closingAmount: line.closingAmount,
      },
      update: {
        averageCost: line.averageCost,
        finalOutAmount: line.finalOutAmount,
        adjustment: line.adjustment,
        closingQty: line.closingQty,
        closingAmount: line.closingAmount,
      },
    });

    if (config.config.closeAdjusts && D(line.adjustment).isZero() === false) {
      // the item sits in whichever warehouse holds it; value adjustments are booked to the
      // warehouse with the largest closing position so the per-warehouse sums stay coherent.
      const warehouseId = await mainWarehouseOf(ctx, line.itemId);
      if (warehouseId) {
        await ledger.post(ctx, [
          {
            sourceType: 'VALUATION_ADJUST',
            sourceId: `${row.id}:${line.itemId}`,
            sourceLineId: null,
            sourceVersion: 1,
            itemId: line.itemId,
            warehouseId,
            quantity: '0',
            unitCost: line.averageCost,
            amount: D(line.adjustment).neg().toString(),
            reason: `${period} 월 총평균 마감조정`,
            occurredAt: lastDay,
          },
        ]);
      }
    }
  }

  await audit.record(ctx, {
    action: 'inventory.valuation',
    entityType: 'InventoryValuationPeriod',
    entityId: row.id,
    after: { period, items: result.items, totalAdjustment: result.totalAdjustment },
  });

  return result;
}

/** Reopening is deliberately noisy: it needs a reason and leaves the adjustment rows in place. */
export async function reopen(ctx: TransactionContext, period: string, reason: string) {
  requirePermission(ctx.actor, 'inventory.valuation');
  if (reason.trim().length < 5) {
    throw new AppError('VALIDATION', '마감 해제 사유를 5자 이상 입력하세요.');
  }
  const row = await ctx.tx.inventoryValuationPeriod.findUniqueOrThrow({ where: { period } });
  if (row.status !== 'CLOSED') throw new AppError('VALIDATION', `${period}은(는) 마감 상태가 아닙니다.`);

  const later = await ctx.tx.inventoryValuationPeriod.findFirst({
    where: { period: { gt: period }, status: 'CLOSED' },
    orderBy: { period: 'asc' },
  });
  if (later) {
    throw new AppError('VALIDATION', `이후 기간(${later.period})이 마감되어 있어 먼저 해제해야 합니다.`, {
      period,
      later: later.period,
    });
  }

  const updated = await ctx.tx.inventoryValuationPeriod.update({
    where: { period },
    data: { status: 'OPEN', reopenedAt: ctx.now, reopenReason: reason },
  });

  await audit.record(ctx, {
    action: 'inventory.reopen',
    entityType: 'InventoryValuationPeriod',
    entityId: row.id,
    before: { status: 'CLOSED' },
    after: { status: 'OPEN', reason },
  });
  return updated;
}

async function earliestOpenBefore(ctx: TransactionContext, period: string): Promise<string | null> {
  const first = await ctx.tx.inventoryLedger.findFirst({ orderBy: { occurredAt: 'asc' } });
  if (!first) return null;

  const closed = new Set(
    (
      await ctx.tx.inventoryValuationPeriod.findMany({
        where: { status: 'CLOSED' },
        select: { period: true },
      })
    ).map((p) => p.period),
  );

  let cursor = periodKey(first.occurredAt);
  while (cursor < period) {
    const movements = await ctx.tx.inventoryLedger.count({
      where: {
        occurredAt: {
          gte: toDateOnly(monthRange(cursor).start),
          lt: toDateOnly(monthRange(cursor).endExclusive),
        },
      },
    });
    if (movements > 0 && !closed.has(cursor)) return cursor;
    cursor = nextPeriod(cursor);
  }
  return null;
}

function nextPeriod(period: string): string {
  const [y, m] = period.split('-').map(Number) as [number, number];
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
}

async function mainWarehouseOf(ctx: TransactionContext, itemId: string): Promise<string | null> {
  const rows = await ctx.tx.inventoryLedger.groupBy({
    by: ['warehouseId'],
    where: { itemId },
    _sum: { quantity: true },
  });
  if (rows.length === 0) return null;
  const best = rows.reduce((a, b) => (D(a._sum.quantity ?? 0).gte(D(b._sum.quantity ?? 0)) ? a : b));
  return best.warehouseId;
}
