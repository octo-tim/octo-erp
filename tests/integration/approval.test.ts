// covers: APV-01..APV-15, INT-05, INT-06, B-07, B-08, E2E-03
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { actorFor, baseCtx, prepareDatabase, prisma, runTx, truncateBusinessData } from '../helpers/db';
import { withTransaction } from '@/server/core/context';
import * as approval from '@/server/modules/approval/service';
import * as form from '@/server/modules/approval/form';
import * as employee from '@/server/modules/hrm/employee';
import * as organization from '@/server/modules/hrm/organization';
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

describe('APV-03: 상신 시 결재선 변경 (ApprovalLineTemplate.editable)', () => {
  it('editable 서식은 기안자가 결재선을 바꿔 상신할 수 있다', async () => {
    // STANDARD (seeded) is editable: true
    const doc = await draftExpense('1000000');
    await runTx(drafter, (t) =>
      approval.submit(t, {
        documentId: doc.id,
        version: doc.version,
        lineOverride: [{ approverId: deputy.userId, role: 'APPROVE' }],
      }),
    );

    const steps = await prisma.approvalStep.findMany({
      where: { documentId: doc.id },
      orderBy: { stepNo: 'asc' },
    });
    // the drafter's override is honoured — not the department head this template would
    // otherwise resolve to
    expect(steps).toHaveLength(1);
    expect(steps[0]!.approverId).toBe(deputy.userId);
  });

  it('editable=false 서식은 서버가 결재선 변경을 거부한다 (컨트롤을 숨기는 것만으로는 강제되지 않음)', async () => {
    const proposalForm = await prisma.approvalForm.findUniqueOrThrow({ where: { code: 'PROPOSAL' } });
    const locked = await prisma.approvalLineTemplate.create({
      data: {
        code: `LOCKED-${randomUUID().slice(0, 8)}`,
        name: '고정 결재선',
        editable: false,
        steps: { create: [{ stepNo: 1, role: 'APPROVE', resolveBy: 'DRAFTER_MANAGER', canFinalize: true }] },
      },
    });
    const rule = await prisma.approvalRule.create({
      data: {
        code: `LOCKED-RULE-${randomUUID().slice(0, 8)}`,
        name: '고정 결재선 규칙',
        formId: proposalForm.id,
        lineTemplateId: locked.id,
        priority: 100,
      },
    });

    try {
      const doc = await runTx(drafter, (t) =>
        approval.draft(t, {
          docNo: `AP-${randomUUID().slice(0, 8)}`,
          formCode: 'PROPOSAL',
          title: '품의 테스트',
          content: { subject: '품의 테스트', background: '테스트 배경' },
          departmentId: deptId,
        }),
      );

      // a hidden control would stop here; the server must refuse the override on its own
      await expect(
        runTx(drafter, (t) =>
          approval.submit(t, {
            documentId: doc.id,
            version: doc.version,
            lineOverride: [{ approverId: deputy.userId, role: 'APPROVE' }],
          }),
        ),
      ).rejects.toThrow(/결재선을 변경할 수 없습니다/);

      // and nothing was written by the rejected attempt — submitting for real still works
      const refreshed = await prisma.approvalDocument.findUniqueOrThrow({ where: { id: doc.id } });
      expect(refreshed.status).toBe('DRAFT');
      await runTx(drafter, (t) => approval.submit(t, { documentId: doc.id, version: refreshed.version }));
      const steps = await prisma.approvalStep.findMany({ where: { documentId: doc.id } });
      expect(steps).toHaveLength(1);
      expect(steps[0]!.approverId).toBe(manager.userId);
    } finally {
      await prisma.approvalRule.delete({ where: { id: rule.id } });
      await prisma.approvalLineTemplate.delete({ where: { id: locked.id } });
    }
  });
});

