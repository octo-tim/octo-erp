import type { TransactionContext } from '@/server/core/context';
import { AppError } from '@/server/core/errors';
import { requirePermission, requirePermissionUnlessApproval } from '@/server/modules/rbac/service';
import * as audit from '@/server/modules/audit/service';
import * as period from './period';
import * as matrix from '@/server/modules/approval/matrix';
import * as approvalState from '@/server/modules/documents/approval-state';
import { nextDocNo, DOC_TYPES } from '@/server/modules/numbering/service';
import { idempotent } from '@/server/core/idempotency';
import { assertVersion } from '@/server/core/state-machine';
import { amount, cmp, D, ZERO } from '@/lib/money';
import { businessDate, periodKey as periodOf, toDateOnly } from '@/lib/dates';

/**
 * ACC-02 / ACC-04 / ACC-08 — journal entries.
 *
 * The two rules that make the books trustworthy live here: a line is one-sided and
 * non-zero, and an entry's debits equal its credits. Both are checked before anything is
 * written, so an unbalanced entry cannot exist even as a draft.
 *
 * A confirmed entry is never edited. A correction is a reversing entry that points back
 * at the original (INT-07), dated per ADR-0006.
 */

export const ENTRY_TYPES = ['TRANSFER', 'RECEIPT', 'PAYMENT'] as const;
export type EntryType = (typeof ENTRY_TYPES)[number];
export const ENTRY_TYPE_LABEL: Record<EntryType, string> = {
  TRANSFER: '대체',
  RECEIPT: '입금',
  PAYMENT: '출금',
};

export interface LineInput {
  accountId: string;
  debit?: string;
  credit?: string;
  description?: string;
  divisionId?: string;
  partnerId?: string;
}

export interface EntryInput {
  entryType?: EntryType;
  entryDate?: string;
  description?: string;
  lines: LineInput[];
}

export interface Totals {
  debit: string;
  credit: string;
}

/**
 * The balance rule. Returns the totals so the caller can store them; throws with every
 * problem at once rather than one at a time, because an operator fixing a voucher wants
 * the whole list.
 */
export function validateLines(lines: LineInput[]): Totals {
  if (lines.length < 2) {
    throw new AppError('VALIDATION', '분개는 차변·대변 각각 한 줄 이상 필요합니다.');
  }

  const errors: string[] = [];
  let debit = ZERO;
  let credit = ZERO;

  for (const [i, l] of lines.entries()) {
    const label = `${i + 1}행`;
    const d = D(l.debit ?? 0);
    const c = D(l.credit ?? 0);

    if (!l.accountId) errors.push(`${label}: 계정과목을 선택하세요.`);
    if (d.isNegative() || c.isNegative()) errors.push(`${label}: 금액은 0 이상이어야 합니다.`);
    if (d.gt(0) && c.gt(0)) errors.push(`${label}: 차변과 대변에 동시에 금액을 넣을 수 없습니다.`);
    if (d.isZero() && c.isZero()) errors.push(`${label}: 금액이 0인 행은 저장할 수 없습니다.`);

    debit = debit.plus(d);
    credit = credit.plus(c);
  }

  if (errors.length) throw new AppError('VALIDATION', errors.join('\n'), { errors });

  if (cmp(debit, credit) !== 0) {
    throw new AppError(
      'UNBALANCED_JOURNAL',
      `차변 합계(${debit.toFixed(0)})와 대변 합계(${credit.toFixed(0)})가 일치하지 않습니다. 차액 ${debit.minus(credit).abs().toFixed(0)}원.`,
      { debit: debit.toFixed(0), credit: credit.toFixed(0) },
    );
  }
  if (debit.isZero()) {
    throw new AppError('VALIDATION', '합계가 0인 분개는 저장할 수 없습니다.');
  }

  return { debit: amount(debit), credit: amount(credit) };
}

async function assertPostable(ctx: TransactionContext, lines: LineInput[]): Promise<void> {
  const ids = [...new Set(lines.map((l) => l.accountId).filter(Boolean))];
  const accounts = await ctx.tx.account.findMany({
    where: { id: { in: ids } },
    select: { id: true, code: true, name: true, isActive: true, isPostable: true },
  });
  const byId = new Map(accounts.map((a) => [a.id, a]));

  const errors: string[] = [];
  for (const [i, l] of lines.entries()) {
    const a = byId.get(l.accountId);
    if (!a) errors.push(`${i + 1}행: 존재하지 않는 계정과목입니다.`);
    else if (!a.isActive) errors.push(`${i + 1}행: 사용중지된 계정과목입니다(${a.name}).`);
    else if (!a.isPostable)
      errors.push(`${i + 1}행: 하위 계정이 있는 계정에는 전기할 수 없습니다(${a.name}).`);
  }
  if (errors.length) throw new AppError('VALIDATION', errors.join('\n'), { errors });
}

