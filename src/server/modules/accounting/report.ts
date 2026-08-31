import type { TransactionContext } from '@/server/core/context';
import { AppError } from '@/server/core/errors';
import { requirePermission } from '@/server/modules/rbac/service';
import { isProfitAndLoss } from './account';
import { amount, D, ZERO } from '@/lib/money';
import { monthRange, periodKey as periodOf, toDateOnly } from '@/lib/dates';
import type Decimal from 'decimal.js';

/**
 * ACC-04 (원장), ACC-05 (손익), ACC-06 (재무상태), ACC-07 (부문별 손익).
 *
 * Everything here reads confirmed journal lines and nothing else, so a figure on a screen
 * can always be traced to the entries behind it. Every output carries INTERNAL_NOTICE:
 * the RFP requires these to be labelled as internal management reports, not filed
 * financial statements, and that label belongs with the data rather than bolted onto one
 * screen and forgotten on the export.
 */

export const INTERNAL_NOTICE = '내부 관리용이며 세무신고·외부공시용 확정 재무제표가 아닙니다.';

/**
 * What counts as "in the books". Not `status: CONFIRMED` — cancelling a confirmed entry
 * leaves the original CANCELED *and* writes a reversal, so filtering on status alone drops
 * the original while keeping its mirror, and the account balance ends up showing the
 * reversal on its own. An entry belongs to the books once it has been confirmed, and its
 * cancellation is represented by the reversing entry beside it, exactly as INT-07 intends.
 * A draft that was cancelled without ever being confirmed has no confirmedAt and stays out.
 */
const POSTED = { confirmedAt: { not: null } };

/**
 * INT-12. A requested division narrows the actor's scope; it never replaces it.
 *
 * This used to return `{ divisionId }` as soon as one was requested, before looking at the
 * actor at all — so a user scoped to one division could read another division's ledger just
 * by naming it in the filter. The scope was enforced only for the caller who did not ask for
 * anything in particular, which is the caller least likely to be probing.
 */
function divisionFilter(ctx: TransactionContext, divisionId?: string) {
  if (ctx.actor.isAdmin) return divisionId ? { divisionId } : {};
  if (divisionId) {
    if (!ctx.actor.divisionIds.includes(divisionId)) {
      throw new AppError('OUT_OF_SCOPE', '해당 사업부의 자료에 접근할 수 없습니다.', { divisionId });
    }
    return { divisionId };
  }
  return { OR: [{ divisionId: { in: ctx.actor.divisionIds } }, { divisionId: null }] };
}

// ── ACC-04: general ledger and account ledger ──

export interface LedgerRow {
  lineId: string;
  entryId: string;
  entryNo: string;
  entryDate: string;
  description: string | null;
  counterpart: string;
  partnerName: string | null;
  divisionName: string | null;
  debit: string;
  credit: string;
  balance: string;
  sourceType: string | null;
  sourceId: string | null;
}

export interface AccountLedger {
  accountId: string;
  accountCode: string;
  accountName: string;
  normalSide: string;
  from: string;
  to: string;
  opening: string;
  closing: string;
  totalDebit: string;
  totalCredit: string;
  rows: LedgerRow[];
  notice: string;
}

/**
 * ACC-04: one account over a period, with a running balance and a link back to the source
 * document on every row. The balance is signed by the account's normal side, so an asset
 * account reads positive when it holds something.
 */
