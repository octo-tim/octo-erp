'use client';

import { useState } from 'react';
import { api, newRequestId } from '@/lib/trpc';
import { Button, Card, EmptyState, Input, Select, Spinner } from '@/components/ui/primitives';

/** Numbering rules (BAS-01, APV-13, INT-11). */
const DOC_LABEL: Record<string, string> = {
  ITEM: '품목',
  PARTNER: '거래처',
  QUOTATION: '견적',
  SALES_ORDER: '주문',
  SALES: '매출전표',
  PURCHASE: '매입전표',
  PURCHASE_REQUEST: '구매요청',
  PURCHASE_ORDER: '발주',
  RETURN_SALES: '매출반품',
  RETURN_PURCHASE: '매입반품',
  RECEIPT: '수금',
  PAYMENT: '지급',
  STOCK_IN: '입고',
  STOCK_OUT: '출고',
  STOCK_MOVE: '창고이동',
  STOCK_COUNT: '재고실사',
  STOCK_ADJUST: '재고조정',
  JOURNAL: '회계전표',
  APPROVAL: '결재문서',
  LEAVE_REQUEST: '휴가신청',
  ATTENDANCE_CORRECTION: '근태정정',
  CERTIFICATE: '증명서',
};
const PERIOD_LABEL: Record<string, string> = { NONE: '없음', YEAR: '연도', MONTH: '연월' };

export default function NumberingPage() {
  const rules = api.master.numberingRules.useQuery();
  const update = api.master.updateNumberingRule.useMutation();
  const [editing, setEditing] = useState<string | null>(null);
  const [form, setForm] = useState({
    prefix: '',
    periodKind: 'MONTH' as 'NONE' | 'YEAR' | 'MONTH',
    seqLength: '4',
  });
  const [error, setError] = useState<string | null>(null);

  function example(prefix: string, periodKind: string, seqLength: number) {
    const seq = '1'.padStart(seqLength, '0');
    if (periodKind === 'NONE') return `${prefix}-${seq}`;
    return `${prefix}-${periodKind === 'YEAR' ? '2026' : '202609'}-${seq}`;
  }

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <header>
        <h1 className="text-lg font-semibold">채번규칙</h1>
        <p className="mt-0.5 text-sm text-slate-500">
          문서번호는 규칙과 데이터베이스 유일성 제약으로 생성되어 동시에 등록해도 중복되지 않습니다. 이미
          발행된 번호는 바뀌지 않습니다.
        </p>
      </header>

      {error ? (
        <p role="alert" className="rounded bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      ) : null}

      <Card title="문서별 채번규칙">
        {rules.isLoading ? (
          <Spinner />
        ) : (rules.data ?? []).length === 0 ? (
          <EmptyState title="등록된 채번규칙이 없습니다." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-max text-sm">
              <thead className="bg-slate-50">
                <tr>
                  <th scope="col" className="px-3 py-2 text-left font-semibold">
                    문서
                  </th>
                  <th scope="col" className="px-3 py-2 text-left font-semibold">
                    접두어
                  </th>
                  <th scope="col" className="px-3 py-2 text-left font-semibold">
                    기간구분
                  </th>
                  <th scope="col" className="px-3 py-2 text-right font-semibold">
                    자릿수
                  </th>
                  <th scope="col" className="px-3 py-2 text-left font-semibold">
                    예시
                  </th>
                  <th scope="col" className="px-3 py-2 text-left font-semibold">
                    최근 발행
                  </th>
                  <th scope="col" className="px-3 py-2 text-left font-semibold">
                    작업
                  </th>
                </tr>
              </thead>
              <tbody>
                {(rules.data ?? []).map((r) =>
                  editing === r.docType ? (
                    <tr key={r.id} className="border-b border-slate-100 bg-blue-50/50">
                      <td className="px-3 py-1.5">{DOC_LABEL[r.docType] ?? r.docType}</td>
                      <td className="px-3 py-1.5">
                        <Input
                          aria-label="접두어"
                          className="w-20"
                          value={form.prefix}
                          onChange={(e) => setForm({ ...form, prefix: e.target.value.toUpperCase() })}
                        />
                      </td>
                      <td className="px-3 py-1.5">
                        <Select
                          aria-label="기간구분"
                          className="w-28"
                          value={form.periodKind}
                          onChange={(e) =>
                            setForm({ ...form, periodKind: e.target.value as typeof form.periodKind })
                          }
                        >
                          <option value="NONE">없음</option>
                          <option value="YEAR">연도</option>
                          <option value="MONTH">연월</option>
                        </Select>
                      </td>
                      <td className="px-3 py-1.5">
                        <Input
                          aria-label="자릿수"
                          className="w-16 tabular text-right"
                          value={form.seqLength}
                          onChange={(e) => setForm({ ...form, seqLength: e.target.value })}
                        />
                      </td>
                      <td className="px-3 py-1.5 tabular text-slate-500">
                        {example(
                          form.prefix || r.prefix,
                          form.periodKind,
                          Number(form.seqLength) || r.seqLength,
                        )}
                      </td>
                      <td className="px-3 py-1.5" />
                      <td className="px-3 py-1.5">
                        <div className="flex gap-1">
                          <Button
                            size="sm"
                            variant="primary"
                            onClick={async () => {
                              setError(null);
                              try {
                                await update.mutateAsync({
                                  docType: r.docType,
                                  prefix: form.prefix,
                                  periodKind: form.periodKind,
                                  seqLength: Number(form.seqLength),
                                  requestId: newRequestId(),
                                });
                                setEditing(null);
                                await rules.refetch();
                              } catch (err) {
                                setError((err as { message?: string }).message ?? '저장에 실패했습니다.');
                              }
                            }}
                          >
                            저장
                          </Button>
                          <Button size="sm" onClick={() => setEditing(null)}>
                            취소
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ) : (
                    <tr key={r.id} className="border-b border-slate-100 last:border-0">
                      <td className="px-3 py-1.5">{DOC_LABEL[r.docType] ?? r.docType}</td>
                      <td className="px-3 py-1.5 font-mono">{r.prefix}</td>
                      <td className="px-3 py-1.5">{PERIOD_LABEL[r.periodKind] ?? r.periodKind}</td>
                      <td className="px-3 py-1.5 tabular text-right">{r.seqLength}</td>
                      <td className="px-3 py-1.5 tabular text-slate-500">
                        {example(r.prefix, r.periodKind, r.seqLength)}
                      </td>
                      <td className="px-3 py-1.5 tabular text-slate-500">
                        {r.counters.length === 0
                          ? '-'
                          : r.counters.map((c) => `${c.periodKey}:${c.lastSeq}`).join(', ')}
                      </td>
                      <td className="px-3 py-1.5">
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => {
                            setEditing(r.docType);
                            setForm({
                              prefix: r.prefix,
                              periodKind: r.periodKind as 'MONTH',
                              seqLength: String(r.seqLength),
                            });
                          }}
                        >
                          수정
                        </Button>
                      </td>
                    </tr>
                  ),
                )}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
