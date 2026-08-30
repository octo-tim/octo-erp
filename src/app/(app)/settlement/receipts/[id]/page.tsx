'use client';

import { use, useState } from 'react';
import Link from 'next/link';
import { api, newRequestId } from '@/lib/trpc';
import { Button, Card, EmptyState, Input, Spinner, StatusBadge } from '@/components/ui/primitives';
import { fmt } from '@/lib/format';

/**
 * SLS-10 — allocating one receipt or payment.
 *
 * The allocation history is shown in full rather than as a single settled figure, because
 * a reallocation is a sequence of events (applied, reversed, re-applied) and hiding that
 * makes a disputed balance impossible to explain to the customer.
 */
const STATUS_LABEL: Record<string, string> = {
  DRAFT: '작성중',
  CONFIRMED: '확정',
  CANCELED: '취소',
};
const ORIGIN_LABEL: Record<string, string> = {
  AUTO: '자동배분',
  MANUAL: '수동배분',
  REVERSAL: '배분취소',
};

export default function SettlementDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const utils = api.useUtils();
  const refresh = { onSuccess: () => utils.sales.invalidate() };

  const detail = api.sales.settlement.useQuery({ id });
  const autoAllocate = api.sales.autoAllocate.useMutation(refresh);
  const reallocate = api.sales.reallocate.useMutation(refresh);
  const confirm = api.sales.confirmSettlement.useMutation(refresh);
  const cancel = api.sales.cancelSettlement.useMutation(refresh);

  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [manual, setManual] = useState(false);
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [reason, setReason] = useState('');

  const kind = detail.data?.docType === 'PAYMENT' ? 'PAYABLE' : 'RECEIVABLE';
  const openItems = api.sales.openItems.useQuery(
    { partnerId: detail.data?.partnerId ?? '', kind },
    { enabled: Boolean(detail.data?.partnerId) },
  );

  if (detail.isLoading) return <Spinner />;
  if (detail.error) return <EmptyState title="전표를 찾을 수 없습니다." description={detail.error.message} />;
  const s = detail.data!;
  const isReceipt = s.docType === 'RECEIPT';

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

  async function submitManual() {
    const allocations = Object.entries(amounts)
      .filter(([, v]) => v.trim() && Number(v) > 0)
      .map(([targetId, amount]) => ({ targetId, amount }));
    if (allocations.length === 0) {
      setError('배분 금액을 입력하세요.');
      return;
    }
    if (reason.trim().length < 2) {
      setError('재배분 사유를 입력하세요.');
      return;
    }
    await run(async () => {
      await reallocate.mutateAsync({ id, allocations, reason, requestId: newRequestId() });
      setManual(false);
      setAmounts({});
      setReason('');
    }, '배분을 변경했습니다.');
  }

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h1 className="text-lg font-semibold">
            {isReceipt ? '수금' : '지급'}{' '}
            <span className="ml-1 text-sm font-normal text-slate-500">{s.docNo}</span>
          </h1>
          <p className="mt-0.5 text-sm text-slate-500">
            {fmt.date(s.docDate as unknown as string)} · {s.partner.name}
            {s.method ? ` · ${s.method}` : ''}
          </p>
        </div>
        <StatusBadge status={s.status} label={STATUS_LABEL[s.status] ?? s.status} />
      </header>

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

      <Card title="금액">
        <dl className="grid grid-cols-[7rem_1fr] gap-y-2 text-sm sm:grid-cols-[7rem_1fr_7rem_1fr]">
          <dt className="text-slate-500">{isReceipt ? '수납액' : '지급액'}</dt>
          <dd className="tabular font-medium">{fmt.krw(s.amount as unknown as string)}</dd>
          <dt className="text-slate-500">배분액</dt>
          <dd className="tabular">{fmt.krw(s.allocatedAmount as unknown as string)}</dd>
          <dt className="text-slate-500">미배분</dt>
          <dd className="tabular">{fmt.krw(s.unapplied)}</dd>
          <dt className="text-slate-500">회계 분개</dt>
          <dd>
            {s.journalEntry ? (
              <Link
                className="text-blue-700 hover:underline"
                href={`/accounting/journals/${s.journalEntry.id}`}
              >
                {s.journalEntry.entryNo}
              </Link>
            ) : (
              '확정 시 생성됩니다.'
            )}
          </dd>
        </dl>
      </Card>

      <Card title="처리">
        <div className="flex flex-wrap gap-1.5">
          {s.status === 'DRAFT' && Number(s.unapplied) > 0 ? (
            <Button
              variant="primary"
              size="sm"
              onClick={() =>
                run(
                  () => autoAllocate.mutateAsync({ id, requestId: newRequestId() }),
                  '오래된 미결부터 자동 배분했습니다.',
                )
              }
            >
              자동 배분
            </Button>
          ) : null}
          {s.status === 'DRAFT' ? (
            <Button size="sm" onClick={() => setManual((v) => !v)}>
              {manual ? '수동 배분 닫기' : '수동 재배분'}
            </Button>
          ) : null}
          {s.status === 'DRAFT' && Number(s.allocatedAmount) > 0 ? (
            <Button
              variant="primary"
              size="sm"
              onClick={() =>
                run(
                  () => confirm.mutateAsync({ id, version: s.version, requestId: newRequestId() }),
                  '확정했습니다. 회계 분개가 생성되었습니다.',
                )
              }
            >
              확정
            </Button>
          ) : null}
          {s.status !== 'CANCELED' ? (
            <Button
              size="sm"
              variant="danger"
              onClick={() =>
                run(
                  () =>
                    cancel.mutateAsync({
                      id,
                      reason: '전표 취소',
                      version: s.version,
                      requestId: newRequestId(),
                    }),
                  '취소했습니다. 배분이 모두 해제되었습니다.',
                )
              }
            >
              전표 취소
            </Button>
          ) : null}
        </div>

        {manual ? (
          <div className="mt-4">
            <p className="mb-2 text-sm text-slate-600">
              기존 배분을 모두 되돌리고 아래 금액으로 다시 배분합니다.
            </p>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[36rem] text-sm">
                <thead className="border-b border-slate-200 text-left text-slate-500">
                  <tr>
                    <th className="px-2 py-1.5 font-medium">전표번호</th>
                    <th className="px-2 py-1.5 font-medium">일자</th>
                    <th className="px-2 py-1.5 text-right font-medium">잔액</th>
                    <th className="px-2 py-1.5 text-right font-medium">배분액</th>
                  </tr>
                </thead>
                <tbody>
                  {(openItems.data ?? []).map((o) => (
                    <tr key={o.id} className="border-b border-slate-100">
                      <td className="px-2 py-1.5">{o.docNo}</td>
                      <td className="px-2 py-1.5">{o.docDate}</td>
                      <td className="tabular px-2 py-1.5 text-right">{fmt.krw(o.balance)}</td>
                      <td className="px-2 py-1.5 text-right">
                        <Input
                          aria-label={`${o.docNo} 배분액`}
                          className="w-32 text-right"
                          inputMode="numeric"
                          value={amounts[o.id] ?? ''}
                          onChange={(e) => setAmounts({ ...amounts, [o.id]: e.target.value })}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="mt-3 flex flex-wrap items-end gap-2">
              <div className="min-w-0 flex-1">
                <label className="mb-1 block text-sm text-slate-600" htmlFor="st-reason">
                  재배분 사유
                </label>
                <Input id="st-reason" value={reason} onChange={(e) => setReason(e.target.value)} />
              </div>
              <Button variant="primary" size="sm" onClick={submitManual} disabled={reallocate.isPending}>
                재배분 적용
              </Button>
            </div>
          </div>
        ) : null}
      </Card>

      <Card title="배분 이력">
        {s.matches.length === 0 ? (
          <EmptyState title="배분 내역이 없습니다." description="'자동 배분'을 눌러 시작하세요." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[36rem] text-sm">
              <thead className="border-b border-slate-200 text-left text-slate-500">
                <tr>
                  <th className="px-2 py-1.5 font-medium">일시</th>
                  <th className="px-2 py-1.5 font-medium">대상 전표</th>
                  <th className="px-2 py-1.5 font-medium">구분</th>
                  <th className="px-2 py-1.5 font-medium">사유</th>
                  <th className="px-2 py-1.5 text-right font-medium">금액</th>
                </tr>
              </thead>
              <tbody>
                {s.matches.map((m) => (
                  <tr key={m.id} className="border-b border-slate-100">
                    <td className="px-2 py-1.5">{fmt.dateTime(m.createdAt as unknown as string)}</td>
                    <td className="px-2 py-1.5">
                      {m.receivable?.document.docNo ?? m.payable?.document.docNo ?? '-'}
                    </td>
                    <td className="px-2 py-1.5">{ORIGIN_LABEL[m.origin] ?? m.origin}</td>
                    <td className="px-2 py-1.5">{m.note ?? '-'}</td>
                    <td className="tabular px-2 py-1.5 text-right">
                      {fmt.krw(m.amount as unknown as string)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
