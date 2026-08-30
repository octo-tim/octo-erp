'use client';

import { use, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, newRequestId } from '@/lib/trpc';
import { Button, Card, EmptyState, Input, Spinner, StatusBadge } from '@/components/ui/primitives';
import { fmt } from '@/lib/format';

/**
 * SLS-01 / SLS-02: a quotation with its per-line conversion progress, and the partial
 * conversion form. The remaining quantity is shown on every line because that is what the
 * operator needs to decide how much to convert.
 */
const STATUS_LABEL: Record<string, string> = {
  DRAFT: '작성중',
  CONFIRMED: '확정',
  CONVERTED: '전환완료',
  CANCELED: '취소',
  EXPIRED: '기한만료',
};

export default function QuotationDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const utils = api.useUtils();
  const refresh = { onSuccess: () => utils.sales.invalidate() };

  const detail = api.sales.quotation.useQuery({ id });
  const copy = api.sales.copyQuotation.useMutation(refresh);
  const setStatus = api.sales.setQuotationStatus.useMutation(refresh);
  const convert = api.sales.convertQuotationToOrder.useMutation(refresh);

  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [converting, setConverting] = useState(false);
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [deliveryDate, setDeliveryDate] = useState('');

  if (detail.isLoading) return <Spinner />;
  if (detail.error)
    return <EmptyState title="견적서를 찾을 수 없습니다." description={detail.error.message} />;
  const q = detail.data!;

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

  async function submitConversion() {
    const selected = q.lines
      .filter((l) => (amounts[l.id] ?? '').trim() && Number(amounts[l.id]) > 0)
      .map((l) => ({ sourceLineId: l.id, quantity: amounts[l.id]! }));
    if (selected.length === 0) {
      setError('전환할 수량을 입력하세요.');
      return;
    }
    await run(async () => {
      const order = await convert.mutateAsync({
        quotationId: id,
        lines: selected,
        ...(deliveryDate ? { deliveryDate } : {}),
        requestId: newRequestId(),
      });
      setConverting(false);
      setAmounts({});
      router.push(`/sales/orders/${order.id}`);
    }, '주문으로 전환했습니다.');
  }

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h1 className="text-lg font-semibold">
            견적서 <span className="ml-1 text-sm font-normal text-slate-500">{q.docNo}</span>
          </h1>
          <p className="mt-0.5 text-sm text-slate-500">
            {fmt.date(q.docDate as unknown as string)} · {q.partner.name}
            {q.title ? ` · ${q.title}` : ''}
            {q.validUntil ? ` · 유효기한 ${fmt.date(q.validUntil as unknown as string)}` : ''}
          </p>
        </div>
        <StatusBadge status={q.status} label={STATUS_LABEL[q.status] ?? q.status} />
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
                <th className="px-2 py-1.5 text-right font-medium">수량</th>
                <th className="px-2 py-1.5 text-right font-medium">단가</th>
                <th className="px-2 py-1.5 text-right font-medium">공급가액</th>
                <th className="px-2 py-1.5 text-right font-medium">전환</th>
                <th className="px-2 py-1.5 text-right font-medium">잔여</th>
                {converting ? <th className="px-2 py-1.5 text-right font-medium">전환수량</th> : null}
              </tr>
            </thead>
            <tbody>
              {q.lines.map((l) => (
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
                  <td className="tabular px-2 py-1.5 text-right">
                    {fmt.krw(l.supplyAmount as unknown as string)}
                  </td>
                  <td className="tabular px-2 py-1.5 text-right text-slate-500">{fmt.qty(l.converted)}</td>
                  <td className="tabular px-2 py-1.5 text-right font-medium">{fmt.qty(l.remaining)}</td>
                  {converting ? (
                    <td className="px-2 py-1.5 text-right">
                      <Input
                        aria-label={`${l.item.name} 전환수량`}
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
            <tfoot>
              <tr className="border-t-2 border-slate-300 font-medium">
                <td className="px-2 py-1.5" colSpan={4}>
                  합계 (공급가 {fmt.krw(q.supplyAmount as unknown as string)} · 세액{' '}
                  {fmt.krw(q.vatAmount as unknown as string)})
                </td>
                <td className="tabular px-2 py-1.5 text-right" colSpan={converting ? 4 : 3}>
                  {fmt.krw(q.totalAmount as unknown as string)}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      </Card>

      <Card title="처리">
        <div className="flex flex-wrap gap-1.5">
          {q.status !== 'CANCELED' && q.status !== 'CONVERTED' ? (
            <Button variant="primary" size="sm" onClick={() => setConverting((v) => !v)}>
              {converting ? '전환 닫기' : '주문으로 전환'}
            </Button>
          ) : null}
          <Button
            size="sm"
            onClick={() =>
              run(async () => {
                const c = await copy.mutateAsync({ id, requestId: newRequestId() });
                router.push(`/sales/quotations/${c.id}`);
              }, '견적서를 복사했습니다.')
            }
          >
            복사
          </Button>
          {q.status === 'DRAFT' ? (
            <Button
              size="sm"
              onClick={() =>
                run(
                  () =>
                    setStatus.mutateAsync({
                      id,
                      status: 'CONFIRMED',
                      version: q.version,
                      requestId: newRequestId(),
                    }),
                  '견적을 확정했습니다.',
                )
              }
            >
              견적 확정
            </Button>
          ) : null}
          {q.status !== 'CANCELED' && q.status !== 'CONVERTED' ? (
            <Button
              size="sm"
              variant="danger"
              onClick={() =>
                run(
                  () =>
                    setStatus.mutateAsync({
                      id,
                      status: 'CANCELED',
                      version: q.version,
                      requestId: newRequestId(),
                    }),
                  '견적을 취소했습니다.',
                )
              }
            >
              견적 취소
            </Button>
          ) : null}
        </div>

        {converting ? (
          <div className="mt-3 flex flex-wrap items-end gap-2">
            <div>
              <label className="mb-1 block text-sm text-slate-600" htmlFor="qt-delivery">
                납기일
              </label>
              <Input
                id="qt-delivery"
                type="date"
                value={deliveryDate}
                onChange={(e) => setDeliveryDate(e.target.value)}
              />
            </div>
            <Button variant="primary" size="sm" onClick={submitConversion} disabled={convert.isPending}>
              선택 수량으로 주문 생성
            </Button>
            <p className="w-full text-xs text-slate-500">
              잔여수량 범위 안에서만 전환됩니다. 나머지는 나중에 다시 전환할 수 있습니다.
            </p>
          </div>
        ) : null}
      </Card>
    </div>
  );
}
