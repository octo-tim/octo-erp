import { withTransaction } from '@/server/core/context';
import type { Actor } from '@/server/core/context';
import { prisma } from '@/server/db';
import { logger } from '@/server/core/logger';
import { notify } from '@/server/modules/notification/service';

/**
 * HRM-08 — telling HR that a fixed-term contract is about to end.
 *
 * `employee.create`/`update` have enqueued `job.contract_expiry` since STEP 4 and nothing
 * consumed it, so the reminder never arrived and the outbox reported success. The payload
 * carries the employee, but the job re-reads rather than trusting it: a contract that was
 * extended, or an employee who has since resigned, must not produce a reminder just because
 * an event was queued weeks ago.
 */
const NOTICE_DAYS = 30;

export async function contractExpiryJob(payload: Record<string, unknown>): Promise<void> {
  const employeeId = typeof payload['employeeId'] === 'string' ? payload['employeeId'] : null;
  if (!employeeId) {
    logger.warn({ payload }, 'contract expiry job without an employeeId');
    return;
  }

  const employee = await prisma.employee.findUnique({
    where: { id: employeeId },
    select: { id: true, name: true, employeeNo: true, status: true, contractEndDate: true },
  });

  // the state that mattered is the state now, not the state when this was queued
  if (!employee || employee.status === 'RESIGNED' || !employee.contractEndDate) return;
  const endDate = employee.contractEndDate.toISOString().slice(0, 10);

  const daysLeft = Math.ceil((employee.contractEndDate.getTime() - Date.now()) / 86_400_000);
  if (daysLeft > NOTICE_DAYS || daysLeft < 0) return;

  const recipients = await prisma.user.findMany({
    where: {
      isActive: true,
      roles: { some: { role: { permissions: { some: { permission: { code: 'hr.write' } } } } } },
    },
    select: { id: true },
  });
  if (recipients.length === 0) return;

  await withTransaction(
    prisma,
    { actor: systemActor(), requestId: `contract-expiry:${employee.id}`, now: new Date() },
    (ctx) =>
      notify(ctx, {
        userIds: recipients.map((r) => r.id),
        category: 'HR',
        title: `계약 만료 예정: ${employee.name}`,
        body: `${employee.employeeNo} ${employee.name}의 계약이 ${endDate}에 만료됩니다. 갱신 여부를 확인하세요.`,
        linkUrl: `/hr/employees/${employee.id}`,
        // one reminder per employee per contract end date, however often this is queued
        dedupKey: `contract-expiry:${employee.id}:${endDate}`,
      }),
  );
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
