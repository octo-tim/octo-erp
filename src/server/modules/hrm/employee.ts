import type { TransactionContext } from '@/server/core/context';
import { AppError } from '@/server/core/errors';
import { decryptSensitive, encryptSensitive, last4 } from '@/server/core/crypto';
import { maskBankAccount, maskResidentNo } from '@/server/core/redact';
import { assertHrScope, has, hrScopeFilter, requirePermission } from '@/server/modules/rbac/service';
import * as audit from '@/server/modules/audit/service';
import * as outbox from '@/server/modules/outbox/service';
import { deactivateUserForEmployee } from '@/server/modules/auth/service';
import { businessDate, fromDateOnly, toDateOnly } from '@/lib/dates';
import { getEnv } from '@/server/env';

/** HRM-01, HRM-11, HRM-12. Sensitive columns live in EmployeeSensitive, never on Employee. */

export interface EmployeeInput {
  employeeNo?: string;
  name: string;
  birthDate?: string;
  phone?: string;
  email?: string;
  address?: string;
  hireDate: string;
  departmentId?: string;
  positionCode?: string;
  jobTitle?: string;
  employmentType?: string;
  contractEndDate?: string;
}

export async function create(ctx: TransactionContext, input: EmployeeInput) {
  requirePermission(ctx.actor, 'hr.write');

  const employeeNo = input.employeeNo ?? (await nextEmployeeNo(ctx));
  const employee = await ctx.tx.employee.create({
    data: {
      employeeNo,
      name: input.name,
      birthDate: input.birthDate ? toDateOnly(input.birthDate) : null,
      phone: input.phone ?? null,
      email: input.email ?? null,
      address: input.address ?? null,
      hireDate: toDateOnly(input.hireDate),
      departmentId: input.departmentId ?? null,
      positionCode: input.positionCode ?? null,
      jobTitle: input.jobTitle ?? null,
      employmentType: input.employmentType ?? 'REGULAR',
      contractEndDate: input.contractEndDate ? toDateOnly(input.contractEndDate) : null,
    },
  });

  // HRM-03: hiring is itself an assignment, so point-in-time queries work from day one.
  await ctx.tx.assignment.create({
    data: {
      employeeId: employee.id,
      type: 'HIRE',
      departmentId: input.departmentId ?? null,
      positionCode: input.positionCode ?? null,
      jobTitle: input.jobTitle ?? null,
      employmentType: input.employmentType ?? 'REGULAR',
      effectiveFrom: toDateOnly(input.hireDate),
      createdById: ctx.actor.userId,
    },
  });

  await audit.record(ctx, {
    action: 'employee.create',
    entityType: 'Employee',
    entityId: employee.id,
    after: { employeeNo, name: input.name, hireDate: input.hireDate, departmentId: input.departmentId },
  });

  if (input.contractEndDate) await scheduleContractExpiryNotice(ctx, employee.id, input.contractEndDate);

  return employee;
}

async function nextEmployeeNo(ctx: TransactionContext): Promise<string> {
  const year = businessDate(ctx.now).slice(0, 4);
  const rows = await ctx.tx.$queryRaw<{ max: string | null }[]>`
    SELECT MAX("employeeNo") as max FROM "Employee" WHERE "employeeNo" LIKE ${`${year}%`}`;
  const current = rows[0]?.max;
  const seq = current ? Number(current.slice(4)) + 1 : 1;
  return `${year}${String(seq).padStart(3, '0')}`;
}

