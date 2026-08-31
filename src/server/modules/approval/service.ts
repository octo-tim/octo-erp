import type { TransactionContext } from '@/server/core/context';
import { AppError } from '@/server/core/errors';
import { assertVersion } from '@/server/core/state-machine';
import * as audit from '@/server/modules/audit/service';
import * as notification from '@/server/modules/notification/service';
import { has, requirePermission } from '@/server/modules/rbac/service';
import { nextDocNo } from '@/server/modules/numbering/service';
import { businessDate } from '@/lib/dates';
import {
  buildLine,
  buildOverrideLine,
  pendingStepNumbers,
  selectLineTemplate,
  type LineContext,
  type StepRole,
} from './line';
import { resolveHandler, type ApprovalTarget } from './handlers';

/**
 * APV-13: each form gets its own numbering sequence — docType `APPROVAL:<formCode>` — so two
 * different forms never share a counter. A form with no rule of its own falls back to the
 * shared 'APPROVAL' rule rather than failing; that fallback is the expected path for most
 * forms until an admin registers a dedicated rule for one (system > 채번규칙 currently only
 * edits existing rules, so today every form uses the fallback — this only stops sharing a
 * sequence once a per-form rule row exists).
 */
export async function nextApprovalDocNo(ctx: TransactionContext, formCode: string): Promise<string> {
  try {
    return await nextDocNo(ctx, `APPROVAL:${formCode}`);
  } catch (e) {
    if (e instanceof AppError && e.code === 'VALIDATION' && e.message.includes('채번규칙이 없습니다')) {
      return nextDocNo(ctx, 'APPROVAL');
    }
    throw e;
  }
}

/** APV-13: the form code behind an existing document — a cancellation document is numbered under the same per-form sequence as the document it cancels. */
export async function documentFormCode(ctx: TransactionContext, documentId: string): Promise<string> {
  const document = await ctx.tx.approvalDocument.findUniqueOrThrow({
    where: { id: documentId },
    include: { formVersion: { include: { form: true } } },
  });
  return document.formVersion.form.code;
}

/** APV-07: the document lifecycle (INT-02 shape, extended for approval-specific states). */
export const ApprovalStatus = {
  DRAFT: 'DRAFT',
  IN_PROGRESS: 'IN_PROGRESS',
  ON_HOLD: 'ON_HOLD',
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED',
  WITHDRAWN: 'WITHDRAWN',
  CANCELED: 'CANCELED',
} as const;
export type ApprovalStatus = (typeof ApprovalStatus)[keyof typeof ApprovalStatus];

const TRANSITIONS: Record<ApprovalStatus, ApprovalStatus[]> = {
  DRAFT: ['IN_PROGRESS'],
  IN_PROGRESS: ['APPROVED', 'REJECTED', 'ON_HOLD', 'WITHDRAWN'],
  ON_HOLD: ['IN_PROGRESS', 'WITHDRAWN', 'REJECTED'],
  APPROVED: ['CANCELED'],
  REJECTED: ['DRAFT'],
  WITHDRAWN: ['DRAFT'],
  CANCELED: [],
};

function assertApprovalTransition(from: ApprovalStatus, to: ApprovalStatus): void {
  if (!TRANSITIONS[from]?.includes(to)) {
    throw new AppError('INVALID_TRANSITION', `결재문서를 ${from}에서 ${to}(으)로 바꿀 수 없습니다.`, {
      from,
      to,
    });
  }
}

export interface DraftInput {
  docNo: string;
  formCode: string;
  title: string;
  content: Record<string, unknown>;
  amount?: string;
  divisionId?: string;
  departmentId?: string;
  target?: ApprovalTarget;
}

/** APV-01: the active form version on the given date, plus its schema snapshot. */
async function activeFormVersion(ctx: TransactionContext, formCode: string, onDate: string) {
  const form = await ctx.tx.approvalForm.findUnique({ where: { code: formCode } });
  if (!form || !form.isActive)
    throw new AppError('NOT_FOUND', `사용 가능한 결재양식이 아닙니다: ${formCode}`);

  const version = await ctx.tx.approvalFormVersion.findFirst({
    where: { formId: form.id, isActive: true, effectiveFrom: { lte: new Date(`${onDate}T00:00:00.000Z`) } },
    orderBy: [{ effectiveFrom: 'desc' }, { version: 'desc' }],
  });
  if (!version)
    throw new AppError('NOT_FOUND', `${onDate} 기준으로 유효한 양식 버전이 없습니다: ${formCode}`);
  return { form, version };
}

interface FieldSchema {
  key: string;
  label: string;
  type: 'text' | 'textarea' | 'number' | 'money' | 'date' | 'select' | 'checkbox';
  required?: boolean;
  options?: { value: string; label: string }[];
  max?: number;
}

