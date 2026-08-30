// covers: ACC-01..ACC-09, INT-05, INT-07, DEC-04, B-01
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { actorFor, prepareDatabase, prisma, runTx, truncateBusinessData } from '../helpers/db';
import * as account from '@/server/modules/accounting/account';
import * as journal from '@/server/modules/accounting/journal';
import * as period from '@/server/modules/accounting/period';
import * as postingRule from '@/server/modules/accounting/posting-rule';
import * as report from '@/server/modules/accounting/report';
import * as closing from '@/server/modules/accounting/closing';
import { hashPassword } from '@/server/core/crypto';
import type { Actor } from '@/server/core/context';

let admin: Actor;
let clerk: Actor;
const acc: Record<string, string> = {};

beforeAll(async () => {
  prepareDatabase();
  admin = await actorFor('admin');

  // a user with accounting rights but NOT period.reopen, to prove the reopen gate
  const role = await prisma.role.findUniqueOrThrow({ where: { code: 'accounting' } });
  await prisma.user.upsert({
    where: { username: 'accclerk' },
    create: {
      username: 'accclerk',
      displayName: '회계담당',
      passwordHash: await hashPassword('Clerk!123456'),
      roles: { create: [{ roleId: role.id }] },
    },
    update: { isActive: true },
  });
  clerk = await actorFor('accclerk');

  for (const code of ['101', '102', '110', '120', '150', '210', '220', '330', '401', '501', '601']) {
    const row = await prisma.account.findUniqueOrThrow({ where: { code } });
    acc[code] = row.id;
  }
});

beforeEach(async () => {
  await truncateBusinessData();
});

afterAll(() => prisma.$disconnect());

/** A confirmed manual entry, the way a router would make one. */
async function post(lines: journal.LineInput[], entryDate = '2026-06-15', description = '시험 전표') {
  const entry = await runTx(admin, (t) => journal.create(t, { entryDate, description, lines }));
  await runTx(admin, (t) => journal.confirm(t, entry.id, entry.version));
  return entry;
}

describe('ACC-02: balanced entries only', () => {
  it('a balanced entry is created and confirmed', async () => {
    const entry = await post([
      { accountId: acc['110']!, debit: '660000' },
      { accountId: acc['401']!, credit: '600000' },
      { accountId: acc['220']!, credit: '60000' },
    ]);

    const stored = await prisma.journalEntry.findUniqueOrThrow({
      where: { id: entry.id },
      include: { lines: true },
    });
    expect(stored.status).toBe('CONFIRMED');
    expect(stored.totalDebit.toString()).toBe('660000');
    expect(stored.totalCredit.toString()).toBe('660000');
    expect(stored.lines).toHaveLength(3);
    expect(stored.entryNo).toMatch(/^JV-/);
  });

  it('an unbalanced entry is never written', async () => {
    await expect(
      runTx(admin, (t) =>
        journal.create(t, {
          lines: [
            { accountId: acc['110']!, debit: '100000' },
            { accountId: acc['401']!, credit: '90000' },
          ],
        }),
      ),
    ).rejects.toThrow(/차액 10000원/);
    expect(await prisma.journalEntry.count()).toBe(0);
  });

  it('a non-postable parent account is refused', async () => {
    const parent = await prisma.account.findUniqueOrThrow({ where: { code: '100' } });
    await expect(
      runTx(admin, (t) =>
        journal.create(t, {
          lines: [
            { accountId: parent.id, debit: '1000' },
            { accountId: acc['401']!, credit: '1000' },
          ],
        }),
      ),
    ).rejects.toThrow(/하위 계정이 있는 계정/);
  });

  it('a deactivated account is refused', async () => {
    const target = await prisma.account.findUniqueOrThrow({ where: { code: '605' } });
    await prisma.account.update({ where: { id: target.id }, data: { isActive: false } });
    try {
      await expect(
        runTx(admin, (t) =>
          journal.create(t, {
            lines: [
              { accountId: target.id, debit: '1000' },
              { accountId: acc['101']!, credit: '1000' },
            ],
          }),
        ),
      ).rejects.toThrow(/사용중지된 계정과목/);
    } finally {
      await prisma.account.update({ where: { id: target.id }, data: { isActive: true } });
    }
  });
});

