import { AppError } from '@/server/core/errors';
import * as salesDocument from '@/server/modules/sales/sales-document';
import * as purchase from '@/server/modules/sales/purchase';
import { registerHandler, type ApprovalTargetHandler } from './index';

/**
 * APV-09 / DEC-03: sales and purchase documents above the approval threshold, and purchase
 * requests, which always need approval. Every callback runs inside the approval
 * transaction, so a failure in the business effect rolls the approval back with it.
 */

export const salesDocumentHandler: ApprovalTargetHandler = {
  targetType: 'SALES_DOCUMENT',
  label: '매출전표',

  async validateBeforeSubmit(ctx, target) {
    const doc = await ctx.tx.salesDocument.findUnique({ where: { id: target.targetId } });
    if (!doc) throw new AppError('NOT_FOUND', '매출전표를 찾을 수 없습니다.');
    if (doc.version !== target.targetVersion) {
      throw new AppError('VERSION_CONFLICT', '매출전표가 변경되었습니다. 새로 고친 뒤 다시 상신하세요.');
    }
    if (doc.status !== 'DRAFT') {
      throw new AppError('INVALID_TRANSITION', `현재 상태(${doc.status})의 전표는 상신할 수 없습니다.`);
    }
    await ctx.tx.salesDocument.update({
      where: { id: target.targetId },
      data: { status: 'PENDING_APPROVAL', version: { increment: 1 } },
    });
  },

  async validateBeforeCancelSubmit(ctx, target) {
    const doc = await ctx.tx.salesDocument.findUnique({ where: { id: target.targetId } });
    if (!doc) throw new AppError('NOT_FOUND', '매출전표를 찾을 수 없습니다.');
    if (doc.status !== 'CONFIRMED') {
      throw new AppError('INVALID_TRANSITION', '확정된 전표만 취소 상신할 수 있습니다.');
    }
    if (doc.version !== target.targetVersion) {
      throw new AppError('VERSION_CONFLICT', '매출전표가 변경되었습니다. 새로 고친 뒤 다시 상신하세요.');
    }
  },

  async currentVersion(ctx, targetId) {
    const doc = await ctx.tx.salesDocument.findUniqueOrThrow({
      where: { id: targetId },
      select: { version: true },
    });
    return doc.version;
  },

  async onApproved(ctx, target) {
    const doc = await ctx.tx.salesDocument.findUniqueOrThrow({ where: { id: target.targetId } });
    if (doc.status === 'CONFIRMED') return;
    await salesDocument.confirm({ ...ctx, viaApproval: true }, target.targetId, doc.version);
  },

  async onRejected(ctx, target) {
    const doc = await ctx.tx.salesDocument.findUnique({ where: { id: target.targetId } });
    if (!doc || doc.status !== 'PENDING_APPROVAL') return;
    await ctx.tx.salesDocument.update({
      where: { id: target.targetId },
      data: { status: 'DRAFT', version: { increment: 1 } },
    });
  },

  async onCanceled(ctx, target) {
    const doc = await ctx.tx.salesDocument.findUniqueOrThrow({ where: { id: target.targetId } });
    if (doc.status === 'CANCELED') return;
    await salesDocument.cancel({ ...ctx, viaApproval: true }, target.targetId, '취소 결재 승인', doc.version);
  },
};