function validateContent(fields: FieldSchema[], content: Record<string, unknown>): void {
  const errors: string[] = [];
  for (const field of fields) {
    const value = content[field.key];
    if (field.required && (value === undefined || value === null || value === '')) {
      errors.push(`${field.label}을(를) 입력하세요.`);
      continue;
    }
    if (value === undefined || value === null || value === '') continue;
    if ((field.type === 'money' || field.type === 'number') && !/^-?\d+(\.\d+)?$/.test(String(value))) {
      errors.push(`${field.label}은(는) 숫자여야 합니다.`);
    }
    if (field.type === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(String(value))) {
      errors.push(`${field.label}은(는) YYYY-MM-DD 형식이어야 합니다.`);
    }
    if (field.type === 'select' && field.options && !field.options.some((o) => o.value === String(value))) {
      errors.push(`${field.label}에 허용되지 않은 값입니다.`);
    }
    if (field.max !== undefined && String(value).length > field.max) {
      errors.push(`${field.label}은(는) ${field.max}자 이내여야 합니다.`);
    }
  }
  if (errors.length) throw new AppError('VALIDATION', errors.join('\n'), { errors });
}

/** APV-06: save a draft. Nothing outside the approval module is touched yet. */
export async function draft(ctx: TransactionContext, input: DraftInput) {
  requirePermission(ctx.actor, 'approval.use');
  const onDate = businessDate(ctx.now);
  const { form, version } = await activeFormVersion(ctx, input.formCode, onDate);
  const fields = version.fieldSchema as unknown as FieldSchema[];
  validateContent(fields, input.content);

  const employee = ctx.actor.employeeId
    ? await ctx.tx.employee.findUnique({ where: { id: ctx.actor.employeeId } })
    : null;

  const document = await ctx.tx.approvalDocument.create({
    data: {
      docNo: input.docNo,
      formVersionId: version.id,
      // APV-01: the snapshot lets an old document render exactly as it was submitted
      formSnapshot: {
        formCode: form.code,
        formName: form.name,
        version: version.version,
        fieldSchema: fields,
      } as never,
      title: input.title,
      content: input.content as never,
      drafterId: ctx.actor.userId,
      drafterEmployeeId: ctx.actor.employeeId,
      divisionId: input.divisionId ?? null,
      departmentId: input.departmentId ?? employee?.departmentId ?? null,
      amount: input.amount ?? null,
      status: 'DRAFT',
    },
  });

  if (input.target) {
    await linkTarget(ctx, document.id, input.target);
  }

  await audit.record(ctx, {
    action: 'approval.draft',
    entityType: 'ApprovalDocument',
    entityId: document.id,
    after: { docNo: input.docNo, formCode: form.code, title: input.title, amount: input.amount },
  });

  return document;
}

/** INT-11: one live approval per (targetType, targetId, targetVersion). */
async function linkTarget(ctx: TransactionContext, documentId: string, target: ApprovalTarget) {
  try {
    await ctx.tx.approvalLink.create({
      data: {
        documentId,
        targetType: target.targetType,
        targetId: target.targetId,
        targetVersion: target.targetVersion,
      },
    });
  } catch (e) {
    if ((e as { code?: string }).code === 'P2002') {
      throw new AppError('DUPLICATE_EFFECT', '해당 문서는 이미 결재가 상신되어 있습니다.', { ...target });
    }
    throw e;
  }
}

