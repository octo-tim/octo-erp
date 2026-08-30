import { describe, expect, it } from 'vitest';
import { validateLines } from '@/server/modules/accounting/journal';
import { normalSideOf, isProfitAndLoss } from '@/server/modules/accounting/account';

/**
 * ACC-02: the balance rule. These are the checks that decide whether the books can be
 * trusted at all, so they are tested at the level where they are cheapest to run.
 */
describe('ACC-02 분개 균형 검증', () => {
  const account = (n: number) => `acc${n}`;

  it('차변 합계와 대변 합계가 같으면 통과한다', () => {
    const totals = validateLines([
      { accountId: account(1), debit: '660000' },
      { accountId: account(2), credit: '600000' },
      { accountId: account(3), credit: '60000' },
    ]);
    expect(totals).toEqual({ debit: '660000', credit: '660000' });
  });

  it('불균형이면 차액을 알려주며 거부한다', () => {
    expect(() =>
      validateLines([
        { accountId: account(1), debit: '660000' },
        { accountId: account(2), credit: '600000' },
      ]),
    ).toThrow(/차액 60000원/);
  });

  it('한 행에 차변과 대변을 동시에 넣을 수 없다', () => {
    expect(() =>
      validateLines([
        { accountId: account(1), debit: '1000', credit: '1000' },
        { accountId: account(2), credit: '1000' },
      ]),
    ).toThrow(/동시에 금액을 넣을 수 없습니다/);
  });

  it('금액이 0인 행은 저장할 수 없다', () => {
    expect(() =>
      validateLines([
        { accountId: account(1), debit: '1000' },
        { accountId: account(2), credit: '1000' },
        { accountId: account(3), debit: '0', credit: '0' },
      ]),
    ).toThrow(/금액이 0인 행/);
  });

  it('음수 금액은 거부한다: 반대 부호가 아니라 반대 변으로 표현한다', () => {
    expect(() =>
      validateLines([
        { accountId: account(1), debit: '-1000' },
        { accountId: account(2), credit: '-1000' },
      ]),
    ).toThrow(/0 이상/);
  });

  it('합계가 0이면 균형이 맞아도 저장하지 않는다', () => {
    expect(() =>
      validateLines([
        { accountId: account(1), debit: '0', credit: '0' },
        { accountId: account(2), debit: '0', credit: '0' },
      ]),
    ).toThrow();
  });

  it('한 줄짜리 분개는 성립하지 않는다', () => {
    expect(() => validateLines([{ accountId: account(1), debit: '1000' }])).toThrow(/한 줄 이상/);
  });

  it('계정과목이 비면 행 번호와 함께 알려준다', () => {
    expect(() =>
      validateLines([
        { accountId: '', debit: '1000' },
        { accountId: account(2), credit: '1000' },
      ]),
    ).toThrow(/1행: 계정과목/);
  });

  it('여러 문제를 한 번에 모아 알려준다', () => {
    try {
      validateLines([
        { accountId: '', debit: '1000', credit: '500' },
        { accountId: account(2), debit: '0', credit: '0' },
      ]);
      expect.unreachable('오류가 발생해야 한다');
    } catch (e) {
      const message = (e as Error).message;
      expect(message).toContain('1행: 계정과목');
      expect(message).toContain('1행: 차변과 대변');
      expect(message).toContain('2행: 금액이 0');
    }
  });

  it('원 단위 이하가 없는 큰 금액도 정확히 비교한다 (INT-01)', () => {
    // 0.1 + 0.2 style float error would break this comparison
    const totals = validateLines([
      { accountId: account(1), debit: '999999999999' },
      { accountId: account(2), credit: '999999999998' },
      { accountId: account(3), credit: '1' },
    ]);
    expect(totals.debit).toBe('999999999999');
  });
});

describe('ACC-01 계정 성격', () => {
  it('자산·비용은 차변이 증가 방향이다', () => {
    expect(normalSideOf('ASSET')).toBe('DEBIT');
    expect(normalSideOf('EXPENSE')).toBe('DEBIT');
  });

  it('부채·자본·수익은 대변이 증가 방향이다', () => {
    expect(normalSideOf('LIABILITY')).toBe('CREDIT');
    expect(normalSideOf('EQUITY')).toBe('CREDIT');
    expect(normalSideOf('REVENUE')).toBe('CREDIT');
  });

  it('손익 계정만 연말에 마감된다 (ACC-08)', () => {
    expect(isProfitAndLoss('REVENUE')).toBe(true);
    expect(isProfitAndLoss('EXPENSE')).toBe(true);
    expect(isProfitAndLoss('ASSET')).toBe(false);
    expect(isProfitAndLoss('LIABILITY')).toBe(false);
    expect(isProfitAndLoss('EQUITY')).toBe(false);
  });
});
