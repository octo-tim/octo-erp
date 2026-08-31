import { z } from 'zod';
import { permissionProcedure, readTx, router, tx } from '@/server/api/trpc';
import * as account from '@/server/modules/accounting/account';
import * as journal from '@/server/modules/accounting/journal';
import * as period from '@/server/modules/accounting/period';
import * as postingRule from '@/server/modules/accounting/posting-rule';
import * as report from '@/server/modules/accounting/report';
import * as closing from '@/server/modules/accounting/closing';
import * as documents from '@/server/modules/documents/service';
import * as documentSubmit from '@/server/modules/documents/submit';
import {
  amountString,
  cuid,
  dateString,
  paging,
  periodString,
  requestId,
  searchText,
  skipTake,
} from '@/server/api/schemas/common';

const accountType = z.enum(['ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE']);
const entryType = z.enum(['TRANSFER', 'RECEIPT', 'PAYMENT']);

const lineInput = z.object({
  accountId: cuid,
  debit: amountString.optional(),
  credit: amountString.optional(),
  description: z.string().max(200).optional(),
  divisionId: cuid.optional(),
  partnerId: cuid.optional(),
});

const entryInput = z.object({
  entryType: entryType.optional(),
  entryDate: dateString.optional(),
  description: z.string().max(500).optional(),
  lines: z.array(lineInput).min(2).max(200),
});

const templateLine = z.object({
  slot: z.string().min(1).max(40),
  side: z.enum(['DEBIT', 'CREDIT']),
  amountKey: z.string().min(1).max(40),
  description: z.string().max(100).optional(),
});

