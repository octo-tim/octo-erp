import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { authedProcedure, permissionProcedure, publicProcedure, router, tx } from '@/server/api/trpc';
import { prisma } from '@/server/db';
import * as auth from '@/server/modules/auth/service';
import * as audit from '@/server/modules/audit/service';
import { AppError } from '@/server/core/errors';
import { cuid, requestId } from '@/server/api/schemas/common';

export const authRouter = router({
  me: publicProcedure.query(({ ctx }) =>
    ctx.actor
      ? {
          userId: ctx.actor.userId,
          username: ctx.actor.username,
          displayName: ctx.actor.displayName,
          employeeId: ctx.actor.employeeId,
          roles: ctx.actor.roles,
          permissions: [...ctx.actor.permissions],
          divisionIds: ctx.actor.divisionIds,
          warehouseIds: ctx.actor.warehouseIds,
          isAdmin: ctx.actor.isAdmin,
        }
      : null,
  ),

  changePassword: authedProcedure
    .input(z.object({ currentPassword: z.string().min(1), newPassword: z.string().min(10) }))
    .mutation(async ({ ctx, input }) => {
      await auth.changePassword(prisma, {
        userId: ctx.actor!.userId,
        currentPassword: input.currentPassword,
        newPassword: input.newPassword,
        now: ctx.now,
      });
      return { ok: true };
    }),

  unlockUser: permissionProcedure('admin.users')
    .input(z.object({ userId: cuid, requestId }))
    .mutation(({ ctx, input }) =>
      tx(
        ctx,
        async (t) => {
          await auth.unlockUser(t, input.userId);
          await audit.record(t, { action: 'user.unlock', entityType: 'User', entityId: input.userId });
          return { ok: true };
        },
        input.requestId,
      ),
    ),

  resetPassword: permissionProcedure('admin.users')
    .input(z.object({ userId: cuid, temporaryPassword: z.string().min(10), requestId }))
    .mutation(({ ctx, input }) =>
      tx(
        ctx,
        async (t) => {
          await auth.resetPasswordByAdmin(t, {
            userId: input.userId,
            temporaryPassword: input.temporaryPassword,
          });
          await audit.record(t, { action: 'user.resetPassword', entityType: 'User', entityId: input.userId });
          return { ok: true };
        },
        input.requestId,
      ),
    ),

  revokeSessions: permissionProcedure('admin.users')
    .input(z.object({ userId: cuid }))
    .mutation(async ({ input }) => ({ revoked: await auth.revokeAllSessions(prisma, input.userId) })),

  sessions: authedProcedure.query(({ ctx }) =>
    prisma.session.findMany({
      where: { userId: ctx.actor!.userId, revokedAt: null, expiresAt: { gt: ctx.now } },
      select: { id: true, createdAt: true, lastSeenAt: true, expiresAt: true, ip: true, userAgent: true },
      orderBy: { lastSeenAt: 'desc' },
    }),
  ),
});

export function toTrpcError(e: unknown): never {
  if (e instanceof AppError) {
    const code =
      e.code === 'UNAUTHENTICATED'
        ? 'UNAUTHORIZED'
        : e.code === 'FORBIDDEN' || e.code === 'OUT_OF_SCOPE'
          ? 'FORBIDDEN'
          : 'BAD_REQUEST';
    throw new TRPCError({ code, message: e.message, cause: e });
  }
  throw e;
}
