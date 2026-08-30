// covers: APV-01..APV-15, INT-05, INT-06, B-07, B-08, E2E-03
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { actorFor, baseCtx, prepareDatabase, prisma, runTx, truncateBusinessData } from '../helpers/db';
import { withTransaction } from '@/server/core/context';
import * as approval from '@/server/modules/approval/service';
import * as form from '@/server/modules/approval/form';
import * as employee from '@/server/modules/hrm/employee';
import * as leave from '@/server/modules/hrm/leave';
import * as attendance from '@/server/modules/hrm/attendance';
import { registerHandler, __resetHandlers } from '@/server/modules/approval/handlers';
import { registerHrmHandlers } from '@/server/modules/approval/handlers/hrm';
import { AppError } from '@/server/core/errors';
import { hashPassword } from '@/server/core/crypto';
import type { Actor } from '@/server/core/context';

let admin: Actor;
let drafter: Actor;
let manager: Actor;
let deputy: Actor;
let ceo: Actor;

let deptId = '';
let managerEmployeeId = '';
let drafterEmployeeId = '';

beforeAll(async () => {
  prepareDatabase();
  admin = await actorFor('admin');

  const hash = await hashPassword('Approve!123456');
  const salesRole = await prisma.role.findUniqueOrThrow({ where: { code: 'sales' } });
  const managerRole = await prisma.role.findUniqueOrThrow({ where: { code: 'manager' } });
  for (const [username, roleId, displayName] of [
    ['drafter1', salesRole.id, '기안자'],
    ['manager1', managerRole.id, '부서장'],
    ['deputy1', managerRole.id, '대결자'],
    ['ceo1', managerRole.id, '대표이사'],
  ] as const) {
    await prisma.user.upsert({
      where: { username },
      create: { username, displayName, passwordHash: hash, roles: { create: [{ roleId }] } },
      update: { isActive: true },
    });
  }
});

beforeEach(async () => {
  await truncateBusinessData();
  await prisma.$executeRawUnsafe(`DELETE FROM "Delegation"`);
  await prisma.$executeRawUnsafe(`DELETE FROM "ApprovalDocument"`);

  __resetHandlers();
  registerHrmHandlers();

  // department with a head, so DRAFTER_MANAGER resolves
  const dept = await runTx(admin, (t) =>
    import('@/server/modules/hrm/organization').then((m) =>
      m.createDepartment(t, { code: 'APV-DEPT', name: '결재시험팀', validFrom: '2020-01-01' }),
    ),
  );
  deptId = dept.id;

  const managerEmployee = await runTx(admin, (t) =>
    employee.create(t, { name: '부서장', hireDate: '2020-01-02', departmentId: deptId, jobTitle: '팀장' }),
  );
  managerEmployeeId = managerEmployee.id;
  await prisma.department.update({ where: { id: deptId }, data: { headEmployeeId: managerEmployeeId } });

  const drafterEmployee = await runTx(admin, (t) =>
    employee.create(t, { name: '기안자', hireDate: '2022-03-02', departmentId: deptId }),
  );
  drafterEmployeeId = drafterEmployee.id;

  const ceoEmployee = await runTx(admin, (t) =>
    employee.create(t, { name: '대표이사', hireDate: '2019-01-02', positionCode: 'CEO' }),
  );

  await prisma.user.update({ where: { username: 'manager1' }, data: { employeeId: managerEmployeeId } });
  await prisma.user.update({ where: { username: 'drafter1' }, data: { employeeId: drafterEmployeeId } });
  await prisma.user.update({ where: { username: 'ceo1' }, data: { employeeId: ceoEmployee.id } });

  drafter = await actorFor('drafter1');
  manager = await actorFor('manager1');
  deputy = await actorFor('deputy1');
  ceo = await actorFor('ceo1');
});

afterAll(() => prisma.$disconnect());

async function draftExpense(amount = '1000000', actor: Actor = drafter) {
  return runTx(actor, (t) =>
    approval.draft(t, {
      docNo: `AP-${randomUUID().slice(0, 8)}`,
      formCode: 'EXPENSE',
      title: '사무용품 구매',
      content: { purpose: '사무용품', amount, paymentDate: '2026-09-10', payee: '오피스넥스' },
      amount,
      departmentId: deptId,
    }),
  );
}

