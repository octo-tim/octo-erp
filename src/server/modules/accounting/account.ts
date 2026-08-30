import type { TransactionContext } from '@/server/core/context';
import { AppError } from '@/server/core/errors';
import { requirePermission } from '@/server/modules/rbac/service';
import * as audit from '@/server/modules/audit/service';

/**
 * ACC-01 — the chart of accounts.
 *
 * Standard accounts ship with the system and can be deactivated but never deleted or
 * retyped, because a posted entry that referred to them must keep meaning what it meant.
 * Only a leaf account is postable, the same rule item categories use.
 */

export const ACCOUNT_TYPES = ['ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE'] as const;
export type AccountType = (typeof ACCOUNT_TYPES)[number];

export const ACCOUNT_TYPE_LABEL: Record<AccountType, string> = {
  ASSET: '자산',
  LIABILITY: '부채',
  EQUITY: '자본',
  REVENUE: '수익',
  EXPENSE: '비용',
};

/** Which side increases the account. Debit for assets and expenses, credit for the rest. */
export function normalSideOf(type: AccountType): 'DEBIT' | 'CREDIT' {
  return type === 'ASSET' || type === 'EXPENSE' ? 'DEBIT' : 'CREDIT';
}

/** ACC-05: revenue and expense close each year; the rest carry forward (ACC-06/ACC-08). */
export function isProfitAndLoss(type: string): boolean {
  return type === 'REVENUE' || type === 'EXPENSE';
}

export async function list(ctx: TransactionContext, input: { q?: string; activeOnly?: boolean } = {}) {
  requirePermission(ctx.actor, 'accounting.read');
  return ctx.tx.account.findMany({
    where: {
      ...(input.activeOnly ? { isActive: true } : {}),
      ...(input.q
        ? {
            OR: [
              { code: { contains: input.q, mode: 'insensitive' as const } },
              { name: { contains: input.q, mode: 'insensitive' as const } },
            ],
          }
        : {}),
    },
    orderBy: { code: 'asc' },
  });
}

export async function postable(ctx: TransactionContext) {
  requirePermission(ctx.actor, 'accounting.read');
  return ctx.tx.account.findMany({
    where: { isActive: true, isPostable: true },
    select: { id: true, code: true, name: true, accountType: true, normalSide: true },
    orderBy: { code: 'asc' },
  });
}

export async function create(
  ctx: TransactionContext,
  input: { code: string; name: string; accountType: AccountType; parentId?: string; note?: string },
) {
  requirePermission(ctx.actor, 'accounting.rules');
  if (!ACCOUNT_TYPES.includes(input.accountType)) {
    throw new AppError('VALIDATION', '계정 구분이 올바르지 않습니다.');
  }
  if (!/^\d{3,8}$/.test(input.code)) {
    throw new AppError('VALIDATION', '계정과목 코드는 숫자 3~8자리여야 합니다.');
  }

  let level = 1;
  if (input.parentId) {
    const parent = await ctx.tx.account.findUniqueOrThrow({ where: { id: input.parentId } });
    if (parent.accountType !== input.accountType) {
      throw new AppError('VALIDATION', '상위 계정과 계정 구분이 같아야 합니다.');
    }
    level = parent.level + 1;
    if (level > 4) throw new AppError('VALIDATION', '계정과목은 4단계까지만 만들 수 있습니다.');

    // a parent that has children is no longer postable: entries belong on leaves
    if (parent.isPostable) {
      const posted = await ctx.tx.journalLine.count({ where: { accountId: parent.id } });
      if (posted > 0) {
        throw new AppError(
          'MASTER_IN_USE',
          `상위로 삼으려는 계정에 이미 분개 ${posted}건이 있습니다. 하위 계정을 만들 수 없습니다.`,
        );
      }
      await ctx.tx.account.update({ where: { id: parent.id }, data: { isPostable: false } });
    }
  }

  try {
    const account = await ctx.tx.account.create({
      data: {
        code: input.code,
        name: input.name.trim(),
        accountType: input.accountType,
        normalSide: normalSideOf(input.accountType),
        parentId: input.parentId ?? null,
        level,
        isPostable: true,
        isStandard: false,
        note: input.note ?? null,
      },
    });
    await audit.record(ctx, {
      action: 'account.create',
      entityType: 'Account',
      entityId: account.id,
      after: { code: input.code, name: account.name, accountType: input.accountType },
    });
    return account;
  } catch (e) {
    if ((e as { code?: string }).code === 'P2002')
      throw new AppError('CONFLICT', `이미 사용 중인 계정과목 코드입니다: ${input.code}`);
    throw e;
  }
}

