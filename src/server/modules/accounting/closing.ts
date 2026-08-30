import type { TransactionContext } from '@/server/core/context';
import { AppError } from '@/server/core/errors';
import { requirePermission } from '@/server/modules/rbac/service';
import * as audit from '@/server/modules/audit/service';
import * as account from './account';
import * as period from './period';
import * as journal from './journal';
import { nextDocNo, DOC_TYPES } from '@/server/modules/numbering/service';
import { amount, D, ZERO } from '@/lib/money';
import { monthRange, toDateOnly } from '@/lib/dates';

/**
 * ACC-08 — closing.
 *
 * ADR-0006 separates two things that are often conflated. A *month* close simply locks the
 * period so nothing dated inside it can move. A *year* close additionally writes a closing
 * entry that transfers the year's revenue and expense balances into retained earnings, and
 * carries the remaining balance-sheet accounts forward as the next year's opening balances.
 *
 * Profit-and-loss accounts close; balance-sheet accounts carry. Mixing the two is how a
 * balance sheet quietly stops balancing.
 */

export async function closeMonth(ctx: TransactionContext, periodKey: string) {
  requirePermission(ctx.actor, 'accounting.close');

  const closed = await period.close(ctx, periodKey);
  const p = await ctx.tx.accountingPeriod.findUniqueOrThrow({ where: { periodKey } });

  const locked = await ctx.tx.journalEntry.count({
    where: { periodId: p.id, status: 'CONFIRMED' },
  });

  const run = await ctx.tx.closingRun.create({
    data: { periodId: p.id, kind: 'MONTH', entriesLocked: locked, runById: ctx.actor.userId },
  });

  return { period: closed, run, entriesLocked: locked };
}

export interface YearClosePreview {
  year: string;
  periodKey: string;
  revenue: string;
  expense: string;
  netIncome: string;
  retainedEarningsAccount: string | null;
  carriedAccounts: number;
  lines: { accountId: string; code: string; name: string; accountType: string; balance: string }[];
}

/**
 * What the year close would post. Kept separate from `closeYear` so nobody transfers a
 * year's profit without first seeing the number.
 */
export async function previewYear(ctx: TransactionContext, year: string): Promise<YearClosePreview> {
  requirePermission(ctx.actor, 'accounting.read');
  const from = `${year}-01-01`;
  const to = `${year}-12-31`;

  const accounts = await ctx.tx.account.findMany({
    where: { isPostable: true },
    select: { id: true, code: true, name: true, accountType: true, normalSide: true },
    orderBy: { code: 'asc' },
  });

  const sums = await ctx.tx.journalLine.groupBy({
    by: ['accountId'],
    where: {
      entry: {
        // see report.ts POSTED: a cancelled-after-confirmation entry stays in the books
        // alongside its reversal, so the pair nets out rather than the reversal standing alone
        confirmedAt: { not: null },
        isClosingEntry: false,
        entryDate: { gte: toDateOnly(from), lte: toDateOnly(to) },
      },
    },
    _sum: { debit: true, credit: true },
  });
  const by = new Map(sums.map((s) => [s.accountId, s]));

  let revenue = ZERO;
  let expense = ZERO;
  const lines: YearClosePreview['lines'] = [];

  for (const a of accounts) {
    if (!account.isProfitAndLoss(a.accountType)) continue;
    const s = by.get(a.id);
    const sign = a.normalSide === 'DEBIT' ? 1 : -1;
    const balance = D(s?._sum.debit ?? 0)
      .minus(D(s?._sum.credit ?? 0))
      .times(sign);
    if (balance.isZero()) continue;

    if (a.accountType === 'REVENUE') revenue = revenue.plus(balance);
    else expense = expense.plus(balance);

    lines.push({
      accountId: a.id,
      code: a.code,
      name: a.name,
      accountType: a.accountType,
      balance: amount(balance),
    });
  }

  const mapping = await ctx.tx.accountMapping.findUnique({
    where: { slot: 'RETAINED_EARNINGS' },
    include: { account: { select: { code: true, name: true } } },
  });

  // balance-sheet accounts with a non-zero balance carry forward
  const carried = accounts.filter((a) => {
    if (account.isProfitAndLoss(a.accountType)) return false;
    const s = by.get(a.id);
    return s !== undefined;
  }).length;

  return {
    year,
    periodKey: `${year}-12`,
    revenue: amount(revenue),
    expense: amount(expense),
    netIncome: amount(revenue.minus(expense)),
    retainedEarningsAccount: mapping ? `${mapping.account.code} ${mapping.account.name}` : null,
    carriedAccounts: carried,
    lines,
  };
}

/**
 * Writes the closing entry and the next year's opening balances. December must be the
 * period being closed, and it must still be open when this runs — the entry has to land
 * inside it.
 */
