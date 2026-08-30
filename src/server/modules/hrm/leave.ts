import type { TransactionContext } from '@/server/core/context';
import { AppError } from '@/server/core/errors';
import { assertHrScope, has, requirePermission } from '@/server/modules/rbac/service';
import * as audit from '@/server/modules/audit/service';
import * as policy from '@/server/modules/policy/service';
import type { LeavePolicyConfig } from '@/server/modules/policy/service';
import { accrue, balance } from './leave-policy';
import { cmp, D, sub } from '@/lib/money';
import { addDays, businessDate, fromDateOnly, isWeekend, toDateOnly } from '@/lib/dates';

/**
 * HRM-05 / HRM-06. Grants and usages are ledgers (append-only, DB-enforced): a cancelled
 * leave produces a negative usage row rather than deleting the original.
 */

export async function grantAnnual(
  ctx: TransactionContext,
  input: { employeeId: string; asOf?: string; fullAttendanceMonths?: number },
) {
  requirePermission(ctx.actor, 'hr.leave');
  const asOf = input.asOf ?? businessDate(ctx.now);
  const employee = await ctx.tx.employee.findUniqueOrThrow({ where: { id: input.employeeId } });
  const resolved = await policy.resolve<LeavePolicyConfig>(ctx, policy.PolicyKeys.leave, asOf);

  const { attendanceRate } = await import('./attendance');
  const hireDate = fromDateOnly(employee.hireDate);
  const rate = await attendanceRate(ctx, input.employeeId, hireDate, asOf);

  const result = accrue(resolved.config, {
    hireDate,
    asOf,
    attendanceRate: rate.rate,
    ...(input.fullAttendanceMonths !== undefined ? { fullAttendanceMonths: input.fullAttendanceMonths } : {}),
  });

  if (cmp(result.days, '0') <= 0) {
    return { granted: false, ...result };
  }

  // one grant per accrual year — re-running the job must not double-grant
  const existing = await ctx.tx.leaveGrant.findFirst({
    where: { employeeId: input.employeeId, leaveType: 'ANNUAL', grantDate: toDateOnly(result.accrualStart) },
  });
  if (existing) return { granted: false, ...result, reason: '해당 산정연도의 부여가 이미 존재합니다.' };

  await ctx.tx.leaveGrant.create({
    data: {
      employeeId: input.employeeId,
      leaveType: 'ANNUAL',
      days: result.days,
      grantDate: toDateOnly(result.accrualStart),
      expiresAt: toDateOnly(result.expiresAt),
      policyVersionId: resolved.id,
      reason: result.reason,
      sourceType: 'POLICY',
      sourceId: `${input.employeeId}:${result.accrualStart}`,
    },
  });

  await audit.record(ctx, {
    action: 'leave.grant',
    entityType: 'LeaveGrant',
    entityId: `${input.employeeId}:${result.accrualStart}`,
    after: {
      days: result.days,
      accrualStart: result.accrualStart,
      expiresAt: result.expiresAt,
      policyVersion: resolved.version,
    },
  });

  return { granted: true, ...result };
}

export async function grantManual(
  ctx: TransactionContext,
  input: {
    employeeId: string;
    leaveType?: string;
    days: string;
    grantDate: string;
    expiresAt: string;
    reason: string;
  },
) {
  requirePermission(ctx.actor, 'hr.leave');
  const grant = await ctx.tx.leaveGrant.create({
    data: {
      employeeId: input.employeeId,
      leaveType: input.leaveType ?? 'ANNUAL',
      days: input.days,
      grantDate: toDateOnly(input.grantDate),
      expiresAt: toDateOnly(input.expiresAt),
      reason: input.reason,
      sourceType: 'MANUAL',
      sourceId: `${input.employeeId}:${input.grantDate}:${ctx.requestId}`,
    },
  });
  await audit.record(ctx, {
    action: 'leave.grantManual',
    entityType: 'LeaveGrant',
    entityId: grant.id,
    after: { employeeId: input.employeeId, days: input.days, reason: input.reason },
  });
  return grant;
}

