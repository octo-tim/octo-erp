import type { TransactionContext } from '@/server/core/context';
import { redact } from '@/server/core/redact';

export interface AuditInput {
  action: string;
  entityType: string;
  entityId: string;
  before?: unknown;
  after?: unknown;
  meta?: Record<string, unknown>;
}

/** INT-09: written inside the same transaction as the business change. */
export async function record(ctx: TransactionContext, input: AuditInput): Promise<void> {
  await ctx.tx.auditLog.create({
    data: {
      actorId: ctx.actor.userId === 'system' ? null : ctx.actor.userId,
      actorName: ctx.actor.displayName,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId,
      before: input.before === undefined ? undefined : (redact(input.before) as never),
      after: input.after === undefined ? undefined : (redact(input.after) as never),
      meta: input.meta === undefined ? undefined : (redact(input.meta) as never),
      ip: ctx.ip ?? null,
      requestId: ctx.requestId,
    },
  });
}

export async function listForEntity(
  ctx: TransactionContext,
  entityType: string,
  entityId: string,
  limit = 100,
) {
  return ctx.tx.auditLog.findMany({
    where: { entityType, entityId },
    orderBy: { createdAt: 'desc' },
    take: limit,
  });
}