export async function accountLedger(
  ctx: TransactionContext,
  input: { accountId: string; from: string; to: string; divisionId?: string },
): Promise<AccountLedger> {
  requirePermission(ctx.actor, 'accounting.read');

  const account = await ctx.tx.account.findUniqueOrThrow({
    where: { id: input.accountId },
    select: { id: true, code: true, name: true, normalSide: true },
  });
  const sign = account.normalSide === 'DEBIT' ? 1 : -1;
  const scope = divisionFilter(ctx, input.divisionId);

  const before = await ctx.tx.journalLine.aggregate({
    where: {
      accountId: input.accountId,
      ...scope,
      entry: { ...POSTED, entryDate: { lt: toDateOnly(input.from) } },
    },
    _sum: { debit: true, credit: true },
  });
  const opening = D(before._sum.debit ?? 0)
    .minus(D(before._sum.credit ?? 0))
    .times(sign);

  const lines = await ctx.tx.journalLine.findMany({
    where: {
      accountId: input.accountId,
      ...scope,
      entry: {
        ...POSTED,
        entryDate: { gte: toDateOnly(input.from), lte: toDateOnly(input.to) },
      },
    },
    include: {
      entry: {
        select: {
          id: true,
          entryNo: true,
          entryDate: true,
          description: true,
          sourceType: true,
          sourceId: true,
          lines: { select: { accountId: true, account: { select: { name: true } } } },
        },
      },
      partner: { select: { name: true } },
      division: { select: { name: true } },
    },
    orderBy: [{ entry: { entryDate: 'asc' } }, { entry: { entryNo: 'asc' } }, { lineNo: 'asc' }],
    take: 5000,
  });

  let balance = opening;
  let totalDebit = ZERO;
  let totalCredit = ZERO;

  const rows: LedgerRow[] = lines.map((l) => {
    const d = D(l.debit);
    const c = D(l.credit);
    balance = balance.plus(d.minus(c).times(sign));
    totalDebit = totalDebit.plus(d);
    totalCredit = totalCredit.plus(c);

    // the counterpart is what makes a ledger row readable: "what was the other side?"
    const others = l.entry.lines.filter((x) => x.accountId !== input.accountId).map((x) => x.account.name);
    const counterpart =
      others.length === 0 ? '-' : others.length === 1 ? others[0]! : `${others[0]!} 외 ${others.length - 1}`;

    return {
      lineId: l.id,
      entryId: l.entry.id,
      entryNo: l.entry.entryNo,
      entryDate: l.entry.entryDate.toISOString().slice(0, 10),
      description: l.description ?? l.entry.description,
      counterpart,
      partnerName: l.partner?.name ?? null,
      divisionName: l.division?.name ?? null,
      debit: amount(d),
      credit: amount(c),
      balance: amount(balance),
      sourceType: l.entry.sourceType,
      sourceId: l.entry.sourceId,
    };
  });

  return {
    accountId: account.id,
    accountCode: account.code,
    accountName: account.name,
    normalSide: account.normalSide,
    from: input.from,
    to: input.to,
    opening: amount(opening),
    closing: amount(balance),
    totalDebit: amount(totalDebit),
    totalCredit: amount(totalCredit),
    rows,
    notice: INTERNAL_NOTICE,
  };
}

export interface TrialRow {
  accountId: string;
  code: string;
  name: string;
  accountType: string;
  opening: string;
  debit: string;
  credit: string;
  closing: string;
}

