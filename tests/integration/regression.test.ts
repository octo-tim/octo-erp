// covers: NFR-SEC-08, HRM-08, APV-11, INT-10, APV-07, UIX-08, SLS-04, HRM-09, HRM-13, NFR-SEC-03
/**
 * Regression tests for defects an audit found and that were then fixed, but shipped with no
 * test protecting the fix. Each test here is written to FAIL if its fix is reverted — see the
 * comment above each `it` for exactly what pre-fix behaviour it targets.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { actorFor, prepareDatabase, prisma, runTx, truncateBusinessData } from '../helpers/db';
import { registerScheduledJobs } from '@/server/jobs/register';
import { runScheduledJob } from '@/server/jobs/handlers/scheduled';
import { enqueueDueJobs } from '@/server/jobs/scheduler';
import { businessDate } from '@/lib/dates';
import * as approval from '@/server/modules/approval/service';
import * as organization from '@/server/modules/hrm/organization';
import * as employee from '@/server/modules/hrm/employee';
import * as notification from '@/server/modules/notification/service';
import * as audit from '@/server/modules/audit/service';
import * as item from '@/server/modules/master/item';
import * as partnerModule from '@/server/modules/master/partner';
import * as salesOrder from '@/server/modules/sales/sales-order';
import * as salesDocument from '@/server/modules/sales/sales-document';
import { changePassword, login, resolveSession } from '@/server/modules/auth/service';
import { hashPassword } from '@/server/core/crypto';
import { AppError } from '@/server/core/errors';
import type { Actor } from '@/server/core/context';

let admin: Actor;

beforeAll(async () => {
  prepareDatabase();
  admin = await actorFor('admin');
});

beforeEach(async () => {
  await truncateBusinessData();
  // approval domain: not part of truncateBusinessData's list (see approval.test.ts)
  await prisma.$executeRawUnsafe(`DELETE FROM "Delegation"`);
  await prisma.$executeRawUnsafe(`DELETE FROM "ApprovalDocument"`);
  // sales domain: not part of truncateBusinessData's list (see sales.test.ts)
  await prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      "SettlementMatch", "Settlement", "Receivable", "Payable",
      "TaxDocumentOutput", "DocumentConversion",
      "SalesDocumentLine", "SalesDocument", "SalesOrderLine", "SalesOrder",
      "QuotationLine", "Quotation",
      "PurchaseDocumentLine", "PurchaseDocument", "PurchaseOrderLine", "PurchaseOrder",
      "PurchaseRequestLine", "PurchaseRequest"
    RESTART IDENTITY CASCADE`);
  await prisma.$executeRawUnsafe(`UPDATE "Item" SET "defaultSupplierId" = NULL`);
  await prisma.$executeRawUnsafe(`DELETE FROM "PartnerContact"`);
  await prisma.$executeRawUnsafe(`DELETE FROM "Item"`);
  await prisma.$executeRawUnsafe(`DELETE FROM "Partner"`);
});

afterAll(() => prisma.$disconnect());

/** Runs `fn` and returns whatever it threw, so tests can assert on the error's `code`. */
async function captureError(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
  } catch (e) {
    return e;
  }
  throw new Error('expected the call to throw, but it did not');
}

// ── 1. NFR-SEC-08 / HRM-08 / APV-11 / INT-10: scheduled job registration ──
//
// Before the fix, `registerJob` was never called anywhere the worker imported. Every
// `job.*` outbox event (retention, contract expiry, long-pending approval) reached
// `runScheduledJob` with no handler registered, and — because that function used to log a
// warning and return instead of throwing — the worker marked the event DONE. Three real
// jobs were silently discarded for months while the outbox reported success.
describe('scheduled job registration (src/server/jobs/register.ts)', () => {
  it('an unknown topic throws instead of silently succeeding, both before and after registration', async () => {
    // Before anything is registered, even a topic that WILL eventually have a handler
    // throws. This is the fix in scheduled.ts: a missing handler is a thrown error, not a
    // logged warning and a quiet return.
    await expect(runScheduledJob('job.retention', {})).rejects.toThrow(/no handler registered/);

    registerScheduledJobs();

    // A topic that will never have a handler must still throw after registration.
    await expect(runScheduledJob('job.totally_unknown', {})).rejects.toThrow(/no handler registered/);
  });

  it('registerScheduledJobs wires up all three scheduled topics so they actually run', async () => {
    registerScheduledJobs();

    // Before the fix these three calls all rejected with "no handler registered for
    // scheduled job: job.xxx" because register.ts never called registerJob. If that wiring
    // regresses, these now-resolved calls go back to rejecting.
    await expect(runScheduledJob('job.retention', {})).resolves.toBeUndefined();
    await expect(runScheduledJob('job.contract_expiry', {})).resolves.toBeUndefined();
    await expect(runScheduledJob('job.long_pending_approval', {})).resolves.toBeUndefined();
  });
});

