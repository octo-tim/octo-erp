import { z } from 'zod';
import { permissionProcedure, readTx, router, tx } from '@/server/api/trpc';
import * as stockDocument from '@/server/modules/inventory/stock-document';
import * as stockCount from '@/server/modules/inventory/stock-count';
import * as report from '@/server/modules/inventory/stock-report';
import * as safetyStock from '@/server/modules/inventory/safety-stock';
import * as valuation from '@/server/modules/inventory/valuation';
import * as ledger from '@/server/modules/inventory/ledger';
import {
  cuid,
  dateString,
  paging,
  periodString,
  quantityString,
  requestId,
  searchText,
  skipTake,
  unitPriceString,
} from '@/server/api/schemas/common';

const docType = z.enum(['RECEIPT', 'ISSUE', 'TRANSFER', 'ADJUST']);

/** an adjustment line may be negative (a shortfall), so its quantity is signed */
const signedQuantity = z
  .string()
  .trim()
  .regex(/^-?\d+(\.\d{1,3})?$/, '수량 형식이 올바르지 않습니다.');

const lineInput = z.object({
  itemId: cuid,
  quantity: signedQuantity,
  unitCost: unitPriceString.optional(),
  note: z.string().max(200).optional(),
});

const documentInput = z.object({
  docType,
  docDate: dateString.optional(),
  fromWarehouseId: cuid.optional(),
  toWarehouseId: cuid.optional(),
  partnerId: cuid.optional(),
  reasonCode: z.string().max(30).optional(),
  divisionId: cuid.optional(),
  note: z.string().max(500).optional(),
  lines: z.array(lineInput).min(1).max(500),
});

