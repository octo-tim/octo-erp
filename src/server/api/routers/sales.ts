import { z } from 'zod';
import { permissionProcedure, readTx, router, tx } from '@/server/api/trpc';
import * as quotation from '@/server/modules/sales/quotation';
import * as salesOrder from '@/server/modules/sales/sales-order';
import * as salesDocument from '@/server/modules/sales/sales-document';
import * as purchase from '@/server/modules/sales/purchase';
import * as documents from '@/server/modules/documents/service';
import * as documentSubmit from '@/server/modules/documents/submit';
import * as receivable from '@/server/modules/sales/receivable';
import * as settlement from '@/server/modules/sales/settlement';
import * as taxInvoice from '@/server/modules/sales/tax-invoice';
import {
  amountString,
  cuid,
  dateString,
  paging,
  quantityString,
  requestId,
  searchText,
  skipTake,
  unitPriceString,
} from '@/server/api/schemas/common';

const taxType = z.enum(['TAXABLE', 'ZERO', 'EXEMPT']);

const lineInput = z.object({
  itemId: cuid,
  description: z.string().max(200).optional(),
  quantity: quantityString,
  unitPrice: unitPriceString,
  taxType: taxType.optional(),
  sourceLineId: cuid.optional(),
  originalLineId: cuid.optional(),
  suggestedSupplierId: cuid.optional(),
});

const convertLine = z.object({
  sourceLineId: cuid,
  quantity: quantityString,
  unitPrice: unitPriceString.optional(),
});

const dateRange = {
  from: dateString.optional(),
  to: dateString.optional(),
};