// ── 2. APV-07: approval hold release authorization ──
//
// Before the fix, `releaseHold` let anyone holding `approval.use` (nearly every role) lift
// a hold that a different approver had placed, which makes the hold meaningless. The fix
// restricts release to the approver who placed the hold (or an admin).
describe('APV-07: 결재 보류 해제는 보류를 건 결재자만 할 수 있다', () => {
  it('다른 결재자가 해제를 시도하면 FORBIDDEN이고, 보류를 건 결재자는 해제할 수 있다', async () => {
    const hash = await hashPassword('Regress!123456');
    const salesRole = await prisma.role.findUniqueOrThrow({ where: { code: 'sales' } });
    const managerRole = await prisma.role.findUniqueOrThrow({ where: { code: 'manager' } });

    const dept = await runTx(admin, (t) =>
      organization.createDepartment(t, { code: 'REG-DEPT', name: '회귀시험팀', validFrom: '2020-01-01' }),
    );
    const managerEmployee = await runTx(admin, (t) =>
      employee.create(t, {
        name: '보류승인자',
        hireDate: '2020-01-02',
        departmentId: dept.id,
        jobTitle: '팀장',
      }),
    );
    await prisma.department.update({
      where: { id: dept.id },
      data: { headEmployeeId: managerEmployee.id },
    });
    // DRAFTER_MANAGER resolution needs the drafter linked to an employee in this department
    const drafterEmployee = await runTx(admin, (t) =>
      employee.create(t, { name: '기안자', hireDate: '2022-03-02', departmentId: dept.id }),
    );

    await prisma.user.upsert({
      where: { username: 'reg-manager' },
      create: {
        username: 'reg-manager',
        displayName: '보류승인자',
        passwordHash: hash,
        employeeId: managerEmployee.id,
        roles: { create: [{ roleId: managerRole.id }] },
      },
      update: { employeeId: managerEmployee.id, isActive: true },
    });
    await prisma.user.upsert({
      where: { username: 'reg-outsider' },
      create: {
        username: 'reg-outsider',
        displayName: '제3의 결재자',
        passwordHash: hash,
        roles: { create: [{ roleId: managerRole.id }] },
      },
      update: { isActive: true },
    });
    await prisma.user.upsert({
      where: { username: 'reg-drafter' },
      create: {
        username: 'reg-drafter',
        displayName: '기안자',
        passwordHash: hash,
        employeeId: drafterEmployee.id,
        roles: { create: [{ roleId: salesRole.id }] },
      },
      update: { employeeId: drafterEmployee.id, isActive: true },
    });

    const manager = await actorFor('reg-manager');
    const outsider = await actorFor('reg-outsider'); // holds approval.use, is not the one who held it
    const drafter = await actorFor('reg-drafter');

    const doc = await runTx(drafter, (t) =>
      approval.draft(t, {
        docNo: `AP-REG-${randomUUID().slice(0, 8)}`,
        formCode: 'EXPENSE',
        title: '회귀시험 지출결의',
        content: { purpose: '테스트', amount: '500000', paymentDate: '2026-09-10', payee: '테스트업체' },
        amount: '500000',
        departmentId: dept.id,
      }),
    );
    await runTx(drafter, (t) => approval.submit(t, { documentId: doc.id, version: doc.version }));
    const submitted = await prisma.approvalDocument.findUniqueOrThrow({ where: { id: doc.id } });

    await runTx(manager, (t) =>
      approval.hold(t, { documentId: doc.id, version: submitted.version, comment: '자료 보완 요청' }),
    );
    const held = await prisma.approvalDocument.findUniqueOrThrow({ where: { id: doc.id } });
    expect(held.status).toBe('ON_HOLD');

    const error = await captureError(() =>
      runTx(outsider, (t) => approval.releaseHold(t, { documentId: doc.id, version: held.version })),
    );
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe('FORBIDDEN');
    expect((error as AppError).message).toMatch(/보류를 건 결재자만/);

    // the forbidden attempt had no effect: still on hold
    expect((await prisma.approvalDocument.findUniqueOrThrow({ where: { id: doc.id } })).status).toBe(
      'ON_HOLD',
    );

    // the approver who placed the hold can release it
    await runTx(manager, (t) => approval.releaseHold(t, { documentId: doc.id, version: held.version }));
    expect((await prisma.approvalDocument.findUniqueOrThrow({ where: { id: doc.id } })).status).toBe(
      'IN_PROGRESS',
    );
  });
});

