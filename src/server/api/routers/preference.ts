import { z } from 'zod';
import { authedProcedure, router } from '@/server/api/trpc';
import { prisma } from '@/server/db';

/** UIX-01/UIX-02: per-user grid columns, saved search filters, dashboard layout. */
const kind = z.enum(['GRID_COLUMNS', 'SEARCH_FILTER', 'DASHBOARD']);

export const preferenceRouter = router({
  get: authedProcedure
    .input(z.object({ kind, key: z.string().min(1).max(100) }))
    .query(async ({ ctx, input }) => {
      const row = await prisma.userPreference.findUnique({
        where: { userId_kind_key: { userId: ctx.actor!.userId, kind: input.kind, key: input.key } },
      });
      return row?.value ?? null;
    }),

  list: authedProcedure.input(z.object({ kind })).query(({ ctx, input }) =>
    prisma.userPreference.findMany({
      where: { userId: ctx.actor!.userId, kind: input.kind },
      orderBy: { key: 'asc' },
    }),
  ),

  set: authedProcedure
    .input(z.object({ kind, key: z.string().min(1).max(100), value: z.unknown() }))
    .mutation(async ({ ctx, input }) => {
      await prisma.userPreference.upsert({
        where: { userId_kind_key: { userId: ctx.actor!.userId, kind: input.kind, key: input.key } },
        create: { userId: ctx.actor!.userId, kind: input.kind, key: input.key, value: input.value as never },
        update: { value: input.value as never },
      });
      return { ok: true };
    }),

  remove: authedProcedure
    .input(z.object({ kind, key: z.string().min(1).max(100) }))
    .mutation(async ({ ctx, input }) => {
      await prisma.userPreference.deleteMany({
        where: { userId: ctx.actor!.userId, kind: input.kind, key: input.key },
      });
      return { ok: true };
    }),
});
