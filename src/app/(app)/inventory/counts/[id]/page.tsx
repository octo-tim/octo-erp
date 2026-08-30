'use client';

import { use, useState } from 'react';
import Link from 'next/link';
import { api, newRequestId } from '@/lib/trpc';
import { Button, Card, EmptyState, Input, Spinner, StatusBadge } from '@/components/ui/primitives';
import { ChangeHistory } from '@/components/ui/change-history';
import { fmt } from '@/lib/format';

/**
 * INV-08: the count sheet. The system quantity shown is the one frozen at 실사 시작,
 * so later movements do not silently change what a difference means — the screen says
 * so rather than leaving the operator to wonder.
 */
const STATUS_LABEL: Record<string, string> = {
  DRAFT: '작성중',
  COUNTING: '실사중',
  PENDING_APPROVAL: '결재중',
  APPROVED: '승인',
  CANCELED: '취소',
};

export default function StockCountDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const utils = api.useUtils();
  const refresh = { onSuccess: () => utils.inventory.invalidate() };

  const detail = api.inventory.count.useQuery({ id });
  const start = api.inventory.startCount.useMutation(refresh);
  const record = api.inventory.recordCount.useMutation(refresh);
  const approve = api.inventory.approveCount.useMutation(refresh);
  const cancel = api.inventory.cancelCount.useMutation(refresh);

  const [counted, setCounted] = useState<Record<string, string>>({});
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (detail.isLoading) return <Spinner />;
  if (detail.error) return <EmptyState title="실사를 찾을 수 없습니다." description={detail.error.message} />;
  const c = detail.data!;
  const lines = c.lines;

  // unsaved edits count as entered, so the reminder reflects what the operator sees
  const uncounted = lines.filter((l) => !(counted[l.itemId] ?? l.countedQty ?? '').trim()).length;

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

  async function saveCounts() {
    const payload = Object.entries(counted)
      .filter(([, v]) => v.trim() !== '')
      .map(([itemId, countedQty]) => ({
        itemId,
        countedQty,
        ...(reasons[itemId] ? { reason: reasons[itemId]! } : {}),
      }));
    if (payload.length === 0) {
      setError('입력된 실사 수량이 없습니다.');
      return;
    }
    await run(
      () => record.mutateAsync({ id, lines: payload, requestId: newRequestId() }),
      `${payload.length}건을 저장했습니다.`,
    );
  }

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h1 className="text-lg font-semibold">
            재고실사 <span className="ml-1 text-sm font-normal text-slate-500">{c.countNo}</span>
          </h1>
          <p className="mt-0.5 text-sm text-slate-500">
            {c.warehouse.name} · {fmt.date(c.countDate as unknown as string)}
            {c.frozenAt ? ` · 전산재고 동결 ${fmt.dateTime(c.frozenAt as unknown as string)}` : ''}
          </p>
        </div>
        <StatusBadge status={c.status} label={STATUS_LABEL[c.status] ?? c.status} />
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

      <Card title="처리">
        <div className="flex flex-wrap gap-1.5">
          {c.status === 'DRAFT' ? (
            <Button
              variant="primary"
              size="sm"
              onClick={() =>
                run(
                  () => start.mutateAsync({ id, version: c.version, requestId: newRequestId() }),
                  '실사를 시작했습니다. 현재 전산재고를 동결했습니다.',
                )
              }
            >
              실사 시작
            </Button>
          ) : null}
          {c.status === 'COUNTING' ? (
            <>
              <Button size="sm" onClick={saveCounts} disabled={record.isPending}>
                실사수량 저장
              </Button>
              <Button
                variant="primary"
                size="sm"
                onClick={() =>
                  run(
                    () => approve.mutateAsync({ id, version: c.version, requestId: newRequestId() }),
                    '승인했습니다. 차이가 있으면 조정전표가 생성됩니다.',
                  )
                }
              >
                승인
              </Button>
            </>
          ) : null}
          {c.status !== 'APPROVED' && c.status !== 'CANCELED' ? (
            <Button
              size="sm"
              variant="danger"
              onClick={() =>
                run(
                  () =>
                    cancel.mutateAsync({
                      id,
                      reason: '실사 취소',
                      version: c.version,
                      requestId: newRequestId(),
                    }),
                  '취소했습니다.',
                )
              }
            >
              실사 취소
            </Button>
          ) : null}
        </div>

        {c.status === 'COUNTING' ? (
          <p className="mt-3 text-sm text-slate-600">
            차이가 없는 품목도 실사수량을 입력해야 승인할 수 있습니다. 미입력 {uncounted}건.
          </p>
        ) : null}

        {c.adjustment ? (
          <p className="mt-3 text-sm">
            조정전표{' '}
            <Link className="text-blue-700 hover:underline" href={`/inventory/documents/${c.adjustment.id}`}>
              {c.adjustment.docNo}
            </Link>{' '}
            ({c.adjustment.status === 'CONFIRMED' ? '확정' : c.adjustment.status})
          </p>
        ) : null}
      </Card>

      <Card title={`실사 품목 (${lines.length}건)`}>
        {lines.length === 0 ? (
          <EmptyState
            title="아직 실사 품목이 없습니다."
            description="'실사 시작'을 누르면 해당 창고의 전산재고가 실사표로 만들어집니다."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[44rem] text-sm">
              <thead className="border-b border-slate-200 text-left text-slate-500">
                <tr>
                  <th className="px-2 py-1.5 font-medium">품목코드</th>
                  <th className="px-2 py-1.5 font-medium">품목명</th>
                  <th className="px-2 py-1.5 text-right font-medium">전산재고</th>
                  <th className="px-2 py-1.5 text-right font-medium">실사수량</th>
                  <th className="px-2 py-1.5 text-right font-medium">차이</th>
                  <th className="px-2 py-1.5 font-medium">사유</th>
                </tr>
              </thead>
              <tbody>
                {lines.map((l) => {
                  const editable = c.status === 'COUNTING';
                  const value = counted[l.itemId] ?? l.countedQty ?? '';
                  const diff = value === '' ? null : Number(value) - Number(l.systemQty);
                  return (
                    <tr key={l.itemId} className="border-b border-slate-100">
                      <td className="px-2 py-1.5">{l.code}</td>
                      <td className="px-2 py-1.5">{l.name}</td>
                      <td className="tabular px-2 py-1.5 text-right">
                        {fmt.qty(l.systemQty)} {l.unitCode}
                      </td>
                      <td className="px-2 py-1.5 text-right">
                        {editable ? (
                          <Input
                            aria-label={`${l.name} 실사수량`}
                            className="w-28 text-right"
                            inputMode="decimal"
                            value={counted[l.itemId] ?? l.countedQty ?? ''}
                            onChange={(e) => setCounted({ ...counted, [l.itemId]: e.target.value })}
                          />
                        ) : (
                          <span className="tabular">{l.countedQty ? fmt.qty(l.countedQty) : '-'}</span>
                        )}
                      </td>
                      <td className="tabular px-2 py-1.5 text-right">
                        {diff === null ? (
                          '-'
                        ) : diff === 0 ? (
                          <span className="text-slate-500">0</span>
                        ) : (
                          <span
                            className={diff < 0 ? 'font-medium text-red-700' : 'font-medium text-blue-700'}
                          >
                            {diff > 0 ? '+' : ''}
                            {diff}
                          </span>
                        )}
                      </td>
                      <td className="px-2 py-1.5">
                        {editable ? (
                          <Input
                            aria-label={`${l.name} 사유`}
                            value={reasons[l.itemId] ?? l.reason ?? ''}
                            onChange={(e) => setReasons({ ...reasons, [l.itemId]: e.target.value })}
                          />
                        ) : (
                          (l.reason ?? '-')
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <ChangeHistory entityType="StockCount" entityId={id} />
    </div>
  );
}
