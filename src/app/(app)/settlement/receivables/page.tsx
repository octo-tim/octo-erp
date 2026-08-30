'use client';

import { useState } from 'react';
import { api } from '@/lib/trpc';
import { Button, Card, EmptyState, Field, Input, Spinner } from '@/components/ui/primitives';
import { PartnerSelect } from '@/components/sales/partner-select';
import { fmt } from '@/lib/format';
import { businessDate } from '@/lib/dates';

/**
 * SLS-08 — receivables by partner with 30/60/90-day aging and the credit-limit position.
 * Over-limit partners are marked in text as well as colour (NFR-UX-03).
 */
export default function ReceivablesPage() {
  const today = businessDate(new Date());
  const [form, setForm] = useState({ asOf: today, partnerId: '' });
  const [applied, setApplied] = useState(form);

  const aging = api.sales.aging.useQuery({
    asOf: applied.asOf,
    ...(applied.partnerId ? { partnerId: applied.partnerId } : {}),
  });

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <header>
        <h1 className="text-lg font-semibold">미수금</h1>
        <p className="mt-0.5 text-sm text-slate-500">
          거래처별 미수 잔액과 연령분석입니다. 여신한도를 넘은 거래처는 별도로 표시됩니다.
        </p>
      </header>

      <Card title="조회조건">
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            setApplied(form);
          }}
        >
          <Field label="기준일" htmlFor="ar-asof" required>
            <Input
              id="ar-asof"
              type="date"
              value={form.asOf}
              onChange={(e) => setForm({ ...form, asOf: e.target.value })}
            />
          </Field>
          <Field label="거래처" htmlFor="ar-partner">
            <PartnerSelect
              id="ar-partner"
              includeAll
              partnerType="CUSTOMER"
              value={form.partnerId}
              onChange={(v) => setForm({ ...form, partnerId: v })}
            />
          </Field>
          <Button type="submit" variant="primary" size="sm">
            조회
          </Button>
        </form>
      </Card>

      {aging.isLoading ? (
        <Spinner />
      ) : aging.error ? (
        <EmptyState title="조회할 수 없습니다." description={aging.error.message} />
      ) : aging.data!.rows.length === 0 ? (
        <EmptyState title="미수금이 없습니다." description="확정된 매출전표가 있으면 여기에 나타납니다." />
      ) : (
        <Card title={`미수 잔액 합계 ${fmt.krw(aging.data!.total)}원`}>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[52rem] text-sm">
              <thead className="border-b border-slate-200 text-left text-slate-500">
                <tr>
                  <th className="px-2 py-1.5 font-medium">거래처</th>
                  {Object.entries(aging.data!.bucketLabels).map(([k, label]) => (
                    <th key={k} className="px-2 py-1.5 text-right font-medium">
                      {label}
                    </th>
                  ))}
                  <th className="px-2 py-1.5 text-right font-medium">합계</th>
                  <th className="px-2 py-1.5 text-right font-medium">여신한도</th>
                </tr>
              </thead>
              <tbody>
                {aging.data!.rows.map((r) => (
                  <tr key={r.partnerId} className="border-b border-slate-100">
                    <td className="px-2 py-1.5">
                      {r.partnerName}
                      {r.overLimit ? (
                        <span className="ml-2 rounded bg-red-50 px-1.5 py-0.5 text-xs font-medium text-red-700">
                          한도초과
                        </span>
                      ) : null}
                    </td>
                    {(['CURRENT', 'D30', 'D60', 'D90', 'OVER90'] as const).map((b) => (
                      <td key={b} className="tabular px-2 py-1.5 text-right">
                        {r.buckets[b] === '0' ? '' : fmt.krw(r.buckets[b])}
                      </td>
                    ))}
                    <td className="tabular px-2 py-1.5 text-right font-medium">{fmt.krw(r.total)}</td>
                    <td className="tabular px-2 py-1.5 text-right text-slate-500">
                      {r.creditLimit ? fmt.krw(r.creditLimit) : '-'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}