// ── 3. UIX-08 / DEC-09: notification dedup under a concurrent collision ──
//
// Before the fix, `notify` inserted with a plain `create`. Two notifications racing to the
// same (userId, dedupKey) both passed any prior read and both attempted the insert; the
// loser hit the unique index, and a unique violation aborts the entire Postgres
// transaction — so a notification collision could roll back whatever business write it
// rode in on. `skipDuplicates` (ON CONFLICT DO NOTHING) fixes this: the loser gets a
// count of zero instead of an error.
describe('UIX-08: 알림 dedup 충돌이 트랜잭션을 무너뜨리지 않는다', () => {
  it('같은 (userId, dedupKey)로 동시에 알림을 보내도 한 행만 남고, 두 트랜잭션 모두 커밋된다', async () => {
    const dedupKey = `regress-dedup-${randomUUID()}`;

    const results = await Promise.allSettled([
      runTx(admin, async (t) => {
        await notification.notify(t, {
          userIds: [admin.userId],
          category: 'SYSTEM',
          title: '알림 A',
          dedupKey,
        });
        // proof the transaction is still usable after the dedup collision, not poisoned
        await audit.record(t, {
          action: 'test.notify-followup',
          entityType: 'Notification',
          entityId: dedupKey,
          meta: { who: 'A' },
        });
      }),
      runTx(admin, async (t) => {
        await notification.notify(t, {
          userIds: [admin.userId],
          category: 'SYSTEM',
          title: '알림 B',
          dedupKey,
        });
        await audit.record(t, {
          action: 'test.notify-followup',
          entityType: 'Notification',
          entityId: dedupKey,
          meta: { who: 'B' },
        });
      }),
    ]);

    // If notify() still used a plain create(), the loser's unique-constraint violation
    // would abort its whole transaction and this promise would reject.
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(2);
    expect(await prisma.notification.count({ where: { userId: admin.userId, dedupKey } })).toBe(1);
    // both followup writes landed, so neither transaction was corrupted by the collision
    expect(
      await prisma.auditLog.count({ where: { action: 'test.notify-followup', entityId: dedupKey } }),
    ).toBe(2);
  });
});

// ── 4. SLS-04: sales document detail reports the source order line ──
//
// `detail()` used to omit `sourceLineId`; the link lives only in DocumentConversion, so an
// editor had no way to see which order line a document line was consuming, and re-saving
// released the reservation without re-establishing it. The order's remaining quantity
// would then silently grow back.
describe('SLS-04: 매출전표 상세는 라인별 원 주문 라인을 보고한다', () => {
  it('주문에서 전환된 라인은 sourceLineId를 보고하고, 수기 입력 라인은 null을 보고한다', async () => {
    const warehouse = await prisma.warehouse.findFirstOrThrow({ orderBy: { code: 'asc' } });
    const itemId = (await runTx(admin, (t) => item.create(t, { name: '연동시험품', unitCode: 'EA' }))).id;
    const customerId = (
      await runTx(admin, (t) => partnerModule.create(t, { name: '연동거래처', partnerType: 'CUSTOMER' }))
    ).id;

    const order = await runTx(admin, (t) =>
      salesOrder.create(t, {
        partnerId: customerId,
        docDate: '2026-06-15',
        lines: [{ itemId, quantity: '5', unitPrice: '10000', taxType: 'TAXABLE' }],
      }),
    );

    const linkedDoc = await runTx(admin, (t) =>
      salesDocument.create(t, {
        docDate: '2026-06-15',
        partnerId: customerId,
        warehouseId: warehouse.id,
        lines: [
          {
            itemId,
            quantity: '5',
            unitPrice: '10000',
            taxType: 'TAXABLE',
            sourceLineId: order.lines[0]!.id,
          },
        ],
      }),
    );

    const handDoc = await runTx(admin, (t) =>
      salesDocument.create(t, {
        docDate: '2026-06-15',
        partnerId: customerId,
        warehouseId: warehouse.id,
        lines: [{ itemId, quantity: '2', unitPrice: '10000', taxType: 'TAXABLE' }],
      }),
    );

    const linkedDetail = await runTx(admin, (t) => salesDocument.detail(t, linkedDoc.id));
    expect(linkedDetail.lines[0]!.sourceLineId).toBe(order.lines[0]!.id);

    const handDetail = await runTx(admin, (t) => salesDocument.detail(t, handDoc.id));
    expect(handDetail.lines[0]!.sourceLineId).toBeNull();
  });
});