// ── manual entries (ACC-02) ──

export async function create(ctx: TransactionContext, input: EntryInput) {
  requirePermission(ctx.actor, 'accounting.write');

  const entryDate = input.entryDate ?? businessDate(ctx.now);
  await period.assertOpen(ctx, entryDate);
  const totals = validateLines(input.lines);
  await assertPostable(ctx, input.lines);

  const p = await period.ensure(ctx, periodOf(entryDate));
  const entryNo = await nextDocNo(ctx, DOC_TYPES.JOURNAL, entryDate);

  const entry = await ctx.tx.journalEntry.create({
    data: {
      entryNo,
      entryType: input.entryType ?? 'TRANSFER',
      entryDate: toDateOnly(entryDate),
      periodId: p.id,
      status: 'DRAFT',
      description: input.description ?? null,
      totalDebit: totals.debit,
      totalCredit: totals.credit,
      createdById: ctx.actor.userId,
      lines: { create: buildLineData(input.lines) },
    },
    include: { lines: true },
  });

  await audit.record(ctx, {
    action: 'journal.create',
    entityType: 'JournalEntry',
    entityId: entry.id,
    after: { entryNo, entryDate, totalDebit: totals.debit, lines: input.lines.length },
  });
  return entry;
}

export async function update(ctx: TransactionContext, id: string, input: EntryInput, version: number) {
  requirePermission(ctx.actor, 'accounting.write');

  const before = await ctx.tx.journalEntry.findUniqueOrThrow({ where: { id } });
  assertVersion('회계전표', before.version, version);
  if (before.status !== 'DRAFT') {
    throw new AppError('IMMUTABLE', '작성 중인 전표만 수정할 수 있습니다. 확정 전표는 역분개로 정정하세요.', {
      status: before.status,
    });
  }
  if (before.sourceType) {
    throw new AppError('IMMUTABLE', '업무전표에서 자동 생성된 분개는 직접 수정할 수 없습니다.');
  }

  const entryDate = input.entryDate ?? before.entryDate.toISOString().slice(0, 10);
  await period.assertOpen(ctx, entryDate);
  const totals = validateLines(input.lines);
  await assertPostable(ctx, input.lines);

  const p = await period.ensure(ctx, periodOf(entryDate));
  await ctx.tx.journalLine.deleteMany({ where: { entryId: id } });

  const after = await ctx.tx.journalEntry.update({
    where: { id },
    data: {
      entryType: input.entryType ?? before.entryType,
      entryDate: toDateOnly(entryDate),
      periodId: p.id,
      description: input.description ?? null,
      totalDebit: totals.debit,
      totalCredit: totals.credit,
      version: { increment: 1 },
      lines: { create: buildLineData(input.lines) },
    },
    include: { lines: true },
  });

  await audit.record(ctx, {
    action: 'journal.update',
    entityType: 'JournalEntry',
    entityId: id,
    before: { totalDebit: before.totalDebit.toString(), entryDate: before.entryDate.toISOString() },
    after: { totalDebit: totals.debit, entryDate },
  });
  return after;
}

