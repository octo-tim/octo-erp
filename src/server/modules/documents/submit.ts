import type { TransactionContext } from '@/server/core/context';
import { AppError } from '@/server/core/errors';
import * as approval from '@/server/modules/approval/service';
import * as matrix from '@/server/modules/approval/matrix';
import { nextDocNo, DOC_TYPES } from '@/server/modules/numbering/service';
import { amount, D, ZERO } from '@/lib/money';
import type { BusinessDocumentType } from './service';

/**
 * APV-08 / STEP 10 — putting a business document into approval.
 *
 * DEC-03 says a document over the threshold is confirmed by its approval and by nothing
 * else. That rule was enforced but unreachable: nothing turned a sales, purchase or stock
 * document into an approval document, so an over-threshold document could be neither
 * confirmed nor submitted and simply sat there. This is the missing half — one call that
 * reads the business document, drafts the matching approval on the form registered for its
 * target type, and submits it, all inside the caller's transaction.
 *
 * The approval's amount comes from the document rather than from the user, because the
 * approval line is chosen by amount (APV-03): letting a drafter type their own figure would
 * let them pick their own approver.
 */

interface Summary {
  title: string;
  formCode: string;
  amount: string;
  content: Record<string, unknown>;
  version: number;
  divisionId?: string;
}

async function summarize(ctx: TransactionContext, type: BusinessDocumentType, id: string): Promise<Summary> {
  if (type === 'SALES_DOCUMENT') {
    const doc = await ctx.tx.salesDocument.findUnique({ where: { id }, include: { partner: true } });
    if (!doc) throw new AppError('NOT_FOUND', '매출전표를 찾을 수 없습니다.');
    return {
      formCode: 'SALES_DOCUMENT',
      title: `매출전표 ${doc.docNo} ${doc.partner.name}`,
      amount: doc.totalAmount.toString(),
      version: doc.version,
      ...(doc.divisionId ? { divisionId: doc.divisionId } : {}),
      content: { docNo: doc.docNo, partner: doc.partner.name, amount: doc.totalAmount.toString() },
    };
  }

  if (type === 'PURCHASE_DOCUMENT') {
    const doc = await ctx.tx.purchaseDocument.findUnique({ where: { id }, include: { partner: true } });
    if (!doc) throw new AppError('NOT_FOUND', '매입전표를 찾을 수 없습니다.');
    return {
      formCode: 'PURCHASE_DOCUMENT',
      title: `매입전표 ${doc.docNo} ${doc.partner.name}`,
      amount: doc.totalAmount.toString(),
      version: doc.version,
      ...(doc.divisionId ? { divisionId: doc.divisionId } : {}),
      content: { docNo: doc.docNo, partner: doc.partner.name, amount: doc.totalAmount.toString() },
    };
  }

  if (type === 'JOURNAL_ENTRY') {
    const entry = await ctx.tx.journalEntry.findUnique({ where: { id }, include: { lines: true } });
    if (!entry) throw new AppError('NOT_FOUND', '회계전표를 찾을 수 없습니다.');
    const total = amount(entry.lines.reduce((acc, l) => acc.plus(D(l.debit)), ZERO));
    const entryDate = entry.entryDate.toISOString().slice(0, 10);
    return {
      formCode: 'JOURNAL_ENTRY',
      title: `수동전표 ${entry.entryNo}`,
      amount: total,
      version: entry.version,
      content: { entryNo: entry.entryNo, entryDate, amount: total },
    };
  }

  const doc = await ctx.tx.stockDocument.findUnique({
    where: { id },
    include: { fromWarehouse: true, toWarehouse: true },
  });
  if (!doc) throw new AppError('NOT_FOUND', '재고전표를 찾을 수 없습니다.');
  const warehouse = doc.toWarehouse?.name ?? doc.fromWarehouse?.name ?? '';
  return {
    formCode: 'STOCK_DOCUMENT',
    title: `재고전표 ${doc.docNo} ${warehouse}`,
    amount: doc.totalAmount.toString(),
    version: doc.version,
    ...(doc.divisionId ? { divisionId: doc.divisionId } : {}),
    content: { docNo: doc.docNo, warehouse, amount: doc.totalAmount.toString() },
  };
}