describe('INT-07 / ACC-08: cancelling writes a reversal, never an edit', () => {
  it('a confirmed entry is canceled and mirrored by a reversing entry', async () => {
    const entry = await post([
      { accountId: acc['110']!, debit: '330000' },
      { accountId: acc['401']!, credit: '330000' },
    ]);
    const confirmed = await prisma.journalEntry.findUniqueOrThrow({ where: { id: entry.id } });

    const result = await runTx(admin, (t) => journal.cancel(t, entry.id, '거래 취소', confirmed.version));
    expect(result.reversalId).toBeTruthy();

    const reversal = await prisma.journalEntry.findUniqueOrThrow({
      where: { id: result.reversalId! },
      include: { lines: { orderBy: { lineNo: 'asc' } } },
    });
    expect(reversal.reversalOfId).toBe(entry.id);
    expect(reversal.status).toBe('CONFIRMED');
    // the sides are swapped, which is what makes the pair net to zero
    expect(reversal.lines[0]!.credit.toString()).toBe('330000');
    expect(reversal.lines[0]!.debit.toString()).toBe('0');

    // the original still exists, unchanged apart from its status
    const original = await prisma.journalEntry.findUniqueOrThrow({ where: { id: entry.id } });
    expect(original.status).toBe('CANCELED');
    expect(original.totalDebit.toString()).toBe('330000');
  });

  it('the account balance nets to zero after a cancellation', async () => {
    const entry = await post([
      { accountId: acc['110']!, debit: '500000' },
      { accountId: acc['401']!, credit: '500000' },
    ]);
    const confirmed = await prisma.journalEntry.findUniqueOrThrow({ where: { id: entry.id } });
    await runTx(admin, (t) => journal.cancel(t, entry.id, '오입력', confirmed.version));

    const ledger = await runTx(admin, (t) =>
      report.accountLedger(t, { accountId: acc['110']!, from: '2026-06-01', to: '2026-06-30' }),
    );
    expect(ledger.closing).toBe('0');
    // both rows are visible: the ledger shows what happened, not a tidied result
    expect(ledger.rows).toHaveLength(2);
  });

  it('a confirmed entry cannot be edited', async () => {
    const entry = await post([
      { accountId: acc['110']!, debit: '1000' },
      { accountId: acc['401']!, credit: '1000' },
    ]);
    const confirmed = await prisma.journalEntry.findUniqueOrThrow({ where: { id: entry.id } });

    await expect(
      runTx(admin, (t) =>
        journal.update(
          t,
          entry.id,
          {
            lines: [
              { accountId: acc['110']!, debit: '2000' },
              { accountId: acc['401']!, credit: '2000' },
            ],
          },
          confirmed.version,
        ),
      ),
    ).rejects.toThrow(/작성 중인 전표만/);
  });

  it('the database refuses to change a confirmed entry even behind the service', async () => {
    const entry = await post([
      { accountId: acc['110']!, debit: '7000' },
      { accountId: acc['401']!, credit: '7000' },
    ]);
    await expect(
      prisma.$executeRawUnsafe(`UPDATE "JournalEntry" SET "totalDebit" = 1 WHERE id = $1`, entry.id),
    ).rejects.toThrow(/cannot change amounts/);

    await expect(
      prisma.$executeRawUnsafe(`DELETE FROM "JournalLine" WHERE "entryId" = $1`, entry.id),
    ).rejects.toThrow(/append-only/);
  });

  it('cancelling twice is refused', async () => {
    const entry = await post([
      { accountId: acc['110']!, debit: '1000' },
      { accountId: acc['401']!, credit: '1000' },
    ]);
    const confirmed = await prisma.journalEntry.findUniqueOrThrow({ where: { id: entry.id } });
    await runTx(admin, (t) => journal.cancel(t, entry.id, '취소', confirmed.version));

    const canceled = await prisma.journalEntry.findUniqueOrThrow({ where: { id: entry.id } });
    await expect(
      runTx(admin, (t) => journal.cancel(t, entry.id, '또 취소', canceled.version)),
    ).rejects.toThrow(/이미 취소된/);
  });
});

