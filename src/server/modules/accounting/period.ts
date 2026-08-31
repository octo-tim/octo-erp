import type { TransactionContext } from '@/server/core/context';
import { AppError } from '@/server/core/errors';
import { requirePermission } from '@/server/modules/rbac/service';
import * as audit from '@/server/modules/audit/service';
import { periodKey as periodOf, monthRange, toDateOnly } from '@/lib/dates';

/**
 * DEC-04 / ADR-0006 / ACC-08 — calendar-month accounting periods.
 *
 * A closed period refuses creation, confirmation and cancellation of anything dated
 * inside it. Reopening needs the `period.reopen` permission and a written reason, both
 * of which land in the audit log — a close that can be undone quietly is not a close.
 */

export async function ensure(ctx: TransactionContext, key: string) {
  const existing = await ctx.tx.accountingPeriod.findUnique({ where: { periodKey: key } });
  if (existing) return existing;
  return ctx.tx.accountingPeriod.create({ data: { periodKey: key, status: 'OPEN' } });
}

export async function statusOf(ctx: TransactionContext, key: string): Promise<'OPEN' | 'CLOSED'> {
  const row = await ctx.tx.accountingPeriod.findUnique({ where: { periodKey: key } });
  return row?.status === 'CLOSED' ? 'CLOSED' : 'OPEN';
}

/**
 * The guard every business module calls before it writes anything dated. Callers pass the
 * business date (전표일), not the wall clock — backdating into a closed month is exactly
 * what this prevents.
 *
 * The period row is locked FOR SHARE, not merely read. Reading it without a lock left a
 * race that silently invalidated a financial close: a confirm reads the month as OPEN, a
 * close runs and commits while the confirm is still working, and the confirm then commits a
 * journal entry into a month that has been closed and signed off. The trial balance for
 * that month changes afterwards and nothing says why. FOR SHARE lets any number of confirms
 * run together — they only conflict with `close`, which takes the exclusive lock.
 */
export async function assertOpen(ctx: TransactionContext, businessDate: string): Promise<void> {
  const key = periodOf(businessDate);
  await ctx.tx.$queryRawUnsafe('SELECT id FROM "AccountingPeriod" WHERE "periodKey" = $1 FOR SHARE', key);
  if ((await statusOf(ctx, key)) === 'CLOSED') {
    throw new AppError(
      'PERIOD_CLOSED',
      `${key} 회계기간이 마감되어 해당 일자의 전표를 처리할 수 없습니다. 마감을 해제한 뒤 다시 시도하세요.`,
      { periodKey: key, businessDate },
    );
  }
}

/**
 * ADR-0006: where a reversal is dated. If the original month is still open the reversal
 * belongs there, so the two entries net to zero within the same period. If it is closed
 * the reversal moves to the first day of the earliest open period, because rewriting a
 * closed month is not an option.
 */
export async function reversalDate(ctx: TransactionContext, originalDate: Date): Promise<Date> {
  const originalKey = periodOf(originalDate);
  if ((await statusOf(ctx, originalKey)) === 'OPEN') return originalDate;

  const closed = new Set(
    (
      await ctx.tx.accountingPeriod.findMany({ where: { status: 'CLOSED' }, select: { periodKey: true } })
    ).map((p) => p.periodKey),
  );

  let cursor = originalKey;
  // walk forward to the first month that is not closed; 120 months is a hard stop, not a limit
  for (let i = 0; i < 120; i++) {
    if (!closed.has(cursor)) return toDateOnly(monthRange(cursor).start);
    cursor = nextPeriod(cursor);
  }
  throw new AppError('PERIOD_CLOSED', '열려 있는 회계기간을 찾을 수 없습니다. 마감 상태를 확인하세요.');
}

export function nextPeriod(key: string): string {
  const [y, m] = key.split('-').map(Number) as [number, number];
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
}

export function previousPeriod(key: string): string {
  const [y, m] = key.split('-').map(Number) as [number, number];
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
}

