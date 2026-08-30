// NFR-UX-01: business dates are Asia/Seoul; storage is UTC timestamptz or plain date.
export const TZ = 'Asia/Seoul';
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** Business day (KST) of an instant, as 'YYYY-MM-DD'. */
export function businessDate(at: Date = new Date()): string {
  return new Date(at.getTime() + KST_OFFSET_MS).toISOString().slice(0, 10);
}

/** 'YYYY-MM-DD' -> Date at UTC midnight, which Postgres stores as that calendar date. */
export function toDateOnly(ymd: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) throw new Error(`invalid date: ${ymd}`);
  return new Date(`${ymd}T00:00:00.000Z`);
}

export function fromDateOnly(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Accounting period key 'YYYY-MM' (DEC-04). */
export function periodKey(ymdOrDate: string | Date): string {
  const s = typeof ymdOrDate === 'string' ? ymdOrDate : fromDateOnly(ymdOrDate);
  return s.slice(0, 7);
}

export function addDays(ymd: string, days: number): string {
  const d = toDateOnly(ymd);
  d.setUTCDate(d.getUTCDate() + days);
  return fromDateOnly(d);
}

export function addMonths(ymd: string, months: number): string {
  const d = toDateOnly(ymd);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return fromDateOnly(d);
}

export function addYears(ymd: string, years: number): string {
  return addMonths(ymd, years * 12);
}

export function daysBetween(a: string, b: string): number {
  return Math.round((toDateOnly(b).getTime() - toDateOnly(a).getTime()) / 86400000);
}

export function monthRange(period: string): { start: string; endExclusive: string } {
  const start = `${period}-01`;
  return { start, endExclusive: addMonths(start, 1) };
}

export function isWeekend(ymd: string): boolean {
  const day = toDateOnly(ymd).getUTCDay();
  return day === 0 || day === 6;
}

/** KST display of an instant, e.g. '2026-08-30 14:05'. */
export function formatKst(at: Date, withTime = true): string {
  const s = new Date(at.getTime() + KST_OFFSET_MS).toISOString();
  return withTime ? `${s.slice(0, 10)} ${s.slice(11, 16)}` : s.slice(0, 10);
}
