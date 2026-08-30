import type { TransactionContext } from '@/server/core/context';
import { AppError } from '@/server/core/errors';
import { businessDate } from '@/lib/dates';

/**
 * BAS-01 / APV-13 / INT-11: concurrency-safe document numbering.
 * The counter row is locked FOR UPDATE, so parallel callers serialize on it and
 * the (docType, docNo) unique index on each document table is the second guard.
 */
export async function nextDocNo(ctx: TransactionContext, docType: string, onDate?: string): Promise<string> {
  const rule = await ctx.tx.numberingRule.findUnique({ where: { docType } });
  if (!rule)
    throw new AppError('VALIDATION', `채번규칙이 없습니다: ${docType}. 시스템 > 채번규칙에서 등록하세요.`);

  const date = onDate ?? businessDate(ctx.now);
  const periodKey =
    rule.periodKind === 'NONE'
      ? 'ALL'
      : rule.periodKind === 'YEAR'
        ? date.slice(0, 4)
        : date.slice(0, 7).replace('-', '');

  // upsert then lock: ON CONFLICT DO NOTHING keeps concurrent first-use safe
  await ctx.tx.$executeRaw`
    INSERT INTO "NumberingCounter" ("ruleId", "periodKey", "lastSeq")
    VALUES (${rule.id}, ${periodKey}, 0)
    ON CONFLICT ("ruleId", "periodKey") DO NOTHING`;

  const rows = await ctx.tx.$queryRaw<{ lastSeq: number }[]>`
    SELECT "lastSeq" FROM "NumberingCounter"
    WHERE "ruleId" = ${rule.id} AND "periodKey" = ${periodKey}
    FOR UPDATE`;
  const current = rows[0]?.lastSeq ?? 0;
  const next = current + 1;

  await ctx.tx.$executeRaw`
    UPDATE "NumberingCounter" SET "lastSeq" = ${next}
    WHERE "ruleId" = ${rule.id} AND "periodKey" = ${periodKey}`;

  const seq = String(next).padStart(rule.seqLength, '0');
  return rule.periodKind === 'NONE' ? `${rule.prefix}-${seq}` : `${rule.prefix}-${periodKey}-${seq}`;
}

export const DOC_TYPES = {
  QUOTATION: 'QUOTATION',
  SALES_ORDER: 'SALES_ORDER',
  SALES: 'SALES',
  PURCHASE: 'PURCHASE',
  PURCHASE_REQUEST: 'PURCHASE_REQUEST',
  PURCHASE_ORDER: 'PURCHASE_ORDER',
  RETURN_SALES: 'RETURN_SALES',
  RETURN_PURCHASE: 'RETURN_PURCHASE',
  RECEIPT: 'RECEIPT',
  PAYMENT: 'PAYMENT',
  STOCK_IN: 'STOCK_IN',
  STOCK_OUT: 'STOCK_OUT',
  STOCK_MOVE: 'STOCK_MOVE',
  STOCK_COUNT: 'STOCK_COUNT',
  STOCK_ADJUST: 'STOCK_ADJUST',
  JOURNAL: 'JOURNAL',
  APPROVAL: 'APPROVAL',
  LEAVE_REQUEST: 'LEAVE_REQUEST',
  ATTENDANCE_CORRECTION: 'ATTENDANCE_CORRECTION',
  CERTIFICATE: 'CERTIFICATE',
  ITEM: 'ITEM',
  PARTNER: 'PARTNER',
} as const;