describe('APV-01/APV-02: forms and versions', () => {
  it('seeds the six default forms with a published version', async () => {
    const forms = await runTx(admin, (t) => form.listForms(t));
    const codes = forms.map((f) => f.code);
    expect(codes).toEqual(
      expect.arrayContaining([
        'EXPENSE',
        'PURCHASE_REQUEST',
        'PROPOSAL',
        'CONTRACT_REVIEW',
        'LEAVE',
        'ATTENDANCE_CORRECTION',
      ]),
    );
    expect(forms.every((f) => f.currentVersion === 1)).toBe(true);
  });

  it('validates the draft against the form schema', async () => {
    await expect(
      runTx(drafter, (t) =>
        approval.draft(t, {
          docNo: 'AP-INVALID',
          formCode: 'EXPENSE',
          title: '검증 시험',
          content: { purpose: '사무용품' }, // amount/paymentDate/payee missing
        }),
      ),
    ).rejects.toThrow(/입력하세요/);
  });

  it('APV-01: a document keeps the schema snapshot it was drafted against', async () => {
    const doc = await draftExpense();
    await runTx(admin, (t) =>
      form.publishFormVersion(t, {
        formCode: 'EXPENSE',
        fieldSchema: [{ key: 'purpose', label: '지출목적', type: 'text', required: true }],
        effectiveFrom: '2020-01-01',
      }),
    );

    const stored = await prisma.approvalDocument.findUniqueOrThrow({ where: { id: doc.id } });
    const snapshot = stored.formSnapshot as unknown as { version: number; fieldSchema: { key: string }[] };
    expect(snapshot.version).toBe(1);
    expect(snapshot.fieldSchema.map((f) => f.key)).toContain('payee');
  });
});

describe('APV-03/APV-05: line resolution and amount branching', () => {
  it('below the threshold only the department head is on the line', async () => {
    const doc = await draftExpense('1000000');
    await runTx(drafter, (t) => approval.submit(t, { documentId: doc.id, version: doc.version }));

    const steps = await prisma.approvalStep.findMany({
      where: { documentId: doc.id },
      orderBy: { stepNo: 'asc' },
    });
    expect(steps).toHaveLength(1);
    expect(steps[0]!.approverId).toBe(manager.userId);
  });

  it('APV-05: at or above the threshold the CEO step is added', async () => {
    const doc = await draftExpense('5000000');
    await runTx(drafter, (t) => approval.submit(t, { documentId: doc.id, version: doc.version }));

    const steps = await prisma.approvalStep.findMany({
      where: { documentId: doc.id },
      orderBy: { stepNo: 'asc' },
    });
    expect(steps).toHaveLength(2);
    expect(steps.map((s) => s.approverId)).toEqual([manager.userId, ceo.userId]);
  });

  it('refuses to submit when no approver can be resolved', async () => {
    await prisma.department.update({ where: { id: deptId }, data: { headEmployeeId: null } });
    const doc = await draftExpense('1000000');
    await expect(
      runTx(drafter, (t) => approval.submit(t, { documentId: doc.id, version: doc.version })),
    ).rejects.toThrow(/승인 단계가 없는 결재선/);
  });
});

