// covers: HRM-01..HRM-13, NFR-SEC-02, NFR-SEC-06, B-15
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { actorFor, prepareDatabase, prisma, runTx, truncateBusinessData } from '../helpers/db';
import * as employee from '@/server/modules/hrm/employee';
import * as organization from '@/server/modules/hrm/organization';
import * as attendance from '@/server/modules/hrm/attendance';
import * as leave from '@/server/modules/hrm/leave';
import { login, resolveSession } from '@/server/modules/auth/service';
import { hashPassword } from '@/server/core/crypto';
import { AppError } from '@/server/core/errors';
import type { Actor } from '@/server/core/context';

let admin: Actor;
let hrUser: Actor;
let salesUser: Actor;

beforeAll(async () => {
  prepareDatabase();
  admin = await actorFor('admin');

  const hash = await hashPassword('Hrm!123456789');
  const hrRole = await prisma.role.findUniqueOrThrow({ where: { code: 'hr' } });
  const salesRole = await prisma.role.findUniqueOrThrow({ where: { code: 'sales' } });
  await prisma.user.upsert({
    where: { username: 'hrm1' },
    create: {
      username: 'hrm1',
      displayName: '인사담당',
      passwordHash: hash,
      roles: { create: [{ roleId: hrRole.id }] },
    },
    update: {},
  });
  await prisma.user.upsert({
    where: { username: 'sales9' },
    create: {
      username: 'sales9',
      displayName: '영업사원',
      passwordHash: hash,
      roles: { create: [{ roleId: salesRole.id }] },
    },
    update: {},
  });
});

beforeEach(() => truncateBusinessData());
afterAll(() => prisma.$disconnect());

async function seedEmployee(overrides?: Partial<Parameters<typeof employee.create>[1]>) {
  return runTx(admin, (t) =>
    employee.create(t, {
      name: '홍길동',
      hireDate: '2024-03-01',
      phone: '010-1234-5678',
      email: 'hong@octoworks.test',
      ...overrides,
    }),
  );
}

describe('HRM-01/HRM-03: employee creation', () => {
  it('assigns a sequential employee number and records the hire assignment', async () => {
    const a = await seedEmployee();
    const b = await seedEmployee({ name: '김철수' });
    expect(a.employeeNo).toMatch(/^\d{7}$/);
    expect(Number(b.employeeNo)).toBe(Number(a.employeeNo) + 1);

    const assignments = await prisma.assignment.findMany({ where: { employeeId: a.id } });
    expect(assignments).toHaveLength(1);
    expect(assignments[0]!.type).toBe('HIRE');
  });

  it('rejects an employee update with a stale version (optimistic locking)', async () => {
    const e = await seedEmployee();
    await runTx(admin, (t) => employee.update(t, e.id, { jobTitle: '대리' }, e.version));
    await expect(
      runTx(admin, (t) => employee.update(t, e.id, { jobTitle: '과장' }, e.version)),
    ).rejects.toThrow(/다른 사용자에 의해 변경/);
  });
});