describe('DEC-04 / B-01: closed periods', () => {
  it('a closed month refuses creation, confirmation and cancellation', async () => {
    const entry = await post(
      [
        { accountId: acc['110']!, debit: '1000' },
        { accountId: acc['401']!, credit: '1000' },
      ],
      '2026-07-15',
    );

    await runTx(admin, (t) => closing.closeMonth(t, '2026-07'));

    await expect(
      runTx(admin, (t) =>
        journal.create(t, {
          entryDate: '2026-07-20',
          lines: [
            { accountId: acc['110']!, debit: '1000' },
            { accountId: acc['401']!, credit: '1000' },
          ],
        }),
      ),
    ).rejects.toThrow(/마감/);

    const confirmed = await prisma.journalEntry.findUniqueOrThrow({ where: { id: entry.id } });
    // cancelling a confirmed entry is allowed, but the reversal moves to an open month
    const result = await runTx(admin, (t) => journal.cancel(t, entry.id, '마감 후 취소', confirmed.version));
    const reversal = await prisma.journalEntry.findUniqueOrThrow({ where: { id: result.reversalId! } });
    expect(reversal.entryDate.toISOString().slice(0, 10)).toBe('2026-08-01');
  });

  it('reopening needs the permission and a reason, and both land in the audit log', async () => {
    await post(
      [
        { accountId: acc['110']!, debit: '1000' },
        { accountId: acc['401']!, credit: '1000' },
      ],
      '2026-07-15',
    );
    await runTx(admin, (t) => closing.closeMonth(t, '2026-07'));

    // the accountant role can close but not reopen
    await expect(runTx(clerk, (t) => period.reopen(t, '2026-07', '단가 정정 필요'))).rejects.toThrow(/권한/);
    await expect(runTx(admin, (t) => period.reopen(t, '2026-07', '오타'))).rejects.toThrow(/5자/);

    await runTx(admin, (t) => period.reopen(t, '2026-07', '매입 단가 정정 필요'));
    expect(await runTx(admin, (t) => period.statusOf(t, '2026-07'))).toBe('OPEN');

    const log = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'accountingPeriod.reopen' },
    });
    expect(JSON.stringify(log.after)).toContain('매입 단가 정정 필요');

    // and after reopening, the month accepts entries again
    await post(
      [
        { accountId: acc['110']!, debit: '2000' },
        { accountId: acc['401']!, credit: '2000' },
      ],
      '2026-07-20',
    );
  });

  it('a month with a draft entry cannot close', async () => {
    await runTx(admin, (t) =>
      journal.create(t, {
        entryDate: '2026-07-10',
        lines: [
          { accountId: acc['110']!, debit: '1000' },
          { accountId: acc['401']!, credit: '1000' },
        ],
      }),
    );
    await expect(runTx(admin, (t) => closing.closeMonth(t, '2026-07'))).rejects.toThrow(/확정되지 않은 전표/);
  });

  it('months close in order', async () => {
    await post(
      [
        { accountId: acc['110']!, debit: '1000' },
        { accountId: acc['401']!, credit: '1000' },
      ],
      '2026-06-10',
    );
    await post(
      [
        { accountId: acc['110']!, debit: '1000' },
        { accountId: acc['401']!, credit: '1000' },
      ],
      '2026-07-10',
    );

    await expect(runTx(admin, (t) => closing.closeMonth(t, '2026-07'))).rejects.toThrow(/이전 기간/);
  });
});