export async function closeYear(ctx: TransactionContext, year: string) {
  requirePermission(ctx.actor, 'accounting.close');

  const periodKey = `${year}-12`;
  if ((await period.statusOf(ctx, periodKey)) === 'CLOSED') {
    throw new AppError(
      'PERIOD_CLOSED',
      `${periodKey}이 이미 마감되어 손익 마감분개를 만들 수 없습니다. 마감을 해제한 뒤 진행하세요.`,
    );
  }

  const existing = await ctx.tx.journalEntry.findFirst({
    where: {
      isClosingEntry: true,
      status: 'CONFIRMED',
      entryDate: { gte: toDateOnly(`${year}-01-01`), lte: toDateOnly(`${year}-12-31`) },
    },
  });
  if (existing) {
    throw new AppError('DUPLICATE_EFFECT', `${year}년 손익 마감분개가 이미 있습니다: ${existing.entryNo}`);
  }

  const preview = await previewYear(ctx, year);
  if (preview.lines.length === 0) {
    throw new AppError('VALIDATION', `${year}년에 마감할 손익 잔액이 없습니다.`);
  }

  const retainedId = await account.resolveSlot(ctx, 'RETAINED_EARNINGS');
  const entryDate = `${year}-12-31`;
  const p = await period.ensure(ctx, periodKey);
  const entryNo = await nextDocNo(ctx, DOC_TYPES.JOURNAL, entryDate);

  // each P&L account is zeroed by an entry on the side opposite its balance; the net
  // difference goes to retained earnings, which is what makes the entry balance.
  const lines: journal.LineInput[] = [];
  for (const l of preview.lines) {
    const balance = D(l.balance);
    if (l.accountType === 'REVENUE') {
      lines.push({ accountId: l.accountId, debit: amount(balance), description: `${year} 손익대체` });
    } else {
      lines.push({ accountId: l.accountId, credit: amount(balance), description: `${year} 손익대체` });
    }
  }

  const net = D(preview.netIncome);
  lines.push(
    net.isNegative()
      ? { accountId: retainedId, debit: amount(net.neg()), description: `${year} 당기순손실 대체` }
      : { accountId: retainedId, credit: amount(net), description: `${year} 당기순이익 대체` },
  );

  const totals = journal.validateLines(lines);
  const entry = await ctx.tx.journalEntry.create({
    data: {
      entryNo,
      entryType: 'TRANSFER',
      entryDate: toDateOnly(entryDate),
      periodId: p.id,
      status: 'CONFIRMED',
      description: `${year}년 손익 마감분개`,
      isClosingEntry: true,
      totalDebit: totals.debit,
      totalCredit: totals.credit,
      confirmedAt: ctx.now,
      confirmedById: ctx.actor.userId,
      createdById: ctx.actor.userId,
      lines: {
        create: lines.map((l, i) => ({
          lineNo: i + 1,
          accountId: l.accountId,
          debit: amount(l.debit ?? 0),
          credit: amount(l.credit ?? 0),
          description: l.description ?? null,
        })),
      },
    },
  });

  const carried = await carryForward(ctx, year);

  const run = await ctx.tx.closingRun.create({
    data: {
      periodId: p.id,
      kind: 'YEAR',
      closingEntryId: entry.id,
      carriedAccounts: carried,
      runById: ctx.actor.userId,
    },
  });

  await audit.record(ctx, {
    action: 'accounting.closeYear',
    entityType: 'ClosingRun',
    entityId: run.id,
    after: {
      year,
      entryNo,
      netIncome: preview.netIncome,
      closedAccounts: preview.lines.length,
      carriedAccounts: carried,
    },
  });

  return { entry, run, netIncome: preview.netIncome, carriedAccounts: carried };
}

/**
 * Balance-sheet accounts open the next year with the balance they closed on. P&L accounts
 * do not carry: they were just transferred to retained earnings and start at zero.
 */
async function carryForward(ctx: TransactionContext, year: string): Promise<number> {
  const nextKey = `${Number(year) + 1}-01`;
  const asOf = `${year}-12-31`;

  const accounts = await ctx.tx.account.findMany({
    where: { isPostable: true, accountType: { in: ['ASSET', 'LIABILITY', 'EQUITY'] } },
    select: { id: true, normalSide: true },
  });

  const sums = await ctx.tx.journalLine.groupBy({
    by: ['accountId', 'divisionId'],
    where: {
      accountId: { in: accounts.map((a) => a.id) },
      entry: { confirmedAt: { not: null }, entryDate: { lte: toDateOnly(asOf) } },
    },
    _sum: { debit: true, credit: true },
  });

  await ctx.tx.openingBalance.deleteMany({ where: { periodKey: nextKey, origin: 'CARRY_FORWARD' } });

  let count = 0;
  for (const s of sums) {
    const debit = D(s._sum.debit ?? 0);
    const credit = D(s._sum.credit ?? 0);
    if (debit.isZero() && credit.isZero()) continue;

    // the opening carries the net position on the side it actually sits
    const net = debit.minus(credit);
    await ctx.tx.openingBalance.create({
      data: {
        periodKey: nextKey,
        accountId: s.accountId,
        divisionId: s.divisionId,
        debit: net.isNegative() ? '0' : amount(net),
        credit: net.isNegative() ? amount(net.neg()) : '0',
        origin: 'CARRY_FORWARD',
      },
    });
    count++;
  }
  return count;
}

export async function runs(ctx: TransactionContext, take = 50) {
  requirePermission(ctx.actor, 'accounting.read');
  return ctx.tx.closingRun.findMany({
    include: { period: { select: { periodKey: true, status: true } } },
    orderBy: { runAt: 'desc' },
    take,
  });
}

export async function openingBalances(ctx: TransactionContext, periodKey: string) {
  requirePermission(ctx.actor, 'accounting.read');
  return ctx.tx.openingBalance.findMany({
    where: { periodKey },
    include: { account: { select: { code: true, name: true, accountType: true } } },
    orderBy: { account: { code: 'asc' } },
  });
}

export { monthRange };
