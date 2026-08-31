import type { TransactionContext } from '@/server/core/context';
import { AppError } from '@/server/core/errors';
import { requirePermission } from '@/server/modules/rbac/service';
import * as audit from '@/server/modules/audit/service';
import { nextDocNo, DOC_TYPES } from '@/server/modules/numbering/service';
import { assertVersion } from '@/server/core/state-machine';
import { idempotent } from '@/server/core/idempotency';
import * as valuation from './valuation';
import * as stockDocument from './stock-document';
import { D, quantity } from '@/lib/money';
import { businessDate, toDateOnly } from '@/lib/dates';
import { buildCsvExport, type CsvExport } from '@/server/core/list-export';

/**
 * INV-08 — physical count, differences, approval, adjustment.
 *
 * The system quantity is frozen when counting starts, so movements made while people are
 * walking the warehouse do not silently change what a difference means. The adjustment is
 * an ordinary ADJUST stock document, which means it goes through the same ledger, approval
 * and cancellation rules as everything else rather than a private back door.
 */

export type CountStatus = 'DRAFT' | 'COUNTING' | 'PENDING_APPROVAL' | 'APPROVED' | 'CANCELED';

export async function create(
  ctx: TransactionContext,
  input: { warehouseId: string; countDate?: string; itemIds?: string[]; categoryId?: string; note?: string },
) {
  requirePermission(ctx.actor, 'inventory.count');
  if (!ctx.actor.isAdmin && !ctx.actor.warehouseIds.includes(input.warehouseId)) {
    throw new AppError('FORBIDDEN', '권한 범위 밖의 창고입니다.');
  }

  const countDate = input.countDate ?? businessDate(ctx.now);
  await valuation.assertPeriodOpen(ctx, countDate);

  const countNo = await nextDocNo(ctx, DOC_TYPES.STOCK_COUNT, countDate);
  const count = await ctx.tx.stockCount.create({
    data: {
      countNo,
      warehouseId: input.warehouseId,
      countDate: toDateOnly(countDate),
      status: 'DRAFT',
      note: input.note ?? null,
      createdById: ctx.actor.userId,
    },
  });

  await audit.record(ctx, {
    action: 'stockCount.create',
    entityType: 'StockCount',
    entityId: count.id,
    after: { countNo, warehouseId: input.warehouseId, countDate },
  });
  return count;
}

/**
 * Freezes the ledger position into the count lines. Every item that either has stock in
 * the warehouse or was explicitly asked for gets a line, so a count can also record that
 * something unexpected was found on the shelf.
 */
export async function start(
  ctx: TransactionContext,
  id: string,
  input: { itemIds?: string[]; categoryId?: string },
  version: number,
) {
  requirePermission(ctx.actor, 'inventory.count');
  const count = await ctx.tx.stockCount.findUniqueOrThrow({ where: { id } });
  assertVersion('재고실사', count.version, version);
  if (count.status !== 'DRAFT') {
    throw new AppError('INVALID_TRANSITION', '작성 중인 실사만 시작할 수 있습니다.', {
      status: count.status,
    });
  }

  const held = await ctx.tx.inventoryLedger.groupBy({
    by: ['itemId'],
    where: { warehouseId: count.warehouseId },
    _sum: { quantity: true },
  });

  const explicit = input.itemIds ?? [];
  const byCategory = input.categoryId
    ? (
        await ctx.tx.item.findMany({
          where: { categoryId: input.categoryId, isActive: true },
          select: { id: true },
        })
      ).map((i) => i.id)
    : [];

  const systemQty = new Map(held.map((h) => [h.itemId, D(h._sum.quantity ?? 0)]));
  const itemIds = [...new Set([...systemQty.keys(), ...explicit, ...byCategory])];
  if (itemIds.length === 0) {
    throw new AppError('VALIDATION', '실사할 품목이 없습니다. 품목이나 분류를 지정하세요.');
  }

  await ctx.tx.stockCountLine.deleteMany({ where: { countId: id } });
  await ctx.tx.stockCountLine.createMany({
    data: itemIds.map((itemId) => ({
      countId: id,
      itemId,
      systemQty: quantity(systemQty.get(itemId) ?? D(0)),
    })),
  });

  const updated = await ctx.tx.stockCount.update({
    where: { id },
    data: { status: 'COUNTING', frozenAt: ctx.now, version: { increment: 1 } },
  });

  await audit.record(ctx, {
    action: 'stockCount.start',
    entityType: 'StockCount',
    entityId: id,
    after: { status: 'COUNTING', lines: itemIds.length, frozenAt: ctx.now.toISOString() },
  });
  return updated;
}