/** ACC-04: the general ledger summary — every account's movement over a period. */
export async function trialBalance(
  ctx: TransactionContext,
  input: { from: string; to: string; divisionId?: string; hideZero?: boolean },
): Promise<{ rows: TrialRow[]; totalDebit: string; totalCredit: string; notice: string }> {
  requirePermission(ctx.actor, 'accounting.read');
  const scope = divisionFilter(ctx, input.divisionId);

  const [accounts, before, within] = await Promise.all([
    ctx.tx.account.findMany({
      where: { isPostable: true },
      select: { id: true, code: true, name: true, accountType: true, normalSide: true },
      orderBy: { code: 'asc' },
    }),
    ctx.tx.journalLine.groupBy({
      by: ['accountId'],
      where: { ...scope, entry: { ...POSTED, entryDate: { lt: toDateOnly(input.from) } } },
      _sum: { debit: true, credit: true },
    }),
    ctx.tx.journalLine.groupBy({
      by: ['accountId'],
      where: {
        ...scope,
        entry: { ...POSTED, entryDate: { gte: toDateOnly(input.from), lte: toDateOnly(input.to) } },
      },
      _sum: { debit: true, credit: true },
    }),
  ]);

  const openingBy = new Map(before.map((b) => [b.accountId, b]));
  const movementBy = new Map(within.map((w) => [w.accountId, w]));

  let totalDebit = ZERO;
  let totalCredit = ZERO;
  const rows: TrialRow[] = [];

  for (const a of accounts) {
    const sign = a.normalSide === 'DEBIT' ? 1 : -1;
    const o = openingBy.get(a.id);
    const m = movementBy.get(a.id);

    const opening = D(o?._sum.debit ?? 0)
      .minus(D(o?._sum.credit ?? 0))
      .times(sign);
    const debit = D(m?._sum.debit ?? 0);
    const credit = D(m?._sum.credit ?? 0);
    const closing = opening.plus(debit.minus(credit).times(sign));

    if (input.hideZero && opening.isZero() && debit.isZero() && credit.isZero()) continue;

    totalDebit = totalDebit.plus(debit);
    totalCredit = totalCredit.plus(credit);
    rows.push({
      accountId: a.id,
      code: a.code,
      name: a.name,
      accountType: a.accountType,
      opening: amount(opening),
      debit: amount(debit),
      credit: amount(credit),
      closing: amount(closing),
    });
  }

  return { rows, totalDebit: amount(totalDebit), totalCredit: amount(totalCredit), notice: INTERNAL_NOTICE };
}

// ── ACC-05 / ACC-07: income statement ──

export interface IncomeRow {
  accountId: string;
  code: string;
  name: string;
  accountType: string;
  current: string;
  previous: string;
  change: string;
}

export interface IncomeStatement {
  period: string;
  comparePeriod: string;
  divisionId: string | null;
  revenue: IncomeRow[];
  expense: IncomeRow[];
  totalRevenue: string;
  totalExpense: string;
  netIncome: string;
  previousNetIncome: string;
  notice: string;
}

/**
 * ACC-05: a month's P&L with the comparison period beside it. Closing entries are excluded
 * — including them would double-count the year's result in the month it was closed.
 */
export async function incomeStatement(
  ctx: TransactionContext,
  input: { period: string; comparePeriod?: string; divisionId?: string },
): Promise<IncomeStatement> {
  requirePermission(ctx.actor, 'accounting.read');
  const compare = input.comparePeriod ?? previousMonth(input.period);
  const scope = divisionFilter(ctx, input.divisionId);

  const sums = async (key: string) => {
    const { start, endExclusive } = monthRange(key);
    return ctx.tx.journalLine.groupBy({
      by: ['accountId'],
      where: {
        ...scope,
        entry: {
          ...POSTED,
          isClosingEntry: false,
          entryDate: { gte: toDateOnly(start), lt: toDateOnly(endExclusive) },
        },
      },
      _sum: { debit: true, credit: true },
    });
  };

  const [accounts, current, previous] = await Promise.all([
    ctx.tx.account.findMany({
      where: { accountType: { in: ['REVENUE', 'EXPENSE'] }, isPostable: true },
      select: { id: true, code: true, name: true, accountType: true, normalSide: true },
      orderBy: { code: 'asc' },
    }),
    sums(input.period),
    sums(compare),
  ]);

  const cur = new Map(current.map((r) => [r.accountId, r]));
  const prev = new Map(previous.map((r) => [r.accountId, r]));

  const balanceOf = (
    row: { _sum: { debit: unknown; credit: unknown } } | undefined,
    normalSide: string,
  ): Decimal => {
    const sign = normalSide === 'DEBIT' ? 1 : -1;
    return D((row?._sum.debit as never) ?? 0)
      .minus(D((row?._sum.credit as never) ?? 0))
      .times(sign);
  };

  const revenue: IncomeRow[] = [];
  const expense: IncomeRow[] = [];
  let totalRevenue = ZERO;
  let totalExpense = ZERO;
  let prevRevenue = ZERO;
  let prevExpense = ZERO;

  for (const a of accounts) {
    const c = balanceOf(cur.get(a.id), a.normalSide);
    const p = balanceOf(prev.get(a.id), a.normalSide);
    if (c.isZero() && p.isZero()) continue;

    const row: IncomeRow = {
      accountId: a.id,
      code: a.code,
      name: a.name,
      accountType: a.accountType,
      current: amount(c),
      previous: amount(p),
      change: amount(c.minus(p)),
    };

    if (a.accountType === 'REVENUE') {
      revenue.push(row);
      totalRevenue = totalRevenue.plus(c);
      prevRevenue = prevRevenue.plus(p);
    } else {
      expense.push(row);
      totalExpense = totalExpense.plus(c);
      prevExpense = prevExpense.plus(p);
    }
  }

  return {
    period: input.period,
    comparePeriod: compare,
    divisionId: input.divisionId ?? null,
    revenue,
    expense,
    totalRevenue: amount(totalRevenue),
    totalExpense: amount(totalExpense),
    netIncome: amount(totalRevenue.minus(totalExpense)),
    previousNetIncome: amount(prevRevenue.minus(prevExpense)),
    notice: INTERNAL_NOTICE,
  };
}

