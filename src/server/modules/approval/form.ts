import type { TransactionContext } from '@/server/core/context';
import { AppError } from '@/server/core/errors';
import { requirePermission } from '@/server/modules/rbac/service';
import * as audit from '@/server/modules/audit/service';
import { businessDate, toDateOnly } from '@/lib/dates';

/** APV-01/02/03/04: form versions, line templates, rules and delegations. */

export interface FieldSchema {
  key: string;
  label: string;
  type: 'text' | 'textarea' | 'number' | 'money' | 'date' | 'select' | 'checkbox';
  required?: boolean;
  options?: { value: string; label: string }[];
  max?: number;
}

export async function listForms(ctx: TransactionContext) {
  const forms = await ctx.tx.approvalForm.findMany({
    where: { isActive: true },
    include: { versions: { where: { isActive: true }, orderBy: { version: 'desc' }, take: 1 } },
    orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }],
  });
  return forms.map((f) => ({
    id: f.id,
    code: f.code,
    name: f.name,
    category: f.category,
    targetType: f.targetType,
    currentVersion: f.versions[0]?.version ?? null,
    fieldSchema: (f.versions[0]?.fieldSchema ?? []) as unknown as FieldSchema[],
  }));
}

export async function listFormVersions(ctx: TransactionContext, formCode?: string) {
  requirePermission(ctx.actor, 'approval.admin');
  return ctx.tx.approvalFormVersion.findMany({
    where: formCode ? { form: { code: formCode } } : {},
    include: { form: { select: { code: true, name: true } } },
    orderBy: [{ formId: 'asc' }, { version: 'desc' }],
  });
}

/**
 * APV-01: publishing never edits an existing version — old documents keep rendering
 * against the schema they were submitted with.
 */
export async function publishFormVersion(
  ctx: TransactionContext,
  input: { formCode: string; fieldSchema: FieldSchema[]; effectiveFrom: string },
) {
  requirePermission(ctx.actor, 'approval.admin');
  const form = await ctx.tx.approvalForm.findUnique({ where: { code: input.formCode } });
  if (!form) throw new AppError('NOT_FOUND', `결재양식을 찾을 수 없습니다: ${input.formCode}`);

  const keys = input.fieldSchema.map((f) => f.key);
  if (new Set(keys).size !== keys.length) throw new AppError('VALIDATION', '필드 키가 중복되었습니다.');

  const last = await ctx.tx.approvalFormVersion.findFirst({
    where: { formId: form.id },
    orderBy: { version: 'desc' },
  });

  const version = await ctx.tx.approvalFormVersion.create({
    data: {
      formId: form.id,
      version: (last?.version ?? 0) + 1,
      fieldSchema: input.fieldSchema as never,
      effectiveFrom: toDateOnly(input.effectiveFrom),
      createdById: ctx.actor.userId,
    },
  });

  await audit.record(ctx, {
    action: 'approvalForm.publish',
    entityType: 'ApprovalFormVersion',
    entityId: version.id,
    after: { formCode: input.formCode, version: version.version, fields: keys },
  });
  return version;
}

export async function listLineTemplates(ctx: TransactionContext) {
  return ctx.tx.approvalLineTemplate.findMany({
    where: { isActive: true },
    include: { steps: { orderBy: { stepNo: 'asc' } } },
    orderBy: { code: 'asc' },
  });
}

export async function listRules(ctx: TransactionContext) {
  requirePermission(ctx.actor, 'approval.admin');
  return ctx.tx.approvalRule.findMany({
    where: { isActive: true },
    orderBy: [{ priority: 'desc' }, { code: 'asc' }],
  });
}

// ── APV-04 delegation ──

export async function listDelegations(ctx: TransactionContext) {
  return ctx.tx.delegation.findMany({
    where: { OR: [{ fromUserId: ctx.actor.userId }, { toUserId: ctx.actor.userId }], isActive: true },
    orderBy: { validFrom: 'desc' },
  });
}

