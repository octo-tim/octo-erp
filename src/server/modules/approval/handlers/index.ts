import type { TransactionContext } from '@/server/core/context';
import { AppError } from '@/server/core/errors';

/**
 * docs/transaction-contract.md §5. The approval module never imports a business module
 * directly — it goes through a handler registered here for the document's `targetType`.
 * The map is explicit (not runtime discovery), so a missing handler is a startup-visible
 * mistake rather than a silent no-op at approval time.
 */
export interface ApprovalTarget {
  targetType: string;
  targetId: string;
  targetVersion: number;
}

export interface ApprovalTargetHandler {
  targetType: string;
  /** Human label used in the approval inbox. */
  label: string;
  /** Checked when the document is submitted: state, amount, locks. */
  validateBeforeSubmit(ctx: TransactionContext, target: ApprovalTarget): Promise<void>;
  /**
   * Checked when a CANCELLATION document is submitted. The target is APPROVED at this
   * point, so the normal submit checks would reject it. Defaults to "cancellation is not
   * supported" when a handler does not implement it.
   */
  validateBeforeCancelSubmit?(ctx: TransactionContext, target: ApprovalTarget): Promise<void>;
  /**
   * The target's current optimistic-lock version. A cancellation document links to the
   * target at its version *now*, which the business module owns — the approval module
   * must not guess it.
   */
  currentVersion(ctx: TransactionContext, targetId: string): Promise<number>;
  /** Runs in the SAME transaction as the final approval. */
  onApproved(ctx: TransactionContext, target: ApprovalTarget, documentId: string): Promise<void>;
  onRejected(ctx: TransactionContext, target: ApprovalTarget, documentId: string): Promise<void>;
  onCanceled(ctx: TransactionContext, target: ApprovalTarget, documentId: string): Promise<void>;
}

const handlers = new Map<string, ApprovalTargetHandler>();

export function registerHandler(handler: ApprovalTargetHandler): void {
  handlers.set(handler.targetType, handler);
}

export function resolveHandler(targetType: string): ApprovalTargetHandler {
  const handler = handlers.get(targetType);
  if (!handler) {
    throw new AppError('VALIDATION', `연동 처리기가 등록되지 않은 결재 대상입니다: ${targetType}`, {
      targetType,
    });
  }
  return handler;
}

export function hasHandler(targetType: string): boolean {
  return handlers.has(targetType);
}

export function registeredTargetTypes(): string[] {
  return [...handlers.keys()].sort();
}

/** Test seam: integration tests register fakes and must be able to clear them. */
export function __resetHandlers(): void {
  handlers.clear();
}