export async function balanceOf(
  ctx: TransactionContext,
  employeeId: string,
  asOf?: string,
  leaveType = 'ANNUAL',
) {
  assertHrScope(ctx.actor, employeeId);
  const date = asOf ?? businessDate(ctx.now);
  const [grants, usages] = await Promise.all([
    ctx.tx.leaveGrant.findMany({ where: { employeeId, leaveType }, orderBy: { grantDate: 'asc' } }),
    ctx.tx.leaveUsage.findMany({ where: { employeeId, leaveType }, orderBy: { usageDate: 'asc' } }),
  ]);

  const result = balance(
    grants.map((g) => ({ days: g.days.toString(), expiresAt: fromDateOnly(g.expiresAt) })),
    usages.map((u) => ({ days: u.days.toString() })),
    date,
  );

  return {
    ...result,
    asOf: date,
    grants: grants.map((g) => ({
      id: g.id,
      days: g.days.toString(),
      grantDate: fromDateOnly(g.grantDate),
      expiresAt: fromDateOnly(g.expiresAt),
      reason: g.reason,
    })),
    usages: usages.map((u) => ({
      id: u.id,
      days: u.days.toString(),
      usageDate: fromDateOnly(u.usageDate),
      sourceType: u.sourceType,
      reversalOfId: u.reversalOfId,
    })),
  };
}

/** Working days between two dates, excluding weekends; half-day requests count as 0.5. */
export function workingDays(start: string, end: string, halfDay?: 'AM' | 'PM' | null): string {
  if (halfDay) {
    if (start !== end) throw new AppError('VALIDATION', '반차는 하루만 신청할 수 있습니다.');
    return '0.5';
  }
  let days = 0;
  for (let d = start; d <= end; d = addDays(d, 1)) if (!isWeekend(d)) days++;
  return D(days).toFixed(1);
}

export async function requestLeave(
  ctx: TransactionContext,
  input: {
    docNo: string;
    employeeId?: string;
    leaveType?: string;
    startDate: string;
    endDate: string;
    halfDay?: 'AM' | 'PM';
    reason?: string;
  },
) {
  const employeeId = input.employeeId ?? ctx.actor.employeeId;
  if (!employeeId) throw new AppError('NOT_FOUND', '연결된 사원정보가 없습니다.');
  assertHrScope(ctx.actor, employeeId);
  if (input.endDate < input.startDate)
    throw new AppError('VALIDATION', '종료일은 시작일보다 빠를 수 없습니다.');

  const days = workingDays(input.startDate, input.endDate, input.halfDay ?? null);
  if (cmp(days, '0') <= 0) throw new AppError('VALIDATION', '신청 기간에 근무일이 없습니다.');

  // overlapping live requests would double-count the balance
  const overlap = await ctx.tx.leaveRequest.findFirst({
    where: {
      employeeId,
      status: { in: ['DRAFT', 'PENDING_APPROVAL', 'APPROVED'] },
      startDate: { lte: toDateOnly(input.endDate) },
      endDate: { gte: toDateOnly(input.startDate) },
    },
  });
  if (overlap) throw new AppError('CONFLICT', `이미 신청된 휴가와 기간이 겹칩니다 (${overlap.docNo}).`);

  const current = await balanceOf(ctx, employeeId, input.startDate, input.leaveType ?? 'ANNUAL');
  if (cmp(days, current.remaining) > 0) {
    throw new AppError('VALIDATION', `잔여 연차(${current.remaining}일)를 초과했습니다. 신청 ${days}일.`);
  }

  const request = await ctx.tx.leaveRequest.create({
    data: {
      docNo: input.docNo,
      employeeId,
      leaveType: input.leaveType ?? 'ANNUAL',
      startDate: toDateOnly(input.startDate),
      endDate: toDateOnly(input.endDate),
      days,
      halfDay: input.halfDay ?? null,
      reason: input.reason ?? null,
    },
  });

  await audit.record(ctx, {
    action: 'leave.request',
    entityType: 'LeaveRequest',
    entityId: request.id,
    after: { docNo: input.docNo, employeeId, startDate: input.startDate, endDate: input.endDate, days },
  });
  return request;
}

