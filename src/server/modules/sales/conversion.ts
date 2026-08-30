import type { TransactionContext } from '@/server/core/context';
import { AppError } from '@/server/core/errors';
import { D, quantity, ZERO } from '@/lib/money';
import type Decimal from 'decimal.js';

/**
 * SLS-02 / SLS-04 / SLS-13 — partial conversion between documents.
 *
 * The remaining quantity of a source line is never stored on the line. It is derived from
 * the DocumentConversion rows against it, so there is exactly one place it can be wrong.
 * `reserve` locks the source line first, then re-derives the remainder inside the lock, so
 * two people converting the same quotation at once cannot both take the last unit.
 */

export interface ConversionRequest {
  sourceType: string;
  sourceId: string;
  sourceLineId: string;
  targetType: string;
  targetId: string;
  targetLineId: string;
  quantity: string;
  /** for the error message when the request exceeds what is left */
  label: string;
}

/** The table holding the source line, used for the row lock. */
const SOURCE_LINE_TABLE: Record<string, string> = {
  QUOTATION: 'QuotationLine',
  SALES_ORDER: 'SalesOrderLine',
  PURCHASE_REQUEST: 'PurchaseRequestLine',
  PURCHASE_ORDER: 'PurchaseOrderLine',
};

export async function convertedQuantity(ctx: TransactionContext, sourceLineId: string): Promise<Decimal> {
  const rows = await ctx.tx.documentConversion.aggregate({
    where: { sourceLineId, canceledAt: null },
    _sum: { quantity: true },
  });
  return D(rows._sum.quantity ?? 0);
}

export async function remainingOf(
  ctx: TransactionContext,
  sourceType: string,
  sourceLineId: string,
  originalQuantity: string,
): Promise<Decimal> {
  void sourceType;
  return D(originalQuantity).minus(await convertedQuantity(ctx, sourceLineId));
}

/**
 * Locks the source line, checks the remainder, and records the conversion — in that order,
 * inside the caller's transaction. Returns what is left after this conversion.
 */
export async function reserve(
  ctx: TransactionContext,
  request: ConversionRequest,
  originalQuantity: string,
): Promise<{ remaining: Decimal }> {
  const table = SOURCE_LINE_TABLE[request.sourceType];
  if (!table) {
    throw new AppError('VALIDATION', `전환 원천 유형이 올바르지 않습니다: ${request.sourceType}`);
  }

  // INT-08: the row lock is what makes two concurrent conversions serialise
  await ctx.tx.$queryRawUnsafe(`SELECT id FROM "${table}" WHERE id = $1 FOR UPDATE`, request.sourceLineId);

  const already = await convertedQuantity(ctx, request.sourceLineId);
  const remaining = D(originalQuantity).minus(already);
  const want = D(request.quantity);

  if (want.lte(0)) {
    throw new AppError('VALIDATION', `${request.label}: 전환 수량은 0보다 커야 합니다.`);
  }
  if (want.gt(remaining)) {
    throw new AppError(
      'OVER_ALLOCATION',
      `${request.label}: 잔여수량 ${quantity(remaining)}을(를) 초과했습니다. 요청 ${quantity(want)}.`,
      { requested: quantity(want), remaining: quantity(remaining) },
    );
  }

  await ctx.tx.documentConversion.create({
    data: {
      sourceType: request.sourceType,
      sourceId: request.sourceId,
      sourceLineId: request.sourceLineId,
      targetType: request.targetType,
      targetId: request.targetId,
      targetLineId: request.targetLineId,
      quantity: quantity(want),
    },
  });

  return { remaining: remaining.minus(want) };
}

/**
 * Cancelling the target document releases its conversions. The rows are marked rather
 * than deleted, so the history of what was converted and then undone stays visible.
 */
export async function release(
  ctx: TransactionContext,
  targetType: string,
  targetId: string,
): Promise<number> {
  const result = await ctx.tx.documentConversion.updateMany({
    where: { targetType, targetId, canceledAt: null },
    data: { canceledAt: ctx.now },
  });
  return result.count;
}

export interface LineProgress {
  sourceLineId: string;
  originalQuantity: string;
  convertedQuantity: string;
  remainingQuantity: string;
  fullyConverted: boolean;
}

/** Progress for every line of a source document, for the screen and the status rule. */
export async function progressOf(
  ctx: TransactionContext,
  lines: { id: string; quantity: unknown }[],
): Promise<LineProgress[]> {
  if (lines.length === 0) return [];

  const sums = await ctx.tx.documentConversion.groupBy({
    by: ['sourceLineId'],
    where: { sourceLineId: { in: lines.map((l) => l.id) }, canceledAt: null },
    _sum: { quantity: true },
  });
  const by = new Map(sums.map((s) => [s.sourceLineId, D(s._sum.quantity ?? 0)]));

  return lines.map((l) => {
    const original = D(l.quantity as never);
    const converted = by.get(l.id) ?? ZERO;
    const remaining = original.minus(converted);
    return {
      sourceLineId: l.id,
      originalQuantity: quantity(original),
      convertedQuantity: quantity(converted),
      remainingQuantity: quantity(remaining),
      fullyConverted: remaining.lte(0),
    };
  });
}

/**
 * A source document is COMPLETED when every line is fully converted, IN_PROGRESS when some
 * quantity has moved, and unchanged otherwise. Returning the three states rather than
 * writing them keeps this module free of any one document type's status vocabulary.
 */
export function progressStatus(progress: LineProgress[]): 'NONE' | 'PARTIAL' | 'COMPLETE' {
  if (progress.length === 0) return 'NONE';
  const anyConverted = progress.some((p) => D(p.convertedQuantity).gt(0));
  if (!anyConverted) return 'NONE';
  return progress.every((p) => p.fullyConverted) ? 'COMPLETE' : 'PARTIAL';
}