export async function update(
  ctx: TransactionContext,
  id: string,
  input: Partial<EmployeeInput>,
  version: number,
) {
  requirePermission(ctx.actor, 'hr.write');
  const before = await ctx.tx.employee.findUniqueOrThrow({ where: { id } });
  if (before.version !== version) {
    throw new AppError(
      'VERSION_CONFLICT',
      '사원정보가 다른 사용자에 의해 변경되었습니다. 새로 고친 뒤 다시 시도하세요.',
    );
  }

  const after = await ctx.tx.employee.update({
    where: { id },
    data: {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.birthDate !== undefined
        ? { birthDate: input.birthDate ? toDateOnly(input.birthDate) : null }
        : {}),
      ...(input.phone !== undefined ? { phone: input.phone } : {}),
      ...(input.email !== undefined ? { email: input.email } : {}),
      ...(input.address !== undefined ? { address: input.address } : {}),
      ...(input.jobTitle !== undefined ? { jobTitle: input.jobTitle } : {}),
      ...(input.positionCode !== undefined ? { positionCode: input.positionCode } : {}),
      ...(input.employmentType !== undefined ? { employmentType: input.employmentType } : {}),
      ...(input.contractEndDate !== undefined
        ? { contractEndDate: input.contractEndDate ? toDateOnly(input.contractEndDate) : null }
        : {}),
      version: { increment: 1 },
    },
  });

  await audit.record(ctx, {
    action: 'employee.update',
    entityType: 'Employee',
    entityId: id,
    before: { name: before.name, phone: before.phone, email: before.email, jobTitle: before.jobTitle },
    after: { name: after.name, phone: after.phone, email: after.email, jobTitle: after.jobTitle },
  });

  if (input.contractEndDate) await scheduleContractExpiryNotice(ctx, id, input.contractEndDate);
  return after;
}

/** HRM-08: contract expiry reminders go through the outbox, never a direct send (INT-10). */
async function scheduleContractExpiryNotice(
  ctx: TransactionContext,
  employeeId: string,
  contractEndDate: string,
) {
  await outbox.enqueue(ctx, {
    topic: 'job.contract_expiry',
    payload: { employeeId, contractEndDate },
    dedupKey: `contract:${employeeId}:${contractEndDate}`,
  });
}

export async function list(
  ctx: TransactionContext,
  input: { q?: string; departmentId?: string; status?: string; skip: number; take: number },
) {
  requirePermission(ctx.actor, 'hr.self');
  const where = {
    ...hrScopeFilter(ctx.actor),
    ...(input.departmentId ? { departmentId: input.departmentId } : {}),
    ...(input.status ? { status: input.status } : {}),
    ...(input.q
      ? {
          OR: [
            { name: { contains: input.q, mode: 'insensitive' as const } },
            { employeeNo: { contains: input.q } },
          ],
        }
      : {}),
  };
  const [rows, total] = await Promise.all([
    ctx.tx.employee.findMany({
      where,
      include: {
        department: { select: { code: true, name: true } },
        user: { select: { username: true, isActive: true } },
      },
      orderBy: { employeeNo: 'asc' },
      skip: input.skip,
      take: input.take,
    }),
    ctx.tx.employee.count({ where }),
  ]);
  return { rows, total };
}

export async function detail(ctx: TransactionContext, id: string) {
  assertHrScope(ctx.actor, id);
  const employee = await ctx.tx.employee.findUnique({
    where: { id },
    include: {
      department: true,
      user: { select: { id: true, username: true, isActive: true, lastLoginAt: true } },
      sensitive: {
        select: { residentNoLast4: true, bankName: true, bankAccountLast4: true, updatedAt: true },
      },
    },
  });
  if (!employee) throw new AppError('NOT_FOUND', '사원을 찾을 수 없습니다.');

  // HRM-12: masked by default, decryption is a separate, logged operation.
  return {
    ...employee,
    sensitive: employee.sensitive
      ? {
          residentNoMasked: maskResidentNo(employee.sensitive.residentNoLast4),
          bankName: employee.sensitive.bankName,
          bankAccountMasked: maskBankAccount(employee.sensitive.bankAccountLast4),
          updatedAt: employee.sensitive.updatedAt,
        }
      : null,
  };
}

