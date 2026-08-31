import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { prisma } from '@/server/db';
import { logger } from '@/server/core/logger';
import { MAX_ATTEMPTS, nextBackoff } from '@/server/modules/outbox/service';
import { sendEmail } from './handlers/email';
import { runScheduledJob } from './handlers/scheduled';
import { registerScheduledJobs } from './register';

/**
 * INT-10: the transactional-outbox worker. Claims with FOR UPDATE SKIP LOCKED so
 * multiple instances can run, retries with backoff, and never blocks business writes.
 */
// every scheduled job has a handler before a single event is claimed
registerScheduledJobs();

const WORKER_ID = `${process.env['RAILWAY_REPLICA_ID'] ?? 'local'}:${process.pid}:${randomUUID().slice(0, 8)}`;
const BATCH = Number(process.env['OUTBOX_BATCH'] ?? 20);
const POLL_MS = Number(process.env['OUTBOX_POLL_MS'] ?? 2000);
const STALE_LOCK_MS = 10 * 60 * 1000;

interface Claimed {
  id: string;
  topic: string;
  payload: unknown;
  attempt: number;
}

async function reclaimStale(): Promise<void> {
  await prisma.outboxEvent.updateMany({
    where: { status: 'PROCESSING', lockedAt: { lt: new Date(Date.now() - STALE_LOCK_MS) } },
    data: { status: 'PENDING', lockedBy: null, lockedAt: null },
  });
}

async function claim(): Promise<Claimed[]> {
  return prisma.$queryRaw<Claimed[]>`
    UPDATE "OutboxEvent" SET "status" = 'PROCESSING', "lockedBy" = ${WORKER_ID}, "lockedAt" = NOW()
    WHERE "id" IN (
      SELECT "id" FROM "OutboxEvent"
      WHERE "status" = 'PENDING' AND "nextAttemptAt" <= NOW()
      ORDER BY "nextAttemptAt" ASC
      FOR UPDATE SKIP LOCKED
      LIMIT ${BATCH}
    )
    RETURNING "id", "topic", "payload", "attempt"`;
}

async function dispatch(event: Claimed): Promise<void> {
  const payload = event.payload as Record<string, unknown>;
  switch (event.topic) {
    case 'email.send':
      await sendEmail(payload as { to: string; subject: string; text: string; notificationId?: string });
      break;
    case 'messenger.send':
      // DEC-09: messenger channel is NONE until the company picks one (ADR-0010).
      logger.info({ topic: event.topic }, 'messenger channel not configured; skipping');
      break;
    default:
      if (event.topic.startsWith('job.')) {
        await runScheduledJob(event.topic, payload);
        break;
      }
      throw new Error(`unknown outbox topic: ${event.topic}`);
  }
}

async function processOne(event: Claimed): Promise<void> {
  try {
    await dispatch(event);
    await prisma.outboxEvent.update({
      where: { id: event.id },
      data: { status: 'DONE', processedAt: new Date(), lockedBy: null, lockedAt: null, lastError: null },
    });
    const notificationId = (event.payload as { notificationId?: string }).notificationId;
    if (notificationId) {
      await prisma.notificationDelivery.updateMany({
        where: { notificationId, channel: 'EMAIL', status: { not: 'SENT' } },
        data: { status: 'SENT', sentAt: new Date() },
      });
    }
  } catch (e) {
    const attempt = event.attempt + 1;
    const failed = attempt >= MAX_ATTEMPTS;
    const message = (e as Error).message.slice(0, 1000);
    await prisma.outboxEvent.update({
      where: { id: event.id },
      data: {
        status: failed ? 'FAILED' : 'PENDING',
        attempt,
        nextAttemptAt: new Date(Date.now() + nextBackoff(attempt - 1)),
        lastError: message,
        lockedBy: null,
        lockedAt: null,
      },
    });
    const notificationId = (event.payload as { notificationId?: string }).notificationId;
    if (notificationId) {
      await prisma.notificationDelivery.updateMany({
        where: { notificationId, channel: 'EMAIL' },
        data: { status: failed ? 'FAILED' : 'PENDING', attempt, lastError: message },
      });
    }
    logger.warn(
      { id: event.id, topic: event.topic, attempt, failed, err: message },
      'outbox delivery failed',
    );
    if (failed) await notifyAdminsOfFailure(event.id, event.topic, message);
  }
}

async function notifyAdminsOfFailure(eventId: string, topic: string, error: string): Promise<void> {
  const admins = await prisma.user.findMany({
    where: { isActive: true, roles: { some: { role: { code: 'admin' } } } },
    select: { id: true },
  });
  if (admins.length === 0) return;
  await prisma.notification.createMany({
    data: admins.map((a) => ({
      userId: a.id,
      category: 'SYSTEM',
      title: `알림 발송 실패: ${topic}`,
      body: `${error}\n실패작업 화면에서 재시도할 수 있습니다.`,
      linkUrl: `/system/jobs?id=${eventId}`,
    })),
  });
}

export async function tick(): Promise<number> {
  await reclaimStale();
  const events = await claim();
  for (const event of events) await processOne(event);
  return events.length;
}

async function main(): Promise<void> {
  logger.info({ workerId: WORKER_ID, batch: BATCH, pollMs: POLL_MS }, 'outbox worker started');
  let running = true;
  const stop = () => {
    running = false;
    logger.info('outbox worker stopping');
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);

  while (running) {
    try {
      const n = await tick();
      if (n === 0) await new Promise((r) => setTimeout(r, POLL_MS));
    } catch (e) {
      logger.error({ err: (e as Error).message }, 'outbox worker loop error');
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
  }
  await prisma.$disconnect();
}

if (process.argv[1]?.includes('worker')) {
  void main();
}
