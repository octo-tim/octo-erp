'use client';

import { use, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, newRequestId } from '@/lib/trpc';
import { Button, Card, EmptyState, Input, Spinner, StatusBadge } from '@/components/ui/primitives';
import { PartnerSelect } from '@/components/sales/partner-select';
import { fmt } from '@/lib/format';

/**
 * SLS-13: an approved request with its per-line ordering progress, and the partial-order
 * form. Only an approved request can be ordered, which is the point of the approval.
 */
const STATUS_LABEL: Record<string, string> = {
  DRAFT: '작성중',
  PENDING_APPROVAL: '결재중',
  APPROVED: '승인',
  REJECTED: '반려',
  ORDERED: '발주완료',
  CANCELED: '취소',
};

export default function PurchaseRequestDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const utils = api.useUtils();

  const detail = api.sales.purchaseRequest.useQuery({ id });
  const convert = api.sales.convertRequestToOrder.useMutation({
    onSuccess: () => utils.sales.invalidate(),
  });

  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ordering, setOrdering] = useState(false);
  const [partnerId, setPartnerId] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [amounts, setAmounts] = useState<Record<string, string>>({});

  if (detail.isLoading) return <Spinner />;
  if (detail.error)
    return <EmptyState title="구매요청을 찾을 수 없습니다." description={detail.error.message} />;
  const r = detail.data!;
  const orderable = r.status === 'APPROVED' || r.status === 'ORDERED';

  async function submitOrder() {
    setError(null);
    setMessage(null);
    if (!partnerId) {
      setError('발주처를 선택하세요.');
      return;
    }
    const selected = r.lines
      .filter((l) => (amounts[l.id] ?? '').trim() && Number(amounts[l.id]) > 0)
      .map((l) => ({ sourceLineId: l.id, quantity: amounts[l.id]! }));
    if (selected.length === 0) {
      setError('발주할 수량을 입력하세요.');
      return;
    }

    try {
      const order = await convert.mutateAsync({
        requestId: id,
        partnerId,
        lines: selected,
        ...(dueDate ? { dueDate } : {}),
        idempotencyKey: newRequestId(),
      });
      setOrdering(false);
      setAmounts({});
      router.push(`/sales/purchase-orders/${order.id}`);
    } catch (err) {
      setError((err as { message?: string }).message ?? '발주에 실패했습니다.');
    }
  }

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h1 className="text-lg font-semibold">
            구매요청 <span className="ml-1 text-sm font-normal text-slate-500">{r.docNo}</span>
          </h1>
          <p className="mt-0.5 text-sm text-slate-500">
            {fmt.date(r.docDate as unknown as string)}
            {r.purpose ? ` · ${r.purpose}` : ''}
            {r.requiredDate ? ` · 필요일 ${fmt.date(r.requiredDate as unknown as string)}` : ''}
          </p>
        </div>
        <StatusBadge status={r.status} label={STATUS_LABEL[r.status] ?? r.status} />
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

      {!orderable ? (
        <p className="rounded bg-amber-50 px-3 py-2 text-sm text-amber-900">
          구매요청은 결재 승인 후에만 발주할 수 있습니다. 전자결재에서 상신하세요.
        </p>
      ) : null}

      <Card title="품목">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[46rem] text-sm">
            <thead className="border-b border-slate-200 text-left text-slate-500">
              <tr>
                <th className="px-2 py-1.5 font-medium">#</th>
                <th className="px-2 py-1.5 font-medium">품목</th>
                <th className="px-2 py-1.5 text-right font-medium">요청수량</th>
                <th className="px-2 py-1.5 text-right font-medium">단가</th>
                <th className="px-2 py-1.5 text-right font-medium">발주</th>
                <th className="px-2 py-1.5 text-right font-medium">잔여</th>
                {ordering ? <th className="px-2 py-1.5 text-right font-medium">발주수량</th> : null}
              </tr>
            </thead>
            <tbody>
              {r.lines.map((l) => (
                <tr key={l.id} className="border-b border-slate-100">
                  <td className="px-2 py-1.5">{l.lineNo}</td>
                  <td className="px-2 py-1.5">
                    {l.item.name} <span className="text-slate-500">{l.item.code}</span>
                  </td>
                  <td className="tabular px-2 py-1.5 text-right">
                    {fmt.qty(l.quantity as unknown as string)}
                  </td>
                  <td className="tabular px-2 py-1.5 text-right">
                    {fmt.krw(l.unitPrice as unknown as string)}
                  </td>
                  <td className="tabular px-2 py-1.5 text-right text-slate-500">{fmt.qty(l.ordered)}</td>
                  <td className="tabular px-2 py-1.5 text-right font-medium">{fmt.qty(l.remaining)}</td>
                  {ordering ? (
                    <td className="px-2 py-1.5 text-right">
                      <Input
                        aria-label={`${l.item.name} 발주수량`}
                        className="w-24 text-right"
                        inputMode="decimal"
                        disabled={Number(l.remaining) <= 0}
                        value={amounts[l.id] ?? ''}
                        onChange={(e) => setAmounts({ ...amounts, [l.id]: e.target.value })}
                      />
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card title="처리">
        <Button variant="primary" size="sm" disabled={!orderable} onClick={() => setOrdering((v) => !v)}>
          {ordering ? '발주 닫기' : '발주서 생성'}
        </Button>

        {ordering ? (
          <div className="mt-3 flex flex-wrap items-end gap-2">
            <div>
              <label className="mb-1 block text-sm text-slate-600" htmlFor="pr-partner">
                발주처
              </label>
              <PartnerSelect
                id="pr-partner"
                partnerType="SUPPLIER"
                value={partnerId}
                onChange={setPartnerId}
              />
            </div>
            <div>
              <label className="mb-1 block text-sm text-slate-600" htmlFor="pr-due">
                납기일
              </label>
              <Input id="pr-due" type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
            </div>
            <Button variant="primary" size="sm" onClick={submitOrder} disabled={convert.isPending}>
              선택 수량으로 발주
            </Button>
            <p className="w-full text-xs text-slate-500">
              공급처별로 나누어 여러 번 발주할 수 있습니다. 잔여수량 범위 안에서만 처리됩니다.
            </p>
          </div>
        ) : null}
      </Card>
    </div>
  );
}
