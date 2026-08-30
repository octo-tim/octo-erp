import type { TransactionContext } from '@/server/core/context';
import { redact } from '@/server/core/redact';

export type OutboxTopic =
  | 'email.send'
  | 'messenger.send'
  | 'job.safety_stock'
  | 'job.contract_expiry'
  | 'job.long_pending_approval'
  | 'job.retention';

export interface EnqueueInput {
  topic: OutboxTopic;
  payload: Record<string, unknown>;
  /** Unique per topic — a second enqueue with the same key is ignored (INT-10/INT-11). */
  dedupKey?: string;
  delayMs?: number;
}

/** INT-10: the ONLY way to trigger effects outside the database. */
export async function enqueue(ctx: TransactionContext, input: EnqueueInput): Promise<void> {
  const nextAttemptAt = new Date(ctx.now.getTime() + (input.delayMs ?? 0));
  // ON CONFLICT DO NOTHING rather than catch(P2002): a failed statement would abort
  // the surrounding transaction, and a duplicate dedupKey simply means the effect is
  // already scheduled.
  await ctx.tx.$executeRaw`
    INSERT INTO "OutboxEvent" ("id", "topic", "payload", "dedupKey", "status", "attempt", "nextAttemptAt", "createdAt", "updatedAt")
    VALUES (gen_random_uuid()::text, ${input.topic}, ${JSON.stringify(redact(input.payload))}::jsonb,
            ${input.dedupKey ?? null}, 'PENDING', 0, ${nextAttemptAt}, NOW(), NOW())
    ON CONFLICT ("topic", "dedupKey") DO NOTHING`;
}

export const BACKOFF_MS = [60_000, 300_000, 1_800_000, 7_200_000, 43_200_000];
export const MAX_ATTEMPTS = BACKOFF_MS.length;

export function nextBackoff(attempt: number): number {
  return BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)] ?? 43_200_000;
}