export async function update(
  ctx: TransactionContext,
  id: string,
  input: { name?: string; note?: string; isActive?: boolean; sortOrder?: number },
  version: number,
) {
  requirePermission(ctx.actor, 'accounting.rules');
  const before = await ctx.tx.account.findUniqueOrThrow({ where: { id } });
  if (before.version !== version) {
    throw new AppError('VERSION_CONFLICT', '계정과목이 변경되었습니다. 새로 고친 뒤 다시 시도하세요.');
  }

  // a standard account keeps its name so a posted entry keeps meaning what it meant
  if (before.isStandard && input.name !== undefined && input.name !== before.name) {
    throw new AppError(
      'VALIDATION',
      '표준 계정과목의 명칭은 변경할 수 없습니다. 필요하면 사용중지 후 새 계정을 만드세요.',
    );
  }

  if (input.isActive === false) {
    const mapped = await ctx.tx.accountMapping.count({ where: { accountId: id } });
    if (mapped > 0) {
      throw new AppError(
        'MASTER_IN_USE',
        '자동분개 계정 매핑에 사용 중인 계정은 사용중지할 수 없습니다. 매핑을 먼저 바꾸세요.',
      );
    }
  }

  const after = await ctx.tx.account.update({
    where: { id },
    data: {
      ...(input.name !== undefined ? { name: input.name.trim() } : {}),
      ...(input.note !== undefined ? { note: input.note } : {}),
      ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
      ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}),
      version: { increment: 1 },
    },
  });

  await audit.record(ctx, {
    action: 'account.update',
    entityType: 'Account',
    entityId: id,
    before: { name: before.name, isActive: before.isActive },
    after: { name: after.name, isActive: after.isActive },
  });
  return after;
}

/** ACC-01: a posted account is never deleted, only deactivated. */
export async function remove(ctx: TransactionContext, id: string) {
  requirePermission(ctx.actor, 'accounting.rules');
  const account = await ctx.tx.account.findUniqueOrThrow({ where: { id } });
  if (account.isStandard) {
    throw new AppError('VALIDATION', '표준 계정과목은 삭제할 수 없습니다. 사용중지로 처리하세요.');
  }

  const [posted, children, mapped] = await Promise.all([
    ctx.tx.journalLine.count({ where: { accountId: id } }),
    ctx.tx.account.count({ where: { parentId: id } }),
    ctx.tx.accountMapping.count({ where: { accountId: id } }),
  ]);
  if (posted > 0 || children > 0 || mapped > 0) {
    throw new AppError(
      'MASTER_IN_USE',
      `사용 중인 계정과목은 삭제할 수 없습니다(분개 ${posted}건, 하위 ${children}건, 매핑 ${mapped}건). 사용중지로 처리하세요.`,
    );
  }

  await ctx.tx.account.delete({ where: { id } });
  await audit.record(ctx, {
    action: 'account.delete',
    entityType: 'Account',
    entityId: id,
    before: { code: account.code, name: account.name },
  });
}

// ── ACC-03 slot mapping ──

export const MAPPING_SLOTS: { slot: string; label: string }[] = [
  { slot: 'SALES', label: '매출' },
  { slot: 'SALES_DISCOUNT', label: '매출에누리' },
  { slot: 'ACCOUNTS_RECEIVABLE', label: '외상매출금' },
  { slot: 'VAT_PAYABLE', label: '부가세예수금' },
  { slot: 'PURCHASE', label: '매입' },
  { slot: 'ACCOUNTS_PAYABLE', label: '외상매입금' },
  { slot: 'VAT_RECEIVABLE', label: '부가세대급금' },
  { slot: 'INVENTORY', label: '재고자산' },
  { slot: 'COGS', label: '매출원가' },
  { slot: 'CASH', label: '현금' },
  { slot: 'BANK', label: '보통예금' },
  { slot: 'RETAINED_EARNINGS', label: '이익잉여금' },
];

export async function mappings(ctx: TransactionContext) {
  requirePermission(ctx.actor, 'accounting.read');
  const rows = await ctx.tx.accountMapping.findMany({
    include: { account: { select: { id: true, code: true, name: true } } },
  });
  const bySlot = new Map(rows.map((r) => [r.slot, r]));
  return MAPPING_SLOTS.map((s) => ({
    slot: s.slot,
    label: s.label,
    account: bySlot.get(s.slot)?.account ?? null,
  }));
}

export async function setMapping(ctx: TransactionContext, slot: string, accountId: string) {
  requirePermission(ctx.actor, 'accounting.rules');
  if (!MAPPING_SLOTS.some((s) => s.slot === slot)) {
    throw new AppError('VALIDATION', `알 수 없는 계정 역할입니다: ${slot}`);
  }
  const account = await ctx.tx.account.findUniqueOrThrow({ where: { id: accountId } });
  if (!account.isPostable || !account.isActive) {
    throw new AppError('VALIDATION', '전기 가능한 사용 중인 계정만 매핑할 수 있습니다.');
  }

  const label = MAPPING_SLOTS.find((s) => s.slot === slot)!.label;
  const before = await ctx.tx.accountMapping.findUnique({ where: { slot } });
  const row = await ctx.tx.accountMapping.upsert({
    where: { slot },
    create: { slot, label, accountId },
    update: { accountId, label },
  });

  await audit.record(ctx, {
    action: 'accountMapping.set',
    entityType: 'AccountMapping',
    entityId: row.id,
    before: before ? { accountId: before.accountId } : undefined,
    after: { slot, accountId, accountCode: account.code },
  });
  return row;
}

/** Resolves a slot to its account id, with a message that says what to fix. */
export async function resolveSlot(ctx: TransactionContext, slot: string): Promise<string> {
  const row = await ctx.tx.accountMapping.findUnique({ where: { slot } });
  if (!row) {
    const label = MAPPING_SLOTS.find((s) => s.slot === slot)?.label ?? slot;
    throw new AppError(
      'VALIDATION',
      `자동분개 계정이 지정되지 않았습니다: ${label}. 회계 > 분개규칙에서 계정을 지정하세요.`,
      { slot },
    );
  }
  return row.accountId;
}
