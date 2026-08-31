import type { TransactionContext } from '@/server/core/context';
import { AppError } from '@/server/core/errors';
import { cmp } from '@/lib/money';
import { toDateOnly } from '@/lib/dates';

/**
 * APV-03/04/05: turning a line template plus the document's facts (division, department,
 * amount) into the concrete approver list, applying amount branching, delegation and
 * 전결 (a step allowed to finalise without the steps above it).
 */
export type StepRole = 'APPROVE' | 'AGREE' | 'REFERENCE';

export interface ResolvedStep {
  stepNo: number;
  role: StepRole;
  approverId: string;
  /** set when a delegation redirected this step to a deputy */
  actedByUserId?: string;
  canFinalize: boolean;
}

export interface LineContext {
  drafterId: string;
  drafterEmployeeId: string | null;
  departmentId: string | null;
  divisionId: string | null;
  amount: string | null;
  onDate: string;
}

/** APV-04: the deputy standing in for `userId` on `onDate`, if any. */
export async function resolveDelegate(
  ctx: TransactionContext,
  userId: string,
  onDate: string,
): Promise<string | null> {
  const date = toDateOnly(onDate);
  const delegation = await ctx.tx.delegation.findFirst({
    where: { fromUserId: userId, isActive: true, validFrom: { lte: date }, validTo: { gte: date } },
    orderBy: { validFrom: 'desc' },
  });
  return delegation?.toUserId ?? null;
}

async function resolveApprover(
  ctx: TransactionContext,
  step: {
    resolveBy: string;
    userId: string | null;
    positionCode: string | null;
    departmentId: string | null;
  },
  line: LineContext,
): Promise<string | null> {
  switch (step.resolveBy) {
    case 'USER':
      return step.userId;

    case 'DEPARTMENT_HEAD': {
      const departmentId = step.departmentId ?? line.departmentId;
      if (!departmentId) return null;
      const department = await ctx.tx.department.findUnique({ where: { id: departmentId } });
      if (!department?.headEmployeeId) return null;
      const user = await ctx.tx.user.findUnique({ where: { employeeId: department.headEmployeeId } });
      return user?.id ?? null;
    }

    case 'DRAFTER_MANAGER': {
      if (!line.drafterEmployeeId) return null;
      const employee = await ctx.tx.employee.findUnique({ where: { id: line.drafterEmployeeId } });
      if (!employee?.departmentId) return null;
      const department = await ctx.tx.department.findUnique({ where: { id: employee.departmentId } });
      if (!department?.headEmployeeId || department.headEmployeeId === line.drafterEmployeeId) return null;
      const user = await ctx.tx.user.findUnique({ where: { employeeId: department.headEmployeeId } });
      return user?.id ?? null;
    }

    case 'POSITION': {
      if (!step.positionCode) return null;
      const employee = await ctx.tx.employee.findFirst({
        where: {
          positionCode: step.positionCode,
          status: 'ACTIVE',
          ...(step.departmentId ? { departmentId: step.departmentId } : {}),
        },
        orderBy: { hireDate: 'asc' },
      });
      if (!employee) return null;
      const user = await ctx.tx.user.findUnique({ where: { employeeId: employee.id } });
      return user?.id ?? null;
    }

    default:
      return null;
  }
}

/**
 * Builds the approval line. Steps whose `minAmount` exceeds the document amount are
 * dropped (APV-05); unresolvable steps are dropped with the reason recorded, and a line
 * that ends up with no APPROVE step is rejected rather than silently auto-approving.
 */
export async function buildLine(
  ctx: TransactionContext,
  templateId: string,
  line: LineContext,
): Promise<{ steps: ResolvedStep[]; skipped: { stepNo: number; reason: string }[] }> {
  const template = await ctx.tx.approvalLineTemplate.findUnique({
    where: { id: templateId },
    include: { steps: { orderBy: { stepNo: 'asc' } } },
  });
  if (!template) throw new AppError('NOT_FOUND', '결재선 서식을 찾을 수 없습니다.');
  if (!template.isActive) throw new AppError('VALIDATION', '사용 중지된 결재선 서식입니다.');

  const steps: ResolvedStep[] = [];
  const skipped: { stepNo: number; reason: string }[] = [];
  let stepNo = 0;

  for (const templateStep of template.steps) {
    // APV-05: amount branching
    if (templateStep.minAmount !== null) {
      if (line.amount === null || cmp(line.amount, templateStep.minAmount.toString()) < 0) {
        skipped.push({
          stepNo: templateStep.stepNo,
          reason: `금액 기준(${templateStep.minAmount.toString()}원) 미만`,
        });
        continue;
      }
    }

    const approverId = await resolveApprover(ctx, templateStep, line);
    if (!approverId) {
      skipped.push({
        stepNo: templateStep.stepNo,
        reason: `결재자를 확정할 수 없음 (${templateStep.resolveBy})`,
      });
      continue;
    }

    // the drafter never approves their own document
    if (approverId === line.drafterId && templateStep.role !== 'REFERENCE') {
      skipped.push({ stepNo: templateStep.stepNo, reason: '기안자 본인' });
      continue;
    }

    // APV-04: delegation redirects the action, but the assigned approver is preserved
    const delegate = await resolveDelegate(ctx, approverId, line.onDate);

    stepNo += 1;
    steps.push({
      stepNo,
      role: templateStep.role as StepRole,
      approverId,
      ...(delegate ? { actedByUserId: delegate } : {}),
      canFinalize: templateStep.canFinalize,
    });
  }

  if (!steps.some((s) => s.role === 'APPROVE' || s.role === 'AGREE')) {
    throw new AppError('VALIDATION', '승인 단계가 없는 결재선입니다. 결재선 설정을 확인하세요.', { skipped });
  }

  return { steps, skipped };
}