describe('APV-03: 병렬합의(AGREE)와 참조·열람(REFERENCE)', () => {
  it('AGREE: 병렬 단계는 모두 승인해야 다음 단계로 넘어가고, 뒤 단계는 그 사이에 진행될 수 없다', async () => {
    const doc = await draftExpense('1000000');
    await runTx(drafter, (t) =>
      approval.submit(t, {
        documentId: doc.id,
        version: doc.version,
        lineOverride: [
          { approverId: manager.userId, role: 'AGREE' },
          { approverId: ceo.userId, role: 'AGREE' },
          { approverId: deputy.userId, role: 'APPROVE' },
        ],
      }),
    );

    // both AGREE approvers are asked to act at once
    expect(
      await prisma.notification.count({
        where: { userId: manager.userId, title: { contains: '결재 요청' } },
      }),
    ).toBe(1);
    expect(
      await prisma.notification.count({ where: { userId: ceo.userId, title: { contains: '결재 요청' } } }),
    ).toBe(1);
    // the APPROVE step behind the AGREE block is not — it is not anyone's turn yet
    expect(await prisma.notification.count({ where: { userId: deputy.userId } })).toBe(0);

    const afterSubmit = await runTx(manager, (t) => approval.detail(t, doc.id));
    expect(afterSubmit.pendingStepNos.sort()).toEqual([1, 2]);
    expect((await runTx(ceo, (t) => approval.detail(t, doc.id))).canAct).toBe(true);
    expect((await runTx(deputy, (t) => approval.detail(t, doc.id))).canAct).toBe(false);

    let current = await prisma.approvalDocument.findUniqueOrThrow({ where: { id: doc.id } });
    // the step behind an open AGREE block can never jump the queue
    await expect(
      runTx(deputy, (t) => approval.approve(t, { documentId: doc.id, version: current.version })),
    ).rejects.toThrow(/결재 차례가 아니/);

    // one AGREE approver acting alone does not clear the block
    await runTx(manager, (t) => approval.approve(t, { documentId: doc.id, version: current.version }));
    current = await prisma.approvalDocument.findUniqueOrThrow({ where: { id: doc.id } });
    expect(current.status).toBe('IN_PROGRESS');
    expect((await runTx(ceo, (t) => approval.detail(t, doc.id))).canAct).toBe(true);
    await expect(
      runTx(deputy, (t) => approval.approve(t, { documentId: doc.id, version: current.version })),
    ).rejects.toThrow(/결재 차례가 아니/);

    // the second AGREE approver clears the block, unblocking the step behind it
    await runTx(ceo, (t) => approval.approve(t, { documentId: doc.id, version: current.version }));
    current = await prisma.approvalDocument.findUniqueOrThrow({ where: { id: doc.id } });
    expect(current.status).toBe('IN_PROGRESS');
    const afterBlock = await runTx(deputy, (t) => approval.detail(t, doc.id));
    expect(afterBlock.canAct).toBe(true);
    expect(afterBlock.pendingStepNos).toEqual([3]);

    await runTx(deputy, (t) => approval.approve(t, { documentId: doc.id, version: current.version }));
    expect((await prisma.approvalDocument.findUniqueOrThrow({ where: { id: doc.id } })).status).toBe(
      'APPROVED',
    );
  });

  it('REFERENCE: 참조 단계는 결재 진행을 막지 않고, 참조자는 열람만 하고 승인할 수 없다', async () => {
    const doc = await draftExpense('1000000');
    await runTx(drafter, (t) =>
      approval.submit(t, {
        documentId: doc.id,
        version: doc.version,
        lineOverride: [
          { approverId: manager.userId, role: 'APPROVE' },
          { approverId: ceo.userId, role: 'REFERENCE' },
        ],
      }),
    );

    // a REFERENCE step is skipped immediately, not queued as work
    const referenceStep = await prisma.approvalStep.findFirstOrThrow({
      where: { documentId: doc.id, role: 'REFERENCE' },
    });
    expect(referenceStep.status).toBe('SKIPPED');
    expect(
      await prisma.approvalParticipant.count({
        where: { documentId: doc.id, userId: ceo.userId, role: 'REFERENCE' },
      }),
    ).toBe(1);
    expect(
      (await runTx(ceo, (t) => approval.listInbox(t, { inbox: 'REFERENCE', skip: 0, take: 20 }))).total,
    ).toBe(1);
    // never on the reference viewer's action queue
    expect(
      (await runTx(ceo, (t) => approval.listInbox(t, { inbox: 'PENDING', skip: 0, take: 20 }))).total,
    ).toBe(0);
    expect((await runTx(ceo, (t) => approval.detail(t, doc.id))).canAct).toBe(false);

    const current = await prisma.approvalDocument.findUniqueOrThrow({ where: { id: doc.id } });
    // a reference viewer is never given a turn to act
    await expect(
      runTx(ceo, (t) => approval.approve(t, { documentId: doc.id, version: current.version })),
    ).rejects.toThrow(/결재 차례가 아니/);

    // the single APPROVE step alone completes the document — REFERENCE never blocks it
    await runTx(manager, (t) => approval.approve(t, { documentId: doc.id, version: current.version }));
    expect((await prisma.approvalDocument.findUniqueOrThrow({ where: { id: doc.id } })).status).toBe(
      'APPROVED',
    );
  });
});

