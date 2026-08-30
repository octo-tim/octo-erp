import type { TransactionContext } from '@/server/core/context';
import { AppError } from '@/server/core/errors';
import * as leave from '@/server/modules/hrm/leave';
import * as attendance from '@/server/modules/hrm/attendance';
import { registerHandler, type ApprovalTargetHandler } from './index';

/**
 * APV-09 / E2E-03: the leave request handler. Every callback runs inside the approval
 * transaction, so a failure here rolls the approval back with it.
 */
export const leaveRequestHandler: ApprovalTargetHandler = {
  targetType: 'LEAVE_REQUEST',
  label: '휴가신청',

  async validateBeforeSubmit(ctx: TransactionContext, target) {
    const request = await ctx.tx.leaveRequest.findUnique({ where: { id: target.targetId } });
    if (!request) throw new AppError('NOT_FOUND', '휴가신청을 찾을 수 없습니다.');
    if (request.version !== target.targetVersion) {
      throw new AppError(
        'VERSION_CONFLICT',
        '휴가신청이 변경되었습니다. 화면을 새로 고친 뒤 다시 상신하세요.',
      );
    }
    if (request.status !== 'DRAFT') {
      throw new AppError(
        'INVALID_TRANSITION',
        `현재 상태(${request.status})의 휴가신청은 상신할 수 없습니다.`,
      );
    }

    // the balance is re-checked at submit time, not only at request time
    const balance = await leave.balanceOf(
      ctx,
      request.employeeId,
      request.startDate.toISOString().slice(0, 10),
      request.leaveType,
    );
    if (Number(request.days) > Number(balance.remaining)) {
      throw new AppError('VALIDATION', `잔여 연차(${balance.remaining}일)를 초과했습니다.`);
    }

    await ctx.tx.leaveRequest.update({
      where: { id: target.targetId },
      data: { status: 'PENDING_APPROVAL', version: { increment: 1 } },
    });
  },

  async validateBeforeCancelSubmit(ctx, target) {
    const request = await ctx.tx.leaveRequest.findUnique({ where: { id: target.targetId } });
    if (!request) throw new AppError('NOT_FOUND', '휴가신청을 찾을 수 없습니다.');
    if (request.status !== 'APPROVED') {
      throw new AppError('INVALID_TRANSITION', '승인된 휴가만 취소 상신할 수 있습니다.');
    }
    if (request.version !== target.targetVersion) {
      throw new AppError(
        'VERSION_CONFLICT',
        '휴가신청이 변경되었습니다. 화면을 새로 고친 뒤 다시 상신하세요.',
      );
    }
  },

  async currentVersion(ctx, targetId) {
    const request = await ctx.tx.leaveRequest.findUniqueOrThrow({ where: { id: targetId } });
    return request.version;
  },

  async onApproved(ctx, target, documentId) {
    await ctx.tx.leaveRequest.update({
      where: { id: target.targetId },
      data: { approvalDocId: documentId },
    });
    await leave.applyApprovedLeave(ctx, target.targetId);
  },

  async onRejected(ctx, target) {
    const request = await ctx.tx.leaveRequest.findUnique({ where: { id: target.targetId } });
    if (!request || request.status === 'APPROVED') return;
    await leave.rejectLeave(ctx, target.targetId);
  },

  async onCanceled(ctx, target, documentId) {
    const cancelDoc = await ctx.tx.approvalDocument.findUnique({ where: { id: documentId } });
    const reason = (cancelDoc?.content as { reason?: string } | null)?.reason ?? '결재 취소';
    await leave.cancelApprovedLeave(ctx, target.targetId, reason);
  },
};

/** APV-09 / HRM-04: attendance correction. */
export const attendanceCorrectionHandler: ApprovalTargetHandler = {
  targetType: 'ATTENDANCE_CORRECTION',
  label: '근태정정',

  async validateBeforeSubmit(ctx, target) {
    const request = await ctx.tx.attendanceCorrectionRequest.findUnique({ where: { id: target.targetId } });
    if (!request) throw new AppError('NOT_FOUND', '근태정정 신청을 찾을 수 없습니다.');
    if (request.version !== target.targetVersion) {
      throw new AppError('VERSION_CONFLICT', '근태정정 신청이 변경되었습니다.');
    }
    if (request.status !== 'DRAFT') {
      throw new AppError(
        'INVALID_TRANSITION',
        `현재 상태(${request.status})의 정정신청은 상신할 수 없습니다.`,
      );
    }
    await ctx.tx.attendanceCorrectionRequest.update({
      where: { id: target.targetId },
      data: { status: 'PENDING_APPROVAL', version: { increment: 1 } },
    });
  },

  async currentVersion(ctx, targetId) {
    const request = await ctx.tx.attendanceCorrectionRequest.findUniqueOrThrow({ where: { id: targetId } });
    return request.version;
  },

  async onApproved(ctx, target, documentId) {
    await ctx.tx.attendanceCorrectionRequest.update({
      where: { id: target.targetId },
      data: { approvalDocId: documentId },
    });
    await attendance.applyCorrection(ctx, target.targetId);
  },

  async onRejected(ctx, target) {
    const request = await ctx.tx.attendanceCorrectionRequest.findUnique({ where: { id: target.targetId } });
    if (!request || request.status === 'APPROVED') return;
    await attendance.rejectCorrection(ctx, target.targetId);
  },

  async onCanceled() {
    throw new AppError('VALIDATION', '근태정정은 취소 결재를 지원하지 않습니다. 새 정정신청을 상신하세요.');
  },
};

export function registerHrmHandlers(): void {
  registerHandler(leaveRequestHandler);
  registerHandler(attendanceCorrectionHandler);
}
