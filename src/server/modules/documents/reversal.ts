import type { TransactionContext } from '@/server/core/context';
import { AppError } from '@/server/core/errors';
import * as accountingPeriod from '@/server/modules/accounting/period';
import * as valuation from '@/server/modules/inventory/valuation';
import { toDateOnly } from '@/lib/dates';

/**
 * When a reversal is dated (DEC-04 / INT-07).
 *
 * A cancellation writes opposite rows rather than deleting the originals, so those rows
 * need a date, and that date has to be in a month that will accept them. There were two
 * different answers to this in the codebase and neither was complete: the sales and
 * purchase paths asked the accounting calendar only, and the stock path asked the
 * inventory valuation calendar only and then used today's date rather than the month it
 * had just decided on. Cancelling a confirmed sale touches BOTH ledgers, so either rule on
 * its own can put rows into a month that is closed for the other one — silently changing a
 * month that has already been reported.
 *
 * One rule, then: the reversal keeps the original date when every calendar it will touch is
 * open there; otherwise it moves to the first day of the earliest month that is open in all
 * of them. Reversals stay next to their originals whenever that is possible, and never land
 * in a closed book.
 */

export type Ledger = 'ACCOUNTING' | 'INVENTORY';

const periodOf = (d: Date): string => d.toISOString().slice(0, 7);

function nextMonth(key: string): string {
  const [y, m] = key.split('-').map(Number) as [number, number];
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
}

async function isOpen(ctx: TransactionContext, period: string, ledgers: Ledger[]): Promise<boolean> {
  for (const ledger of ledgers) {
    const status =
      ledger === 'ACCOUNTING'
        ? await accountingPeriod.statusOf(ctx, period)
        : await valuation.periodStatus(ctx, period);
    if (status === 'CLOSED') return false;
  }
  return true;
}

export async function reversalDate(
  ctx: TransactionContext,
  originalDate: Date,
  ledgers: Ledger[],
): Promise<Date> {
  if (ledgers.length === 0) return originalDate;

  let cursor = periodOf(originalDate);
  if (await isOpen(ctx, cursor, ledgers)) return originalDate;

  // walk forward to the first month every ledger will accept; 120 is a hard stop, not a limit
  for (let i = 0; i < 120; i++) {
    cursor = nextMonth(cursor);
    if (await isOpen(ctx, cursor, ledgers)) return toDateOnly(`${cursor}-01`);
  }
  throw new AppError(
    'PERIOD_CLOSED',
    '역분개를 기록할 수 있는 열린 기간을 찾을 수 없습니다. 회계 또는 재고 마감 상태를 확인하세요.',
  );
}
