import { describe, expect, it } from 'vitest';
import {
  bucketLabel,
  defaultFilter,
  divisionIdsFor,
  isEmptyScope,
  resolveFilter,
  truncUnit,
  warehouseIdsFor,
} from '@/server/modules/report/filter';
import type { Actor, TransactionContext } from '@/server/core/context';

function actor(overrides: Partial<Actor> = {}): Actor {
  return {
    userId: 'u1',
    username: 'tester',
    displayName: '시험자',
    isAdmin: false,
    permissions: new Set(['report.read']),
    divisionIds: [],
    warehouseIds: [],
    employeeId: null,
    roleCodes: [],
    ...overrides,
  } as Actor;
}

const ctxFor = (a: Actor) => ({ actor: a }) as unknown as TransactionContext;

describe('RPT-07 공통 조회조건', () => {
  it('종료일을 포함하도록 상한을 하루 뒤로 잡는다', () => {
    const f = resolveFilter(ctxFor(actor({ isAdmin: true })), { from: '2026-06-01', to: '2026-06-30' });
    expect(f.toExclusive.toISOString().slice(0, 10)).toBe('2026-07-01');
  });

  it('전년동기는 같은 구간을 1년 앞당긴 것이다', () => {
    const f = resolveFilter(ctxFor(actor({ isAdmin: true })), { from: '2026-06-01', to: '2026-06-30' });
    expect(f.priorFromDate.toISOString().slice(0, 10)).toBe('2025-06-01');
    expect(f.priorToExclusive.toISOString().slice(0, 10)).toBe('2025-07-01');
  });

  it('종료일이 시작일보다 빠르면 거부한다', () => {
    expect(() =>
      resolveFilter(ctxFor(actor({ isAdmin: true })), { from: '2026-06-30', to: '2026-06-01' }),
    ).toThrow(/종료일/);
  });

  it('날짜 형식이 아니면 거부한다', () => {
    expect(() =>
      resolveFilter(ctxFor(actor({ isAdmin: true })), { from: '2026/06/01', to: '2026-06-30' }),
    ).toThrow(/형식/);
  });

  /** INT-12: the filter is the place the scope is enforced, so it is tested here. */
  it('권한 범위 밖 사업부를 지정하면 조용히 비우지 않고 거부한다', () => {
    const a = actor({ divisionIds: ['div-A'] });
    expect(() =>
      resolveFilter(ctxFor(a), { from: '2026-06-01', to: '2026-06-30', divisionId: 'div-B' }),
    ).toThrow(/사업부/);
  });

  it('범위 안 사업부는 통과한다', () => {
    const a = actor({ divisionIds: ['div-A'] });
    const f = resolveFilter(ctxFor(a), { from: '2026-06-01', to: '2026-06-30', divisionId: 'div-A' });
    expect(divisionIdsFor(f)).toEqual(['div-A']);
  });

  it('지정하지 않으면 자기 범위 전체가 대상이 된다', () => {
    const a = actor({ divisionIds: ['div-A', 'div-B'], warehouseIds: ['wh-1'] });
    const f = resolveFilter(ctxFor(a), { from: '2026-06-01', to: '2026-06-30' });
    expect(divisionIdsFor(f)).toEqual(['div-A', 'div-B']);
    expect(warehouseIdsFor(f)).toEqual(['wh-1']);
  });

  it('관리자는 제한이 없다', () => {
    const f = resolveFilter(ctxFor(actor({ isAdmin: true })), { from: '2026-06-01', to: '2026-06-30' });
    expect(divisionIdsFor(f)).toBeNull();
    expect(warehouseIdsFor(f)).toBeNull();
  });

  it('범위가 비어 있으면 아무것도 못 본다: 기본 거부', () => {
    const f = resolveFilter(ctxFor(actor()), { from: '2026-06-01', to: '2026-06-30' });
    expect(isEmptyScope(divisionIdsFor(f))).toBe(true);
    expect(isEmptyScope(null)).toBe(false);
  });
});

describe('RPT-01 집계 단위', () => {
  it('단위마다 Postgres 절단 단위가 정해져 있다', () => {
    expect(truncUnit('DAY')).toBe('day');
    expect(truncUnit('WEEK')).toBe('week');
    expect(truncUnit('MONTH')).toBe('month');
    expect(truncUnit('QUARTER')).toBe('quarter');
  });

  it('구간 이름이 단위에 맞게 붙는다', () => {
    const d = new Date('2026-08-30T00:00:00.000Z');
    expect(bucketLabel('DAY', d)).toBe('2026-08-30');
    expect(bucketLabel('MONTH', d)).toBe('2026-08');
    expect(bucketLabel('QUARTER', d)).toBe('2026-Q3');
  });

  it('기본 조회기간은 당월 1일부터 말일까지다', () => {
    const f = defaultFilter(new Date('2026-02-14T00:00:00.000Z'));
    expect(f.from).toBe('2026-02-01');
    expect(f.to).toBe('2026-02-28');
  });

  it('윤년 2월도 말일을 맞춘다', () => {
    expect(defaultFilter(new Date('2028-02-14T00:00:00.000Z')).to).toBe('2028-02-29');
  });
});