export async function setSensitive(
  ctx: TransactionContext,
  input: { employeeId: string; residentNo?: string; bankName?: string; bankAccount?: string },
) {
  requirePermission(ctx.actor, 'hr.sensitive.read');
  const keyVersion = getEnv().DATA_ENCRYPTION_KEY_VERSION;

  const data: Record<string, unknown> = { keyVersion };
  if (input.residentNo !== undefined) {
    const normalized = input.residentNo.replace(/\D/g, '');
    if (normalized.length !== 13) throw new AppError('VALIDATION', '주민등록번호는 13자리 숫자여야 합니다.');
    data['residentNoEnc'] = encryptSensitive(normalized).ciphertext;
    data['residentNoLast4'] = last4(normalized);
  }
  if (input.bankAccount !== undefined) {
    data['bankAccountEnc'] = encryptSensitive(input.bankAccount).ciphertext;
    data['bankAccountLast4'] = last4(input.bankAccount);
  }
  if (input.bankName !== undefined) data['bankName'] = input.bankName;

  await ctx.tx.employeeSensitive.upsert({
    where: { employeeId: input.employeeId },
    create: { employeeId: input.employeeId, ...(data as object) },
    update: data as object,
  });

  // The audit row records that sensitive data changed, never the values themselves.
  await audit.record(ctx, {
    action: 'employee.setSensitive',
    entityType: 'Employee',
    entityId: input.employeeId,
    meta: {
      fields: Object.keys(input).filter((k) => k !== 'employeeId'),
      keyVersion,
    },
  });
}

/** HRM-12: decryption requires the dedicated permission, a stated reason, and leaves a trail. */
export async function revealSensitive(
  ctx: TransactionContext,
  input: { employeeId: string; field: 'residentNo' | 'bankAccount'; reason: string },
): Promise<string> {
  requirePermission(ctx.actor, 'hr.sensitive.read');
  if (input.reason.trim().length < 5) {
    throw new AppError('VALIDATION', '민감정보 조회 사유를 5자 이상 입력하세요.');
  }

  const row = await ctx.tx.employeeSensitive.findUnique({ where: { employeeId: input.employeeId } });
  if (!row) throw new AppError('NOT_FOUND', '등록된 민감정보가 없습니다.');

  const ciphertext = input.field === 'residentNo' ? row.residentNoEnc : row.bankAccountEnc;
  if (!ciphertext) throw new AppError('NOT_FOUND', '등록된 민감정보가 없습니다.');

  await ctx.tx.sensitiveAccessLog.create({
    data: {
      actorId: ctx.actor.userId,
      employeeId: input.employeeId,
      field: input.field,
      reason: input.reason.trim(),
      ip: ctx.ip ?? null,
      requestId: ctx.requestId,
    },
  });
  await ctx.tx.securityEvent.create({
    data: {
      type: 'SENSITIVE_ACCESS',
      userId: ctx.actor.userId,
      actorId: ctx.actor.userId,
      ip: ctx.ip ?? null,
      meta: { employeeId: input.employeeId, field: input.field } as never,
    },
  });

  return decryptSensitive(ciphertext);
}

export async function sensitiveAccessLog(ctx: TransactionContext, employeeId: string, take = 100) {
  requirePermission(ctx.actor, 'hr.sensitive.read');
  return ctx.tx.sensitiveAccessLog.findMany({
    where: { employeeId },
    orderBy: { createdAt: 'desc' },
    take,
  });
}

/**
 * HRM-11 / NFR-SEC-04: a resignation assignment and account deactivation are one
 * atomic operation — an ex-employee must never keep a live session.
 */
