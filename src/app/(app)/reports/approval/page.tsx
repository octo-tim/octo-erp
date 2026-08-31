'use client';

import { useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/trpc';
import { Card, Spinner } from '@/components/ui/primitives';
import { ReportFilterBar, currentMonth, type ReportFilterValue } from '@/components/report/report-filter-bar';
import { ReportTable, type ReportColumn } from '@/components/report/report-table';

/** RPT-09: approval throughput by form, plus what is still waiting. */
type Row = {
  formName: string;
  submitted: number;
  approved: number;
  rejected: number;
  pending: number;
  averageHours: string;
};

export default function ApprovalReportPage() {
  const [filter, setFilter] = useState<ReportFilterValue>(currentMonth());
  const [applied, setApplied] = useState<ReportFilterValue>(filter);
  const q = api.report.approvalStats.useQuery({ filter: applied });

  const columns: ReportColumn<Row>[] = [
    { key: 'formName', header: '결재양식' },
    { key: 'submitted', header: '상신', numeric: true },
    { key: 'approved', header: '승인', numeric: true },
    { key: 'rejected', header: '반려', numeric: true },
    { key: 'pending', header: '진행중', numeric: true },
    {
      key: 'averageHours',
      header: '평균 처리시간',
      numeric: true,
      render: (r) => (r.averageHours === '-' ? '-' : `${r.averageHours}시간`),
    },
  ];

  const period = `${applied.from} ~ ${applied.to}`;
  const stale = q.data?.stale ?? [];

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <header>
        <h1 className="text-lg font-semibold">결재현황</h1>
        <p className="mt-0.5 text-sm text-slate-500">
          평균 처리시간은 상신부터 완료까지이며, 아직 완료되지 않은 문서는 평균에서 제외합니다.
        </p>
      </header>

      <ReportFilterBar
        reportKey="approval"
        value={filter}
        onChange={setFilter}
        onSearch={() => setApplied(filter)}
      />

      {q.isLoading ? (
        <Spinner />
      ) : (
        <>
          <ReportTable<Row>
            reportKey="approval"
            title="결재현황"
            period={period}
            columns={columns}
            rows={(q.data?.rows ?? []) as Row[]}
          />

          <Card title="장기 미결">
            {stale.length === 0 ? (
              <p className="text-sm text-slate-500">진행 중인 결재문서가 없습니다.</p>
            ) : (
              <ul className="flex flex-col gap-1.5 text-sm">
                {stale.map((s) => (
                  <li key={s.id} className="flex flex-wrap items-center justify-between gap-2">
                    <Link className="underline" href={`/approval/documents/${s.id}`}>
                      {s.docNo} {s.title}
                    </Link>
                    <span className={s.waitingDays >= 7 ? 'font-semibold text-red-700' : 'text-slate-600'}>
                      {s.waitingDays}일 대기 · {s.currentStepNo}단계
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </>
      )}
    </div>
  );
}
