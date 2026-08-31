'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/trpc';
import { fmt } from '@/lib/format';
import { Select, Spinner } from '@/components/ui/primitives';
import { ReportFilterBar, currentMonth, type ReportFilterValue } from '@/components/report/report-filter-bar';
import { ReportTable, type ReportColumn } from '@/components/report/report-table';

/** RPT-05: what is owed and what is owing, by age. */
type Row = {
  partnerId: string;
  partnerName: string;
  current: string;
  d30: string;
  d60: string;
  d90: string;
  over90: string;
  total: string;
};

export default function OpenItemReportPage() {
  const router = useRouter();
  const [filter, setFilter] = useState<ReportFilterValue>(currentMonth());
  const [applied, setApplied] = useState<ReportFilterValue>(filter);
  const [kind, setKind] = useState<'RECEIVABLE' | 'PAYABLE'>('RECEIVABLE');
  const q = api.report.openItems.useQuery({ filter: applied, kind });

  const money = (key: keyof Row): ReportColumn<Row> => ({
    key,
    header: '',
    numeric: true,
    render: (r) => fmt.krw(r[key] as string),
  });

  const columns: ReportColumn<Row>[] = [
    { key: 'partnerName', header: '거래처' },
    { ...money('current'), header: '정상' },
    { ...money('d30'), header: '30일' },
    { ...money('d60'), header: '60일' },
    { ...money('d90'), header: '90일' },
    { ...money('over90'), header: '90일 초과' },
    { ...money('total'), header: '합계' },
  ];

  const period = `${applied.to} 기준`;
  const label = kind === 'RECEIVABLE' ? '미수금' : '미지급금';

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <header>
        <h1 className="text-lg font-semibold">채권채무 현황</h1>
        <p className="mt-0.5 text-sm text-slate-500">
          연령은 지급기일이 있으면 그 날짜부터, 없으면 전표일자부터 셉니다. 경계일은 아래 구간에 포함됩니다.
        </p>
      </header>

      <ReportFilterBar
        reportKey="receivables"
        value={filter}
        onChange={setFilter}
        onSearch={() => setApplied(filter)}
        show={{ partner: true }}
        actions={
          <label className="flex items-center gap-1.5 text-sm">
            <span className="text-slate-600">구분</span>
            <Select
              aria-label="채권채무 구분"
              value={kind}
              onChange={(e) => setKind(e.target.value as 'RECEIVABLE' | 'PAYABLE')}
            >
              <option value="RECEIVABLE">미수금</option>
              <option value="PAYABLE">미지급금</option>
            </Select>
          </label>
        }
      />

      {q.isLoading ? (
        <Spinner />
      ) : (
        <ReportTable<Row>
          reportKey={`open-items-${kind}`}
          title={`${label} 연령분석`}
          period={period}
          columns={columns}
          rows={(q.data?.rows ?? []) as Row[]}
          totals={
            q.data
              ? {
                  label: '합계',
                  current: fmt.krw(q.data.totals.current),
                  d30: fmt.krw(q.data.totals.d30),
                  d60: fmt.krw(q.data.totals.d60),
                  d90: fmt.krw(q.data.totals.d90),
                  over90: fmt.krw(q.data.totals.over90),
                  total: fmt.krw(q.data.totals.total),
                }
              : undefined
          }
          onRowClick={(r) =>
            router.push(
              `/reports/drilldown?target=${kind}&partnerId=${r.partnerId}&from=${applied.from}&to=${applied.to}`,
            )
          }
        />
      )}
    </div>
  );
}