describe('HRM-12 / NFR-SEC-06: sensitive data', () => {
  it('stores ciphertext only and masks by default', async () => {
    const e = await seedEmployee();
    await runTx(admin, (t) =>
      employee.setSensitive(t, {
        employeeId: e.id,
        residentNo: '900101-1234567',
        bankName: '국민',
        bankAccount: '110-123-456789',
      }),
    );

    const raw = await prisma.employeeSensitive.findUniqueOrThrow({ where: { employeeId: e.id } });
    expect(raw.residentNoEnc).not.toContain('900101');
    expect(raw.bankAccountEnc).not.toContain('456789');
    // only the gender digit survives in the clear, not four digits (NFR-SEC-06)
    expect(raw.residentNoMaskDigit).toBe('1');
    expect(JSON.stringify(raw)).not.toContain('4567');

    const detail = await runTx(admin, (t) => employee.detail(t, e.id));
    expect(detail.sensitive?.residentNoMasked).toBe('******-1******');
    expect(detail.sensitive?.bankAccountMasked).toBe('****-****-6789');
    expect(JSON.stringify(detail)).not.toContain('900101-1234567');
  });

  it('rejects a malformed resident number', async () => {
    const e = await seedEmployee();
    await expect(
      runTx(admin, (t) => employee.setSensitive(t, { employeeId: e.id, residentNo: '900101-12' })),
    ).rejects.toThrow(/13자리/);
  });

  it('the audit trail never contains the plaintext', async () => {
    const e = await seedEmployee();
    await runTx(admin, (t) => employee.setSensitive(t, { employeeId: e.id, residentNo: '900101-1234567' }));
    const dump = JSON.stringify(await prisma.auditLog.findMany());
    expect(dump).not.toContain('900101');
    expect(dump).toContain('employee.setSensitive');
  });

  it('decryption requires a reason and leaves an access log', async () => {
    const e = await seedEmployee();
    await runTx(admin, (t) => employee.setSensitive(t, { employeeId: e.id, residentNo: '900101-1234567' }));

    await expect(
      runTx(admin, (t) =>
        employee.revealSensitive(t, { employeeId: e.id, field: 'residentNo', reason: '짧음' }),
      ),
    ).rejects.toThrow(/5자 이상/);

    const value = await runTx(admin, (t) =>
      employee.revealSensitive(t, { employeeId: e.id, field: 'residentNo', reason: '4대보험 신고자료 작성' }),
    );
    expect(value).toBe('9001011234567');

    const logs = await prisma.sensitiveAccessLog.findMany({ where: { employeeId: e.id } });
    expect(logs).toHaveLength(1);
    expect(logs[0]!.reason).toBe('4대보험 신고자료 작성');
    expect(await prisma.securityEvent.count({ where: { type: 'SENSITIVE_ACCESS' } })).toBe(1);
  });

  it('NFR-SEC-02: a user without hr.sensitive.read cannot decrypt or even read others', async () => {
    const e = await seedEmployee();
    await runTx(admin, (t) => employee.setSensitive(t, { employeeId: e.id, residentNo: '900101-1234567' }));
    salesUser = await actorFor('sales9');

    await expect(
      runTx(salesUser, (t) =>
        employee.revealSensitive(t, { employeeId: e.id, field: 'residentNo', reason: '궁금해서 봅니다' }),
      ),
    ).rejects.toThrow(/권한이 없습니다/);
    await expect(runTx(salesUser, (t) => employee.detail(t, e.id))).rejects.toThrow(/본인 외/);
  });

  it('an employee sees their own record with sensitive fields still masked', async () => {
    const e = await seedEmployee();
    await runTx(admin, (t) => employee.setSensitive(t, { employeeId: e.id, residentNo: '900101-1234567' }));
    await prisma.user.update({ where: { username: 'sales9' }, data: { employeeId: e.id } });
    const self = await actorFor('sales9');

    const mine = await runTx(self, (t) => employee.me(t));
    expect(mine.name).toBe('홍길동');
    expect(mine.sensitive?.residentNoMasked).toBe('******-1******');
    await expect(
      runTx(self, (t) =>
        employee.revealSensitive(t, { employeeId: e.id, field: 'residentNo', reason: '본인 확인용입니다' }),
      ),
    ).rejects.toThrow(/권한이 없습니다/);
    await prisma.user.update({ where: { username: 'sales9' }, data: { employeeId: null } });
  });
});

describe('HRM-11 / NFR-SEC-04: resignation is atomic with account deactivation', () => {
  it('deactivates the account and kills live sessions in the same transaction', async () => {
    const e = await seedEmployee({ name: '퇴사자' });
    const hash = await hashPassword('Leaver!1234567');
    await prisma.user.upsert({
      where: { username: 'leaver1' },
      create: { username: 'leaver1', displayName: '퇴사자', passwordHash: hash, employeeId: e.id },
      update: { employeeId: e.id, isActive: true, passwordHash: hash },
    });

    const session = await login(prisma, { username: 'leaver1', password: 'Leaver!1234567' });
    expect(await resolveSession(prisma, session.token)).not.toBeNull();

    await runTx(admin, (t) =>
      employee.resign(t, { employeeId: e.id, leaveDate: '2026-08-31', reason: '개인사유' }),
    );

    const user = await prisma.user.findUniqueOrThrow({ where: { username: 'leaver1' } });
    expect(user.isActive).toBe(false);
    expect(await resolveSession(prisma, session.token)).toBeNull();
    expect((await prisma.employee.findUniqueOrThrow({ where: { id: e.id } })).status).toBe('RESIGNED');
  });

  it('rolls both back together when the transaction fails', async () => {
    const e = await seedEmployee({ name: '롤백대상' });
    const hash = await hashPassword('Rollback!12345');
    await prisma.user.upsert({
      where: { username: 'rollback1' },
      create: { username: 'rollback1', displayName: '롤백', passwordHash: hash, employeeId: e.id },
      update: { employeeId: e.id, isActive: true },
    });

    await expect(
      runTx(admin, async (t) => {
        await employee.resign(t, { employeeId: e.id, leaveDate: '2026-08-31' });
        throw new AppError('INTERNAL', '후속 단계 실패');
      }),
    ).rejects.toThrow('후속 단계 실패');

    expect((await prisma.user.findUniqueOrThrow({ where: { username: 'rollback1' } })).isActive).toBe(true);
    expect((await prisma.employee.findUniqueOrThrow({ where: { id: e.id } })).status).toBe('ACTIVE');
  });

  it('refuses a second resignation', async () => {
    const e = await seedEmployee();
    await runTx(admin, (t) => employee.resign(t, { employeeId: e.id, leaveDate: '2026-08-31' }));
    await expect(
      runTx(admin, (t) => employee.resign(t, { employeeId: e.id, leaveDate: '2026-09-01' })),
    ).rejects.toThrow(/이미 퇴사 처리/);
  });
});