/** APV-06/07: submit for approval — resolves the line and notifies the first approver. */
export async function submit(
  ctx: TransactionContext,
  input: {
    documentId: string;
    version: number;
    lineTemplateId?: string;
    /** APV-03: drafter-chosen line, accepted only when the resolved template's `editable` allows it */
    lineOverride?: { approverId: string; role: StepRole }[];
  },
) {
  requirePermission(ctx.actor, 'approval.use');
  const onDate = businessDate(ctx.now);

  const document = await ctx.tx.approvalDocument.findUniqueOrThrow({
    where: { id: input.documentId },
    include: { links: true, formVersion: { include: { form: true } } },
  });
  if (document.drafterId !== ctx.actor.userId && !ctx.actor.isAdmin) {
    throw new AppError('FORBIDDEN', '기안자만 상신할 수 있습니다.');
  }
  assertVersion('결재문서', document.version, input.version);
  assertApprovalTransition(document.status as ApprovalStatus, 'IN_PROGRESS');

  // The business object validates itself before the line is built. A cancellation
  // document validates against a different rule set: its target is already APPROVED.
  const isCancellation = document.cancelsDocumentId !== null;
  for (const link of document.links) {
    const handler = resolveHandler(link.targetType);
    const target = {
      targetType: link.targetType,
      targetId: link.targetId,
      targetVersion: link.targetVersion,
    };
    if (isCancellation) {
      if (!handler.validateBeforeCancelSubmit) {
        throw new AppError('VALIDATION', `${handler.label}은(는) 취소 결재를 지원하지 않습니다.`, {
          targetType: link.targetType,
        });
      }
      await handler.validateBeforeCancelSubmit(ctx, target);
    } else {
      await handler.validateBeforeSubmit(ctx, target);
    }
  }

  const lineContext: LineContext = {
    drafterId: document.drafterId,
    drafterEmployeeId: document.drafterEmployeeId,
    departmentId: document.departmentId,
    divisionId: document.divisionId,
    amount: document.amount?.toString() ?? null,
    onDate,
  };

  const templateId =
    input.lineTemplateId ??
    (await selectLineTemplate(ctx, {
      formId: document.formVersion.formId,
      divisionId: document.divisionId,
      departmentId: document.departmentId,
      amount: lineContext.amount,
    }));

  // APV-03: a drafter-edited line is only ever honoured when the resolved template says so —
  // checked here, on the server, regardless of whether the client offered an edit control.
  let steps;
  if (input.lineOverride) {
    const template = await ctx.tx.approvalLineTemplate.findUnique({ where: { id: templateId } });
    if (!template) throw new AppError('NOT_FOUND', '결재선 서식을 찾을 수 없습니다.');
    if (!template.isActive) throw new AppError('VALIDATION', '사용 중지된 결재선 서식입니다.');
    if (!template.editable) {
      throw new AppError(
        'FORBIDDEN',
        '이 결재선 서식은 상신 시 결재선을 변경할 수 없습니다. 기본 결재선으로 상신하세요.',
        { templateId },
      );
    }
    steps = await buildOverrideLine(ctx, {
      drafterId: document.drafterId,
      onDate,
      override: input.lineOverride,
    });
  } else {
    ({ steps } = await buildLine(ctx, templateId, lineContext));
  }

  await ctx.tx.approvalStep.deleteMany({ where: { documentId: document.id } });
  await ctx.tx.approvalStep.createMany({
    data: steps.map((s) => ({
      documentId: document.id,
      stepNo: s.stepNo,
      role: s.role,
      approverId: s.approverId,
      actedByUserId: s.actedByUserId ?? null,
      canFinalize: s.canFinalize,
      status: s.role === 'REFERENCE' ? 'SKIPPED' : 'PENDING',
    })),
  });

  await ctx.tx.approvalParticipant.deleteMany({ where: { documentId: document.id } });
  const references = steps.filter((s) => s.role === 'REFERENCE');
  if (references.length) {
    await ctx.tx.approvalParticipant.createMany({
      data: references.map((s) => ({ documentId: document.id, userId: s.approverId, role: 'REFERENCE' })),
      skipDuplicates: true,
    });
  }

  const updated = await ctx.tx.approvalDocument.update({
    where: { id: document.id },
    data: {
      status: 'IN_PROGRESS',
      currentStepNo: steps.find((s) => s.role !== 'REFERENCE')?.stepNo ?? 0,
      submittedAt: ctx.now,
      version: { increment: 1 },
    },
  });

  await logAction(ctx, { documentId: document.id, action: 'SUBMIT', stepNo: null });
  await notifyPending(ctx, document.id, document.docNo, document.title);

  await audit.record(ctx, {
    action: 'approval.submit',
    entityType: 'ApprovalDocument',
    entityId: document.id,
    after: {
      status: 'IN_PROGRESS',
      steps: steps.map((s) => ({ stepNo: s.stepNo, role: s.role, approverId: s.approverId })),
      lineOverridden: !!input.lineOverride,
    },
  });

  return updated;
}

/**
 * APV-03: shows the drafter what `submit` would build right now, and whether the resolved
 * template lets them change it. Read-only — it never writes steps, so calling it repeatedly
 * (e.g. while the drafter edits amount) is free of side effects.
 */
