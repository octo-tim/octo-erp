'use client';

import { Suspense, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { api, newRequestId } from '@/lib/trpc';
import { Button, Card, EmptyState, Field, Input, Spinner, StatusBadge } from '@/components/ui/primitives';
import { fmt } from '@/lib/format';
import { businessDate } from '@/lib/dates';

/**
 * SLS-11 — returns.
 *
 * A return is a document of its own with positive quantities, linked to the original
 * document and line. That linkage is what lets the system cap the return at what was
 * actually sold and reverse exactly the right stock, receivable and journal amounts.
 */
function ReturnsScreen() {
  const router = useRouter();
  const params = useSearchParams();
  const utils = api.useUtils();

  // the initial value already reads the URL; no effect is needed to sync it
  const [originalId, setOriginalId] = useState(params.get('originalId') ?? '');
  const [docDate, setDocDate] = useState(businessDate(new Date()));
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const original = api.sales.salesDocument.useQuery({ id: originalId }, { enabled: Boolean(originalId) });
  const create = api.sales.createSalesDocument.useMutation({ onSuccess: () => utils.sales.invalidate() });
  const returnList = api.sales.salesDocuments.useQuery({
    docType: 'RETURN_SALES',
    page: 1,
    pageSize: 30,
  });
  const confirmable = api.sales.salesDocuments.useQuery({
    docType: 'SALES',
    status: 'CONFIRMED',
    page: 1,
    pageSize: 50,
  });

  async function submit() {
    setError(null);
    setMessage(null);
    if (!original.data) {
      setError('반품할 원 전표를 선택하세요.');
      return;
    }
    const lines = original.data.lines
      .filter((l) => (amounts[l.id] ?? '').trim() && Number(amounts[l.id]) > 0)
      .map((l) => ({
        itemId: l.itemId,
        quantity: amounts[l.id]!,
        unitPrice: l.unitPrice.toString(),
        taxType: l.taxType as 'TAXABLE',
        originalLineId: l.id,
      }));
    if (lines.length === 0) {
      setError('반품할 수량을 입력하세요.');
      return;
    }

    try {
      const doc = await create.mutateAsync({
        docType: 'RETURN_SALES',
        docDate,
        partnerId: original.data.partnerId,
        warehouseId: original.data.warehouseId,
        originalId: original.data.id,
        lines,
        requestId: newRequestId(),
      });
      setMessage('반품 전표를 생성했습니다. 확정하면 재고와 채권이 원복됩니다.');
      setAmounts({});
      router.push(`/sales/sales-documents/${doc.id}`);
    } catch (err) {
      setError((err as { message?: string }).message ?? '반품 등록에 실패했습니다.');
    }
  }

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <header>
        <h1 className="text-lg font-semibold">반품</h1>
        <p className="mt-0.5 text-sm text-slate-500">
          반품은 음수 수량이 아니라 별도 문서유형입니다. 원 전표와 라인을 연결해 판매한 수량을 넘지 않도록
          제한하고, 확정 시 재고·채권·회계를 원복합니다.
        </p>
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

      <Card title="원 매출전표 선택">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Field label="원 전표" htmlFor="rt-original" required hint="확정된 매출전표만 반품할 수 있습니다">
            <select
              id="rt-original"
              className="h-9 w-full rounded-md border border-slate-300 bg-white px-2 text-sm"
              value={originalId}
              onChange={(e) => {
                setOriginalId(e.target.value);
                setAmounts({});
              }}
            >
              <option value="">선택</option>
              {(confirmable.data?.rows ?? []).map((d) => (
                <option key={d.id} value={d.id}>
                  {d.docNo} · {d.partner.name} · {fmt.krw(d.totalAmount as unknown as string)}
                </option>
              ))}
            </select>
          </Field>
          <Field label="반품일" htmlFor="rt-date" required>
            <Input id="rt-date" type="date" value={docDate} onChange={(e) => setDocDate(e.target.value)} />
          </Field>
        </div>
      </Card>

      {originalId ? (
        original.isLoading ? (
          <Spinner />
        ) : original.error ? (
          <EmptyState title="원 전표를 불러올 수 없습니다." description={original.error.message} />
        ) : (
          <Card title={`반품 수량 입력 · ${original.data!.docNo}`}>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[40rem] text-sm">
                <thead className="border-b border-slate-200 text-left text-slate-500">
                  <tr>
                    <th className="px-2 py-1.5 font-medium">품목</th>
                    <th className="px-2 py-1.5 text-right font-medium">판매수량</th>
                    <th className="px-2 py-1.5 text-right font-medium">단가</th>
                    <th className="px-2 py-1.5 text-right font-medium">반품수량</th>
                  </tr>
                </thead>
                <tbody>
                  {original.data!.lines.map((l) => (
                    <tr key={l.id} className="border-b border-slate-100">
                      <td className="px-2 py-1.5">
                        {l.item.name} <span className="text-slate-500">{l.item.code}</span>
                      </td>
                      <td className="tabular px-2 py-1.5 text-right">
                        {fmt.qty(l.quantity as unknown as string)}
                      </td>
                      <td className="tabular px-2 py-1.5 text-right">
                        {fmt.krw(l.unitPrice as unknown as string)}
                      </td>
                      <td className="px-2 py-1.5 text-right">
                        <Input
                          aria-label={`${l.item.name} 반품수량`}
                          className="w-24 text-right"
                          inputMode="decimal"
                          value={amounts[l.id] ?? ''}
                          onChange={(e) => setAmounts({ ...amounts, [l.id]: e.target.value })}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <Button className="mt-4" variant="primary" size="sm" onClick={submit} disabled={create.isPending}>
              반품전표 생성
            </Button>
            <p className="mt-2 text-xs text-slate-500">
              이미 반품된 수량을 제외한 나머지까지만 입력할 수 있습니다.
            </p>
          </Card>
        )
      ) : null}

      <Card title="반품 내역">
        {returnList.isLoading ? (
          <Spinner />
        ) : (returnList.data?.rows ?? []).length === 0 ? (
          <EmptyState title="반품 전표가 없습니다." />
        ) : (
          <ul className="divide-y divide-slate-100 text-sm">
            {(returnList.data?.rows ?? []).map((r) => (
              <li key={r.id} className="flex flex-wrap items-center gap-3 py-2">
                <Link className="text-blue-700 hover:underline" href={`/sales/sales-documents/${r.id}`}>
                  {r.docNo}
                </Link>
                <span className="text-slate-500">{fmt.date(r.docDate as unknown as string)}</span>
                <span>{r.partner.name}</span>
                <StatusBadge status={r.status} label={r.status === 'CONFIRMED' ? '확정' : r.status} />
                <span className="tabular ml-auto">{fmt.krw(r.totalAmount as unknown as string)}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

export default function ReturnsPage() {
  return (
    <Suspense fallback={<Spinner />}>
      <ReturnsScreen />
    </Suspense>
  );
}