export const inventoryRouter = router({
  // ── documents (INV-01/02/03) ──

  documents: permissionProcedure('inventory.read')
    .input(
      paging.extend({
        docType: docType.optional(),
        status: z.string().optional(),
        warehouseId: cuid.optional(),
        itemId: cuid.optional(),
        from: dateString.optional(),
        to: dateString.optional(),
        q: searchText,
      }),
    )
    .query(({ ctx, input }) =>
      readTx(ctx, async (t) => {
        const { rows, total } = await stockDocument.list(t, { ...input, ...skipTake(input) });
        return { rows, total, page: input.page, pageSize: input.pageSize };
      }),
    ),

  document: permissionProcedure('inventory.read')
    .input(z.object({ id: cuid }))
    .query(({ ctx, input }) => readTx(ctx, (t) => stockDocument.detail(t, input.id))),

  createDocument: permissionProcedure('inventory.write')
    .input(documentInput.extend({ requestId }))
    .mutation(({ ctx, input }) =>
      tx(
        ctx,
        (t) => {
          const { requestId: _rid, ...data } = input;
          return stockDocument.create(t, data);
        },
        input.requestId,
      ),
    ),

  updateDocument: permissionProcedure('inventory.write')
    .input(documentInput.extend({ id: cuid, version: z.number().int(), requestId }))
    .mutation(({ ctx, input }) =>
      tx(
        ctx,
        (t) => {
          const { id, version, requestId: _rid, ...data } = input;
          return stockDocument.update(t, id, data, version);
        },
        input.requestId,
      ),
    ),

  confirmDocument: permissionProcedure('inventory.confirm')
    .input(z.object({ id: cuid, version: z.number().int(), requestId }))
    .mutation(({ ctx, input }) =>
      tx(ctx, (t) => stockDocument.confirm(t, input.id, input.version), input.requestId),
    ),

  cancelDocument: permissionProcedure('inventory.cancel')
    .input(z.object({ id: cuid, reason: z.string().min(2).max(200), version: z.number().int(), requestId }))
    .mutation(({ ctx, input }) =>
      tx(ctx, (t) => stockDocument.cancel(t, input.id, input.reason, input.version), input.requestId),
    ),

  shipTransfer: permissionProcedure('inventory.write')
    .input(z.object({ id: cuid, version: z.number().int(), requestId }))
    .mutation(({ ctx, input }) =>
      tx(ctx, (t) => stockDocument.ship(t, input.id, input.version), input.requestId),
    ),

  // ── stock on hand and the stock book (INV-04/05) ──

  onHand: permissionProcedure('inventory.read')
    .input(
      z.object({
        warehouseId: cuid.optional(),
        categoryId: cuid.optional(),
        q: searchText,
        hideZero: z.boolean().default(false),
        belowSafetyOnly: z.boolean().default(false),
      }),
    )
    .query(({ ctx, input }) => readTx(ctx, (t) => report.onHand(t, input))),

  book: permissionProcedure('inventory.read')
    .input(z.object({ itemId: cuid, from: dateString, to: dateString, warehouseId: cuid.optional() }))
    .query(({ ctx, input }) => readTx(ctx, (t) => report.book(t, input))),

  bookCsv: permissionProcedure('inventory.export')
    .input(z.object({ itemId: cuid, from: dateString, to: dateString, warehouseId: cuid.optional() }))
    .query(({ ctx, input }) =>
      readTx(ctx, async (t) => ({ csv: report.bookToCsv(await report.book(t, input)) })),
    ),

  // ── safety stock (INV-07) ──

  safetyStock: permissionProcedure('inventory.read').query(({ ctx }) =>
    readTx(ctx, (t) => safetyStock.list(t)),
  ),

  // ── physical count (INV-08) ──

  counts: permissionProcedure('inventory.read')
    .input(paging.extend({ warehouseId: cuid.optional(), status: z.string().optional() }))
    .query(({ ctx, input }) =>
      readTx(ctx, async (t) => {
        const { rows, total } = await stockCount.list(t, { ...input, ...skipTake(input) });
        return { rows, total, page: input.page, pageSize: input.pageSize };
      }),
    ),

  count: permissionProcedure('inventory.read')
    .input(z.object({ id: cuid }))
    .query(({ ctx, input }) => readTx(ctx, (t) => stockCount.detail(t, input.id))),

  createCount: permissionProcedure('inventory.count')
    .input(
      z.object({
        warehouseId: cuid,
        countDate: dateString.optional(),
        note: z.string().max(500).optional(),
        requestId,
      }),
    )
    .mutation(({ ctx, input }) =>
      tx(
        ctx,
        (t) => {
          const { requestId: _rid, ...data } = input;
          return stockCount.create(t, data);
        },
        input.requestId,
      ),
    ),

  startCount: permissionProcedure('inventory.count')
    .input(
      z.object({
        id: cuid,
        version: z.number().int(),
        itemIds: z.array(cuid).optional(),
        categoryId: cuid.optional(),
        requestId,
      }),
    )
    .mutation(({ ctx, input }) =>
      tx(
        ctx,
        (t) =>
          stockCount.start(
            t,
            input.id,
            { itemIds: input.itemIds, categoryId: input.categoryId },
            input.version,
          ),
        input.requestId,
      ),
    ),

  recordCount: permissionProcedure('inventory.count')
    .input(
      z.object({
        id: cuid,
        lines: z
          .array(
            z.object({ itemId: cuid, countedQty: quantityString, reason: z.string().max(200).optional() }),
          )
          .min(1)
          .max(500),
        requestId,
      }),
    )
    .mutation(({ ctx, input }) =>
      tx(ctx, (t) => stockCount.record(t, input.id, input.lines), input.requestId),
    ),

  approveCount: permissionProcedure('inventory.count')
    .input(z.object({ id: cuid, version: z.number().int(), requestId }))
    .mutation(({ ctx, input }) =>
      tx(ctx, (t) => stockCount.approve(t, input.id, input.version), input.requestId),
    ),

  cancelCount: permissionProcedure('inventory.count')
    .input(z.object({ id: cuid, reason: z.string().min(2).max(200), version: z.number().int(), requestId }))
    .mutation(({ ctx, input }) =>
      tx(ctx, (t) => stockCount.cancel(t, input.id, input.reason, input.version), input.requestId),
    ),

  // ── valuation (INV-09 / DEC-01) ──

  periods: permissionProcedure('inventory.read').query(({ ctx }) =>
    readTx(ctx, (t) => valuation.listPeriods(t)),
  ),

  closePreview: permissionProcedure('inventory.read')
    .input(z.object({ period: periodString }))
    .query(({ ctx, input }) => readTx(ctx, (t) => valuation.preview(t, input.period))),

  closePeriod: permissionProcedure('inventory.valuation')
    .input(z.object({ period: periodString, requestId }))
    .mutation(({ ctx, input }) => tx(ctx, (t) => valuation.close(t, input.period), input.requestId)),

  reopenPeriod: permissionProcedure('inventory.valuation')
    .input(z.object({ period: periodString, reason: z.string().min(5).max(200), requestId }))
    .mutation(({ ctx, input }) =>
      tx(ctx, (t) => valuation.reopen(t, input.period, input.reason), input.requestId),
    ),

  // ── ledger/cache integrity (INV-04, INT-04) ──

  reconcile: permissionProcedure('inventory.valuation').query(({ ctx }) =>
    readTx(ctx, (t) => ledger.reconcile(t)),
  ),

  rebuildSnapshot: permissionProcedure('inventory.valuation')
    .input(z.object({ requestId }))
    .mutation(({ ctx, input }) => tx(ctx, (t) => ledger.rebuild(t), input.requestId)),
});