export async function resign(
  ctx: TransactionContext,
  input: { employeeId: string; leaveDate: string; reason?: string },
) {
  requirePermission(ctx.actor, 'hr.write');
  const employee = await ctx.tx.employee.findUniqueOrThrow({ where: { id: input.employeeId } });
  if (employee.status === 'RESIGNED') throw new AppError('CONFLICT', '이미 퇴사 처리된 사원입니다.');

  await ctx.tx.employee.update({
    where: { id: input.employeeId },
    data: { status: 'RESIGNED', leaveDate: toDateOnly(input.leaveDate), version: { increment: 1 } },
  });

  await ctx.tx.assignment.create({
    data: {
      employeeId: input.employeeId,
      type: 'RESIGN',
      effectiveFrom: toDateOnly(input.leaveDate),
      note: input.reason ?? null,
      createdById: ctx.actor.userId,
    },
  });

  // close the open assignment period
  await ctx.tx.assignment.updateMany({
    where: { employeeId: input.employeeId, type: { not: 'RESIGN' }, effectiveTo: null },
    data: { effectiveTo: toDateOnly(input.leaveDate) },
  });

  await deactivateUserForEmployee(ctx, input.employeeId);

  await audit.record(ctx, {
    action: 'employee.resign',
    entityType: 'Employee',
    entityId: input.employeeId,
    before: { status: employee.status },
    after: { status: 'RESIGNED', leaveDate: input.leaveDate },
  });
}

/** HRM-13: an employee's own record, with everything sensitive masked. */
export async function me(ctx: TransactionContext) {
  if (!ctx.actor.employeeId)
    throw new AppError('NOT_FOUND', '연결된 사원정보가 없습니다. 인사담당자에게 문의하세요.');
  return detail(ctx, ctx.actor.employeeId);
}

/** HRM-13: employees request their own changes; HR reviews and applies them. */
export async function requestChange(
  ctx: TransactionContext,
  input: { changes: Record<string, { before: string | null; after: string }> },
) {
  if (!ctx.actor.employeeId) throw new AppError('NOT_FOUND', '연결된 사원정보가 없습니다.');
  const allowed = ['phone', 'email', 'address'];
  const invalid = Object.keys(input.changes).filter((k) => !allowed.includes(k));
  if (invalid.length) {
    throw new AppError(
      'VALIDATION',
      `본인 변경신청은 연락처·이메일·주소만 가능합니다: ${invalid.join(', ')}`,
    );
  }

  const request = await ctx.tx.employeeChangeRequest.create({
    data: { employeeId: ctx.actor.employeeId, changes: input.changes as never },
  });
  await audit.record(ctx, {
    action: 'employee.requestChange',
    entityType: 'EmployeeChangeRequest',
    entityId: request.id,
    meta: { fields: Object.keys(input.changes) },
  });
  return request;
}

export async function reviewChange(
  ctx: TransactionContext,
  input: { requestId: string; approve: boolean; note?: string },
) {
  requirePermission(ctx.actor, 'hr.write');
  const request = await ctx.tx.employeeChangeRequest.findUniqueOrThrow({ where: { id: input.requestId } });
  if (request.status !== 'PENDING') throw new AppError('CONFLICT', '이미 처리된 변경신청입니다.');

  if (input.approve) {
    const changes = request.changes as Record<string, { after: string }>;
    await ctx.tx.employee.update({
      where: { id: request.employeeId },
      data: {
        ...(changes['phone'] ? { phone: changes['phone'].after } : {}),
        ...(changes['email'] ? { email: changes['email'].after } : {}),
        ...(changes['address'] ? { address: changes['address'].after } : {}),
        version: { increment: 1 },
      },
    });
  }

  await ctx.tx.employeeChangeRequest.update({
    where: { id: input.requestId },
    data: {
      status: input.approve ? 'APPROVED' : 'REJECTED',
      reviewerId: ctx.actor.userId,
      reviewNote: input.note ?? null,
    },
  });

  await audit.record(ctx, {
    action: input.approve ? 'employee.changeApproved' : 'employee.changeRejected',
    entityType: 'EmployeeChangeRequest',
    entityId: input.requestId,
  });
}