describe('APV-13: 다조건 검색 (listInbox의 q/from/to)', () => {
  async function draftAndSubmit(actor: Actor, amount: string, title: string, departmentIdOverride?: string) {
    const doc = await runTx(actor, (t) =>
      approval.draft(t, {
        docNo: `AP-${randomUUID().slice(0, 8)}`,
        formCode: 'EXPENSE',
        title,
        content: { purpose: title, amount, paymentDate: '2026-09-10', payee: '거래처' },
        amount,
        departmentId: departmentIdOverride ?? deptId,
      }),
    );
    await runTx(actor, (t) => approval.submit(t, { documentId: doc.id, version: doc.version }));
    return doc;
  }

  it('키워드로 제목·문서번호를 검색한다', async () => {
    const target = await draftAndSubmit(drafter, '1000000', '출장비 정산');
    await draftAndSubmit(drafter, '1000000', '사무용품 구매');

    const byTitle = await runTx(drafter, (t) =>
      approval.listInbox(t, { inbox: 'DRAFTED', q: '출장비', skip: 0, take: 20 }),
    );
    expect(byTitle.total).toBe(1);
    expect(byTitle.rows.map((r) => r.id)).toEqual([target.id]);

    const byDocNo = await runTx(drafter, (t) =>
      approval.listInbox(t, { inbox: 'DRAFTED', q: target.docNo, skip: 0, take: 20 }),
    );
    expect(byDocNo.rows.map((r) => r.id)).toEqual([target.id]);

    const noMatch = await runTx(drafter, (t) =>
      approval.listInbox(t, { inbox: 'DRAFTED', q: '존재하지않는키워드', skip: 0, take: 20 }),
    );
    expect(noMatch.total).toBe(0);
  });

  it('작성일 범위로 검색하면 범위 밖 문서는 제외된다', async () => {
    const inRange = await draftAndSubmit(drafter, '1000000', '범위내 문서');
    const outOfRange = await draftAndSubmit(drafter, '1000000', '범위밖 문서');
    await prisma.$executeRawUnsafe(
      `UPDATE "ApprovalDocument" SET "createdAt" = '2026-01-15T00:00:00Z' WHERE id = '${inRange.id}'`,
    );
    await prisma.$executeRawUnsafe(
      `UPDATE "ApprovalDocument" SET "createdAt" = '2026-05-01T00:00:00Z' WHERE id = '${outOfRange.id}'`,
    );

    const result = await runTx(drafter, (t) =>
      approval.listInbox(t, { inbox: 'DRAFTED', from: '2026-01-01', to: '2026-01-31', skip: 0, take: 20 }),
    );
    expect(result.total).toBe(1);
    expect(result.rows.map((r) => r.id)).toEqual([inRange.id]);
  });

  it('키워드와 날짜 범위를 함께 사용할 수 있다', async () => {
    const a = await draftAndSubmit(drafter, '1000000', '분기 보고서');
    const b = await draftAndSubmit(drafter, '1000000', '분기 정산');
    await prisma.$executeRawUnsafe(
      `UPDATE "ApprovalDocument" SET "createdAt" = '2026-02-10T00:00:00Z' WHERE id = '${a.id}'`,
    );
    await prisma.$executeRawUnsafe(
      `UPDATE "ApprovalDocument" SET "createdAt" = '2026-06-10T00:00:00Z' WHERE id = '${b.id}'`,
    );

    // matches the keyword for both, but the date range keeps only one
    const result = await runTx(drafter, (t) =>
      approval.listInbox(t, {
        inbox: 'DRAFTED',
        q: '분기',
        from: '2026-02-01',
        to: '2026-02-28',
        skip: 0,
        take: 20,
      }),
    );
    expect(result.total).toBe(1);
    expect(result.rows.map((r) => r.id)).toEqual([a.id]);
  });

  it('검색은 호출자의 권한 범위를 벗어난 문서를 노출하지 않는다', async () => {
    // a second department whose head is the CEO, so a document drafted there routes to a
    // different approver than `manager` — the scope leak this test guards against would be
    // a keyword match returning someone else's document regardless of who is really on it
    const dept2 = await runTx(admin, (t) =>
      organization.createDepartment(t, { code: 'APV-DEPT-2', name: '결재시험팀2', validFrom: '2020-01-01' }),
    );
    const ceoEmployee = await prisma.employee.findFirstOrThrow({ where: { name: '대표이사' } });
    await prisma.department.update({ where: { id: dept2.id }, data: { headEmployeeId: ceoEmployee.id } });
    const otherDrafterEmployee = await runTx(admin, (t) =>
      employee.create(t, { name: '타부서 기안자', hireDate: '2022-01-01', departmentId: dept2.id }),
    );
    await prisma.user.upsert({
      where: { username: 'drafter2' },
      create: {
        username: 'drafter2',
        displayName: '타부서 기안자',
        passwordHash: await hashPassword('Approve!123456'),
        employeeId: otherDrafterEmployee.id,
        roles: {
          create: [{ roleId: (await prisma.role.findUniqueOrThrow({ where: { code: 'sales' } })).id }],
        },
      },
      update: { employeeId: otherDrafterEmployee.id, isActive: true },
    });
    const drafter2 = await actorFor('drafter2');

    const mine = await draftAndSubmit(drafter, '1000000', '결재대상 문서');
    const theirs = await draftAndSubmit(drafter2, '1000000', '결재대상 문서', dept2.id);

    // `theirs` is pending on ceo (dept2's head), never on manager — a keyword search must not
    // hand manager a document they have no role on just because the title matches
    const managerPending = await runTx(manager, (t) =>
      approval.listInbox(t, { inbox: 'PENDING', q: '결재대상', skip: 0, take: 20 }),
    );
    expect(managerPending.total).toBe(1);
    expect(managerPending.rows.map((r) => r.id)).toEqual([mine.id]);

    // manager's own DRAFTED search never returns a document manager didn't draft
    const managerDrafted = await runTx(manager, (t) =>
      approval.listInbox(t, { inbox: 'DRAFTED', q: '결재대상', skip: 0, take: 20 }),
    );
    expect(managerDrafted.total).toBe(0);

    // and `drafter` cannot find the other drafter's document by number either
    const drafterOnOthers = await runTx(drafter, (t) =>
      approval.listInbox(t, { inbox: 'DRAFTED', q: theirs.docNo, skip: 0, take: 20 }),
    );
    expect(drafterOnOthers.total).toBe(0);

    // ceo, who really is pending on `theirs`, does find it
    const ceoPending = await runTx(ceo, (t) =>
      approval.listInbox(t, { inbox: 'PENDING', q: '결재대상', skip: 0, take: 20 }),
    );
    expect(ceoPending.total).toBe(1);
    expect(ceoPending.rows.map((r) => r.id)).toEqual([theirs.id]);
  });
});

