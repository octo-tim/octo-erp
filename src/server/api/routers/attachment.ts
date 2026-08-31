import { z } from 'zod';
import { authedProcedure, router, tx } from '@/server/api/trpc';
import * as attachment from '@/server/modules/storage/attachment';
import { cuid, requestId } from '@/server/api/schemas/common';

const ownerType = z.enum([
  'ITEM',
  'PARTNER',
  'SALES_DOC',
  'PURCHASE_DOC',
  'STOCK_DOC',
  'JOURNAL',
  'APPROVAL_DOC',
  'EMPLOYEE_DOC',
  'MIGRATION',
]);

export const attachmentRouter = router({
  list: authedProcedure
    .input(z.object({ ownerType, ownerId: cuid }))
    .query(({ ctx, input }) => tx(ctx, (t) => attachment.list(t, input.ownerType, input.ownerId))),

  upload: authedProcedure
    .input(
      z.object({
        ownerType,
        ownerId: cuid,
        originalName: z.string().min(1).max(255),
        mimeType: z.string().min(1).max(150),
        /** base64 payload; the HTTP body limit keeps this within MAX_FILE_BYTES */
        contentBase64: z.string().min(1),
        requestId,
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const body = Buffer.from(input.contentBase64, 'base64');
      const file = {
        ownerType: input.ownerType,
        ownerId: input.ownerId,
        originalName: input.originalName,
        mimeType: input.mimeType,
        body,
      };

      /**
       * The bytes are written before the transaction opens, so a slow upload does not hold
       * a database connection, and the row lands inside the transaction with everything
       * else the request wrote. If the transaction fails the staged object is removed —
       * without that, a rolled-back upload left a file nothing referenced and nothing
       * collected.
       */
      const staged = await attachment.stageUpload({ actor: ctx.actor!, now: ctx.now }, file);
      try {
        const created = await tx(ctx, (t) => attachment.upload(t, file, staged), input.requestId);
        return { id: created.id, originalName: created.originalName, size: created.size };
      } catch (e) {
        await attachment.discardStaged(staged);
        throw e;
      }
    }),

  downloadUrl: authedProcedure
    .input(z.object({ attachmentId: cuid }))
    .mutation(({ ctx, input }) => tx(ctx, (t) => attachment.downloadUrl(t, input.attachmentId))),

  remove: authedProcedure.input(z.object({ attachmentId: cuid, requestId })).mutation(({ ctx, input }) =>
    tx(
      ctx,
      async (t) => {
        await attachment.softDelete(t, input.attachmentId);
        return { ok: true };
      },
      input.requestId,
    ),
  ),
});
