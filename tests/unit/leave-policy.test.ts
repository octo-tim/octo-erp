// covers: HRM-05, HRM-07, DEC-05 (ADR-0007 approved examples)
import { describe, expect, it } from 'vitest';
import {
  accrue,
  balance,
  classifyWork,
  overtimeWarning,
  yearsOfService,
} from '@/server/modules/hrm/leave-policy';
import type { LeavePolicyConfig } from '@/server/modules/policy/service';

const CONFIG: LeavePolicyConfig = {
  basis: 'HIRE_DATE',
  underOneYear: { perMonth: 1, max: 11 },
  baseDays: 15,
  bonus: { startYear: 3, everyYears: 2, days: 1, max: 25 },
  attendanceRateRequired: 0.8,
  deemedAttendance: ['PARENTAL_LEAVE', 'INDUSTRIAL_ACCIDENT', 'MATERNITY_LEAVE', 'ANNUAL_LEAVE'],
  validMonths: 12,
  halfDay: true,
  weeklyStandardMinutes: 2400,
  weeklyOvertimeLimitMinutes: 720,
  nightStartHour: 22,
  nightEndHour: 6,
};

describe('yearsOfService', () => {
  it('counts completed years from the hire date', () => {
    expect(yearsOfService('2025-03-01', '2026-02-28')).toBe(0);
    expect(yearsOfService('2025-03-01', '2026-03-01')).toBe(1);
    expect(yearsOfService('2016-03-01', '2026-03-01')).toBe(10);
    expect(yearsOfService('2026-03-01', '2026-03-01')).toBe(0);
  });
});

describe('ADR-0007 승인 계산 예시 전건 (DEC-05)', () => {
  it('입사 2025-03-01, 기준 2026-03-01 → 15일', () => {
    const r = accrue(CONFIG, { hireDate: '2025-03-01', asOf: '2026-03-01' });
    expect(r.days).toBe('15.0');
    expect(r.basis).toBe('ANNUAL');
    expect(r.accrualStart).toBe('2026-03-01');
    expect(r.expiresAt).toBe('2027-03-01');
  });

  it('입사 2026-01-15, 기준 2026-06-15, 5개월 개근 → 5일', () => {
    const r = accrue(CONFIG, { hireDate: '2026-01-15', asOf: '2026-06-15', fullAttendanceMonths: 5 });
    expect(r.days).toBe('5.0');
    expect(r.basis).toBe('UNDER_ONE_YEAR');
  });

  it('입사 2022-03-01, 기준 2026-03-01 (근속 4년) → 16일', () => {
    expect(accrue(CONFIG, { hireDate: '2022-03-01', asOf: '2026-03-01' }).days).toBe('16.0');
  });

  it('입사 2016-03-01, 기준 2026-03-01 (근속 10년) → 19일', () => {
    expect(accrue(CONFIG, { hireDate: '2016-03-01', asOf: '2026-03-01' }).days).toBe('19.0');
  });
});

describe('accrual boundaries', () => {
  it('caps the first year at 11 days', () => {
    const r = accrue(CONFIG, { hireDate: '2025-09-01', asOf: '2026-08-30', fullAttendanceMonths: 20 });
    expect(r.days).toBe('11.0');
  });

  it('caps long service at the configured maximum', () => {
    expect(accrue(CONFIG, { hireDate: '1990-01-01', asOf: '2026-01-01' }).days).toBe('25.0');
  });

  it('grants nothing when the attendance rate is below the requirement', () => {
    const r = accrue(CONFIG, { hireDate: '2020-01-01', asOf: '2026-01-01', attendanceRate: 0.75 });
    expect(r.days).toBe('0.0');
    expect(r.reason).toContain('출근율');
  });

  it('grants normally at exactly the required attendance rate', () => {
    // 근속 6년: 15 + floor((6-3)/2 + 1) = 17일
    expect(accrue(CONFIG, { hireDate: '2020-01-01', asOf: '2026-01-01', attendanceRate: 0.8 }).days).toBe(
      '17.0',
    );
  });

  it('reads every number from the policy, not from code', () => {
    const generous: LeavePolicyConfig = {
      ...CONFIG,
      baseDays: 20,
      bonus: { startYear: 2, everyYears: 1, days: 2, max: 40 },
    };
    expect(accrue(generous, { hireDate: '2020-01-01', asOf: '2026-01-01' }).days).toBe('30.0');
  });
});

describe('balance (HRM-05)', () => {
  it('excludes expired grants and nets reversals', () => {
    const r = balance(
      [
        { days: '15.0', expiresAt: '2026-12-31' },
        { days: '11.0', expiresAt: '2025-12-31' }, // expired
      ],
      [{ days: '3.0' }, { days: '2.0' }, { days: '-2.0' }],
      '2026-08-30',
    );
    expect(r.granted).toBe('15.0');
    expect(r.used).toBe('3.0');
    expect(r.remaining).toBe('12.0');
    expect(r.expired).toBe('11.0');
  });

  it('handles no grants without producing NaN', () => {
    const r = balance([], [], '2026-08-30');
    expect(r).toEqual({ granted: '0.0', used: '0.0', remaining: '0.0', expired: '0.0' });
  });
});

describe('classifyWork (HRM-07)', () => {
  it('splits standard and overtime minutes on a weekday', () => {
    // 09:00-20:00 KST with a 60-minute break = 600 minutes, 480 standard, 120 overtime
    const r = classifyWork(CONFIG, {
      checkIn: new Date('2026-08-31T00:00:00Z'),
      checkOut: new Date('2026-08-31T11:00:00Z'),
      isHoliday: false,
      breakMinutes: 60,
    });
    expect(r.workMinutes).toBe(600);
    expect(r.overtimeMinutes).toBe(120);
    expect(r.holidayMinutes).toBe(0);
  });

  it('counts night minutes after 22:00 KST', () => {
    // 21:00-24:00 KST → 120 minutes of night work
    const r = classifyWork(CONFIG, {
      checkIn: new Date('2026-08-31T12:00:00Z'),
      checkOut: new Date('2026-08-31T15:00:00Z'),
      isHoliday: false,
    });
    expect(r.nightMinutes).toBe(120);
  });

  it('treats holiday work as holiday minutes, not overtime', () => {
    const r = classifyWork(CONFIG, {
      checkIn: new Date('2026-08-30T00:00:00Z'),
      checkOut: new Date('2026-08-30T10:00:00Z'),
      isHoliday: true,
    });
    expect(r.overtimeMinutes).toBe(0);
    expect(r.holidayMinutes).toBe(600);
  });

  it('never returns negative minutes', () => {
    const r = classifyWork(CONFIG, {
      checkIn: new Date('2026-08-31T02:00:00Z'),
      checkOut: new Date('2026-08-31T02:10:00Z'),
      isHoliday: false,
      breakMinutes: 60,
    });
    expect(r.workMinutes).toBe(0);
  });
});

describe('overtimeWarning (HRM-07)', () => {
  it('warns only above the configured limit', () => {
    expect(overtimeWarning(CONFIG, 720)).toBeNull();
    expect(overtimeWarning(CONFIG, 800)).toContain('초과');
  });
});