export async function confirm(ctx: TransactionContext, id: string, version: number) {
  requirePermissionUnlessApproval(ctx, 'accounting.confirm');

  return idempotent(ctx, `journal.confirm:${id}`, async () => {
    await ctx.tx.$queryRawUnsafe('SELECT id FROM "JournalEntry" WHERE id = $1 FOR UPDATE', id);

    const entry = await ctx.tx.journalEntry.findUniqueOrThrow({
      where: { id },
      include: { lines: true },
    });
    assertVersion('회계전표', entry.version, version);
    if (entry.status !== 'DRAFT' && entry.status !== 'PENDING_APPROVAL') {
      throw new AppError('INVALID_TRANSITION', `현재 상태(${entry.status})의 전표는 확정할 수 없습니다.`);
    }

    const entryDate = entry.entryDate.toISOString().slice(0, 10);
    await period.assertOpen(ctx, entryDate);

    /**
     * DEC-03. The approval matrix has carried a JOURNAL rule since the seed, but nothing
     * read it: a manual entry over the threshold confirmed straight through, so the policy
     * said one thing and the system did another. Manual entries are exactly the ones the
     * rule is for — an automatic entry comes from a business document that was itself
     * approved, and carries a source.
     */
    if (!entry.sourceType) {
      const total = entry.lines.reduce((acc, l) => acc.plus(D(l.debit)), ZERO);
      const req = await matrix.requirement(ctx, 'JOURNAL', amount(total), entryDate);
      if (req.required && !ctx.viaApproval) {
        throw new AppError('APPROVAL_REQUIRED', `${req.reason}. 결재 상신 후 승인되면 확정됩니다.`, {
          policyVersionId: req.policyVersionId,
        });
      }
    }

    // the balance is re-checked at confirmation: the lines may have been edited since
    validateLines(
      entry.lines.map((l) => ({
        accountId: l.accountId,
        debit: l.debit.toString(),
        credit: l.credit.toString(),
      })),
    );

    const updated = await ctx.tx.journalEntry.update({
      where: { id },
      data: {
        status: 'CONFIRMED',
        confirmedAt: ctx.now,
        confirmedById: ctx.actor.userId,
        version: { increment: 1 },
      },
    });

    await audit.record(ctx, {
      action: 'journal.confirm',
      entityType: 'JournalEntry',
      entityId: id,
      before: { status: entry.status },
      after: { status: 'CONFIRMED', entryNo: entry.entryNo },
    });
    return { id: updated.id, entryNo: updated.entryNo, status: updated.status };
  });
}

/**
 * ACC-08 / INT-07: cancelling a confirmed entry does not edit it. It marks it canceled and
 * writes a reversing entry whose lines are the original's with the sides swapped.
 */
export async function cancel(ctx: TransactionContext, id: string, reason: string, version: number) {
  requirePermissionUnlessApproval(ctx, 'accounting.cancel');
  if (reason.trim().length < 2) throw new AppError('VALIDATION', '취소 사유를 입력하세요.');

  return idempotent(ctx, `journal.cancel:${id}`, async () => {
    await ctx.tx.$queryRawUnsafe('SELECT id FROM "JournalEntry" WHERE id = $1 FOR UPDATE', id);

    const entry = await ctx.tx.journalEntry.findUniqueOrThrow({
      where: { id },
      include: { lines: { orderBy: { lineNo: 'asc' } } },
    });
    assertVersion('회계전표', entry.version, version);
    if (entry.status === 'CANCELED') throw new AppError('INVALID_TRANSITION', '이미 취소된 전표입니다.');
    if (entry.isClosingEntry) {
      throw new AppError('CANCEL_BLOCKED', '마감분개는 취소할 수 없습니다. 회계 마감을 해제하세요.');
    }

    let reversalId: string | null = null;
    if (entry.status === 'CONFIRMED') {
      reversalId = (await reverse(ctx, entry, reason)).id;
    } else {
      // a draft is only cancellable while its period is open
      await period.assertOpen(ctx, entry.entryDate.toISOString().slice(0, 10));
    }

    const updated = await ctx.tx.journalEntry.update({
      where: { id },
      data: {
        status: 'CANCELED',
        canceledAt: ctx.now,
        cancelReason: reason,
        version: { increment: 1 },
      },
    });

    await audit.record(ctx, {
      action: 'journal.cancel',
      entityType: 'JournalEntry',
      entityId: id,
      before: { status: entry.status },
      after: { status: 'CANCELED', reason, reversalId },
    });
    return { id: updated.id, entryNo: updated.entryNo, status: updated.status, reversalId };
  });
}

interface EntryWithLines {
  id: string;
  entryNo: string;
  entryType: string;
  entryDate: Date;
  description: string | null;
  sourceType: string | null;
  sourceId: string | null;
  postingRuleVersionId: string | null;
  lines: {
    lineNo: number;
    accountId: string;
    debit: unknown;
    credit: unknown;
    description: string | null;
    divisionId: string | null;
    partnerId: string | null;
  }[];
}

