// covers: NFR-UX-01, DEC-04
import { describe, expect, it } from 'vitest';
import {
  addDays,
  addMonths,
  addYears,
  businessDate,
  daysBetween,
  formatKst,
  monthRange,
  periodKey,
  toDateOnly,
} from '@/lib/dates';

describe('dates (Asia/Seoul)', () => {
  it('uses the KST business day, not UTC', () => {
    // 2026-08-30 16:00 UTC is 2026-08-31 01:00 KST
    expect(businessDate(new Date('2026-08-30T16:00:00Z'))).toBe('2026-08-31');
    expect(businessDate(new Date('2026-08-30T14:00:00Z'))).toBe('2026-08-30');
  });

  it('derives the accounting period key', () => {
    expect(periodKey('2026-07-15')).toBe('2026-07');
    expect(periodKey(toDateOnly('2026-12-31'))).toBe('2026-12');
  });

  it('handles month arithmetic at month ends', () => {
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonths('2024-01-31', 1)).toBe('2024-02-29');
    expect(addYears('2024-02-29', 1)).toBe('2025-02-28');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
  });

  it('gives a half-open month range', () => {
    expect(monthRange('2026-02')).toEqual({ start: '2026-02-01', endExclusive: '2026-03-01' });
  });

  it('counts days between business dates', () => {
    expect(daysBetween('2026-01-01', '2026-01-31')).toBe(30);
  });

  it('formats instants in KST', () => {
    expect(formatKst(new Date('2026-08-30T05:05:00Z'))).toBe('2026-08-30 14:05');
  });
});
