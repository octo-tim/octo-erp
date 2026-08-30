import type { TransactionContext } from '@/server/core/context';
import { AppError } from '@/server/core/errors';
import { assertHrScope, has, requirePermission } from '@/server/modules/rbac/service';
import * as audit from '@/server/modules/audit/service';
import * as policy from '@/server/modules/policy/service';
import type { LeavePolicyConfig } from '@/server/modules/policy/service';
import { classifyWork, overtimeWarning } from './leave-policy';
import { addDays, businessDate, fromDateOnly, isWeekend, toDateOnly } from '@/lib/dates';

/** HRM-04, HRM-07. Attendance rows are mutable until a correction is approved; the
 *  correction request itself is an approval target (STEP 5 wires the callback). */

export type AttendanceStatus =
  'NORMAL' | 'LATE' | 'EARLY_LEAVE' | 'ABSENT' | 'LEAVE' | 'HALF_LEAVE' | 'HOLIDAY' | 'BUSINESS_TRIP';

export async function checkIn(ctx: TransactionContext, input: { employeeId?: string; at?: Date }) {
  const employeeId = input.employeeId ?? ctx.actor.employeeId;
  if (!employeeId) throw new AppError('NOT_FOUND', '연결된 사원정보가 없습니다.');
  if (employeeId !== ctx.actor.employeeId) requirePermission(ctx.actor, 'hr.attendance');

  const at = input.at ?? ctx.now;
  const workDate = businessDate(at);

  const existing = await ctx.tx.attendance.findUnique({
    where: { employeeId_workDate: { employeeId, workDate: toDateOnly(workDate) } },
  });
  if (existing?.checkIn) throw new AppError('CONFLICT', `${workDate} 출근이 이미 기록되어 있습니다.`);

  const row = await ctx.tx.attendance.upsert({
    where: { employeeId_workDate: { employeeId, workDate: toDateOnly(workDate) } },
    create: { employeeId, workDate: toDateOnly(workDate), checkIn: at, source: 'WEB', status: 'NORMAL' },
    update: { checkIn: at, version: { increment: 1 } },
  });

  await audit.record(ctx, {
    action: 'attendance.checkIn',
    entityType: 'Attendance',
    entityId: row.id,
    after: { workDate },
  });
  return row;
}

export async function checkOut(
  ctx: TransactionContext,
  input: { employeeId?: string; at?: Date; breakMinutes?: number },
) {
  const employeeId = input.employeeId ?? ctx.actor.employeeId;
  if (!employeeId) throw new AppError('NOT_FOUND', '연결된 사원정보가 없습니다.');
  if (employeeId !== ctx.actor.employeeId) requirePermission(ctx.actor, 'hr.attendance');

  const at = input.at ?? ctx.now;
  const workDate = businessDate(at);
  const row = await ctx.tx.attendance.findUnique({
    where: { employeeId_workDate: { employeeId, workDate: toDateOnly(workDate) } },
  });
  if (!row?.checkIn) throw new AppError('CONFLICT', '출근 기록이 없어 퇴근을 기록할 수 없습니다.');

  const config = (await policy.resolve<LeavePolicyConfig>(ctx, policy.PolicyKeys.leave, workDate)).config;
  const buckets = classifyWork(config, {
    checkIn: row.checkIn,
    checkOut: at,
    isHoliday: isWeekend(workDate),
    ...(input.breakMinutes !== undefined ? { breakMinutes: input.breakMinutes } : {}),
  });

  const updated = await ctx.tx.attendance.update({
    where: { id: row.id },
    data: { checkOut: at, ...buckets, version: { increment: 1 } },
  });

  await audit.record(ctx, {
    action: 'attendance.checkOut',
    entityType: 'Attendance',
    entityId: row.id,
    after: { workDate, ...buckets },
  });
  return updated;
}

export interface UploadRow {
  employeeNo: string;
  workDate: string;
  checkIn?: string;
  checkOut?: string;
  status?: AttendanceStatus;
  note?: string;
}

