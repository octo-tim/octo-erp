import type { TransactionContext } from '@/server/core/context';
import { AppError } from '@/server/core/errors';
import { requirePermission } from '@/server/modules/rbac/service';
import * as audit from '@/server/modules/audit/service';
import { nextDocNo } from '@/server/modules/numbering/service';
import { validateBarcode, TAX_TYPES } from './validation';
import { quantity, unitPrice } from '@/lib/money';

/** BAS-01/BAS-02/BAS-09: items, their supplementary fields, and the no-hard-delete rule. */

export interface ItemInput {
  code?: string;
  name: string;
  spec?: string;
  unitCode?: string;
  categoryId?: string;
  purchasePrice?: string;
  salesPrice?: string;
  taxType?: string;
  barcode?: string;
  safetyStock?: string;
  leadTimeDays?: number;
  defaultSupplierId?: string;
  note?: string;
}

function validate(input: Partial<ItemInput>): void {
  const errors: string[] = [];
  if (input.name !== undefined && !input.name.trim()) errors.push('품목명을 입력하세요.');
  if (input.taxType !== undefined && !TAX_TYPES.includes(input.taxType as never))
    errors.push('과세구분이 올바르지 않습니다.');
  if (input.barcode) {
    const barcodeError = validateBarcode(input.barcode);
    if (barcodeError) errors.push(barcodeError);
  }
  if (input.leadTimeDays !== undefined && input.leadTimeDays !== null && input.leadTimeDays < 0) {
    errors.push('리드타임은 0일 이상이어야 합니다.');
  }
  if (errors.length) throw new AppError('VALIDATION', errors.join('\n'), { errors });
}

export async function create(ctx: TransactionContext, input: ItemInput) {
  requirePermission(ctx.actor, 'master.write');
  validate(input);

  const code = input.code ?? (await nextDocNo(ctx, 'ITEM'));
  if (input.categoryId) await assertCategoryIsLeaf(ctx, input.categoryId);

  try {
    const item = await ctx.tx.item.create({
      data: {
        code,
        name: input.name.trim(),
        spec: input.spec ?? null,
        unitCode: input.unitCode ?? 'EA',
        categoryId: input.categoryId ?? null,
        purchasePrice: input.purchasePrice ? unitPrice(input.purchasePrice) : null,
        salesPrice: input.salesPrice ? unitPrice(input.salesPrice) : null,
        taxType: input.taxType ?? 'TAXABLE',
        barcode: input.barcode ?? null,
        safetyStock: input.safetyStock ? quantity(input.safetyStock) : null,
        leadTimeDays: input.leadTimeDays ?? null,
        defaultSupplierId: input.defaultSupplierId ?? null,
        note: input.note ?? null,
      },
    });

    await audit.record(ctx, {
      action: 'item.create',
      entityType: 'Item',
      entityId: item.id,
      after: { code, name: item.name, taxType: item.taxType, categoryId: item.categoryId },
    });
    return item;
  } catch (e) {
    if ((e as { code?: string }).code === 'P2002') {
      throw new AppError('CONFLICT', `이미 사용 중인 품목코드입니다: ${code}`);
    }
    throw e;
  }
}

