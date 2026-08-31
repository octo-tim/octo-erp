// covers: INT-05, INT-06, INT-09, INT-10, INT-11, B-03, B-08, B-09
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { actorFor, baseCtx, prepareDatabase, prisma, runTx, truncateBusinessData } from '../helpers/db';
import { withTransaction } from '@/server/core/context';
import { idempotent } from '@/server/core/idempotency';
import * as audit from '@/server/modules/audit/service';
import * as outbox from '@/server/modules/outbox/service';
import * as notification from '@/server/modules/notification/service';
import { nextDocNo } from '@/server/modules/numbering/service';
import * as approval from '@/server/modules/approval/service';
import { AppError } from '@/server/core/errors';
import type { Actor } from '@/server/core/context';

let admin: Actor;

beforeAll(async () => {
  prepareDatabase();
  admin = await actorFor('admin');
});

beforeEach(() => truncateBusinessData());

afterAll(() => prisma.$disconnect());

describe('idempotency (INT-05, B-03)', () => {
  it('runs the body once for the same requestId and replays the stored result', async () => {
    const requestId = randomUUID();
    let calls = 0;
    const run = () =>
      withTransaction(prisma, { ...baseCtx(admin), requestId }, (t) =>
        idempotent(t, 'test.confirm', async () => {
          calls++;
          await t.tx.notification.create({
            data: { userId: admin.userId, category: 'SYSTEM', title: `run ${calls}` },
          });
          return { docNo: 'X-1', calls };
        }),
      );

    const first = await run();
    const second = await run();

    expect(calls).toBe(1);
    expect(second).toEqual(first);
    expect(await prisma.notification.count()).toBe(1);
  });

  it('a different requestId runs again', async () => {
    let calls = 0;
    const run = (requestId: string) =>
      withTransaction(prisma, { ...baseCtx(admin), requestId }, (t) =>
        idempotent(t, 'test.confirm', async () => ++calls),
      );
    await run(randomUUID());
    await run(randomUUID());
    expect(calls).toBe(2);
  });

  it('two concurrent calls with the same requestId produce one effect', async () => {
    const requestId = randomUUID();
    const run = () =>
      withTransaction(prisma, { ...baseCtx(admin), requestId }, (t) =>
        idempotent(t, 'test.concurrent', async () => {
          await new Promise((r) => setTimeout(r, 50));
          await t.tx.notification.create({
            data: { userId: admin.userId, category: 'SYSTEM', title: 'concurrent' },
          });
          return 'ok';
        }),
      );

    const results = await Promise.allSettled([run(), run()]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    expect(fulfilled.length).toBeGreaterThanOrEqual(1);
    expect(await prisma.notification.count({ where: { title: 'concurrent' } })).toBe(1);
  });

  it('rolls the idempotency record back with the transaction so retries work', async () => {
    const requestId = randomUUID();
    await expect(
      withTransaction(prisma, { ...baseCtx(admin), requestId }, (t) =>
        idempotent(t, 'test.fail', async () => {
          throw new AppError('INTERNAL', 'boom');
        }),
      ),
    ).rejects.toThrow('boom');

    expect(await prisma.idempotencyRecord.count()).toBe(0);

    const retried = await withTransaction(prisma, { ...baseCtx(admin), requestId }, (t) =>
      idempotent(t, 'test.fail', async () => 'recovered'),
    );
    expect(retried).toBe('recovered');
  });
});

describe('transaction atomicity (INT-06, B-08)', () => {
  it('rolls back audit rows and outbox events when a later step fails', async () => {
    await expect(
      runTx(admin, async (t) => {
        await audit.record(t, { action: 'test.atomic', entityType: 'Test', entityId: 'x' });
        await outbox.enqueue(t, { topic: 'email.send', payload: { to: 'a@b.c', subject: 's', text: 't' } });
        await notification.notify(t, { userIds: [admin.userId], category: 'SYSTEM', title: '롤백 대상' });
        throw new AppError('INTERNAL', 'accounting step failed');
      }),
    ).rejects.toThrow('accounting step failed');

    expect(await prisma.auditLog.count({ where: { action: 'test.atomic' } })).toBe(0);
    expect(await prisma.outboxEvent.count()).toBe(0);
    expect(await prisma.notification.count()).toBe(0);
  });

  it('commits audit and outbox together with the business change', async () => {
    await runTx(admin, async (t) => {
      await audit.record(t, {
        action: 'test.commit',
        entityType: 'Test',
        entityId: 'y',
        after: { ok: true },
      });
      await notification.notify(t, {
        userIds: [admin.userId],
        category: 'SYSTEM',
        title: '커밋 대상',
        email: false,
      });
    });
    expect(await prisma.auditLog.count({ where: { action: 'test.commit' } })).toBe(1);
    expect(await prisma.notification.count({ where: { title: '커밋 대상' } })).toBe(1);
  });
});

describe('outbox (INT-10, B-09)', () => {
  it('enqueues email delivery rows in the same transaction as the notification', async () => {
    await prisma.user.update({ where: { id: admin.userId }, data: { email: 'admin@octoworks.test' } });
    await runTx(admin, (t) =>
      notification.notify(t, {
        userIds: [admin.userId],
        category: 'APPROVAL',
        title: '결재 요청',
        email: true,
      }),
    );

    const events = await prisma.outboxEvent.findMany();
    expect(events).toHaveLength(1);
    expect(events[0]!.topic).toBe('email.send');
    expect(events[0]!.status).toBe('PENDING');
    expect(await prisma.notificationDelivery.count()).toBe(1);
  });

  it('INT-11: a duplicate dedupKey does not create a second event', async () => {
    await runTx(admin, async (t) => {
      await outbox.enqueue(t, {
        topic: 'job.safety_stock',
        payload: { itemId: 'i1' },
        dedupKey: 'safety:i1:2026-08-30',
      });
      await outbox.enqueue(t, {
        topic: 'job.safety_stock',
        payload: { itemId: 'i1' },
        dedupKey: 'safety:i1:2026-08-30',
      });
    });
    expect(await prisma.outboxEvent.count({ where: { topic: 'job.safety_stock' } })).toBe(1);
  });

  it('redacts sensitive payload fields before storing', async () => {
    await runTx(admin, (t) =>
      outbox.enqueue(t, {
        topic: 'email.send',
        payload: { to: 'a@b.c', subject: 's', text: 't', password: 'leak-me' },
      }),
    );
    expect(JSON.stringify(await prisma.outboxEvent.findMany())).not.toContain('leak-me');
  });

  it('backoff grows and caps', () => {
    expect(outbox.nextBackoff(0)).toBe(60_000);
    expect(outbox.nextBackoff(4)).toBe(43_200_000);
    expect(outbox.nextBackoff(99)).toBe(43_200_000);
  });
});

describe('numbering (BAS-01, APV-13, B-10)', () => {
  it('produces sequential numbers with the configured prefix and period', async () => {
    const first = await runTx(admin, (t) => nextDocNo(t, 'SALES', '2026-08-30'));
    const second = await runTx(admin, (t) => nextDocNo(t, 'SALES', '2026-08-30'));
    expect(first).toBe('SL-202608-0001');
    expect(second).toBe('SL-202608-0002');
  });

  it('B-10: 30 concurrent calls yield 30 distinct numbers with no gaps', async () => {
    const results = await Promise.all(
      Array.from({ length: 30 }, () => runTx(admin, (t) => nextDocNo(t, 'JOURNAL', '2026-09-01'))),
    );
    const unique = new Set(results);
    expect(unique.size).toBe(30);
    const seqs = results.map((r) => Number(r.split('-')[2])).sort((a, b) => a - b);
    expect(seqs[0]).toBe(1);
    expect(seqs[29]).toBe(30);
  });

  it('restarts the sequence in a new period', async () => {
    await runTx(admin, (t) => nextDocNo(t, 'PURCHASE', '2026-08-31'));
    const next = await runTx(admin, (t) => nextDocNo(t, 'PURCHASE', '2026-09-01'));
    expect(next).toBe('PU-202609-0001');
  });

  it('fails clearly when no numbering rule exists', async () => {
    await expect(runTx(admin, (t) => nextDocNo(t, 'NO_SUCH_TYPE'))).rejects.toThrow(/채번규칙이 없습니다/);
  });

  it('APV-13: approval falls back to the shared APPROVAL rule when a form has no rule of its own', async () => {
    const first = await runTx(admin, (t) => approval.nextApprovalDocNo(t, 'EXPENSE'));
    const second = await runTx(admin, (t) => approval.nextApprovalDocNo(t, 'PROPOSAL'));
    // neither EXPENSE nor PROPOSAL has its own rule, so both share the fallback counter
    expect(first).toMatch(/^AP-\d{6}-0001$/);
    expect(second).toMatch(/^AP-\d{6}-0002$/);
  });

  it('APV-13: a form with its own numbering rule gets its own sequence, not the shared one', async () => {
    await prisma.numberingRule.create({
      data: { docType: 'APPROVAL:EXPENSE', prefix: 'APEX', periodKind: 'MONTH', seqLength: 4 },
    });
    try {
      const expenseNo = await runTx(admin, (t) => approval.nextApprovalDocNo(t, 'EXPENSE'));
      const proposalNo = await runTx(admin, (t) => approval.nextApprovalDocNo(t, 'PROPOSAL'));
      expect(expenseNo).toMatch(/^APEX-\d{6}-0001$/);
      // PROPOSAL still has no rule of its own, so it keeps using the shared fallback,
      // unaffected by EXPENSE now having a dedicated counter
      expect(proposalNo).toMatch(/^AP-\d{6}-0001$/);
    } finally {
      await prisma.numberingRule.delete({ where: { docType: 'APPROVAL:EXPENSE' } });
    }
  });
});

describe('append-only guards (INT-04, INT-07)', () => {
  it('refuses to update or delete audit rows', async () => {
    await runTx(admin, (t) => audit.record(t, { action: 'test.guard', entityType: 'Test', entityId: 'g' }));
    const row = await prisma.auditLog.findFirstOrThrow({ where: { action: 'test.guard' } });

    await expect(
      prisma.auditLog.update({ where: { id: row.id }, data: { action: 'tampered' } }),
    ).rejects.toThrow(/append-only/);
    await expect(prisma.auditLog.delete({ where: { id: row.id } })).rejects.toThrow(/append-only/);
    // the DB trigger is the hard guarantee, independent of the Prisma extension
    await expect(prisma.$executeRawUnsafe(`DELETE FROM "AuditLog" WHERE id = '${row.id}'`)).rejects.toThrow(
      /append-only/,
    );
  });
});