/**
 * APV-09 / E2E-03: called from the approval callback inside the same transaction.
 * Writes the usage ledger and marks the attendance rows in one shot.
 */
export async function applyApprovedLeave(ctx: TransactionContext, leaveRequestId: string) {
  const request = await ctx.tx.leaveRequest.findUniqueOrThrow({ where: { id: leaveRequestId } });
  if (request.status === 'APPROVED') throw new AppError('DUPLICATE_EFFECT', '이미 반영된 휴가신청입니다.');

  const current = await balanceOf(
    ctx,
    request.employeeId,
    fromDateOnly(request.startDate),
    request.leaveType,
  );
  if (cmp(request.days.toString(), current.remaining) > 0) {
    throw new AppError('VALIDATION', `잔여 연차(${current.remaining}일)를 초과하여 승인할 수 없습니다.`);
  }

  await ctx.tx.leaveUsage.create({
    data: {
      employeeId: request.employeeId,
      leaveType: request.leaveType,
      days: request.days,
      usageDate: request.startDate,
      leaveRequestId: request.id,
      sourceType: 'REQUEST',
      sourceId: request.id,
    },
  });

  // HRM-06: attendance reflects the leave for every affected working day
  const start = fromDateOnly(request.startDate);
  const end = fromDateOnly(request.endDate);
  const status = request.halfDay ? 'HALF_LEAVE' : 'LEAVE';
  for (let d = start; d <= end; d = addDays(d, 1)) {
    if (isWeekend(d)) continue;
    await ctx.tx.attendance.upsert({
      where: { employeeId_workDate: { employeeId: request.employeeId, workDate: toDateOnly(d) } },
      create: {
        employeeId: request.employeeId,
        workDate: toDateOnly(d),
        status,
        source: 'LEAVE',
        note: `${request.docNo} ${request.leaveType}`,
      },
      update: {
        status,
        source: 'LEAVE',
        note: `${request.docNo} ${request.leaveType}`,
        version: { increment: 1 },
      },
    });
  }

  await ctx.tx.leaveRequest.update({
    where: { id: leaveRequestId },
    data: { status: 'APPROVED', version: { increment: 1 } },
  });

  await audit.record(ctx, {
    action: 'leave.apply',
    entityType: 'LeaveRequest',
    entityId: leaveRequestId,
    after: { employeeId: request.employeeId, days: request.days.toString(), start, end },
  });
}

/** Cancellation writes a negative usage row; the original ledger row is never touched (INT-07). */
export async function cancelApprovedLeave(ctx: TransactionContext, leaveRequestId: string, reason: string) {
  const request = await ctx.tx.leaveRequest.findUniqueOrThrow({ where: { id: leaveRequestId } });
  if (request.status !== 'APPROVED')
    throw new AppError('INVALID_TRANSITION', '승인된 휴가만 취소할 수 있습니다.');

  const original = await ctx.tx.leaveUsage.findFirst({
    where: { leaveRequestId, sourceType: 'REQUEST' },
  });
  if (!original) throw new AppError('NOT_FOUND', '연결된 사용원장을 찾을 수 없습니다.');

  const alreadyReversed = await ctx.tx.leaveUsage.findFirst({ where: { reversalOfId: original.id } });
  if (alreadyReversed) throw new AppError('DUPLICATE_EFFECT', '이미 취소된 휴가입니다.');

  await ctx.tx.leaveUsage.create({
    data: {
      employeeId: request.employeeId,
      leaveType: request.leaveType,
      days: sub('0', request.days.toString()).toFixed(1),
      usageDate: request.startDate,
      leaveRequestId: request.id,
      reversalOfId: original.id,
      sourceType: 'REVERSAL',
      sourceId: `${request.id}:reversal`,
    },
  });

  const start = fromDateOnly(request.startDate);
  const end = fromDateOnly(request.endDate);
  for (let d = start; d <= end; d = addDays(d, 1)) {
    if (isWeekend(d)) continue;
    await ctx.tx.attendance.updateMany({
      where: { employeeId: request.employeeId, workDate: toDateOnly(d), source: 'LEAVE' },
      data: { status: 'NORMAL', source: 'WEB', note: `${request.docNo} 취소: ${reason}` },
    });
  }

  await ctx.tx.leaveRequest.update({
    where: { id: leaveRequestId },
    data: { status: 'CANCELED', version: { increment: 1 } },
  });

  await audit.record(ctx, {
    action: 'leave.cancel',
    entityType: 'LeaveRequest',
    entityId: leaveRequestId,
    after: { reason, reversedDays: request.days.toString() },
  });
}