export const salesRouter = router({
  // ── SLS-01 quotations ──

  quotations: permissionProcedure('sales.read')
    .input(
      paging.extend({
        status: z.string().optional(),
        partnerId: cuid.optional(),
        q: searchText,
        ...dateRange,
      }),
    )
    .query(({ ctx, input }) =>
      readTx(ctx, async (t) => {
        const { rows, total } = await quotation.list(t, { ...input, ...skipTake(input) });
        return { rows, total, page: input.page, pageSize: input.pageSize };
      }),
    ),

  quotation: permissionProcedure('sales.read')
    .input(z.object({ id: cuid }))
    .query(({ ctx, input }) => readTx(ctx, (t) => quotation.detail(t, input.id))),

  createQuotation: permissionProcedure('sales.write')
    .input(
      z.object({
        docDate: dateString.optional(),
        validUntil: dateString.optional(),
        partnerId: cuid,
        divisionId: cuid.optional(),
        title: z.string().max(200).optional(),
        note: z.string().max(1000).optional(),
        lines: z.array(lineInput).min(1).max(300),
        requestId,
      }),
    )
    .mutation(({ ctx, input }) =>
      tx(
        ctx,
        (t) => {
          const { requestId: _rid, ...data } = input;
          return quotation.create(t, data);
        },
        input.requestId,
      ),
    ),

  updateQuotation: permissionProcedure('sales.write')
    .input(
      z.object({
        id: cuid,
        version: z.number().int(),
        docDate: dateString.optional(),
        validUntil: dateString.optional(),
        partnerId: cuid,
        divisionId: cuid.optional(),
        title: z.string().max(200).optional(),
        note: z.string().max(1000).optional(),
        lines: z.array(lineInput).min(1).max(300),
        requestId,
      }),
    )
    .mutation(({ ctx, input }) =>
      tx(
        ctx,
        (t) => {
          const { id, version, requestId: _rid, ...data } = input;
          return quotation.update(t, id, data, version);
        },
        input.requestId,
      ),
    ),

  copyQuotation: permissionProcedure('sales.write')
    .input(z.object({ id: cuid, requestId }))
    .mutation(({ ctx, input }) => tx(ctx, (t) => quotation.copy(t, input.id), input.requestId)),

  setQuotationStatus: permissionProcedure('sales.write')
    .input(z.object({ id: cuid, status: z.string().max(20), version: z.number().int(), requestId }))
    .mutation(({ ctx, input }) =>
      tx(ctx, (t) => quotation.setStatus(t, input.id, input.status, input.version), input.requestId),
    ),

  // ── SLS-02/SLS-03 orders ──

  convertQuotationToOrder: permissionProcedure('sales.write')
    .input(
      z.object({
        quotationId: cuid,
        lines: z.array(convertLine).min(1).max(300),
        deliveryDate: dateString.optional(),
        note: z.string().max(1000).optional(),
        requestId,
      }),
    )
    .mutation(({ ctx, input }) =>
      tx(
        ctx,
        (t) =>
          quotation.convertToOrder(t, input.quotationId, {
            lines: input.lines,
            ...(input.deliveryDate ? { deliveryDate: input.deliveryDate } : {}),
            ...(input.note ? { note: input.note } : {}),
          }),
        input.requestId,
      ),
    ),

  salesOrders: permissionProcedure('sales.read')
    .input(
      paging.extend({
        status: z.string().optional(),
        partnerId: cuid.optional(),
        q: searchText,
        ...dateRange,
      }),
    )
    .query(({ ctx, input }) =>
      readTx(ctx, async (t) => {
        const { rows, total } = await salesOrder.list(t, { ...input, ...skipTake(input) });
        return { rows, total, page: input.page, pageSize: input.pageSize };
      }),
    ),

  salesOrder: permissionProcedure('sales.read')
    .input(z.object({ id: cuid }))
    .query(({ ctx, input }) => readTx(ctx, (t) => salesOrder.detail(t, input.id))),

  createSalesOrder: permissionProcedure('sales.write')
    .input(
      z.object({
        docDate: dateString.optional(),
        deliveryDate: dateString.optional(),
        partnerId: cuid,
        divisionId: cuid.optional(),
        note: z.string().max(1000).optional(),
        lines: z.array(lineInput).min(1).max(300),
        requestId,
      }),
    )
    .mutation(({ ctx, input }) =>
      tx(
        ctx,
        (t) => {
          const { requestId: _rid, ...data } = input;
          return salesOrder.create(t, data);
        },
        input.requestId,
      ),
    ),

  cancelSalesOrder: permissionProcedure('sales.write')
    .input(z.object({ id: cuid, reason: z.string().min(2).max(200), version: z.number().int(), requestId }))
    .mutation(({ ctx, input }) =>
      tx(ctx, (t) => salesOrder.cancel(t, input.id, input.reason, input.version), input.requestId),
    ),

  // ── SLS-05/SLS-11 sales documents ──

  salesDocuments: permissionProcedure('sales.read')
    .input(
      paging.extend({
        docType: z.enum(['SALES', 'RETURN_SALES']).optional(),
        status: z.string().optional(),
        partnerId: cuid.optional(),
        q: searchText,
        ...dateRange,
      }),
    )
    .query(({ ctx, input }) =>
      readTx(ctx, async (t) => {
        const { rows, total } = await salesDocument.list(t, { ...input, ...skipTake(input) });
        return { rows, total, page: input.page, pageSize: input.pageSize };
      }),
    ),

  salesDocument: permissionProcedure('sales.read')
    .input(z.object({ id: cuid }))
    .query(({ ctx, input }) => readTx(ctx, (t) => salesDocument.detail(t, input.id))),

  createSalesDocument: permissionProcedure('sales.write')
    .input(
      z.object({
        docType: z.enum(['SALES', 'RETURN_SALES']).optional(),
        docDate: dateString.optional(),
        partnerId: cuid,
        warehouseId: cuid,
        divisionId: cuid.optional(),
        note: z.string().max(1000).optional(),
        originalId: cuid.optional(),
        lines: z.array(lineInput).min(1).max(300),
        requestId,
      }),
    )
    .mutation(({ ctx, input }) =>
      tx(
        ctx,
        (t) => {
          const { requestId: _rid, ...data } = input;
          return salesDocument.create(t, data);
        },
        input.requestId,
      ),
    ),

  updateSalesDocument: permissionProcedure('sales.write')
    .input(
      z.object({
        id: cuid,
        version: z.number().int(),
        docDate: dateString.optional(),
        partnerId: cuid,
        warehouseId: cuid,
        divisionId: cuid.optional(),
        note: z.string().max(1000).optional(),
        lines: z.array(lineInput).min(1).max(300),
        requestId,
      }),
    )
    .mutation(({ ctx, input }) =>
      tx(
        ctx,
        (t) => {
          const { id, version, requestId: _rid, ...data } = input;
          return salesDocument.update(t, id, data, version);
        },
        input.requestId,
      ),
    ),

  confirmSalesDocument: permissionProcedure('sales.confirm')
    .input(z.object({ id: cuid, version: z.number().int(), requestId }))
    .mutation(({ ctx, input }) =>
      tx(
        ctx,
        (t) => documents.confirmBusinessDocument(t, { type: 'SALES_DOCUMENT', ...input }),
        input.requestId,
      ),
    ),

  cancelSalesDocument: permissionProcedure('sales.cancel')
    .input(z.object({ id: cuid, reason: z.string().min(2).max(200), version: z.number().int(), requestId }))
    .mutation(({ ctx, input }) =>
      tx(
        ctx,
        (t) => documents.cancelBusinessDocument(t, { type: 'SALES_DOCUMENT', ...input }),
        input.requestId,
      ),
    ),

  // ── APV-08: putting a business document into approval ──

  submitSalesDocumentForApproval: permissionProcedure('sales.write')
    .input(
      z.object({
        id: cuid,
        version: z.number().int(),
        note: z.string().max(500).optional(),
        lineTemplateId: cuid.optional(),
        requestId,
      }),
    )
    .mutation(({ ctx, input }) =>
      tx(
        ctx,
        (t) => documentSubmit.submitForApproval(t, { type: 'SALES_DOCUMENT', ...input }),
        input.requestId,
      ),
    ),

  submitSalesDocumentCancellation: permissionProcedure('sales.cancel')
    .input(z.object({ id: cuid, reason: z.string().min(2).max(200), requestId }))
    .mutation(({ ctx, input }) =>
      tx(
        ctx,
        (t) => documentSubmit.submitCancellation(t, { type: 'SALES_DOCUMENT', ...input }),
        input.requestId,
      ),
    ),

  submitPurchaseDocumentForApproval: permissionProcedure('purchase.write')
    .input(
      z.object({
        id: cuid,
        version: z.number().int(),
        note: z.string().max(500).optional(),
        lineTemplateId: cuid.optional(),
        requestId,
      }),
    )
    .mutation(({ ctx, input }) =>
      tx(
        ctx,
        (t) => documentSubmit.submitForApproval(t, { type: 'PURCHASE_DOCUMENT', ...input }),
        input.requestId,
      ),
    ),

  submitPurchaseDocumentCancellation: permissionProcedure('purchase.cancel')
    .input(z.object({ id: cuid, reason: z.string().min(2).max(200), requestId }))
    .mutation(({ ctx, input }) =>
      tx(
        ctx,
        (t) => documentSubmit.submitCancellation(t, { type: 'PURCHASE_DOCUMENT', ...input }),
        input.requestId,
      ),
    ),

  // ── SLS-07 tax invoice ──

  taxInvoice: permissionProcedure('sales.read')
    .input(z.object({ documentId: cuid }))
    .query(({ ctx, input }) =>
      readTx(ctx, async (t) => {
        const data = await taxInvoice.build(t, input.documentId);
        return { data, html: taxInvoice.render(data) };
      }),
    ),

  issueTaxInvoice: permissionProcedure('sales.write')
    .input(
      z.object({
        documentId: cuid,
        email: z.string().email().optional(),
        send: z.boolean().default(false),
        requestId,
      }),
    )
    .mutation(({ ctx, input }) =>
      tx(
        ctx,
        (t) =>
          taxInvoice.issue(t, input.documentId, {
            ...(input.email ? { email: input.email } : {}),
            send: input.send,
          }),
        input.requestId,
      ),
    ),

  taxInvoiceHistory: permissionProcedure('sales.read')
    .input(z.object({ documentId: cuid }))
    .query(({ ctx, input }) => readTx(ctx, (t) => taxInvoice.history(t, input.documentId))),

  // ── SLS-13 purchase requests and orders ──

  purchaseRequests: permissionProcedure('purchase.read')
    .input(paging.extend({ status: z.string().optional(), q: searchText, ...dateRange }))
    .query(({ ctx, input }) =>
      readTx(ctx, async (t) => {
        const { rows, total } = await purchase.listRequests(t, { ...input, ...skipTake(input) });
        return { rows, total, page: input.page, pageSize: input.pageSize };
      }),
    ),

  purchaseRequest: permissionProcedure('purchase.read')
    .input(z.object({ id: cuid }))
    .query(({ ctx, input }) => readTx(ctx, (t) => purchase.requestDetail(t, input.id))),

  createPurchaseRequest: permissionProcedure('purchase.write')
    .input(
      z.object({
        docDate: dateString.optional(),
        requiredDate: dateString.optional(),
        divisionId: cuid.optional(),
        purpose: z.string().max(200).optional(),
        note: z.string().max(1000).optional(),
        lines: z.array(lineInput).min(1).max(300),
        requestId,
      }),
    )
    .mutation(({ ctx, input }) =>
      tx(
        ctx,
        (t) => {
          const { requestId: _rid, ...data } = input;
          return purchase.createRequest(t, data);
        },
        input.requestId,
      ),
    ),

  convertRequestToOrder: permissionProcedure('purchase.write')
    .input(
      z.object({
        requestId: cuid,
        partnerId: cuid,
        lines: z.array(convertLine).min(1).max(300),
        dueDate: dateString.optional(),
        note: z.string().max(1000).optional(),
        idempotencyKey: z.string().uuid(),
      }),
    )
    .mutation(({ ctx, input }) =>
      tx(
        ctx,
        (t) =>
          purchase.convertRequestToOrder(t, input.requestId, {
            partnerId: input.partnerId,
            lines: input.lines,
            ...(input.dueDate ? { dueDate: input.dueDate } : {}),
            ...(input.note ? { note: input.note } : {}),
          }),
        input.idempotencyKey,
      ),
    ),

  purchaseOrders: permissionProcedure('purchase.read')
    .input(
      paging.extend({
        status: z.string().optional(),
        partnerId: cuid.optional(),
        q: searchText,
        ...dateRange,
      }),
    )
    .query(({ ctx, input }) =>
      readTx(ctx, async (t) => {
        const { rows, total } = await purchase.listOrders(t, { ...input, ...skipTake(input) });
        return { rows, total, page: input.page, pageSize: input.pageSize };
      }),
    ),

  purchaseOrder: permissionProcedure('purchase.read')
    .input(z.object({ id: cuid }))
    .query(({ ctx, input }) => readTx(ctx, (t) => purchase.orderDetail(t, input.id))),

  // ── SLS-06 purchase documents ──

  purchaseDocuments: permissionProcedure('purchase.read')
    .input(
      paging.extend({
        docType: z.enum(['PURCHASE', 'RETURN_PURCHASE']).optional(),
        status: z.string().optional(),
        partnerId: cuid.optional(),
        q: searchText,
        ...dateRange,
      }),
    )
    .query(({ ctx, input }) =>
      readTx(ctx, async (t) => {
        const { rows, total } = await purchase.listDocuments(t, { ...input, ...skipTake(input) });
        return { rows, total, page: input.page, pageSize: input.pageSize };
      }),
    ),

  purchaseDocument: permissionProcedure('purchase.read')
    .input(z.object({ id: cuid }))
    .query(({ ctx, input }) => readTx(ctx, (t) => purchase.documentDetail(t, input.id))),

  createPurchaseDocument: permissionProcedure('purchase.write')
    .input(
      z.object({
        docType: z.enum(['PURCHASE', 'RETURN_PURCHASE']).optional(),
        docDate: dateString.optional(),
        partnerId: cuid,
        warehouseId: cuid,
        divisionId: cuid.optional(),
        note: z.string().max(1000).optional(),
        originalId: cuid.optional(),
        lines: z.array(lineInput).min(1).max(300),
        requestId,
      }),
    )
    .mutation(({ ctx, input }) =>
      tx(
        ctx,
        (t) => {
          const { requestId: _rid, ...data } = input;
          return purchase.createDocument(t, data);
        },
        input.requestId,
      ),
    ),

  confirmPurchaseDocument: permissionProcedure('purchase.confirm')
    .input(z.object({ id: cuid, version: z.number().int(), requestId }))
    .mutation(({ ctx, input }) =>
      tx(
        ctx,
        (t) => documents.confirmBusinessDocument(t, { type: 'PURCHASE_DOCUMENT', ...input }),
        input.requestId,
      ),
    ),

  cancelPurchaseDocument: permissionProcedure('purchase.cancel')
    .input(z.object({ id: cuid, reason: z.string().min(2).max(200), version: z.number().int(), requestId }))
    .mutation(({ ctx, input }) =>
      tx(
        ctx,
        (t) => documents.cancelBusinessDocument(t, { type: 'PURCHASE_DOCUMENT', ...input }),
        input.requestId,
      ),
    ),

  // ── SLS-08/SLS-09 receivables and payables ──

  aging: permissionProcedure('settlement.read')
    .input(z.object({ asOf: dateString.optional(), partnerId: cuid.optional() }))
    .query(({ ctx, input }) => readTx(ctx, (t) => receivable.aging(t, input))),

  payableSummary: permissionProcedure('settlement.read')
    .input(z.object({ partnerId: cuid.optional() }))
    .query(({ ctx, input }) => readTx(ctx, (t) => receivable.payableSummary(t, input))),

  openItems: permissionProcedure('settlement.read')
    .input(z.object({ partnerId: cuid, kind: z.enum(['RECEIVABLE', 'PAYABLE']) }))
    .query(({ ctx, input }) => readTx(ctx, (t) => receivable.openItems(t, input.partnerId, input.kind))),

  // ── SLS-10 receipts and payments ──

  settlements: permissionProcedure('settlement.read')
    .input(
      paging.extend({
        docType: z.enum(['RECEIPT', 'PAYMENT']).optional(),
        status: z.string().optional(),
        partnerId: cuid.optional(),
        ...dateRange,
      }),
    )
    .query(({ ctx, input }) =>
      readTx(ctx, async (t) => {
        const { rows, total } = await settlement.list(t, { ...input, ...skipTake(input) });
        return { rows, total, page: input.page, pageSize: input.pageSize };
      }),
    ),

  settlement: permissionProcedure('settlement.read')
    .input(z.object({ id: cuid }))
    .query(({ ctx, input }) => readTx(ctx, (t) => settlement.detail(t, input.id))),

  createSettlement: permissionProcedure('settlement.write')
    .input(
      z.object({
        docType: z.enum(['RECEIPT', 'PAYMENT']),
        docDate: dateString.optional(),
        partnerId: cuid,
        amount: amountString,
        method: z.string().max(30).optional(),
        bankAccount: z.string().max(60).optional(),
        note: z.string().max(500).optional(),
        requestId,
      }),
    )
    .mutation(({ ctx, input }) =>
      tx(
        ctx,
        (t) => {
          const { requestId: _rid, ...data } = input;
          return settlement.create(t, data);
        },
        input.requestId,
      ),
    ),

  autoAllocate: permissionProcedure('settlement.write')
    .input(z.object({ id: cuid, requestId }))
    .mutation(({ ctx, input }) => tx(ctx, (t) => settlement.autoAllocate(t, input.id), input.requestId)),

  reallocate: permissionProcedure('settlement.write')
    .input(
      z.object({
        id: cuid,
        reason: z.string().min(2).max(200),
        allocations: z
          .array(z.object({ targetId: cuid, amount: amountString, note: z.string().max(200).optional() }))
          .min(1)
          .max(200),
        requestId,
      }),
    )
    .mutation(({ ctx, input }) =>
      tx(ctx, (t) => settlement.reallocate(t, input.id, input.allocations, input.reason), input.requestId),
    ),

  confirmSettlement: permissionProcedure('settlement.confirm')
    .input(z.object({ id: cuid, version: z.number().int(), requestId }))
    .mutation(({ ctx, input }) =>
      tx(ctx, (t) => settlement.confirm(t, input.id, input.version), input.requestId),
    ),

  cancelSettlement: permissionProcedure('settlement.confirm')
    .input(z.object({ id: cuid, reason: z.string().min(2).max(200), version: z.number().int(), requestId }))
    .mutation(({ ctx, input }) =>
      tx(ctx, (t) => settlement.cancel(t, input.id, input.reason, input.version), input.requestId),
    ),
});
