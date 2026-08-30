// covers: INT-01, DEC-02 (ADR-0004, ADR-0011)
import { describe, expect, it } from 'vitest';
import {
  add,
  amount,
  D,
  div,
  floorTo,
  formatKrw,
  formatQty,
  mul,
  quantity,
  sub,
  unitPrice,
} from '@/lib/money';

describe('money (INT-01)', () => {
  it('keeps precision that floats would lose', () => {
    expect(add('0.1', '0.2').toString()).toBe('0.3');
    expect(mul('1.005', '100').toString()).toBe('100.5');
    expect(add('9007199254740993', '1').toString()).toBe('9007199254740994');
  });

  it('truncates KRW amounts toward zero', () => {
    expect(amount('1234.99')).toBe('1234');
    expect(amount('1234.00')).toBe('1234');
    expect(floorTo('999.9999', 0).toString()).toBe('999');
  });

  it('applies declared scales', () => {
    expect(quantity('1.23456')).toBe('1.234');
    expect(unitPrice('1000.123456')).toBe('1000.1234');
  });

  it('formats Korean thousands separators', () => {
    expect(formatKrw('1234567')).toBe('1,234,567');
    expect(formatKrw('0')).toBe('0');
    expect(formatQty('1234.500')).toBe('1,234.5');
    expect(formatQty('10')).toBe('10');
  });

  it('DEC-02 example B-12: line supply and VAT', () => {
    // line 1: qty 3 x price 1,333, taxable
    const supply1 = floorTo(mul('3', '1333'));
    const vat1 = floorTo(mul(supply1, '0.1'));
    expect(supply1.toString()).toBe('3999');
    expect(vat1.toString()).toBe('399');

    // line 2: qty 1.5 x price 1,001, exempt
    const supply2 = floorTo(mul('1.5', '1001'));
    expect(supply2.toString()).toBe('1501');

    const totalSupply = add(supply1, supply2);
    const totalVat = add(vat1, '0');
    expect(totalSupply.toString()).toBe('5500');
    expect(totalVat.toString()).toBe('399');
    expect(add(totalSupply, totalVat).toString()).toBe('5899');
  });

  it('VAT-inclusive input splits without drift', () => {
    const inclusive = D('11000');
    const supply = floorTo(div(inclusive, '1.1'));
    const vat = sub(inclusive, supply);
    expect(supply.toString()).toBe('10000');
    expect(vat.toString()).toBe('1000');
  });
});

describe('display formatting tolerates blanks (UIX-03)', () => {
  it('returns an empty string rather than throwing on null, undefined or ""', async () => {
    const { fmt } = await import('@/lib/format');
    expect(fmt.krw(null)).toBe('');
    expect(fmt.krw(undefined)).toBe('');
    expect(fmt.krw('')).toBe('');
    expect(fmt.krw('   ')).toBe('');
    expect(fmt.qty('')).toBe('');
    expect(fmt.date('')).toBe('');
    expect(fmt.krw('1234567')).toBe('1,234,567');
  });
});
