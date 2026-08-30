'use client';

import { useState } from 'react';
import { api } from '@/lib/trpc';
import { Button, Card, EmptyState, Field, Input, Spinner } from '@/components/ui/primitives';
import { InternalNotice } from '@/components/accounting/internal-notice';
import { fmt } from '@/lib/format';
import { businessDate } from '@/lib/dates';

/** ACC-05 / ACC-07: the month's result with the comparison period, and the division split. */
export default function IncomeStatementPage() {
  const thisMonth = businessDate(new Date()).slice(0, 7);
  const [period, setPeriod] = useState(thisMonth);
  const [applied, setApplied] = useState(thisMonth);

  const statement = api.accounting.incomeStatement.useQuery({ period: applied });
  const byDivision = api.accounting.incomeByDivision.useQuery({ period: applied });

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <header>
        <h1 className="text-lg font-semibold">손익계산서</h1>
        <p className="mt-0.5 text-sm text-slate-500">
          기간별 손익과 전월 비교입니다. 손익 마감분개는 제외하고 집계합니다.
        </p>
      </header>

      <InternalNotice />

      <Card title="조회조건">
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            setApplied(period);
          }}
        >
          <Field label="기간" htmlFor="is-period" hint="YYYY-MM" required>
            <Input
              id="is-period"
              value={period}
              onChange={(e) => setPeriod(e.target.value)}
              pattern="\d{4}-\d{2}"
            />
          </Field>
          <Button type="submit" variant="primary" size="sm">
            조회
          </Button>
        </form>
      </Card>

      {statement.isLoading ? (
        <Spinner />
      ) : statement.error ? (
        <EmptyState title="조회할 수 없습니다." description={statement.error.message} />
      ) : (
        <Card title={`${statement.data!.period} 손익 (비교 ${statement.data!.comparePeriod})`}>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[40rem] text-sm">
              <thead className="border-b border-slate-200 text-left text-slate-500">
                <tr>
                  <th className="px-2 py-1.5 font-medium">계정과목</th>
                  <th className="px-2 py-1.5 text-right font-medium">당월</th>
                  <th className="px-2 py-1.5 text-right font-medium">비교월</th>
                  <th className="px-2 py-1.5 text-right font-medium">증감</th>
                </tr>
              </thead>
              <tbody>
                <tr className="bg-slate-50">
                  <td className="px-2 py-1.5 font-medium" colSpan={4}>
                    수익
                  </td>
                </tr>
                {statement.data!.revenue.map((r) => (
                  <tr key={r.accountId} className="border-b border-slate-100">
                    <td className="px-2 py-1.5 pl-6">{r.name}</td>
                    <td className="tabular px-2 py-1.5 text-right">{fmt.krw(r.current)}</td>
                    <td className="tabular px-2 py-1.5 text-right text-slate-500">{fmt.krw(r.previous)}</td>
                    <td className="tabular px-2 py-1.5 text-right">{fmt.krw(r.change)}</td>
                  </tr>
                ))}
                <tr className="border-b border-slate-200 font-medium">
                  <td className="px-2 py-1.5">수익 합계</td>
                  <td className="tabular px-2 py-1.5 text-right">{fmt.krw(statement.data!.totalRevenue)}</td>
                  <td className="px-2 py-1.5" colSpan={2} />
                </tr>

                <tr className="bg-slate-50">
                  <td className="px-2 py-1.5 font-medium" colSpan={4}>
                    비용
                  </td>
                </tr>
                {statement.data!.expense.map((r) => (
                  <tr key={r.accountId} className="border-b border-slate-100">
                    <td className="px-2 py-1.5 pl-6">{r.name}</td>
                    <td className="tabular px-2 py-1.5 text-right">{fmt.krw(r.current)}</td>
                    <td className="tabular px-2 py-1.5 text-right text-slate-500">{fmt.krw(r.previous)}</td>
                    <td className="tabular px-2 py-1.5 text-right">{fmt.krw(r.change)}</td>
                  </tr>
                ))}
                <tr className="border-b border-slate-200 font-medium">
                  <td className="px-2 py-1.5">비용 합계</td>
                  <td className="tabular px-2 py-1.5 text-right">{fmt.krw(statement.data!.totalExpense)}</td>
                  <td className="px-2 py-1.5" colSpan={2} />
                </tr>

                <tr className="border-t-2 border-slate-300 font-semibold">
                  <td className="px-2 py-2">당기순이익</td>
                  <td className="tabular px-2 py-2 text-right">{fmt.krw(statement.data!.netIncome)}</td>
                  <td className="tabular px-2 py-2 text-right text-slate-500">
                    {fmt.krw(statement.data!.previousNetIncome)}
                  </td>
                  <td className="px-2 py-2" />
                </tr>
              </tbody>
            </table>
          </div>
        </Card>
      )}

      <Card title="부문별 손익 (ACC-07)">
        {byDivision.isLoading ? (
          <Spinner />
        ) : byDivision.error ? (
          <EmptyState title="조회할 수 없습니다." description={byDivision.error.message} />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[36rem] text-sm">
              <thead className="border-b border-slate-200 text-left text-slate-500">
                <tr>
                  <th className="px-2 py-1.5 font-medium">부문</th>
                  <th className="px-2 py-1.5 text-right font-medium">수익</th>
                  <th className="px-2 py-1.5 text-right font-medium">비용</th>
                  <th className="px-2 py-1.5 text-right font-medium">손익</th>
                </tr>
              </thead>
              <tbody>
                {byDivision.data!.columns.map((c) => (
                  <tr key={c.divisionId} className="border-b border-slate-100">
                    <td className="px-2 py-1.5">{c.divisionName}</td>
                    <td className="tabular px-2 py-1.5 text-right">{fmt.krw(c.revenue)}</td>
                    <td className="tabular px-2 py-1.5 text-right">{fmt.krw(c.expense)}</td>
                    <td className="tabular px-2 py-1.5 text-right">{fmt.krw(c.netIncome)}</td>
                  </tr>
                ))}
                <tr className="border-b border-slate-100 text-slate-500">
                  <td className="px-2 py-1.5">부문 미지정</td>
                  <td className="px-2 py-1.5" colSpan={2} />
                  <td className="tabular px-2 py-1.5 text-right">{fmt.krw(byDivision.data!.untagged)}</td>
                </tr>
                <tr className="border-t-2 border-slate-300 font-medium">
                  <td className="px-2 py-1.5">전사 합계</td>
                  <td className="tabular px-2 py-1.5 text-right">
                    {fmt.krw(byDivision.data!.total.revenue)}
                  </td>
                  <td className="tabular px-2 py-1.5 text-right">
                    {fmt.krw(byDivision.data!.total.expense)}
                  </td>
                  <td className="tabular px-2 py-1.5 text-right">
                    {fmt.krw(byDivision.data!.total.netIncome)}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