describe('B-15 / HRM-02 / HRM-03: point-in-time organisation', () => {
  it('reproduces the org chart and an employee position before and after a reorganisation', async () => {
    const dept = await runTx(admin, (t) =>
      organization.createDepartment(t, { code: 'D-OLD', name: '통합사업팀', validFrom: '2026-01-01' }),
    );
    const e = await seedEmployee({ departmentId: dept.id, hireDate: '2026-01-02' });

    // before the reorg
    const before = await runTx(admin, (t) => organization.positionAt(t, e.id, '2026-05-15'));
    expect(before?.departmentName).toBe('통합사업팀');

    // 2026-06-01 reorganisation: rename and split
    await runTx(admin, (t) =>
      organization.reorganize(t, { departmentId: dept.id, effectiveDate: '2026-06-01', name: '건축자재팀' }),
    );
    const newDept = await runTx(admin, (t) =>
      organization.createDepartment(t, { code: 'D-NEW', name: '필름사업팀', validFrom: '2026-06-01' }),
    );
    await runTx(admin, (t) =>
      organization.assign(t, {
        employeeId: e.id,
        type: 'TRANSFER',
        effectiveFrom: '2026-06-01',
        departmentId: newDept.id,
      }),
    );

    const afterMove = await runTx(admin, (t) => organization.positionAt(t, e.id, '2026-07-01'));
    expect(afterMove?.departmentName).toBe('필름사업팀');

    // the historical query still returns the pre-reorg department
    const stillBefore = await runTx(admin, (t) => organization.positionAt(t, e.id, '2026-05-15'));
    expect(stillBefore?.departmentId).toBe(dept.id);

    // the org chart excludes departments not yet effective
    const chartMay = await runTx(admin, (t) => organization.chart(t, '2026-05-15'));
    expect(chartMay.flatMap((n) => [n, ...n.children]).some((n) => n.code === 'D-NEW')).toBe(false);
    const chartJuly = await runTx(admin, (t) => organization.chart(t, '2026-07-01'));
    expect(chartJuly.flatMap((n) => [n, ...n.children]).some((n) => n.code === 'D-NEW')).toBe(true);
  });

  it('refuses to close a department that still has staff', async () => {
    const dept = await runTx(admin, (t) =>
      organization.createDepartment(t, { code: 'D-BUSY', name: '인원있는팀', validFrom: '2026-01-01' }),
    );
    await seedEmployee({ departmentId: dept.id });
    await expect(
      runTx(admin, (t) =>
        organization.reorganize(t, { departmentId: dept.id, effectiveDate: '2026-09-01', close: true }),
      ),
    ).rejects.toThrow(/소속 인원/);
  });

  it('refuses an assignment dated before the hire date', async () => {
    const e = await seedEmployee({ hireDate: '2026-01-02' });
    await expect(
      runTx(admin, (t) =>
        organization.assign(t, { employeeId: e.id, type: 'PROMOTION', effectiveFrom: '2025-12-31' }),
      ),
    ).rejects.toThrow(/입사일보다 빠를 수 없습니다/);
  });
});

