// covers: INT-02, INT-03
import { describe, expect, it } from 'vitest';
import {
  assertMutable,
  assertTransition,
  assertVersion,
  documentTransitions,
} from '@/server/core/state-machine';
import { AppError } from '@/server/core/errors';

describe('document state machine (INT-02)', () => {
  it('allows the documented transitions', () => {
    expect(() => assertTransition(documentTransitions, 'DRAFT', 'PENDING_APPROVAL', '전표')).not.toThrow();
    expect(() => assertTransition(documentTransitions, 'DRAFT', 'CONFIRMED', '전표')).not.toThrow();
    expect(() =>
      assertTransition(documentTransitions, 'PENDING_APPROVAL', 'CONFIRMED', '전표'),
    ).not.toThrow();
    expect(() => assertTransition(documentTransitions, 'CONFIRMED', 'CANCELED', '전표')).not.toThrow();
  });

  it('rejects transitions out of a terminal state', () => {
    expect(() => assertTransition(documentTransitions, 'CANCELED', 'CONFIRMED', '전표')).toThrow(AppError);
    expect(() => assertTransition(documentTransitions, 'CONFIRMED', 'DRAFT', '전표')).toThrow(
      /바꿀 수 없습니다/,
    );
  });

  it('detects optimistic-lock conflicts', () => {
    expect(() => assertVersion('매출전표', 3, 3)).not.toThrow();
    try {
      assertVersion('매출전표', 4, 3);
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as AppError).code).toBe('VERSION_CONFLICT');
    }
  });

  it('INT-03: confirmed documents are immutable', () => {
    expect(() => assertMutable('매출전표', 'DRAFT')).not.toThrow();
    expect(() => assertMutable('매출전표', 'CONFIRMED')).toThrow(/취소 후 재작성/);
    expect(() => assertMutable('매출전표', 'CANCELED')).toThrow(AppError);
  });
});
