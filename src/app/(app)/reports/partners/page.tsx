'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/trpc';
import { fmt } from '@/lib/format';
import { Spinner } from '@/components/ui/primitives';
import { ReportFilterBar, currentMonth, type ReportFilterValue } from '@/components/report/report-filter-bar';
import { ReportTable, type ReportColumn } from '@/components/report/report-table';

/** RPT-03: what each partner did this period, against the same period a year earlier. */
type Row = {
  partnerId: string;
  name: string;
  salesAmount: string;
  purchaseAmount: string;
  priorSalesAmount: string;
  changeRate: string;
  outstanding: string;
};

export default function PartnerReportPage() {
  const router = useRouter();
  const [filter, setFilter] = useState<ReportFilterValue>(currentMonth());
  const [applied, setApplied] = useState<ReportFilterValue>(filter);
  const q = api.report.partnerPerformance.useQuery({ filter: applied });

  const columns: ReportColumn<Row>[] = [
    { key: 'name', header: '거래처' },
    { key: 'salesAmount', header: '매출', numeric: true, render: (r) => fmt.krw(r.salesAmount) },
    { key: 'purchaseAmount', header: '매입', numeric: true, render: (r) => fmt.krw(r.purchaseAmount) },
    {
      key: 'priorSalesAmount',
      header: '전년동기 매출',
      numeric: true,
      render: (r) => fmt.krw(r.priorSalesAmount),
    },
    {
      key: 'changeRate',
      header: '증감률',
      numeric: true,
      render: (r) => (r.changeRate === '-' ? '-' : `${r.changeRate}%`),
    },
    { key: 'outstanding', header: '미수잔액', numeric: true, render: (r) => fmt.krw(r.outstanding) },
  ];

  const period = `${applied.from} ~ ${applied.to}`;

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <header>
        <h1 className="text-lg font-semibold">거래처실적</h1>
        <p className="mt-0.5 text-sm text-slate-500">
          전년동기는 조회기간을 그대로 1년 앞당긴 구간입니다. 전년 실적이 없으면 증감률은 표시하지 않습니다.
        </p>
      </header>

      <ReportFilterBar
        reportKey="partners"
        value={filter}
        onChange={setFilter}
        onSearch={() => setApplied(filter)}
        show={{ division: true, partner: true }}
      />

      {q.isLoading ? (
        <Spinner />
      ) : (
        <ReportTable<Row>
          reportKey="partners"
          title="거래처실적"
          period={period}
          columns={columns}
          rows={(q.data?.rows ?? []) as Row[]}
          onRowClick={(r) =>
            router.push(
              `/reports/drilldown?target=SALES&partnerId=${r.partnerId}&from=${applied.from}&to=${applied.to}`,
            )
          }
        />
      )}
    </div>
  );
}