/** The docType the DEC-03 matrix is keyed by, for the "does this even need approval" check. */
async function matrixDocType(
  ctx: TransactionContext,
  type: BusinessDocumentType,
  id: string,
): Promise<string> {
  if (type === 'SALES_DOCUMENT') {
    const d = await ctx.tx.salesDocument.findUniqueOrThrow({ where: { id }, select: { docType: true } });
    return d.docType;
  }
  if (type === 'PURCHASE_DOCUMENT') {
    const d = await ctx.tx.purchaseDocument.findUniqueOrThrow({
      where: { id },
      select: { docType: true },
    });
    return d.docType;
  }
  if (type === 'JOURNAL_ENTRY') return 'JOURNAL';
  const d = await ctx.tx.stockDocument.findUniqueOrThrow({ where: { id }, select: { docType: true } });
  return d.docType === 'ISSUE' ? 'STOCK_OUT' : d.docType === 'ADJUST' ? 'STOCK_ADJUST' : 'STOCK_IN';
}

export async function submitForApproval(
  ctx: TransactionContext,
  input: {
    type: BusinessDocumentType;
    id: string;
    version: number;
    note?: string;
    lineTemplateId?: string;
  },
) {
  const summary = await summarize(ctx, input.type, input.id);
  if (summary.version !== input.version) {
    throw new AppError('VERSION_CONFLICT', '전표가 변경되었습니다. 새로 고친 뒤 다시 상신하세요.');
  }

  // Submitting a document that needs no approval would create a document nobody has to
  // read and would still block direct confirmation while it sat in someone's inbox.
  const req = await matrix.requirement(ctx, await matrixDocType(ctx, input.type, input.id), summary.amount);
  if (!req.required) {
    throw new AppError('VALIDATION', `${req.reason}. 결재 없이 바로 확정할 수 있습니다.`, {
      policyVersionId: req.policyVersionId,
    });
  }

  const docNo = await nextDocNo(ctx, DOC_TYPES.APPROVAL);
  const document = await approval.draft(ctx, {
    docNo,
    formCode: summary.formCode,
    title: summary.title,
    content: { ...summary.content, ...(input.note ? { note: input.note } : {}) },
    amount: summary.amount,
    ...(summary.divisionId ? { divisionId: summary.divisionId } : {}),
    target: { targetType: input.type, targetId: input.id, targetVersion: summary.version },
  });

  return approval.submit(ctx, {
    documentId: document.id,
    version: document.version,
    ...(input.lineTemplateId ? { lineTemplateId: input.lineTemplateId } : {}),
  });
}

/**
 * APV-12 — the other direction: a confirmed document is cancelled by raising a cancellation
 * approval against the approval that confirmed it, so the two records never disagree.
 */
export async function submitCancellation(
  ctx: TransactionContext,
  input: { type: BusinessDocumentType; id: string; reason: string },
) {
  const link = await ctx.tx.approvalLink.findFirst({
    where: { targetType: input.type, targetId: input.id },
    include: { document: { select: { id: true, status: true, cancelsDocumentId: true } } },
    orderBy: { createdAt: 'desc' },
  });
  const original = link && !link.document.cancelsDocumentId ? link.document : null;
  if (!original || original.status !== 'APPROVED') {
    throw new AppError('VALIDATION', '결재로 확정된 전표가 아닙니다. 전표 화면에서 직접 취소하세요.');
  }

  const docNo = await nextDocNo(ctx, DOC_TYPES.APPROVAL);
  return approval.requestCancel(ctx, { docNo, documentId: original.id, reason: input.reason });
}