export const purchaseDocumentHandler: ApprovalTargetHandler = {
  targetType: 'PURCHASE_DOCUMENT',
  label: '매입전표',

  async validateBeforeSubmit(ctx, target) {
    const doc = await ctx.tx.purchaseDocument.findUnique({ where: { id: target.targetId } });
    if (!doc) throw new AppError('NOT_FOUND', '매입전표를 찾을 수 없습니다.');
    if (doc.version !== target.targetVersion) {
      throw new AppError('VERSION_CONFLICT', '매입전표가 변경되었습니다. 새로 고친 뒤 다시 상신하세요.');
    }
    if (doc.status !== 'DRAFT') {
      throw new AppError('INVALID_TRANSITION', `현재 상태(${doc.status})의 전표는 상신할 수 없습니다.`);
    }
    await ctx.tx.purchaseDocument.update({
      where: { id: target.targetId },
      data: { status: 'PENDING_APPROVAL', version: { increment: 1 } },
    });
  },

  async validateBeforeCancelSubmit(ctx, target) {
    const doc = await ctx.tx.purchaseDocument.findUnique({ where: { id: target.targetId } });
    if (!doc) throw new AppError('NOT_FOUND', '매입전표를 찾을 수 없습니다.');
    if (doc.status !== 'CONFIRMED') {
      throw new AppError('INVALID_TRANSITION', '확정된 전표만 취소 상신할 수 있습니다.');
    }
    if (doc.version !== target.targetVersion) {
      throw new AppError('VERSION_CONFLICT', '매입전표가 변경되었습니다. 새로 고친 뒤 다시 상신하세요.');
    }
  },

  async currentVersion(ctx, targetId) {
    const doc = await ctx.tx.purchaseDocument.findUniqueOrThrow({
      where: { id: targetId },
      select: { version: true },
    });
    return doc.version;
  },

  async onApproved(ctx, target) {
    const doc = await ctx.tx.purchaseDocument.findUniqueOrThrow({ where: { id: target.targetId } });
    if (doc.status === 'CONFIRMED') return;
    await purchase.confirmDocument({ ...ctx, viaApproval: true }, target.targetId, doc.version);
  },

  async onRejected(ctx, target) {
    const doc = await ctx.tx.purchaseDocument.findUnique({ where: { id: target.targetId } });
    if (!doc || doc.status !== 'PENDING_APPROVAL') return;
    await ctx.tx.purchaseDocument.update({
      where: { id: target.targetId },
      data: { status: 'DRAFT', version: { increment: 1 } },
    });
  },

  async onCanceled(ctx, target) {
    const doc = await ctx.tx.purchaseDocument.findUniqueOrThrow({ where: { id: target.targetId } });
    if (doc.status === 'CANCELED') return;
    await purchase.cancelDocument(
      { ...ctx, viaApproval: true },
      target.targetId,
      '취소 결재 승인',
      doc.version,
    );
  },
};

/** APV-09: an approved purchase request becomes orderable; the order is created separately. */
export const purchaseRequestHandler: ApprovalTargetHandler = {
  targetType: 'PURCHASE_REQUEST',
  label: '구매요청',

  async validateBeforeSubmit(ctx, target) {
    const request = await ctx.tx.purchaseRequest.findUnique({ where: { id: target.targetId } });
    if (!request) throw new AppError('NOT_FOUND', '구매요청을 찾을 수 없습니다.');
    if (request.version !== target.targetVersion) {
      throw new AppError('VERSION_CONFLICT', '구매요청이 변경되었습니다. 새로 고친 뒤 다시 상신하세요.');
    }
    if (request.status !== 'DRAFT') {
      throw new AppError('INVALID_TRANSITION', `현재 상태(${request.status})의 요청은 상신할 수 없습니다.`);
    }
    await ctx.tx.purchaseRequest.update({
      where: { id: target.targetId },
      data: { status: 'PENDING_APPROVAL', version: { increment: 1 } },
    });
  },

  async currentVersion(ctx, targetId) {
    const request = await ctx.tx.purchaseRequest.findUniqueOrThrow({
      where: { id: targetId },
      select: { version: true },
    });
    return request.version;
  },

  async onApproved(ctx, target) {
    await purchase.markRequestApproved(ctx, target.targetId);
  },

  async onRejected(ctx, target) {
    const request = await ctx.tx.purchaseRequest.findUnique({ where: { id: target.targetId } });
    if (!request || request.status !== 'PENDING_APPROVAL') return;
    await ctx.tx.purchaseRequest.update({
      where: { id: target.targetId },
      data: { status: 'REJECTED', version: { increment: 1 } },
    });
  },

  async onCanceled() {
    throw new AppError(
      'VALIDATION',
      '구매요청은 취소 결재를 지원하지 않습니다. 발주 전이라면 요청을 취소하세요.',
    );
  },
};

export function registerSalesHandlers(): void {
  registerHandler(salesDocumentHandler);
  registerHandler(purchaseDocumentHandler);
  registerHandler(purchaseRequestHandler);
}
