import { D, add, cmp, sub } from '@/lib/money';
import { addMonths, addYears, daysBetween, toDateOnly } from '@/lib/dates';
import type { LeavePolicyConfig } from '@/server/modules/policy/service';

/**
 * HRM-05 / DEC-05 (ADR-0007): annual leave accrual driven entirely by the approved
 * policy version. Nothing about the statute is hard-coded — every number, the accrual
 * basis and the deemed-attendance list come from `config`, so a policy revision is a new
 * PolicyVersion row rather than a code change.
 */
export interface AccrualInput {
  hireDate: string;
  /** the date the entitlement is being calculated for (usually today, KST) */
  asOf: string;
  /** attendance rate for the accrual year, 0..1. Undefined = assume the requirement is met. */
  attendanceRate?: number;
  /** months of full attendance in the first year (for the under-one-year rule) */
  fullAttendanceMonths?: number;
}

export interface AccrualResult {
  /** days granted for the current accrual year */
  days: string;
  /** start of the accrual year this grant belongs to */
  accrualStart: string;
  /** last day the grant may be used */
  expiresAt: string;
  yearsOfService: number;
  basis: 'UNDER_ONE_YEAR' | 'ANNUAL';
  reason: string;
}

/** Completed years of service on `asOf`, counted from the hire date (DEC-05 basis: HIRE_DATE). */
export function yearsOfService(hireDate: string, asOf: string): number {
  const hire = toDateOnly(hireDate);
  const at = toDateOnly(asOf);
  let years = at.getUTCFullYear() - hire.getUTCFullYear();
  const anniversary = toDateOnly(addYears(hireDate, years));
  if (anniversary > at) years -= 1;
  return Math.max(0, years);
}

export function accrue(config: LeavePolicyConfig, input: AccrualInput): AccrualResult {
  const years = yearsOfService(input.hireDate, input.asOf);

  if (years < 1) {
    // Under one year: one day per month of full attendance, capped.
    const monthsWorked = Math.max(0, Math.floor(daysBetween(input.hireDate, input.asOf) / 30.4375));
    const months = Math.min(input.fullAttendanceMonths ?? monthsWorked, config.underOneYear.max);
    const days = Math.min(months * config.underOneYear.perMonth, config.underOneYear.max);
    return {
      days: D(days).toFixed(1),
      accrualStart: input.hireDate,
      expiresAt: addMonths(input.hireDate, config.validMonths + 12),
      yearsOfService: years,
      basis: 'UNDER_ONE_YEAR',
      reason: `입사 1년 미만: 개근 ${months}개월 × ${config.underOneYear.perMonth}일 (최대 ${config.underOneYear.max}일)`,
    };
  }

  const accrualStart = addYears(input.hireDate, years);

  // Attendance-rate requirement applies to the annual grant only.
  if (input.attendanceRate !== undefined && input.attendanceRate < config.attendanceRateRequired) {
    return {
      days: '0.0',
      accrualStart,
      expiresAt: addMonths(accrualStart, config.validMonths),
      yearsOfService: years,
      basis: 'ANNUAL',
      reason: `출근율 ${(input.attendanceRate * 100).toFixed(1)}% < 기준 ${(config.attendanceRateRequired * 100).toFixed(0)}%`,
    };
  }

  let bonus = 0;
  if (years >= config.bonus.startYear) {
    bonus = Math.floor((years - config.bonus.startYear) / config.bonus.everyYears + 1) * config.bonus.days;
  }
  const total = Math.min(config.baseDays + bonus, config.bonus.max);

  return {
    days: D(total).toFixed(1),
    accrualStart,
    expiresAt: addMonths(accrualStart, config.validMonths),
    yearsOfService: years,
    basis: 'ANNUAL',
    reason:
      bonus > 0
        ? `근속 ${years}년: 기본 ${config.baseDays}일 + 가산 ${bonus}일 (최대 ${config.bonus.max}일)`
        : `근속 ${years}년: 기본 ${config.baseDays}일`,
  };
}

/** Balance = grants that have not expired − usages (usages may be negative reversals). */
export function balance(
  grants: { days: string; expiresAt: string }[],
  usages: { days: string }[],
  asOf: string,
): { granted: string; used: string; remaining: string; expired: string } {
  const live = grants.filter((g) => cmp(daysBetween(asOf, g.expiresAt), 0) >= 0);
  const expiredGrants = grants.filter((g) => cmp(daysBetween(asOf, g.expiresAt), 0) < 0);
  const granted = add(...live.map((g) => g.days));
  const used = add(...usages.map((u) => u.days));
  return {
    granted: granted.toFixed(1),
    used: used.toFixed(1),
    remaining: sub(granted, used).toFixed(1),
    expired: add(...expiredGrants.map((g) => g.days)).toFixed(1),
  };
}

/** HRM-07: classify worked minutes into standard / overtime / night / holiday buckets. */
export function classifyWork(
  config: LeavePolicyConfig,
  input: { checkIn: Date; checkOut: Date; isHoliday: boolean; breakMinutes?: number },
): { workMinutes: number; overtimeMinutes: number; nightMinutes: number; holidayMinutes: number } {
  const totalMinutes = Math.max(
    0,
    Math.round((input.checkOut.getTime() - input.checkIn.getTime()) / 60000) - (input.breakMinutes ?? 0),
  );
  const dailyStandard = Math.round(config.weeklyStandardMinutes / 5);

  let nightMinutes = 0;
  const cursor = new Date(input.checkIn);
  while (cursor < input.checkOut) {
    const hourKst = (cursor.getUTCHours() + 9) % 24;
    if (hourKst >= config.nightStartHour || hourKst < config.nightEndHour) nightMinutes += 1;
    cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);
  }

  return {
    workMinutes: totalMinutes,
    overtimeMinutes: input.isHoliday ? 0 : Math.max(0, totalMinutes - dailyStandard),
    nightMinutes: Math.min(nightMinutes, totalMinutes),
    holidayMinutes: input.isHoliday ? totalMinutes : 0,
  };
}

/** HRM-07: weekly overtime limit warning (config-driven, not a hard-coded 52 hours). */
export function overtimeWarning(config: LeavePolicyConfig, weeklyOvertimeMinutes: number): string | null {
  if (weeklyOvertimeMinutes <= config.weeklyOvertimeLimitMinutes) return null;
  const over = weeklyOvertimeMinutes - config.weeklyOvertimeLimitMinutes;
  return `주간 연장근로 한도를 ${Math.round(over / 60)}시간 ${over % 60}분 초과했습니다.`;
}
