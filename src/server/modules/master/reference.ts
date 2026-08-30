import type { TransactionContext } from '@/server/core/context';
import { AppError } from '@/server/core/errors';
import { requirePermission } from '@/server/modules/rbac/service';
import * as audit from '@/server/modules/audit/service';
import { WAREHOUSE_TYPES } from './validation';

/** BAS-06/BAS-07 and the numbering rules screen. */

// ── warehouses (BAS-06) ──

export async function listWarehouses(ctx: TransactionContext, activeOnly = false) {
  requirePermission(ctx.actor, 'master.read');
  // INT-12: a user only sees warehouses in their scope
  return ctx.tx.warehouse.findMany({
    where: {
      ...(activeOnly ? { isActive: true } : {}),
      ...(ctx.actor.isAdmin ? {} : { id: { in: ctx.actor.warehouseIds } }),
    },
    orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }],
  });
}

export async function createWarehouse(
  ctx: TransactionContext,
  input: {
    code: string;
    name: string;
    type?: string;
    managerEmployeeId?: string;
    address?: string;
    sortOrder?: number;
  },
) {
  requirePermission(ctx.actor, 'master.write');
  if (input.type && !WAREHOUSE_TYPES.includes(input.type as never)) {
    throw new AppError('VALIDATION', '창고 유형은 정상·불량·위탁 중 하나여야 합니다.');
  }
  try {
    const warehouse = await ctx.tx.warehouse.create({
      data: {
        code: input.code,
        name: input.name,
        type: input.type ?? 'NORMAL',
        managerEmployeeId: input.managerEmployeeId ?? null,
        address: input.address ?? null,
        sortOrder: input.sortOrder ?? 0,
      },
    });
    await audit.record(ctx, {
      action: 'warehouse.create',
      entityType: 'Warehouse',
      entityId: warehouse.id,
      after: { code: input.code, name: input.name, type: warehouse.type },
    });
    return warehouse;
  } catch (e) {
    if ((e as { code?: string }).code === 'P2002')
      throw new AppError('CONFLICT', `이미 사용 중인 창고코드입니다: ${input.code}`);
    throw e;
  }
}

export async function updateWarehouse(
  ctx: TransactionContext,
  id: string,
  input: {
    name?: string;
    type?: string;
    managerEmployeeId?: string | null;
    address?: string;
    isActive?: boolean;
    sortOrder?: number;
  },
) {
  requirePermission(ctx.actor, 'master.write');
  const before = await ctx.tx.warehouse.findUniqueOrThrow({ where: { id } });
  if (input.type && !WAREHOUSE_TYPES.includes(input.type as never)) {
    throw new AppError('VALIDATION', '창고 유형은 정상·불량·위탁 중 하나여야 합니다.');
  }

  const after = await ctx.tx.warehouse.update({
    where: { id },
    data: {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.type !== undefined ? { type: input.type } : {}),
      ...(input.managerEmployeeId !== undefined ? { managerEmployeeId: input.managerEmployeeId } : {}),
      ...(input.address !== undefined ? { address: input.address } : {}),
      ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
      ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}),
    },
  });

  await audit.record(ctx, {
    action: 'warehouse.update',
    entityType: 'Warehouse',
    entityId: id,
    before: { name: before.name, type: before.type, isActive: before.isActive },
    after: { name: after.name, type: after.type, isActive: after.isActive },
  });
  return after;
}

// ── divisions (BAS-07 부문) ──

export async function listDivisions(ctx: TransactionContext, activeOnly = false) {
  requirePermission(ctx.actor, 'master.read');
  return ctx.tx.division.findMany({
    where: {
      ...(activeOnly ? { isActive: true } : {}),
      ...(ctx.actor.isAdmin ? {} : { id: { in: ctx.actor.divisionIds } }),
    },
    orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }],
  });
}

export async function createDivision(
  ctx: TransactionContext,
  input: { code: string; name: string; sortOrder?: number },
) {
  requirePermission(ctx.actor, 'master.write');
  try {
    const division = await ctx.tx.division.create({
      data: { code: input.code, name: input.name, sortOrder: input.sortOrder ?? 0 },
    });
    await audit.record(ctx, {
      action: 'division.create',
      entityType: 'Division',
      entityId: division.id,
      after: { code: input.code, name: input.name },
    });
    return division;
  } catch (e) {
    if ((e as { code?: string }).code === 'P2002')
      throw new AppError('CONFLICT', `이미 사용 중인 사업부코드입니다: ${input.code}`);
    throw e;
  }
}

export async function updateDivision(
  ctx: TransactionContext,
  id: string,
  input: { name?: string; isActive?: boolean; sortOrder?: number },
) {
  requirePermission(ctx.actor, 'master.write');
  const before = await ctx.tx.division.findUniqueOrThrow({ where: { id } });
  const after = await ctx.tx.division.update({ where: { id }, data: input });
  await audit.record(ctx, {
    action: 'division.update',
    entityType: 'Division',
    entityId: id,
    before: { name: before.name, isActive: before.isActive },
    after: { name: after.name, isActive: after.isActive },
  });
  return after;
}

// ── common codes (BAS-07) ──

