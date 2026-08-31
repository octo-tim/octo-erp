'use client';

/** NFR-OPS-05/INT-10: outbox health and retry for failed side-effect jobs. */

import { useState } from 'react';
import { api, newRequestId } from '@/lib/trpc';
import { Button, Card, EmptyState, Field, Select, Spinner, StatusBadge } from '@/components/ui/primitives';
import { fmt } from '@/lib/format';

type OutboxStatus = 'PENDING' | 'PROCESSING' | 'DONE' | 'FAILED';

/** Maps outbox statuses onto the badge tones StatusBadge already knows, with our own labels. */
const STATUS_DISPLAY: Record<OutboxStatus, { badgeStatus: string; label: string }> = {
  PENDING: { badgeStatus: 'PENDING_APPROVAL', label: '대기' },
  PROCESSING: { badgeStatus: 'IN_PROGRESS', label: '처리중' },
  DONE: { badgeStatus: 'COMPLETED', label: '완료' },
  FAILED: { badgeStatus: 'REJECTED', label: '실패' },
};

export default function JobsPage() {
  const [status, setStatus] = useState<OutboxStatus | ''>('FAILED');
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const pageSize = 50;

  const utils = api.useUtils();
  const health = api.admin.systemHealth.useQuery(undefined, { refetchInterval: 30_000 });
  const list = api.admin.outboxEvents.useQuery({
    page,
    pageSize,
    ...(status ? { status } : {}),
  });
  const retry = api.admin.retryOutbox.useMutation();

  const rows = list.data?.rows ?? [];
  const total = list.data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const failedSelectable = rows.filter((r) => r.status === 'FAILED').map((r) => r.id);

  async function retryIds(ids: string[]) {
    if (ids.length === 0) return;
    setError(null);
    setMessage(null);
    try {
      const res = await retry.mutateAsync({ ids, requestId: newRequestId() });
      setMessage(`${res.retried}건을 재시도 대기 상태로 되돌렸습니다.`);
      setSelected([]);
      await Promise.all([utils.admin.outboxEvents.invalidate(), utils.admin.systemHealth.invalidate()]);
    } catch (err) {
      setError((err as { message?: string }).message ?? '재시도 처리에 실패했습니다.');
    }
  }

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <header>
        <h1 className="text-lg font-semibold">실패작업</h1>
        <p className="mt-0.5 text-sm text-slate-500">
          이메일·메신저 발송 등 DB 밖 부작용은 아웃박스에 쌓여 워커가 순차 처리합니다. 실패한 건은 원인을
          확인한 뒤 재시도하세요.
        </p>
      </header>

      <Card title="상태 요약">
        {health.isLoading ? (
          <Spinner />
        ) : (
          <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
            <div>
              <dt className="text-slate-500">대기중</dt>
              <dd className="tabular text-lg font-semibold">{fmt.count(health.data?.outbox.pending ?? 0)}</dd>
            </div>
            <div>
              <dt className="text-slate-500">실패</dt>
              <dd
                className={`tabular text-lg font-semibold ${
                  (health.data?.outbox.failed ?? 0) > 0 ? 'text-red-700' : ''
                }`}
              >
                {fmt.count(health.data?.outbox.failed ?? 0)}
              </dd>
            </div>
            <div>
              <dt className="text-slate-500">가장 오래된 대기 건</dt>
              <dd className="text-sm">
                {health.data?.outbox.oldestPendingAt
                  ? fmt.dateTime(health.data.outbox.oldestPendingAt as unknown as string)
                  : '-'}
              </dd>
            </div>
            <div>
              <dt className="text-slate-500">다음 재시도 대기시간</dt>
              <dd className="tabular text-sm">
                {Math.round((health.data?.outbox.nextBackoffMs ?? 0) / 1000)}초
              </dd>
            </div>
          </dl>
        )}
      </Card>

      {message ? (
        <p role="status" className="rounded bg-green-50 px-3 py-2 text-sm text-green-800">
          {message}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="rounded bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      ) : null}

      <Card
        title={`아웃박스 이벤트 (${fmt.count(total)}건)`}
        actions={
          <div className="flex items-center gap-2">
            <Field label="상태" htmlFor="job-status" className="w-40">
              <Select
                id="job-status"
                value={status}
                onChange={(e) => {
                  setStatus(e.target.value as OutboxStatus | '');
                  setPage(1);
                  setSelected([]);
                }}
              >
                <option value="">전체</option>
                <option value="PENDING">대기</option>
                <option value="PROCESSING">처리중</option>
                <option value="DONE">완료</option>
                <option value="FAILED">실패</option>
              </Select>
            </Field>
            <Button
              size="sm"
              disabled={failedSelectable.length === 0}
              onClick={() => setSelected(failedSelectable)}
            >
              실패건 전체 선택
            </Button>
            <Button
              size="sm"
              variant="primary"
              disabled={selected.length === 0 || retry.isPending}
              onClick={() => retryIds(selected)}
            >
              {retry.isPending ? '재시도 중' : `선택 재시도 (${selected.length})`}
            </Button>
          </div>
        }
      >
        {list.isLoading ? (
          <Spinner />
        ) : rows.length === 0 ? (
          <EmptyState
            title="조건에 맞는 아웃박스 이벤트가 없습니다."
            description="상태 필터를 바꾸어 다시 확인하세요."
          />
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full min-w-max text-sm">
                <thead className="bg-slate-50">
                  <tr>
                    <th scope="col" className="w-8 px-3 py-2">
                      <span className="sr-only">선택</span>
                    </th>
                    <th scope="col" className="px-3 py-2 text-left font-semibold">
                      토픽
                    </th>
                    <th scope="col" className="px-3 py-2 text-left font-semibold">
                      상태
                    </th>
                    <th scope="col" className="px-3 py-2 text-right font-semibold">
                      시도횟수
                    </th>
                    <th scope="col" className="px-3 py-2 text-left font-semibold">
                      다음 시도
                    </th>
                    <th scope="col" className="px-3 py-2 text-left font-semibold">
                      마지막 오류
                    </th>
                    <th scope="col" className="px-3 py-2 text-left font-semibold">
                      생성일시
                    </th>
                    <th scope="col" className="px-3 py-2 text-left font-semibold">
                      작업
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((ev) => {
                    const display = STATUS_DISPLAY[ev.status as OutboxStatus];
                    const isFailed = ev.status === 'FAILED';
                    return (
                      <tr
                        key={ev.id}
                        className={`border-b border-slate-100 last:border-0 ${
                          isFailed ? 'bg-red-50/60' : ''
                        }`}
                      >
                        <td className="px-3 py-1.5">
                          {isFailed ? (
                            <input
                              type="checkbox"
                              aria-label={`${ev.topic} 선택`}
                              checked={selected.includes(ev.id)}
                              onChange={(e) =>
                                setSelected((prev) =>
                                  e.target.checked ? [...prev, ev.id] : prev.filter((id) => id !== ev.id),
                                )
                              }
                            />
                          ) : null}
                        </td>
                        <td className="px-3 py-1.5">{ev.topic}</td>
                        <td className="px-3 py-1.5">
                          <StatusBadge status={display?.badgeStatus ?? ev.status} label={display?.label} />
                        </td>
                        <td className="tabular px-3 py-1.5 text-right">{ev.attempt}</td>
                        <td className="px-3 py-1.5">{fmt.dateTime(ev.nextAttemptAt as unknown as string)}</td>
                        <td className="max-w-xs truncate px-3 py-1.5 text-red-700" title={ev.lastError ?? ''}>
                          {ev.lastError ?? '-'}
                        </td>
                        <td className="px-3 py-1.5">{fmt.dateTime(ev.createdAt as unknown as string)}</td>
                        <td className="px-3 py-1.5">
                          {isFailed ? (
                            <Button size="sm" variant="ghost" onClick={() => retryIds([ev.id])}>
                              재시도
                            </Button>
                          ) : (
                            '-'
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="mt-3 flex items-center justify-between text-sm text-slate-500">
              <span>
                {page} / {totalPages} 페이지
              </span>
              <div className="flex gap-1.5">
                <Button size="sm" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>
                  이전
                </Button>
                <Button
                  size="sm"
                  disabled={page >= totalPages}
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                >
                  다음
                </Button>
              </div>
            </div>
          </>
        )}
      </Card>
    </div>
  );
}
