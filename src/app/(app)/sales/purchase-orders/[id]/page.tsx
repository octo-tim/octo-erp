'use client';

import { use, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, newRequestId } from '@/lib/trpc';
import { Button, Card, EmptyState, Input, Select, Spinner, StatusBadge } from '@/components/ui/primitives';
import { fmt } from '@/lib/format';
import { businessDate } from '@/lib/dates';

/** SLS-13: a purchase order with its receiving progress and the partial-receipt form. */
const STATUS_LABEL: Record<string, string> = {
  DRAFT: '작성중',
  ORDERED: '발주',
  RECEIVING: '입고중',
  COMPLETED: '완료',
  CANCELED: '취소',
};

export default function PurchaseOrderDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const utils = api.useUtils();

  const detail = api.sales.purchaseOrder.useQuery({ id });
  const warehouses = api.master.warehouses.useQuery({ activeOnly: true });
  const createDoc = api.sales.createPurchaseDocument.useMutation({
    onSuccess: () => utils.sales.invalidate(),
  });

  const [error, setError] = useState<string | null>(null);
  const [receiving, setReceiving] = useState(false);
  const [warehouseId, setWarehouseId] = useState('');
  const [docDate, setDocDate] = useState(businessDate(new Date()));
  const [amounts, setAmounts] = useState<Record<string, string>>({});

  if (detail.isLoading) return <Spinner />;
  if (detail.error)
    return <EmptyState title="발주서를 찾을 수 없습니다." description={detail.error.message} />;
  const o = detail.data!;

  async function submitReceipt() {
    setError(null);
    if (!warehouseId) {
      setError('입고 창고를 선택하세요.');
      return;
    }
    const selected = o.lines
      .filter((l) => (amounts[l.id] ?? '').trim() && Number(amounts[l.id]) > 0)
      .map((l) => ({
        itemId: l.itemId,
        quantity: amounts[l.id]!,
        unitPrice: l.unitPrice.toString(),
        taxType: l.taxType as 'TAXABLE',
        sourceLineId: l.id,
      }));
    if (selected.length === 0) {
      setError('입고할 수량을 입력하세요.');
      return;
    }

    try {
      const doc = await createDoc.mutateAsync({
        docDate,
        partnerId: o.partnerId,
        warehouseId,
        lines: selected,
        requestId: newRequestId(),
      });
      setReceiving(false);
      setAmounts({});
      router.push(`/sales/purchase-documents/${doc.id}`);
    } catch (err) {
      setError((err as { message?: string }).message ?? '입고 처리에 실패했습니다.');
    }
  }

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h1 className="text-lg font-semibold">
            발주서 <span className="ml-1 text-sm font-normal text-slate-500">{o.docNo}</span>
          </h1>
          <p className="mt-0.5 text-sm text-slate-500">
            {fmt.date(o.docDate as unknown as string)} · {o.partner.name}
            {o.dueDate ? ` · 납기 ${fmt.date(o.dueDate as unknown as string)}` : ''}
          </p>
        </div>
        <StatusBadge status={o.status} label={STATUS_LABEL[o.status] ?? o.status} />
      </header>

      {error ? (
        <p role="alert" className="whitespace-pre-line rounded bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      ) : null}

      <Card title="품목">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[46rem] text-sm">
            <thead className="border-b border-slate-200 text-left text-slate-500">
              <tr>
                <th className="px-2 py-1.5 font-medium">#</th>
                <th className="px-2 py-1.5 font-medium">품목</th>
                <th className="px-2 py-1.5 text-right font-medium">발주수량</th>
                <th className="px-2 py-1.5 text-right font-medium">단가</th>
                <th className="px-2 py-1.5 text-right font-medium">입고</th>
                <th className="px-2 py-1.5 text-right font-medium">잔여</th>
                {receiving ? <th className="px-2 py-1.5 text-right font-medium">입고수량</th> : null}
              </tr>
            </thead>
            <tbody>
              {o.lines.map((l) => (
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
                  <td className="tabular px-2 py-1.5 text-right text-slate-500">{fmt.qty(l.received)}</td>
                  <td className="tabular px-2 py-1.5 text-right font-medium">{fmt.qty(l.remaining)}</td>
                  {receiving ? (
                    <td className="px-2 py-1.5 text-right">
                      <Input
                        aria-label={`${l.item.name} 입고수량`}
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
        <Button
          variant="primary"
          size="sm"
          disabled={o.status === 'CANCELED' || o.status === 'COMPLETED'}
          onClick={() => setReceiving((v) => !v)}
        >
          {receiving ? '입고 닫기' : '매입전표 생성(입고)'}
        </Button>

        {receiving ? (
          <div className="mt-3 flex flex-wrap items-end gap-2">
            <div>
              <label className="mb-1 block text-sm text-slate-600" htmlFor="po-date">
                전표일
              </label>
              <Input id="po-date" type="date" value={docDate} onChange={(e) => setDocDate(e.target.value)} />
            </div>
            <div>
              <label className="mb-1 block text-sm text-slate-600" htmlFor="po-wh">
                입고 창고
              </label>
              <Select id="po-wh" value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)}>
                <option value="">선택</option>
                {(warehouses.data ?? []).map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))}
              </Select>
            </div>
            <Button variant="primary" size="sm" onClick={submitReceipt} disabled={createDoc.isPending}>
              매입전표 생성
            </Button>
          </div>
        ) : null}
      </Card>
    </div>
  );
}
