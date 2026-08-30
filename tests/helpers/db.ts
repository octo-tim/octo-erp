import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { prisma } from '@/server/db';
import type { Actor, BaseContext } from '@/server/core/context';
import { withTransaction } from '@/server/core/context';
import { buildActor } from '@/server/modules/auth/service';

let prepared = false;

/** Applies migrations + seed to DATABASE_URL_TEST once per test run. */
export function prepareDatabase(): void {
  if (prepared) return;
  const url = process.env['DATABASE_URL_TEST'] ?? '';
  execFileSync('node', ['tools/migrate.mjs', 'reset', '--url', url], {
    stdio: 'pipe',
    env: { ...process.env, DATABASE_URL: url },
  });
  execFileSync('npx', ['tsx', 'prisma/seed.ts'], {
    stdio: 'pipe',
    env: { ...process.env, DATABASE_URL: url },
  });
  prepared = true;
}

/** Truncates business data but keeps seeded reference data (roles, policies, numbering). */
export async function truncateBusinessData(): Promise<void> {
  await prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      "AuditLog", "SecurityEvent", "SensitiveAccessLog", "IdempotencyRecord", "OutboxEvent",
      "NotificationDelivery", "Notification", "Attachment", "UserPreference",
      "LoginAttempt", "Session",
      "LeaveUsage", "LeaveGrant", "LeaveRequest", "AttendanceCorrectionRequest", "Attendance",
      "EmployeeChangeRequest", "CertificateIssue", "EmployeeDocument", "Assignment",
      "DepartmentHistory", "EmployeeSensitive"
    RESTART IDENTITY CASCADE`);
  // Employee cannot be truncated with CASCADE without wiping the seeded users that
  // reference it, so detach and delete instead.
  await prisma.$executeRawUnsafe(`UPDATE "User" SET "employeeId" = NULL`);
  await prisma.$executeRawUnsafe(`DELETE FROM "Employee"`);
  await prisma.$executeRawUnsafe(
    `DELETE FROM "Department" WHERE "code" NOT IN ('HQ', 'MGT', 'SAL', 'PUR', 'ACC')`,
  );
  await prisma.$executeRawUnsafe(`UPDATE "NumberingCounter" SET "lastSeq" = 0`);
}

export async function actorFor(username: string): Promise<Actor> {
  const user = await prisma.user.findUniqueOrThrow({ where: { username } });
  return buildActor(prisma, user.id);
}

export function baseCtx(actor: Actor, now = new Date()): BaseContext {
  return { actor, requestId: randomUUID(), now };
}

/** Runs `fn` inside one transaction, mirroring how routers call services. */
export async function runTx<T>(
  actor: Actor,
  fn: Parameters<typeof withTransaction<T>>[2],
  requestId?: string,
): Promise<T> {
  const base = baseCtx(actor);
  return withTransaction(prisma, requestId ? { ...base, requestId } : base, fn);
}

export { prisma };
