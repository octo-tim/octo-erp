import { z } from 'zod';
import { permissionProcedure, readTx, router, tx } from '@/server/api/trpc';
import * as migration from '@/server/modules/migration/service';
import { MIGRATION_TARGETS } from '@/server/modules/migration/templates';
import { cuid, dateString, requestId } from '@/server/api/schemas/common';

/**
 * MIG-01..09. Validation and application are separate calls on purpose: the figures have to
 * be agreed before anything is written, and the approval that happens between the two is a
 * person reading the preview, not a flag in a payload.
 */
const target = z.enum(MIGRATION_TARGETS);
const rows = z.array(z.record(z.string(), z.string())).max(20_000);

export const migrationRouter = router({
  template: permissionProcedure('admin.migration')
    .input(z.object({ target }))
    .query(({ ctx, input }) => readTx(ctx, (t) => migration.template(t, input.target))),

  batches: permissionProcedure('admin.migration')
    .input(z.object({ target: target.optional(), take: z.number().int().min(1).max(200).default(50) }))
    .query(({ ctx, input }) => readTx(ctx, (t) => migration.listBatches(t, input.target, input.take))),

  validate: permissionProcedure('admin.migration')
    .input(
      z.object({
        target,
        rows,
        fileName: z.string().max(200).optional(),
        baselineDate: dateString.optional(),
        templateVersion: z.number().int().optional(),
        note: z.string().max(500).optional(),
        requestId,
      }),
    )
    .mutation(({ ctx, input }) =>
      tx(
        ctx,
        (t) => {
          const { requestId: _rid, ...data } = input;
          return migration.validate(t, data);
        },
        input.requestId,
      ),
    ),

  // `apply` is a reserved procedure name in a tRPC router (Function.prototype.apply)
  applyBatch: permissionProcedure('admin.migration')
    .input(
      z.object({
        batchId: cuid,
        rows,
        selectedRows: z.array(z.number().int().min(1)).optional(),
        requestId,
      }),
    )
    .mutation(({ ctx, input }) =>
      tx(
        ctx,
        (t) =>
          migration.apply(t, {
            batchId: input.batchId,
            rows: input.rows,
            ...(input.selectedRows ? { selectedRows: input.selectedRows } : {}),
          }),
        input.requestId,
      ),
    ),

  reconcile: permissionProcedure('admin.migration')
    .input(z.object({ batchId: cuid }))
    .query(({ ctx, input }) => readTx(ctx, (t) => migration.reconcile(t, input.batchId))),
});
