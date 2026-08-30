'use client';

import { useState } from 'react';
import { api, newRequestId } from '@/lib/trpc';
import { Button, Card, EmptyState, Field, Input, Spinner, StatusBadge } from '@/components/ui/primitives';
import { fmt } from '@/lib/format';
import { businessDate } from '@/lib/dates';

/**
 * INV-09 / DEC-01: month close. The preview is deliberately a separate step — the
 * adjustment it shows is what will be posted, so nobody closes a month without first
 * seeing the number it moves.
 */
export default function ValuationPage() {
  const utils = api.useUtils();
  const refresh = { onSuccess: () => utils.inventory.invalidate() };

  const thisMonth = businessDate(new Date()).slice(0, 7);
  const [period, setPeriod] = useState(thisMonth);
  const [applied, setApplied] = useState<string | null>(null);
  const [reopenReason, setReopenReason] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const periods = api.inventory.periods.useQuery();
  const preview = api.inventory.closePreview.useQuery(
    { period: applied ?? thisMonth },
    { enabled: Boolean(applied) },
  );
  const close = api.inventory.closePeriod.useMutation(refresh);
  const reopen = api.inventory.reopenPeriod.useMutation(refresh);
  const reconcile = api.inventory.reconcile.useQuery(undefined, { enabled: false });
  const rebuild = api.inventory.rebuildSnapshot.useMutation(refresh);

  const closedPeriods = new Set(
    (periods.data ?? []).filter((p) => p.status === 'CLOSED').map((p) => p.period),
  );

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
        <h1 className="text-lg font-semibold">재고 평가·월마감</h1>
        <p className="mt-0.5 text-sm text-slate-500">
          월 총평균법(DEC-01)입니다. 당월 출고는 잠정단가로 평가하고, 마감 시 확정 평균가로 재계산해 차이를
          마감조정 원장에 반영합니다.
        </p>
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

      <Card title="마감 대상 기간">
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            setApplied(period);
          }}
        >
          <Field label="기간" htmlFor="vp-period" hint="YYYY-MM" required>
            <Input
              id="vp-period"
              value={period}
              onChange={(e) => setPeriod(e.target.value)}
              placeholder="2026-06"
              pattern="\d{4}-\d{2}"
            />
          </Field>
          <Button type="submit" variant="primary" size="sm">
            마감 미리보기
          </Button>
        </form>
      </Card>

      {applied ? (
        preview.isLoading ? (
          <Spinner />
        ) : preview.error ? (
          <EmptyState title="미리보기를 만들 수 없습니다." description={preview.error.message} />
        ) : (
          <Card
            title={`${applied} 마감 미리보기`}
            actions={
              closedPeriods.has(applied) ? (
                <StatusBadge status="CONFIRMED" label="마감됨" />
              ) : (
                <Button
                  variant="primary"
                  size="sm"
                  onClick={() =>
                    run(
                      () => close.mutateAsync({ period: applied, requestId: newRequestId() }),
                      `${applied} 마감했습니다.`,
                    )
                  }
                >
                  마감 확정
                </Button>
              )
            }
          >
            <p className="mb-3 text-sm text-slate-600">
              대상 품목 {fmt.count(preview.data!.items)}건 · 마감조정 합계{' '}
              <span className="tabular font-medium">{fmt.krw(preview.data!.totalAdjustment)}</span>원
            </p>

            {preview.data!.lines.length === 0 ? (
              <EmptyState title="해당 기간의 재고 이동이 없습니다." />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[52rem] text-sm">
                  <thead className="border-b border-slate-200 text-left text-slate-500">
                    <tr>
                      <th className="px-2 py-1.5 font-medium">품목</th>
                      <th className="px-2 py-1.5 text-right font-medium">확정 평균가</th>
                      <th className="px-2 py-1.5 text-right font-medium">출고수량</th>
                      <th className="px-2 py-1.5 text-right font-medium">잠정 출고원가</th>
                      <th className="px-2 py-1.5 text-right font-medium">확정 출고원가</th>
                      <th className="px-2 py-1.5 text-right font-medium">조정</th>
                      <th className="px-2 py-1.5 text-right font-medium">기말수량</th>
                      <th className="px-2 py-1.5 text-right font-medium">기말금액</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.data!.lines.map((l) => (
                      <tr key={l.itemId} className="border-b border-slate-100">
                        <td className="px-2 py-1.5">{l.itemName}</td>
                        <td className="tabular px-2 py-1.5 text-right">{fmt.krw(l.averageCost)}</td>
                        <td className="tabular px-2 py-1.5 text-right">{fmt.qty(l.outQty)}</td>
                        <td className="tabular px-2 py-1.5 text-right">{fmt.krw(l.provisionalOutAmount)}</td>
                        <td className="tabular px-2 py-1.5 text-right">{fmt.krw(l.finalOutAmount)}</td>
                        <td className="tabular px-2 py-1.5 text-right font-medium">
                          {fmt.krw(l.adjustment)}
                        </td>
                        <td className="tabular px-2 py-1.5 text-right">{fmt.qty(l.closingQty)}</td>
                        <td className="tabular px-2 py-1.5 text-right">{fmt.krw(l.closingAmount)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        )
      ) : null}

      <Card title="기간 목록">
        {(periods.data ?? []).length === 0 ? (
          <EmptyState title="마감된 기간이 없습니다." />
        ) : (
          <ul className="divide-y divide-slate-100 text-sm">
            {(periods.data ?? []).map((p) => (
              <li key={p.id} className="flex flex-wrap items-center gap-3 py-2">
                <span className="tabular font-medium">{p.period}</span>
                <StatusBadge
                  status={p.status === 'CLOSED' ? 'CONFIRMED' : 'DRAFT'}
                  label={p.status === 'CLOSED' ? '마감' : '진행'}
                />
                {p.closedAt ? (
                  <span className="text-slate-500">{fmt.dateTime(p.closedAt as unknown as string)}</span>
                ) : null}
                {p.reopenReason ? <span className="text-slate-500">해제 사유: {p.reopenReason}</span> : null}
                {p.status === 'CLOSED' ? (
                  <span className="ml-auto flex items-center gap-2">
                    <Input
                      aria-label={`${p.period} 마감 해제 사유`}
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
                            period: p.period,
                            reason: reopenReason,
                            requestId: newRequestId(),
                          });
                          setReopenReason('');
                        }, `${p.period} 마감을 해제했습니다.`)
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

      <Card
        title="원장·캐시 대조"
        actions={
          <Button size="sm" onClick={() => void reconcile.refetch()}>
            대조 실행
          </Button>
        }
      >
        <p className="mb-3 text-sm text-slate-600">
          현재고 캐시는 재고 원장에서 재생성할 수 있습니다. 원장이 진실이므로, 아래에 나오는 행은 모두 캐시 쪽
          오류입니다.
        </p>
        {reconcile.data === undefined ? (
          <EmptyState title="아직 대조하지 않았습니다." description="'대조 실행'을 눌러 확인하세요." />
        ) : reconcile.data.length === 0 ? (
          <p className="text-sm text-green-800">불일치가 없습니다.</p>
        ) : (
          <>
            <p className="mb-2 text-sm text-red-700">불일치 {reconcile.data.length}건</p>
            <Button
              size="sm"
              variant="danger"
              onClick={() =>
                run(async () => {
                  await rebuild.mutateAsync({ requestId: newRequestId() });
                  await reconcile.refetch();
                }, '캐시를 원장에서 재생성했습니다.')
              }
            >
              캐시 재생성
            </Button>
          </>
        )}
      </Card>
    </div>
  );
}