export async function list(ctx: TransactionContext, take = 36) {
  requirePermission(ctx.actor, 'accounting.read');
  return ctx.tx.accountingPeriod.findMany({
    orderBy: { periodKey: 'desc' },
    take,
    include: { _count: { select: { entries: true } } },
  });
}

export async function close(ctx: TransactionContext, key: string) {
  /**
   * The exclusive counterpart to the FOR SHARE in `assertOpen`: a close waits for every
   * confirm already dated in this month to finish, and every confirm that starts afterwards
   * sees CLOSED. Without it a close and a confirm could each believe they went first.
   */
  await ctx.tx.$queryRawUnsafe('SELECT id FROM "AccountingPeriod" WHERE "periodKey" = $1 FOR UPDATE', key);
  requirePermission(ctx.actor, 'accounting.close');

  const period = await ensure(ctx, key);
  if (period.status === 'CLOSED') {
    throw new AppError('PERIOD_CLOSED', `${key}은(는) 이미 마감되었습니다.`, { periodKey: key });
  }

  // a month cannot close while an earlier one with entries is still open
  const earlier = await ctx.tx.accountingPeriod.findFirst({
    where: { periodKey: { lt: key }, status: 'OPEN', entries: { some: {} } },
    orderBy: { periodKey: 'asc' },
  });
  if (earlier) {
    throw new AppError(
      'VALIDATION',
      `이전 기간(${earlier.periodKey})이 아직 마감되지 않았습니다. 순서대로 마감하세요.`,
      { periodKey: key, earlier: earlier.periodKey },
    );
  }

  // a draft left in the month would be silently unpostable after the close
  const drafts = await ctx.tx.journalEntry.count({
    where: { periodId: period.id, status: { in: ['DRAFT', 'PENDING_APPROVAL'] } },
  });
  if (drafts > 0) {
    throw new AppError(
      'VALIDATION',
      `확정되지 않은 전표가 ${drafts}건 있습니다. 확정하거나 취소한 뒤 마감하세요.`,
      { periodKey: key, drafts },
    );
  }

  const updated = await ctx.tx.accountingPeriod.update({
    where: { periodKey: key },
    data: { status: 'CLOSED', closedAt: ctx.now, closedById: ctx.actor.userId },
  });

  await audit.record(ctx, {
    action: 'accountingPeriod.close',
    entityType: 'AccountingPeriod',
    entityId: period.id,
    before: { status: 'OPEN' },
    after: { status: 'CLOSED', periodKey: key },
  });
  return updated;
}

export async function reopen(ctx: TransactionContext, key: string, reason: string) {
  requirePermission(ctx.actor, 'period.reopen');
  if (reason.trim().length < 5) {
    throw new AppError('VALIDATION', '마감 해제 사유를 5자 이상 입력하세요.');
  }

  const period = await ctx.tx.accountingPeriod.findUniqueOrThrow({ where: { periodKey: key } });
  if (period.status !== 'CLOSED') {
    throw new AppError('VALIDATION', `${key}은(는) 마감 상태가 아닙니다.`, { periodKey: key });
  }

  const later = await ctx.tx.accountingPeriod.findFirst({
    where: { periodKey: { gt: key }, status: 'CLOSED' },
    orderBy: { periodKey: 'asc' },
  });
  if (later) {
    throw new AppError('VALIDATION', `이후 기간(${later.periodKey})이 마감되어 있어 먼저 해제해야 합니다.`, {
      periodKey: key,
      later: later.periodKey,
    });
  }

  const updated = await ctx.tx.accountingPeriod.update({
    where: { periodKey: key },
    data: {
      status: 'OPEN',
      reopenedAt: ctx.now,
      reopenedById: ctx.actor.userId,
      reopenReason: reason,
    },
  });

  // B-01: the reason is the point of the record, so it goes in the audit log verbatim
  await audit.record(ctx, {
    action: 'accountingPeriod.reopen',
    entityType: 'AccountingPeriod',
    entityId: period.id,
    before: { status: 'CLOSED' },
    after: { status: 'OPEN', reason },
  });
  return updated;
}
