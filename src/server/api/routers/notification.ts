import { z } from 'zod';
import { authedProcedure, readTx, router, tx } from '@/server/api/trpc';
import { prisma } from '@/server/db';
import * as notification from '@/server/modules/notification/service';
import { cuid, paging, skipTake } from '@/server/api/schemas/common';

export const notificationRouter = router({
  list: authedProcedure
    .input(paging.extend({ unreadOnly: z.boolean().default(false) }))
    .query(async ({ ctx, input }) => {
      const where = { userId: ctx.actor!.userId, ...(input.unreadOnly ? { readAt: null } : {}) };
      const [rows, total] = await Promise.all([
        prisma.notification.findMany({ where, orderBy: { createdAt: 'desc' }, ...skipTake(input) }),
        prisma.notification.count({ where }),
      ]);
      return { rows, total, page: input.page, pageSize: input.pageSize };
    }),

  unreadCount: authedProcedure.query(({ ctx }) =>
    prisma.notification.count({ where: { userId: ctx.actor!.userId, readAt: null } }),
  ),

  markRead: authedProcedure
    .input(z.object({ ids: z.array(cuid).min(1).max(200) }))
    .mutation(({ ctx, input }) =>
      tx(ctx, async (t) => ({ updated: await notification.markRead(t, input.ids) })),
    ),

  markAllRead: authedProcedure.mutation(({ ctx }) =>
    readTx(ctx, async (t) => {
      const res = await t.tx.notification.updateMany({
        where: { userId: ctx.actor!.userId, readAt: null },
        data: { readAt: ctx.now },
      });
      return { updated: res.count };
    }),
  ),
});