/** ACC-07: the same P&L split by division, so the divisions sum to the whole. */
export async function incomeByDivision(ctx: TransactionContext, period: string) {
  requirePermission(ctx.actor, 'accounting.read');

  const divisions = await ctx.tx.division.findMany({
    where: {
      isActive: true,
      ...(ctx.actor.isAdmin ? {} : { id: { in: ctx.actor.divisionIds } }),
    },
    orderBy: { sortOrder: 'asc' },
  });

  const columns = await Promise.all(
    divisions.map(async (d) => {
      const statement = await incomeStatement(ctx, { period, divisionId: d.id });
      return {
        divisionId: d.id,
        divisionName: d.name,
        revenue: statement.totalRevenue,
        expense: statement.totalExpense,
        netIncome: statement.netIncome,
      };
    }),
  );

  // lines with no division tag belong to no division but still belong to the company
  const total = await incomeStatement(ctx, { period });
  const tagged = columns.reduce((acc, c) => acc.plus(D(c.netIncome)), ZERO);

  return {
    period,
    columns,
    total: { revenue: total.totalRevenue, expense: total.totalExpense, netIncome: total.netIncome },
    untagged: amount(D(total.netIncome).minus(tagged)),
    notice: INTERNAL_NOTICE,
  };
}

// ── ACC-06: balance sheet ──

export interface BalanceSheetSection {
  accountType: string;
  rows: { accountId: string; code: string; name: string; balance: string }[];
  total: string;
}

export interface BalanceSheet {
  asOf: string;
  assets: BalanceSheetSection;
  liabilities: BalanceSheetSection;
  equity: BalanceSheetSection;
  /** revenue less expense for the year to date, shown inside equity but not yet closed */
  currentEarnings: string;
  balanced: boolean;
  difference: string;
  notice: string;
}

/**
 * ACC-06: the position on a date. Retained earnings for the year are shown separately
 * because they have not been closed into equity yet — presenting them as if they had
 * would make the sheet balance for the wrong reason.
 */
