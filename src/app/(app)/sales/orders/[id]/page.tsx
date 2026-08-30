'use client';

import { use, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { api, newRequestId } from '@/lib/trpc';
import { Button, Card, EmptyState, Input, Select, Spinner, StatusBadge } from '@/components/ui/primitives';
import { fmt } from '@/lib/format';
import { businessDate } from '@/lib/dates';

/**
 * SLS-03 / SLS-04: an order with its delivery progress per line, and the partial-delivery
 * form that turns remaining quantity into a sales document.
 */
const STATUS_LABEL: Record<string, string> = {
  DRAFT: '작성중',
  ACCEPTED: '접수',
  IN_PROGRESS: '진행중',
  COMPLETED: '완료',
  CANCELED: '취소',
};

export default function SalesOrderDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const utils = api.useUtils();
  const refresh = { onSuccess: () => utils.sales.invalidate() };

  const detail = api.sales.salesOrder.useQuery({ id });
  const warehouses = api.master.warehouses.useQuery({ activeOnly: true });
  const createDoc = api.sales.createSalesDocument.useMutation(refresh);
  const cancelOrder = api.sales.cancelSalesOrder.useMutation(refresh);

  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [delivering, setDelivering] = useState(false);
  const [warehouseId, setWarehouseId] = useState('');
  const [docDate, setDocDate] = useState(businessDate(new Date()));
  const [amounts, setAmounts] = useState<Record<string, string>>({});

  if (detail.isLoading) return <Spinner />;
  if (detail.error)
    return <EmptyState title="주문서를 찾을 수 없습니다." description={detail.error.message} />;
  const o = detail.data!;

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

  async function submitDelivery() {
    if (!warehouseId) {
      setError('출고 창고를 선택하세요.');
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
      setError('출고할 수량을 입력하세요.');
      return;
    }

    await run(async () => {
      const doc = await createDoc.mutateAsync({
        docDate,
        partnerId: o.partnerId,
        warehouseId,
        ...(o.divisionId ? { divisionId: o.divisionId } : {}),
        lines: selected,
        requestId: newRequestId(),
      });
      setDelivering(false);
      setAmounts({});
      router.push(`/sales/sales-documents/${doc.id}`);
    }, '매출전표를 생성했습니다.');
  }

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h1 className="text-lg font-semibold">
            주문서 <span className="ml-1 text-sm font-normal text-slate-500">{o.docNo}</span>
          </h1>
          <p className="mt-0.5 text-sm text-slate-500">
            {fmt.date(o.docDate as unknown as string)} · {o.partner.name}
            {o.deliveryDate ? ` · 납기 ${fmt.date(o.deliveryDate as unknown as string)}` : ''}
          </p>
        </div>
        <StatusBadge status={o.status} label={STATUS_LABEL[o.status] ?? o.status} />
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
          <table className="w-full min-w-[48rem] text-sm">
            <thead className="border-b border-slate-200 text-left text-slate-500">
              <tr>
                <th className="px-2 py-1.5 font-medium">#</th>
                <th className="px-2 py-1.5 font-medium">품목</th>
                <th className="px-2 py-1.5 text-right font-medium">주문수량</th>
                <th className="px-2 py-1.5 text-right font-medium">단가</th>
                <th className="px-2 py-1.5 text-right font-medium">출고</th>
                <th className="px-2 py-1.5 text-right font-medium">잔여</th>
                {delivering ? <th className="px-2 py-1.5 text-right font-medium">출고수량</th> : null}
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
                  <td className="tabular px-2 py-1.5 text-right text-slate-500">{fmt.qty(l.delivered)}</td>
                  <td className="tabular px-2 py-1.5 text-right font-medium">{fmt.qty(l.remaining)}</td>
                  {delivering ? (
                    <td className="px-2 py-1.5 text-right">
                      <Input
                        aria-label={`${l.item.name} 출고수량`}
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
        <div className="flex flex-wrap gap-1.5">
          {o.status !== 'CANCELED' && o.status !== 'COMPLETED' ? (
            <Button variant="primary" size="sm" onClick={() => setDelivering((v) => !v)}>
              {delivering ? '출고 닫기' : '매출전표 생성(출고)'}
            </Button>
          ) : null}
          {o.status !== 'CANCELED' ? (
            <Button
              size="sm"
              variant="danger"
              onClick={() =>
                run(
                  () =>
                    cancelOrder.mutateAsync({
                      id,
                      reason: '주문 취소',
                      version: o.version,
                      requestId: newRequestId(),
                    }),
                  '주문을 취소했습니다.',
                )
              }
            >
              주문 취소
            </Button>
          ) : null}
        </div>

        {delivering ? (
          <div className="mt-3 flex flex-wrap items-end gap-2">
            <div>
              <label className="mb-1 block text-sm text-slate-600" htmlFor="so-date">
                전표일
              </label>
              <Input id="so-date" type="date" value={docDate} onChange={(e) => setDocDate(e.target.value)} />
            </div>
            <div>
              <label className="mb-1 block text-sm text-slate-600" htmlFor="so-wh">
                출고 창고
              </label>
              <Select id="so-wh" value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)}>
                <option value="">선택</option>
                {(warehouses.data ?? []).map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))}
              </Select>
            </div>
            <Button variant="primary" size="sm" onClick={submitDelivery} disabled={createDoc.isPending}>
              매출전표 생성
            </Button>
          </div>
        ) : null}
      </Card>

      <Card title="출고 내역 (SLS-04)">
        {o.deliveries.length === 0 ? (
          <EmptyState title="아직 출고된 전표가 없습니다." />
        ) : (
          <ul className="divide-y divide-slate-100 text-sm">
            {o.deliveries.map((d) => (
              <li key={d.id} className="flex flex-wrap items-center gap-3 py-2">
                <Link className="text-blue-700 hover:underline" href={`/sales/sales-documents/${d.id}`}>
                  {d.docNo}
                </Link>
                <span className="text-slate-500">{fmt.date(d.docDate as unknown as string)}</span>
                <span className="text-slate-500">{d.status}</span>
                <span className="tabular ml-auto">{fmt.krw(d.totalAmount as unknown as string)}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
