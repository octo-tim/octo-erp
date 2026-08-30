import { AppError } from './errors';
import type { TransactionContext } from './context';

/**
 * INT-05 / ADR-0012. Runs `fn` at most once per (scope, requestId).
 * The record lives in the same transaction, so a rollback also removes it and the
 * caller may retry safely.
 */
export async function idempotent<T>(
  ctx: TransactionContext,
  scope: string,
  fn: () => Promise<T>,
): Promise<T> {
  const existing = await ctx.tx.idempotencyRecord.findUnique({
    where: { scope_requestId: { scope, requestId: ctx.requestId } },
  });

  if (existing) {
    if (existing.status === 'DONE') return existing.responseJson as T;
    throw new AppError('REQUEST_IN_PROGRESS', '동일한 요청이 처리 중입니다. 잠시 후 다시 확인하세요.', {
      scope,
      requestId: ctx.requestId,
    });
  }

  try {
    await ctx.tx.idempotencyRecord.create({
      data: { scope, requestId: ctx.requestId, status: 'IN_PROGRESS' },
    });
  } catch (e) {
    if ((e as { code?: string }).code === 'P2002') {
      throw new AppError('REQUEST_IN_PROGRESS', '동일한 요청이 처리 중입니다.', {
        scope,
        requestId: ctx.requestId,
      });
    }
    throw e;
  }

  const result = await fn();

  await ctx.tx.idempotencyRecord.update({
    where: { scope_requestId: { scope, requestId: ctx.requestId } },
    data: { status: 'DONE', responseJson: result as never },
  });

  return result;
}

/** Translate a unique-constraint violation on a source link into a business error (INT-11). */
export function asDuplicateEffect(e: unknown, message: string): never {
  if ((e as { code?: string }).code === 'P2002') {
    throw new AppError('DUPLICATE_EFFECT', message);
  }
  throw e;
}