// ── 5. HRM-09: certificate history scope ──
//
// Issuing a certificate always persisted a row; nothing could read it back, so
// `certificateHistory` is the fix that closes the loop. It also has to respect HR scope:
// a user holding only hr.self must see their own history and nobody else's.
describe('HRM-09: 증명서 발급이력 조회 범위', () => {
  it('본인 이력은 조회되고, hr.self만 가진 사용자는 타인의 이력을 조회할 수 없다', async () => {
    const hash = await hashPassword('Regress!123456');
    const hrRole = await prisma.role.findUniqueOrThrow({ where: { code: 'hr' } });
    const salesRole = await prisma.role.findUniqueOrThrow({ where: { code: 'sales' } });

    const empA = await runTx(admin, (t) => employee.create(t, { name: '본인', hireDate: '2024-01-02' }));
    const empB = await runTx(admin, (t) => employee.create(t, { name: '타인', hireDate: '2024-01-02' }));

    await prisma.user.upsert({
      where: { username: 'reg-hr' },
      create: {
        username: 'reg-hr',
        displayName: '인사담당',
        passwordHash: hash,
        roles: { create: [{ roleId: hrRole.id }] },
      },
      update: { isActive: true },
    });
    await prisma.user.upsert({
      where: { username: 'reg-self' },
      create: {
        username: 'reg-self',
        displayName: '본인조회자',
        passwordHash: hash,
        employeeId: empA.id,
        roles: { create: [{ roleId: salesRole.id }] },
      },
      update: { employeeId: empA.id, isActive: true },
    });

    const hrActor = await actorFor('reg-hr');
    const selfActor = await actorFor('reg-self');

    await runTx(hrActor, (t) =>
      employee.issueCertificate(t, {
        employeeId: empA.id,
        certType: 'EMPLOYMENT',
        issueNo: `CT-REG-${randomUUID().slice(0, 8)}`,
      }),
    );

    // no employeeId given: falls back to the caller's own employee
    const own = await runTx(selfActor, (t) => employee.certificateHistory(t, {}));
    expect(own).toHaveLength(1);
    expect(own[0]!.employeeId).toBe(empA.id);

    const error = await captureError(() =>
      runTx(selfActor, (t) => employee.certificateHistory(t, { employeeId: empB.id })),
    );
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe('OUT_OF_SCOPE');
  });
});

// ── 6. HRM-13: change request queue ──
//
// `reviewChange` existed with no way to find a request to review — the query nobody could
// reach. `pendingChangeRequests` is the fix; a submitted request must show up in the
// PENDING queue and drop out of it once reviewed.
describe('HRM-13: 본인 변경신청 대기열', () => {
  it('제출된 변경신청은 PENDING 대기열에 나타나고, 검토 후에는 사라진다', async () => {
    const hash = await hashPassword('Regress!123456');
    const hrRole = await prisma.role.findUniqueOrThrow({ where: { code: 'hr' } });
    const salesRole = await prisma.role.findUniqueOrThrow({ where: { code: 'sales' } });

    const emp = await runTx(admin, (t) =>
      employee.create(t, { name: '신청자', hireDate: '2024-01-02', phone: '010-0000-0000' }),
    );

    await prisma.user.upsert({
      where: { username: 'reg-hr' },
      create: {
        username: 'reg-hr',
        displayName: '인사담당',
        passwordHash: hash,
        roles: { create: [{ roleId: hrRole.id }] },
      },
      update: { isActive: true },
    });
    await prisma.user.upsert({
      where: { username: 'reg-self2' },
      create: {
        username: 'reg-self2',
        displayName: '신청자계정',
        passwordHash: hash,
        employeeId: emp.id,
        roles: { create: [{ roleId: salesRole.id }] },
      },
      update: { employeeId: emp.id, isActive: true },
    });

    const hrActor = await actorFor('reg-hr');
    const selfActor = await actorFor('reg-self2');

    const request = await runTx(selfActor, (t) =>
      employee.requestChange(t, { changes: { phone: { before: '010-0000-0000', after: '010-1111-2222' } } }),
    );

    const pendingBefore = await runTx(hrActor, (t) => employee.pendingChangeRequests(t));
    expect(pendingBefore.map((r) => r.id)).toContain(request.id);

    await runTx(hrActor, (t) => employee.reviewChange(t, { requestId: request.id, approve: true }));

    const pendingAfter = await runTx(hrActor, (t) => employee.pendingChangeRequests(t));
    expect(pendingAfter.map((r) => r.id)).not.toContain(request.id);
  });
});

