'use client';

import { useState } from 'react';
import { api } from '@/lib/trpc';
import { fmt } from '@/lib/format';
import { Card, EmptyState, Spinner } from '@/components/ui/primitives';
import { ReportFilterBar, currentMonth, type ReportFilterValue } from '@/components/report/report-filter-bar';
import { ReportTable, type ReportColumn } from '@/components/report/report-table';

/**
 * RPT-10: attendance, overtime, leave usage and headcount movement.
 *
 * NFR-SEC-02 keeps HR behind its own permission, so a user with report.read but no hr.read
 * gets a plain explanation rather than an empty report that looks like there is no data.
 */
type Row = { status: string; days: number; overtimeMinutes: number };

const STATUS_LABEL: Record<string, string> = {
  PRESENT: '정상근무',
  LEAVE: '휴가',
  HALF_LEAVE: '반차',
  ABSENT: '결근',
  HOLIDAY: '휴일',
  BUSINESS_TRIP: '출장',
};

export default function WorkforceReportPage() {
  const [filter, setFilter] = useState<ReportFilterValue>(currentMonth());
  const [applied, setApplied] = useState<ReportFilterValue>(filter);
  const q = api.report.workforce.useQuery({ filter: applied }, { retry: false });

  const columns: ReportColumn<Row>[] = [
    { key: 'status', header: '근태구분', render: (r) => STATUS_LABEL[r.status] ?? r.status },
    { key: 'days', header: '일수', numeric: true },
    {
      key: 'overtimeMinutes',
      header: '연장근로',
      numeric: true,
      render: (r) => `${Math.floor(r.overtimeMinutes / 60)}시간 ${r.overtimeMinutes % 60}분`,
    },
  ];

  const period = `${applied.from} ~ ${applied.to}`;

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <header>
        <h1 className="text-lg font-semibold">근태·인원현황</h1>
        <p className="mt-0.5 text-sm text-slate-500">
          인사정보에 해당하므로 전 직원 인사 조회 권한이 필요합니다.
        </p>
      </header>

      <ReportFilterBar
        reportKey="hr"
        value={filter}
        onChange={setFilter}
        onSearch={() => setApplied(filter)}
      />

      {q.isLoading ? (
        <Spinner />
      ) : q.error ? (
        <EmptyState
          title="인사 자료를 조회할 권한이 없습니다."
          description="근태·인원현황은 전 직원 인사정보 조회 권한이 있어야 볼 수 있습니다. 관리자에게 권한을 요청하세요."
        />
      ) : (
        <>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Card title="재직 인원">
              <p className="text-2xl font-semibold tabular">{fmt.count(q.data?.headcount.current ?? 0)}명</p>
              <p className="mt-1 text-sm text-slate-600">
                입사 {q.data?.headcount.hired ?? 0}명 · 퇴사 {q.data?.headcount.left ?? 0}명 · 순증{' '}
                {q.data?.headcount.net ?? 0}명
              </p>
            </Card>
            <Card title="연차 사용률">
              <p className="text-2xl font-semibold tabular">
                {q.data?.leave.usageRate === '-' ? '-' : `${q.data?.leave.usageRate}%`}
              </p>
              <p className="mt-1 text-sm text-slate-600">
                부여 {q.data?.leave.granted ?? 0}일 · 사용 {q.data?.leave.used ?? 0}일
              </p>
            </Card>
            <Card title="연장근로">
              <p className="text-2xl font-semibold tabular">
                {Math.floor((q.data?.attendance.reduce((a, r) => a + r.overtimeMinutes, 0) ?? 0) / 60)}
                시간
              </p>
              <p className="mt-1 text-sm text-slate-600">조회기간 합계</p>
            </Card>
          </div>

          <ReportTable<Row>
            reportKey="hr"
            title="근태현황"
            period={period}
            columns={columns}
            rows={(q.data?.attendance ?? []) as Row[]}
          />
        </>
      )}
    </div>
  );
}
