import { describe, expect, it } from 'vitest';
import {
  agingBucket,
  priceLine,
  priceLines,
  splitVatInclusive,
  remainingQuantity,
} from '@/server/modules/sales/pricing';

/**
 * DEC-02 / ADR-0004 / acceptance-scenarios B-12. These are the approved figures; if a
 * change moves one of them, the change is wrong until DEC-02 is re-decided.
 */
describe('DEC-02 금액·부가세 계산', () => {
  it('B-12 라인1: 수량 3 × 단가 1,333 과세 → 공급가 3,999 / 부가세 399', () => {
    const line = priceLine({ quantity: '3', unitPrice: '1333', taxType: 'TAXABLE' });
    expect(line.supplyAmount).toBe('3999');
    expect(line.vatAmount).toBe('399'); // floor(399.9), not 400
    expect(line.totalAmount).toBe('4398');
  });

  it('B-12 라인2: 수량 1.5 × 단가 1,001 면세 → 공급가 1,501 / 부가세 0', () => {
    const line = priceLine({ quantity: '1.5', unitPrice: '1001', taxType: 'EXEMPT' });
    expect(line.supplyAmount).toBe('1501'); // floor(1501.5)
    expect(line.vatAmount).toBe('0');
  });

  it('B-12 합계: 공급가 5,500 / 부가세 399 / 총액 5,899', () => {
    const { totals } = priceLines([
      { quantity: '3', unitPrice: '1333', taxType: 'TAXABLE' },
      { quantity: '1.5', unitPrice: '1001', taxType: 'EXEMPT' },
    ]);
    expect(totals.supplyAmount).toBe('5500');
    expect(totals.vatAmount).toBe('399');
    expect(totals.totalAmount).toBe('5899');
  });

  it('합계는 라인 합이지 합계의 10%가 아니다', () => {
    // three taxable lines of 3,333: per line VAT is 333 each (999), not floor(9,999 x 10%) = 999
    // choose figures where the two methods differ: 5 lines of 1,999
    const { totals } = priceLines(
      Array.from({ length: 5 }, () => ({ quantity: '1', unitPrice: '1999', taxType: 'TAXABLE' })),
    );
    expect(totals.supplyAmount).toBe('9995');
    // per-line: floor(199.9) x 5 = 995. document-level would be floor(999.5) = 999.
    expect(totals.vatAmount).toBe('995');
  });

  it('영세는 부가세 0이지만 공급가는 그대로다', () => {
    const line = priceLine({ quantity: '2', unitPrice: '5000', taxType: 'ZERO' });
    expect(line.supplyAmount).toBe('10000');
    expect(line.vatAmount).toBe('0');
  });

  it('절사는 항상 내림이다', () => {
    // 0.999 x 1000 = 999.0 exactly; 1.0009 x 1000 = 1000.9 -> 1000
    expect(priceLine({ quantity: '1.001', unitPrice: '999' }).supplyAmount).toBe('999');
  });

  it('수량 0이나 음수는 거부한다: 반품은 별도 문서유형이다 (SLS-11)', () => {
    expect(() => priceLine({ quantity: '0', unitPrice: '1000' })).toThrow(/0보다 커야/);
    expect(() => priceLine({ quantity: '-1', unitPrice: '1000' })).toThrow(/0보다 커야/);
  });

  it('단가 0은 허용한다: 무상 샘플도 전표가 필요하다', () => {
    const line = priceLine({ quantity: '5', unitPrice: '0' });
    expect(line.supplyAmount).toBe('0');
    expect(line.vatAmount).toBe('0');
  });

  it('알 수 없는 과세구분은 거부한다', () => {
    expect(() => priceLine({ quantity: '1', unitPrice: '1000', taxType: 'SOMETHING' })).toThrow(/과세구분/);
  });

  it('큰 금액도 부동소수 오차 없이 계산한다 (INT-01)', () => {
    const line = priceLine({ quantity: '999999', unitPrice: '999999', taxType: 'TAXABLE' });
    expect(line.supplyAmount).toBe('999998000001');
    expect(line.vatAmount).toBe('99999800000');
  });
});

describe('ADR-0004 부가세 포함가 분해', () => {
  it('포함가 11,000 → 공급가 10,000 / 부가세 1,000', () => {
    expect(splitVatInclusive('11000')).toEqual({ supplyAmount: '10000', vatAmount: '1000' });
  });

  it('나누어떨어지지 않아도 공급가 + 부가세는 입력한 포함가와 정확히 같다', () => {
    const { supplyAmount, vatAmount } = splitVatInclusive('10000');
    expect(supplyAmount).toBe('9090'); // floor(9090.909...)
    expect(vatAmount).toBe('910');
    expect(Number(supplyAmount) + Number(vatAmount)).toBe(10000);
  });

  it('면세는 전액이 공급가다', () => {
    expect(splitVatInclusive('10000', 'EXEMPT')).toEqual({ supplyAmount: '10000', vatAmount: '0' });
  });
});

describe('SLS-08 연령분석 구간', () => {
  it('경계값이 아래 구간에 포함된다', () => {
    expect(agingBucket(0)).toBe('CURRENT');
    expect(agingBucket(30)).toBe('CURRENT');
    expect(agingBucket(31)).toBe('D30');
    expect(agingBucket(60)).toBe('D30');
    expect(agingBucket(61)).toBe('D60');
    expect(agingBucket(90)).toBe('D60');
    expect(agingBucket(91)).toBe('D90');
    expect(agingBucket(120)).toBe('D90');
    expect(agingBucket(121)).toBe('OVER90');
  });
});

describe('SLS-02 잔여수량', () => {
  it('전환된 수량만큼 줄고, 취소된 수량만큼 되돌아온다', () => {
    expect(remainingQuantity('10', '4').toString()).toBe('6');
    expect(remainingQuantity('10', '10', '4').toString()).toBe('4');
    expect(remainingQuantity('10', '10').toString()).toBe('0');
  });

  it('소수 수량도 정확히 남는다', () => {
    expect(remainingQuantity('10.5', '3.25').toString()).toBe('7.25');
  });
});
