import { AppError } from '@/server/core/errors';
import * as journal from '@/server/modules/accounting/journal';
import { registerHandler, type ApprovalTargetHandler } from './index';

/**
 * DEC-03 for manual journal entries.
 *
 * The approval matrix has carried a JOURNAL rule from the beginning, but there was no
 * handler behind it and journal confirmation never consulted it, so the policy was inert:
 * a manual entry of any size confirmed straight through while the decision register said
 * otherwise. Now the rule is enforced, and this is the way through it.
 *
 * Only manual entries take this path. An entry posted from a business document carries a
 * source and is covered by that document's own approval; making it wait for a second one
 * would stop a confirmed sale from reaching the books.
 */
export const journalEntryHandler: ApprovalTargetHandler = {
  targetType: 'JOURNAL_ENTRY',
  label: '수동전표',

  async validateBeforeSubmit(ctx, target) {
    // locked before read: a concurrent confirm must not be overwritten by this submit
    await ctx.tx.$queryRawUnsafe('SELECT id FROM "JournalEntry" WHERE id = $1 FOR UPDATE', target.targetId);
    const entry = await ctx.tx.journalEntry.findUnique({ where: { id: target.targetId } });
    if (!entry) throw new AppError('NOT_FOUND', '회계전표를 찾을 수 없습니다.');
    if (entry.sourceType) {
      throw new AppError('VALIDATION', '업무전표에서 생성된 분개는 따로 결재하지 않습니다.');
    }
    if (entry.version !== target.targetVersion) {
      throw new AppError('VERSION_CONFLICT', '회계전표가 변경되었습니다. 새로 고친 뒤 다시 상신하세요.');
    }
    if (entry.status !== 'DRAFT') {
      throw new AppError('INVALID_TRANSITION', `현재 상태(${entry.status})의 전표는 상신할 수 없습니다.`);
    }
    await ctx.tx.journalEntry.update({
      where: { id: target.targetId },
      data: { status: 'PENDING_APPROVAL', version: { increment: 1 } },
    });
  },

  async validateBeforeCancelSubmit(ctx, target) {
    const entry = await ctx.tx.journalEntry.findUnique({ where: { id: target.targetId } });
    if (!entry) throw new AppError('NOT_FOUND', '회계전표를 찾을 수 없습니다.');
    if (entry.status !== 'CONFIRMED') {
      throw new AppError('INVALID_TRANSITION', '확정된 전표만 취소 상신할 수 있습니다.');
    }
    if (entry.version !== target.targetVersion) {
      throw new AppError('VERSION_CONFLICT', '회계전표가 변경되었습니다. 새로 고친 뒤 다시 상신하세요.');
    }
  },

  async currentVersion(ctx, targetId) {
    const entry = await ctx.tx.journalEntry.findUniqueOrThrow({
      where: { id: targetId },
      select: { version: true },
    });
    return entry.version;
  },

  async onApproved(ctx, target) {
    const entry = await ctx.tx.journalEntry.findUniqueOrThrow({ where: { id: target.targetId } });
    if (entry.status === 'CONFIRMED') return;
    await journal.confirm({ ...ctx, viaApproval: true }, target.targetId, entry.version);
  },

  async onRejected(ctx, target) {
    const entry = await ctx.tx.journalEntry.findUnique({ where: { id: target.targetId } });
    if (!entry || entry.status !== 'PENDING_APPROVAL') return;
    await ctx.tx.journalEntry.update({
      where: { id: target.targetId },
      data: { status: 'DRAFT', version: { increment: 1 } },
    });
  },

  async onCanceled(ctx, target) {
    const entry = await ctx.tx.journalEntry.findUniqueOrThrow({ where: { id: target.targetId } });
    if (entry.status === 'CANCELED') return;
    await journal.cancel({ ...ctx, viaApproval: true }, target.targetId, '취소 결재 승인', entry.version);
  },
};

export function registerAccountingHandlers(): void {
  registerHandler(journalEntryHandler);
}