export const accountingRouter = router({
  // ── ACC-01 chart of accounts ──

  accounts: permissionProcedure('accounting.read')
    .input(z.object({ q: searchText, activeOnly: z.boolean().default(false) }))
    .query(({ ctx, input }) => readTx(ctx, (t) => account.list(t, input))),

  postableAccounts: permissionProcedure('accounting.read').query(({ ctx }) =>
    readTx(ctx, (t) => account.postable(t)),
  ),

  createAccount: permissionProcedure('accounting.rules')
    .input(
      z.object({
        code: z.string().min(3).max(8),
        name: z.string().min(1).max(60),
        accountType,
        parentId: cuid.optional(),
        note: z.string().max(300).optional(),
        requestId,
      }),
    )
    .mutation(({ ctx, input }) =>
      tx(
        ctx,
        (t) => {
          const { requestId: _rid, ...data } = input;
          return account.create(t, data);
        },
        input.requestId,
      ),
    ),

  updateAccount: permissionProcedure('accounting.rules')
    .input(
      z.object({
        id: cuid,
        version: z.number().int(),
        name: z.string().min(1).max(60).optional(),
        note: z.string().max(300).optional(),
        isActive: z.boolean().optional(),
        sortOrder: z.number().int().optional(),
        requestId,
      }),
    )
    .mutation(({ ctx, input }) =>
      tx(
        ctx,
        (t) => {
          const { id, version, requestId: _rid, ...data } = input;
          return account.update(t, id, data, version);
        },
        input.requestId,
      ),
    ),

  deleteAccount: permissionProcedure('accounting.rules')
    .input(z.object({ id: cuid, requestId }))
    .mutation(({ ctx, input }) => tx(ctx, (t) => account.remove(t, input.id), input.requestId)),

  // ── ACC-03 slot mapping and posting rules ──

  accountMappings: permissionProcedure('accounting.read').query(({ ctx }) =>
    readTx(ctx, (t) => account.mappings(t)),
  ),

  setAccountMapping: permissionProcedure('accounting.rules')
    .input(z.object({ slot: z.string().min(1).max(40), accountId: cuid, requestId }))
    .mutation(({ ctx, input }) =>
      tx(ctx, (t) => account.setMapping(t, input.slot, input.accountId), input.requestId),
    ),

  postingRules: permissionProcedure('accounting.read').query(({ ctx }) =>
    readTx(ctx, (t) => postingRule.list(t)),
  ),

  publishPostingRule: permissionProcedure('accounting.rules')
    .input(
      z.object({
        code: z.string().min(1).max(40),
        effectiveFrom: dateString,
        template: z.array(templateLine).min(2).max(20),
        note: z.string().max(300).optional(),
        requestId,
      }),
    )
    .mutation(({ ctx, input }) =>
      tx(
        ctx,
        (t) => {
          const { requestId: _rid, ...data } = input;
          return postingRule.publish(t, data);
        },
        input.requestId,
      ),
    ),

  previewPostingRule: permissionProcedure('accounting.read')
    .input(
      z.object({
        code: z.string().min(1).max(40),
        onDate: dateString,
        amounts: z.record(z.string(), amountString),
      }),
    )
    .query(({ ctx, input }) =>
      readTx(ctx, (t) => postingRule.preview(t, input.code, input.onDate, input.amounts)),
    ),

  // ── ACC-02 journal entries ──

  entries: permissionProcedure('accounting.read')
    .input(
      paging.extend({
        from: dateString.optional(),
        to: dateString.optional(),
        status: z.string().optional(),
        entryType: entryType.optional(),
        accountId: cuid.optional(),
        divisionId: cuid.optional(),
        q: searchText,
      }),
    )
    .query(({ ctx, input }) =>
      readTx(ctx, async (t) => {
        const { rows, total } = await journal.list(t, { ...input, ...skipTake(input) });
        return { rows, total, page: input.page, pageSize: input.pageSize };
      }),
    ),

  // UIX-03: server-side export — calls journal.list itself, same permission and filters.
  entriesCsv: permissionProcedure('accounting.read')
    .input(
      z.object({
        from: dateString.optional(),
        to: dateString.optional(),
        status: z.string().optional(),
        entryType: entryType.optional(),
        accountId: cuid.optional(),
        divisionId: cuid.optional(),
        q: searchText,
      }),
    )
    .query(({ ctx, input }) => readTx(ctx, (t) => journal.listCsv(t, input))),

  entry: permissionProcedure('accounting.read')
    .input(z.object({ id: cuid }))
    .query(({ ctx, input }) => readTx(ctx, (t) => journal.detail(t, input.id))),

  createEntry: permissionProcedure('accounting.write')
    .input(entryInput.extend({ requestId }))
    .mutation(({ ctx, input }) =>
      tx(
        ctx,
        (t) => {
          const { requestId: _rid, ...data } = input;
          return journal.create(t, data);
        },
        input.requestId,
      ),
    ),

  updateEntry: permissionProcedure('accounting.write')
    .input(entryInput.extend({ id: cuid, version: z.number().int(), requestId }))
    .mutation(({ ctx, input }) =>
      tx(
        ctx,
        (t) => {
          const { id, version, requestId: _rid, ...data } = input;
          return journal.update(t, id, data, version);
        },
        input.requestId,
      ),
    ),

  confirmEntry: permissionProcedure('accounting.confirm')
    .input(z.object({ id: cuid, version: z.number().int(), requestId }))
    .mutation(({ ctx, input }) =>
      tx(
        ctx,
        (t) => documents.confirmBusinessDocument(t, { type: 'JOURNAL_ENTRY', ...input }),
        input.requestId,
      ),
    ),

  cancelEntry: permissionProcedure('accounting.cancel')
    .input(z.object({ id: cuid, reason: z.string().min(2).max(200), version: z.number().int(), requestId }))
    .mutation(({ ctx, input }) =>
      tx(
        ctx,
        (t) => documents.cancelBusinessDocument(t, { type: 'JOURNAL_ENTRY', ...input }),
        input.requestId,
      ),
    ),

  submitEntryForApproval: permissionProcedure('accounting.write')
    .input(
      z.object({
        id: cuid,
        version: z.number().int(),
        note: z.string().max(500).optional(),
        lineTemplateId: cuid.optional(),
        requestId,
      }),
    )
    .mutation(({ ctx, input }) =>
      tx(
        ctx,
        (t) => documentSubmit.submitForApproval(t, { type: 'JOURNAL_ENTRY', ...input }),
        input.requestId,
      ),
    ),

  submitEntryCancellation: permissionProcedure('accounting.cancel')
    .input(z.object({ id: cuid, reason: z.string().min(2).max(200), requestId }))
    .mutation(({ ctx, input }) =>
      tx(
        ctx,
        (t) => documentSubmit.submitCancellation(t, { type: 'JOURNAL_ENTRY', ...input }),
        input.requestId,
      ),
    ),

  // ── ACC-04 ledgers ──

  accountLedger: permissionProcedure('accounting.read')
    .input(z.object({ accountId: cuid, from: dateString, to: dateString, divisionId: cuid.optional() }))
    .query(({ ctx, input }) => readTx(ctx, (t) => report.accountLedger(t, input))),

  trialBalance: permissionProcedure('accounting.read')
    .input(
      z.object({
        from: dateString,
        to: dateString,
        divisionId: cuid.optional(),
        hideZero: z.boolean().default(true),
      }),
    )
    .query(({ ctx, input }) => readTx(ctx, (t) => report.trialBalance(t, input))),

  // ── ACC-05/06/07 statements ──

  incomeStatement: permissionProcedure('accounting.read')
    .input(
      z.object({
        period: periodString,
        comparePeriod: periodString.optional(),
        divisionId: cuid.optional(),
      }),
    )
    .query(({ ctx, input }) => readTx(ctx, (t) => report.incomeStatement(t, input))),

  incomeByDivision: permissionProcedure('accounting.read')
    .input(z.object({ period: periodString }))
    .query(({ ctx, input }) => readTx(ctx, (t) => report.incomeByDivision(t, input.period))),

  balanceSheet: permissionProcedure('accounting.read')
    .input(z.object({ asOf: dateString, divisionId: cuid.optional() }))
    .query(({ ctx, input }) => readTx(ctx, (t) => report.balanceSheet(t, input))),

  // ── ACC-09 export ──

  trialBalanceCsv: permissionProcedure('accounting.export')
    .input(z.object({ from: dateString, to: dateString, divisionId: cuid.optional() }))
    .query(({ ctx, input }) =>
      readTx(ctx, async (t) => ({
        csv: report.trialBalanceToCsv(
          await report.trialBalance(t, { ...input, hideZero: true }),
          input.from,
          input.to,
        ),
      })),
    ),

  accountLedgerCsv: permissionProcedure('accounting.export')
    .input(z.object({ accountId: cuid, from: dateString, to: dateString, divisionId: cuid.optional() }))
    .query(({ ctx, input }) =>
      readTx(ctx, async (t) => ({
        csv: report.accountLedgerToCsv(await report.accountLedger(t, input)),
      })),
    ),

  // ── ACC-08 periods and closing ──

  periods: permissionProcedure('accounting.read').query(({ ctx }) => readTx(ctx, (t) => period.list(t))),

  closeMonth: permissionProcedure('accounting.close')
    .input(z.object({ periodKey: periodString, requestId }))
    .mutation(({ ctx, input }) => tx(ctx, (t) => closing.closeMonth(t, input.periodKey), input.requestId)),

  reopenPeriod: permissionProcedure('period.reopen')
    .input(z.object({ periodKey: periodString, reason: z.string().min(5).max(200), requestId }))
    .mutation(({ ctx, input }) =>
      tx(ctx, (t) => period.reopen(t, input.periodKey, input.reason), input.requestId),
    ),

  yearClosePreview: permissionProcedure('accounting.read')
    .input(z.object({ year: z.string().regex(/^\d{4}$/, '연도는 YYYY 형식이어야 합니다.') }))
    .query(({ ctx, input }) => readTx(ctx, (t) => closing.previewYear(t, input.year))),

  closeYear: permissionProcedure('accounting.close')
    .input(z.object({ year: z.string().regex(/^\d{4}$/), requestId }))
    .mutation(({ ctx, input }) => tx(ctx, (t) => closing.closeYear(t, input.year), input.requestId)),

  closingRuns: permissionProcedure('accounting.read').query(({ ctx }) => readTx(ctx, (t) => closing.runs(t))),

  openingBalances: permissionProcedure('accounting.read')
    .input(z.object({ periodKey: periodString }))
    .query(({ ctx, input }) => readTx(ctx, (t) => closing.openingBalances(t, input.periodKey))),
});
