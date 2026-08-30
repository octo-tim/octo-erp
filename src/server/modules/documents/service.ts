import type { TransactionContext } from '@/server/core/context';
import { AppError } from '@/server/core/errors';
import * as salesDocument from '@/server/modules/sales/sales-document';
import * as purchase from '@/server/modules/sales/purchase';
import * as stockDocument from '@/server/modules/inventory/stock-document';
import * as journal from '@/server/modules/accounting/journal';

/**
 * STEP 10 — the one way a business document gets confirmed or cancelled.
 *
 * Every module already knew how to confirm its own document, but each router called its
 * own module directly and so did each approval handler, which left the *ownership*
 * question — may this caller confirm this document at all? — answered separately in each
 * place. This service asks that question once, then delegates to the module that knows the
 * effects. It opens no transaction: the caller's `ctx.tx` is passed straight through, so a
 * confirm and everything it touches stay in one transaction (INT-06).
 *
 * The rule it enforces is APV-08: a document that an approval owns is confirmed by that
 * approval and by nothing else. The DEC-03 amount check inside each module is not enough on
 * its own — it asks "would this document need approval today?", so raising the threshold
 * while a document sits in approval would quietly let someone confirm it out from under a
 * live approval document, leaving the approval APPROVED against a document it never
 * confirmed. Ownership is a fact about the document, not about today's policy, so it is
 * settled by looking for the approval that claims it.
 */

export type BusinessDocumentType =
  'SALES_DOCUMENT' | 'PURCHASE_DOCUMENT' | 'STOCK_DOCUMENT' | 'JOURNAL_ENTRY';

interface DocumentKind {
  label: string;
  confirm(ctx: TransactionContext, id: string, version: number): Promise<unknown>;
  cancel(ctx: TransactionContext, id: string, reason: string, version: number): Promise<unknown>;
}

/** An explicit map, like the approval registry: a missing type is a bug, not a fallback. */
const KINDS: Record<BusinessDocumentType, DocumentKind> = {
  SALES_DOCUMENT: {
    label: '매출전표',
    confirm: (ctx, id, version) => salesDocument.confirm(ctx, id, version),
    cancel: (ctx, id, reason, version) => salesDocument.cancel(ctx, id, reason, version),
  },
  PURCHASE_DOCUMENT: {
    label: '매입전표',
    confirm: (ctx, id, version) => purchase.confirmDocument(ctx, id, version),
    cancel: (ctx, id, reason, version) => purchase.cancelDocument(ctx, id, reason, version),
  },
  STOCK_DOCUMENT: {
    label: '재고전표',
    confirm: (ctx, id, version) => stockDocument.confirm(ctx, id, version),
    cancel: (ctx, id, reason, version) => stockDocument.cancel(ctx, id, reason, version),
  },
  JOURNAL_ENTRY: {
    label: '수동전표',
    confirm: (ctx, id, version) => journal.confirm(ctx, id, version),
    cancel: (ctx, id, reason, version) => journal.cancel(ctx, id, reason, version),
  },
};

function kindOf(type: BusinessDocumentType): DocumentKind {
  const kind = KINDS[type];
  if (!kind) throw new AppError('VALIDATION', `알 수 없는 전표유형입니다: ${type}`);
  return kind;
}

/** Approval documents that still speak for the target. Withdrawn and rejected ones do not. */
const LIVE_APPROVAL = ['DRAFT', 'IN_PROGRESS', 'ON_HOLD'];

interface ApprovalClaim {
  documentId: string;
  docNo: string;
  status: string;
}

/**
 * The approval document, if any, that currently claims this business document. Cancellation
 * approvals are excluded: one of those exists precisely in order to cancel the target, so
 * treating it as a claim would block the cancellation it was raised for.
 */
async function claimOf(
  ctx: TransactionContext,
  type: BusinessDocumentType,
  id: string,
): Promise<ApprovalClaim | null> {
  const links = await ctx.tx.approvalLink.findMany({
    where: { targetType: type, targetId: id },
    include: {
      document: { select: { id: true, docNo: true, status: true, cancelsDocumentId: true } },
    },
    orderBy: { createdAt: 'desc' },
  });

  for (const link of links) {
    if (link.document.cancelsDocumentId) continue;
    if (LIVE_APPROVAL.includes(link.document.status) || link.document.status === 'APPROVED') {
      return { documentId: link.document.id, docNo: link.document.docNo, status: link.document.status };
    }
  }
  return null;
}

/**
 * APV-08. Refuses a direct confirm of a document an approval is carrying. The approval
 * module passes `viaApproval`, which is exactly the caller this rule is making room for.
 */
export async function assertConfirmableBy(
  ctx: TransactionContext,
  type: BusinessDocumentType,
  id: string,
): Promise<void> {
  if (ctx.viaApproval) return;
  const claim = await claimOf(ctx, type, id);
  if (claim && LIVE_APPROVAL.includes(claim.status)) {
    throw new AppError(
      'APPROVAL_REQUIRED',
      `결재 진행 중인 전표입니다. 결재문서 ${claim.docNo}가 승인되면 확정됩니다.`,
      { approvalDocumentId: claim.documentId },
    );
  }
}

/**
 * APV-12. A document that an approval confirmed is cancelled by a cancellation approval, so
 * that the approval record and the document never disagree about what happened.
 */
export async function assertCancellableBy(
  ctx: TransactionContext,
  type: BusinessDocumentType,
  id: string,
): Promise<void> {
  if (ctx.viaApproval) return;
  const claim = await claimOf(ctx, type, id);
  if (!claim) return;
  if (claim.status === 'APPROVED') {
    throw new AppError(
      'CANCEL_BLOCKED',
      `결재로 확정된 전표입니다. 결재문서 ${claim.docNo}에 대해 취소 상신하세요.`,
      { approvalDocumentId: claim.documentId },
    );
  }
  throw new AppError(
    'APPROVAL_REQUIRED',
    `결재 진행 중인 전표입니다. 결재문서 ${claim.docNo}를 회수하거나 반려한 뒤 취소하세요.`,
    { approvalDocumentId: claim.documentId },
  );
}

export async function confirmBusinessDocument(
  ctx: TransactionContext,
  input: { type: BusinessDocumentType; id: string; version: number },
) {
  const kind = kindOf(input.type);
  await assertConfirmableBy(ctx, input.type, input.id);
  return kind.confirm(ctx, input.id, input.version);
}

export async function cancelBusinessDocument(
  ctx: TransactionContext,
  input: { type: BusinessDocumentType; id: string; reason: string; version: number },
) {
  const kind = kindOf(input.type);
  await assertCancellableBy(ctx, input.type, input.id);
  return kind.cancel(ctx, input.id, input.reason, input.version);
}

/** For screens: what the document label is, without importing the map everywhere. */
export function labelOf(type: BusinessDocumentType): string {
  return kindOf(type).label;
}
