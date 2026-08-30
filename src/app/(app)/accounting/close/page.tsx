'use client';

import { useState } from 'react';
import { api, newRequestId } from '@/lib/trpc';
import { Button, Card, EmptyState, Field, Input, Spinner, StatusBadge } from '@/components/ui/primitives';
import { InternalNotice } from '@/components/accounting/internal-notice';
import { fmt } from '@/lib/format';
import { businessDate } from '@/lib/dates';

/**
 * ACC-08: month close locks a period; year close additionally transfers the year's result
 * to retained earnings and carries the balance sheet forward. The two are kept visibly
 * separate because they are different operations with different consequences.
 */
export default function ClosePage() {
  const utils = api.useUtils();
  const refresh = { onSuccess: () => utils.accounting.invalidate() };

  const today = businessDate(new Date());
  const [periodKey, setPeriodKey] = useState(today.slice(0, 7));
  const [year, setYear] = useState(today.slice(0, 4));
  const [previewYear, setPreviewYear] = useState<string | null>(null);
  const [reopenReason, setReopenReason] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const periods = api.accounting.periods.useQuery();
  const runs = api.accounting.closingRuns.useQuery();
  const preview = api.accounting.yearClosePreview.useQuery(
    { year: previewYear ?? year },
    { enabled: Boolean(previewYear) },
  );
  const closeMonth = api.accounting.closeMonth.useMutation(refresh);
  const reopen = api.accounting.reopenPeriod.useMutation(refresh);
  const closeYear = api.accounting.closeYear.useMutation(refresh);

  async function run(fn: () => Promise<unknown>, ok: string) {
    setError(null);
    setMessage(null);
    try {
      await fn();
      setMessage(ok);
    } catch (err) {
      setError((err as { message?: string }).message ?? '처리에 실패했습니다.');
    }
  }

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <header>
        <h1 className="text-lg font-semibold">결산·마감</h1>
        <p className="mt-0.5 text-sm text-slate-500">
          월 마감은 해당 기간의 전표를 잠급니다. 연 마감은 손익을 이익잉여금으로 대체하고 재무상태 계정을 다음
          연도 기초잔액으로 이월합니다.
        </p>
      </header>

      <InternalNotice />

      {message ? (
        <p role="status" className="rounded bg-green-50 px-3 py-2 text-sm text-green-800">
          {message}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="whitespace-pre-line rounded bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      ) : null}

      <Card title="월 마감">
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void run(
              () => closeMonth.mutateAsync({ periodKey, requestId: newRequestId() }),
              `${periodKey} 마감했습니다.`,
            );
          }}
        >
          <Field label="마감 기간" htmlFor="cl-period" hint="YYYY-MM" required>
            <Input
              id="cl-period"
              value={periodKey}
              onChange={(e) => setPeriodKey(e.target.value)}
              pattern="\d{4}-\d{2}"
            />
          </Field>
          <Button type="submit" variant="primary" size="sm" disabled={closeMonth.isPending}>
            월 마감
          </Button>
        </form>
        <p className="mt-2 text-xs text-slate-500">
          확정되지 않은 전표가 남아 있으면 마감할 수 없습니다. 이전 기간이 열려 있어도 마감할 수 없습니다.
        </p>
      </Card>

      <Card title="기간 목록">
        {periods.isLoading ? (
          <Spinner />
        ) : (periods.data ?? []).length === 0 ? (
          <EmptyState title="회계기간이 없습니다." description="전표를 등록하면 기간이 생성됩니다." />
        ) : (
          <ul className="divide-y divide-slate-100 text-sm">
            {(periods.data ?? []).map((p) => (
              <li key={p.id} className="flex flex-wrap items-center gap-3 py-2">
                <span className="tabular font-medium">{p.periodKey}</span>
                <StatusBadge
                  status={p.status === 'CLOSED' ? 'CONFIRMED' : 'DRAFT'}
                  label={p.status === 'CLOSED' ? '마감' : '진행'}
                />
                <span className="text-slate-500">전표 {fmt.count(p._count.entries)}건</span>
                {p.closedAt ? (
                  <span className="text-slate-500">{fmt.dateTime(p.closedAt as unknown as string)}</span>
                ) : null}
                {p.reopenReason ? <span className="text-slate-500">해제 사유: {p.reopenReason}</span> : null}
                {p.status === 'CLOSED' ? (
                  <span className="ml-auto flex items-center gap-2">
                    <Input
                      aria-label={`${p.periodKey} 마감 해제 사유`}
                      className="w-56"
                      placeholder="해제 사유 (5자 이상)"
                      value={reopenReason}
                      onChange={(e) => setReopenReason(e.target.value)}
                    />
                    <Button
                      size="sm"
                      disabled={reopenReason.trim().length < 5}
                      onClick={() =>
                        run(async () => {
                          await reopen.mutateAsync({
                            periodKey: p.periodKey,
                            reason: reopenReason,
                            requestId: newRequestId(),
                          });
                          setReopenReason('');
                        }, `${p.periodKey} 마감을 해제했습니다.`)
                      }
                    >
                      마감 해제
                    </Button>
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title="연 마감 (손익대체·이월)">
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            setPreviewYear(year);
          }}
        >
          <Field label="대상 연도" htmlFor="cl-year" hint="YYYY" required>
            <Input id="cl-year" value={year} onChange={(e) => setYear(e.target.value)} pattern="\d{4}" />
          </Field>
          <Button type="submit" size="sm">
            마감 미리보기
          </Button>
        </form>

        {previewYear ? (
          preview.isLoading ? (
            <Spinner />
          ) : preview.error ? (
            <EmptyState title="미리보기를 만들 수 없습니다." description={preview.error.message} />
          ) : (
            <div className="mt-4">
              <p className="mb-3 text-sm">
                수익 <span className="tabular font-medium">{fmt.krw(preview.data!.revenue)}</span> · 비용{' '}
                <span className="tabular font-medium">{fmt.krw(preview.data!.expense)}</span> · 당기순손익{' '}
                <span className="tabular font-medium">{fmt.krw(preview.data!.netIncome)}</span>
              </p>
              <p className="mb-3 text-sm text-slate-600">
                대체 대상 계정 {preview.data!.lines.length}건 · 이월 대상 {preview.data!.carriedAccounts}건 ·
                이익잉여금 계정 {preview.data!.retainedEarningsAccount ?? '미지정'}
              </p>

              <div className="overflow-x-auto">
                <table className="w-full min-w-[32rem] text-sm">
                  <thead className="border-b border-slate-200 text-left text-slate-500">
                    <tr>
                      <th className="px-2 py-1.5 font-medium">계정과목</th>
                      <th className="px-2 py-1.5 font-medium">구분</th>
                      <th className="px-2 py-1.5 text-right font-medium">잔액</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.data!.lines.map((l) => (
                      <tr key={l.accountId} className="border-b border-slate-100">
                        <td className="px-2 py-1.5">
                          <span className="tabular text-slate-500">{l.code}</span> {l.name}
                        </td>
                        <td className="px-2 py-1.5">{l.accountType === 'REVENUE' ? '수익' : '비용'}</td>
                        <td className="tabular px-2 py-1.5 text-right">{fmt.krw(l.balance)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <Button
                className="mt-4"
                variant="primary"
                size="sm"
                disabled={closeYear.isPending || !preview.data!.retainedEarningsAccount}
                onClick={() =>
                  run(
                    () => closeYear.mutateAsync({ year: previewYear, requestId: newRequestId() }),
                    `${previewYear}년 손익을 마감했습니다.`,
                  )
                }
              >
                연 마감 확정
              </Button>
            </div>
          )
        ) : null}
      </Card>

      <Card title="마감 이력">
        {runs.isLoading ? (
          <Spinner />
        ) : (runs.data ?? []).length === 0 ? (
          <EmptyState title="마감 이력이 없습니다." />
        ) : (
          <ul className="divide-y divide-slate-100 text-sm">
            {(runs.data ?? []).map((r) => (
              <li key={r.id} className="flex flex-wrap items-center gap-3 py-2">
                <span className="tabular font-medium">{r.period.periodKey}</span>
                <span>{r.kind === 'YEAR' ? '연 마감' : '월 마감'}</span>
                <span className="text-slate-500">
                  잠금 전표 {fmt.count(r.entriesLocked)}건
                  {r.kind === 'YEAR' ? ` · 이월 ${fmt.count(r.carriedAccounts)}건` : ''}
                </span>
                <span className="ml-auto text-slate-500">{fmt.dateTime(r.runAt as unknown as string)}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