export async function setDelegation(
  ctx: TransactionContext,
  input: { toUserId: string; validFrom: string; validTo: string; reason?: string },
) {
  if (input.toUserId === ctx.actor.userId)
    throw new AppError('VALIDATION', '본인을 대결자로 지정할 수 없습니다.');
  if (input.validTo < input.validFrom)
    throw new AppError('VALIDATION', '종료일은 시작일보다 빠를 수 없습니다.');

  const deputy = await ctx.tx.user.findUnique({ where: { id: input.toUserId } });
  if (!deputy?.isActive) throw new AppError('VALIDATION', '사용 가능한 대결자가 아닙니다.');

  // A chain of delegations would make the acting approver ambiguous, so block both
  // directions: the deputy must not already delegate onward, and the delegator must not
  // already be someone else's deputy for an overlapping period.
  const period = {
    validFrom: { lte: toDateOnly(input.validTo) },
    validTo: { gte: toDateOnly(input.validFrom) },
  };
  const deputyDelegatesOnward = await ctx.tx.delegation.findFirst({
    where: { fromUserId: input.toUserId, isActive: true, ...period },
  });
  if (deputyDelegatesOnward) {
    throw new AppError('CONFLICT', '지정한 대결자가 같은 기간에 다른 사람에게 대결을 위임했습니다.');
  }
  const actorIsAlreadyDeputy = await ctx.tx.delegation.findFirst({
    where: { toUserId: ctx.actor.userId, isActive: true, ...period },
  });
  if (actorIsAlreadyDeputy) {
    throw new AppError(
      'CONFLICT',
      '같은 기간에 다른 사람의 대결자로 지정되어 있어 대결을 위임할 수 없습니다.',
    );
  }

  const overlapping = await ctx.tx.delegation.findFirst({
    where: {
      fromUserId: ctx.actor.userId,
      isActive: true,
      validFrom: { lte: toDateOnly(input.validTo) },
      validTo: { gte: toDateOnly(input.validFrom) },
    },
  });
  if (overlapping) throw new AppError('CONFLICT', '같은 기간에 이미 설정된 대결이 있습니다.');

  const delegation = await ctx.tx.delegation.create({
    data: {
      fromUserId: ctx.actor.userId,
      toUserId: input.toUserId,
      validFrom: toDateOnly(input.validFrom),
      validTo: toDateOnly(input.validTo),
      reason: input.reason ?? null,
      createdById: ctx.actor.userId,
    },
  });

  await audit.record(ctx, {
    action: 'delegation.create',
    entityType: 'Delegation',
    entityId: delegation.id,
    after: { toUserId: input.toUserId, validFrom: input.validFrom, validTo: input.validTo },
  });
  return delegation;
}

export async function endDelegation(ctx: TransactionContext, delegationId: string) {
  const delegation = await ctx.tx.delegation.findUniqueOrThrow({ where: { id: delegationId } });
  if (delegation.fromUserId !== ctx.actor.userId && !ctx.actor.isAdmin) {
    throw new AppError('FORBIDDEN', '본인이 설정한 대결만 해제할 수 있습니다.');
  }
  await ctx.tx.delegation.update({ where: { id: delegationId }, data: { isActive: false } });
  await audit.record(ctx, { action: 'delegation.end', entityType: 'Delegation', entityId: delegationId });
  return { ok: true };
}