/** HRM-04: bulk upload validates every row first and reports errors per row (BAS-03 pattern). */
export async function bulkUpload(ctx: TransactionContext, rows: UploadRow[]) {
  requirePermission(ctx.actor, 'hr.attendance');

  const employees = await ctx.tx.employee.findMany({
    where: { employeeNo: { in: [...new Set(rows.map((r) => r.employeeNo))] } },
    select: { id: true, employeeNo: true, hireDate: true, leaveDate: true },
  });
  const byNo = new Map(employees.map((e) => [e.employeeNo, e]));

  const errors: { row: number; message: string }[] = [];
  const valid: { employeeId: string; row: UploadRow; index: number }[] = [];

  rows.forEach((row, i) => {
    const employee = byNo.get(row.employeeNo);
    if (!employee) {
      errors.push({ row: i + 1, message: `사번 ${row.employeeNo}에 해당하는 사원이 없습니다.` });
      return;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(row.workDate)) {
      errors.push({ row: i + 1, message: '근무일은 YYYY-MM-DD 형식이어야 합니다.' });
      return;
    }
    const workDate = toDateOnly(row.workDate);
    if (workDate < employee.hireDate) {
      errors.push({ row: i + 1, message: '입사일 이전 근무일은 등록할 수 없습니다.' });
      return;
    }
    if (employee.leaveDate && workDate > employee.leaveDate) {
      errors.push({ row: i + 1, message: '퇴사일 이후 근무일은 등록할 수 없습니다.' });
      return;
    }
    valid.push({ employeeId: employee.id, row, index: i + 1 });
  });

  const config = (await policy.resolve<LeavePolicyConfig>(ctx, policy.PolicyKeys.leave)).config;
  let applied = 0;

  for (const { employeeId, row } of valid) {
    const checkIn = row.checkIn ? new Date(`${row.workDate}T${row.checkIn}:00+09:00`) : null;
    const checkOut = row.checkOut ? new Date(`${row.workDate}T${row.checkOut}:00+09:00`) : null;
    const buckets =
      checkIn && checkOut
        ? classifyWork(config, { checkIn, checkOut, isHoliday: isWeekend(row.workDate) })
        : { workMinutes: 0, overtimeMinutes: 0, nightMinutes: 0, holidayMinutes: 0 };

    await ctx.tx.attendance.upsert({
      where: { employeeId_workDate: { employeeId, workDate: toDateOnly(row.workDate) } },
      create: {
        employeeId,
        workDate: toDateOnly(row.workDate),
        checkIn,
        checkOut,
        status: row.status ?? 'NORMAL',
        source: 'UPLOAD',
        note: row.note ?? null,
        ...buckets,
      },
      update: {
        checkIn,
        checkOut,
        status: row.status ?? 'NORMAL',
        source: 'UPLOAD',
        note: row.note ?? null,
        ...buckets,
        version: { increment: 1 },
      },
    });
    applied++;
  }

  await audit.record(ctx, {
    action: 'attendance.bulkUpload',
    entityType: 'Attendance',
    entityId: 'bulk',
    meta: { total: rows.length, applied, errorCount: errors.length },
  });

  return { total: rows.length, applied, errors };
}

export async function monthly(
  ctx: TransactionContext,
  input: { employeeId: string; from: string; to: string },
) {
  assertHrScope(ctx.actor, input.employeeId);
  const rows = await ctx.tx.attendance.findMany({
    where: {
      employeeId: input.employeeId,
      workDate: { gte: toDateOnly(input.from), lte: toDateOnly(input.to) },
    },
    orderBy: { workDate: 'asc' },
  });

  const config = (await policy.resolve<LeavePolicyConfig>(ctx, policy.PolicyKeys.leave, input.to)).config;
  const totals = rows.reduce(
    (acc, r) => ({
      workMinutes: acc.workMinutes + r.workMinutes,
      overtimeMinutes: acc.overtimeMinutes + r.overtimeMinutes,
      nightMinutes: acc.nightMinutes + r.nightMinutes,
      holidayMinutes: acc.holidayMinutes + r.holidayMinutes,
    }),
    { workMinutes: 0, overtimeMinutes: 0, nightMinutes: 0, holidayMinutes: 0 },
  );

  const weeks = Math.max(1, Math.ceil(rows.length / 7));
  const warning = overtimeWarning(config, Math.round(totals.overtimeMinutes / weeks));

  return {
    rows: rows.map((r) => ({ ...r, workDate: fromDateOnly(r.workDate) })),
    totals,
    counts: {
      normal: rows.filter((r) => r.status === 'NORMAL').length,
      late: rows.filter((r) => r.status === 'LATE').length,
      earlyLeave: rows.filter((r) => r.status === 'EARLY_LEAVE').length,
      absent: rows.filter((r) => r.status === 'ABSENT').length,
      leave: rows.filter((r) => r.status === 'LEAVE' || r.status === 'HALF_LEAVE').length,
    },
    overtimeWarning: warning,
  };
}

/** Attendance rate for a period, used by the annual-leave accrual (DEC-05). */
export async function attendanceRate(ctx: TransactionContext, employeeId: string, from: string, to: string) {
  const config = (await policy.resolve<LeavePolicyConfig>(ctx, policy.PolicyKeys.leave, to)).config;
  const rows = await ctx.tx.attendance.findMany({
    where: { employeeId, workDate: { gte: toDateOnly(from), lte: toDateOnly(to) } },
    select: { status: true, workDate: true },
  });

  // A missing row means "no record", not "absent": only an explicit ABSENT status counts
  // against the rate. Deemed-attendance statuses (DEC-05 config) never count against it.
  const absentDates = new Set(rows.filter((r) => r.status === 'ABSENT').map((r) => fromDateOnly(r.workDate)));

  let scheduled = 0;
  let absent = 0;
  for (let d = from; d <= to; d = addDays(d, 1)) {
    if (isWeekend(d)) continue;
    scheduled++;
    if (absentDates.has(d)) absent++;
  }
  const attended = scheduled - absent;
  return {
    scheduled,
    attended,
    rate: scheduled === 0 ? 1 : attended / scheduled,
    deemed: config.deemedAttendance,
  };
}

