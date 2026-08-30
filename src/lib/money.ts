import Decimal from 'decimal.js';

// INT-01 / ADR-0011: money and quantity never touch JS floats.
// KRW amounts are integers; quantities allow 3 decimals; unit prices allow 4.
Decimal.set({ precision: 34, rounding: Decimal.ROUND_DOWN, toExpNeg: -30, toExpPos: 30 });

export type Numeric = string | number | Decimal | { toString(): string };

export const D = (v: Numeric): Decimal =>
  new Decimal(typeof v === 'string' || typeof v === 'number' ? v : v.toString());

export const ZERO = new Decimal(0);

/** Truncate toward zero to the given number of decimals (KRW: 0). */
export function floorTo(v: Numeric, decimals = 0): Decimal {
  return D(v).toDecimalPlaces(decimals, Decimal.ROUND_DOWN);
}

/** Amount as KRW integer string, suitable for Prisma Decimal and API output. */
export function amount(v: Numeric): string {
  return floorTo(v, 0).toFixed(0);
}

export function quantity(v: Numeric): string {
  return D(v).toDecimalPlaces(3, Decimal.ROUND_DOWN).toFixed(3);
}

export function unitPrice(v: Numeric): string {
  return D(v).toDecimalPlaces(4, Decimal.ROUND_DOWN).toFixed(4);
}

export const add = (...vs: Numeric[]): Decimal => vs.reduce<Decimal>((a, v) => a.plus(D(v)), ZERO);
export const sub = (a: Numeric, b: Numeric): Decimal => D(a).minus(D(b));
export const mul = (a: Numeric, b: Numeric): Decimal => D(a).times(D(b));
export const div = (a: Numeric, b: Numeric): Decimal => D(a).div(D(b));
export const isZero = (v: Numeric): boolean => D(v).isZero();
export const isNegative = (v: Numeric): boolean => D(v).isNegative();
export const cmp = (a: Numeric, b: Numeric): number => D(a).cmp(D(b));
export const max = (a: Numeric, b: Numeric): Decimal => (cmp(a, b) >= 0 ? D(a) : D(b));
export const min = (a: Numeric, b: Numeric): Decimal => (cmp(a, b) <= 0 ? D(a) : D(b));
export const neg = (v: Numeric): Decimal => D(v).neg();

/** Display helper: 1,234,567 */
export function formatKrw(v: Numeric): string {
  const d = floorTo(v, 0);
  return d.toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

export function formatQty(v: Numeric): string {
  const d = D(v);
  const s = d
    .toDecimalPlaces(3, Decimal.ROUND_DOWN)
    .toFixed(3)
    .replace(/\.?0+$/, '');
  const [i, f] = s.split('.');
  const head = (i ?? '0').replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return f ? `${head}.${f}` : head;
}

export { Decimal };