// ── 7 & 8. NFR-SEC-03: password change and login session handling ──
describe('NFR-SEC-03: 인증·세션', () => {
  const PASSWORD = 'Regress!123456';

  beforeEach(async () => {
    await prisma.user.updateMany({
      where: { username: 'admin' },
      data: { passwordHash: await hashPassword(PASSWORD), failedLoginCount: 0, lockedUntil: null },
    });
  });

  // 7. Password change used to be three independent statements: update the password hash,
  // revoke sessions, and (separately) nothing recorded the fact in the security log. A
  // crash between them left the password changed with every stolen session still live and
  // no record that the password had moved. The fix wraps all three in one transaction. We
  // cannot inject a mid-transaction crash into changePassword without modifying it or
  // mocking (both out of bounds here), so this test asserts the fix's observable
  // consequence instead: both effects — session revocation AND the security log entry —
  // are always present together after a successful call. Dropping either one (which is
  // exactly what the pre-fix code did for the security log) fails this test.
  it('비밀번호 변경은 세션 폐기와 보안이벤트 기록을 함께 남긴다', async () => {
    const user = await prisma.user.findUniqueOrThrow({ where: { username: 'admin' } });
    const session = await login(prisma, { username: 'admin', password: PASSWORD });
    expect(await resolveSession(prisma, session.token)).not.toBeNull();

    await changePassword(prisma, {
      userId: user.id,
      currentPassword: PASSWORD,
      newPassword: 'Rotated!998877',
    });

    expect(await resolveSession(prisma, session.token)).toBeNull();

    const revokedEvent = await prisma.securityEvent.findFirst({
      where: { type: 'SESSION_REVOKED', userId: user.id },
    });
    expect(revokedEvent).toBeTruthy();
    expect((revokedEvent!.meta as { count: number }).count).toBeGreaterThanOrEqual(1);

    const resetEvent = await prisma.securityEvent.findFirst({
      where: { type: 'PASSWORD_RESET', userId: user.id, actorId: user.id },
    });
    expect(resetEvent).toBeTruthy();
    expect((resetEvent!.meta as { self: boolean }).self).toBe(true);

    await prisma.user.update({
      where: { id: user.id },
      data: { passwordHash: await hashPassword(PASSWORD) },
    });
  });

  // 8. Login rotation used to revoke sessions matching `expiresAt: { lt: now } }`, which
  // only matches sessions that had already expired (and which `resolveSession` rejects
  // anyway) — so rotation revoked nothing live. A user who logged in again because they
  // suspected a compromise did not evict whoever was holding their old, still-valid
  // cookie. The fix revokes every live (`revokedAt: null`) session regardless of its
  // expiry.
  it('로그인하면 만료 전인 이전 세션도 즉시 폐기된다', async () => {
    const first = await login(prisma, { username: 'admin', password: PASSWORD });
    expect(await resolveSession(prisma, first.token)).not.toBeNull();

    const second = await login(prisma, { username: 'admin', password: PASSWORD });

    // `first` was still well within its absolute/idle TTL when `second` logged in — the
    // pre-fix predicate would have left it live.
    expect(await resolveSession(prisma, first.token)).toBeNull();
    expect(await resolveSession(prisma, second.token)).not.toBeNull();
  });
});