describe('HRM-04 / HRM-07: attendance', () => {
  it('records check-in/check-out and classifies the minutes', async () => {
    const e = await seedEmployee();
    await prisma.user.update({ where: { username: 'sales9' }, data: { employeeId: e.id } });
    const self = await actorFor('sales9');

    await runTx(self, (t) => attendance.checkIn(t, { at: new Date('2026-08-31T00:00:00Z') })); // 09:00 KST
    const row = await runTx(self, (t) =>
      attendance.checkOut(t, { at: new Date('2026-08-31T11:00:00Z'), breakMinutes: 60 }),
    );
    expect(row.workMinutes).toBe(600);
    expect(row.overtimeMinutes).toBe(120);

    await expect(
      runTx(self, (t) => attendance.checkIn(t, { at: new Date('2026-08-31T01:00:00Z') })),
    ).rejects.toThrow(/이미 기록/);
    await prisma.user.update({ where: { username: 'sales9' }, data: { employeeId: null } });
  });

  it('bulk upload applies valid rows and reports errors per row', async () => {
    const e = await seedEmployee({ hireDate: '2026-01-02' });
    const result = await runTx(admin, (t) =>
      attendance.bulkUpload(t, [
        { employeeNo: e.employeeNo, workDate: '2026-08-31', checkIn: '09:00', checkOut: '18:00' },
        { employeeNo: 'NOPE', workDate: '2026-08-31' },
        { employeeNo: e.employeeNo, workDate: '2025-12-31' }, // before hire date
        { employeeNo: e.employeeNo, workDate: '31-08-2026' }, // bad format
      ]),
    );
    expect(result.applied).toBe(1);
    expect(result.errors).toHaveLength(3);
    expect(result.errors.map((x) => x.row)).toEqual([2, 3, 4]);
    // the unknown 사번 row's message names the offending value, not just a generic failure
    expect(result.errors[0]!.message).toContain('NOPE');
    expect(result.errors[0]!.message).toContain('사원이 없습니다');
    expect(await prisma.attendance.count({ where: { employeeId: e.id } })).toBe(1);

    // the valid row's data actually landed, not merely counted
    const applied = await prisma.attendance.findFirstOrThrow({ where: { employeeId: e.id } });
    expect(applied.source).toBe('UPLOAD');
    expect(applied.checkIn).not.toBeNull();
  });

  it('a correction is only reflected once approved', async () => {
    const e = await seedEmployee();
    const request = await runTx(admin, (t) =>
      attendance.requestCorrection(t, {
        docNo: 'AC-202608-0001',
        employeeId: e.id,
        workDate: '2026-08-31',
        requestedCheckIn: '09:00',
        requestedCheckOut: '18:00',
        reason: '출근 태그 누락으로 정정 요청',
      }),
    );
    expect(await prisma.attendance.count({ where: { employeeId: e.id } })).toBe(0);

    await runTx(admin, (t) => attendance.applyCorrection(t, request.id));
    const row = await prisma.attendance.findFirstOrThrow({ where: { employeeId: e.id } });
    expect(row.source).toBe('CORRECTION');
    expect(row.workMinutes).toBe(540);

    await expect(runTx(admin, (t) => attendance.applyCorrection(t, request.id))).rejects.toThrow(/이미 반영/);
  });
});