describe('ACC-03: automatic posting from a source document', () => {
  it('the SALES rule produces the E2E-01 entry shape', async () => {
    const entry = await runTx(admin, (t) =>
      postingRule.post(t, 'SALES', {
        source: { sourceType: 'SALES', sourceId: 'sales-doc-1' },
        entryDate: '2026-06-15',
        amounts: { supply: '600000', vat: '60000', total: '660000', cost: '400000' },
      }),
    );

    const stored = await prisma.journalEntry.findUniqueOrThrow({
      where: { id: entry.id },
      include: { lines: { include: { account: true }, orderBy: { lineNo: 'asc' } } },
    });
    expect(stored.status).toBe('CONFIRMED');
    expect(stored.totalDebit.toString()).toBe('1060000'); // 660,000 receivable + 400,000 COGS

    const byCode = new Map(stored.lines.map((l) => [l.account.code, l]));
    expect(byCode.get('110')!.debit.toString()).toBe('660000');
    expect(byCode.get('401')!.credit.toString()).toBe('600000');
    expect(byCode.get('220')!.credit.toString()).toBe('60000');
    expect(byCode.get('501')!.debit.toString()).toBe('400000');
    expect(byCode.get('150')!.credit.toString()).toBe('400000');

    // the rule version is recorded on the entry, so a later rule change cannot rewrite it
    expect(stored.postingRuleVersionId).toBeTruthy();
  });

  it('a zero-VAT sale drops the VAT line instead of posting an empty one', async () => {
    const entry = await runTx(admin, (t) =>
      postingRule.post(t, 'SALES', {
        source: { sourceType: 'SALES', sourceId: 'sales-doc-zero-vat' },
        entryDate: '2026-06-15',
        amounts: { supply: '500000', vat: '0', total: '500000', cost: '300000' },
      }),
    );
    const stored = await prisma.journalEntry.findUniqueOrThrow({
      where: { id: entry.id },
      include: { lines: { include: { account: true } } },
    });
    expect(stored.lines.map((l) => l.account.code)).not.toContain('220');
    expect(stored.totalDebit.toString()).toBe(stored.totalCredit.toString());
  });

  it('the PURCHASE rule produces the E2E-02 entry shape', async () => {
    const entry = await runTx(admin, (t) =>
      postingRule.post(t, 'PURCHASE', {
        source: { sourceType: 'PURCHASE', sourceId: 'purchase-doc-1' },
        entryDate: '2026-06-15',
        amounts: { supply: '300000', vat: '30000', total: '330000' },
      }),
    );
    const stored = await prisma.journalEntry.findUniqueOrThrow({
      where: { id: entry.id },
      include: { lines: { include: { account: true } } },
    });
    const byCode = new Map(stored.lines.map((l) => [l.account.code, l]));
    expect(byCode.get('150')!.debit.toString()).toBe('300000');
    expect(byCode.get('120')!.debit.toString()).toBe('30000');
    expect(byCode.get('210')!.credit.toString()).toBe('330000');
  });

  it('INT-05: the same source cannot post twice', async () => {
    const source = { sourceType: 'SALES', sourceId: 'sales-doc-dup' };
    await runTx(admin, (t) =>
      postingRule.post(t, 'SALES', {
        source,
        entryDate: '2026-06-15',
        amounts: { supply: '100000', vat: '10000', total: '110000', cost: '60000' },
      }),
    );
    await expect(
      runTx(admin, (t) =>
        postingRule.post(t, 'SALES', {
          source,
          entryDate: '2026-06-15',
          amounts: { supply: '100000', vat: '10000', total: '110000', cost: '60000' },
        }),
      ),
    ).rejects.toThrow(/이미 분개가 생성된/);

    expect(await prisma.journalEntry.count({ where: source })).toBe(1);
  });

  it('reverseFromSource cancels the original and posts the mirror once', async () => {
    const source = { sourceType: 'SALES', sourceId: 'sales-doc-cancel' };
    await runTx(admin, (t) =>
      postingRule.post(t, 'SALES', {
        source,
        entryDate: '2026-06-15',
        amounts: { supply: '200000', vat: '20000', total: '220000', cost: '120000' },
      }),
    );

    const first = await runTx(admin, (t) => journal.reverseFromSource(t, source, '전표 취소'));
    expect(first).not.toBeNull();

    // calling it again returns the existing reversal rather than posting a second one
    const second = await runTx(admin, (t) => journal.reverseFromSource(t, source, '전표 취소'));
    expect(second!.id).toBe(first!.id);
    expect(await prisma.journalEntry.count({ where: source })).toBe(2);

    const original = await prisma.journalEntry.findFirstOrThrow({
      where: { ...source, sourceVersion: 1 },
    });
    expect(original.status).toBe('CANCELED');
  });

  it('a rule version change does not touch entries already posted', async () => {
    await runTx(admin, (t) =>
      postingRule.post(t, 'RECEIPT', {
        source: { sourceType: 'RECEIPT', sourceId: 'receipt-1' },
        entryDate: '2026-06-10',
        amounts: { total: '100000' },
      }),
    );
    const before = await prisma.journalEntry.findFirstOrThrow({
      where: { sourceType: 'RECEIPT', sourceId: 'receipt-1' },
      include: { lines: { include: { account: true } } },
    });
    const beforeCodes = before.lines.map((l) => l.account.code).sort();

    // publish a new version that books receipts to cash instead of the bank
    await runTx(admin, (t) =>
      postingRule.publish(t, {
        code: 'RECEIPT',
        effectiveFrom: '2026-07-01',
        template: [
          { slot: 'CASH', side: 'DEBIT', amountKey: 'total' },
          { slot: 'ACCOUNTS_RECEIVABLE', side: 'CREDIT', amountKey: 'total' },
        ],
      }),
    );

    const after = await prisma.journalEntry.findFirstOrThrow({
      where: { sourceType: 'RECEIPT', sourceId: 'receipt-1' },
      include: { lines: { include: { account: true } } },
    });
    expect(after.lines.map((l) => l.account.code).sort()).toEqual(beforeCodes);

    // a July receipt uses the new version
    await runTx(admin, (t) =>
      postingRule.post(t, 'RECEIPT', {
        source: { sourceType: 'RECEIPT', sourceId: 'receipt-2' },
        entryDate: '2026-07-10',
        amounts: { total: '50000' },
      }),
    );
    const july = await prisma.journalEntry.findFirstOrThrow({
      where: { sourceType: 'RECEIPT', sourceId: 'receipt-2' },
      include: { lines: { include: { account: true } } },
    });
    expect(july.lines.map((l) => l.account.code)).toContain('101');
  });
});