export async function record(
  ctx: TransactionContext,
  id: string,
  lines: { itemId: string; countedQty: string; reason?: string }[],
) {
  requirePermission(ctx.actor, 'inventory.count');
  const count = await ctx.tx.stockCount.findUniqueOrThrow({ where: { id } });
  if (count.status !== 'COUNTING') {
    throw new AppError('INVALID_TRANSITION', '실사 진행 중일 때만 수량을 입력할 수 있습니다.', {
      status: count.status,
    });
  }

  for (const l of lines) {
    if (D(l.countedQty).isNegative()) throw new AppError('VALIDATION', '실사 수량은 0 이상이어야 합니다.');
    await ctx.tx.stockCountLine.upsert({
      where: { countId_itemId: { countId: id, itemId: l.itemId } },
      create: {
        countId: id,
        itemId: l.itemId,
        systemQty: '0',
        countedQty: quantity(l.countedQty),
        reason: l.reason ?? null,
      },
      update: { countedQty: quantity(l.countedQty), reason: l.reason ?? null },
    });
  }
  return { recorded: lines.length };
}

export interface Difference {
  itemId: string;
  code: string;
  name: string;
  unitCode: string;
  systemQty: string;
  countedQty: string | null;
  difference: string;
  reason: string | null;
}

export async function differences(ctx: TransactionContext, id: string): Promise<Difference[]> {
  requirePermission(ctx.actor, 'inventory.read');
  const lines = await ctx.tx.stockCountLine.findMany({
    where: { countId: id },
    include: { item: { select: { code: true, name: true, unitCode: true } } },
    orderBy: { item: { code: 'asc' } },
  });

  return lines.map((l) => {
    const diff = l.countedQty === null ? null : D(l.countedQty).minus(D(l.systemQty));
    return {
      itemId: l.itemId,
      code: l.item.code,
      name: l.item.name,
      unitCode: l.item.unitCode,
      systemQty: quantity(l.systemQty),
      countedQty: l.countedQty === null ? null : quantity(l.countedQty),
      difference: diff === null ? '0.000' : quantity(diff),
      reason: l.reason,
    };
  });
}

/**
 * Turns the differences into an ADJUST stock document. Lines with no difference are left
 * out; uncounted lines block the close, because "not counted" is not the same as "matches".
 */
export async function approve(ctx: TransactionContext, id: string, version: number) {
  requirePermission(ctx.actor, 'inventory.count');

  return idempotent(ctx, `stockCount.approve:${id}`, async () => {
    const count = await ctx.tx.stockCount.findUniqueOrThrow({
      where: { id },
      include: { lines: true },
    });
    assertVersion('재고실사', count.version, version);
    if (count.status !== 'COUNTING') {
      throw new AppError('INVALID_TRANSITION', '실사 진행 중일 때만 승인할 수 있습니다.', {
        status: count.status,
      });
    }

    const uncounted = count.lines.filter((l) => l.countedQty === null);
    if (uncounted.length > 0) {
      throw new AppError(
        'VALIDATION',
        `실사 수량이 입력되지 않은 품목이 ${uncounted.length}건 있습니다. 차이가 없더라도 수량을 입력하세요.`,
        { uncounted: uncounted.length },
      );
    }

    const adjustments = count.lines
      .map((l) => ({ itemId: l.itemId, diff: D(l.countedQty!).minus(D(l.systemQty)), reason: l.reason }))
      .filter((l) => !l.diff.isZero());

    let adjustmentId: string | null = null;
    if (adjustments.length > 0) {
      const doc = await stockDocument.create(ctx, {
        docType: 'ADJUST',
        docDate: count.countDate.toISOString().slice(0, 10),
        toWarehouseId: count.warehouseId,
        reasonCode: 'COUNT_ADJUST',
        note: `재고실사 ${count.countNo} 차이 조정`,
        lines: adjustments.map((a) => ({
          itemId: a.itemId,
          quantity: a.diff.toString(),
          note: a.reason ?? undefined,
        })),
      });
      adjustmentId = doc.id;

      await ctx.tx.stockDocument.update({ where: { id: doc.id }, data: { stockCountId: id } });

      // the adjustment is confirmed here so the count and the ledger move together;
      // if DEC-03 requires approval for the amount, confirm() refuses and the whole
      // count approval rolls back rather than leaving a dangling draft.
      await stockDocument.confirm(ctx, doc.id, doc.version);
    }

    const updated = await ctx.tx.stockCount.update({
      where: { id },
      data: { status: 'APPROVED', approvedAt: ctx.now, version: { increment: 1 } },
    });

    await audit.record(ctx, {
      action: 'stockCount.approve',
      entityType: 'StockCount',
      entityId: id,
      before: { status: 'COUNTING' },
      after: { status: 'APPROVED', adjustments: adjustments.length, adjustmentId },
    });

    return { id: updated.id, countNo: updated.countNo, adjustmentId, adjustedLines: adjustments.length };
  });
}