describe('HRM-05 / HRM-06 / E2E-03: leave', () => {
  async function withGrant(days = '15.0') {
    const e = await seedEmployee({ hireDate: '2024-03-01' });
    await runTx(admin, (t) =>
      leave.grantManual(t, {
        employeeId: e.id,
        days,
        grantDate: '2026-03-01',
        expiresAt: '2027-02-28',
        reason: '시험용 부여',
      }),
    );
    return e;
  }

  it('grants annual leave from the approved policy version', async () => {
    const e = await seedEmployee({ hireDate: '2024-03-01' });
    const result = await runTx(admin, (t) => leave.grantAnnual(t, { employeeId: e.id, asOf: '2026-03-01' }));
    expect(result.granted).toBe(true);
    expect(result.days).toBe('15.0');

    const grant = await prisma.leaveGrant.findFirstOrThrow({ where: { employeeId: e.id } });
    expect(grant.policyVersionId).toBeTruthy();

    // re-running does not double-grant
    const again = await runTx(admin, (t) => leave.grantAnnual(t, { employeeId: e.id, asOf: '2026-03-01' }));
    expect(again.granted).toBe(false);
    expect(await prisma.leaveGrant.count({ where: { employeeId: e.id } })).toBe(1);
  });

  it('applies an approved leave to the usage ledger and to attendance', async () => {
    const e = await withGrant();
    const request = await runTx(admin, (t) =>
      leave.requestLeave(t, {
        docNo: 'LV-202609-0001',
        employeeId: e.id,
        startDate: '2026-09-10',
        endDate: '2026-09-11',
      }),
    );
    expect(request.days.toString()).toBe('2');

    await runTx(admin, (t) => leave.applyApprovedLeave(t, request.id));

    const balance = await runTx(admin, (t) => leave.balanceOf(t, e.id, '2026-09-12'));
    expect(balance.used).toBe('2.0');
    expect(balance.remaining).toBe('13.0');

    const days = await prisma.attendance.findMany({
      where: { employeeId: e.id },
      orderBy: { workDate: 'asc' },
    });
    expect(days).toHaveLength(2);
    expect(days.every((d) => d.status === 'LEAVE')).toBe(true);
  });

  it('cancellation writes a reversal row and never deletes the original (INT-07)', async () => {
    const e = await withGrant();
    const request = await runTx(admin, (t) =>
      leave.requestLeave(t, {
        docNo: 'LV-202609-0002',
        employeeId: e.id,
        startDate: '2026-09-10',
        endDate: '2026-09-11',
      }),
    );
    await runTx(admin, (t) => leave.applyApprovedLeave(t, request.id));
    await runTx(admin, (t) => leave.cancelApprovedLeave(t, request.id, '일정 변경'));

    const usages = await prisma.leaveUsage.findMany({
      where: { employeeId: e.id },
      orderBy: { createdAt: 'asc' },
    });
    expect(usages).toHaveLength(2);
    expect(usages[0]!.days.toString()).toBe('2');
    expect(usages[1]!.days.toString()).toBe('-2');
    expect(usages[1]!.reversalOfId).toBe(usages[0]!.id);

    const balance = await runTx(admin, (t) => leave.balanceOf(t, e.id, '2026-09-12'));
    expect(balance.remaining).toBe('15.0');

    const days = await prisma.attendance.findMany({ where: { employeeId: e.id } });
    expect(days.every((d) => d.status === 'NORMAL')).toBe(true);

    await expect(
      runTx(admin, (t) => leave.cancelApprovedLeave(t, request.id, '중복 취소')),
    ).rejects.toThrow();
  });

  it('refuses a request that exceeds the remaining balance', async () => {
    const e = await withGrant('2.0');
    await expect(
      runTx(admin, (t) =>
        leave.requestLeave(t, {
          docNo: 'LV-202609-0003',
          employeeId: e.id,
          startDate: '2026-09-07',
          endDate: '2026-09-18',
        }),
      ),
    ).rejects.toThrow(/잔여 연차/);
  });

  it('refuses overlapping requests', async () => {
    const e = await withGrant();
    await runTx(admin, (t) =>
      leave.requestLeave(t, {
        docNo: 'LV-202609-0004',
        employeeId: e.id,
        startDate: '2026-09-10',
        endDate: '2026-09-11',
      }),
    );
    await expect(
      runTx(admin, (t) =>
        leave.requestLeave(t, {
          docNo: 'LV-202609-0005',
          employeeId: e.id,
          startDate: '2026-09-11',
          endDate: '2026-09-14',
        }),
      ),
    ).rejects.toThrow(/기간이 겹칩니다/);
  });

  it('counts a half day as 0.5 and only for a single date', async () => {
    const e = await withGrant();
    const half = await runTx(admin, (t) =>
      leave.requestLeave(t, {
        docNo: 'LV-202609-0006',
        employeeId: e.id,
        startDate: '2026-09-10',
        endDate: '2026-09-10',
        halfDay: 'AM',
      }),
    );
    expect(half.days.toString()).toBe('0.5');

    await expect(
      runTx(admin, (t) =>
        leave.requestLeave(t, {
          docNo: 'LV-202609-0007',
          employeeId: e.id,
          startDate: '2026-09-14',
          endDate: '2026-09-15',
          halfDay: 'PM',
        }),
      ),
    ).rejects.toThrow(/반차는 하루만/);
  });

  it('skips weekends when counting requested days', async () => {
    const e = await withGrant();
    // 2026-09-11 is a Friday, 2026-09-14 a Monday
    const request = await runTx(admin, (t) =>
      leave.requestLeave(t, {
        docNo: 'LV-202609-0008',
        employeeId: e.id,
        startDate: '2026-09-11',
        endDate: '2026-09-14',
      }),
    );
    expect(request.days.toString()).toBe('2');
  });

  it('the leave ledger refuses updates and deletes (INT-04)', async () => {
    const e = await withGrant();
    const request = await runTx(admin, (t) =>
      leave.requestLeave(t, {
        docNo: 'LV-202609-0009',
        employeeId: e.id,
        startDate: '2026-09-10',
        endDate: '2026-09-10',
      }),
    );
    await runTx(admin, (t) => leave.applyApprovedLeave(t, request.id));
    const usage = await prisma.leaveUsage.findFirstOrThrow({ where: { employeeId: e.id } });

    await expect(
      prisma.$executeRawUnsafe(`UPDATE "LeaveUsage" SET days = 99 WHERE id = '${usage.id}'`),
    ).rejects.toThrow(/append-only/);
    await expect(
      prisma.$executeRawUnsafe(`DELETE FROM "LeaveUsage" WHERE id = '${usage.id}'`),
    ).rejects.toThrow(/append-only/);
  });

  it('expires grants past their validity as a negative ledger row', async () => {
    const e = await seedEmployee();
    await runTx(admin, (t) =>
      leave.grantManual(t, {
        employeeId: e.id,
        days: '10.0',
        grantDate: '2024-03-01',
        expiresAt: '2025-02-28',
        reason: '만료 대상',
      }),
    );
    const result = await runTx(admin, (t) => leave.expireGrants(t, '2026-08-30'));
    expect(result.expired).toBe(1);

    const grants = await prisma.leaveGrant.findMany({ where: { employeeId: e.id } });
    expect(grants).toHaveLength(2);
    expect(grants.find((g) => g.sourceType === 'EXPIRY')?.days.toString()).toBe('-10');

    // running twice does not double-expire
    expect((await runTx(admin, (t) => leave.expireGrants(t, '2026-08-30'))).expired).toBe(0);
  });
});

