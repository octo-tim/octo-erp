import { withTransaction } from '@/server/core/context';
import type { Actor } from '@/server/core/context';
import { prisma } from '@/server/db';
import { logger } from '@/server/core/logger';
import { enqueue, type OutboxTopic } from '@/server/modules/outbox/service';
import { businessDate, TZ } from '@/lib/dates';

/**
 * What actually starts the periodic jobs.
 *
 * `registerScheduledJobs` gave every `job.*` topic a handler, which fixed events being
 * silently discarded. It did not fix a second, quieter half of the same problem: two of
 * those three topics were never enqueued by anything. `job.contract_expiry` is emitted as a
 * side effect of editing an employee, but nothing in the system ever emitted
 * `job.long_pending_approval` or `job.retention`, so the long-pending reminder and the
 * personal-data retention run had working handlers waiting on events that never arrived.
 * A registered handler is not a schedule.
 *
 * There is no external scheduler in this deployment, so the outbox worker — which already
 * runs continuously and already survives restarts — is where the daily tick belongs. The
 * dedupKey is the business day, and OutboxEvent has a unique index on (topic, dedupKey)
 * with ON CONFLICT DO NOTHING, so several worker replicas ticking at once still produce one
 * run per day. Missing the hour entirely is not possible either: the condition is "the hour
 * has passed and today's run has not been enqueued", so a worker started at 18:00 still
 * enqueues the 09:00 job for that day rather than skipping to tomorrow.
 */
interface DailyJob {
  topic: OutboxTopic;
  /** KST hour at or after which the day's run may be enqueued. */
  hour: number;
  description: string;
}

export const DAILY_JOBS: DailyJob[] = [
  { topic: 'job.long_pending_approval', hour: 9, description: 'APV-11 장기 미결 결재 알림' },
  { topic: 'job.retention', hour: 2, description: '개인정보 보유기간 경과 대상 파기 계획' },
];

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

function kstHour(at: Date): number {
  return new Date(at.getTime() + KST_OFFSET_MS).getUTCHours();
}

function systemActor(): Actor {
  return {
    userId: 'system',
    username: 'system',
    displayName: '시스템',
    employeeId: null,
    roles: ['system'],
    permissions: new Set(['*']),
    divisionIds: [],
    warehouseIds: [],
    isAdmin: true,
  };
}

/** Enqueues any daily job whose hour has passed and that has not run today. Returns how many. */
export async function enqueueDueJobs(now: Date = new Date()): Promise<number> {
  const day = businessDate(now);
  const hour = kstHour(now);
  const due = DAILY_JOBS.filter((j) => hour >= j.hour);
  if (due.length === 0) return 0;

  let enqueued = 0;
  for (const job of due) {
    // Read first so the log tells the truth about which runs this tick actually created:
    // the insert itself is ON CONFLICT DO NOTHING and reports nothing back.
    const existing = await prisma.outboxEvent.findFirst({
      where: { topic: job.topic, dedupKey: day },
      select: { id: true },
    });
    if (existing) continue;

    await withTransaction(
      prisma,
      { actor: systemActor(), requestId: `scheduler:${job.topic}:${day}`, now },
      (ctx) => enqueue(ctx, { topic: job.topic, payload: { scheduledFor: day }, dedupKey: day }),
    );
    enqueued += 1;
    logger.info({ topic: job.topic, day, tz: TZ }, 'scheduled job enqueued');
  }
  return enqueued;
}