/** HRM-10: headcount distribution by department, employment type and tenure. */
export async function overview(ctx: TransactionContext, asOf?: string) {
  requirePermission(ctx.actor, 'hr.read');
  const date = asOf ?? businessDate(ctx.now);

  const employees = await ctx.tx.employee.findMany({
    where: {
      OR: [{ leaveDate: null }, { leaveDate: { gte: toDateOnly(date) } }],
      hireDate: { lte: toDateOnly(date) },
    },
    include: { department: { select: { code: true, name: true } } },
  });

  const byDepartment = new Map<string, number>();
  const byEmploymentType = new Map<string, number>();
  const byTenure = new Map<string, number>();

  for (const e of employees) {
    const dept = e.department?.name ?? '미지정';
    byDepartment.set(dept, (byDepartment.get(dept) ?? 0) + 1);
    byEmploymentType.set(e.employmentType, (byEmploymentType.get(e.employmentType) ?? 0) + 1);
    const years = Math.floor((toDateOnly(date).getTime() - e.hireDate.getTime()) / (365.25 * 86400000));
    const bucket =
      years < 1
        ? '1년 미만'
        : years < 3
          ? '1~3년'
          : years < 5
            ? '3~5년'
            : years < 10
              ? '5~10년'
              : '10년 이상';
    byTenure.set(bucket, (byTenure.get(bucket) ?? 0) + 1);
  }

  const yearStart = `${date.slice(0, 4)}-01-01`;
  const [hired, left] = await Promise.all([
    ctx.tx.employee.count({ where: { hireDate: { gte: toDateOnly(yearStart), lte: toDateOnly(date) } } }),
    ctx.tx.employee.count({ where: { leaveDate: { gte: toDateOnly(yearStart), lte: toDateOnly(date) } } }),
  ]);

  return {
    asOf: date,
    headcount: employees.length,
    byDepartment: [...byDepartment].map(([name, count]) => ({ name, count })),
    byEmploymentType: [...byEmploymentType].map(([name, count]) => ({ name, count })),
    byTenure: [...byTenure].map(([name, count]) => ({ name, count })),
    hiredThisYear: hired,
    leftThisYear: left,
  };
}

/** HRM-09: certificate issue with its own numbering and permanent issue history. */
export async function issueCertificate(
  ctx: TransactionContext,
  input: { employeeId: string; certType: 'EMPLOYMENT' | 'CAREER'; purpose?: string; issueNo: string },
) {
  assertHrScope(ctx.actor, input.employeeId);
  if (!has(ctx.actor, 'hr.self') && !has(ctx.actor, 'hr.read')) {
    throw new AppError('FORBIDDEN', '증명서를 발급할 권한이 없습니다.');
  }

  const employee = await ctx.tx.employee.findUniqueOrThrow({
    where: { id: input.employeeId },
    include: { department: true },
  });

  const issue = await ctx.tx.certificateIssue.create({
    data: {
      issueNo: input.issueNo,
      employeeId: input.employeeId,
      certType: input.certType,
      purpose: input.purpose ?? null,
      issuedById: ctx.actor.userId,
    },
  });

  await audit.record(ctx, {
    action: 'certificate.issue',
    entityType: 'CertificateIssue',
    entityId: issue.id,
    after: { issueNo: input.issueNo, certType: input.certType, employeeId: input.employeeId },
  });

  return {
    issue,
    // The PDF is rendered from this payload; no sensitive identifiers are included.
    document: {
      issueNo: input.issueNo,
      certType: input.certType,
      employeeNo: employee.employeeNo,
      name: employee.name,
      department: employee.department?.name ?? '',
      jobTitle: employee.jobTitle ?? '',
      hireDate: fromDateOnly(employee.hireDate),
      leaveDate: employee.leaveDate ? fromDateOnly(employee.leaveDate) : null,
      purpose: input.purpose ?? '',
      issuedAt: businessDate(ctx.now),
    },
  };
}