// ── 9. INT-10 / APV-11 / NFR-SEC-08: daily scheduled-job enqueueing ──
//
// `registerScheduledJobs` gave every `job.*` topic a handler, which fixed events being
// silently discarded (see test group 1 above). It did not fix a second, quieter half of the
// same problem: nothing ever emitted `job.long_pending_approval` or `job.retention`, so those
// two handlers sat wired up but unreachable. `enqueueDueJobs` (src/server/jobs/scheduler.ts)
// is the fix: it enqueues one OutboxEvent per topic per KST business day, gated on "the job's
// KST hour has passed", and deduplicated on OutboxEvent's (topic, dedupKey) unique index so
// several worker replicas ticking at once still produce one run.
describe('스케줄 작업 발생 (src/server/jobs/scheduler.ts)', () => {
  /** Builds the UTC instant whose Asia/Seoul wall-clock time is the given KST hour/minute —
   *  never the real wall clock, so the test does not pass or fail by time of day. */
  function kst(y: number, m: number, d: number, hour: number, minute = 0): Date {
    return new Date(Date.UTC(y, m - 1, d, hour - 9, minute));
  }

  // DAILY_JOBS today: job.retention at KST 02:00, job.long_pending_approval at KST 09:00.
  const RETENTION_TOPIC = 'job.retention';
  const LONG_PENDING_TOPIC = 'job.long_pending_approval';

  it('KST 시각이 지난 작업만 발생하고, 아직 지나지 않은 작업은 발생하지 않는다', async () => {
    // 05:00 KST: retention's 02:00 has passed, long_pending_approval's 09:00 has not.
    const now = kst(2026, 8, 31, 5);
    const day = businessDate(now);

    const enqueued = await enqueueDueJobs(now);
    expect(enqueued).toBe(1);

    expect(await prisma.outboxEvent.count({ where: { topic: RETENTION_TOPIC, dedupKey: day } })).toBe(1);
    expect(await prisma.outboxEvent.count({ where: { topic: LONG_PENDING_TOPIC, dedupKey: day } })).toBe(0);
  });

  it('같은 날 두 번 호출해도 하루에 한 번만 발생한다', async () => {
    const now = kst(2026, 8, 31, 10); // past both jobs' hours
    const day = businessDate(now);

    expect(await enqueueDueJobs(now)).toBe(2);
    // Second call the same day: both topics already have a row for `day`, so nothing new.
    expect(await enqueueDueJobs(now)).toBe(0);

    expect(await prisma.outboxEvent.count({ where: { topic: RETENTION_TOPIC, dedupKey: day } })).toBe(1);
    expect(await prisma.outboxEvent.count({ where: { topic: LONG_PENDING_TOPIC, dedupKey: day } })).toBe(1);
  });

  it('여러 워커가 동시에 호출해도 하루에 한 행만 남는다', async () => {
    const now = kst(2026, 8, 31, 10);
    const day = businessDate(now);

    // Before the (topic, dedupKey) unique index + ON CONFLICT DO NOTHING, replicas racing
    // this read-then-insert would each pass the "not enqueued yet" read and each insert,
    // producing duplicate runs for the same day.
    const results = await Promise.allSettled([
      enqueueDueJobs(now),
      enqueueDueJobs(now),
      enqueueDueJobs(now),
      enqueueDueJobs(now),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(4);

    expect(await prisma.outboxEvent.count({ where: { topic: RETENTION_TOPIC, dedupKey: day } })).toBe(1);
    expect(await prisma.outboxEvent.count({ where: { topic: LONG_PENDING_TOPIC, dedupKey: day } })).toBe(1);
  });

  it('하루의 첫 호출이 늦게(23시) 일어나도 그날의 이른 시각 작업을 건너뛰지 않는다', async () => {
    // Simulates a worker that only starts ticking at 23:00 KST: this is the FIRST call of
    // the day, made long after both jobs' hours have passed. The condition is "hour has
    // passed and today has not run" rather than "it is currently that hour", so both the
    // 02:00 and 09:00 jobs still get enqueued for today instead of being skipped to
    // tomorrow.
    const now = kst(2026, 8, 31, 23);
    const day = businessDate(now);

    expect(await enqueueDueJobs(now)).toBe(2);
    expect(await prisma.outboxEvent.count({ where: { topic: RETENTION_TOPIC, dedupKey: day } })).toBe(1);
    expect(await prisma.outboxEvent.count({ where: { topic: LONG_PENDING_TOPIC, dedupKey: day } })).toBe(1);
  });
});