/** Writes the mirror entry. Exported so the source-posting path can reuse it. */
async function reverse(ctx: TransactionContext, entry: EntryWithLines, reason: string) {
  const date = await period.reversalDate(ctx, entry.entryDate);
  const dateStr = date.toISOString().slice(0, 10);
  const p = await period.ensure(ctx, periodOf(dateStr));
  const entryNo = await nextDocNo(ctx, DOC_TYPES.JOURNAL, dateStr);

  let debit = ZERO;
  let credit = ZERO;
  for (const l of entry.lines) {
    debit = debit.plus(D(l.credit as never));
    credit = credit.plus(D(l.debit as never));
  }

  const reversal = await ctx.tx.journalEntry.create({
    data: {
      entryNo,
      entryType: entry.entryType,
      entryDate: date,
      periodId: p.id,
      status: 'CONFIRMED',
      description: `역분개: ${entry.entryNo} (${reason})`,
      // the reversal carries the same source, one version on, so the pair is traceable
      ...(entry.sourceType
        ? { sourceType: entry.sourceType, sourceId: entry.sourceId, sourceVersion: 2 }
        : {}),
      postingRuleVersionId: entry.postingRuleVersionId,
      reversalOfId: entry.id,
      totalDebit: amount(debit),
      totalCredit: amount(credit),
      confirmedAt: ctx.now,
      confirmedById: ctx.actor.userId,
      createdById: ctx.actor.userId,
      lines: {
        create: entry.lines.map((l) => ({
          lineNo: l.lineNo,
          accountId: l.accountId,
          // sides swapped: this is what makes the pair net to zero
          debit: amount(D(l.credit as never)),
          credit: amount(D(l.debit as never)),
          description: l.description,
          divisionId: l.divisionId,
          partnerId: l.partnerId,
        })),
      },
    },
  });

  await audit.record(ctx, {
    action: 'journal.reverse',
    entityType: 'JournalEntry',
    entityId: reversal.id,
    after: { entryNo: reversal.entryNo, reversalOf: entry.entryNo, entryDate: dateStr },
  });
  return reversal;
}

// ── ACC-03: posting from a business document ──

export interface SourceRef {
  sourceType: string;
  sourceId: string;
}

/**
 * Posts an already-built set of lines against a source document. The unique index on
 * (sourceType, sourceId, sourceVersion) is what makes a repeated call a loud failure
 * rather than a duplicate entry (INT-05).
 */
export async function postFromSource(
  ctx: TransactionContext,
  input: {
    source: SourceRef;
    entryDate: string;
    entryType?: EntryType;
    description?: string;
    lines: LineInput[];
    postingRuleVersionId?: string;
  },
) {
  await period.assertOpen(ctx, input.entryDate);
  const totals = validateLines(input.lines);
  await assertPostable(ctx, input.lines);

  const p = await period.ensure(ctx, periodOf(input.entryDate));
  const entryNo = await nextDocNo(ctx, DOC_TYPES.JOURNAL, input.entryDate);

  try {
    const entry = await ctx.tx.journalEntry.create({
      data: {
        entryNo,
        entryType: input.entryType ?? 'TRANSFER',
        entryDate: toDateOnly(input.entryDate),
        periodId: p.id,
        status: 'CONFIRMED',
        description: input.description ?? null,
        sourceType: input.source.sourceType,
        sourceId: input.source.sourceId,
        sourceVersion: 1,
        postingRuleVersionId: input.postingRuleVersionId ?? null,
        totalDebit: totals.debit,
        totalCredit: totals.credit,
        confirmedAt: ctx.now,
        confirmedById: ctx.actor.userId,
        createdById: ctx.actor.userId,
        lines: { create: buildLineData(input.lines) },
      },
      include: { lines: true },
    });

    await audit.record(ctx, {
      action: 'journal.postFromSource',
      entityType: 'JournalEntry',
      entityId: entry.id,
      after: {
        entryNo,
        sourceType: input.source.sourceType,
        sourceId: input.source.sourceId,
        totalDebit: totals.debit,
      },
    });
    return entry;
  } catch (e) {
    if ((e as { code?: string }).code === 'P2002') {
      throw new AppError(
        'DUPLICATE_EFFECT',
        '이미 분개가 생성된 전표입니다. 새로 고친 뒤 상태를 확인하세요.',
        { ...input.source },
      );
    }
    throw e;
  }
}