export const CODE_GROUPS: { group: string; label: string }[] = [
  { group: 'UNIT', label: '단위' },
  { group: 'PAYMENT_METHOD', label: '결제수단' },
  { group: 'PAYMENT_TERMS', label: '결제조건' },
  { group: 'POSITION', label: '직위' },
  { group: 'STOCK_REASON_IN', label: '입고사유' },
  { group: 'STOCK_REASON_OUT', label: '출고사유' },
  { group: 'LEAVE_TYPE', label: '휴가유형' },
];

export async function listCodes(ctx: TransactionContext, groupCode?: string, activeOnly = false) {
  requirePermission(ctx.actor, 'master.read');
  return ctx.tx.commonCode.findMany({
    where: { ...(groupCode ? { groupCode } : {}), ...(activeOnly ? { isActive: true } : {}) },
    orderBy: [{ groupCode: 'asc' }, { sortOrder: 'asc' }, { code: 'asc' }],
  });
}

export async function upsertCode(
  ctx: TransactionContext,
  input: {
    groupCode: string;
    code: string;
    name: string;
    value1?: string;
    value2?: string;
    sortOrder?: number;
    isActive?: boolean;
  },
) {
  requirePermission(ctx.actor, 'master.write');
  if (!CODE_GROUPS.some((g) => g.group === input.groupCode)) {
    throw new AppError('VALIDATION', `알 수 없는 코드그룹입니다: ${input.groupCode}`);
  }

  const before = await ctx.tx.commonCode.findUnique({
    where: { groupCode_code: { groupCode: input.groupCode, code: input.code } },
  });

  const row = await ctx.tx.commonCode.upsert({
    where: { groupCode_code: { groupCode: input.groupCode, code: input.code } },
    create: {
      groupCode: input.groupCode,
      code: input.code,
      name: input.name,
      value1: input.value1 ?? null,
      value2: input.value2 ?? null,
      sortOrder: input.sortOrder ?? 0,
    },
    update: {
      name: input.name,
      value1: input.value1 ?? null,
      value2: input.value2 ?? null,
      ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}),
      ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
    },
  });

  await audit.record(ctx, {
    action: before ? 'commonCode.update' : 'commonCode.create',
    entityType: 'CommonCode',
    entityId: row.id,
    before: before ? { name: before.name, isActive: before.isActive } : undefined,
    after: { groupCode: input.groupCode, code: input.code, name: input.name, isActive: row.isActive },
  });
  return row;
}

/** BAS-09: a code in use is deactivated, never deleted. */
export async function deactivateCode(ctx: TransactionContext, groupCode: string, code: string) {
  requirePermission(ctx.actor, 'master.write');
  if (groupCode === 'UNIT') {
    const used = await ctx.tx.item.count({ where: { unitCode: code } });
    if (used > 0)
      throw new AppError('MASTER_IN_USE', `품목 ${used}건이 사용 중인 단위입니다. 사용중지만 가능합니다.`);
  }
  const row = await ctx.tx.commonCode.update({
    where: { groupCode_code: { groupCode, code } },
    data: { isActive: false },
  });
  await audit.record(ctx, { action: 'commonCode.deactivate', entityType: 'CommonCode', entityId: row.id });
  return row;
}

// ── numbering rules ──

export async function listNumberingRules(ctx: TransactionContext) {
  requirePermission(ctx.actor, 'master.read');
  return ctx.tx.numberingRule.findMany({
    include: { counters: { orderBy: { periodKey: 'desc' }, take: 3 } },
    orderBy: { docType: 'asc' },
  });
}

export async function updateNumberingRule(
  ctx: TransactionContext,
  input: { docType: string; prefix: string; periodKind: 'NONE' | 'YEAR' | 'MONTH'; seqLength: number },
) {
  requirePermission(ctx.actor, 'admin.settings');
  if (input.seqLength < 3 || input.seqLength > 10)
    throw new AppError('VALIDATION', '일련번호 자릿수는 3~10 사이여야 합니다.');
  if (!/^[A-Z0-9]{1,5}$/.test(input.prefix))
    throw new AppError('VALIDATION', '접두어는 영문 대문자·숫자 5자 이내여야 합니다.');

  const before = await ctx.tx.numberingRule.findUniqueOrThrow({ where: { docType: input.docType } });
  const after = await ctx.tx.numberingRule.update({
    where: { docType: input.docType },
    data: {
      prefix: input.prefix,
      periodKind: input.periodKind,
      seqLength: input.seqLength,
      version: { increment: 1 },
    },
  });

  await audit.record(ctx, {
    action: 'numberingRule.update',
    entityType: 'NumberingRule',
    entityId: after.id,
    before: { prefix: before.prefix, periodKind: before.periodKind, seqLength: before.seqLength },
    after: { prefix: after.prefix, periodKind: after.periodKind, seqLength: after.seqLength },
  });
  return after;
}

/** BAS-08: the change history a master screen shows comes straight from the audit log. */
export async function changeHistory(ctx: TransactionContext, entityType: string, entityId: string) {
  requirePermission(ctx.actor, 'master.read');
  return ctx.tx.auditLog.findMany({
    where: { entityType, entityId },
    orderBy: { createdAt: 'desc' },
    take: 100,
    select: { id: true, action: true, actorName: true, before: true, after: true, createdAt: true },
  });
}