export async function cancel(ctx: TransactionContext, id: string, reason: string, version: number) {
  requirePermission(ctx.actor, 'inventory.count');
  const count = await ctx.tx.stockCount.findUniqueOrThrow({ where: { id } });
  assertVersion('재고실사', count.version, version);
  if (count.status === 'APPROVED') {
    throw new AppError(
      'INVALID_TRANSITION',
      '승인된 실사는 취소할 수 없습니다. 생성된 조정전표를 취소하세요.',
    );
  }
  const updated = await ctx.tx.stockCount.update({
    where: { id },
    data: { status: 'CANCELED', version: { increment: 1 } },
  });
  await audit.record(ctx, {
    action: 'stockCount.cancel',
    entityType: 'StockCount',
    entityId: id,
    before: { status: count.status },
    after: { status: 'CANCELED', reason },
  });
  return updated;
}

export async function list(
  ctx: TransactionContext,
  input: { warehouseId?: string; status?: string; skip: number; take: number },
) {
  requirePermission(ctx.actor, 'inventory.read');
  const scope = ctx.actor.isAdmin ? undefined : ctx.actor.warehouseIds;
  const where = {
    ...(input.warehouseId ? { warehouseId: input.warehouseId } : scope ? { warehouseId: { in: scope } } : {}),
    ...(input.status ? { status: input.status } : {}),
  };
  const [rows, total] = await Promise.all([
    ctx.tx.stockCount.findMany({
      where,
      include: { warehouse: { select: { name: true } }, _count: { select: { lines: true } } },
      orderBy: [{ countDate: 'desc' }, { countNo: 'desc' }],
      skip: input.skip,
      take: input.take,
    }),
    ctx.tx.stockCount.count({ where }),
  ]);
  return { rows, total };
}

const STOCK_COUNT_CSV_HEADERS = ['실사번호', '실사일', '창고', '품목수', '상태'];

/** UIX-03: server-side export for the 재고실사 grid — same permission and rows as `list`. */
export async function listCsv(
  ctx: TransactionContext,
  input: { warehouseId?: string; status?: string },
): Promise<CsvExport> {
  return buildCsvExport(
    (paging) => list(ctx, { ...input, ...paging }),
    STOCK_COUNT_CSV_HEADERS,
    (r) => [r.countNo, r.countDate.toISOString().slice(0, 10), r.warehouse.name, r._count.lines, r.status],
  );
}

export async function detail(ctx: TransactionContext, id: string) {
  requirePermission(ctx.actor, 'inventory.read');
  const count = await ctx.tx.stockCount.findUnique({
    where: { id },
    include: {
      warehouse: { select: { id: true, name: true } },
      adjustment: { select: { id: true, docNo: true, status: true } },
    },
  });
  if (!count) throw new AppError('NOT_FOUND', '재고실사를 찾을 수 없습니다.');
  return { ...count, lines: await differences(ctx, id) };
}