// ── HRM-04 correction requests (approval target; callback wired in STEP 5) ──

export async function requestCorrection(
  ctx: TransactionContext,
  input: {
    docNo: string;
    employeeId?: string;
    workDate: string;
    requestedCheckIn?: string;
    requestedCheckOut?: string;
    requestedStatus?: AttendanceStatus;
    reason: string;
  },
) {
  const employeeId = input.employeeId ?? ctx.actor.employeeId;
  if (!employeeId) throw new AppError('NOT_FOUND', '연결된 사원정보가 없습니다.');
  assertHrScope(ctx.actor, employeeId);
  if (input.reason.trim().length < 5) throw new AppError('VALIDATION', '정정 사유를 5자 이상 입력하세요.');

  const request = await ctx.tx.attendanceCorrectionRequest.create({
    data: {
      docNo: input.docNo,
      employeeId,
      workDate: toDateOnly(input.workDate),
      requestedCheckIn: input.requestedCheckIn
        ? new Date(`${input.workDate}T${input.requestedCheckIn}:00+09:00`)
        : null,
      requestedCheckOut: input.requestedCheckOut
        ? new Date(`${input.workDate}T${input.requestedCheckOut}:00+09:00`)
        : null,
      requestedStatus: input.requestedStatus ?? null,
      reason: input.reason.trim(),
    },
  });

  await audit.record(ctx, {
    action: 'attendanceCorrection.create',
    entityType: 'AttendanceCorrectionRequest',
    entityId: request.id,
    after: { docNo: input.docNo, employeeId, workDate: input.workDate },
  });
  return request;
}

/**
 * Applied by the approval callback (APV-09) inside the approval transaction — never
 * called directly from a router.
 */
export async function applyCorrection(ctx: TransactionContext, requestId: string) {
  const request = await ctx.tx.attendanceCorrectionRequest.findUniqueOrThrow({ where: { id: requestId } });
  if (request.status === 'APPROVED') throw new AppError('DUPLICATE_EFFECT', '이미 반영된 근태정정입니다.');

  const config = (
    await policy.resolve<LeavePolicyConfig>(ctx, policy.PolicyKeys.leave, fromDateOnly(request.workDate))
  ).config;
  const existing = await ctx.tx.attendance.findUnique({
    where: { employeeId_workDate: { employeeId: request.employeeId, workDate: request.workDate } },
  });

  const checkIn = request.requestedCheckIn ?? existing?.checkIn ?? null;
  const checkOut = request.requestedCheckOut ?? existing?.checkOut ?? null;
  const buckets =
    checkIn && checkOut
      ? classifyWork(config, { checkIn, checkOut, isHoliday: isWeekend(fromDateOnly(request.workDate)) })
      : { workMinutes: 0, overtimeMinutes: 0, nightMinutes: 0, holidayMinutes: 0 };

  await ctx.tx.attendance.upsert({
    where: { employeeId_workDate: { employeeId: request.employeeId, workDate: request.workDate } },
    create: {
      employeeId: request.employeeId,
      workDate: request.workDate,
      checkIn,
      checkOut,
      status: request.requestedStatus ?? 'NORMAL',
      source: 'CORRECTION',
      note: request.reason,
      ...buckets,
    },
    update: {
      checkIn,
      checkOut,
      ...(request.requestedStatus ? { status: request.requestedStatus } : {}),
      source: 'CORRECTION',
      note: request.reason,
      ...buckets,
      version: { increment: 1 },
    },
  });

  await ctx.tx.attendanceCorrectionRequest.update({
    where: { id: requestId },
    data: { status: 'APPROVED', version: { increment: 1 } },
  });

  await audit.record(ctx, {
    action: 'attendanceCorrection.apply',
    entityType: 'AttendanceCorrectionRequest',
    entityId: requestId,
    after: { employeeId: request.employeeId, workDate: fromDateOnly(request.workDate) },
  });
}

export async function rejectCorrection(ctx: TransactionContext, requestId: string) {
  await ctx.tx.attendanceCorrectionRequest.update({
    where: { id: requestId },
    data: { status: 'REJECTED', version: { increment: 1 } },
  });
}

export async function listCorrections(
  ctx: TransactionContext,
  input: { employeeId?: string; status?: string; skip: number; take: number },
) {
  const canSeeAll = has(ctx.actor, 'hr.attendance') || has(ctx.actor, 'hr.read');
  const where = {
    ...(input.employeeId
      ? { employeeId: input.employeeId }
      : canSeeAll
        ? {}
        : { employeeId: ctx.actor.employeeId ?? '__none__' }),
    ...(input.status ? { status: input.status } : {}),
  };
  if (input.employeeId) assertHrScope(ctx.actor, input.employeeId);

  const [rows, total] = await Promise.all([
    ctx.tx.attendanceCorrectionRequest.findMany({
      where,
      include: { employee: { select: { employeeNo: true, name: true } } },
      orderBy: { createdAt: 'desc' },
      skip: input.skip,
      take: input.take,
    }),
    ctx.tx.attendanceCorrectionRequest.count({ where }),
  ]);
  return { rows, total };
}
