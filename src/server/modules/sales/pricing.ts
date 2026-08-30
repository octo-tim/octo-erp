import { AppError } from '@/server/core/errors';
import { amount, D, floorTo, quantity, unitPrice, ZERO } from '@/lib/money';
import type Decimal from 'decimal.js';

/**
 * DEC-02 / ADR-0004 — line amounts and VAT.
 *
 * Supply = floor(quantity x unitPrice). VAT = floor(supply x 10%) for taxable lines and
 * zero for 영세/면세. Document totals are the SUM OF LINE AMOUNTS, never a percentage of
 * the document total — the two differ by rounding, and the approved example (B-12) is the
 * per-line one. Truncation is always downward, never rounding.
 *
 * This module is pure so the calculation can be tested against the approved example
 * without a database, and the server always recomputes it rather than trusting the client.
 */

export const VAT_RATE = D('0.1');

export type TaxType = 'TAXABLE' | 'ZERO' | 'EXEMPT';
export const TAX_TYPES: TaxType[] = ['TAXABLE', 'ZERO', 'EXEMPT'];
export const TAX_TYPE_LABEL: Record<TaxType, string> = {
  TAXABLE: '과세',
  ZERO: '영세',
  EXEMPT: '면세',
};

export interface PricedLineInput {
  quantity: string;
  unitPrice: string;
  taxType?: string;
}

export interface PricedLine {
  quantity: string;
  unitPrice: string;
  taxType: TaxType;
  supplyAmount: string;
  vatAmount: string;
  totalAmount: string;
}

export interface DocumentTotals {
  supplyAmount: string;
  vatAmount: string;
  totalAmount: string;
}

export function isTaxType(v: string): v is TaxType {
  return (TAX_TYPES as string[]).includes(v);
}

/** One line. Quantity may carry 3 decimals; the unit price is an integer won. */
export function priceLine(input: PricedLineInput): PricedLine {
  const taxType = (input.taxType ?? 'TAXABLE') as TaxType;
  if (!isTaxType(taxType)) {
    throw new AppError('VALIDATION', `과세구분이 올바르지 않습니다: ${input.taxType}`);
  }

  const qty = D(input.quantity);
  const price = D(input.unitPrice);
  if (qty.lte(0)) throw new AppError('VALIDATION', '수량은 0보다 커야 합니다.');
  if (price.isNegative()) throw new AppError('VALIDATION', '단가는 0 이상이어야 합니다.');

  const supply = floorTo(qty.times(price), 0);
  const vat = taxType === 'TAXABLE' ? floorTo(supply.times(VAT_RATE), 0) : ZERO;

  return {
    quantity: quantity(qty),
    unitPrice: unitPrice(price),
    taxType,
    supplyAmount: amount(supply),
    vatAmount: amount(vat),
    totalAmount: amount(supply.plus(vat)),
  };
}

/** The document totals: the sum of the priced lines, nothing else. */
export function totalsOf(lines: PricedLine[]): DocumentTotals {
  let supply = ZERO;
  let vat = ZERO;
  for (const l of lines) {
    supply = supply.plus(D(l.supplyAmount));
    vat = vat.plus(D(l.vatAmount));
  }
  return { supplyAmount: amount(supply), vatAmount: amount(vat), totalAmount: amount(supply.plus(vat)) };
}

export function priceLines(lines: PricedLineInput[]): { lines: PricedLine[]; totals: DocumentTotals } {
  const priced = lines.map(priceLine);
  return { lines: priced, totals: totalsOf(priced) };
}

/**
 * ADR-0004: when a price is entered VAT-inclusive, supply = floor(inclusive / 1.1) and
 * VAT is the remainder — so supply + VAT is exactly the figure the user typed, which is
 * the point of entering it that way.
 */
export function splitVatInclusive(
  inclusive: string,
  taxType: TaxType = 'TAXABLE',
): {
  supplyAmount: string;
  vatAmount: string;
} {
  const total = D(inclusive);
  if (taxType !== 'TAXABLE') return { supplyAmount: amount(total), vatAmount: '0' };
  const supply = floorTo(total.div(D(1).plus(VAT_RATE)), 0);
  return { supplyAmount: amount(supply), vatAmount: amount(total.minus(supply)) };
}

/**
 * SLS-08: aging buckets for the receivables report. A bucket is chosen by how long the
 * item has been outstanding, measured from the document date to the report date.
 */
export const AGING_BUCKETS = ['CURRENT', 'D30', 'D60', 'D90', 'OVER90'] as const;
export type AgingBucket = (typeof AGING_BUCKETS)[number];
export const AGING_LABEL: Record<AgingBucket, string> = {
  CURRENT: '30일 이내',
  D30: '31~60일',
  D60: '61~90일',
  D90: '91~120일',
  OVER90: '120일 초과',
};

export function agingBucket(daysOutstanding: number): AgingBucket {
  if (daysOutstanding <= 30) return 'CURRENT';
  if (daysOutstanding <= 60) return 'D30';
  if (daysOutstanding <= 90) return 'D60';
  if (daysOutstanding <= 120) return 'D90';
  return 'OVER90';
}

/**
 * SLS-02/SLS-04/SLS-13: what is left of a source line after conversions and cancellations.
 * Kept here so every document type derives it the same way.
 */
export function remainingQuantity(original: string, converted: string, canceled = '0'): Decimal {
  return D(original).minus(D(converted)).plus(D(canceled));
}

export function assertWithinRemaining(requested: string, remaining: Decimal, label: string): void {
  if (D(requested).gt(remaining)) {
    throw new AppError(
      'OVER_ALLOCATION',
      `${label}: 잔여수량 ${quantity(remaining)}을(를) 초과했습니다. 요청 ${quantity(requested)}.`,
      { requested, remaining: quantity(remaining) },
    );
  }
}
