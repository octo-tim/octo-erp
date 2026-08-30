import { describe, expect, it } from 'vitest';
import { averageOf } from '@/server/modules/inventory/valuation';
import { D } from '@/lib/money';

/**
 * DEC-01 / ADR-0003 / acceptance-scenarios B-11.
 * These numbers are the approved calculation example. If a change makes one of them move,
 * the change is wrong until DEC-01 itself is re-decided.
 */
describe('DEC-01 월 총평균 단가', () => {
  it('B-11 잠정단가: 전월말 10@1,000 + 당월 입고 10@1,200 → 1,100', () => {
    const avg = averageOf(D(10_000), D(12_000), D(10), D(10));
    expect(avg.toString()).toBe('1100');
  });

  it('B-11 확정 평균가: 입고 두 건을 모두 반영하면 1,233 (원단위 절사)', () => {
    // (10,000 + 12,000 + 15,000) / (10 + 10 + 10) = 1,233.33... → 1,233
    const avg = averageOf(D(10_000), D(27_000), D(10), D(20));
    expect(avg.toString()).toBe('1233');
  });

  it('확정 평균가로 출고 13개를 평가하면 16,029원이고 기말은 20,971원이다', () => {
    const avg = averageOf(D(10_000), D(27_000), D(10), D(20));
    const outCost = avg.times(13);
    expect(outCost.toString()).toBe('16029');
    expect(D(37_000).minus(outCost).toString()).toBe('20971');
  });

  it('잠정 합계 15,364와 확정 16,029의 차이 665가 마감조정 금액이다', () => {
    const provisional = D(1_100).times(5).plus(D(1_233).times(8)); // 5,500 + 9,864
    expect(provisional.toString()).toBe('15364');
    const final = averageOf(D(10_000), D(27_000), D(10), D(20)).times(13);
    expect(final.minus(provisional).toString()).toBe('665');
  });

  it('절사는 버림이다: 나눗셈 결과의 소수점 이하를 올리지 않는다', () => {
    // 999.99... must become 999, never 1,000
    expect(averageOf(D(0), D(99_999), D(0), D(100)).toString()).toBe('999');
  });

  it('수량이 0이면 단가는 0이다 (0으로 나누지 않는다)', () => {
    expect(averageOf(D(5_000), D(0), D(0), D(0)).toString()).toBe('0');
  });

  it('수량이 음수여도 단가 계산이 폭주하지 않는다', () => {
    // a negative position is a data problem, not a reason to produce a nonsense unit cost
    expect(averageOf(D(1_000), D(0), D(-5), D(0)).toString()).toBe('0');
  });
});
