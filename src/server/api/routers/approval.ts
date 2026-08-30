import { z } from 'zod';
import { permissionProcedure, readTx, router, tx } from '@/server/api/trpc';
import * as approval from '@/server/modules/approval/service';
import * as form from '@/server/modules/approval/form';
import { registeredTargetTypes } from '@/server/modules/approval/handlers';
import { nextDocNo } from '@/server/modules/numbering/service';
import { amountString, cuid, dateString, paging, requestId, skipTake } from '@/server/api/schemas/common';

const targetInput = z.object({
  targetType: z.string().min(1).max(50),
  targetId: cuid,
  targetVersion: z.number().int().min(1),
});

export const approvalRouter = router({
  // ── APV-10 inboxes ──
  inbox: permissionProcedure('approval.use')
    .input(
      paging.extend({
        inbox: z.enum(['DRAFTED', 'PENDING', 'IN_PROGRESS', 'COMPLETED', 'REJECTED', 'REFERENCE']),
        q: z.string().trim().max(100).optional(),
        from: dateString.optional(),
        to: dateString.optional(),
      }),
    )
    .query(({ ctx, input }) =>
      readTx(ctx, async (t) => {
        const { rows, total } = await approval.listInbox(t, {
          inbox: input.inbox,
          ...(input.q ? { q: input.q } : {}),
          ...(input.from ? { from: input.from } : {}),
          ...(input.to ? { to: input.to } : {}),
          ...skipTake(input),
        });
        return { rows, total, page: input.page, pageSize: input.pageSize };
      }),
    ),

  pendingCount: permissionProcedure('approval.use').query(({ ctx }) =>
    readTx(ctx, (t) => approval.pendingCount(t)),
  ),

  detail: permissionProcedure('approval.use')
    .input(z.object({ documentId: cuid }))
    .query(({ ctx, input }) => readTx(ctx, (t) => approval.detail(t, input.documentId))),

  // ── APV-06 drafting ──
  forms: permissionProcedure('approval.use').query(({ ctx }) => readTx(ctx, (t) => form.listForms(t))),

  draft: permissionProcedure('approval.use')
    .input(
      z.object({
        formCode: z.string().min(1).max(50),
        title: z.string().min(1).max(200),
        content: z.record(z.string(), z.unknown()),
        amount: amountString.optional(),
        divisionId: cuid.optional(),
        departmentId: cuid.optional(),
        target: targetInput.optional(),
        requestId,
      }),
    )
    .mutation(({ ctx, input }) =>
      tx(
        ctx,
        async (t) => {
          const docNo = await nextDocNo(t, 'APPROVAL');
          const { requestId: _rid, ...data } = input;
          return approval.draft(t, { docNo, ...data });
        },
        input.requestId,
      ),
    ),

  submit: permissionProcedure('approval.use')
    .input(
      z.object({ documentId: cuid, version: z.number().int(), lineTemplateId: cuid.optional(), requestId }),
    )
    .mutation(({ ctx, input }) =>
      tx(
        ctx,
        (t) =>
          approval.submit(t, {
            documentId: input.documentId,
            version: input.version,
            ...(input.lineTemplateId ? { lineTemplateId: input.lineTemplateId } : {}),
          }),
        input.requestId,
      ),
    ),

  // ── APV-07 processing ──
  approve: permissionProcedure('approval.use')
    .input(
      z.object({
        documentId: cuid,
        version: z.number().int(),
        comment: z.string().max(500).optional(),
        requestId,
      }),
    )
    .mutation(({ ctx, input }) =>
      tx(
        ctx,
        (t) =>
          approval.approve(t, {
            documentId: input.documentId,
            version: input.version,
            ...(input.comment ? { comment: input.comment } : {}),
          }),
        input.requestId,
      ),
    ),

  reject: permissionProcedure('approval.use')
    .input(
      z.object({
        documentId: cuid,
        version: z.number().int(),
        comment: z.string().min(2).max(500),
        requestId,
      }),
    )
    .mutation(({ ctx, input }) => tx(ctx, (t) => approval.reject(t, input), input.requestId)),

  hold: permissionProcedure('approval.use')
    .input(
      z.object({
        documentId: cuid,
        version: z.number().int(),
        comment: z.string().min(2).max(500),
        requestId,
      }),
    )
    .mutation(({ ctx, input }) => tx(ctx, (t) => approval.hold(t, input), input.requestId)),

  releaseHold: permissionProcedure('approval.use')
    .input(z.object({ documentId: cuid, version: z.number().int(), requestId }))
    .mutation(({ ctx, input }) => tx(ctx, (t) => approval.releaseHold(t, input), input.requestId)),

  withdraw: permissionProcedure('approval.use')
    .input(
      z.object({
        documentId: cuid,
        version: z.number().int(),
        reason: z.string().max(200).optional(),
        requestId,
      }),
    )
    .mutation(({ ctx, input }) =>
      tx(
        ctx,
        (t) =>
          approval.withdraw(t, {
            documentId: input.documentId,
            version: input.version,
            ...(input.reason ? { reason: input.reason } : {}),
          }),
        input.requestId,
      ),
    ),

  resubmit: permissionProcedure('approval.use')
    .input(
      z.object({
        documentId: cuid,
        version: z.number().int(),
        title: z.string().max(200).optional(),
        content: z.record(z.string(), z.unknown()).optional(),
        amount: amountString.optional(),
        requestId,
      }),
    )
    .mutation(({ ctx, input }) =>
      tx(
        ctx,
        (t) =>
          approval.resubmit(t, {
            documentId: input.documentId,
            version: input.version,
            ...(input.title ? { title: input.title } : {}),
            ...(input.content ? { content: input.content } : {}),
            ...(input.amount !== undefined ? { amount: input.amount } : {}),
          }),
        input.requestId,
      ),
    ),

  // ── APV-12 cancellation ──
  requestCancel: permissionProcedure('approval.use')
    .input(z.object({ documentId: cuid, reason: z.string().min(2).max(200), requestId }))
    .mutation(({ ctx, input }) =>
      tx(
        ctx,
        async (t) => {
          const docNo = await nextDocNo(t, 'APPROVAL');
          return approval.requestCancel(t, { docNo, documentId: input.documentId, reason: input.reason });
        },
        input.requestId,
      ),
    ),

  // ── APV-01/03/04 administration ──
  listFormVersions: permissionProcedure('approval.admin')
    .input(z.object({ formCode: z.string().optional() }))
    .query(({ ctx, input }) => readTx(ctx, (t) => form.listFormVersions(t, input.formCode))),

  publishFormVersion: permissionProcedure('approval.admin')
    .input(
      z.object({
        formCode: z.string().min(1).max(50),
        fieldSchema: z.array(
          z.object({
            key: z.string().min(1).max(50),
            label: z.string().min(1).max(50),
            type: z.enum(['text', 'textarea', 'number', 'money', 'date', 'select', 'checkbox']),
            required: z.boolean().optional(),
            options: z.array(z.object({ value: z.string(), label: z.string() })).optional(),
            max: z.number().int().optional(),
          }),
        ),
        effectiveFrom: dateString,
        requestId,
      }),
    )
    .mutation(({ ctx, input }) =>
      tx(
        ctx,
        (t) =>
          form.publishFormVersion(t, {
            formCode: input.formCode,
            fieldSchema: input.fieldSchema,
            effectiveFrom: input.effectiveFrom,
          }),
        input.requestId,
      ),
    ),

  lineTemplates: permissionProcedure('approval.use').query(({ ctx }) =>
    readTx(ctx, (t) => form.listLineTemplates(t)),
  ),

  rules: permissionProcedure('approval.admin').query(({ ctx }) => readTx(ctx, (t) => form.listRules(t))),

  // ── APV-04 delegation ──
  listDelegations: permissionProcedure('approval.use').query(({ ctx }) =>
    readTx(ctx, (t) => form.listDelegations(t)),
  ),

  setDelegation: permissionProcedure('approval.use')
    .input(
      z.object({
        toUserId: cuid,
        validFrom: dateString,
        validTo: dateString,
        reason: z.string().max(200).optional(),
        requestId,
      }),
    )
    .mutation(({ ctx, input }) =>
      tx(
        ctx,
        (t) =>
          form.setDelegation(t, {
            toUserId: input.toUserId,
            validFrom: input.validFrom,
            validTo: input.validTo,
            ...(input.reason ? { reason: input.reason } : {}),
          }),
        input.requestId,
      ),
    ),

  endDelegation: permissionProcedure('approval.use')
    .input(z.object({ delegationId: cuid, requestId }))
    .mutation(({ ctx, input }) => tx(ctx, (t) => form.endDelegation(t, input.delegationId), input.requestId)),

  targetTypes: permissionProcedure('approval.admin').query(() => registeredTargetTypes()),
});