export async function previewLine(
  ctx: TransactionContext,
  documentId: string,
): Promise<{
  templateId: string;
  editable: boolean;
  steps: { stepNo: number; role: string; approverId: string }[];
  skipped: { stepNo: number; reason: string }[];
}> {
  requirePermission(ctx.actor, 'approval.use');
  const document = await ctx.tx.approvalDocument.findUniqueOrThrow({
    where: { id: documentId },
    include: { formVersion: true },
  });
  if (document.drafterId !== ctx.actor.userId && !ctx.actor.isAdmin) {
    throw new AppError('FORBIDDEN', '기안자만 결재선을 미리 볼 수 있습니다.');
  }

  const onDate = businessDate(ctx.now);
  const lineContext: LineContext = {
    drafterId: document.drafterId,
    drafterEmployeeId: document.drafterEmployeeId,
    departmentId: document.departmentId,
    divisionId: document.divisionId,
    amount: document.amount?.toString() ?? null,
    onDate,
  };

  const templateId = await selectLineTemplate(ctx, {
    formId: document.formVersion.formId,
    divisionId: document.divisionId,
    departmentId: document.departmentId,
    amount: lineContext.amount,
  });
  const template = await ctx.tx.approvalLineTemplate.findUniqueOrThrow({ where: { id: templateId } });

  try {
    const { steps, skipped } = await buildLine(ctx, templateId, lineContext);
    return {
      templateId,
      editable: template.editable,
      steps: steps.map((s) => ({ stepNo: s.stepNo, role: s.role, approverId: s.approverId })),
      skipped,
    };
  } catch (e) {
    // An editable template can still fail to auto-resolve anyone (e.g. the drafter has no
    // department head on record) — that gap is exactly what editing exists to route around,
    // so hand back an empty, editable line instead of a dead end. Any other failure (an
    // inactive template, for instance) is real and must still be reported as one, editable or
    // not — editing lets the drafter pick approvers, it does not waive those checks.
    if (
      e instanceof AppError &&
      e.code === 'VALIDATION' &&
      template.editable &&
      e.message.includes('승인 단계가 없는 결재선')
    ) {
      return { templateId, editable: true, steps: [], skipped: [] };
    }
    throw e;
  }
}

/** APV-03: candidates for a manually edited 결재선 — active users a drafter may pick as approver. */
export async function listApprovers(ctx: TransactionContext) {
  requirePermission(ctx.actor, 'approval.use');
  return ctx.tx.user.findMany({
    where: { isActive: true },
    select: { id: true, displayName: true, username: true },
    orderBy: { displayName: 'asc' },
  });
}

async function logAction(
  ctx: TransactionContext,
  input: { documentId: string; action: string; stepNo: number | null; comment?: string },
) {
  try {
    await ctx.tx.approvalActionLog.create({
      data: {
        documentId: input.documentId,
        stepNo: input.stepNo,
        actorId: ctx.actor.userId,
        action: input.action,
        comment: input.comment ?? null,
        requestId: ctx.requestId,
      },
    });
  } catch (e) {
    // INT-05: the unique index on (documentId, stepNo, action, requestId) is the
    // second line of defence against a double-submitted approval.
    if ((e as { code?: string }).code === 'P2002') {
      throw new AppError('DUPLICATE_EFFECT', '이미 처리된 요청입니다.', { action: input.action });
    }
    throw e;
  }
}

async function notifyPending(ctx: TransactionContext, documentId: string, docNo: string, title: string) {
  const steps = await ctx.tx.approvalStep.findMany({ where: { documentId }, orderBy: { stepNo: 'asc' } });
  const pending = pendingStepNumbers(steps);
  const recipients = steps
    .filter((s) => pending.includes(s.stepNo))
    .map((s) => s.actedByUserId ?? s.approverId);

  if (recipients.length === 0) return;
  await notification.notify(ctx, {
    userIds: recipients,
    category: 'APPROVAL',
    title: `결재 요청: ${title}`,
    body: `문서번호 ${docNo}`,
    linkUrl: `/approval/documents/${documentId}`,
    email: true,
    dedupKey: `approval:${documentId}:${pending.join(',')}`,
  });
}

/**
 * APV-07/08/09: approve one step. When the document completes, the target handlers run
 * inside this same transaction, so a failure in the business effect rolls the approval back.
 */
