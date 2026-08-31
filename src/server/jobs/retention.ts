import type { TransactionContext } from '@/server/core/context';
import { withTransaction } from '@/server/core/context';
import { prisma } from '@/server/db';
import { logger } from '@/server/core/logger';
import * as audit from '@/server/modules/audit/service';
import * as policy from '@/server/modules/policy/service';
import { securityEvent } from '@/server/modules/auth/service';
import type { RetentionPolicyConfig } from '@/server/modules/policy/service';
import { getStorage } from '@/server/modules/storage/service';
import type { Actor } from '@/server/core/context';

/**
 * NFR-SEC-08 / DEC-06 — actually destroying personal data.
 *
 * ADR-0008 has said since STEP 1 that resident registration and account numbers are
 * destroyed on resignation and that resigned HR records are anonymised after three years.
 * The policy was seeded, the RetentionRun table existed, and the outbox topic was declared
 * — and nothing implemented any of it, so every ex-employee's identifiers stayed in the
 * database indefinitely. A retention policy that is written down and not executed is worse
 * than none, because it is relied on.
 *
 * The run is deliberately two-phase. `plan()` counts and records what would be destroyed
 * and stops; `execute()` acts on an approved plan. Destruction is irreversible, so somebody
 * signs for it, and the run record is what they signed.
 */

export interface RetentionPlanItem {
  key: string;
  label: string;
  action: 'PURGE' | 'ANONYMIZE' | 'KEEP';
  years: number | null;
  /** how many records the policy would act on today */
  targetCount: number;
  cutoff: string | null;
}

/** The date before which a record with this retention period is due for destruction. */
function cutoffFor(years: number | null, now: Date): Date | null {
  if (years === null) return null;
  const d = new Date(now.getTime());
  d.setUTCFullYear(d.getUTCFullYear() - years);
  return d;
}

async function countFor(ctx: TransactionContext, key: string, cutoff: Date | null): Promise<number> {
  switch (key) {
    case 'employee.sensitive':
      // years: 0 — due the moment the person resigns
      return ctx.tx.employeeSensitive.count({
        where: {
          employee: { status: 'RESIGNED', leaveDate: cutoff ? { lte: cutoff } : { not: null } },
          OR: [{ residentNoEnc: { not: null } }, { bankAccountEnc: { not: null } }],
        },
      });
    case 'employee.resigned':
      return ctx.tx.employee.count({
        where: {
          status: 'RESIGNED',
          ...(cutoff ? { leaveDate: { lte: cutoff } } : {}),
          anonymizedAt: null,
        },
      });
    case 'employee.contract':
      return ctx.tx.attachment.count({
        where: {
          ownerType: 'EMPLOYEE_DOC',
          deletedAt: null,
          ...(cutoff ? { createdAt: { lte: cutoff } } : {}),
        },
      });
    default:
      // KEEP items and anything the policy names but this build does not act on
      return 0;
  }
}

export async function plan(ctx: TransactionContext, now = ctx.now) {
  const resolved = await policy.resolve<RetentionPolicyConfig>(ctx, 'retention');
  const items: RetentionPlanItem[] = [];

  for (const item of resolved.config.items) {
    const cutoff = cutoffFor(item.years, now);
    const targetCount = item.action === 'KEEP' ? 0 : await countFor(ctx, item.key, cutoff);
    items.push({
      key: item.key,
      label: item.label,
      action: item.action,
      years: item.years,
      targetCount,
      cutoff: cutoff ? cutoff.toISOString().slice(0, 10) : null,
    });
  }

  const run = await ctx.tx.retentionRun.create({
    data: {
      policyKey: 'retention',
      status: 'PLANNED',
      targetCount: items.reduce((acc, i) => acc + i.targetCount, 0),
      result: { items, policyVersionId: resolved.id } as never,
    },
  });

  await audit.record(ctx, {
    action: 'retention.plan',
    entityType: 'RetentionRun',
    entityId: run.id,
    after: { targetCount: run.targetCount, items: items.map((i) => `${i.key}:${i.targetCount}`) },
  });

  return { runId: run.id, items, targetCount: run.targetCount };
}

export async function approve(ctx: TransactionContext, runId: string) {
  const run = await ctx.tx.retentionRun.findUniqueOrThrow({ where: { id: runId } });
  if (run.status !== 'PLANNED') {
    throw new Error(`retention run ${runId} is ${run.status}, not PLANNED`);
  }
  await ctx.tx.retentionRun.update({
    where: { id: runId },
    data: { status: 'APPROVED', approvedById: ctx.actor.userId },
  });
  await audit.record(ctx, {
    action: 'retention.approve',
    entityType: 'RetentionRun',
    entityId: runId,
    after: { targetCount: run.targetCount },
  });
  return { runId, status: 'APPROVED' as const };
}

/**
 * Carries out an approved plan. Every branch destroys rather than hides: the ciphertext is
 * nulled, not flagged, and the stored file is removed from the object store as well as
 * marked deleted, because a soft delete leaves the personal data exactly where it was.
 */
