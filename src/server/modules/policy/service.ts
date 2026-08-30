import { AppError } from '@/server/core/errors';
import type { TransactionContext } from '@/server/core/context';
import { businessDate, toDateOnly } from '@/lib/dates';

/** Policy keys map 1:1 to DEC-01~09 (docs/decision-register.md). */
export const PolicyKeys = {
  valuation: 'inventory.valuation', // DEC-01
  money: 'money', // DEC-02
  approvalMatrix: 'approval.matrix', // DEC-03
  period: 'accounting.period', // DEC-04
  leave: 'leave', // DEC-05
  retention: 'retention', // DEC-06
  notification: 'notification', // DEC-09
} as const;
export type PolicyKey = (typeof PolicyKeys)[keyof typeof PolicyKeys];

export interface ResolvedPolicy<T> {
  id: string;
  version: number;
  effectiveFrom: string;
  config: T;
}

/**
 * Returns the policy version in force on `onDate` (business date, KST).
 * Past documents keep the version recorded on them — policies are never applied retroactively.
 */
export async function resolve<T>(
  ctx: TransactionContext,
  key: PolicyKey,
  onDate?: string,
): Promise<ResolvedPolicy<T>> {
  const date = onDate ?? businessDate(ctx.now);
  const row = await ctx.tx.policyVersion.findFirst({
    where: { policyKey: key, effectiveFrom: { lte: toDateOnly(date) } },
    orderBy: [{ effectiveFrom: 'desc' }, { version: 'desc' }],
  });
  if (!row) {
    throw new AppError(
      'POLICY_MISSING',
      `${date} 기준으로 적용할 정책(${key})이 없습니다. 정책설정에서 등록하세요.`,
      {
        policyKey: key,
        date,
      },
    );
  }
  return {
    id: row.id,
    version: row.version,
    effectiveFrom: row.effectiveFrom.toISOString().slice(0, 10),
    config: row.config as T,
  };
}

export async function byId<T>(ctx: TransactionContext, policyVersionId: string): Promise<ResolvedPolicy<T>> {
  const row = await ctx.tx.policyVersion.findUniqueOrThrow({ where: { id: policyVersionId } });
  return {
    id: row.id,
    version: row.version,
    effectiveFrom: row.effectiveFrom.toISOString().slice(0, 10),
    config: row.config as T,
  };
}

export async function publish<T>(
  ctx: TransactionContext,
  input: { key: PolicyKey; effectiveFrom: string; config: T; note?: string },
): Promise<ResolvedPolicy<T>> {
  const last = await ctx.tx.policyVersion.findFirst({
    where: { policyKey: input.key },
    orderBy: { version: 'desc' },
  });
  const row = await ctx.tx.policyVersion.create({
    data: {
      policyKey: input.key,
      version: (last?.version ?? 0) + 1,
      effectiveFrom: toDateOnly(input.effectiveFrom),
      config: input.config as never,
      note: input.note ?? null,
      createdById: ctx.actor.userId === 'system' ? null : ctx.actor.userId,
    },
  });
  return { id: row.id, version: row.version, effectiveFrom: input.effectiveFrom, config: input.config };
}

// ── Policy config shapes ──

export interface MoneyPolicy {
  currency: 'KRW';
  amountScale: number;
  quantityScale: number;
  unitPriceScale: number;
  vatRate: string;
  rounding: 'FLOOR';
}

export interface ValuationPolicy {
  method: 'MONTHLY_AVERAGE';
  provisionalWithinMonth: boolean;
  closeAdjusts: boolean;
}

export type ApprovalMode = 'REQUIRED' | 'OPTIONAL' | 'EXEMPT';

export interface ApprovalMatrixPolicy {
  rules: { docType: string; mode: ApprovalMode; minAmount?: string }[];
  creditLimit: 'BLOCK' | 'WARN';
}

export interface PeriodPolicy {
  kind: 'CALENDAR_MONTH';
  reopenPermission: string;
  reversalUsesOpenPeriod: boolean;
}

export interface LeavePolicyConfig {
  basis: 'HIRE_DATE';
  underOneYear: { perMonth: number; max: number };
  baseDays: number;
  bonus: { startYear: number; everyYears: number; days: number; max: number };
  attendanceRateRequired: number;
  deemedAttendance: string[];
  validMonths: number;
  halfDay: boolean;
  weeklyStandardMinutes: number;
  weeklyOvertimeLimitMinutes: number;
  nightStartHour: number;
  nightEndHour: number;
}

export interface RetentionPolicyConfig {
  items: { key: string; label: string; years: number | null; action: 'PURGE' | 'ANONYMIZE' | 'KEEP' }[];
}

export interface NotificationPolicy {
  channels: { app: boolean; email: boolean; messenger: 'NONE' | 'SLACK' | 'KAKAOWORK' | 'NAVERWORKS' };
  backoffMs: number[];
  longPendingBusinessDays: number;
}
