import { logger } from '@/server/core/logger';

/**
 * Scheduled jobs enqueued as outbox events (job.*). Handlers are wired in jobs/register.ts,
 * which the worker imports; nothing else should call registerJob, so there is one place to
 * look when asking whether a job actually runs.
 */
type JobHandler = (payload: Record<string, unknown>) => Promise<void>;

const handlers = new Map<string, JobHandler>();

export function registerJob(topic: string, handler: JobHandler): void {
  handlers.set(topic, handler);
}

export async function runScheduledJob(topic: string, payload: Record<string, unknown>): Promise<void> {
  const handler = handlers.get(topic);
  if (!handler) {
    /**
     * Throwing, not warning. This used to log and return, which made the worker mark the
     * event DONE — so three scheduled jobs were dropped for months while the outbox
     * reported success and the failed-jobs screen stayed empty. A job with no handler is a
     * deployment mistake, and the outbox is built to surface exactly that: the event goes
     * back to PENDING, retries, and eventually raises a failure alert.
     */
    throw new Error(`no handler registered for scheduled job: ${topic}`);
  }
  logger.info({ topic }, 'running scheduled job');
  await handler(payload);
}