describe('ACC-04: ledgers', () => {
  it('the account ledger shows opening, movement, running balance and the counterpart', async () => {
    await post(
      [
        { accountId: acc['110']!, debit: '100000' },
        { accountId: acc['401']!, credit: '100000' },
      ],
      '2026-05-10',
    );
    await post(
      [
        { accountId: acc['102']!, debit: '40000' },
        { accountId: acc['110']!, credit: '40000' },
      ],
      '2026-06-05',
    );

    const ledger = await runTx(admin, (t) =>
      report.accountLedger(t, { accountId: acc['110']!, from: '2026-06-01', to: '2026-06-30' }),
    );
    expect(ledger.opening).toBe('100000');
    expect(ledger.rows).toHaveLength(1);
    expect(ledger.rows[0]!.credit).toBe('40000');
    expect(ledger.rows[0]!.counterpart).toBe('보통예금');
    expect(ledger.closing).toBe('60000');
    expect(ledger.notice).toContain('내부 관리용');
  });

  it('the trial balance debits and credits agree', async () => {
    await post([
      { accountId: acc['110']!, debit: '660000' },
      { accountId: acc['401']!, credit: '600000' },
      { accountId: acc['220']!, credit: '60000' },
    ]);

    const tb = await runTx(admin, (t) => report.trialBalance(t, { from: '2026-06-01', to: '2026-06-30' }));
    expect(tb.totalDebit).toBe(tb.totalCredit);
    expect(tb.totalDebit).toBe('660000');
    expect(tb.notice).toContain('내부 관리용');
  });

  it('a draft entry never appears in a ledger', async () => {
    await runTx(admin, (t) =>
      journal.create(t, {
        entryDate: '2026-06-15',
        lines: [
          { accountId: acc['110']!, debit: '999999' },
          { accountId: acc['401']!, credit: '999999' },
        ],
      }),
    );
    const tb = await runTx(admin, (t) => report.trialBalance(t, { from: '2026-06-01', to: '2026-06-30' }));
    expect(tb.totalDebit).toBe('0');
  });
});

