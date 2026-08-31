'use client';

import { use, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, newRequestId } from '@/lib/trpc';
import { Button, Card, EmptyState, Field, Input, Spinner, StatusBadge } from '@/components/ui/primitives';
import { FormErrorSummary, type FieldError } from '@/components/ui/form-error-summary';
import { PartnerSelect } from '@/components/sales/partner-select';
import {
  useItemResolver,
  TradeLineEditor,
  TradeTotals,
  type TradeLine,
} from '@/components/sales/trade-line-editor';
import { itemLabel } from '@/lib/item-match';
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

interface ApiErrorShape {
  message?: string;
  data?: { appCode?: string };
}

export default function QuotationDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const utils = api.useUtils();
  const refresh = { onSuccess: () => utils.sales.invalidate() };

  const detail = api.sales.quotation.useQuery({ id });
  const copy = api.sales.copyQuotation.useMutation(refresh);
  const setStatus = api.sales.setQuotationStatus.useMutation(refresh);
  const convert = api.sales.convertQuotationToOrder.useMutation(refresh);
  const update = api.sales.updateQuotation.useMutation(refresh);

  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [converting, setConverting] = useState(false);
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [deliveryDate, setDeliveryDate] = useState('');

  // SLS-01: editing a DRAFT quotation's header and lines
  const [editing, setEditing] = useState(false);
  const [editHeader, setEditHeader] = useState({ docDate: '', validUntil: '', partnerId: '', title: '' });
  const [editLines, setEditLines] = useState<TradeLine[]>([]);
  const [formErrors, setFormErrors] = useState<FieldError[]>([]);
  const resolveItems = useItemResolver();

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

  function startEdit() {
    setMessage(null);
    setError(null);
    setFormErrors([]);
    setEditHeader({
      docDate: fmt.date(q.docDate as unknown as string),
      validUntil: q.validUntil ? fmt.date(q.validUntil as unknown as string) : '',
      partnerId: q.partner.id,
      title: q.title ?? '',
    });
    setEditLines(
      q.lines.map((l) => ({
        itemLabel: itemLabel({ name: l.item.name, code: l.item.code }),
        description: l.description ?? '',
        quantity: l.quantity as unknown as string,
        unitPrice: l.unitPrice as unknown as string,
        taxType: l.taxType,
        supplyAmount: l.supplyAmount as unknown as string,
        vatAmount: l.vatAmount as unknown as string,
      })),
    );
    setConverting(false);
    setEditing(true);
  }

  async function submitEdit() {
    setFormErrors([]);
    const entered = editLines.filter((l) => l.itemLabel.trim() || l.quantity.trim());
    // CR-14: the server resolves what was typed, so items outside the suggestion list are found
    const resolved = entered.length > 0 ? await resolveItems(entered.map((l) => l.itemLabel)) : null;
    const prepared =
      resolved && 'ids' in resolved
        ? entered.map((line, i) => ({ index: i, itemId: resolved.ids[i]!, line }))
        : [];

    const problems: FieldError[] = [];
    if (!editHeader.partnerId)
      problems.push({ field: 'qte-partner', label: '거래처', message: '거래처를 선택하세요.' });
    if (entered.length === 0) {
      problems.push({ field: 'qte-lines', label: '품목', message: '품목을 한 건 이상 입력하세요.' });
    } else if (resolved && 'errors' in resolved) {
      for (const message of resolved.errors) problems.push({ field: 'qte-lines', label: '품목', message });
    }
    if (problems.length) {
      setFormErrors(problems);
      return;
    }

    try {
      await update.mutateAsync({
        id,
        version: q.version,
        docDate: editHeader.docDate,
        ...(editHeader.validUntil ? { validUntil: editHeader.validUntil } : {}),
        partnerId: editHeader.partnerId,
        ...(editHeader.title ? { title: editHeader.title } : {}),
        ...(q.note ? { note: q.note } : {}),
        ...(q.divisionId ? { divisionId: q.divisionId } : {}),
        lines: prepared.map((p) => ({
          itemId: p.itemId,
          ...(p.line.description ? { description: p.line.description } : {}),
          quantity: p.line.quantity,
          unitPrice: p.line.unitPrice,
          taxType: (p.line.taxType || 'TAXABLE') as 'TAXABLE',
        })),
        requestId: newRequestId(),
      });
      setEditing(false);
      setMessage('견적서를 수정했습니다.');
    } catch (err) {
      const shape = err as ApiErrorShape;
      if (shape.data?.appCode === 'VERSION_CONFLICT') {
        // the on-screen copy is now stale; refetch instead of retrying with the old version
        await detail.refetch();
      }
      setFormErrors([{ field: 'qte-date', label: '저장', message: shape.message ?? '저장에 실패했습니다.' }]);
    }
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

      {editing ? (
        <Card
          title="견적서 수정"
          actions={
            <Button size="sm" onClick={() => setEditing(false)}>
              닫기
            </Button>
          }
        >
          <FormErrorSummary errors={formErrors} />
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
            <Field label="견적일" htmlFor="qte-date" required>
              <Input
                id="qte-date"
                type="date"
                value={editHeader.docDate}
                onChange={(e) => setEditHeader({ ...editHeader, docDate: e.target.value })}
              />
            </Field>
            <Field label="거래처" htmlFor="qte-partner" required>
              <PartnerSelect
                id="qte-partner"
                partnerType="CUSTOMER"
                value={editHeader.partnerId}
                onChange={(v) => setEditHeader({ ...editHeader, partnerId: v })}
              />
            </Field>
            <Field label="유효기한" htmlFor="qte-valid">
              <Input
                id="qte-valid"
                type="date"
                value={editHeader.validUntil}
                onChange={(e) => setEditHeader({ ...editHeader, validUntil: e.target.value })}
              />
            </Field>
            <Field label="제목" htmlFor="qte-title">
              <Input
                id="qte-title"
                value={editHeader.title}
                onChange={(e) => setEditHeader({ ...editHeader, title: e.target.value })}
              />
            </Field>
          </div>

          <div className="mt-4" id="qte-lines">
            <TradeLineEditor lines={editLines} onChange={setEditLines} />
          </div>
          <TradeTotals lines={editLines} />

          <div className="mt-4 flex gap-1.5">
            <Button variant="primary" size="sm" onClick={submitEdit} disabled={update.isPending}>
              {update.isPending ? '저장 중' : '저장'}
            </Button>
            <Button size="sm" onClick={() => setEditing(false)}>
              취소
            </Button>
          </div>
        </Card>
      ) : (
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
      )}

      <Card title="처리">
        <div className="flex flex-wrap gap-1.5">
          {q.status === 'DRAFT' ? (
            <Button variant="primary" size="sm" onClick={editing ? () => setEditing(false) : startEdit}>
              {editing ? '수정 닫기' : '수정'}
            </Button>
          ) : null}
          {q.status !== 'CANCELED' && q.status !== 'CONVERTED' ? (
            <Button
              variant="primary"
              size="sm"
              onClick={() => {
                setEditing(false);
                setConverting((v) => !v);
              }}
            >
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
