import type { TransactionContext } from '@/server/core/context';
import { AppError } from '@/server/core/errors';
import * as stockDocument from '@/server/modules/inventory/stock-document';
import { registerHandler, type ApprovalTargetHandler } from './index';

/**
 * APV-09 / DEC-03: a stock document above the approval threshold is confirmed by the
 * approval module, not by the operator. `onApproved` runs inside the approval transaction
 * and sets `viaApproval`, which is the only way stock-document.confirm accepts a document
 * the matrix marked as requiring approval.
 */
export const stockDocumentHandler: ApprovalTargetHandler = {
  targetType: 'STOCK_DOCUMENT',
  label: '재고전표',

  async validateBeforeSubmit(ctx: TransactionContext, target) {
    // locked before read: a concurrent confirm must not be overwritten by this submit
    await ctx.tx.$queryRawUnsafe('SELECT id FROM "StockDocument" WHERE id = $1 FOR UPDATE', target.targetId);
    const doc = await ctx.tx.stockDocument.findUnique({ where: { id: target.targetId } });
    if (!doc) throw new AppError('NOT_FOUND', '재고 전표를 찾을 수 없습니다.');
    if (doc.version !== target.targetVersion) {
      throw new AppError(
        'VERSION_CONFLICT',
        '재고 전표가 변경되었습니다. 화면을 새로 고친 뒤 다시 상신하세요.',
      );
    }
    if (doc.status !== 'DRAFT') {
      throw new AppError('INVALID_TRANSITION', `현재 상태(${doc.status})의 전표는 상신할 수 없습니다.`);
    }

    await ctx.tx.stockDocument.update({
      where: { id: target.targetId },
      data: { status: 'PENDING_APPROVAL', version: { increment: 1 } },
    });
  },

  async validateBeforeCancelSubmit(ctx, target) {
    const doc = await ctx.tx.stockDocument.findUnique({ where: { id: target.targetId } });
    if (!doc) throw new AppError('NOT_FOUND', '재고 전표를 찾을 수 없습니다.');
    if (doc.status !== 'CONFIRMED') {
      throw new AppError('INVALID_TRANSITION', '확정된 전표만 취소 상신할 수 있습니다.');
    }
    if (doc.version !== target.targetVersion) {
      throw new AppError('VERSION_CONFLICT', '재고 전표가 변경되었습니다. 새로 고친 뒤 다시 상신하세요.');
    }
  },

  async currentVersion(ctx, targetId) {
    const doc = await ctx.tx.stockDocument.findUniqueOrThrow({
      where: { id: targetId },
      select: { version: true },
    });
    return doc.version;
  },

  async onApproved(ctx, target) {
    const doc = await ctx.tx.stockDocument.findUniqueOrThrow({ where: { id: target.targetId } });
    if (doc.status === 'CONFIRMED') return;
    // viaApproval is what lets confirm() past the DEC-03 gate
    await stockDocument.confirm({ ...ctx, viaApproval: true }, target.targetId, doc.version);
  },

  async onRejected(ctx, target) {
    const doc = await ctx.tx.stockDocument.findUnique({ where: { id: target.targetId } });
    if (!doc || doc.status !== 'PENDING_APPROVAL') return;
    await ctx.tx.stockDocument.update({
      where: { id: target.targetId },
      data: { status: 'DRAFT', version: { increment: 1 } },
    });
  },

  /** APV-12: the approved cancellation writes the reversing ledger rows. */
  async onCanceled(ctx, target) {
    const doc = await ctx.tx.stockDocument.findUniqueOrThrow({ where: { id: target.targetId } });
    if (doc.status === 'CANCELED') return;
    await stockDocument.cancel({ ...ctx, viaApproval: true }, target.targetId, '취소 결재 승인', doc.version);
  },
};

export function registerInventoryHandlers(): void {
  registerHandler(stockDocumentHandler);
}