export async function update(
  ctx: TransactionContext,
  id: string,
  input: Partial<ItemInput>,
  version: number,
) {
  requirePermission(ctx.actor, 'master.write');
  validate(input);

  const before = await ctx.tx.item.findUniqueOrThrow({ where: { id } });
  if (before.version !== version) {
    throw new AppError(
      'VERSION_CONFLICT',
      '품목이 다른 사용자에 의해 변경되었습니다. 새로 고친 뒤 다시 시도하세요.',
    );
  }
  if (input.categoryId) await assertCategoryIsLeaf(ctx, input.categoryId);

  const after = await ctx.tx.item.update({
    where: { id },
    data: {
      ...(input.name !== undefined ? { name: input.name.trim() } : {}),
      ...(input.spec !== undefined ? { spec: input.spec } : {}),
      ...(input.unitCode !== undefined ? { unitCode: input.unitCode } : {}),
      ...(input.categoryId !== undefined ? { categoryId: input.categoryId } : {}),
      ...(input.purchasePrice !== undefined
        ? { purchasePrice: input.purchasePrice ? unitPrice(input.purchasePrice) : null }
        : {}),
      ...(input.salesPrice !== undefined
        ? { salesPrice: input.salesPrice ? unitPrice(input.salesPrice) : null }
        : {}),
      ...(input.taxType !== undefined ? { taxType: input.taxType } : {}),
      ...(input.barcode !== undefined ? { barcode: input.barcode } : {}),
      ...(input.safetyStock !== undefined
        ? { safetyStock: input.safetyStock ? quantity(input.safetyStock) : null }
        : {}),
      ...(input.leadTimeDays !== undefined ? { leadTimeDays: input.leadTimeDays } : {}),
      ...(input.defaultSupplierId !== undefined ? { defaultSupplierId: input.defaultSupplierId } : {}),
      ...(input.note !== undefined ? { note: input.note } : {}),
      version: { increment: 1 },
    },
  });

  // BAS-08: the before/after pair is the change history shown on the item screen
  await audit.record(ctx, {
    action: 'item.update',
    entityType: 'Item',
    entityId: id,
    before: {
      name: before.name,
      spec: before.spec,
      salesPrice: before.salesPrice?.toString() ?? null,
      purchasePrice: before.purchasePrice?.toString() ?? null,
      taxType: before.taxType,
      safetyStock: before.safetyStock?.toString() ?? null,
    },
    after: {
      name: after.name,
      spec: after.spec,
      salesPrice: after.salesPrice?.toString() ?? null,
      purchasePrice: after.purchasePrice?.toString() ?? null,
      taxType: after.taxType,
      safetyStock: after.safetyStock?.toString() ?? null,
    },
  });
  return after;
}

/** A three-level classification: items attach to level-3 categories only (BAS-01). */
async function assertCategoryIsLeaf(ctx: TransactionContext, categoryId: string) {
  const category = await ctx.tx.itemCategory.findUnique({ where: { id: categoryId } });
  if (!category) throw new AppError('VALIDATION', '존재하지 않는 품목분류입니다.');
  if (!category.isActive) throw new AppError('VALIDATION', '사용 중지된 품목분류입니다.');
  const hasChildren = await ctx.tx.itemCategory.count({ where: { parentId: categoryId, isActive: true } });
  if (hasChildren > 0) throw new AppError('VALIDATION', '최하위 분류에만 품목을 등록할 수 있습니다.');
}

/**
 * BAS-09: masters that have been used are never physically deleted. This is the single
 * place that decides "in use", so every caller gets the same answer.
 */
export async function usageCount(ctx: TransactionContext, itemId: string): Promise<number> {
  // Later steps add stock/sales references here; today only the default-supplier link exists.
  const [ledgerTableExists] = await ctx.tx.$queryRaw<{ exists: boolean }[]>`
    SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'InventoryLedger') AS "exists"`;
  if (!ledgerTableExists?.exists) return 0;
  const rows = await ctx.tx.$queryRaw<{ count: bigint }[]>`
    SELECT COUNT(*)::bigint AS count FROM "InventoryLedger" WHERE "itemId" = ${itemId}`;
  return Number(rows[0]?.count ?? 0);
}

export async function setActive(ctx: TransactionContext, id: string, isActive: boolean) {
  requirePermission(ctx.actor, 'master.write');
  const item = await ctx.tx.item.findUniqueOrThrow({ where: { id } });
  await ctx.tx.item.update({ where: { id }, data: { isActive, version: { increment: 1 } } });
  await audit.record(ctx, {
    action: isActive ? 'item.activate' : 'item.deactivate',
    entityType: 'Item',
    entityId: id,
    before: { isActive: item.isActive },
    after: { isActive },
  });
}

export async function remove(ctx: TransactionContext, id: string) {
  requirePermission(ctx.actor, 'master.write');
  const used = await usageCount(ctx, id);
  if (used > 0) {
    throw new AppError(
      'MASTER_IN_USE',
      `이미 사용된 품목은 삭제할 수 없습니다(관련 자료 ${used}건). 사용중지로 처리하세요.`,
      {
        itemId: id,
        used,
      },
    );
  }
  const item = await ctx.tx.item.findUniqueOrThrow({ where: { id } });
  await ctx.tx.item.delete({ where: { id } });
  await audit.record(ctx, {
    action: 'item.delete',
    entityType: 'Item',
    entityId: id,
    before: { code: item.code, name: item.name },
  });
}

