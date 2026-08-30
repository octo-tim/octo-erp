import type { TransactionContext } from '@/server/core/context';
import { AppError } from '@/server/core/errors';
import { requirePermission } from '@/server/modules/rbac/service';
import * as audit from '@/server/modules/audit/service';
import { businessDate, fromDateOnly, toDateOnly } from '@/lib/dates';

/**
 * HRM-02 / HRM-03: organisation and assignments are effective-dated, so the org chart
 * and each employee's department/position can be reproduced for any past date (B-15).
 */

export interface DepartmentNode {
  id: string;
  code: string;
  name: string;
  parentId: string | null;
  headEmployeeId: string | null;
  sortOrder: number;
  children: DepartmentNode[];
}

/** Org chart as it stood on `asOf` (defaults to today, KST). */
export async function chart(ctx: TransactionContext, asOf?: string): Promise<DepartmentNode[]> {
  requirePermission(ctx.actor, 'hr.self');
  const date = toDateOnly(asOf ?? businessDate(ctx.now));

  const departments = await ctx.tx.department.findMany({
    where: {
      validFrom: { lte: date },
      OR: [{ validTo: null }, { validTo: { gte: date } }],
    },
    orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }],
  });

  const byId = new Map<string, DepartmentNode>();
  for (const d of departments) {
    byId.set(d.id, {
      id: d.id,
      code: d.code,
      name: d.name,
      parentId: d.parentId,
      headEmployeeId: d.headEmployeeId,
      sortOrder: d.sortOrder,
      children: [],
    });
  }
  const roots: DepartmentNode[] = [];
  for (const node of byId.values()) {
    const parent = node.parentId ? byId.get(node.parentId) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  return roots;
}

export async function createDepartment(
  ctx: TransactionContext,
  input: {
    code: string;
    name: string;
    parentId?: string;
    headEmployeeId?: string;
    validFrom: string;
    sortOrder?: number;
  },
) {
  requirePermission(ctx.actor, 'hr.write');
  const department = await ctx.tx.department.create({
    data: {
      code: input.code,
      name: input.name,
      parentId: input.parentId ?? null,
      headEmployeeId: input.headEmployeeId ?? null,
      validFrom: toDateOnly(input.validFrom),
      sortOrder: input.sortOrder ?? 0,
    },
  });
  await ctx.tx.departmentHistory.create({
    data: {
      departmentId: department.id,
      changeType: 'CREATED',
      snapshot: { code: input.code, name: input.name, parentId: input.parentId ?? null } as never,
      effectiveDate: toDateOnly(input.validFrom),
    },
  });
  await audit.record(ctx, {
    action: 'department.create',
    entityType: 'Department',
    entityId: department.id,
    after: { code: input.code, name: input.name, parentId: input.parentId },
  });
  return department;
}

/**
 * HRM-02: a reorganisation closes the old shape at `effectiveDate` and records the change,
 * so a query for an earlier date still returns the previous structure.
 */
export async function reorganize(
  ctx: TransactionContext,
  input: {
    departmentId: string;
    effectiveDate: string;
    name?: string;
    parentId?: string | null;
    headEmployeeId?: string | null;
    close?: boolean;
  },
) {
  requirePermission(ctx.actor, 'hr.write');
  const before = await ctx.tx.department.findUniqueOrThrow({ where: { id: input.departmentId } });
  const effective = toDateOnly(input.effectiveDate);

  if (effective < before.validFrom) {
    throw new AppError('VALIDATION', '개편 시행일은 부서 유효 시작일보다 빠를 수 없습니다.');
  }

  if (input.close) {
    const staff = await ctx.tx.employee.count({
      where: { departmentId: input.departmentId, status: { not: 'RESIGNED' } },
    });
    if (staff > 0) {
      throw new AppError(
        'CONFLICT',
        `소속 인원 ${staff}명이 남아 있어 폐지할 수 없습니다. 먼저 발령으로 이동시키세요.`,
      );
    }
    await ctx.tx.department.update({
      where: { id: input.departmentId },
      data: { validTo: effective, isActive: false },
    });
  } else {
    await ctx.tx.department.update({
      where: { id: input.departmentId },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.parentId !== undefined ? { parentId: input.parentId } : {}),
        ...(input.headEmployeeId !== undefined ? { headEmployeeId: input.headEmployeeId } : {}),
      },
    });
  }

  await ctx.tx.departmentHistory.create({
    data: {
      departmentId: input.departmentId,
      changeType: input.close
        ? 'CLOSED'
        : input.parentId !== undefined
          ? 'MOVED'
          : input.name !== undefined
            ? 'RENAMED'
            : 'HEAD_CHANGED',
      snapshot: {
        before: { name: before.name, parentId: before.parentId, headEmployeeId: before.headEmployeeId },
        after: {
          name: input.name ?? before.name,
          parentId: input.parentId ?? before.parentId,
          headEmployeeId: input.headEmployeeId ?? before.headEmployeeId,
        },
      } as never,
      effectiveDate: effective,
    },
  });

  await audit.record(ctx, {
    action: 'department.reorganize',
    entityType: 'Department',
    entityId: input.departmentId,
    before: { name: before.name, parentId: before.parentId },
    after: {
      name: input.name ?? before.name,
      parentId: input.parentId ?? before.parentId,
      closed: !!input.close,
    },
  });
}

