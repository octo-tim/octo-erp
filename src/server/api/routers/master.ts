import { z } from 'zod';
import { permissionProcedure, readTx, router, tx } from '@/server/api/trpc';
import * as item from '@/server/modules/master/item';
import * as partner from '@/server/modules/master/partner';
import * as reference from '@/server/modules/master/reference';
import * as importer from '@/server/modules/master/import';
import {
  amountString,
  cuid,
  paging,
  quantityString,
  requestId,
  skipTake,
  unitPriceString,
} from '@/server/api/schemas/common';

const taxType = z.enum(['TAXABLE', 'ZERO', 'EXEMPT']);
const partnerType = z.enum(['CUSTOMER', 'SUPPLIER', 'BOTH']);
const warehouseType = z.enum(['NORMAL', 'DEFECT', 'CONSIGNED']);

const itemInput = z.object({
  code: z.string().max(30).optional(),
  name: z.string().min(1).max(100),
  spec: z.string().max(100).optional(),
  unitCode: z.string().max(20).optional(),
  categoryId: cuid.optional(),
  purchasePrice: unitPriceString.optional(),
  salesPrice: unitPriceString.optional(),
  taxType: taxType.optional(),
  barcode: z.string().max(20).optional(),
  safetyStock: quantityString.optional(),
  leadTimeDays: z.number().int().min(0).max(999).optional(),
  defaultSupplierId: cuid.optional(),
  note: z.string().max(500).optional(),
});

const contactInput = z.object({
  name: z.string().min(1).max(50),
  position: z.string().max(50).optional(),
  phone: z.string().max(30).optional(),
  email: z.string().email().max(100).optional(),
  isPrimary: z.boolean().optional(),
  note: z.string().max(200).optional(),
});

const partnerInput = z.object({
  code: z.string().max(30).optional(),
  name: z.string().min(1).max(100),
  businessNo: z.string().max(20).optional(),
  ceoName: z.string().max(50).optional(),
  businessType: z.string().max(50).optional(),
  businessItem: z.string().max(50).optional(),
  address: z.string().max(200).optional(),
  phone: z.string().max(30).optional(),
  email: z.string().email().max(100).optional(),
  partnerType: partnerType.optional(),
  paymentTerms: z.string().max(50).optional(),
  creditLimit: amountString.optional(),
  note: z.string().max(500).optional(),
  contacts: z.array(contactInput).max(20).optional(),
});