export async function approve(
  ctx: TransactionContext,
  input: { documentId: string; version: number; comment?: string },
) {
  requirePermission(ctx.actor, 'approval.use');

  // lock the document row so two approvers cannot advance the same step
  await ctx.tx.$executeRaw`SELECT id FROM "ApprovalDocument" WHERE id = ${input.documentId} FOR UPDATE`;

  const document = await ctx.tx.approvalDocument.findUniqueOrThrow({
    where: { id: input.documentId },
    include: { steps: { orderBy: { stepNo: 'asc' } }, links: true },
  });
  assertVersion('결재문서', document.version, input.version);
  if (document.status !== 'IN_PROGRESS' && document.status !== 'ON_HOLD') {
    throw new AppError('INVALID_TRANSITION', `현재 상태(${document.status})에서는 승인할 수 없습니다.`);
  }

  const pending = pendingStepNumbers(document.steps);
  const step = document.steps.find(
    (s) =>
      pending.includes(s.stepNo) &&
      (s.approverId === ctx.actor.userId || s.actedByUserId === ctx.actor.userId),
  );
  if (!step) throw new AppError('FORBIDDEN', '현재 결재 차례가 아니거나 결재자가 아닙니다.');

  await logAction(ctx, {
    documentId: document.id,
    action: 'APPROVE',
    stepNo: step.stepNo,
    ...(input.comment ? { comment: input.comment } : {}),
  });

  await ctx.tx.approvalStep.update({
    where: { id: step.id },
    data: {
      status: 'APPROVED',
      comment: input.comment ?? null,
      actedAt: ctx.now,
      ...(step.approverId !== ctx.actor.userId ? { actedByUserId: ctx.actor.userId } : {}),
    },
  });

  const steps = await ctx.tx.approvalStep.findMany({
    where: { documentId: document.id },
    orderBy: { stepNo: 'asc' },
  });

  // APV-04 전결: this step finalises the document, later steps are skipped
  const finalized = step.canFinalize;
  if (finalized) {
    await ctx.tx.approvalStep.updateMany({
      where: { documentId: document.id, status: 'PENDING', stepNo: { gt: step.stepNo } },
      data: { status: 'SKIPPED', comment: `${step.stepNo}단계 전결` },
    });
  }

  const remaining = finalized ? [] : pendingStepNumbers(steps);
  const complete = remaining.length === 0;

  const updated = await ctx.tx.approvalDocument.update({
    where: { id: document.id },
    data: {
      status: complete ? 'APPROVED' : 'IN_PROGRESS',
      currentStepNo: complete ? step.stepNo : (remaining[0] ?? step.stepNo),
      completedAt: complete ? ctx.now : null,
      version: { increment: 1 },
    },
  });

  if (complete) {
    // APV-08/09/12: business effects run here, in this transaction. A cancellation
    // document reverses its targets instead of applying them.
    if (document.cancelsDocumentId) {
      await applyCancellation({ ...ctx, viaApproval: true }, document.id);
    } else {
      for (const link of document.links) {
        const target = {
          targetType: link.targetType,
          targetId: link.targetId,
          targetVersion: link.targetVersion,
        };
        await resolveHandler(link.targetType).onApproved({ ...ctx, viaApproval: true }, target, document.id);
      }
    }
    await notification.notify(ctx, {
      userIds: [document.drafterId],
      category: 'APPROVAL',
      title: `결재 완료: ${document.title}`,
      body: `문서번호 ${document.docNo}`,
      linkUrl: `/approval/documents/${document.id}`,
      email: true,
      dedupKey: `approval-done:${document.id}`,
    });
  } else {
    await notifyPending(ctx, document.id, document.docNo, document.title);
  }

  await audit.record(ctx, {
    action: 'approval.approve',
    entityType: 'ApprovalDocument',
    entityId: document.id,
    after: { stepNo: step.stepNo, finalized, complete, status: updated.status },
  });

  return updated;
}

export async function reject(
  ctx: TransactionContext,
  input: { documentId: string; version: number; comment: string },
) {
  requirePermission(ctx.actor, 'approval.use');
  if (input.comment.trim().length < 2) throw new AppError('VALIDATION', '반려 의견을 입력하세요.');

  await ctx.tx.$executeRaw`SELECT id FROM "ApprovalDocument" WHERE id = ${input.documentId} FOR UPDATE`;
  const document = await ctx.tx.approvalDocument.findUniqueOrThrow({
    where: { id: input.documentId },
    include: { steps: { orderBy: { stepNo: 'asc' } }, links: true },
  });
  assertVersion('결재문서', document.version, input.version);
  assertApprovalTransition(document.status as ApprovalStatus, 'REJECTED');

  const pending = pendingStepNumbers(document.steps);
  const step = document.steps.find(
    (s) =>
      pending.includes(s.stepNo) &&
      (s.approverId === ctx.actor.userId || s.actedByUserId === ctx.actor.userId),
  );
  if (!step) throw new AppError('FORBIDDEN', '현재 결재 차례가 아니거나 결재자가 아닙니다.');

  await logAction(ctx, {
    documentId: document.id,
    action: 'REJECT',
    stepNo: step.stepNo,
    comment: input.comment,
  });
  await ctx.tx.approvalStep.update({
    where: { id: step.id },
    data: { status: 'REJECTED', comment: input.comment, actedAt: ctx.now },
  });
  await ctx.tx.approvalStep.updateMany({
    where: { documentId: document.id, status: 'PENDING' },
    data: { status: 'SKIPPED' },
  });

  const updated = await ctx.tx.approvalDocument.update({
    where: { id: document.id },
    data: { status: 'REJECTED', completedAt: ctx.now, version: { increment: 1 } },
  });

  for (const link of document.links) {
    await resolveHandler(link.targetType).onRejected(
      { ...ctx, viaApproval: true },
      { targetType: link.targetType, targetId: link.targetId, targetVersion: link.targetVersion },
      document.id,
    );
  }

  await notification.notify(ctx, {
    userIds: [document.drafterId],
    category: 'APPROVAL',
    title: `결재 반려: ${document.title}`,
    body: `${input.comment} (문서번호 ${document.docNo})`,
    linkUrl: `/approval/documents/${document.id}`,
    email: true,
    dedupKey: `approval-reject:${document.id}`,
  });

  await audit.record(ctx, {
    action: 'approval.reject',
    entityType: 'ApprovalDocument',
    entityId: document.id,
    after: { stepNo: step.stepNo, comment: input.comment },
  });

  return updated;
}