/** APV-02: the seeded forms, each published as version 1. */
export const DEFAULT_FORMS: {
  code: string;
  name: string;
  category: string;
  targetType?: string;
  fields: FieldSchema[];
}[] = [
  {
    code: 'EXPENSE',
    name: '지출결의서',
    category: 'EXPENSE',
    fields: [
      { key: 'purpose', label: '지출목적', type: 'text', required: true, max: 100 },
      { key: 'amount', label: '지출금액', type: 'money', required: true },
      { key: 'paymentDate', label: '지급예정일', type: 'date', required: true },
      { key: 'payee', label: '지급처', type: 'text', required: true, max: 50 },
      { key: 'note', label: '비고', type: 'textarea', max: 500 },
    ],
  },
  {
    code: 'PURCHASE_REQUEST',
    name: '구매요청서',
    category: 'PURCHASE',
    targetType: 'PURCHASE_REQUEST',
    fields: [
      { key: 'purpose', label: '구매목적', type: 'text', required: true, max: 100 },
      { key: 'requiredDate', label: '필요일자', type: 'date', required: true },
      { key: 'amount', label: '예상금액', type: 'money', required: true },
      { key: 'note', label: '비고', type: 'textarea', max: 500 },
    ],
  },
  {
    code: 'PROPOSAL',
    name: '품의서',
    category: 'GENERAL',
    fields: [
      { key: 'subject', label: '품의제목', type: 'text', required: true, max: 100 },
      { key: 'background', label: '배경', type: 'textarea', required: true, max: 1000 },
      { key: 'amount', label: '관련금액', type: 'money' },
      { key: 'note', label: '비고', type: 'textarea', max: 500 },
    ],
  },
  {
    code: 'CONTRACT_REVIEW',
    name: '계약검토서',
    category: 'CONTRACT',
    fields: [
      { key: 'counterparty', label: '계약상대방', type: 'text', required: true, max: 50 },
      {
        key: 'contractType',
        label: '계약유형',
        type: 'select',
        required: true,
        options: [
          { value: 'PURCHASE', label: '구매' },
          { value: 'SALES', label: '판매' },
          { value: 'SERVICE', label: '용역' },
          { value: 'LEASE', label: '임대차' },
          { value: 'OTHER', label: '기타' },
        ],
      },
      { key: 'amount', label: '계약금액', type: 'money', required: true },
      { key: 'startDate', label: '계약시작일', type: 'date', required: true },
      { key: 'endDate', label: '계약종료일', type: 'date' },
      { key: 'note', label: '검토요청사항', type: 'textarea', max: 1000 },
    ],
  },
  {
    code: 'LEAVE',
    name: '휴가신청서',
    category: 'HR',
    targetType: 'LEAVE_REQUEST',
    fields: [
      {
        key: 'leaveType',
        label: '휴가유형',
        type: 'select',
        required: true,
        options: [
          { value: 'ANNUAL', label: '연차' },
          { value: 'SICK', label: '병가' },
          { value: 'SPECIAL', label: '경조사' },
        ],
      },
      { key: 'startDate', label: '시작일', type: 'date', required: true },
      { key: 'endDate', label: '종료일', type: 'date', required: true },
      { key: 'reason', label: '사유', type: 'text', max: 200 },
    ],
  },
  /**
   * APV-08 / STEP 10. A document over the DEC-03 threshold can only be confirmed by an
   * approval, so it needs a form to be submitted on. Without these three, that gate was a
   * dead end: an over-threshold sales document could be neither confirmed nor submitted.
   * The fields are deliberately thin — the figures live on the business document, and the
   * approval carries only what an approver reads before deciding.
   */
  {
    code: 'SALES_DOCUMENT',
    name: '매출전표 결재',
    category: 'SALES',
    targetType: 'SALES_DOCUMENT',
    fields: [
      { key: 'docNo', label: '전표번호', type: 'text', required: true, max: 30 },
      { key: 'partner', label: '거래처', type: 'text', required: true, max: 100 },
      { key: 'amount', label: '합계금액', type: 'money', required: true },
      { key: 'note', label: '상신사유', type: 'textarea', max: 500 },
    ],
  },
  {
    code: 'PURCHASE_DOCUMENT',
    name: '매입전표 결재',
    category: 'PURCHASE',
    targetType: 'PURCHASE_DOCUMENT',
    fields: [
      { key: 'docNo', label: '전표번호', type: 'text', required: true, max: 30 },
      { key: 'partner', label: '매입처', type: 'text', required: true, max: 100 },
      { key: 'amount', label: '합계금액', type: 'money', required: true },
      { key: 'note', label: '상신사유', type: 'textarea', max: 500 },
    ],
  },
  {
    code: 'STOCK_DOCUMENT',
    name: '재고전표 결재',
    category: 'INVENTORY',
    targetType: 'STOCK_DOCUMENT',
    fields: [
      { key: 'docNo', label: '전표번호', type: 'text', required: true, max: 30 },
      { key: 'warehouse', label: '창고', type: 'text', required: true, max: 100 },
      { key: 'amount', label: '금액', type: 'money', required: true },
      { key: 'note', label: '상신사유', type: 'textarea', max: 500 },
    ],
  },
  {
    code: 'JOURNAL_ENTRY',
    name: '수동전표 결재',
    category: 'ACCOUNTING',
    targetType: 'JOURNAL_ENTRY',
    fields: [
      { key: 'entryNo', label: '전표번호', type: 'text', required: true, max: 30 },
      { key: 'entryDate', label: '전표일자', type: 'date', required: true },
      { key: 'amount', label: '차변합계', type: 'money', required: true },
      { key: 'note', label: '상신사유', type: 'textarea', max: 500 },
    ],
  },
  {
    code: 'ATTENDANCE_CORRECTION',
    name: '근태정정신청서',
    category: 'HR',
    targetType: 'ATTENDANCE_CORRECTION',
    fields: [
      { key: 'workDate', label: '근무일', type: 'date', required: true },
      { key: 'requestedCheckIn', label: '출근시각', type: 'text', max: 5 },
      { key: 'requestedCheckOut', label: '퇴근시각', type: 'text', max: 5 },
      { key: 'reason', label: '정정사유', type: 'textarea', required: true, max: 500 },
    ],
  },
];

/** Idempotent bootstrap used by the seed and by tests. */
export async function ensureDefaultForms(ctx: TransactionContext): Promise<void> {
  const effectiveFrom = toDateOnly('2020-01-01');
  for (const [index, def] of DEFAULT_FORMS.entries()) {
    const form = await ctx.tx.approvalForm.upsert({
      where: { code: def.code },
      create: {
        code: def.code,
        name: def.name,
        category: def.category,
        targetType: def.targetType ?? null,
        sortOrder: index,
      },
      update: {
        name: def.name,
        category: def.category,
        targetType: def.targetType ?? null,
        sortOrder: index,
      },
    });
    const existing = await ctx.tx.approvalFormVersion.findFirst({ where: { formId: form.id } });
    if (existing) continue;
    await ctx.tx.approvalFormVersion.create({
      data: { formId: form.id, version: 1, fieldSchema: def.fields as never, effectiveFrom },
    });
  }
}

export function currentDate(ctx: TransactionContext): string {
  return businessDate(ctx.now);
}