/** INT-07: the accounting half of cancelling a business document. */
export async function reverseFromSource(
  ctx: TransactionContext,
  source: SourceRef,
  reason: string,
): Promise<{ id: string; entryNo: string } | null> {
  // the existing-reversal check comes FIRST: after a successful reverse the original is
  // CANCELED, so looking for a confirmed original would report "nothing to do" on a retry
  // and the caller would think the reversal never happened.
  const already = await ctx.tx.journalEntry.findFirst({ where: { ...source, sourceVersion: 2 } });
  if (already) return { id: already.id, entryNo: already.entryNo };

  const original = await ctx.tx.journalEntry.findFirst({
    where: { ...source, sourceVersion: 1, status: 'CONFIRMED' },
    include: { lines: { orderBy: { lineNo: 'asc' } } },
  });
  if (!original) return null;

  const reversal = await reverse(ctx, original, reason);
  await ctx.tx.journalEntry.update({
    where: { id: original.id },
    data: { status: 'CANCELED', canceledAt: ctx.now, cancelReason: reason, version: { increment: 1 } },
  });
  return { id: reversal.id, entryNo: reversal.entryNo };
}

// ── read ──

export async function list(
  ctx: TransactionContext,
  input: {
    from?: string;
    to?: string;
    status?: string;
    entryType?: string;
    accountId?: string;
    divisionId?: string;
    q?: string;
    skip: number;
    take: number;
  },
) {
  requirePermission(ctx.actor, 'accounting.read');
  const scope = ctx.actor.isAdmin ? undefined : ctx.actor.divisionIds;

  const where = {
    ...(input.status ? { status: input.status } : {}),
    ...(input.entryType ? { entryType: input.entryType } : {}),
    ...(input.from || input.to
      ? {
          entryDate: {
            ...(input.from ? { gte: toDateOnly(input.from) } : {}),
            ...(input.to ? { lte: toDateOnly(input.to) } : {}),
          },
        }
      : {}),
    ...(input.q
      ? {
          OR: [
            { entryNo: { contains: input.q, mode: 'insensitive' as const } },
            { description: { contains: input.q, mode: 'insensitive' as const } },
          ],
        }
      : {}),
    ...(input.accountId || input.divisionId || scope
      ? {
          lines: {
            some: {
              ...(input.accountId ? { accountId: input.accountId } : {}),
              // INT-12: a division-scoped user sees only entries that touch their divisions
              ...(input.divisionId
                ? { divisionId: input.divisionId }
                : scope
                  ? { OR: [{ divisionId: { in: scope } }, { divisionId: null }] }
                  : {}),
            },
          },
        }
      : {}),
  };

  const [rows, total] = await Promise.all([
    ctx.tx.journalEntry.findMany({
      where,
      include: { _count: { select: { lines: true } } },
      orderBy: [{ entryDate: 'desc' }, { entryNo: 'desc' }],
      skip: input.skip,
      take: input.take,
    }),
    ctx.tx.journalEntry.count({ where }),
  ]);
  return { rows, total };
}

export async function detail(ctx: TransactionContext, id: string) {
  requirePermission(ctx.actor, 'accounting.read');
  const entry = await ctx.tx.journalEntry.findUnique({
    where: { id },
    include: {
      period: { select: { periodKey: true, status: true } },
      reversalOf: { select: { id: true, entryNo: true } },
      reversedBy: { select: { id: true, entryNo: true } },
      lines: {
        orderBy: { lineNo: 'asc' },
        include: {
          account: { select: { id: true, code: true, name: true } },
          division: { select: { id: true, name: true } },
          partner: { select: { id: true, name: true } },
        },
      },
    },
  });
  if (!entry) throw new AppError('NOT_FOUND', '회계전표를 찾을 수 없습니다.');

  // DEC-03: a manual entry over the threshold is confirmed by its approval, so the screen
  // has to know that before it offers a confirm button
  const total = amount(entry.lines.reduce((acc, l) => acc.plus(D(l.debit)), ZERO));
  const req = entry.sourceType
    ? null
    : await matrix.requirement(ctx, 'JOURNAL', total, entry.entryDate.toISOString().slice(0, 10));
  const approvalInfo = await approvalState.approvalStateOf(ctx, 'JOURNAL_ENTRY', id);

  return {
    ...entry,
    approvalRequired: req?.required ?? false,
    approvalReason: req?.reason ?? '',
    ...approvalInfo,
  };
}

// ── helpers ──

function buildLineData(lines: LineInput[]) {
  return lines.map((l, i) => ({
    lineNo: i + 1,
    accountId: l.accountId,
    debit: amount(l.debit ?? 0),
    credit: amount(l.credit ?? 0),
    description: l.description ?? null,
    divisionId: l.divisionId ?? null,
    partnerId: l.partnerId ?? null,
  }));
}