export async function balanceSheet(
  ctx: TransactionContext,
  input: { asOf: string; divisionId?: string },
): Promise<BalanceSheet> {
  requirePermission(ctx.actor, 'accounting.read');
  const scope = divisionFilter(ctx, input.divisionId);

  const [accounts, sums] = await Promise.all([
    ctx.tx.account.findMany({
      where: { accountType: { in: ['ASSET', 'LIABILITY', 'EQUITY'] }, isPostable: true },
      select: { id: true, code: true, name: true, accountType: true, normalSide: true },
      orderBy: { code: 'asc' },
    }),
    ctx.tx.journalLine.groupBy({
      by: ['accountId'],
      where: { ...scope, entry: { ...POSTED, entryDate: { lte: toDateOnly(input.asOf) } } },
      _sum: { debit: true, credit: true },
    }),
  ]);

  const by = new Map(sums.map((s) => [s.accountId, s]));
  const section = (type: string): BalanceSheetSection => {
    let total = ZERO;
    const rows = accounts
      .filter((a) => a.accountType === type)
      .map((a) => {
        const s = by.get(a.id);
        const sign = a.normalSide === 'DEBIT' ? 1 : -1;
        const balance = D(s?._sum.debit ?? 0)
          .minus(D(s?._sum.credit ?? 0))
          .times(sign);
        total = total.plus(balance);
        return { accountId: a.id, code: a.code, name: a.name, balance: amount(balance) };
      })
      .filter((r) => r.balance !== '0');
    return { accountType: type, rows, total: amount(total) };
  };

  const assets = section('ASSET');
  const liabilities = section('LIABILITY');
  const equity = section('EQUITY');

  // year-to-date profit that has not been closed into equity yet
  const yearStart = `${input.asOf.slice(0, 4)}-01-01`;
  const plSums = await ctx.tx.journalLine.groupBy({
    by: ['accountId'],
    where: {
      ...scope,
      entry: {
        ...POSTED,
        isClosingEntry: false,
        entryDate: { gte: toDateOnly(yearStart), lte: toDateOnly(input.asOf) },
      },
      account: { accountType: { in: ['REVENUE', 'EXPENSE'] } },
    },
    _sum: { debit: true, credit: true },
  });
  const plAccounts = await ctx.tx.account.findMany({
    where: { id: { in: plSums.map((p) => p.accountId) } },
    select: { id: true, accountType: true },
  });
  const typeById = new Map(plAccounts.map((a) => [a.id, a.accountType]));

  let currentEarnings = ZERO;
  for (const s of plSums) {
    const type = typeById.get(s.accountId);
    if (!type || !isProfitAndLoss(type)) continue;
    const value = D(s._sum.credit ?? 0).minus(D(s._sum.debit ?? 0));
    // revenue is a credit balance (positive), expense a debit balance (negative)
    currentEarnings = currentEarnings.plus(value);
  }

  const left = D(assets.total);
  const right = D(liabilities.total).plus(D(equity.total)).plus(currentEarnings);
  const difference = left.minus(right);

  return {
    asOf: input.asOf,
    assets,
    liabilities,
    equity,
    currentEarnings: amount(currentEarnings),
    balanced: difference.isZero(),
    difference: amount(difference),
    notice: INTERNAL_NOTICE,
  };
}

// ── ACC-09: export ──

export function trialBalanceToCsv(
  data: Awaited<ReturnType<typeof trialBalance>>,
  from: string,
  to: string,
): string {
  const lines = [
    `# ${INTERNAL_NOTICE}`,
    `# 기간,${from} ~ ${to}`,
    ['계정코드', '계정과목', '구분', '기초', '차변', '대변', '기말'].join(','),
    ...data.rows.map((r) =>
      [r.code, csv(r.name), r.accountType, r.opening, r.debit, r.credit, r.closing].join(','),
    ),
    ['', '합계', '', '', data.totalDebit, data.totalCredit, ''].join(','),
  ];
  return lines.join('\n');
}

export function accountLedgerToCsv(data: AccountLedger): string {
  const lines = [
    `# ${INTERNAL_NOTICE}`,
    `# 계정,${data.accountCode} ${data.accountName}`,
    `# 기간,${data.from} ~ ${data.to}`,
    ['일자', '전표번호', '적요', '상대계정', '거래처', '부문', '차변', '대변', '잔액'].join(','),
    ['', '', '기초', '', '', '', '', '', data.opening].join(','),
    ...data.rows.map((r) =>
      [
        r.entryDate,
        r.entryNo,
        csv(r.description ?? ''),
        csv(r.counterpart),
        csv(r.partnerName ?? ''),
        csv(r.divisionName ?? ''),
        r.debit,
        r.credit,
        r.balance,
      ].join(','),
    ),
    ['', '', '기말', '', '', '', data.totalDebit, data.totalCredit, data.closing].join(','),
  ];
  return lines.join('\n');
}

function csv(v: string): string {
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

function previousMonth(period: string): string {
  const [y, m] = period.split('-').map(Number) as [number, number];
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
}

export { periodOf };
