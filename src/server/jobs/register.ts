import { registerJob } from './handlers/scheduled';
import { retentionJob } from './retention';
import { contractExpiryJob } from './handlers/contract-expiry';
import { longPendingApprovalJob } from './handlers/long-pending';

/**
 * Where the scheduled jobs are wired up.
 *
 * This file is the thing that was missing. `registerJob` existed, three modules enqueued
 * `job.*` events, and nothing ever called `registerJob` — so every scheduled job reached a
 * worker with no handler, was logged at warn level, and was marked DONE. Contract expiry
 * reminders, long-pending approval alerts and the personal-data retention run were all
 * silently discarded while the outbox reported success. Registration now happens in one
 * place that the worker imports, and `runScheduledJob` throws on an unknown topic so the
 * same thing cannot happen quietly again.
 */
let registered = false;

export function registerScheduledJobs(): void {
  if (registered) return;
  registerJob('job.retention', retentionJob);
  registerJob('job.contract_expiry', contractExpiryJob);
  registerJob('job.long_pending_approval', longPendingApprovalJob);
  registered = true;
}

export function __resetScheduledJobs(): void {
  registered = false;
}
