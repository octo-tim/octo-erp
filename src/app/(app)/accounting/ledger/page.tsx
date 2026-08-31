'use client';

import { useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/trpc';
import { Button, Card, EmptyState, Field, Input, Select, Spinner } from '@/components/ui/primitives';
import { InternalNotice } from '@/components/accounting/internal-notice';
import { fmt } from '@/lib/format';
import { businessDate } from '@/lib/dates';

/**
 * ACC-04: the general ledger summary and, for one account, the detail with a running
 * balance and a link back to the source document on every row.
 */
function firstOfMonth(): string {
  return `${businessDate(new Date()).slice(0, 7)}-01`;
}

export default function LedgerPage() {
  const [form, setForm] = useState({
    accountId: '',
    from: firstOfMonth(),
    to: businessDate(new Date()),
  });
  const [applied, setApplied] = useState(form);

  const accounts = api.accounting.postableAccounts.useQuery();
  const trial = api.accounting.trialBalance.useQuery({
    from: applied.from,
    to: applied.to,
    hideZero: true,
  });
  const ledger = api.accounting.accountLedger.useQuery(
    { accountId: applied.accountId, from: applied.from, to: applied.to },
    { enabled: Boolean(applied.accountId) },
  );

  function download(csv: string, name: string) {
    const blob = new Blob([`﻿${csv}`], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    URL.revokeObjectURL(url);
  }

  const trialCsv = api.accounting.trialBalanceCsv.useQuery(
    { from: applied.from, to: applied.to },
    { enabled: false },
  );
  const ledgerCsv = api.accounting.accountLedgerCsv.useQuery(
    { accountId: applied.accountId, from: applied.from, to: applied.to },
    { enabled: false },
  );

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <header>
        <h1 className="text-lg font-semibold">원장</h1>
        <p className="mt-0.5 text-sm text-slate-500">
          총계정원장과 계정별원장입니다. 모든 행에서 원천전표로 이동할 수 있습니다.
        </p>
      </header>

      <InternalNotice />

      <Card title="조회조건">
        <form
          className="grid grid-cols-1 gap-3 sm:grid-cols-4"
          onSubmit={(e) => {
            e.preventDefault();
            setApplied(form);
          }}
        >
          <Field label="계정과목" htmlFor="gl-acc" hint="선택하면 계정별원장을 보여줍니다">
            <Select
              id="gl-acc"
              value={form.accountId}
              onChange={(e) => setForm({ ...form, accountId: e.target.value })}
            >
              <option value="">총계정원장</option>
              {(accounts.data ?? []).map((a) => (
                <option key={a.id} value={a.id}>
                  {a.code} {a.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="시작일" htmlFor="gl-from" required>
            <Input
              id="gl-from"
              type="date"
              value={form.from}
              onChange={(e) => setForm({ ...form, from: e.target.value })}
            />
          </Field>
          <Field label="종료일" htmlFor="gl-to" required>
            <Input
              id="gl-to"
              type="date"
              value={form.to}
              onChange={(e) => setForm({ ...form, to: e.target.value })}
            />
          </Field>
          <div className="flex items-end gap-1.5">
            <Button type="submit" variant="primary" size="sm">
              조회
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={async () => {
                const result = await trialCsv.refetch();
                if (result.data) download(result.data.csv, `총계정원장_${applied.from}_${applied.to}.csv`);
              }}
            >
              엑셀 내려받기
            </Button>
          </div>
        </form>
      </Card>

      {applied.accountId ? (
        ledger.isLoading ? (
          <Spinner />
        ) : ledger.error ? (
          <EmptyState title="조회할 수 없습니다." description={ledger.error.message} />
        ) : (
          <Card
            title={`${ledger.data!.accountCode} ${ledger.data!.accountName} 계정별원장`}
            actions={
              <Button
                size="sm"
                onClick={async () => {
                  const result = await ledgerCsv.refetch();
                  if (result.data) {
                    download(
                      result.data.csv,
                      `계정별원장_${ledger.data!.accountCode}_${applied.from}_${applied.to}.csv`,
                    );
                  }
                }}
              >
                엑셀 내려받기
              </Button>
            }
          >
            <div className="overflow-x-auto">
              <table className="w-full min-w-[52rem] text-sm">
                <thead className="border-b border-slate-200 text-left text-slate-500">
                  <tr>
                    <th className="px-2 py-1.5 font-medium">일자</th>
                    <th className="px-2 py-1.5 font-medium">전표번호</th>
                    <th className="px-2 py-1.5 font-medium">적요</th>
                    <th className="px-2 py-1.5 font-medium">상대계정</th>
                    <th className="px-2 py-1.5 text-right font-medium">차변</th>
                    <th className="px-2 py-1.5 text-right font-medium">대변</th>
                    <th className="px-2 py-1.5 text-right font-medium">잔액</th>
                  </tr>
                </thead>
                <tbody>
                  <tr className="border-b border-slate-100 bg-slate-50">
                    <td className="px-2 py-1.5 font-medium" colSpan={6}>
                      기초
                    </td>
                    <td className="tabular px-2 py-1.5 text-right">{fmt.krw(ledger.data!.opening)}</td>
                  </tr>
                  {ledger.data!.rows.map((r) => (
                    <tr key={r.lineId} className="border-b border-slate-100">
                      <td className="px-2 py-1.5">{r.entryDate}</td>
                      <td className="px-2 py-1.5">
                        <Link
                          className="text-blue-700 hover:underline"
                          href={`/accounting/journals/${r.entryId}`}
                        >
                          {r.entryNo}
                        </Link>
                      </td>
                      <td className="px-2 py-1.5">{r.description ?? '-'}</td>
                      <td className="px-2 py-1.5">{r.counterpart}</td>
                      <td className="tabular px-2 py-1.5 text-right">
                        {r.debit === '0' ? '' : fmt.krw(r.debit)}
                      </td>
                      <td className="tabular px-2 py-1.5 text-right">
                        {r.credit === '0' ? '' : fmt.krw(r.credit)}
                      </td>
                      <td className="tabular px-2 py-1.5 text-right">{fmt.krw(r.balance)}</td>
                    </tr>
                  ))}
                  <tr className="border-t-2 border-slate-300 bg-slate-50 font-medium">
                    <td className="px-2 py-1.5" colSpan={4}>
                      기말
                    </td>
                    <td className="tabular px-2 py-1.5 text-right">{fmt.krw(ledger.data!.totalDebit)}</td>
                    <td className="tabular px-2 py-1.5 text-right">{fmt.krw(ledger.data!.totalCredit)}</td>
                    <td className="tabular px-2 py-1.5 text-right">{fmt.krw(ledger.data!.closing)}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </Card>
        )
      ) : trial.isLoading ? (
        <Spinner />
      ) : trial.error ? (
        <EmptyState title="조회할 수 없습니다." description={trial.error.message} />
      ) : (
        <Card title={`총계정원장 ${applied.from} ~ ${applied.to}`}>
          {trial.data!.rows.length === 0 ? (
            <EmptyState title="해당 기간의 분개가 없습니다." />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[44rem] text-sm">
                <thead className="border-b border-slate-200 text-left text-slate-500">
                  <tr>
                    <th className="px-2 py-1.5 font-medium">계정코드</th>
                    <th className="px-2 py-1.5 font-medium">계정과목</th>
                    <th className="px-2 py-1.5 text-right font-medium">기초</th>
                    <th className="px-2 py-1.5 text-right font-medium">차변</th>
                    <th className="px-2 py-1.5 text-right font-medium">대변</th>
                    <th className="px-2 py-1.5 text-right font-medium">기말</th>
                  </tr>
                </thead>
                <tbody>
                  {trial.data!.rows.map((r) => (
                    <tr key={r.accountId} className="border-b border-slate-100">
                      <td className="tabular px-2 py-1.5">{r.code}</td>
                      <td className="px-2 py-1.5">
                        <button
                          type="button"
                          className="text-blue-700 hover:underline"
                          onClick={() => {
                            const next = { ...applied, accountId: r.accountId };
                            setForm(next);
                            setApplied(next);
                          }}
                        >
                          {r.name}
                        </button>
                      </td>
                      <td className="tabular px-2 py-1.5 text-right">{fmt.krw(r.opening)}</td>
                      <td className="tabular px-2 py-1.5 text-right">{fmt.krw(r.debit)}</td>
                      <td className="tabular px-2 py-1.5 text-right">{fmt.krw(r.credit)}</td>
                      <td className="tabular px-2 py-1.5 text-right">{fmt.krw(r.closing)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t-2 border-slate-300 font-medium">
                    <td className="px-2 py-1.5" colSpan={3}>
                      합계
                    </td>
                    <td className="tabular px-2 py-1.5 text-right">{fmt.krw(trial.data!.totalDebit)}</td>
                    <td className="tabular px-2 py-1.5 text-right">{fmt.krw(trial.data!.totalCredit)}</td>
                    <td className="px-2 py-1.5" />
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </Card>
      )}
    </div>
  );
}
