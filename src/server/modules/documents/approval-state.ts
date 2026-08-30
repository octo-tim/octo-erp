import type { TransactionContext } from '@/server/core/context';
import type { BusinessDocumentType } from './service';

/**
 * What the detail screens show: the approval that owns this document, if any, plus the
 * cancellation approval raised against it. A screen that knows this can offer the one
 * action that will actually work instead of a confirm button that is certain to be refused.
 */
export async function approvalStateOf(ctx: TransactionContext, type: BusinessDocumentType, id: string) {
  const links = await ctx.tx.approvalLink.findMany({
    where: { targetType: type, targetId: id },
    include: {
      document: { select: { id: true, docNo: true, status: true, cancelsDocumentId: true } },
    },
    orderBy: { createdAt: 'desc' },
  });

  const own = links.map((l) => l.document).find((d) => !d.cancelsDocumentId) ?? null;
  const cancellation = own
    ? await ctx.tx.approvalDocument.findUnique({
        where: { cancelsDocumentId: own.id },
        select: { id: true, docNo: true, status: true },
      })
    : null;

  return {
    approval: own ? { id: own.id, docNo: own.docNo, status: own.status } : null,
    cancellationApproval: cancellation,
  };
}
