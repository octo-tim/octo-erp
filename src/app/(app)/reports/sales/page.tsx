'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/trpc';
import { fmt } from '@/lib/format';
import { Select, Spinner } from '@/components/ui/primitives';
import { ReportFilterBar, currentMonth, type ReportFilterValue } from '@/components/report/report-filter-bar';
import { ReportTable, type ReportColumn } from '@/components/report/report-table';

/** RPT-01: sales, cost and profit over time, at whichever granularity the reader wants. */
type Row = {
  bucket: string;
  supplyAmount: string;
  costAmount: string;
  profitAmount: string;
  marginRate: string;
  documentCount: number;
};

const GRANULARITY_LABEL = { DAY: '일', WEEK: '주', MONTH: '월', QUARTER: '분기' } as const;

export default function SalesReportPage() {
  const router = useRouter();
  const [filter, setFilter] = useState<ReportFilterValue>(currentMonth());
  const [applied, setApplied] = useState<ReportFilterValue>(filter);
  const [granularity, setGranularity] = useState<keyof typeof GRANULARITY_LABEL>('MONTH');

  const q = api.report.salesTrend.useQuery({ filter: applied, granularity });

  const columns: ReportColumn<Row>[] = [
    { key: 'bucket', header: '기간' },
    { key: 'supplyAmount', header: '매출액', numeric: true, render: (r) => fmt.krw(r.supplyAmount) },
    { key: 'costAmount', header: '매출원가', numeric: true, render: (r) => fmt.krw(r.costAmount) },
    { key: 'profitAmount', header: '매출이익', numeric: true, render: (r) => fmt.krw(r.profitAmount) },
    {
      key: 'marginRate',
      header: '이익률',
      numeric: true,
      render: (r) => (r.marginRate === '-' ? '-' : `${r.marginRate}%`),
    },
    { key: 'documentCount', header: '전표수', numeric: true },
  ];

  const period = `${applied.from} ~ ${applied.to}`;

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <header>
        <h1 className="text-lg font-semibold">매출현황</h1>
        <p className="mt-0.5 text-sm text-slate-500">
          확정된 매출전표와 그 분개에서 집계합니다. 행을 누르면 해당 기간의 전표 목록으로 이동합니다.
        </p>
      </header>

      <ReportFilterBar
        reportKey="sales"
        value={filter}
        onChange={setFilter}
        onSearch={() => setApplied(filter)}
        show={{ division: true, warehouse: true, partner: true }}
        actions={
          <label className="flex items-center gap-1.5 text-sm">
            <span className="text-slate-600">단위</span>
            <Select
              aria-label="집계 단위"
              value={granularity}
              onChange={(e) => setGranularity(e.target.value as keyof typeof GRANULARITY_LABEL)}
            >
              {Object.entries(GRANULARITY_LABEL).map(([v, label]) => (
                <option key={v} value={v}>
                  {label}
                </option>
              ))}
            </Select>
          </label>
        }
      />

      {q.isLoading ? (
        <Spinner />
      ) : (
        <ReportTable<Row>
          reportKey="sales"
          title="매출현황"
          period={period}
          columns={columns}
          rows={(q.data?.rows ?? []) as Row[]}
          totals={{
            label: '합계',
            supplyAmount: fmt.krw(q.data?.totals.supplyAmount ?? '0'),
            costAmount: fmt.krw(q.data?.totals.costAmount ?? '0'),
            profitAmount: fmt.krw(q.data?.totals.profitAmount ?? '0'),
            marginRate: q.data?.totals.marginRate === '-' ? '-' : `${q.data?.totals.marginRate ?? '-'}%`,
            documentCount: q.data?.totals.documentCount ?? 0,
          }}
          onRowClick={() =>
            router.push(
              `/reports/drilldown?target=SALES&from=${applied.from}&to=${applied.to}` +
                (applied.divisionId ? `&divisionId=${applied.divisionId}` : '') +
                (applied.warehouseId ? `&warehouseId=${applied.warehouseId}` : '') +
                (applied.partnerId ? `&partnerId=${applied.partnerId}` : ''),
            )
          }
        />
      )}
    </div>
  );
}