describe('UIX-03: server-side CSV export', () => {
  it('listInboxCsv returns every matching row, not a page, and respects a filter', async () => {
    for (let i = 0; i < 6; i++) {
      await runTx(drafter, (t) =>
        approval.draft(t, {
          docNo: `AP-${randomUUID().slice(0, 8)}`,
          formCode: 'EXPENSE',
          title: `내보내기문서 ${i}`,
          content: { purpose: '경비', amount: '10000', paymentDate: '2026-09-10', payee: '거래처' },
          amount: '10000',
          departmentId: deptId,
        }),
      );
    }
    const drafted = await runTx(drafter, (t) =>
      approval.draft(t, {
        docNo: `AP-${randomUUID().slice(0, 8)}`,
        formCode: 'EXPENSE',
        title: '검색용문서',
        content: { purpose: '경비', amount: '10000', paymentDate: '2026-09-10', payee: '거래처' },
        amount: '10000',
        departmentId: deptId,
      }),
    );

    const all = await runTx(drafter, (t) => approval.listInboxCsv(t, { inbox: 'DRAFTED' }));
    expect(all.total).toBe(7);
    expect(all.rowCount).toBe(7);
    expect(all.truncated).toBe(false);
    expect(all.csv.trim().split('\r\n')).toHaveLength(8);
    expect(all.csv).toContain('문서번호');

    const filtered = await runTx(drafter, (t) =>
      approval.listInboxCsv(t, { inbox: 'DRAFTED', q: '검색용문서' }),
    );
    expect(filtered.total).toBe(1);
    expect(filtered.csv).toContain(drafted.docNo);
  });

  it('a user does not get another approver’s pending document in their export (identity scope)', async () => {
    const dept2 = await runTx(admin, (t) =>
      organization.createDepartment(t, {
        code: 'APV-DEPT-CSV',
        name: '결재시험팀CSV',
        validFrom: '2020-01-01',
      }),
    );
    const ceoEmployee = await prisma.employee.findFirstOrThrow({ where: { name: '대표이사' } });
    await prisma.department.update({ where: { id: dept2.id }, data: { headEmployeeId: ceoEmployee.id } });
    const otherDrafterEmployee = await runTx(admin, (t) =>
      employee.create(t, { name: '내보내기 타부서 기안자', hireDate: '2022-01-01', departmentId: dept2.id }),
    );
    await prisma.user.upsert({
      where: { username: 'drafter-csv2' },
      create: {
        username: 'drafter-csv2',
        displayName: '내보내기 타부서 기안자',
        passwordHash: await hashPassword('Approve!123456'),
        employeeId: otherDrafterEmployee.id,
        roles: {
          create: [{ roleId: (await prisma.role.findUniqueOrThrow({ where: { code: 'sales' } })).id }],
        },
      },
      update: { employeeId: otherDrafterEmployee.id, isActive: true },
    });
    const drafter2 = await actorFor('drafter-csv2');

    const mine = await runTx(drafter, (t) =>
      approval.draft(t, {
        docNo: `AP-${randomUUID().slice(0, 8)}`,
        formCode: 'EXPENSE',
        title: '결재대상 내보내기 문서',
        content: { purpose: '경비', amount: '10000', paymentDate: '2026-09-10', payee: '거래처' },
        amount: '10000',
        departmentId: deptId,
      }),
    );
    await runTx(drafter, (t) => approval.submit(t, { documentId: mine.id, version: mine.version }));

    const theirs = await runTx(drafter2, (t) =>
      approval.draft(t, {
        docNo: `AP-${randomUUID().slice(0, 8)}`,
        formCode: 'EXPENSE',
        title: '결재대상 내보내기 문서',
        content: { purpose: '경비', amount: '10000', paymentDate: '2026-09-10', payee: '거래처' },
        amount: '10000',
        departmentId: dept2.id,
      }),
    );
    await runTx(drafter2, (t) => approval.submit(t, { documentId: theirs.id, version: theirs.version }));

    // `theirs` is pending on ceo (dept2's head), never on manager
    const managerExport = await runTx(manager, (t) => approval.listInboxCsv(t, { inbox: 'PENDING' }));
    expect(managerExport.total).toBe(1);
    expect(managerExport.csv).toContain(mine.docNo);
    expect(managerExport.csv).not.toContain(theirs.docNo);

    const ceoExport = await runTx(ceo, (t) => approval.listInboxCsv(t, { inbox: 'PENDING' }));
    expect(ceoExport.total).toBe(1);
    expect(ceoExport.csv).toContain(theirs.docNo);
    expect(ceoExport.csv).not.toContain(mine.docNo);
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
