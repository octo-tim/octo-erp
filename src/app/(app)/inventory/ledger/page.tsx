'use client';

import { Suspense, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { api } from '@/lib/trpc';
import { Button, Card, EmptyState, Field, Input, Select, Spinner } from '@/components/ui/primitives';
import { ItemPicker } from '@/components/ui/item-picker';
import { fmt } from '@/lib/format';
import { businessDate } from '@/lib/dates';

/**
 * INV-05 수불부: opening, every movement with a link back to its source document, and
 * closing. The running balance is on every row so a reader can verify the arithmetic
 * line by line rather than trusting the total.
 */
function firstOfMonth(): string {
  const today = businessDate(new Date());
  return `${today.slice(0, 7)}-01`;
}

function LedgerBook() {
  const params = useSearchParams();
  const [form, setForm] = useState({
    itemId: params.get('itemId') ?? '',
    warehouseId: '',
    from: firstOfMonth(),
    to: businessDate(new Date()),
  });
  const [applied, setApplied] = useState(form);

  const warehouses = api.master.warehouses.useQuery({ activeOnly: true });
  const book = api.inventory.book.useQuery(
    {
      itemId: applied.itemId,
      from: applied.from,
      to: applied.to,
      ...(applied.warehouseId ? { warehouseId: applied.warehouseId } : {}),
    },
    { enabled: Boolean(applied.itemId) },
  );
  // INV-05: the export is the server's own CSV, not a client-side rebuild of the same
  // rows — one formatter, so the download can never drift from what the screen shows.
  const bookCsv = api.inventory.bookCsv.useQuery(
    {
      itemId: applied.itemId,
      from: applied.from,
      to: applied.to,
      ...(applied.warehouseId ? { warehouseId: applied.warehouseId } : {}),
    },
    { enabled: false },
  );

  async function downloadCsv() {
    if (!book.data) return;
    const result = await bookCsv.refetch();
    if (!result.data) return;
    // BOM so Excel opens the Korean headers in UTF-8
    const blob = new Blob([`﻿${result.data.csv}`], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `수불부_${book.data.itemLabel.replace(/[\\/:*?"<>|]/g, '')}_${applied.from}_${applied.to}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <header>
        <h1 className="text-lg font-semibold">수불부</h1>
        <p className="mt-0.5 text-sm text-slate-500">
          기간별 기초·입고·출고·기말과 원천전표를 보여줍니다. 현재고는 재고 원장 합계가 진실입니다.
        </p>
      </header>

      <Card title="조회조건">
        <form
          className="grid grid-cols-1 gap-3 sm:grid-cols-4"
          onSubmit={(e) => {
            e.preventDefault();
            setApplied(form);
          }}
        >
          <Field label="품목" htmlFor="lb-item" required>
            {/* CR-22: a dropdown of the whole master stops working once the master grows */}
            <ItemPicker
              id="lb-item"
              value={form.itemId}
              onChange={(itemId) => setForm({ ...form, itemId })}
            />
          </Field>
          <Field label="창고" htmlFor="lb-wh">
            <Select
              id="lb-wh"
              value={form.warehouseId}
              onChange={(e) => setForm({ ...form, warehouseId: e.target.value })}
            >
              <option value="">전체</option>
              {(warehouses.data ?? []).map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="시작일" htmlFor="lb-from" required>
            <Input
              id="lb-from"
              type="date"
              value={form.from}
              onChange={(e) => setForm({ ...form, from: e.target.value })}
            />
          </Field>
          <Field label="종료일" htmlFor="lb-to" required>
            <Input
              id="lb-to"
              type="date"
              value={form.to}
              onChange={(e) => setForm({ ...form, to: e.target.value })}
            />
          </Field>
          <div className="sm:col-span-4 flex gap-1.5">
            <Button type="submit" variant="primary" size="sm" disabled={!form.itemId}>
              조회
            </Button>
            <Button type="button" size="sm" onClick={downloadCsv} disabled={!book.data}>
              엑셀 내려받기
            </Button>
          </div>
        </form>
      </Card>

      {!applied.itemId ? (
        <EmptyState title="품목을 선택하세요." description="품목과 기간을 지정하면 수불 내역을 보여줍니다." />
      ) : book.isLoading ? (
        <Spinner />
      ) : book.error ? (
        <EmptyState title="조회할 수 없습니다." description={book.error.message} />
      ) : (
        <Card title={`${book.data!.itemLabel} · ${book.data!.from} ~ ${book.data!.to}`}>
          <p className="mb-3 text-sm text-slate-600">
            {book.data!.periodStatus === 'CLOSED'
              ? '해당 월은 재고평가가 마감되어 금액이 확정되었습니다.'
              : '당월은 잠정 평가 금액입니다. 월 마감 시 총평균가로 확정됩니다.'}
          </p>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[52rem] text-sm">
              <thead className="border-b border-slate-200 text-left text-slate-500">
                <tr>
                  <th className="px-2 py-1.5 font-medium">일자</th>
                  <th className="px-2 py-1.5 font-medium">전표</th>
                  <th className="px-2 py-1.5 font-medium">창고</th>
                  <th className="px-2 py-1.5 font-medium">사유</th>
                  <th className="px-2 py-1.5 text-right font-medium">입고</th>
                  <th className="px-2 py-1.5 text-right font-medium">출고</th>
                  <th className="px-2 py-1.5 text-right font-medium">재고수량</th>
                  <th className="px-2 py-1.5 text-right font-medium">재고금액</th>
                </tr>
              </thead>
              <tbody>
                <tr className="border-b border-slate-100 bg-slate-50">
                  <td className="px-2 py-1.5 font-medium" colSpan={4}>
                    기초
                  </td>
                  <td className="px-2 py-1.5" />
                  <td className="px-2 py-1.5" />
                  <td className="tabular px-2 py-1.5 text-right">{fmt.qty(book.data!.opening.quantity)}</td>
                  <td className="tabular px-2 py-1.5 text-right">{fmt.krw(book.data!.opening.amount)}</td>
                </tr>
                {book.data!.rows.map((r) => (
                  <tr key={r.ledgerId} className="border-b border-slate-100">
                    <td className="px-2 py-1.5">{r.occurredAt}</td>
                    <td className="px-2 py-1.5">
                      {r.docNo ? (
                        <Link
                          className="text-blue-700 hover:underline"
                          href={`/inventory/documents/${r.sourceId}`}
                        >
                          {r.docNo}
                        </Link>
                      ) : (
                        <span className="text-slate-500">{r.sourceType}</span>
                      )}
                    </td>
                    <td className="px-2 py-1.5">{r.warehouseName}</td>
                    <td className="px-2 py-1.5">{r.reason ?? '-'}</td>
                    <td className="tabular px-2 py-1.5 text-right">
                      {r.inQty === '0.000' ? '' : fmt.qty(r.inQty)}
                    </td>
                    <td className="tabular px-2 py-1.5 text-right">
                      {r.outQty === '0.000' ? '' : fmt.qty(r.outQty)}
                    </td>
                    <td className="tabular px-2 py-1.5 text-right">{fmt.qty(r.balanceQty)}</td>
                    <td className="tabular px-2 py-1.5 text-right">{fmt.krw(r.balanceAmount)}</td>
                  </tr>
                ))}
                <tr className="border-t-2 border-slate-300 bg-slate-50 font-medium">
                  <td className="px-2 py-1.5" colSpan={4}>
                    기말
                  </td>
                  <td className="tabular px-2 py-1.5 text-right">{fmt.qty(book.data!.totals.inQty)}</td>
                  <td className="tabular px-2 py-1.5 text-right">{fmt.qty(book.data!.totals.outQty)}</td>
                  <td className="tabular px-2 py-1.5 text-right">{fmt.qty(book.data!.closing.quantity)}</td>
                  <td className="tabular px-2 py-1.5 text-right">{fmt.krw(book.data!.closing.amount)}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}

export default function LedgerPage() {
  return (
    <Suspense fallback={<Spinner />}>
      <LedgerBook />
    </Suspense>
  );
}