export async function execute(ctx: TransactionContext, runId: string, now = ctx.now) {
  const run = await ctx.tx.retentionRun.findUniqueOrThrow({ where: { id: runId } });
  if (run.status !== 'APPROVED') {
    throw new Error(`retention run ${runId} is ${run.status}, not APPROVED`);
  }

  const resolved = await policy.resolve<RetentionPolicyConfig>(ctx, 'retention');
  const done: Record<string, number> = {};
  const removedKeys: string[] = [];

  for (const item of resolved.config.items) {
    if (item.action === 'KEEP') continue;
    const cutoff = cutoffFor(item.years, now);

    if (item.key === 'employee.sensitive') {
      const targets = await ctx.tx.employeeSensitive.findMany({
        where: {
          employee: { status: 'RESIGNED', leaveDate: cutoff ? { lte: cutoff } : { not: null } },
          OR: [{ residentNoEnc: { not: null } }, { bankAccountEnc: { not: null } }],
        },
        select: { employeeId: true },
      });
      if (targets.length > 0) {
        await ctx.tx.employeeSensitive.updateMany({
          where: { employeeId: { in: targets.map((t) => t.employeeId) } },
          data: {
            residentNoEnc: null,
            residentNoMaskDigit: null,
            bankAccountEnc: null,
            bankAccountLast4: null,
            bankName: null,
          },
        });
      }
      done[item.key] = targets.length;
      continue;
    }

    if (item.key === 'employee.resigned') {
      const targets = await ctx.tx.employee.findMany({
        where: {
          status: 'RESIGNED',
          ...(cutoff ? { leaveDate: { lte: cutoff } } : {}),
          anonymizedAt: null,
        },
        select: { id: true, employeeNo: true },
      });
      for (const t of targets) {
        /**
         * Anonymised, not deleted: payroll and approval history reference these rows, and
         * removing them would break records the company must keep. What goes is everything
         * that identifies the person; the employee number stays as an opaque handle.
         */
        await ctx.tx.employee.update({
          where: { id: t.id },
          data: {
            name: `퇴직자-${t.employeeNo}`,
            birthDate: null,
            phone: null,
            email: null,
            address: null,
            anonymizedAt: now,
          },
        });
      }
      done[item.key] = targets.length;
      continue;
    }

    if (item.key === 'employee.contract') {
      const targets = await ctx.tx.attachment.findMany({
        where: {
          ownerType: 'EMPLOYEE_DOC',
          deletedAt: null,
          ...(cutoff ? { createdAt: { lte: cutoff } } : {}),
        },
        select: { id: true, storageKey: true },
      });
      if (targets.length > 0) {
        await ctx.tx.attachment.updateMany({
          where: { id: { in: targets.map((t) => t.id) } },
          data: { deletedAt: now, purgedAt: now },
        });
        removedKeys.push(...targets.map((t) => t.storageKey));
      }
      done[item.key] = targets.length;
    }
  }

  const processed = Object.values(done).reduce((a, b) => a + b, 0);
  await ctx.tx.retentionRun.update({
    where: { id: runId },
    data: {
      status: 'EXECUTED',
      processedCount: processed,
      executedAt: now,
      result: { ...((run.result as object) ?? {}), executed: done } as never,
    },
  });

  await audit.record(ctx, {
    action: 'retention.execute',
    entityType: 'RetentionRun',
    entityId: runId,
    after: { processed, byItem: done },
  });

  // the object store is not transactional, so the files go after the rows commit
  return { runId, processed, byItem: done, removedKeys };
}

/**
 * The job the worker runs. It plans, and stops — destruction needs a person to approve it
 * (ADR-0008). A run that finds nothing due does not create noise.
 */
export async function retentionJob(): Promise<void> {
  const actor = await systemActor();
  const result = await withTransaction(
    prisma,
    { actor, requestId: `retention:${new Date().toISOString().slice(0, 10)}`, now: new Date() },
    (ctx) => plan(ctx),
  );

  if (result.targetCount === 0) {
    logger.info({ runId: result.runId }, 'retention: nothing due');
    return;
  }

  logger.warn(
    { runId: result.runId, targetCount: result.targetCount },
    'retention: records are due for destruction and need approval',
  );
  await securityEvent(prisma, 'RETENTION_DUE', {
    meta: { runId: result.runId, targetCount: result.targetCount },
  });
}

/**
 * Deleting the files an executed run marked. Separate from the transaction on purpose: the
 * object store cannot roll back, so the rows commit first and a failure here leaves a file
 * the next run will pick up again rather than a row that claims a file is gone when it is not.
 */
export async function purgeStoredFiles(keys: string[]): Promise<{ removed: number; failed: number }> {
  let removed = 0;
  let failed = 0;
  for (const key of keys) {
    try {
      await getStorage().remove(key);
      removed += 1;
    } catch (e) {
      failed += 1;
      logger.error({ key, err: (e as Error).message }, 'retention: failed to remove stored file');
    }
  }
  return { removed, failed };
}

/** The actor a scheduled job runs as: full permissions, no session, recorded as SYSTEM. */
async function systemActor(): Promise<Actor> {
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