export async function rejectLeave(ctx: TransactionContext, leaveRequestId: string) {
  await ctx.tx.leaveRequest.update({
    where: { id: leaveRequestId },
    data: { status: 'REJECTED', version: { increment: 1 } },
  });
}

export async function listRequests(
  ctx: TransactionContext,
  input: { employeeId?: string; status?: string; from?: string; to?: string; skip: number; take: number },
) {
  const canSeeAll = has(ctx.actor, 'hr.leave') || has(ctx.actor, 'hr.read');
  if (input.employeeId) assertHrScope(ctx.actor, input.employeeId);

  const where = {
    ...(input.employeeId
      ? { employeeId: input.employeeId }
      : canSeeAll
        ? {}
        : { employeeId: ctx.actor.employeeId ?? '__none__' }),
    ...(input.status ? { status: input.status } : {}),
    ...(input.from ? { endDate: { gte: toDateOnly(input.from) } } : {}),
    ...(input.to ? { startDate: { lte: toDateOnly(input.to) } } : {}),
  };

  const [rows, total] = await Promise.all([
    ctx.tx.leaveRequest.findMany({
      where,
      include: { employee: { select: { employeeNo: true, name: true } } },
      orderBy: { startDate: 'desc' },
      skip: input.skip,
      take: input.take,
    }),
    ctx.tx.leaveRequest.count({ where }),
  ]);
  return { rows, total };
}

/** HRM-05: expire grants past their validity, as an explicit negative-grant ledger row. */
export async function expireGrants(ctx: TransactionContext, asOf?: string) {
  requirePermission(ctx.actor, 'hr.leave');
  const date = asOf ?? businessDate(ctx.now);

  const expired = await ctx.tx.leaveGrant.findMany({
    where: { expiresAt: { lt: toDateOnly(date) }, sourceType: { not: 'EXPIRY' } },
  });

  let count = 0;
  for (const grant of expired) {
    const already = await ctx.tx.leaveGrant.findFirst({
      where: { sourceType: 'EXPIRY', sourceId: grant.id },
    });
    if (already) continue;
    await ctx.tx.leaveGrant.create({
      data: {
        employeeId: grant.employeeId,
        leaveType: grant.leaveType,
        days: sub('0', grant.days.toString()).toFixed(1),
        grantDate: grant.expiresAt,
        expiresAt: grant.expiresAt,
        reason: `유효기간 만료 (${fromDateOnly(grant.expiresAt)})`,
        sourceType: 'EXPIRY',
        sourceId: grant.id,
      },
    });
    count++;
  }
  return { expired: count };
}

/** RPT-10 input: leave usage rate per employee for a period. */
export async function usageSummary(ctx: TransactionContext, from: string, to: string) {
  requirePermission(ctx.actor, 'hr.read');
  const usages = await ctx.tx.leaveUsage.groupBy({
    by: ['employeeId'],
    where: { usageDate: { gte: toDateOnly(from), lte: toDateOnly(to) } },
    _sum: { days: true },
  });
  const grants = await ctx.tx.leaveGrant.groupBy({
    by: ['employeeId'],
    where: { grantDate: { lte: toDateOnly(to) }, expiresAt: { gte: toDateOnly(from) } },
    _sum: { days: true },
  });
  const grantMap = new Map(grants.map((g) => [g.employeeId, g._sum.days?.toString() ?? '0']));

  return usages.map((u) => {
    const granted = grantMap.get(u.employeeId) ?? '0';
    const used = u._sum.days?.toString() ?? '0';
    return {
      employeeId: u.employeeId,
      granted,
      used,
      remaining: sub(granted, used).toFixed(1),
      rate: cmp(granted, '0') > 0 ? Number(D(used).div(D(granted)).toFixed(4)) : 0,
    };
  });
}