export async function hold(
  ctx: TransactionContext,
  input: { documentId: string; version: number; comment: string },
) {
  requirePermission(ctx.actor, 'approval.use');
  const document = await ctx.tx.approvalDocument.findUniqueOrThrow({
    where: { id: input.documentId },
    include: { steps: true },
  });
  assertVersion('결재문서', document.version, input.version);
  assertApprovalTransition(document.status as ApprovalStatus, 'ON_HOLD');

  const pending = pendingStepNumbers(document.steps);
  const step = document.steps.find(
    (s) =>
      pending.includes(s.stepNo) &&
      (s.approverId === ctx.actor.userId || s.actedByUserId === ctx.actor.userId),
  );
  if (!step) throw new AppError('FORBIDDEN', '현재 결재 차례가 아닙니다.');

  await logAction(ctx, {
    documentId: document.id,
    action: 'HOLD',
    stepNo: step.stepNo,
    comment: input.comment,
  });
  await ctx.tx.approvalStep.update({
    where: { id: step.id },
    data: { status: 'ON_HOLD', comment: input.comment },
  });
  return ctx.tx.approvalDocument.update({
    where: { id: document.id },
    data: { status: 'ON_HOLD', version: { increment: 1 } },
  });
}

export async function releaseHold(ctx: TransactionContext, input: { documentId: string; version: number }) {
  const document = await ctx.tx.approvalDocument.findUniqueOrThrow({
    where: { id: input.documentId },
    include: { steps: true },
  });
  assertVersion('결재문서', document.version, input.version);
  assertApprovalTransition(document.status as ApprovalStatus, 'IN_PROGRESS');

  /**
   * A hold is one approver saying they are not ready to decide. Anyone holding
   * `approval.use` — which is nearly everyone — could previously lift someone else's hold and
   * push the document back into the queue, which makes the hold meaningless. Only the
   * approver who placed it, or an admin, may take it back off.
   */
  const held = document.steps.filter((s) => s.status === 'ON_HOLD');
  if (held.length === 0) {
    throw new AppError('INVALID_TRANSITION', '보류 중인 결재단계가 없습니다.');
  }
  if (!ctx.actor.isAdmin && !held.some((s) => s.approverId === ctx.actor.userId)) {
    throw new AppError('FORBIDDEN', '보류를 건 결재자만 보류를 해제할 수 있습니다.');
  }

  await ctx.tx.approvalStep.updateMany({
    where: { documentId: document.id, status: 'ON_HOLD' },
    data: { status: 'PENDING', comment: null },
  });
  return ctx.tx.approvalDocument.update({
    where: { id: document.id },
    data: { status: 'IN_PROGRESS', version: { increment: 1 } },
  });
}

/** APV-07: the drafter may withdraw while no approver has acted yet. */
export async function withdraw(
  ctx: TransactionContext,
  input: { documentId: string; version: number; reason?: string },
) {
  const document = await ctx.tx.approvalDocument.findUniqueOrThrow({
    where: { id: input.documentId },
    include: { steps: true, links: true },
  });
  if (document.drafterId !== ctx.actor.userId && !ctx.actor.isAdmin) {
    throw new AppError('FORBIDDEN', '기안자만 회수할 수 있습니다.');
  }
  assertVersion('결재문서', document.version, input.version);
  assertApprovalTransition(document.status as ApprovalStatus, 'WITHDRAWN');

  if (document.steps.some((s) => s.status === 'APPROVED')) {
    throw new AppError('CONFLICT', '이미 결재가 진행된 문서는 회수할 수 없습니다. 반려를 요청하세요.');
  }

  await logAction(ctx, {
    documentId: document.id,
    action: 'WITHDRAW',
    stepNo: null,
    ...(input.reason ? { comment: input.reason } : {}),
  });
  await ctx.tx.approvalStep.updateMany({ where: { documentId: document.id }, data: { status: 'SKIPPED' } });

  const updated = await ctx.tx.approvalDocument.update({
    where: { id: document.id },
    data: { status: 'WITHDRAWN', version: { increment: 1 } },
  });

  for (const link of document.links) {
    await resolveHandler(link.targetType).onRejected(
      { ...ctx, viaApproval: true },
      { targetType: link.targetType, targetId: link.targetId, targetVersion: link.targetVersion },
      document.id,
    );
  }

  await audit.record(ctx, {
    action: 'approval.withdraw',
    entityType: 'ApprovalDocument',
    entityId: document.id,
  });
  return updated;
}

