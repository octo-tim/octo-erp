import type { TransactionContext } from '@/server/core/context';
import { AppError } from '@/server/core/errors';
import { requirePermission } from '@/server/modules/rbac/service';
import * as audit from '@/server/modules/audit/service';
import * as account from './account';
import * as journal from './journal';
import { amount, D, ZERO } from '@/lib/money';
import { toDateOnly } from '@/lib/dates';

/**
 * ACC-03 — configurable automatic posting.
 *
 * A rule is a template of lines that name an account *slot* and an *amount key*, never a
 * literal account code or figure. The caller supplies the amounts; the slots resolve
 * through AccountMapping. Rules are versioned with an effective range, and the version
 * used is stored on the entry, so changing a rule tomorrow cannot rewrite what was posted
 * yesterday.
 */

export interface TemplateLine {
  slot: string;
  side: 'DEBIT' | 'CREDIT';
  /** names a figure in the amounts the caller passes: supply, vat, total, cost ... */
  amountKey: string;
  description?: string;
}

export const RULE_CODES = [
  'SALES',
  'PURCHASE',
  'RECEIPT',
  'PAYMENT',
  'RETURN_SALES',
  'RETURN_PURCHASE',
  'VALUATION_ADJUST',
] as const;
export type RuleCode = (typeof RULE_CODES)[number];

export const RULE_LABEL: Record<RuleCode, string> = {
  SALES: '매출',
  PURCHASE: '매입',
  RECEIPT: '수금',
  PAYMENT: '지급',
  RETURN_SALES: '매출반품',
  RETURN_PURCHASE: '매입반품',
  VALUATION_ADJUST: '재고평가 마감조정',
};

/** The baselines the system ships with. A user may publish a new version over any of them. */
export const DEFAULT_TEMPLATES: Record<RuleCode, TemplateLine[]> = {
  SALES: [
    { slot: 'ACCOUNTS_RECEIVABLE', side: 'DEBIT', amountKey: 'total', description: '외상매출금' },
    { slot: 'SALES', side: 'CREDIT', amountKey: 'supply', description: '매출' },
    { slot: 'VAT_PAYABLE', side: 'CREDIT', amountKey: 'vat', description: '부가세예수금' },
    { slot: 'COGS', side: 'DEBIT', amountKey: 'cost', description: '매출원가' },
    { slot: 'INVENTORY', side: 'CREDIT', amountKey: 'cost', description: '재고자산' },
  ],
  PURCHASE: [
    { slot: 'INVENTORY', side: 'DEBIT', amountKey: 'supply', description: '재고자산' },
    { slot: 'VAT_RECEIVABLE', side: 'DEBIT', amountKey: 'vat', description: '부가세대급금' },
    { slot: 'ACCOUNTS_PAYABLE', side: 'CREDIT', amountKey: 'total', description: '외상매입금' },
  ],
  RECEIPT: [
    { slot: 'BANK', side: 'DEBIT', amountKey: 'total', description: '보통예금' },
    { slot: 'ACCOUNTS_RECEIVABLE', side: 'CREDIT', amountKey: 'total', description: '외상매출금 회수' },
  ],
  PAYMENT: [
    { slot: 'ACCOUNTS_PAYABLE', side: 'DEBIT', amountKey: 'total', description: '외상매입금 상환' },
    { slot: 'BANK', side: 'CREDIT', amountKey: 'total', description: '보통예금' },
  ],
  RETURN_SALES: [
    { slot: 'SALES', side: 'DEBIT', amountKey: 'supply', description: '매출 취소' },
    { slot: 'VAT_PAYABLE', side: 'DEBIT', amountKey: 'vat', description: '부가세예수금 취소' },
    { slot: 'ACCOUNTS_RECEIVABLE', side: 'CREDIT', amountKey: 'total', description: '외상매출금 감소' },
    { slot: 'INVENTORY', side: 'DEBIT', amountKey: 'cost', description: '재고자산 복원' },
    { slot: 'COGS', side: 'CREDIT', amountKey: 'cost', description: '매출원가 취소' },
  ],
  RETURN_PURCHASE: [
    { slot: 'ACCOUNTS_PAYABLE', side: 'DEBIT', amountKey: 'total', description: '외상매입금 감소' },
    { slot: 'INVENTORY', side: 'CREDIT', amountKey: 'supply', description: '재고자산 감소' },
    { slot: 'VAT_RECEIVABLE', side: 'CREDIT', amountKey: 'vat', description: '부가세대급금 취소' },
  ],
  // DEC-01: the month-close difference between provisional and confirmed cost of sales
  VALUATION_ADJUST: [
    { slot: 'COGS', side: 'DEBIT', amountKey: 'adjustment', description: '매출원가 마감조정' },
    { slot: 'INVENTORY', side: 'CREDIT', amountKey: 'adjustment', description: '재고자산 마감조정' },
  ],
};

