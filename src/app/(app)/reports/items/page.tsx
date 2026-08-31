'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/trpc';
import { fmt } from '@/lib/format';
import { Select, Spinner } from '@/components/ui/primitives';
import { ReportFilterBar, currentMonth, type ReportFilterValue } from '@/components/report/report-filter-bar';
import { ReportTable, type ReportColumn } from '@/components/report/report-table';

/** RPT-02: which items sold, ranked, with each one's share of the ranked total. */
type Row = {
  itemId: string;
  rank: number;
  code: string;
  name: string;
  quantity: string;
  supplyAmount: string;
  share: string;
};

export default function ItemReportPage() {
  const router = useRouter();
  const [filter, setFilter] = useState<ReportFilterValue>(currentMonth());
  const [applied, setApplied] = useState<ReportFilterValue>(filter);
  const [top, setTop] = useState(20);
  const [by, setBy] = useState<'AMOUNT' | 'QUANTITY'>('AMOUNT');

  const q = api.report.itemRanking.useQuery({ filter: applied, top, by });

  const columns: ReportColumn<Row>[] = [
    { key: 'rank', header: '순위', numeric: true },
    { key: 'code', header: '품목코드' },
    { key: 'name', header: '품목명' },
    { key: 'quantity', header: '수량', numeric: true, render: (r) => fmt.qty(r.quantity) },
    { key: 'supplyAmount', header: '매출액', numeric: true, render: (r) => fmt.krw(r.supplyAmount) },
    {
      key: 'share',
      header: '기여도',
      numeric: true,
      render: (r) => (r.share === '-' ? '-' : `${r.share}%`),
    },
  ];

  const period = `${applied.from} ~ ${applied.to}`;

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <header>
        <h1 className="text-lg font-semibold">품목순위</h1>
        <p className="mt-0.5 text-sm text-slate-500">
          기여도는 표시된 상위 {top}개 합계에 대한 비율입니다. 행을 누르면 그 품목의 매출전표로 이동합니다.
        </p>
      </header>

      <ReportFilterBar
        reportKey="items"
        value={filter}
        onChange={setFilter}
        onSearch={() => setApplied(filter)}
        show={{ division: true, warehouse: true, category: true }}
        actions={
          <>
            <label className="flex items-center gap-1.5 text-sm">
              <span className="text-slate-600">기준</span>
              <Select
                aria-label="순위 기준"
                value={by}
                onChange={(e) => setBy(e.target.value as 'AMOUNT' | 'QUANTITY')}
              >
                <option value="AMOUNT">금액</option>
                <option value="QUANTITY">수량</option>
              </Select>
            </label>
            <label className="flex items-center gap-1.5 text-sm">
              <span className="text-slate-600">상위</span>
              <Select
                aria-label="표시 건수"
                value={String(top)}
                onChange={(e) => setTop(Number(e.target.value))}
              >
                {[10, 20, 50, 100].map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </Select>
            </label>
          </>
        }
      />

      {q.isLoading ? (
        <Spinner />
      ) : (
        <ReportTable<Row>
          reportKey="items"
          title="품목순위"
          period={period}
          columns={columns}
          rows={(q.data?.rows ?? []) as Row[]}
          totals={{ label: '상위 합계', supplyAmount: fmt.krw(q.data?.totalAmount ?? '0') }}
          onRowClick={(r) =>
            router.push(
              `/reports/drilldown?target=SALES&itemId=${r.itemId}&from=${applied.from}&to=${applied.to}` +
                (applied.divisionId ? `&divisionId=${applied.divisionId}` : '') +
                (applied.warehouseId ? `&warehouseId=${applied.warehouseId}` : ''),
            )
          }
        />
      )}
    </div>
  );
}
