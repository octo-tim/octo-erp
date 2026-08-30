import { AppError } from './errors';

/** INT-02: the shared business-document lifecycle. */
export const DocStatus = {
  DRAFT: 'DRAFT',
  PENDING_APPROVAL: 'PENDING_APPROVAL',
  CONFIRMED: 'CONFIRMED',
  CANCELED: 'CANCELED',
} as const;
export type DocStatus = (typeof DocStatus)[keyof typeof DocStatus];

export type TransitionTable<S extends string> = Record<S, readonly S[]>;

export const documentTransitions: TransitionTable<DocStatus> = {
  DRAFT: ['PENDING_APPROVAL', 'CONFIRMED'],
  PENDING_APPROVAL: ['DRAFT', 'CONFIRMED', 'CANCELED'],
  CONFIRMED: ['CANCELED'],
  CANCELED: [],
};

export function assertTransition<S extends string>(
  table: TransitionTable<S>,
  from: S,
  to: S,
  entity: string,
): void {
  const allowed = table[from];
  if (!allowed || !allowed.includes(to)) {
    throw new AppError('INVALID_TRANSITION', `${entity} 상태를 ${from}에서 ${to}(으)로 바꿀 수 없습니다.`, {
      entity,
      from,
      to,
    });
  }
}

export function assertVersion(entity: string, current: number, expected: number): void {
  if (current !== expected) {
    throw new AppError(
      'VERSION_CONFLICT',
      `${entity}이(가) 다른 사용자에 의해 변경되었습니다. 화면을 새로 고친 뒤 다시 시도하세요.`,
      { entity, current, expected },
    );
  }
}

export function assertMutable(entity: string, status: DocStatus): void {
  if (status === 'CONFIRMED' || status === 'CANCELED') {
    throw new AppError(
      'IMMUTABLE',
      `확정 또는 취소된 ${entity}은(는) 수정할 수 없습니다. 취소 후 재작성하세요.`,
      {
        entity,
        status,
      },
    );
  }
}