export async function list(ctx: TransactionContext) {
  requirePermission(ctx.actor, 'accounting.read');
  return ctx.tx.postingRule.findMany({
    include: { versions: { orderBy: [{ effectiveFrom: 'desc' }, { version: 'desc' }] } },
    orderBy: { code: 'asc' },
  });
}

/** The version in force for a business date. Past entries keep the version stored on them. */
export async function versionFor(ctx: TransactionContext, code: string, onDate: string) {
  const rule = await ctx.tx.postingRule.findUnique({ where: { code } });
  if (!rule) {
    throw new AppError('VALIDATION', `분개규칙이 없습니다: ${code}. 회계 > 분개규칙에서 등록하세요.`);
  }

  const version = await ctx.tx.postingRuleVersion.findFirst({
    where: {
      ruleId: rule.id,
      isActive: true,
      effectiveFrom: { lte: toDateOnly(onDate) },
      OR: [{ effectiveTo: null }, { effectiveTo: { gte: toDateOnly(onDate) } }],
    },
    orderBy: [{ effectiveFrom: 'desc' }, { version: 'desc' }],
  });
  if (!version) {
    throw new AppError(
      'VALIDATION',
      `${onDate} 기준으로 적용할 분개규칙 버전이 없습니다: ${RULE_LABEL[code as RuleCode] ?? code}.`,
      { code, onDate },
    );
  }
  return version;
}

export async function publish(
  ctx: TransactionContext,
  input: { code: string; effectiveFrom: string; template: TemplateLine[]; note?: string },
) {
  requirePermission(ctx.actor, 'accounting.rules');
  validateTemplate(input.template);

  const rule = await ctx.tx.postingRule.upsert({
    where: { code: input.code },
    create: {
      code: input.code,
      label: RULE_LABEL[input.code as RuleCode] ?? input.code,
      note: input.note ?? null,
    },
    update: { ...(input.note !== undefined ? { note: input.note } : {}) },
  });

  const last = await ctx.tx.postingRuleVersion.findFirst({
    where: { ruleId: rule.id },
    orderBy: { version: 'desc' },
  });

  // the previous version stops the day before the new one starts, so ranges never overlap
  if (last && last.effectiveTo === null) {
    const dayBefore = new Date(toDateOnly(input.effectiveFrom).getTime() - 24 * 60 * 60 * 1000);
    if (dayBefore < last.effectiveFrom) {
      throw new AppError(
        'VALIDATION',
        `적용 시작일이 직전 버전(${last.effectiveFrom.toISOString().slice(0, 10)})보다 빠를 수 없습니다.`,
      );
    }
    await ctx.tx.postingRuleVersion.update({
      where: { id: last.id },
      data: { effectiveTo: dayBefore },
    });
  }

  const version = await ctx.tx.postingRuleVersion.create({
    data: {
      ruleId: rule.id,
      version: (last?.version ?? 0) + 1,
      effectiveFrom: toDateOnly(input.effectiveFrom),
      template: input.template as never,
      createdById: ctx.actor.userId,
    },
  });

  await audit.record(ctx, {
    action: 'postingRule.publish',
    entityType: 'PostingRuleVersion',
    entityId: version.id,
    after: { code: input.code, version: version.version, effectiveFrom: input.effectiveFrom },
  });
  return version;
}