describe('APV-04: 전결 and 대결', () => {
  it('전결: a finalising step completes the document and skips later steps', async () => {
    const doc = await draftExpense('5000000');
    await runTx(drafter, (t) => approval.submit(t, { documentId: doc.id, version: doc.version }));
    const submitted = await prisma.approvalDocument.findUniqueOrThrow({ where: { id: doc.id } });

    await runTx(manager, (t) =>
      approval.approve(t, { documentId: doc.id, version: submitted.version, comment: '전결 처리' }),
    );

    const after = await prisma.approvalDocument.findUniqueOrThrow({ where: { id: doc.id } });
    expect(after.status).toBe('APPROVED');
    const steps = await prisma.approvalStep.findMany({
      where: { documentId: doc.id },
      orderBy: { stepNo: 'asc' },
    });
    expect(steps[0]!.status).toBe('APPROVED');
    expect(steps[1]!.status).toBe('SKIPPED');
    expect(steps[1]!.comment).toContain('전결');
  });

  it('대결: a deputy may act during the delegation period, and the original approver is preserved', async () => {
    await runTx(manager, (t) =>
      form.setDelegation(t, {
        toUserId: deputy.userId,
        validFrom: '2020-01-01',
        validTo: '2099-12-31',
        reason: '휴가',
      }),
    );

    const doc = await draftExpense('1000000');
    await runTx(drafter, (t) => approval.submit(t, { documentId: doc.id, version: doc.version }));

    const step = await prisma.approvalStep.findFirstOrThrow({ where: { documentId: doc.id } });
    expect(step.approverId).toBe(manager.userId);
    expect(step.actedByUserId).toBe(deputy.userId);

    const submitted = await prisma.approvalDocument.findUniqueOrThrow({ where: { id: doc.id } });
    await runTx(deputy, (t) => approval.approve(t, { documentId: doc.id, version: submitted.version }));
    expect((await prisma.approvalDocument.findUniqueOrThrow({ where: { id: doc.id } })).status).toBe(
      'APPROVED',
    );
  });

  it('refuses a delegation chain and a self-delegation', async () => {
    await runTx(manager, (t) =>
      form.setDelegation(t, { toUserId: deputy.userId, validFrom: '2026-01-01', validTo: '2026-12-31' }),
    );
    // deputy is already someone's deputy, so they may not delegate onward
    await expect(
      runTx(deputy, (t) =>
        form.setDelegation(t, { toUserId: ceo.userId, validFrom: '2026-06-01', validTo: '2026-07-01' }),
      ),
    ).rejects.toThrow(/다른 사람의 대결자로 지정되어 있어/);
    // and nobody may name a person who already delegates onward as their own deputy
    await expect(
      runTx(ceo, (t) =>
        form.setDelegation(t, { toUserId: manager.userId, validFrom: '2026-06-01', validTo: '2026-07-01' }),
      ),
    ).rejects.toThrow(/다른 사람에게 대결을 위임/);
    await expect(
      runTx(manager, (t) =>
        form.setDelegation(t, { toUserId: manager.userId, validFrom: '2027-01-01', validTo: '2027-02-01' }),
      ),
    ).rejects.toThrow(/본인을 대결자로/);
  });
});

