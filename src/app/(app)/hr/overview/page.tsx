'use client';

import { useState } from 'react';
import { api } from '@/lib/trpc';
import { Card, EmptyState, Field, Input, Spinner } from '@/components/ui/primitives';
import { fmt } from '@/lib/format';
import { businessDate } from '@/lib/dates';

/** HRM-10: headcount distribution by department, employment type and tenure. */
export default function HrOverviewPage() {
  const [asOf, setAsOf] = useState(businessDate());
  const overview = api.hrm.overview.useQuery({ asOf });

  if (overview.isLoading) return <Spinner />;
  if (overview.error)
    return <EmptyState title="인사현황을 불러올 수 없습니다." description={overview.error.message} />;
  const d = overview.data!;

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold">인사현황</h1>
          <p className="mt-0.5 text-sm text-slate-500">기준일 재직 인원의 부서·고용형태·근속 분포입니다.</p>
        </div>
        <Field label="기준일" htmlFor="ov-asof" className="w-44">
          <Input id="ov-asof" type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} />
        </Field>
      </header>

      <div className="grid gap-4 md:grid-cols-3">
        <Card title="총 인원">
          <p className="text-2xl font-semibold tabular">{fmt.count(d.headcount)}명</p>
        </Card>
        <Card title="당해 입사">
          <p className="text-2xl font-semibold tabular">{fmt.count(d.hiredThisYear)}명</p>
        </Card>
        <Card title="당해 퇴사">
          <p className="text-2xl font-semibold tabular">{fmt.count(d.leftThisYear)}명</p>
        </Card>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <Distribution title="부서별" rows={d.byDepartment} total={d.headcount} />
        <Distribution title="고용형태별" rows={d.byEmploymentType} total={d.headcount} />
        <Distribution title="근속별" rows={d.byTenure} total={d.headcount} />
      </div>
    </div>
  );
}

function Distribution({
  title,
  rows,
  total,
}: {
  title: string;
  rows: { name: string; count: number }[];
  total: number;
}) {
  return (
    <Card title={title}>
      {rows.length === 0 ? (
        <EmptyState title="해당 없음" />
      ) : (
        <ul className="flex flex-col gap-2 text-sm">
          {rows.map((r) => (
            <li key={r.name}>
              <div className="flex items-center justify-between">
                <span>{r.name}</span>
                <span className="tabular text-slate-600">
                  {r.count}명 ({total > 0 ? Math.round((r.count / total) * 100) : 0}%)
                </span>
              </div>
              <div className="mt-0.5 h-1.5 w-full rounded bg-slate-100">
                <div
                  className="h-1.5 rounded bg-blue-600"
                  style={{ width: `${total > 0 ? (r.count / total) * 100 : 0}%` }}
                />
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