export async function list(
  ctx: TransactionContext,
  input: {
    q?: string;
    categoryId?: string;
    taxType?: string;
    activeOnly?: boolean;
    skip: number;
    take: number;
  },
) {
  requirePermission(ctx.actor, 'master.read');
  const where = {
    ...(input.activeOnly ? { isActive: true } : {}),
    ...(input.categoryId ? { categoryId: input.categoryId } : {}),
    ...(input.taxType ? { taxType: input.taxType } : {}),
    ...(input.q
      ? {
          OR: [
            { code: { contains: input.q, mode: 'insensitive' as const } },
            { name: { contains: input.q, mode: 'insensitive' as const } },
            { spec: { contains: input.q, mode: 'insensitive' as const } },
            { barcode: { contains: input.q } },
          ],
        }
      : {}),
  };
  const [rows, total] = await Promise.all([
    ctx.tx.item.findMany({
      where,
      include: {
        category: { select: { code: true, name: true } },
        defaultSupplier: { select: { code: true, name: true } },
      },
      orderBy: { code: 'asc' },
      skip: input.skip,
      take: input.take,
    }),
    ctx.tx.item.count({ where }),
  ]);
  return { rows, total };
}

export async function detail(ctx: TransactionContext, id: string) {
  requirePermission(ctx.actor, 'master.read');
  const item = await ctx.tx.item.findUnique({
    where: { id },
    include: { category: true, defaultSupplier: { select: { id: true, code: true, name: true } } },
  });
  if (!item) throw new AppError('NOT_FOUND', '품목을 찾을 수 없습니다.');
  return { ...item, usageCount: await usageCount(ctx, id) };
}

/** Autocomplete source for the voucher line editor (UIX-04). */
export async function search(ctx: TransactionContext, q: string, take = 20) {
  requirePermission(ctx.actor, 'master.read');
  return ctx.tx.item.findMany({
    where: {
      isActive: true,
      OR: [
        { code: { contains: q, mode: 'insensitive' } },
        { name: { contains: q, mode: 'insensitive' } },
        { barcode: { contains: q } },
      ],
    },
    select: {
      id: true,
      code: true,
      name: true,
      spec: true,
      unitCode: true,
      salesPrice: true,
      purchasePrice: true,
      taxType: true,
    },
    orderBy: { code: 'asc' },
    take,
  });
}

// ── categories ──

export async function categories(ctx: TransactionContext) {
  requirePermission(ctx.actor, 'master.read');
  return ctx.tx.itemCategory.findMany({ orderBy: [{ level: 'asc' }, { sortOrder: 'asc' }, { code: 'asc' }] });
}

export async function createCategory(
  ctx: TransactionContext,
  input: { code: string; name: string; parentId?: string; sortOrder?: number },
) {
  requirePermission(ctx.actor, 'master.write');
  let level = 1;
  if (input.parentId) {
    const parent = await ctx.tx.itemCategory.findUnique({ where: { id: input.parentId } });
    if (!parent) throw new AppError('VALIDATION', '상위 분류를 찾을 수 없습니다.');
    level = parent.level + 1;
    if (level > 3) throw new AppError('VALIDATION', '품목분류는 3단계까지만 등록할 수 있습니다.');

    const itemsOnParent = await ctx.tx.item.count({ where: { categoryId: input.parentId } });
    if (itemsOnParent > 0) {
      throw new AppError(
        'CONFLICT',
        `상위 분류에 품목 ${itemsOnParent}건이 등록되어 있어 하위 분류를 만들 수 없습니다.`,
      );
    }
  }

  const category = await ctx.tx.itemCategory.create({
    data: {
      code: input.code,
      name: input.name,
      level,
      parentId: input.parentId ?? null,
      sortOrder: input.sortOrder ?? 0,
    },
  });
  await audit.record(ctx, {
    action: 'itemCategory.create',
    entityType: 'ItemCategory',
    entityId: category.id,
    after: { code: input.code, name: input.name, level },
  });
  return category;
}