describe('APV-07: processing', () => {
  it('only the current approver may act', async () => {
    const doc = await draftExpense('5000000');
    await runTx(drafter, (t) => approval.submit(t, { documentId: doc.id, version: doc.version }));
    const submitted = await prisma.approvalDocument.findUniqueOrThrow({ where: { id: doc.id } });

    // the CEO is step 2 and cannot act while step 1 is pending
    await expect(
      runTx(ceo, (t) => approval.approve(t, { documentId: doc.id, version: submitted.version })),
    ).rejects.toThrow(/결재 차례가 아니/);
  });

  it('rejection ends the document and notifies the drafter', async () => {
    const doc = await draftExpense('1000000');
    await runTx(drafter, (t) => approval.submit(t, { documentId: doc.id, version: doc.version }));
    const submitted = await prisma.approvalDocument.findUniqueOrThrow({ where: { id: doc.id } });

    await runTx(manager, (t) =>
      approval.reject(t, { documentId: doc.id, version: submitted.version, comment: '증빙 누락' }),
    );

    const after = await prisma.approvalDocument.findUniqueOrThrow({ where: { id: doc.id } });
    expect(after.status).toBe('REJECTED');
    expect(
      await prisma.notification.count({ where: { userId: drafter.userId, category: 'APPROVAL' } }),
    ).toBeGreaterThan(0);
  });

  it('rejected documents can be edited and resubmitted', async () => {
    const doc = await draftExpense('1000000');
    await runTx(drafter, (t) => approval.submit(t, { documentId: doc.id, version: doc.version }));
    let current = await prisma.approvalDocument.findUniqueOrThrow({ where: { id: doc.id } });
    await runTx(manager, (t) =>
      approval.reject(t, { documentId: doc.id, version: current.version, comment: '금액 확인' }),
    );

    current = await prisma.approvalDocument.findUniqueOrThrow({ where: { id: doc.id } });
    await runTx(drafter, (t) =>
      approval.resubmit(t, { documentId: doc.id, version: current.version, title: '사무용품 구매 (수정)' }),
    );
    current = await prisma.approvalDocument.findUniqueOrThrow({ where: { id: doc.id } });
    expect(current.status).toBe('DRAFT');
    expect(current.title).toContain('수정');

    await runTx(drafter, (t) => approval.submit(t, { documentId: doc.id, version: current.version }));
    expect((await prisma.approvalDocument.findUniqueOrThrow({ where: { id: doc.id } })).status).toBe(
      'IN_PROGRESS',
    );
  });

  it('withdrawal is allowed before any approval and refused afterwards', async () => {
    const doc = await draftExpense('5000000');
    await runTx(drafter, (t) => approval.submit(t, { documentId: doc.id, version: doc.version }));
    let current = await prisma.approvalDocument.findUniqueOrThrow({ where: { id: doc.id } });

    await runTx(drafter, (t) =>
      approval.withdraw(t, { documentId: doc.id, version: current.version, reason: '재검토' }),
    );
    expect((await prisma.approvalDocument.findUniqueOrThrow({ where: { id: doc.id } })).status).toBe(
      'WITHDRAWN',
    );

    // resubmit then approve step 1, after which withdrawal is refused
    current = await prisma.approvalDocument.findUniqueOrThrow({ where: { id: doc.id } });
    await runTx(drafter, (t) => approval.resubmit(t, { documentId: doc.id, version: current.version }));
    current = await prisma.approvalDocument.findUniqueOrThrow({ where: { id: doc.id } });
    await runTx(drafter, (t) => approval.submit(t, { documentId: doc.id, version: current.version }));

    // step 1 finalises (canFinalize), so use a below-threshold document for the "partially approved" case
    const doc2 = await draftExpense('1000000');
    await runTx(drafter, (t) => approval.submit(t, { documentId: doc2.id, version: doc2.version }));
    const d2 = await prisma.approvalDocument.findUniqueOrThrow({ where: { id: doc2.id } });
    await runTx(manager, (t) => approval.approve(t, { documentId: doc2.id, version: d2.version }));
    const d2After = await prisma.approvalDocument.findUniqueOrThrow({ where: { id: doc2.id } });
    await expect(
      runTx(drafter, (t) => approval.withdraw(t, { documentId: doc2.id, version: d2After.version })),
    ).rejects.toThrow();
  });

  it('hold and release move the document in and out of ON_HOLD', async () => {
    const doc = await draftExpense('1000000');
    await runTx(drafter, (t) => approval.submit(t, { documentId: doc.id, version: doc.version }));
    let current = await prisma.approvalDocument.findUniqueOrThrow({ where: { id: doc.id } });

    await runTx(manager, (t) =>
      approval.hold(t, { documentId: doc.id, version: current.version, comment: '자료 보완 요청' }),
    );
    current = await prisma.approvalDocument.findUniqueOrThrow({ where: { id: doc.id } });
    expect(current.status).toBe('ON_HOLD');

    await runTx(manager, (t) => approval.releaseHold(t, { documentId: doc.id, version: current.version }));
    expect((await prisma.approvalDocument.findUniqueOrThrow({ where: { id: doc.id } })).status).toBe(
      'IN_PROGRESS',
    );
  });

  it('B-07: an approved document cannot be edited', async () => {
    const doc = await draftExpense('1000000');
    await runTx(drafter, (t) => approval.submit(t, { documentId: doc.id, version: doc.version }));
    const submitted = await prisma.approvalDocument.findUniqueOrThrow({ where: { id: doc.id } });
    await runTx(manager, (t) => approval.approve(t, { documentId: doc.id, version: submitted.version }));

    const approved = await prisma.approvalDocument.findUniqueOrThrow({ where: { id: doc.id } });
    await expect(
      runTx(drafter, (t) =>
        approval.resubmit(t, { documentId: doc.id, version: approved.version, title: '몰래 수정' }),
      ),
    ).rejects.toThrow(/바꿀 수 없습니다/);
  });

  it('detects a stale version (optimistic concurrency)', async () => {
    const doc = await draftExpense('1000000');
    await runTx(drafter, (t) => approval.submit(t, { documentId: doc.id, version: doc.version }));
    const submitted = await prisma.approvalDocument.findUniqueOrThrow({ where: { id: doc.id } });

    await runTx(manager, (t) => approval.approve(t, { documentId: doc.id, version: submitted.version }));
    await expect(
      runTx(manager, (t) => approval.approve(t, { documentId: doc.id, version: submitted.version })),
    ).rejects.toThrow(/변경되었습니다/);
  });

  it('INT-05: the same requestId cannot advance a step twice', async () => {
    const doc = await draftExpense('5000000');
    await runTx(drafter, (t) => approval.submit(t, { documentId: doc.id, version: doc.version }));
    const submitted = await prisma.approvalDocument.findUniqueOrThrow({ where: { id: doc.id } });

    const requestId = randomUUID();
    const run = () =>
      withTransaction(prisma, { ...baseCtx(manager), requestId }, (t) =>
        approval.approve(t, { documentId: doc.id, version: submitted.version }),
      );

    await run();
    await expect(run()).rejects.toThrow();
    const approvedSteps = await prisma.approvalStep.count({
      where: { documentId: doc.id, status: 'APPROVED' },
    });
    expect(approvedSteps).toBe(1);
  });

  it('two concurrent approvals of the same step produce one effect', async () => {
    const doc = await draftExpense('5000000');
    await runTx(drafter, (t) => approval.submit(t, { documentId: doc.id, version: doc.version }));
    const submitted = await prisma.approvalDocument.findUniqueOrThrow({ where: { id: doc.id } });

    const results = await Promise.allSettled([
      runTx(manager, (t) => approval.approve(t, { documentId: doc.id, version: submitted.version })),
      runTx(manager, (t) => approval.approve(t, { documentId: doc.id, version: submitted.version })),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await prisma.approvalStep.count({ where: { documentId: doc.id, status: 'APPROVED' } })).toBe(1);
  });
});

describe('APV-10: inboxes and badge', () => {
  it('routes documents into the right inbox for each participant', async () => {
    const doc = await draftExpense('1000000');
    await runTx(drafter, (t) => approval.submit(t, { documentId: doc.id, version: doc.version }));

    expect(
      (await runTx(drafter, (t) => approval.listInbox(t, { inbox: 'DRAFTED', skip: 0, take: 20 }))).total,
    ).toBe(1);
    expect(
      (await runTx(manager, (t) => approval.listInbox(t, { inbox: 'PENDING', skip: 0, take: 20 }))).total,
    ).toBe(1);
    expect(await runTx(manager, (t) => approval.pendingCount(t))).toBe(1);
    expect(
      (await runTx(ceo, (t) => approval.listInbox(t, { inbox: 'PENDING', skip: 0, take: 20 }))).total,
    ).toBe(0);

    const submitted = await prisma.approvalDocument.findUniqueOrThrow({ where: { id: doc.id } });
    await runTx(manager, (t) => approval.approve(t, { documentId: doc.id, version: submitted.version }));

    expect(await runTx(manager, (t) => approval.pendingCount(t))).toBe(0);
    expect(
      (await runTx(drafter, (t) => approval.listInbox(t, { inbox: 'COMPLETED', skip: 0, take: 20 }))).total,
    ).toBe(1);
  });

  it("a stranger cannot open someone else's document", async () => {
    const doc = await draftExpense('1000000');
    await runTx(drafter, (t) => approval.submit(t, { documentId: doc.id, version: doc.version }));
    await expect(runTx(deputy, (t) => approval.detail(t, doc.id))).rejects.toThrow(/권한이 없습니다/);
  });
});

describe('APV-08/APV-09 + E2E-03: HR targets', () => {
  async function leaveRequestWithGrant() {
    await runTx(admin, (t) =>
      leave.grantManual(t, {
        employeeId: drafterEmployeeId,
        days: '15.0',
        grantDate: '2026-03-01',
        expiresAt: '2027-02-28',
        reason: '시험용',
      }),
    );
    return runTx(drafter, (t) =>
      leave.requestLeave(t, {
        docNo: `LV-${randomUUID().slice(0, 8)}`,
        startDate: '2026-09-10',
        endDate: '2026-09-11',
        reason: '개인사유',
      }),
    );
  }

  it('E2E-03: 휴가신청 → 결재 → 연차사용원장 → 근태반영', async () => {
    const request = await leaveRequestWithGrant();

    const doc = await runTx(drafter, (t) =>
      approval.draft(t, {
        docNo: `AP-${randomUUID().slice(0, 8)}`,
        formCode: 'LEAVE',
        title: '연차 신청',
        content: { leaveType: 'ANNUAL', startDate: '2026-09-10', endDate: '2026-09-11' },
        departmentId: deptId,
        target: { targetType: 'LEAVE_REQUEST', targetId: request.id, targetVersion: request.version },
      }),
    );

    await runTx(drafter, (t) => approval.submit(t, { documentId: doc.id, version: doc.version }));
    expect((await prisma.leaveRequest.findUniqueOrThrow({ where: { id: request.id } })).status).toBe(
      'PENDING_APPROVAL',
    );
    // nothing hits the ledger before approval
    expect(await prisma.leaveUsage.count()).toBe(0);

    const submitted = await prisma.approvalDocument.findUniqueOrThrow({ where: { id: doc.id } });
    await runTx(manager, (t) => approval.approve(t, { documentId: doc.id, version: submitted.version }));

    const afterRequest = await prisma.leaveRequest.findUniqueOrThrow({ where: { id: request.id } });
    expect(afterRequest.status).toBe('APPROVED');
    expect(afterRequest.approvalDocId).toBe(doc.id);

    const usages = await prisma.leaveUsage.findMany({ where: { employeeId: drafterEmployeeId } });
    expect(usages).toHaveLength(1);
    expect(usages[0]!.days.toString()).toBe('2');

    const attendanceRows = await prisma.attendance.findMany({ where: { employeeId: drafterEmployeeId } });
    expect(attendanceRows).toHaveLength(2);
    expect(attendanceRows.every((a) => a.status === 'LEAVE')).toBe(true);

    const balance = await runTx(admin, (t) => leave.balanceOf(t, drafterEmployeeId, '2026-09-12'));
    expect(balance.remaining).toBe('13.0');
  });

  it('rejection returns the leave request to REJECTED and writes nothing to the ledger', async () => {
    const request = await leaveRequestWithGrant();
    const doc = await runTx(drafter, (t) =>
      approval.draft(t, {
        docNo: `AP-${randomUUID().slice(0, 8)}`,
        formCode: 'LEAVE',
        title: '연차 신청',
        content: { leaveType: 'ANNUAL', startDate: '2026-09-10', endDate: '2026-09-11' },
        departmentId: deptId,
        target: { targetType: 'LEAVE_REQUEST', targetId: request.id, targetVersion: request.version },
      }),
    );
    await runTx(drafter, (t) => approval.submit(t, { documentId: doc.id, version: doc.version }));
    const submitted = await prisma.approvalDocument.findUniqueOrThrow({ where: { id: doc.id } });
    await runTx(manager, (t) =>
      approval.reject(t, { documentId: doc.id, version: submitted.version, comment: '업무일정' }),
    );

    expect((await prisma.leaveRequest.findUniqueOrThrow({ where: { id: request.id } })).status).toBe(
      'REJECTED',
    );
    expect(await prisma.leaveUsage.count()).toBe(0);
    expect(await prisma.attendance.count()).toBe(0);
  });

  it('APV-09: an approved 근태정정 is applied to the attendance row', async () => {
    const correction = await runTx(drafter, (t) =>
      attendance.requestCorrection(t, {
        docNo: `AC-${randomUUID().slice(0, 8)}`,
        employeeId: drafterEmployeeId,
        workDate: '2026-08-31',
        requestedCheckIn: '09:00',
        requestedCheckOut: '18:00',
        reason: '출근 태그 누락으로 정정 요청',
      }),
    );

    const doc = await runTx(drafter, (t) =>
      approval.draft(t, {
        docNo: `AP-${randomUUID().slice(0, 8)}`,
        formCode: 'ATTENDANCE_CORRECTION',
        title: '근태 정정',
        content: {
          workDate: '2026-08-31',
          requestedCheckIn: '09:00',
          requestedCheckOut: '18:00',
          reason: '출근 태그 누락',
        },
        departmentId: deptId,
        target: {
          targetType: 'ATTENDANCE_CORRECTION',
          targetId: correction.id,
          targetVersion: correction.version,
        },
      }),
    );
    await runTx(drafter, (t) => approval.submit(t, { documentId: doc.id, version: doc.version }));
    expect(await prisma.attendance.count()).toBe(0);

    const submitted = await prisma.approvalDocument.findUniqueOrThrow({ where: { id: doc.id } });
    await runTx(manager, (t) => approval.approve(t, { documentId: doc.id, version: submitted.version }));

    const row = await prisma.attendance.findFirstOrThrow({ where: { employeeId: drafterEmployeeId } });
    expect(row.source).toBe('CORRECTION');
    expect(row.workMinutes).toBe(540);
  });

  it('INT-11: the same leave request cannot be submitted twice at the same version', async () => {
    const request = await leaveRequestWithGrant();
    const target = { targetType: 'LEAVE_REQUEST', targetId: request.id, targetVersion: request.version };
    await runTx(drafter, (t) =>
      approval.draft(t, {
        docNo: `AP-${randomUUID().slice(0, 8)}`,
        formCode: 'LEAVE',
        title: '연차 신청',
        content: { leaveType: 'ANNUAL', startDate: '2026-09-10', endDate: '2026-09-11' },
        target,
      }),
    );
    await expect(
      runTx(drafter, (t) =>
        approval.draft(t, {
          docNo: `AP-${randomUUID().slice(0, 8)}`,
          formCode: 'LEAVE',
          title: '연차 신청 (중복)',
          content: { leaveType: 'ANNUAL', startDate: '2026-09-10', endDate: '2026-09-11' },
          target,
        }),
      ),
    ).rejects.toThrow(/이미 결재가 상신/);
  });

  it('B-08 / INT-06: a failure inside onApproved rolls the whole approval back', async () => {
    const request = await leaveRequestWithGrant();
    const doc = await runTx(drafter, (t) =>
      approval.draft(t, {
        docNo: `AP-${randomUUID().slice(0, 8)}`,
        formCode: 'LEAVE',
        title: '연차 신청',
        content: { leaveType: 'ANNUAL', startDate: '2026-09-10', endDate: '2026-09-11' },
        departmentId: deptId,
        target: { targetType: 'LEAVE_REQUEST', targetId: request.id, targetVersion: request.version },
      }),
    );
    await runTx(drafter, (t) => approval.submit(t, { documentId: doc.id, version: doc.version }));
    const submitted = await prisma.approvalDocument.findUniqueOrThrow({ where: { id: doc.id } });

    // fault injection: the handler writes the ledger, then fails
    registerHandler({
      targetType: 'LEAVE_REQUEST',
      label: '휴가신청(장애주입)',
      async validateBeforeSubmit() {},
      async currentVersion() {
        return 1;
      },
      async onApproved(ctx, target) {
        await leave.applyApprovedLeave(ctx, target.targetId);
        throw new AppError('INTERNAL', '회계 연동 실패');
      },
      async onRejected() {},
      async onCanceled() {},
    });

    await expect(
      runTx(manager, (t) => approval.approve(t, { documentId: doc.id, version: submitted.version })),
    ).rejects.toThrow('회계 연동 실패');

    // everything rolled back together: document, step, ledger, attendance, notifications
    const after = await prisma.approvalDocument.findUniqueOrThrow({ where: { id: doc.id } });
    expect(after.status).toBe('IN_PROGRESS');
    expect(await prisma.approvalStep.count({ where: { documentId: doc.id, status: 'APPROVED' } })).toBe(0);
    expect(await prisma.leaveUsage.count()).toBe(0);
    expect(await prisma.attendance.count()).toBe(0);
    expect(await prisma.notification.count({ where: { title: { contains: '결재 완료' } } })).toBe(0);
  });

  it('APV-12: an approved leave is cancelled through a cancellation document', async () => {
    const request = await leaveRequestWithGrant();
    const doc = await runTx(drafter, (t) =>
      approval.draft(t, {
        docNo: `AP-${randomUUID().slice(0, 8)}`,
        formCode: 'LEAVE',
        title: '연차 신청',
        content: { leaveType: 'ANNUAL', startDate: '2026-09-10', endDate: '2026-09-11' },
        departmentId: deptId,
        target: { targetType: 'LEAVE_REQUEST', targetId: request.id, targetVersion: request.version },
      }),
    );
    await runTx(drafter, (t) => approval.submit(t, { documentId: doc.id, version: doc.version }));
    const submitted = await prisma.approvalDocument.findUniqueOrThrow({ where: { id: doc.id } });
    await runTx(manager, (t) => approval.approve(t, { documentId: doc.id, version: submitted.version }));
    expect(await prisma.leaveUsage.count()).toBe(1);

    const cancelDoc = await runTx(drafter, (t) =>
      approval.requestCancel(t, {
        docNo: `AP-${randomUUID().slice(0, 8)}`,
        documentId: doc.id,
        reason: '일정 변경',
      }),
    );
    await runTx(drafter, (t) => approval.submit(t, { documentId: cancelDoc.id, version: cancelDoc.version }));
    const cancelSubmitted = await prisma.approvalDocument.findUniqueOrThrow({ where: { id: cancelDoc.id } });
    await runTx(manager, (t) =>
      approval.approve(t, { documentId: cancelDoc.id, version: cancelSubmitted.version }),
    );

    // the usage ledger gains a reversal row; the original stays
    const usages = await prisma.leaveUsage.findMany({ orderBy: { createdAt: 'asc' } });
    expect(usages).toHaveLength(2);
    expect(usages[1]!.days.toString()).toBe('-2');
    expect((await prisma.leaveRequest.findUniqueOrThrow({ where: { id: request.id } })).status).toBe(
      'CANCELED',
    );
    // the original approval document is marked cancelled by the same approval
    expect((await prisma.approvalDocument.findUniqueOrThrow({ where: { id: doc.id } })).status).toBe(
      'CANCELED',
    );
  });

  it('refuses to submit a target whose version moved on', async () => {
    const request = await leaveRequestWithGrant();
    const doc = await runTx(drafter, (t) =>
      approval.draft(t, {
        docNo: `AP-${randomUUID().slice(0, 8)}`,
        formCode: 'LEAVE',
        title: '연차 신청',
        content: { leaveType: 'ANNUAL', startDate: '2026-09-10', endDate: '2026-09-11' },
        departmentId: deptId,
        target: { targetType: 'LEAVE_REQUEST', targetId: request.id, targetVersion: request.version },
      }),
    );
    await prisma.$executeRawUnsafe(
      `UPDATE "LeaveRequest" SET version = version + 1 WHERE id = '${request.id}'`,
    );
    await expect(
      runTx(drafter, (t) => approval.submit(t, { documentId: doc.id, version: doc.version })),
    ).rejects.toThrow(/변경되었습니다/);
  });

  it('an unregistered target type fails loudly at submit time', async () => {
    __resetHandlers();
    const request = await leaveRequestWithGrant();
    const doc = await runTx(drafter, (t) =>
      approval.draft(t, {
        docNo: `AP-${randomUUID().slice(0, 8)}`,
        formCode: 'LEAVE',
        title: '연차 신청',
        content: { leaveType: 'ANNUAL', startDate: '2026-09-10', endDate: '2026-09-11' },
        target: { targetType: 'LEAVE_REQUEST', targetId: request.id, targetVersion: request.version },
      }),
    );
    await expect(
      runTx(drafter, (t) => approval.submit(t, { documentId: doc.id, version: doc.version })),
    ).rejects.toThrow(/연동 처리기가 등록되지 않은/);
  });
});

describe('APV-11: notifications', () => {
  it('notifies the next approver on submit and the drafter on completion', async () => {
    await prisma.user.update({ where: { id: manager.userId }, data: { email: 'manager@octoworks.test' } });
    const doc = await draftExpense('1000000');
    await runTx(drafter, (t) => approval.submit(t, { documentId: doc.id, version: doc.version }));

    const requestNotice = await prisma.notification.findFirst({ where: { userId: manager.userId } });
    expect(requestNotice?.title).toContain('결재 요청');
    // INT-10: email delivery goes through the outbox, never a direct send
    expect(await prisma.outboxEvent.count({ where: { topic: 'email.send' } })).toBeGreaterThan(0);

    const submitted = await prisma.approvalDocument.findUniqueOrThrow({ where: { id: doc.id } });
    await runTx(manager, (t) => approval.approve(t, { documentId: doc.id, version: submitted.version }));
    const doneNotice = await prisma.notification.findFirst({
      where: { userId: drafter.userId, title: { contains: '결재 완료' } },
    });
    expect(doneNotice).toBeTruthy();
  });

  it('APV-11: long-pending documents are detectable', async () => {
    const doc = await draftExpense('1000000');
    await runTx(drafter, (t) => approval.submit(t, { documentId: doc.id, version: doc.version }));
    await prisma.$executeRawUnsafe(
      `UPDATE "ApprovalDocument" SET "submittedAt" = NOW() - INTERVAL '10 days' WHERE id = '${doc.id}'`,
    );
    const overdue = await runTx(admin, (t) => approval.longPending(t, 3));
    expect(overdue.map((d) => d.id)).toContain(doc.id);
  });
});