/** APV-07: after a rejection or withdrawal, edit and submit again as a new draft cycle. */
export async function resubmit(
  ctx: TransactionContext,
  input: {
    documentId: string;
    version: number;
    title?: string;
    content?: Record<string, unknown>;
    amount?: string;
  },
) {
  const document = await ctx.tx.approvalDocument.findUniqueOrThrow({
    where: { id: input.documentId },
    include: { formVersion: true },
  });
  if (document.drafterId !== ctx.actor.userId && !ctx.actor.isAdmin) {
    throw new AppError('FORBIDDEN', '기안자만 재상신할 수 있습니다.');
  }
  assertVersion('결재문서', document.version, input.version);
  assertApprovalTransition(document.status as ApprovalStatus, 'DRAFT');

  if (input.content) {
    const snapshot = document.formSnapshot as unknown as { fieldSchema: FieldSchema[] };
    validateContent(snapshot.fieldSchema, input.content);
  }

  await ctx.tx.approvalStep.deleteMany({ where: { documentId: document.id } });
  const updated = await ctx.tx.approvalDocument.update({
    where: { id: document.id },
    data: {
      status: 'DRAFT',
      currentStepNo: 0,
      submittedAt: null,
      completedAt: null,
      ...(input.title ? { title: input.title } : {}),
      ...(input.content ? { content: input.content as never } : {}),
      ...(input.amount !== undefined ? { amount: input.amount } : {}),
      version: { increment: 1 },
    },
  });

  await logAction(ctx, { documentId: document.id, action: 'RESUBMIT', stepNo: null });
  await audit.record(ctx, {
    action: 'approval.resubmit',
    entityType: 'ApprovalDocument',
    entityId: document.id,
  });
  return updated;
}

/**
 * APV-12: a completed document is immutable. Cancelling it means creating a separate
 * cancellation document whose approval triggers the target's onCanceled effects.
 */
export async function requestCancel(
  ctx: TransactionContext,
  input: { docNo: string; documentId: string; reason: string },
) {
  const original = await ctx.tx.approvalDocument.findUniqueOrThrow({
    where: { id: input.documentId },
    include: { links: true, formVersion: true },
  });
  if (original.status !== 'APPROVED') {
    throw new AppError('INVALID_TRANSITION', '승인 완료된 문서만 취소 상신할 수 있습니다.');
  }
  const existing = await ctx.tx.approvalDocument.findUnique({
    where: { cancelsDocumentId: input.documentId },
  });
  if (existing)
    throw new AppError('DUPLICATE_EFFECT', '이미 취소 문서가 존재합니다.', { cancelDocumentId: existing.id });

  const cancelDoc = await ctx.tx.approvalDocument.create({
    data: {
      docNo: input.docNo,
      formVersionId: original.formVersionId,
      formSnapshot: original.formSnapshot as never,
      title: `[취소] ${original.title}`,
      content: { originalDocNo: original.docNo, reason: input.reason } as never,
      drafterId: ctx.actor.userId,
      drafterEmployeeId: ctx.actor.employeeId,
      divisionId: original.divisionId,
      departmentId: original.departmentId,
      amount: original.amount,
      status: 'DRAFT',
      cancelsDocumentId: original.id,
    },
  });

  // The cancellation links to each target at its CURRENT version, which the owning
  // module reports — the approval module never guesses a version number.
  for (const link of original.links) {
    const handler = resolveHandler(link.targetType);
    await ctx.tx.approvalLink.create({
      data: {
        documentId: cancelDoc.id,
        targetType: link.targetType,
        targetId: link.targetId,
        targetVersion: await handler.currentVersion(ctx, link.targetId),
      },
    });
  }

  await audit.record(ctx, {
    action: 'approval.requestCancel',
    entityType: 'ApprovalDocument',
    entityId: cancelDoc.id,
    after: { cancels: original.docNo, reason: input.reason },
  });
  return cancelDoc;
}

/** Called when a cancellation document is approved: fires onCanceled and marks the original. */
export async function applyCancellation(ctx: TransactionContext, cancelDocumentId: string) {
  const cancelDoc = await ctx.tx.approvalDocument.findUniqueOrThrow({
    where: { id: cancelDocumentId },
    include: { links: true },
  });
  if (!cancelDoc.cancelsDocumentId) throw new AppError('VALIDATION', '취소 대상 문서가 없습니다.');

  for (const link of cancelDoc.links) {
    await resolveHandler(link.targetType).onCanceled(
      { ...ctx, viaApproval: true },
      { targetType: link.targetType, targetId: link.targetId, targetVersion: link.targetVersion },
      cancelDoc.id,
    );
  }

  await ctx.tx.approvalDocument.update({
    where: { id: cancelDoc.cancelsDocumentId },
    data: { status: 'CANCELED', version: { increment: 1 } },
  });
  await audit.record(ctx, {
    action: 'approval.cancelApplied',
    entityType: 'ApprovalDocument',
    entityId: cancelDoc.cancelsDocumentId,
  });
}

// ── APV-10 inboxes and APV-13 search ──

