'use client';

import { useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/trpc';
import { Button, Card, EmptyState, Field, Spinner } from '@/components/ui/primitives';
import { PartnerSelect } from '@/components/sales/partner-select';
import { fmt } from '@/lib/format';

/** SLS-09: payables by partner with their due dates, oldest first. */
export default function PayablesPage() {
  const [partnerId, setPartnerId] = useState('');
  const [applied, setApplied] = useState('');

  const summary = api.sales.payableSummary.useQuery(applied ? { partnerId: applied } : {});

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <header>
        <h1 className="text-lg font-semibold">미지급금</h1>
        <p className="mt-0.5 text-sm text-slate-500">
          매입처별 미지급 잔액과 결제예정일입니다. 지급 화면에서 오래된 건부터 자동 배분할 수 있습니다.
        </p>
      </header>

      <Card title="조회조건">
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            setApplied(partnerId);
          }}
        >
          <Field label="매입처" htmlFor="ap-partner">
            <PartnerSelect
              id="ap-partner"
              includeAll
              partnerType="SUPPLIER"
              value={partnerId}
              onChange={setPartnerId}
            />
          </Field>
          <Button type="submit" variant="primary" size="sm">
            조회
          </Button>
        </form>
      </Card>

      {summary.isLoading ? (
        <Spinner />
      ) : summary.error ? (
        <EmptyState title="조회할 수 없습니다." description={summary.error.message} />
      ) : summary.data!.rows.length === 0 ? (
        <EmptyState title="미지급금이 없습니다." description="확정된 매입전표가 있으면 여기에 나타납니다." />
      ) : (
        <Card title={`미지급 잔액 합계 ${fmt.krw(summary.data!.total)}원`}>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[44rem] text-sm">
              <thead className="border-b border-slate-200 text-left text-slate-500">
                <tr>
                  <th className="px-2 py-1.5 font-medium">매입처</th>
                  <th className="px-2 py-1.5 font-medium">전표번호</th>
                  <th className="px-2 py-1.5 font-medium">전표일</th>
                  <th className="px-2 py-1.5 font-medium">결제예정일</th>
                  <th className="px-2 py-1.5 text-right font-medium">금액</th>
                  <th className="px-2 py-1.5 text-right font-medium">지급</th>
                  <th className="px-2 py-1.5 text-right font-medium">잔액</th>
                </tr>
              </thead>
              <tbody>
                {summary.data!.rows.map((r) => (
                  <tr key={r.id} className="border-b border-slate-100">
                    <td className="px-2 py-1.5">{r.partnerName}</td>
                    <td className="px-2 py-1.5">{r.docNo}</td>
                    <td className="px-2 py-1.5">{r.docDate}</td>
                    <td className="px-2 py-1.5">{r.dueDate ?? '-'}</td>
                    <td className="tabular px-2 py-1.5 text-right">{fmt.krw(r.amount)}</td>
                    <td className="tabular px-2 py-1.5 text-right text-slate-500">
                      {fmt.krw(r.settledAmount)}
                    </td>
                    <td className="tabular px-2 py-1.5 text-right font-medium">{fmt.krw(r.balance)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <p className="mt-3 text-sm">
            <Link className="text-blue-700 hover:underline" href="/settlement/payments">
              지급 등록으로 이동
            </Link>
          </p>
        </Card>
      )}
    </div>
  );
}