/**
 * APV-03: builds the line from a drafter-supplied override instead of the template.
 * Only called when the caller has already checked `ApprovalLineTemplate.editable` — this
 * function itself does not know or care which template the drafter started from, it only
 * validates the shape of a hand-picked line the same way a generated one is validated:
 * at least one APPROVE/AGREE step, no self-approval, and a real, active approver per step.
 * Delegation (APV-04) still applies so a manually chosen approver who is currently away is
 * still redirected to their deputy, same as a generated line.
 */
export async function buildOverrideLine(
  ctx: TransactionContext,
  input: {
    drafterId: string;
    onDate: string;
    override: { approverId: string; role: StepRole }[];
  },
): Promise<ResolvedStep[]> {
  if (input.override.length === 0) {
    throw new AppError('VALIDATION', '결재선에는 최소 1명 이상의 결재자가 필요합니다.');
  }
  if (!input.override.some((s) => s.role === 'APPROVE' || s.role === 'AGREE')) {
    throw new AppError(
      'VALIDATION',
      '승인 단계가 없는 결재선입니다. 결재 또는 합의 단계를 하나 이상 넣으세요.',
    );
  }

  const steps: ResolvedStep[] = [];
  let stepNo = 0;
  for (const s of input.override) {
    if (s.approverId === input.drafterId && s.role !== 'REFERENCE') {
      throw new AppError('VALIDATION', '기안자 본인을 결재자로 지정할 수 없습니다.');
    }
    const approver = await ctx.tx.user.findUnique({ where: { id: s.approverId } });
    if (!approver?.isActive) {
      throw new AppError('VALIDATION', `사용할 수 없는 결재자입니다: ${s.approverId}`);
    }

    const delegate = await resolveDelegate(ctx, s.approverId, input.onDate);
    stepNo += 1;
    steps.push({
      stepNo,
      role: s.role,
      approverId: s.approverId,
      ...(delegate ? { actedByUserId: delegate } : {}),
      // a manually edited line does not carry 전결 — it always runs to its last step
      canFinalize: false,
    });
  }

  return steps;
}

/** APV-03/05: picks the highest-priority rule whose conditions all match. */
export async function selectLineTemplate(
  ctx: TransactionContext,
  input: { formId: string; divisionId: string | null; departmentId: string | null; amount: string | null },
): Promise<string> {
  const rules = await ctx.tx.approvalRule.findMany({
    where: { isActive: true, OR: [{ formId: input.formId }, { formId: null }] },
    orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }],
  });

  for (const rule of rules) {
    if (rule.divisionId && rule.divisionId !== input.divisionId) continue;
    if (rule.departmentId && rule.departmentId !== input.departmentId) continue;
    if (
      rule.minAmount !== null &&
      (input.amount === null || cmp(input.amount, rule.minAmount.toString()) < 0)
    )
      continue;
    if (rule.maxAmount !== null && input.amount !== null && cmp(input.amount, rule.maxAmount.toString()) > 0)
      continue;
    return rule.lineTemplateId;
  }

  throw new AppError('VALIDATION', '적용할 결재선 규칙이 없습니다. 결재선·전결 설정에서 규칙을 등록하세요.', {
    formId: input.formId,
    amount: input.amount,
  });
}

/**
 * The steps that must act before the document can advance past `currentStepNo`.
 * Parallel AGREE steps sharing a step number act together; APPROVE steps are sequential.
 */
export function pendingStepNumbers(steps: { stepNo: number; role: string; status: string }[]): number[] {
  const actionable = steps.filter((s) => s.role !== 'REFERENCE');
  const firstPending = actionable.find((s) => s.status === 'PENDING');
  if (!firstPending) return [];

  // an AGREE block is every consecutive AGREE step starting at the first pending one
  if (firstPending.role === 'AGREE') {
    const block: number[] = [];
    for (const s of actionable) {
      if (s.stepNo < firstPending.stepNo) continue;
      if (s.role !== 'AGREE') break;
      if (s.status === 'PENDING') block.push(s.stepNo);
    }
    return block;
  }
  return [firstPending.stepNo];
}