function validateTemplate(template: TemplateLine[]): void {
  if (template.length < 2) throw new AppError('VALIDATION', '분개규칙은 두 줄 이상이어야 합니다.');

  const errors: string[] = [];
  for (const [i, line] of template.entries()) {
    const label = `${i + 1}행`;
    if (!account.MAPPING_SLOTS.some((s) => s.slot === line.slot))
      errors.push(`${label}: 알 수 없는 계정 역할입니다(${line.slot}).`);
    if (line.side !== 'DEBIT' && line.side !== 'CREDIT') errors.push(`${label}: 차변/대변을 지정하세요.`);
    if (!line.amountKey) errors.push(`${label}: 금액 항목을 지정하세요.`);
  }

  const debits = template.filter((l) => l.side === 'DEBIT');
  const credits = template.filter((l) => l.side === 'CREDIT');
  if (debits.length === 0 || credits.length === 0) errors.push('차변과 대변이 각각 한 줄 이상 필요합니다.');

  if (errors.length) throw new AppError('VALIDATION', errors.join('\n'), { errors });
}

export interface PostArgs {
  source: journal.SourceRef;
  entryDate: string;
  /** figures the template's amountKeys draw from; a missing or zero key drops its line */
  amounts: Record<string, string>;
  description?: string;
  divisionId?: string;
  partnerId?: string;
  entryType?: journal.EntryType;
}

/**
 * Builds and posts the entry for one business event. A template line whose amount is zero
 * or absent is dropped — a zero-VAT sale should not carry an empty 부가세 line — and the
 * balance check then applies to what is left, so a template that only balances when every
 * key is present fails loudly rather than posting a lopsided entry.
 */
export async function post(ctx: TransactionContext, code: string, args: PostArgs) {
  const version = await versionFor(ctx, code, args.entryDate);
  const template = version.template as unknown as TemplateLine[];

  const lines: journal.LineInput[] = [];
  for (const line of template) {
    const value = D(args.amounts[line.amountKey] ?? 0);
    if (value.isZero()) continue;
    if (value.isNegative()) {
      throw new AppError(
        'VALIDATION',
        `자동분개 금액은 음수일 수 없습니다: ${line.amountKey}. 반품·취소는 별도 규칙을 사용하세요.`,
        { amountKey: line.amountKey },
      );
    }

    lines.push({
      accountId: await account.resolveSlot(ctx, line.slot),
      ...(line.side === 'DEBIT' ? { debit: amount(value) } : { credit: amount(value) }),
      ...(line.description ? { description: line.description } : {}),
      ...(args.divisionId ? { divisionId: args.divisionId } : {}),
      ...(args.partnerId ? { partnerId: args.partnerId } : {}),
    });
  }

  if (lines.length === 0) {
    throw new AppError('VALIDATION', '자동분개할 금액이 없습니다.', { code });
  }

  return journal.postFromSource(ctx, {
    source: args.source,
    entryDate: args.entryDate,
    ...(args.entryType ? { entryType: args.entryType } : {}),
    description: args.description ?? `${RULE_LABEL[code as RuleCode] ?? code} 자동분개`,
    lines,
    postingRuleVersionId: version.id,
  });
}

/** Preview for the rules screen: what the current template would produce for sample amounts. */
export async function preview(
  ctx: TransactionContext,
  code: string,
  onDate: string,
  amounts: Record<string, string>,
) {
  requirePermission(ctx.actor, 'accounting.read');
  const version = await versionFor(ctx, code, onDate);
  const template = version.template as unknown as TemplateLine[];
  const mapped = await account.mappings(ctx);
  const bySlot = new Map(mapped.map((m) => [m.slot, m.account]));

  let debit = ZERO;
  let credit = ZERO;
  const lines = template
    .map((line) => {
      const value = D(amounts[line.amountKey] ?? 0);
      if (line.side === 'DEBIT') debit = debit.plus(value);
      else credit = credit.plus(value);
      const acc = bySlot.get(line.slot);
      return {
        slot: line.slot,
        accountCode: acc?.code ?? null,
        accountName: acc?.name ?? '(계정 미지정)',
        side: line.side,
        amountKey: line.amountKey,
        amount: amount(value),
        description: line.description ?? '',
      };
    })
    .filter((l) => l.amount !== '0');

  return {
    code,
    version: version.version,
    effectiveFrom: version.effectiveFrom.toISOString().slice(0, 10),
    lines,
    totalDebit: amount(debit),
    totalCredit: amount(credit),
    balanced: debit.eq(credit),
  };
}