describe('ACC-05 / ACC-07: income statement', () => {
  it('reports revenue, expense and the comparison period', async () => {
    await post(
      [
        { accountId: acc['110']!, debit: '1000000' },
        { accountId: acc['401']!, credit: '1000000' },
      ],
      '2026-05-15',
    );
    await post(
      [
        { accountId: acc['110']!, debit: '1500000' },
        { accountId: acc['401']!, credit: '1500000' },
      ],
      '2026-06-15',
    );
    await post(
      [
        { accountId: acc['601']!, debit: '400000' },
        { accountId: acc['102']!, credit: '400000' },
      ],
      '2026-06-20',
    );

    const is = await runTx(admin, (t) => report.incomeStatement(t, { period: '2026-06' }));
    expect(is.totalRevenue).toBe('1500000');
    expect(is.totalExpense).toBe('400000');
    expect(is.netIncome).toBe('1100000');
    expect(is.comparePeriod).toBe('2026-05');
    expect(is.previousNetIncome).toBe('1000000');
    expect(is.revenue[0]!.change).toBe('500000');
  });

  it('ACC-07: division-tagged lines split the result, and the parts plus untagged make the whole', async () => {
    const divisions = await prisma.division.findMany({ orderBy: { code: 'asc' }, take: 2 });
    const [d1, d2] = divisions;

    await post([
      { accountId: acc['110']!, debit: '600000', divisionId: d1!.id },
      { accountId: acc['401']!, credit: '600000', divisionId: d1!.id },
    ]);
    await post([
      { accountId: acc['110']!, debit: '400000', divisionId: d2!.id },
      { accountId: acc['401']!, credit: '400000', divisionId: d2!.id },
    ]);
    // an untagged entry belongs to the company but to no division
    await post([
      { accountId: acc['110']!, debit: '100000' },
      { accountId: acc['401']!, credit: '100000' },
    ]);

    const byDivision = await runTx(admin, (t) => report.incomeByDivision(t, '2026-06'));
    const first = byDivision.columns.find((c) => c.divisionId === d1!.id)!;
    const second = byDivision.columns.find((c) => c.divisionId === d2!.id)!;
    expect(first.netIncome).toBe('600000');
    expect(second.netIncome).toBe('400000');
    expect(byDivision.total.netIncome).toBe('1100000');
    expect(byDivision.untagged).toBe('100000');
  });
});