export type Inbox = 'DRAFTED' | 'PENDING' | 'IN_PROGRESS' | 'COMPLETED' | 'REJECTED' | 'REFERENCE';

export async function listInbox(
  ctx: TransactionContext,
  input: { inbox: Inbox; q?: string; from?: string; to?: string; skip: number; take: number },
) {
  requirePermission(ctx.actor, 'approval.use');
  const userId = ctx.actor.userId;

  const base = {
    ...(input.q
      ? {
          OR: [
            { title: { contains: input.q, mode: 'insensitive' as const } },
            { docNo: { contains: input.q } },
          ],
        }
      : {}),
    ...(input.from || input.to
      ? {
          createdAt: {
            ...(input.from ? { gte: new Date(`${input.from}T00:00:00.000Z`) } : {}),
            ...(input.to ? { lt: new Date(`${input.to}T23:59:59.999Z`) } : {}),
          },
        }
      : {}),
  };

  const where = (() => {
    switch (input.inbox) {
      case 'DRAFTED':
        return { ...base, drafterId: userId };
      case 'PENDING':
        return {
          ...base,
          status: { in: ['IN_PROGRESS', 'ON_HOLD'] },
          steps: { some: { status: 'PENDING', OR: [{ approverId: userId }, { actedByUserId: userId }] } },
        };
      case 'IN_PROGRESS':
        return {
          ...base,
          status: 'IN_PROGRESS',
          steps: { some: { OR: [{ approverId: userId }, { actedByUserId: userId }] } },
        };
      case 'COMPLETED':
        return {
          ...base,
          status: 'APPROVED',
          OR: [
            { drafterId: userId },
            { steps: { some: { OR: [{ approverId: userId }, { actedByUserId: userId }] } } },
          ],
        };
      case 'REJECTED':
        return {
          ...base,
          status: { in: ['REJECTED', 'WITHDRAWN'] },
          OR: [
            { drafterId: userId },
            { steps: { some: { OR: [{ approverId: userId }, { actedByUserId: userId }] } } },
          ],
        };
      case 'REFERENCE':
        return { ...base, participants: { some: { userId } } };
    }
  })();

  const [rows, total] = await Promise.all([
    ctx.tx.approvalDocument.findMany({
      where,
      include: { steps: { orderBy: { stepNo: 'asc' } } },
      orderBy: { createdAt: 'desc' },
      skip: input.skip,
      take: input.take,
    }),
    ctx.tx.approvalDocument.count({ where }),
  ]);
  return { rows, total };
}

/** APV-10: the unread badge count. */
export async function pendingCount(ctx: TransactionContext): Promise<number> {
  return ctx.tx.approvalDocument.count({
    where: {
      status: { in: ['IN_PROGRESS', 'ON_HOLD'] },
      steps: {
        some: {
          status: 'PENDING',
          OR: [{ approverId: ctx.actor.userId }, { actedByUserId: ctx.actor.userId }],
        },
      },
    },
  });
}

export async function detail(ctx: TransactionContext, documentId: string) {
  requirePermission(ctx.actor, 'approval.use');
  const document = await ctx.tx.approvalDocument.findUnique({
    where: { id: documentId },
    include: {
      steps: { orderBy: { stepNo: 'asc' } },
      participants: true,
      actions: { orderBy: { createdAt: 'asc' } },
      links: true,
    },
  });
  if (!document) throw new AppError('NOT_FOUND', '결재문서를 찾을 수 없습니다.');

  const involved =
    document.drafterId === ctx.actor.userId ||
    document.steps.some((s) => s.approverId === ctx.actor.userId || s.actedByUserId === ctx.actor.userId) ||
    document.participants.some((p) => p.userId === ctx.actor.userId);

  if (!involved && !ctx.actor.isAdmin && !has(ctx.actor, 'approval.admin')) {
    throw new AppError('FORBIDDEN', '이 결재문서를 조회할 권한이 없습니다.');
  }

  const pending = pendingStepNumbers(document.steps);
  return {
    ...document,
    pendingStepNos: pending,
    canAct: document.steps.some(
      (s) =>
        pending.includes(s.stepNo) &&
        (s.approverId === ctx.actor.userId || s.actedByUserId === ctx.actor.userId),
    ),
    isDrafter: document.drafterId === ctx.actor.userId,
  };
}

/** APV-11: long-pending documents, used by the scheduled reminder job. */
export async function longPending(ctx: TransactionContext, businessDays: number) {
  const cutoff = new Date(ctx.now.getTime() - businessDays * 86400000 * 1.4); // rough business-day allowance
  return ctx.tx.approvalDocument.findMany({
    where: { status: { in: ['IN_PROGRESS', 'ON_HOLD'] }, submittedAt: { lt: cutoff } },
    include: { steps: { where: { status: 'PENDING' } } },
  });
}
