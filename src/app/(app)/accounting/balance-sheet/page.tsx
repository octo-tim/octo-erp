'use client';

import { useState } from 'react';
import { api } from '@/lib/trpc';
import { Button, Card, EmptyState, Field, Input, Spinner } from '@/components/ui/primitives';
import { InternalNotice } from '@/components/accounting/internal-notice';
import { fmt } from '@/lib/format';
import { businessDate } from '@/lib/dates';

/**
 * ACC-06: the position on a date. Year-to-date earnings are shown as their own line inside
 * equity rather than folded in, because they have not been closed yet — presenting them as
 * closed would make the sheet balance for the wrong reason.
 */
export default function BalanceSheetPage() {
  const today = businessDate(new Date());
  const [asOf, setAsOf] = useState(today);
  const [applied, setApplied] = useState(today);

  const sheet = api.accounting.balanceSheet.useQuery({ asOf: applied });

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <header>
        <h1 className="text-lg font-semibold">재무상태표</h1>
        <p className="mt-0.5 text-sm text-slate-500">기준일 현재의 자산·부채·자본입니다.</p>
      </header>

      <InternalNotice />

      <Card title="조회조건">
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            setApplied(asOf);
          }}
        >
          <Field label="기준일" htmlFor="bs-asof" required>
            <Input id="bs-asof" type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} />
          </Field>
          <Button type="submit" variant="primary" size="sm">
            조회
          </Button>
        </form>
      </Card>

      {sheet.isLoading ? (
        <Spinner />
      ) : sheet.error ? (
        <EmptyState title="조회할 수 없습니다." description={sheet.error.message} />
      ) : (
        <>
          {!sheet.data!.balanced ? (
            <p role="alert" className="rounded bg-red-50 px-3 py-2 text-sm text-red-700">
              차대가 일치하지 않습니다. 차액 {fmt.krw(sheet.data!.difference)}원. 분개 데이터를 확인하세요.
            </p>
          ) : null}

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Card title={`자산 ${fmt.krw(sheet.data!.assets.total)}`}>
              <Section rows={sheet.data!.assets.rows} />
            </Card>

            <div className="flex flex-col gap-4">
              <Card title={`부채 ${fmt.krw(sheet.data!.liabilities.total)}`}>
                <Section rows={sheet.data!.liabilities.rows} />
              </Card>
              <Card title={`자본 ${fmt.krw(sheet.data!.equity.total)}`}>
                <Section rows={sheet.data!.equity.rows} />
                <p className="mt-3 flex items-center justify-between border-t border-slate-200 pt-2 text-sm">
                  <span>당기순손익 (미마감)</span>
                  <span className="tabular font-medium">{fmt.krw(sheet.data!.currentEarnings)}</span>
                </p>
              </Card>
            </div>
          </div>

          <Card title="검증">
            <p className="text-sm">
              자산 <span className="tabular">{fmt.krw(sheet.data!.assets.total)}</span> = 부채{' '}
              <span className="tabular">{fmt.krw(sheet.data!.liabilities.total)}</span> + 자본{' '}
              <span className="tabular">{fmt.krw(sheet.data!.equity.total)}</span> + 당기순손익{' '}
              <span className="tabular">{fmt.krw(sheet.data!.currentEarnings)}</span>{' '}
              {sheet.data!.balanced ? (
                <span className="rounded bg-green-50 px-2 py-0.5 text-xs text-green-800">일치</span>
              ) : (
                <span className="rounded bg-red-50 px-2 py-0.5 text-xs text-red-700">불일치</span>
              )}
            </p>
          </Card>
        </>
      )}
    </div>
  );
}

function Section({ rows }: { rows: { accountId: string; code: string; name: string; balance: string }[] }) {
  if (rows.length === 0) return <EmptyState title="잔액이 없습니다." />;
  return (
    <ul className="divide-y divide-slate-100 text-sm">
      {rows.map((r) => (
        <li key={r.accountId} className="flex items-center justify-between py-1.5">
          <span>
            <span className="tabular text-slate-500">{r.code}</span> {r.name}
          </span>
          <span className="tabular">{fmt.krw(r.balance)}</span>
        </li>
      ))}
    </ul>
  );
}