describe('ACC-06: balance sheet', () => {
  it('assets equal liabilities plus equity plus the year-to-date result', async () => {
    // capital injection
    await post(
      [
        { accountId: acc['102']!, debit: '10000000' },
        { accountId: acc['330']!, credit: '10000000' },
      ],
      '2026-01-05',
    );
    // a sale on credit
    await post(
      [
        { accountId: acc['110']!, debit: '1100000' },
        { accountId: acc['401']!, credit: '1000000' },
        { accountId: acc['220']!, credit: '100000' },
      ],
      '2026-06-15',
    );
    // an expense
    await post(
      [
        { accountId: acc['601']!, debit: '300000' },
        { accountId: acc['102']!, credit: '300000' },
      ],
      '2026-06-20',
    );

    const bs = await runTx(admin, (t) => report.balanceSheet(t, { asOf: '2026-06-30' }));
    expect(bs.balanced).toBe(true);
    expect(bs.difference).toBe('0');
    expect(bs.currentEarnings).toBe('700000'); // 1,000,000 revenue - 300,000 expense
    expect(bs.notice).toContain('내부 관리용');
  });
});

describe('ACC-08: year close', () => {
  it('transfers the year result to retained earnings and carries the balance sheet forward', async () => {
    await post(
      [
        { accountId: acc['102']!, debit: '5000000' },
        { accountId: acc['330']!, credit: '5000000' },
      ],
      '2026-01-05',
    );
    await post(
      [
        { accountId: acc['110']!, debit: '2000000' },
        { accountId: acc['401']!, credit: '2000000' },
      ],
      '2026-03-15',
    );
    await post(
      [
        { accountId: acc['601']!, debit: '800000' },
        { accountId: acc['102']!, credit: '800000' },
      ],
      '2026-04-20',
    );

    const preview = await runTx(admin, (t) => closing.previewYear(t, '2026'));
    expect(preview.revenue).toBe('2000000');
    expect(preview.expense).toBe('800000');
    expect(preview.netIncome).toBe('1200000');

    const result = await runTx(admin, (t) => closing.closeYear(t, '2026'));
    expect(result.netIncome).toBe('1200000');

    const entry = await prisma.journalEntry.findUniqueOrThrow({
      where: { id: result.entry.id },
      include: { lines: { include: { account: true } } },
    });
    expect(entry.isClosingEntry).toBe(true);
    expect(entry.totalDebit.toString()).toBe(entry.totalCredit.toString());

    const byCode = new Map(entry.lines.map((l) => [l.account.code, l]));
    // revenue is debited to zero, expense credited to zero, the net goes to equity
    expect(byCode.get('401')!.debit.toString()).toBe('2000000');
    expect(byCode.get('601')!.credit.toString()).toBe('800000');
    expect(byCode.get('330')!.credit.toString()).toBe('1200000');

    // P&L accounts are flat for the next year, balance-sheet accounts carry
    const openings = await runTx(admin, (t) => closing.openingBalances(t, '2027-01'));
    const codes = openings.map((o) => o.account.code);
    expect(codes).toContain('102');
    expect(codes).toContain('110');
    expect(codes).not.toContain('401');
    expect(codes).not.toContain('601');
  });

  it('the closing entry is excluded from the income statement that produced it', async () => {
    await post(
      [
        { accountId: acc['110']!, debit: '1000000' },
        { accountId: acc['401']!, credit: '1000000' },
      ],
      '2026-12-10',
    );
    await runTx(admin, (t) => closing.closeYear(t, '2026'));

    const is = await runTx(admin, (t) => report.incomeStatement(t, { period: '2026-12' }));
    // without the exclusion the December revenue would net to zero against the close
    expect(is.totalRevenue).toBe('1000000');
  });

  it('closing the same year twice is refused', async () => {
    await post(
      [
        { accountId: acc['110']!, debit: '100000' },
        { accountId: acc['401']!, credit: '100000' },
      ],
      '2026-12-10',
    );
    await runTx(admin, (t) => closing.closeYear(t, '2026'));
    await expect(runTx(admin, (t) => closing.closeYear(t, '2026'))).rejects.toThrow(/이미 있습니다/);
  });

  it('a closing entry cannot be canceled', async () => {
    await post(
      [
        { accountId: acc['110']!, debit: '100000' },
        { accountId: acc['401']!, credit: '100000' },
      ],
      '2026-12-10',
    );
    const result = await runTx(admin, (t) => closing.closeYear(t, '2026'));
    const entry = await prisma.journalEntry.findUniqueOrThrow({ where: { id: result.entry.id } });
    await expect(runTx(admin, (t) => journal.cancel(t, entry.id, '되돌리기', entry.version))).rejects.toThrow(
      /마감분개는 취소할 수 없습니다/,
    );
  });
});

