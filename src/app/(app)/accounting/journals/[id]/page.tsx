'use client';

import { use, useState } from 'react';
import Link from 'next/link';
import { api, newRequestId } from '@/lib/trpc';
import { Button, Card, EmptyState, Input, Spinner, StatusBadge } from '@/components/ui/primitives';
import { InternalNotice } from '@/components/accounting/internal-notice';
import { fmt } from '@/lib/format';

/** ACC-02/ACC-04/ACC-08: one entry, its lines, and its reversal relationship. */
const STATUS_LABEL: Record<string, string> = {
  DRAFT: '작성중',
  PENDING_APPROVAL: '결재중',
  CONFIRMED: '확정',
  CANCELED: '취소',
};
const TYPE_LABEL: Record<string, string> = { TRANSFER: '대체', RECEIPT: '입금', PAYMENT: '출금' };

export default function JournalDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const utils = api.useUtils();
  const refresh = { onSuccess: () => utils.accounting.invalidate() };

  const detail = api.accounting.entry.useQuery({ id });
  const confirm = api.accounting.confirmEntry.useMutation(refresh);
  const cancel = api.accounting.cancelEntry.useMutation(refresh);

  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cancelReason, setCancelReason] = useState('');
  const [cancelling, setCancelling] = useState(false);

  if (detail.isLoading) return <Spinner />;
  if (detail.error) return <EmptyState title="전표를 찾을 수 없습니다." description={detail.error.message} />;
  const e = detail.data!;

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
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h1 className="text-lg font-semibold">
            회계전표 <span className="ml-1 text-sm font-normal text-slate-500">{e.entryNo}</span>
          </h1>
          <p className="mt-0.5 text-sm text-slate-500">
            {fmt.date(e.entryDate as unknown as string)} · {TYPE_LABEL[e.entryType] ?? e.entryType} ·{' '}
            {e.period.periodKey} 기간 {e.period.status === 'CLOSED' ? '마감' : '진행'}
            {e.sourceType ? ` · 원천 ${e.sourceType}` : ' · 수동 입력'}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {e.isClosingEntry ? (
            <span className="rounded bg-slate-100 px-2 py-0.5 text-xs text-slate-700">마감분개</span>
          ) : null}
          <StatusBadge status={e.status} label={STATUS_LABEL[e.status] ?? e.status} />
        </div>
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

      {e.reversalOf ? (
        <p className="rounded bg-blue-50 px-3 py-2 text-sm text-blue-900">
          이 전표는{' '}
          <Link className="underline" href={`/accounting/journals/${e.reversalOf.id}`}>
            {e.reversalOf.entryNo}
          </Link>
          의 역분개입니다.
        </p>
      ) : null}
      {e.reversedBy ? (
        <p className="rounded bg-amber-50 px-3 py-2 text-sm text-amber-900">
          이 전표는{' '}
          <Link className="underline" href={`/accounting/journals/${e.reversedBy.id}`}>
            {e.reversedBy.entryNo}
          </Link>
          으로 역분개되었습니다.
        </p>
      ) : null}

      <Card title="분개">
        <p className="mb-3 text-sm text-slate-600">{e.description ?? '적요 없음'}</p>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[44rem] text-sm">
            <thead className="border-b border-slate-200 text-left text-slate-500">
              <tr>
                <th className="px-2 py-1.5 font-medium">#</th>
                <th className="px-2 py-1.5 font-medium">계정과목</th>
                <th className="px-2 py-1.5 font-medium">적요</th>
                <th className="px-2 py-1.5 font-medium">거래처</th>
                <th className="px-2 py-1.5 font-medium">부문</th>
                <th className="px-2 py-1.5 text-right font-medium">차변</th>
                <th className="px-2 py-1.5 text-right font-medium">대변</th>
              </tr>
            </thead>
            <tbody>
              {e.lines.map((l) => (
                <tr key={l.id} className="border-b border-slate-100">
                  <td className="px-2 py-1.5">{l.lineNo}</td>
                  <td className="px-2 py-1.5">
                    <span className="tabular text-slate-500">{l.account.code}</span> {l.account.name}
                  </td>
                  <td className="px-2 py-1.5">{l.description ?? '-'}</td>
                  <td className="px-2 py-1.5">{l.partner?.name ?? '-'}</td>
                  <td className="px-2 py-1.5">{l.division?.name ?? '-'}</td>
                  <td className="tabular px-2 py-1.5 text-right">
                    {l.debit.toString() === '0' ? '' : fmt.krw(l.debit as unknown as string)}
                  </td>
                  <td className="tabular px-2 py-1.5 text-right">
                    {l.credit.toString() === '0' ? '' : fmt.krw(l.credit as unknown as string)}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t-2 border-slate-300 font-medium">
                <td className="px-2 py-1.5" colSpan={5}>
                  합계
                </td>
                <td className="tabular px-2 py-1.5 text-right">
                  {fmt.krw(e.totalDebit as unknown as string)}
                </td>
                <td className="tabular px-2 py-1.5 text-right">
                  {fmt.krw(e.totalCredit as unknown as string)}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      </Card>

      <Card title="처리">
        <div className="flex flex-wrap gap-1.5">
          {e.status === 'DRAFT' || e.status === 'PENDING_APPROVAL' ? (
            <Button
              variant="primary"
              size="sm"
              onClick={() =>
                run(
                  () => confirm.mutateAsync({ id, version: e.version, requestId: newRequestId() }),
                  '확정했습니다.',
                )
              }
            >
              확정
            </Button>
          ) : null}
          {e.status !== 'CANCELED' && !e.isClosingEntry ? (
            <Button size="sm" variant="danger" onClick={() => setCancelling((v) => !v)}>
              {cancelling ? '취소 닫기' : '전표 취소'}
            </Button>
          ) : null}
        </div>

        {cancelling ? (
          <div className="mt-3 flex flex-wrap items-end gap-2">
            <div className="min-w-0 flex-1">
              <label className="mb-1 block text-sm text-slate-600" htmlFor="jv-cancel-reason">
                취소 사유
              </label>
              <Input
                id="jv-cancel-reason"
                value={cancelReason}
                onChange={(ev) => setCancelReason(ev.target.value)}
              />
            </div>
            <Button
              size="sm"
              variant="danger"
              disabled={cancelReason.trim().length < 2}
              onClick={() =>
                run(async () => {
                  await cancel.mutateAsync({
                    id,
                    reason: cancelReason,
                    version: e.version,
                    requestId: newRequestId(),
                  });
                  setCancelling(false);
                  setCancelReason('');
                }, '취소했습니다. 확정 전표였다면 역분개가 생성되었습니다.')
              }
            >
              취소 확정
            </Button>
          </div>
        ) : null}

        {e.status === 'CANCELED' && e.cancelReason ? (
          <p className="mt-3 text-sm text-slate-600">취소 사유: {e.cancelReason}</p>
        ) : null}
        {e.status === 'CONFIRMED' ? (
          <p className="mt-3 text-xs text-slate-500">
            확정 전표는 수정할 수 없습니다. 정정이 필요하면 취소하여 역분개를 만든 뒤 새 전표를 작성하세요.
          </p>
        ) : null}
      </Card>
    </div>
  );
}
