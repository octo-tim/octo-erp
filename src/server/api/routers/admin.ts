import { z } from 'zod';
import { permissionProcedure, readTx, router, tx } from '@/server/api/trpc';
import { prisma } from '@/server/db';
import * as audit from '@/server/modules/audit/service';
import * as policy from '@/server/modules/policy/service';
import { hashPassword, validatePasswordPolicy } from '@/server/core/crypto';
import { AppError } from '@/server/core/errors';
import { cuid, dateString, paging, requestId, skipTake } from '@/server/api/schemas/common';
import { nextBackoff } from '@/server/modules/outbox/service';
import * as retention from '@/server/jobs/retention';

export const adminRouter = router({
  // ── users & roles (NFR-SEC-01) ──
  listUsers: permissionProcedure('admin.users')
    .input(paging.extend({ q: z.string().trim().optional(), activeOnly: z.boolean().default(false) }))
    .query(async ({ input }) => {
      const where = {
        ...(input.activeOnly ? { isActive: true } : {}),
        ...(input.q
          ? {
              OR: [
                { username: { contains: input.q, mode: 'insensitive' as const } },
                { displayName: { contains: input.q, mode: 'insensitive' as const } },
              ],
            }
          : {}),
      };
      const [rows, total] = await Promise.all([
        prisma.user.findMany({
          where,
          include: {
            roles: { include: { role: true } },
            employee: { select: { employeeNo: true, name: true } },
            // updateUserAccess replaces both scope sets wholesale, so an editor that cannot
            // read the current ones can only submit an empty list and silently strip a
            // user's division and warehouse access while changing something unrelated.
            divisionScopes: { select: { divisionId: true } },
            warehouseScopes: { select: { warehouseId: true } },
          },
          orderBy: { username: 'asc' },
          ...skipTake(input),
        }),
        prisma.user.count({ where }),
      ]);
      return {
        rows: rows.map((u) => ({
          id: u.id,
          username: u.username,
          displayName: u.displayName,
          email: u.email,
          isActive: u.isActive,
          lockedUntil: u.lockedUntil,
          lastLoginAt: u.lastLoginAt,
          roles: u.roles.map((r) => r.role.code),
          divisionIds: u.divisionScopes.map((s) => s.divisionId),
          warehouseIds: u.warehouseScopes.map((s) => s.warehouseId),
          employee: u.employee,
        })),
        total,
        page: input.page,
        pageSize: input.pageSize,
      };
    }),

  createUser: permissionProcedure('admin.users')
    .input(
      z.object({
        username: z
          .string()
          .min(3)
          .max(50)
          .regex(/^[a-z0-9._-]+$/, '아이디는 영문 소문자·숫자·. _ - 만 사용할 수 있습니다.'),
        displayName: z.string().min(1).max(50),
        email: z.string().email().optional(),
        password: z.string().min(10),
        employeeId: cuid.optional(),
        roleCodes: z.array(z.string()).min(1),
        divisionIds: z.array(cuid).default([]),
        warehouseIds: z.array(cuid).default([]),
        requestId,
      }),
    )
    .mutation(({ ctx, input }) =>
      tx(
        ctx,
        async (t) => {
          const err = validatePasswordPolicy(input.password);
          if (err) throw new AppError('VALIDATION', err);
          const roles = await t.tx.role.findMany({ where: { code: { in: input.roleCodes } } });
          if (roles.length !== input.roleCodes.length)
            throw new AppError('VALIDATION', '존재하지 않는 역할이 포함되어 있습니다.');

          const user = await t.tx.user.create({
            data: {
              username: input.username,
              displayName: input.displayName,
              email: input.email ?? null,
              passwordHash: await hashPassword(input.password),
              mustChangePassword: true,
              employeeId: input.employeeId ?? null,
              roles: { create: roles.map((r) => ({ roleId: r.id })) },
              divisionScopes: { create: input.divisionIds.map((divisionId) => ({ divisionId })) },
              warehouseScopes: { create: input.warehouseIds.map((warehouseId) => ({ warehouseId })) },
            },
          });
          await audit.record(t, {
            action: 'user.create',
            entityType: 'User',
            entityId: user.id,
            after: { username: user.username, displayName: user.displayName, roles: input.roleCodes },
          });
          return { id: user.id };
        },
        input.requestId,
      ),
    ),

  updateUserAccess: permissionProcedure('admin.users')
    .input(
      z.object({
        userId: cuid,
        roleCodes: z.array(z.string()).min(1),
        divisionIds: z.array(cuid),
        warehouseIds: z.array(cuid),
        isActive: z.boolean(),
        requestId,
      }),
    )
    .mutation(({ ctx, input }) =>
      tx(
        ctx,
        async (t) => {
          const before = await t.tx.user.findUniqueOrThrow({
            where: { id: input.userId },
            include: { roles: { include: { role: true } }, divisionScopes: true, warehouseScopes: true },
          });
          const roles = await t.tx.role.findMany({ where: { code: { in: input.roleCodes } } });
          if (roles.length !== input.roleCodes.length)
            throw new AppError('VALIDATION', '존재하지 않는 역할이 포함되어 있습니다.');

          await t.tx.userRole.deleteMany({ where: { userId: input.userId } });
          await t.tx.userDivisionScope.deleteMany({ where: { userId: input.userId } });
          await t.tx.userWarehouseScope.deleteMany({ where: { userId: input.userId } });
          await t.tx.user.update({
            where: { id: input.userId },
            data: {
              isActive: input.isActive,
              roles: { create: roles.map((r) => ({ roleId: r.id })) },
              divisionScopes: { create: input.divisionIds.map((divisionId) => ({ divisionId })) },
              warehouseScopes: { create: input.warehouseIds.map((warehouseId) => ({ warehouseId })) },
            },
          });
          if (!input.isActive) {
            await t.tx.session.updateMany({
              where: { userId: input.userId, revokedAt: null },
              data: { revokedAt: ctx.now },
            });
          }
          await audit.record(t, {
            action: 'user.updateAccess',
            entityType: 'User',
            entityId: input.userId,
            before: {
              roles: before.roles.map((r) => r.role.code),
              divisionIds: before.divisionScopes.map((s) => s.divisionId),
              warehouseIds: before.warehouseScopes.map((s) => s.warehouseId),
              isActive: before.isActive,
            },
            after: {
              roles: input.roleCodes,
              divisionIds: input.divisionIds,
              warehouseIds: input.warehouseIds,
              isActive: input.isActive,
            },
          });
          return { ok: true };
        },
        input.requestId,
      ),
    ),

  listRoles: permissionProcedure('admin.roles').query(() =>
    prisma.role
      .findMany({ include: { permissions: { include: { permission: true } } }, orderBy: { code: 'asc' } })
      .then((rows) =>
        rows.map((r) => ({
          id: r.id,
          code: r.code,
          name: r.name,
          isSystem: r.isSystem,
          permissions: r.permissions.map((p) => p.permission.code),
        })),
      ),
  ),

  listPermissions: permissionProcedure('admin.roles').query(() =>
    prisma.permission.findMany({ orderBy: [{ module: 'asc' }, { code: 'asc' }] }),
  ),

  setRolePermissions: permissionProcedure('admin.roles')
    .input(z.object({ roleId: cuid, permissionCodes: z.array(z.string()), requestId }))
    .mutation(({ ctx, input }) =>
      tx(
        ctx,
        async (t) => {
          const role = await t.tx.role.findUniqueOrThrow({ where: { id: input.roleId } });
          if (role.code === 'admin')
            throw new AppError('VALIDATION', '관리자 역할의 권한은 변경할 수 없습니다.');
          const perms = await t.tx.permission.findMany({ where: { code: { in: input.permissionCodes } } });
          await t.tx.rolePermission.deleteMany({ where: { roleId: input.roleId } });
          await t.tx.rolePermission.createMany({
            data: perms.map((p) => ({ roleId: input.roleId, permissionId: p.id })),
          });
          await audit.record(t, {
            action: 'role.setPermissions',
            entityType: 'Role',
            entityId: role.id,
            after: { permissions: input.permissionCodes },
          });
          return { ok: true };
        },
        input.requestId,
      ),
    ),

  // ── audit log (BAS-08, INT-09) ──
  auditLog: permissionProcedure('admin.audit')
    .input(
      paging.extend({
        entityType: z.string().optional(),
        entityId: z.string().optional(),
        actorId: cuid.optional(),
        action: z.string().optional(),
        from: dateString.optional(),
        to: dateString.optional(),
      }),
    )
    .query(async ({ input }) => {
      const where = {
        ...(input.entityType ? { entityType: input.entityType } : {}),
        ...(input.entityId ? { entityId: input.entityId } : {}),
        ...(input.actorId ? { actorId: input.actorId } : {}),
        ...(input.action ? { action: { contains: input.action } } : {}),
        ...(input.from || input.to
          ? {
              createdAt: {
                ...(input.from ? { gte: new Date(`${input.from}T00:00:00Z`) } : {}),
                ...(input.to ? { lt: new Date(`${input.to}T23:59:59.999Z`) } : {}),
              },
            }
          : {}),
      };
      const [rows, total] = await Promise.all([
        prisma.auditLog.findMany({ where, orderBy: { createdAt: 'desc' }, ...skipTake(input) }),
        prisma.auditLog.count({ where }),
      ]);
      return { rows, total, page: input.page, pageSize: input.pageSize };
    }),

  securityEvents: permissionProcedure('admin.audit')
    .input(paging.extend({ type: z.string().optional() }))
    .query(async ({ input }) => {
      const where = input.type ? { type: input.type } : {};
      const [rows, total] = await Promise.all([
        prisma.securityEvent.findMany({ where, orderBy: { createdAt: 'desc' }, ...skipTake(input) }),
        prisma.securityEvent.count({ where }),
      ]);
      return { rows, total, page: input.page, pageSize: input.pageSize };
    }),

  // ── failed jobs (NFR-OPS-05, INT-10) ──
  outboxEvents: permissionProcedure('admin.jobs')
    .input(paging.extend({ status: z.enum(['PENDING', 'PROCESSING', 'DONE', 'FAILED']).optional() }))
    .query(async ({ input }) => {
      const where = input.status ? { status: input.status } : {};
      const [rows, total] = await Promise.all([
        prisma.outboxEvent.findMany({ where, orderBy: { createdAt: 'desc' }, ...skipTake(input) }),
        prisma.outboxEvent.count({ where }),
      ]);
      return { rows, total, page: input.page, pageSize: input.pageSize };
    }),

  retryOutbox: permissionProcedure('admin.jobs')
    .input(z.object({ ids: z.array(cuid).min(1).max(100), requestId }))
    .mutation(({ ctx, input }) =>
      tx(
        ctx,
        async (t) => {
          const res = await t.tx.outboxEvent.updateMany({
            where: { id: { in: input.ids }, status: 'FAILED' },
            data: {
              status: 'PENDING',
              attempt: 0,
              nextAttemptAt: ctx.now,
              lastError: null,
              lockedBy: null,
              lockedAt: null,
            },
          });
          await audit.record(t, {
            action: 'outbox.retry',
            entityType: 'OutboxEvent',
            entityId: input.ids.join(','),
            meta: { count: res.count },
          });
          return { retried: res.count };
        },
        input.requestId,
      ),
    ),

  // ── policies (DEC-01~09) ──
  listPolicies: permissionProcedure('admin.settings')
    .input(z.object({ key: z.string().optional() }))
    .query(({ input }) =>
      prisma.policyVersion.findMany({
        where: input.key ? { policyKey: input.key } : {},
        orderBy: [{ policyKey: 'asc' }, { version: 'desc' }],
      }),
    ),

  publishPolicy: permissionProcedure('admin.settings')
    .input(
      z.object({
        key: z.enum([
          'inventory.valuation',
          'money',
          'approval.matrix',
          'accounting.period',
          'leave',
          'retention',
          'notification',
        ]),
        effectiveFrom: dateString,
        config: z.record(z.string(), z.unknown()),
        note: z.string().max(500).optional(),
        requestId,
      }),
    )
    .mutation(({ ctx, input }) =>
      tx(
        ctx,
        async (t) => {
          const published = await policy.publish(t, {
            key: input.key as policy.PolicyKey,
            effectiveFrom: input.effectiveFrom,
            config: input.config,
            ...(input.note ? { note: input.note } : {}),
          });
          await audit.record(t, {
            action: 'policy.publish',
            entityType: 'PolicyVersion',
            entityId: published.id,
            after: { key: input.key, version: published.version, effectiveFrom: input.effectiveFrom },
          });
          return published;
        },
        input.requestId,
      ),
    ),

  systemHealth: permissionProcedure('admin.jobs').query(({ ctx }) =>
    readTx(ctx, async (t) => {
      const [pending, failed, oldestPending] = await Promise.all([
        t.tx.outboxEvent.count({ where: { status: 'PENDING' } }),
        t.tx.outboxEvent.count({ where: { status: 'FAILED' } }),
        t.tx.outboxEvent.findFirst({
          where: { status: 'PENDING' },
          orderBy: { createdAt: 'asc' },
          select: { createdAt: true },
        }),
      ]);
      return {
        outbox: {
          pending,
          failed,
          oldestPendingAt: oldestPending?.createdAt ?? null,
          nextBackoffMs: nextBackoff(0),
        },
      };
    }),
  ),
  // ── NFR-SEC-05 / DEC-06: personal-data retention ──
  /**
   * Two phases with a person in between, deliberately. `plan` only counts and records what
   * would be destroyed; `execute` destroys it and cannot be undone. Wiring them to one
   * button would make an irreversible action one click away from a mis-read number, so the
   * approval is a separate call by a named user and is written to the audit log.
   *
   * These existed as library code from STEP 12 with no router and no screen, so the whole
   * retention obligation was unreachable from the running system.
   */
  retentionRuns: permissionProcedure('admin.settings')
    .input(z.object({ take: z.number().int().min(1).max(100).default(20) }))
    .query(({ input }) => prisma.retentionRun.findMany({ orderBy: { createdAt: 'desc' }, take: input.take })),

  planRetention: permissionProcedure('admin.settings')
    .input(z.object({ requestId }))
    .mutation(({ ctx, input }) => tx(ctx, (t) => retention.plan(t), input.requestId)),

  approveRetention: permissionProcedure('admin.settings')
    .input(z.object({ runId: cuid, requestId }))
    .mutation(({ ctx, input }) => tx(ctx, (t) => retention.approve(t, input.runId), input.requestId)),

  executeRetention: permissionProcedure('admin.settings')
    .input(z.object({ runId: cuid, requestId }))
    .mutation(({ ctx, input }) => tx(ctx, (t) => retention.execute(t, input.runId), input.requestId)),
});