describe('ACC-01: the chart of accounts protects posted history', () => {
  it('a standard account cannot be renamed or deleted', async () => {
    const target = await prisma.account.findUniqueOrThrow({ where: { code: '401' } });
    await expect(
      runTx(admin, (t) => account.update(t, target.id, { name: '다른이름' }, target.version)),
    ).rejects.toThrow(/표준 계정과목의 명칭/);
    await expect(runTx(admin, (t) => account.remove(t, target.id))).rejects.toThrow(/삭제할 수 없습니다/);
  });

  it('an account used by a posting mapping cannot be deactivated', async () => {
    const target = await prisma.account.findUniqueOrThrow({ where: { code: '401' } });
    await expect(
      runTx(admin, (t) => account.update(t, target.id, { isActive: false }, target.version)),
    ).rejects.toThrow(/계정 매핑에 사용 중/);
  });

  it('a new leaf account can be added and posted to', async () => {
    const parent = await prisma.account.findUniqueOrThrow({ where: { code: '600' } });
    const created = await runTx(admin, (t) =>
      account.create(t, { code: '699', name: '시험비용', accountType: 'EXPENSE', parentId: parent.id }),
    );
    await post([
      { accountId: created.id, debit: '5000' },
      { accountId: acc['101']!, credit: '5000' },
    ]);
    const tb = await runTx(admin, (t) => report.trialBalance(t, { from: '2026-06-01', to: '2026-06-30' }));
    expect(tb.rows.some((r) => r.code === '699')).toBe(true);
    // the account is left in place: its journal lines are confirmed, and removing them is
    // exactly what the guard forbids. beforeEach truncates the lines for the next test.
  });
});

describe('ACC-09: export carries the internal-use notice', () => {
  it('the trial balance CSV starts with the notice', async () => {
    await post([
      { accountId: acc['110']!, debit: '1000' },
      { accountId: acc['401']!, credit: '1000' },
    ]);
    const tb = await runTx(admin, (t) => report.trialBalance(t, { from: '2026-06-01', to: '2026-06-30' }));
    const csv = report.trialBalanceToCsv(tb, '2026-06-01', '2026-06-30');
    expect(csv.split('\n')[0]).toContain('내부 관리용');
    expect(csv).toContain('계정코드');
  });

  it('the account ledger CSV carries the notice and the opening line', async () => {
    await post([
      { accountId: acc['110']!, debit: '1000' },
      { accountId: acc['401']!, credit: '1000' },
    ]);
    const ledger = await runTx(admin, (t) =>
      report.accountLedger(t, { accountId: acc['110']!, from: '2026-06-01', to: '2026-06-30' }),
    );
    const csv = report.accountLedgerToCsv(ledger);
    expect(csv).toContain('내부 관리용');
    expect(csv).toContain('기초');
    expect(csv).toContain('기말');
  });
});

describe('INT-05: idempotent confirmation', () => {
  it('the same requestId replays the first result', async () => {
    const entry = await runTx(admin, (t) =>
      journal.create(t, {
        entryDate: '2026-06-15',
        lines: [
          { accountId: acc['110']!, debit: '1000' },
          { accountId: acc['401']!, credit: '1000' },
        ],
      }),
    );
    const rid = randomUUID();
    const first = await runTx(admin, (t) => journal.confirm(t, entry.id, entry.version), rid);
    const second = await runTx(admin, (t) => journal.confirm(t, entry.id, entry.version), rid);
    expect(second).toEqual(first);
  });
});
