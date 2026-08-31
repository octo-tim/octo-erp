import type { Actor, TransactionContext } from '@/server/core/context';
import { AppError } from '@/server/core/errors';
import { assertDivisionScope, assertWarehouseScope } from '@/server/modules/rbac/service';
import { monthRange, toDateOnly } from '@/lib/dates';

/**
 * RPT-07 — the one filter every report speaks.
 *
 * Every report asks the same questions (which period, whose division, which warehouse,
 * which partner), so they share one shape rather than each inventing its own. That matters
 * for more than tidiness: the scope check below is what keeps a user from reading another
 * division's numbers through a report, and a per-report filter would mean a per-report
 * chance to forget it (INT-12).
 */

export interface ReportFilter {
  from: string;
  to: string;
  divisionId?: string;
  warehouseId?: string;
  partnerId?: string;
  categoryId?: string;
}

export interface ResolvedFilter extends ReportFilter {
  fromDate: Date;
  /** exclusive upper bound, so a BETWEEN never drops the last day's evening rows */
  toExclusive: Date;
  /** the same window one year earlier, for the year-on-year comparisons (RPT-03) */
  priorFromDate: Date;
  priorToExclusive: Date;
  actor: Actor;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** The current month, which is what every report opens on. */
export function defaultFilter(now: Date): ReportFilter {
  const { start, endExclusive } = monthRange(now.toISOString().slice(0, 7));
  const last = new Date(toDateOnly(endExclusive).getTime() - 24 * 60 * 60 * 1000);
  return { from: start, to: last.toISOString().slice(0, 10) };
}

function shiftYear(d: Date, years: number): Date {
  const copy = new Date(d.getTime());
  copy.setUTCFullYear(copy.getUTCFullYear() + years);
  return copy;
}

export function resolveFilter(ctx: TransactionContext, filter: ReportFilter): ResolvedFilter {
  if (!DATE.test(filter.from) || !DATE.test(filter.to)) {
    throw new AppError('VALIDATION', '조회 기간을 YYYY-MM-DD 형식으로 입력하세요.');
  }
  if (filter.to < filter.from) {
    throw new AppError('VALIDATION', '종료일은 시작일보다 빠를 수 없습니다.');
  }

  // INT-12: a filter is a request to read, so the scope is checked here rather than in each
  // report. Asking for a division you cannot see is refused, not silently emptied.
  assertDivisionScope(ctx.actor, filter.divisionId);
  assertWarehouseScope(ctx.actor, filter.warehouseId);

  const fromDate = toDateOnly(filter.from);
  const toDate = toDateOnly(filter.to);
  const toExclusive = new Date(toDate.getTime() + 24 * 60 * 60 * 1000);

  return {
    ...filter,
    fromDate,
    toExclusive,
    priorFromDate: shiftYear(fromDate, -1),
    priorToExclusive: shiftYear(toExclusive, -1),
    actor: ctx.actor,
  };
}

/**
 * The division ids a query may read, or null for "no restriction". Reports build SQL, so
 * they need the list rather than a Prisma where-fragment.
 */
export function divisionIdsFor(f: ResolvedFilter): string[] | null {
  if (f.divisionId) return [f.divisionId];
  if (f.actor.isAdmin) return null;
  return f.actor.divisionIds;
}

export function warehouseIdsFor(f: ResolvedFilter): string[] | null {
  if (f.warehouseId) return [f.warehouseId];
  if (f.actor.isAdmin) return null;
  return f.actor.warehouseIds;
}

/**
 * A scope that resolves to an empty list means the user may read nothing — default-deny.
 * Returning no rows is the correct answer there; the SQL below would otherwise produce
 * `IN ()`, which Postgres rejects.
 */
export function isEmptyScope(ids: string[] | null): boolean {
  return ids !== null && ids.length === 0;
}

export const GRANULARITIES = ['DAY', 'WEEK', 'MONTH', 'QUARTER'] as const;
export type Granularity = (typeof GRANULARITIES)[number];

/** The Postgres date_trunc unit for a granularity. Never interpolated from user input. */
export function truncUnit(g: Granularity): string {
  switch (g) {
    case 'DAY':
      return 'day';
    case 'WEEK':
      return 'week';
    case 'QUARTER':
      return 'quarter';
    case 'MONTH':
    default:
      return 'month';
  }
}

export function bucketLabel(g: Granularity, d: Date): string {
  const iso = d.toISOString().slice(0, 10);
  if (g === 'DAY') return iso;
  if (g === 'WEEK') return `${iso} 주`;
  if (g === 'QUARTER') {
    const q = Math.floor(d.getUTCMonth() / 3) + 1;
    return `${d.getUTCFullYear()}-Q${q}`;
  }
  return iso.slice(0, 7);
}
