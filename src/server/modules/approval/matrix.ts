import type { TransactionContext } from '@/server/core/context';
import * as policy from '@/server/modules/policy/service';
import { cmp, D } from '@/lib/money';

/**
 * DEC-03 / ADR-0005 — which business documents need approval before they can be confirmed.
 * The matrix is a policy version, not a constant, so the threshold can move without a
 * deploy and past documents keep the version they were judged under.
 */

export interface MatrixRule {
  docType: string;
  mode: 'EXEMPT' | 'REQUIRED';
  minAmount?: string;
}

export interface ApprovalMatrix {
  creditLimit: 'BLOCK' | 'WARN';
  rules: MatrixRule[];
}

export interface ApprovalRequirement {
  required: boolean;
  policyVersionId: string;
  reason: string;
}

export async function requirement(
  ctx: TransactionContext,
  docType: string,
  amount: string | number,
  onDate?: string,
): Promise<ApprovalRequirement> {
  const resolved = await policy.resolve<ApprovalMatrix>(ctx, 'approval.matrix', onDate);
  const rule = resolved.config.rules.find((r) => r.docType === docType);

  if (!rule || rule.mode === 'EXEMPT') {
    return { required: false, policyVersionId: resolved.id, reason: '결재 면제 전표유형' };
  }
  if (rule.minAmount === undefined) {
    return { required: true, policyVersionId: resolved.id, reason: '항상 결재 필요' };
  }

  const over = cmp(D(amount), D(rule.minAmount)) >= 0;
  return {
    required: over,
    policyVersionId: resolved.id,
    reason: over ? `금액 ${rule.minAmount}원 이상은 결재 필요` : `금액 ${rule.minAmount}원 미만은 결재 면제`,
  };
}

export async function creditLimitMode(ctx: TransactionContext): Promise<'BLOCK' | 'WARN'> {
  const resolved = await policy.resolve<ApprovalMatrix>(ctx, 'approval.matrix');
  return resolved.config.creditLimit === 'WARN' ? 'WARN' : 'BLOCK';
}