describe('HRM-09 / HRM-10 / HRM-13', () => {
  it('issues a certificate with a permanent record and no sensitive identifiers', async () => {
    const e = await seedEmployee({ jobTitle: '과장' });
    const result = await runTx(admin, (t) =>
      employee.issueCertificate(t, {
        employeeId: e.id,
        certType: 'EMPLOYMENT',
        purpose: '은행 제출',
        issueNo: 'CT-2026-0001',
      }),
    );
    expect(result.document.name).toBe('홍길동');
    expect(result.document.jobTitle).toBe('과장');
    expect(JSON.stringify(result.document)).not.toMatch(/\d{6}-\d{7}/);
    expect(await prisma.certificateIssue.count({ where: { employeeId: e.id } })).toBe(1);
  });

  it('reports headcount distribution as of a date', async () => {
    await seedEmployee({ hireDate: '2024-01-02' });
    await seedEmployee({ name: '신입', hireDate: '2026-03-01', employmentType: 'CONTRACT' });
    const overview = await runTx(admin, (t) => employee.overview(t, '2026-08-30'));
    expect(overview.headcount).toBe(2);
    expect(overview.hiredThisYear).toBe(1);
    expect(overview.byEmploymentType.find((x) => x.name === 'CONTRACT')?.count).toBe(1);
  });

  it('self-service change requests are limited to contact fields and need HR review', async () => {
    const e = await seedEmployee();
    await prisma.user.update({ where: { username: 'sales9' }, data: { employeeId: e.id } });
    const self = await actorFor('sales9');

    await expect(
      runTx(self, (t) =>
        employee.requestChange(t, { changes: { jobTitle: { before: '사원', after: '이사' } } }),
      ),
    ).rejects.toThrow(/연락처·이메일·주소만/);

    const request = await runTx(self, (t) =>
      employee.requestChange(t, { changes: { phone: { before: '010-1234-5678', after: '010-9999-8888' } } }),
    );
    expect((await prisma.employee.findUniqueOrThrow({ where: { id: e.id } })).phone).toBe('010-1234-5678');

    hrUser = await actorFor('hrm1');
    await runTx(hrUser, (t) => employee.reviewChange(t, { requestId: request.id, approve: true }));
    expect((await prisma.employee.findUniqueOrThrow({ where: { id: e.id } })).phone).toBe('010-9999-8888');

    await expect(
      runTx(hrUser, (t) => employee.reviewChange(t, { requestId: request.id, approve: true })),
    ).rejects.toThrow(/이미 처리/);
    await prisma.user.update({ where: { username: 'sales9' }, data: { employeeId: null } });
  });
});
