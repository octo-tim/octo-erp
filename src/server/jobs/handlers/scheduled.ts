import { logger } from '@/server/core/logger';

/**
 * Scheduled jobs enqueued as outbox events (job.*). Each module registers its handler here
 * once implemented: safety stock (INV-07), contract expiry (HRM-08), long-pending approvals
 * (APV-11), retention purge (NFR-SEC-08).
 */
type JobHandler = (payload: Record<string, unknown>) => Promise<void>;

const handlers = new Map<string, JobHandler>();

export function registerJob(topic: string, handler: JobHandler): void {
  handlers.set(topic, handler);
}

export async function runScheduledJob(topic: string, payload: Record<string, unknown>): Promise<void> {
  const handler = handlers.get(topic);
  if (!handler) {
    logger.warn({ topic }, 'no handler registered for scheduled job');
    return;
  }
  await handler(payload);
}