export async function departmentHistory(ctx: TransactionContext, departmentId?: string) {
  requirePermission(ctx.actor, 'hr.read');
  return ctx.tx.departmentHistory.findMany({
    where: departmentId ? { departmentId } : {},
    include: { department: { select: { code: true, name: true } } },
    orderBy: [{ effectiveDate: 'desc' }, { createdAt: 'desc' }],
    take: 500,
  });
}

export type AssignmentType = 'HIRE' | 'PROMOTION' | 'TRANSFER' | 'LEAVE_OF_ABSENCE' | 'RETURN' | 'RESIGN';

/**
 * HRM-03: an assignment closes the previous one and updates the employee's current
 * fields in the same transaction, so "current" and "history" can never disagree.
 */
export async function assign(
  ctx: TransactionContext,
  input: {
    employeeId: string;
    type: AssignmentType;
    effectiveFrom: string;
    departmentId?: string;
    positionCode?: string;
    jobTitle?: string;
    employmentType?: string;
    note?: string;
    approvalDocId?: string;
  },
) {
  requirePermission(ctx.actor, 'hr.write');
  const employee = await ctx.tx.employee.findUniqueOrThrow({ where: { id: input.employeeId } });
  const effective = toDateOnly(input.effectiveFrom);

  if (effective < employee.hireDate) {
    throw new AppError('VALIDATION', '발령일은 입사일보다 빠를 수 없습니다.');
  }
  if (employee.status === 'RESIGNED') {
    throw new AppError('CONFLICT', '퇴사한 사원에게는 발령을 낼 수 없습니다.');
  }

  await ctx.tx.assignment.updateMany({
    where: { employeeId: input.employeeId, effectiveTo: null, effectiveFrom: { lt: effective } },
    data: { effectiveTo: effective },
  });

  const assignment = await ctx.tx.assignment.create({
    data: {
      employeeId: input.employeeId,
      type: input.type,
      departmentId: input.departmentId ?? employee.departmentId,
      positionCode: input.positionCode ?? employee.positionCode,
      jobTitle: input.jobTitle ?? employee.jobTitle,
      employmentType: input.employmentType ?? employee.employmentType,
      effectiveFrom: effective,
      note: input.note ?? null,
      approvalDocId: input.approvalDocId ?? null,
      createdById: ctx.actor.userId,
    },
  });

  const status =
    input.type === 'LEAVE_OF_ABSENCE' ? 'ON_LEAVE' : input.type === 'RETURN' ? 'ACTIVE' : employee.status;
  await ctx.tx.employee.update({
    where: { id: input.employeeId },
    data: {
      departmentId: input.departmentId ?? employee.departmentId,
      positionCode: input.positionCode ?? employee.positionCode,
      jobTitle: input.jobTitle ?? employee.jobTitle,
      employmentType: input.employmentType ?? employee.employmentType,
      status,
      version: { increment: 1 },
    },
  });

  await audit.record(ctx, {
    action: 'assignment.create',
    entityType: 'Assignment',
    entityId: assignment.id,
    after: {
      employeeId: input.employeeId,
      type: input.type,
      effectiveFrom: input.effectiveFrom,
      departmentId: input.departmentId,
      jobTitle: input.jobTitle,
    },
  });

  return assignment;
}

/** B-15: what department/position did this employee hold on `asOf`? */
export async function positionAt(ctx: TransactionContext, employeeId: string, asOf: string) {
  const date = toDateOnly(asOf);
  const assignment = await ctx.tx.assignment.findFirst({
    where: {
      employeeId,
      effectiveFrom: { lte: date },
      OR: [{ effectiveTo: null }, { effectiveTo: { gt: date } }],
    },
    include: { department: { select: { id: true, code: true, name: true } } },
    orderBy: { effectiveFrom: 'desc' },
  });
  if (!assignment) return null;
  return {
    assignmentId: assignment.id,
    type: assignment.type,
    departmentId: assignment.departmentId,
    departmentName: assignment.department?.name ?? null,
    positionCode: assignment.positionCode,
    jobTitle: assignment.jobTitle,
    employmentType: assignment.employmentType,
    effectiveFrom: fromDateOnly(assignment.effectiveFrom),
    effectiveTo: assignment.effectiveTo ? fromDateOnly(assignment.effectiveTo) : null,
  };
}

export async function assignmentHistory(ctx: TransactionContext, employeeId: string) {
  const { assertHrScope } = await import('@/server/modules/rbac/service');
  assertHrScope(ctx.actor, employeeId);
  return ctx.tx.assignment.findMany({
    where: { employeeId },
    include: { department: { select: { code: true, name: true } } },
    orderBy: { effectiveFrom: 'desc' },
  });
}
