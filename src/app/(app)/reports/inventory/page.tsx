'use client';

import { useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/trpc';
import { fmt } from '@/lib/format';
import { Spinner } from '@/components/ui/primitives';
import { ReportFilterBar, currentMonth, type ReportFilterValue } from '@/components/report/report-filter-bar';
import { ReportTable, type ReportColumn } from '@/components/report/report-table';

/** RPT-04: on-hand quantity and value by warehouse, as of the end of the period. */
type Row = {
  itemId: string;
  code: string;
  name: string;
  warehouseName: string;
  categoryName: string;
  quantity: string;
  amount: string;
  safetyStock: string | null;
  belowSafety: boolean;
};

export default function InventoryReportPage() {
  const [filter, setFilter] = useState<ReportFilterValue>(currentMonth());
  const [applied, setApplied] = useState<ReportFilterValue>(filter);
  const [onlyBelow, setOnlyBelow] = useState(false);
  const q = api.report.stockStatus.useQuery({ filter: applied });

  const all = (q.data?.rows ?? []) as Row[];
  const rows = onlyBelow ? all.filter((r) => r.belowSafety) : all;

  const columns: ReportColumn<Row>[] = [
    {
      key: 'code',
      header: '품목코드',
      render: (r) => (
        <Link className="underline" href={`/inventory/ledger?itemId=${r.itemId}`}>
          {r.code}
        </Link>
      ),
    },
    { key: 'name', header: '품목명', emphasise: (r) => r.belowSafety },
    { key: 'categoryName', header: '분류' },
    { key: 'warehouseName', header: '창고' },
    {
      key: 'quantity',
      header: '수량',
      numeric: true,
      render: (r) => fmt.qty(r.quantity),
      emphasise: (r) => r.belowSafety,
    },
    {
      key: 'safetyStock',
      header: '안전재고',
      numeric: true,
      render: (r) => (r.safetyStock ? fmt.qty(r.safetyStock) : '-'),
    },
    { key: 'amount', header: '재고금액', numeric: true, render: (r) => fmt.krw(r.amount) },
  ];

  const period = `${applied.to} 기준`;

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <header>
        <h1 className="text-lg font-semibold">재고현황</h1>
        <p className="mt-0.5 text-sm text-slate-500">
          조회기간 종료일 시점의 재고 원장 합계입니다. 안전재고 미달은 굵게 표시됩니다.
        </p>
      </header>

      <ReportFilterBar
        reportKey="inventory"
        value={filter}
        onChange={setFilter}
        onSearch={() => setApplied(filter)}
        show={{ warehouse: true, category: true }}
        actions={
          <label className="flex items-center gap-1.5 text-sm">
            <input type="checkbox" checked={onlyBelow} onChange={(e) => setOnlyBelow(e.target.checked)} />
            안전재고 미달만
          </label>
        }
      />

      {q.isLoading ? (
        <Spinner />
      ) : (
        <>
          {(q.data?.totals.belowSafety ?? 0) > 0 ? (
            <p className="rounded bg-amber-50 px-3 py-2 text-sm text-amber-900">
              안전재고 미달 <strong>{q.data?.totals.belowSafety}</strong>건이 있습니다.
            </p>
          ) : null}
          <ReportTable<Row>
            reportKey="inventory"
            title="재고현황"
            period={period}
            columns={columns}
            rows={rows}
            totals={{
              label: '합계',
              quantity: fmt.qty(q.data?.totals.quantity ?? '0'),
              amount: fmt.krw(q.data?.totals.amount ?? '0'),
            }}
          />
        </>
      )}
    </div>
  );
}