export const masterRouter = router({
  // ── BAS-01/02 items ──
  items: permissionProcedure('master.read')
    .input(
      paging.extend({
        q: z.string().trim().max(100).optional(),
        categoryId: cuid.optional(),
        taxType: taxType.optional(),
        activeOnly: z.boolean().default(true),
      }),
    )
    .query(({ ctx, input }) =>
      readTx(ctx, async (t) => {
        const { rows, total } = await item.list(t, {
          ...(input.q ? { q: input.q } : {}),
          ...(input.categoryId ? { categoryId: input.categoryId } : {}),
          ...(input.taxType ? { taxType: input.taxType } : {}),
          activeOnly: input.activeOnly,
          ...skipTake(input),
        });
        return { rows, total, page: input.page, pageSize: input.pageSize };
      }),
    ),

  // UIX-03: server-side export — calls item.list itself (skip/take replaced by the export
  // cap), so the master.read permission and every filter apply exactly as they do above.
  itemsCsv: permissionProcedure('master.read')
    .input(
      z.object({
        q: z.string().trim().max(100).optional(),
        categoryId: cuid.optional(),
        taxType: taxType.optional(),
        activeOnly: z.boolean().default(true),
      }),
    )
    .query(({ ctx, input }) =>
      readTx(ctx, (t) =>
        item.listCsv(t, {
          ...(input.q ? { q: input.q } : {}),
          ...(input.categoryId ? { categoryId: input.categoryId } : {}),
          ...(input.taxType ? { taxType: input.taxType } : {}),
          activeOnly: input.activeOnly,
        }),
      ),
    ),

  item: permissionProcedure('master.read')
    .input(z.object({ id: cuid }))
    .query(({ ctx, input }) => readTx(ctx, (t) => item.detail(t, input.id))),

  // an empty q returns the first `take` active items, which is what a picker needs on open
  searchItems: permissionProcedure('master.read')
    .input(
      z.object({ q: z.string().max(50).default(''), take: z.number().int().min(1).max(500).default(20) }),
    )
    .query(({ ctx, input }) => readTx(ctx, (t) => item.search(t, input.q, input.take))),

  createItem: permissionProcedure('master.write')
    .input(itemInput.extend({ requestId }))
    .mutation(({ ctx, input }) =>
      tx(
        ctx,
        (t) => {
          const { requestId: _rid, ...data } = input;
          return item.create(t, data);
        },
        input.requestId,
      ),
    ),

  updateItem: permissionProcedure('master.write')
    .input(itemInput.partial().extend({ id: cuid, version: z.number().int(), requestId }))
    .mutation(({ ctx, input }) =>
      tx(
        ctx,
        (t) => {
          const { id, version, requestId: _rid, ...data } = input;
          return item.update(t, id, data, version);
        },
        input.requestId,
      ),
    ),

  setItemActive: permissionProcedure('master.write')
    .input(z.object({ id: cuid, isActive: z.boolean(), requestId }))
    .mutation(({ ctx, input }) =>
      tx(
        ctx,
        async (t) => {
          await item.setActive(t, input.id, input.isActive);
          return { ok: true };
        },
        input.requestId,
      ),
    ),

  deleteItem: permissionProcedure('master.write')
    .input(z.object({ id: cuid, requestId }))
    .mutation(({ ctx, input }) =>
      tx(
        ctx,
        async (t) => {
          await item.remove(t, input.id);
          return { ok: true };
        },
        input.requestId,
      ),
    ),

  itemCategories: permissionProcedure('master.read').query(({ ctx }) =>
    readTx(ctx, (t) => item.categories(t)),
  ),

  createItemCategory: permissionProcedure('master.write')
    .input(
      z.object({
        code: z.string().min(1).max(30),
        name: z.string().min(1).max(50),
        parentId: cuid.optional(),
        sortOrder: z.number().int().optional(),
        requestId,
      }),
    )
    .mutation(({ ctx, input }) =>
      tx(
        ctx,
        (t) => {
          const { requestId: _rid, ...data } = input;
          return item.createCategory(t, data);
        },
        input.requestId,
      ),
    ),

  // ── BAS-04 partners ──
  partners: permissionProcedure('master.read')
    .input(
      paging.extend({
        q: z.string().trim().max(100).optional(),
        partnerType: partnerType.optional(),
        activeOnly: z.boolean().default(true),
      }),
    )
    .query(({ ctx, input }) =>
      readTx(ctx, async (t) => {
        const { rows, total } = await partner.list(t, {
          ...(input.q ? { q: input.q } : {}),
          ...(input.partnerType ? { partnerType: input.partnerType } : {}),
          activeOnly: input.activeOnly,
          ...skipTake(input),
        });
        return { rows, total, page: input.page, pageSize: input.pageSize };
      }),
    ),

  // UIX-03: server-side export — calls partner.list itself, same permission and filters.
  partnersCsv: permissionProcedure('master.read')
    .input(
      z.object({
        q: z.string().trim().max(100).optional(),
        partnerType: partnerType.optional(),
        activeOnly: z.boolean().default(true),
      }),
    )
    .query(({ ctx, input }) =>
      readTx(ctx, (t) =>
        partner.listCsv(t, {
          ...(input.q ? { q: input.q } : {}),
          ...(input.partnerType ? { partnerType: input.partnerType } : {}),
          activeOnly: input.activeOnly,
        }),
      ),
    ),

  partner: permissionProcedure('master.read')
    .input(z.object({ id: cuid }))
    .query(({ ctx, input }) => readTx(ctx, (t) => partner.detail(t, input.id))),

  // an empty q returns the first `take` active partners, which is what a picker needs on open
  searchPartners: permissionProcedure('master.read')
    .input(
      z.object({
        q: z.string().max(50).default(''),
        partnerType: partnerType.optional(),
        take: z.number().int().min(1).max(500).default(20),
      }),
    )
    .query(({ ctx, input }) => readTx(ctx, (t) => partner.search(t, input.q, input.partnerType, input.take))),

  createPartner: permissionProcedure('master.write')
    .input(partnerInput.extend({ requestId }))
    .mutation(({ ctx, input }) =>
      tx(
        ctx,
        (t) => {
          const { requestId: _rid, ...data } = input;
          return partner.create(t, data);
        },
        input.requestId,
      ),
    ),

  updatePartner: permissionProcedure('master.write')
    .input(partnerInput.partial().extend({ id: cuid, version: z.number().int(), requestId }))
    .mutation(({ ctx, input }) =>
      tx(
        ctx,
        (t) => {
          const { id, version, requestId: _rid, ...data } = input;
          return partner.update(t, id, data, version);
        },
        input.requestId,
      ),
    ),

  setPartnerActive: permissionProcedure('master.write')
    .input(z.object({ id: cuid, isActive: z.boolean(), requestId }))
    .mutation(({ ctx, input }) =>
      tx(
        ctx,
        async (t) => {
          await partner.setActive(t, input.id, input.isActive);
          return { ok: true };
        },
        input.requestId,
      ),
    ),

  deletePartner: permissionProcedure('master.write')
    .input(z.object({ id: cuid, requestId }))
    .mutation(({ ctx, input }) =>
      tx(
        ctx,
        async (t) => {
          await partner.remove(t, input.id);
          return { ok: true };
        },
        input.requestId,
      ),
    ),

  // ── BAS-06/07 reference data ──
  warehouses: permissionProcedure('master.read')
    .input(z.object({ activeOnly: z.boolean().default(false) }))
    .query(({ ctx, input }) => readTx(ctx, (t) => reference.listWarehouses(t, input.activeOnly))),

  createWarehouse: permissionProcedure('master.write')
    .input(
      z.object({
        code: z.string().min(1).max(20),
        name: z.string().min(1).max(50),
        type: warehouseType.optional(),
        managerEmployeeId: cuid.optional(),
        address: z.string().max(200).optional(),
        sortOrder: z.number().int().optional(),
        requestId,
      }),
    )
    .mutation(({ ctx, input }) =>
      tx(
        ctx,
        (t) => {
          const { requestId: _rid, ...data } = input;
          return reference.createWarehouse(t, data);
        },
        input.requestId,
      ),
    ),

  updateWarehouse: permissionProcedure('master.write')
    .input(
      z.object({
        id: cuid,
        name: z.string().max(50).optional(),
        type: warehouseType.optional(),
        managerEmployeeId: cuid.nullable().optional(),
        address: z.string().max(200).optional(),
        isActive: z.boolean().optional(),
        sortOrder: z.number().int().optional(),
        requestId,
      }),
    )
    .mutation(({ ctx, input }) =>
      tx(
        ctx,
        (t) => {
          const { id, requestId: _rid, ...data } = input;
          return reference.updateWarehouse(t, id, data);
        },
        input.requestId,
      ),
    ),

  divisions: permissionProcedure('master.read')
    .input(z.object({ activeOnly: z.boolean().default(false) }))
    .query(({ ctx, input }) => readTx(ctx, (t) => reference.listDivisions(t, input.activeOnly))),

  createDivision: permissionProcedure('master.write')
    .input(
      z.object({
        code: z.string().min(1).max(20),
        name: z.string().min(1).max(50),
        sortOrder: z.number().int().optional(),
        requestId,
      }),
    )
    .mutation(({ ctx, input }) =>
      tx(
        ctx,
        (t) => {
          const { requestId: _rid, ...data } = input;
          return reference.createDivision(t, data);
        },
        input.requestId,
      ),
    ),

  updateDivision: permissionProcedure('master.write')
    .input(
      z.object({
        id: cuid,
        name: z.string().max(50).optional(),
        isActive: z.boolean().optional(),
        sortOrder: z.number().int().optional(),
        requestId,
      }),
    )
    .mutation(({ ctx, input }) =>
      tx(
        ctx,
        (t) => {
          const { id, requestId: _rid, ...data } = input;
          return reference.updateDivision(t, id, data);
        },
        input.requestId,
      ),
    ),

  codeGroups: permissionProcedure('master.read').query(() => reference.CODE_GROUPS),

  codes: permissionProcedure('master.read')
    .input(z.object({ groupCode: z.string().optional(), activeOnly: z.boolean().default(false) }))
    .query(({ ctx, input }) => readTx(ctx, (t) => reference.listCodes(t, input.groupCode, input.activeOnly))),

  upsertCode: permissionProcedure('master.write')
    .input(
      z.object({
        groupCode: z.string().min(1).max(30),
        code: z.string().min(1).max(30),
        name: z.string().min(1).max(50),
        value1: z.string().max(100).optional(),
        value2: z.string().max(100).optional(),
        sortOrder: z.number().int().optional(),
        isActive: z.boolean().optional(),
        requestId,
      }),
    )
    .mutation(({ ctx, input }) =>
      tx(
        ctx,
        (t) => {
          const { requestId: _rid, ...data } = input;
          return reference.upsertCode(t, data);
        },
        input.requestId,
      ),
    ),

  deactivateCode: permissionProcedure('master.write')
    .input(z.object({ groupCode: z.string(), code: z.string(), requestId }))
    .mutation(({ ctx, input }) =>
      tx(ctx, (t) => reference.deactivateCode(t, input.groupCode, input.code), input.requestId),
    ),

  numberingRules: permissionProcedure('master.read').query(({ ctx }) =>
    readTx(ctx, (t) => reference.listNumberingRules(t)),
  ),

  createNumberingRule: permissionProcedure('admin.settings')
    .input(
      z.object({
        docType: z.string().min(1).max(40),
        prefix: z.string().min(1).max(5),
        periodKind: z.enum(['NONE', 'YEAR', 'MONTH']),
        seqLength: z.number().int().min(3).max(10),
        requestId,
      }),
    )
    .mutation(({ ctx, input }) =>
      tx(
        ctx,
        (t) => {
          const { requestId: _rid, ...data } = input;
          return reference.createNumberingRule(t, data);
        },
        input.requestId,
      ),
    ),

  updateNumberingRule: permissionProcedure('admin.settings')
    .input(
      z.object({
        docType: z.string().min(1).max(40),
        prefix: z.string().min(1).max(5),
        periodKind: z.enum(['NONE', 'YEAR', 'MONTH']),
        seqLength: z.number().int().min(3).max(10),
        requestId,
      }),
    )
    .mutation(({ ctx, input }) =>
      tx(
        ctx,
        (t) => {
          const { requestId: _rid, ...data } = input;
          return reference.updateNumberingRule(t, data);
        },
        input.requestId,
      ),
    ),

  // ── BAS-08 change history ──
  changeHistory: permissionProcedure('master.read')
    .input(
      z.object({
        // the change-history card is shared by master and document screens alike
        entityType: z.enum([
          'Item',
          'Partner',
          'Warehouse',
          'Division',
          'CommonCode',
          'StockDocument',
          'StockCount',
        ]),
        entityId: cuid,
      }),
    )
    .query(({ ctx, input }) =>
      readTx(ctx, (t) => reference.changeHistory(t, input.entityType, input.entityId)),
    ),

  // ── BAS-03 bulk registration ──
  importTemplate: permissionProcedure('master.read')
    .input(z.object({ targetType: z.enum(['ITEM', 'PARTNER']) }))
    .query(({ input }) => importer.templateFor(input.targetType)),

  validateImport: permissionProcedure('master.write')
    .input(
      z.object({
        targetType: z.enum(['ITEM', 'PARTNER']),
        rows: z.array(z.record(z.string(), z.string())).min(1).max(5000),
        fileName: z.string().max(200).optional(),
        templateVersion: z.number().int().optional(),
        requestId,
      }),
    )
    .mutation(({ ctx, input }) =>
      tx(
        ctx,
        (t) => {
          const { requestId: _rid, ...data } = input;
          return importer.validateBatch(t, data);
        },
        input.requestId,
      ),
    ),

  applyImport: permissionProcedure('master.write')
    .input(
      z.object({
        batchId: cuid,
        targetType: z.enum(['ITEM', 'PARTNER']),
        rows: z.array(z.record(z.string(), z.string())).min(1).max(5000),
        selectedRows: z.array(z.number().int().min(1)).min(1),
        requestId,
      }),
    )
    .mutation(({ ctx, input }) =>
      tx(
        ctx,
        (t) => {
          const { requestId: _rid, ...data } = input;
          return importer.applyBatch(t, data);
        },
        input.requestId,
      ),
    ),

  importBatches: permissionProcedure('master.read')
    .input(z.object({ targetType: z.enum(['ITEM', 'PARTNER']).optional() }))
    .query(({ ctx, input }) => readTx(ctx, (t) => importer.listBatches(t, input.targetType))),
});
