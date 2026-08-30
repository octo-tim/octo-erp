'use client';

import { use, useState } from 'react';
import Link from 'next/link';
import { api, newRequestId } from '@/lib/trpc';
import { ApprovalActions } from '@/components/documents/approval-actions';
import { Button, Card, EmptyState, Input, Spinner, StatusBadge } from '@/components/ui/primitives';
import { fmt } from '@/lib/format';

/** SLS-06 / SLS-11: one purchase document with the payable and journal entry it produced. */
const STATUS_LABEL: Record<string, string> = {
  DRAFT: '작성중',
  PENDING_APPROVAL: '결재중',
  CONFIRMED: '확정',
  CANCELED: '취소',
};
const TAX_LABEL: Record<string, string> = { TAXABLE: '과세', ZERO: '영세', EXEMPT: '면세' };

export default function PurchaseDocumentDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const utils = api.useUtils();
  const refresh = { onSuccess: () => utils.sales.invalidate() };

  const detail = api.sales.purchaseDocument.useQuery({ id });
  const confirm = api.sales.confirmPurchaseDocument.useMutation(refresh);
  const cancel = api.sales.cancelPurchaseDocument.useMutation(refresh);
  const submitApproval = api.sales.submitPurchaseDocumentForApproval.useMutation(refresh);
  const submitCancellation = api.sales.submitPurchaseDocumentCancellation.useMutation(refresh);

  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cancelReason, setCancelReason] = useState('');
  const [cancelling, setCancelling] = useState(false);

  if (detail.isLoading) return <Spinner />;
  if (detail.error) return <EmptyState title="전표를 찾을 수 없습니다." description={detail.error.message} />;
  const d = detail.data!;
  const isReturn = d.docType === 'RETURN_PURCHASE';

  async function run(fn: () => Promise<unknown>, ok: string) {
    setError(null);
    setMessage(null);
    try {
      await fn();
      setMessage(ok);
    } catch (err) {
      setError((err as { message?: string }).message ?? '처리에 실패했습니다.');
    }
  }

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h1 className="text-lg font-semibold">
            {isReturn ? '매입반품' : '매입전표'}{' '}
            <span className="ml-1 text-sm font-normal text-slate-500">{d.docNo}</span>
          </h1>
          <p className="mt-0.5 text-sm text-slate-500">
            {fmt.date(d.docDate as unknown as string)} · {d.partner.name} · {d.warehouse.name}
          </p>
        </div>
        <StatusBadge status={d.status} label={STATUS_LABEL[d.status] ?? d.status} />
      </header>

      {message ? (
        <p role="status" className="rounded bg-green-50 px-3 py-2 text-sm text-green-800">
          {message}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="whitespace-pre-line rounded bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      ) : null}

      <Card title="품목">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[44rem] text-sm">
            <thead className="border-b border-slate-200 text-left text-slate-500">
              <tr>
                <th className="px-2 py-1.5 font-medium">#</th>
                <th className="px-2 py-1.5 font-medium">품목</th>
                <th className="px-2 py-1.5 font-medium">과세</th>
                <th className="px-2 py-1.5 text-right font-medium">수량</th>
                <th className="px-2 py-1.5 text-right font-medium">단가</th>
                <th className="px-2 py-1.5 text-right font-medium">공급가액</th>
                <th className="px-2 py-1.5 text-right font-medium">세액</th>
              </tr>
            </thead>
            <tbody>
              {d.lines.map((l) => (
                <tr key={l.id} className="border-b border-slate-100">
                  <td className="px-2 py-1.5">{l.lineNo}</td>
                  <td className="px-2 py-1.5">
                    {l.item.name} <span className="text-slate-500">{l.item.code}</span>
                  </td>
                  <td className="px-2 py-1.5">{TAX_LABEL[l.taxType] ?? l.taxType}</td>
                  <td className="tabular px-2 py-1.5 text-right">
                    {fmt.qty(l.quantity as unknown as string)} {l.item.unitCode}
                  </td>
                  <td className="tabular px-2 py-1.5 text-right">
                    {fmt.krw(l.unitPrice as unknown as string)}
                  </td>
                  <td className="tabular px-2 py-1.5 text-right">
                    {fmt.krw(l.supplyAmount as unknown as string)}
                  </td>
                  <td className="tabular px-2 py-1.5 text-right">
                    {fmt.krw(l.vatAmount as unknown as string)}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t-2 border-slate-300 font-semibold">
                <td className="px-2 py-1.5" colSpan={5}>
                  총액
                </td>
                <td className="tabular px-2 py-1.5 text-right" colSpan={2}>
                  {fmt.krw(d.totalAmount as unknown as string)}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      </Card>

      <Card title="처리">
        <div className="mb-3 flex flex-col gap-2">
          <ApprovalActions
            idPrefix="pd-apv"
            status={d.status}
            approvalRequired={d.approvalRequired}
            approvalReason={d.approvalReason}
            approval={d.approval}
            cancellationApproval={d.cancellationApproval}
            onSubmitForApproval={(note) =>
              run(
                () =>
                  submitApproval.mutateAsync({
                    id,
                    version: d.version,
                    ...(note ? { note } : {}),
                    requestId: newRequestId(),
                  }),
                '결재를 상신했습니다. 승인되면 전표가 확정됩니다.',
              )
            }
            onSubmitCancellation={(reason) =>
              run(
                () => submitCancellation.mutateAsync({ id, reason, requestId: newRequestId() }),
                '취소 결재를 상신했습니다. 승인되면 전표가 취소됩니다.',
              )
            }
          />
        </div>
        <div className="flex flex-wrap gap-1.5">
          {(d.status === 'DRAFT' || d.status === 'PENDING_APPROVAL') && !d.approvalRequired ? (
            <Button
              variant="primary"
              size="sm"
              onClick={() =>
                run(
                  () => confirm.mutateAsync({ id, version: d.version, requestId: newRequestId() }),
                  '확정했습니다. 재고·미지급금·회계 분개가 함께 반영되었습니다.',
                )
              }
            >
              확정
            </Button>
          ) : null}
          {d.status !== 'CANCELED' && d.approval?.status !== 'APPROVED' ? (
            <Button size="sm" variant="danger" onClick={() => setCancelling((v) => !v)}>
              {cancelling ? '취소 닫기' : '전표 취소'}
            </Button>
          ) : null}
        </div>

        {cancelling ? (
          <div className="mt-3 flex flex-wrap items-end gap-2">
            <div className="min-w-0 flex-1">
              <label className="mb-1 block text-sm text-slate-600" htmlFor="pd-cancel-reason">
                취소 사유
              </label>
              <Input
                id="pd-cancel-reason"
                value={cancelReason}
                onChange={(e) => setCancelReason(e.target.value)}
              />
            </div>
            <Button
              size="sm"
              variant="danger"
              disabled={cancelReason.trim().length < 2}
              onClick={() =>
                run(async () => {
                  await cancel.mutateAsync({
                    id,
                    reason: cancelReason,
                    version: d.version,
                    requestId: newRequestId(),
                  });
                  setCancelling(false);
                  setCancelReason('');
                }, '취소했습니다. 재고 반대원장·채무 원복·회계 역분개가 생성되었습니다.')
              }
            >
              취소 확정
            </Button>
          </div>
        ) : null}

        {d.status === 'CANCELED' && d.cancelReason ? (
          <p className="mt-3 text-sm text-slate-600">취소 사유: {d.cancelReason}</p>
        ) : null}
      </Card>

      <Card title="연결된 기록">
        <dl className="grid grid-cols-[8rem_1fr] gap-y-2 text-sm">
          <dt className="text-slate-500">미지급금</dt>
          <dd>
            {d.payable ? (
              <>
                {fmt.krw(d.payable.amount as unknown as string)}원 · 지급{' '}
                {fmt.krw(d.payable.settledAmount as unknown as string)}원 · {d.payable.status}
              </>
            ) : (
              '확정 시 생성됩니다.'
            )}
          </dd>
          <dt className="text-slate-500">회계 분개</dt>
          <dd>
            {d.journalEntry ? (
              <Link
                className="text-blue-700 hover:underline"
                href={`/accounting/journals/${d.journalEntry.id}`}
              >
                {d.journalEntry.entryNo}
              </Link>
            ) : (
              '확정 시 생성됩니다.'
            )}
          </dd>
        </dl>
      </Card>
    </div>
  );
}
