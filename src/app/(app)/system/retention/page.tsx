'use client';

/**
 * NFR-SEC-08 / DEC-06 — 개인정보 파기 화면.
 *
 * `src/server/jobs/retention.ts`는 STEP 12부터 plan/approve/execute를 갖고 있었지만 라우터도
 * 화면도 없어서, 퇴직자의 주민등록번호·계좌번호가 무기한 남아 있었다. 이 화면은 세 단계를
 * 분리해서 보여준다: 계획 수립은 계산만 하고 아무 것도 바꾸지 않고, 승인은 사람이 계획을
 * 검토했다는 서명이고, 실행은 되돌릴 수 없는 실제 파기다. 실행은 암호문을 null로 만들고
 * 저장된 파일을 객체 저장소에서 제거한다 — 삭제 표시가 아니라 실제 삭제이므로, 몇 건이
 * 지워지는지 화면에 그대로 적고 그 건수를 다시 입력해야 실행 버튼이 눌리게 한다.
 */
import { useState } from 'react';
import { api, newRequestId } from '@/lib/trpc';
import { Button, Card, EmptyState, Field, Input, Spinner, StatusBadge } from '@/components/ui/primitives';
import { fmt } from '@/lib/format';

interface RetentionPlanItem {
  key: string;
  label: string;
  action: 'PURGE' | 'ANONYMIZE' | 'KEEP';
  years: number | null;
  targetCount: number;
  cutoff: string | null;
}

interface RunResult {
  items?: RetentionPlanItem[];
  executed?: Record<string, number>;
}

interface RetentionRunRow {
  id: string;
  status: string;
  targetCount: number;
  processedCount: number;
  approvedById: string | null;
  executedAt: string | Date | null;
  createdAt: string | Date;
  result: unknown;
}

const ACTION_LABEL: Record<RetentionPlanItem['action'], string> = {
  PURGE: '완전 파기',
  ANONYMIZE: '익명화',
  KEEP: '보관 유지',
};

type RunStatus = 'PLANNED' | 'APPROVED' | 'EXECUTED' | 'FAILED';

/** Maps run statuses onto the badge tones StatusBadge already knows, with our own labels. */
const STATUS_DISPLAY: Record<RunStatus, { badgeStatus: string; label: string }> = {
  PLANNED: { badgeStatus: 'PENDING_APPROVAL', label: '계획됨 (승인 대기)' },
  APPROVED: { badgeStatus: 'APPROVED', label: '승인됨 (실행 대기)' },
  EXECUTED: { badgeStatus: 'COMPLETED', label: '파기 완료' },
  FAILED: { badgeStatus: 'REJECTED', label: '실패' },
};

export default function RetentionPage() {
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmRunId, setConfirmRunId] = useState<string | null>(null);
  const [confirmInput, setConfirmInput] = useState('');

  const utils = api.useUtils();
  const runsQuery = api.admin.retentionRuns.useQuery({ take: 20 });
  // Only 'admin' (permissions '*') reaches this screen today, so this is always readable here;
  // it is used only to turn an approver's id into a name, and falls back to the id if it fails.
  const usersQuery = api.admin.listUsers.useQuery(
    { page: 1, pageSize: 200, sortDir: 'asc', activeOnly: false },
    { retry: false },
  );
  const plan = api.admin.planRetention.useMutation();
  const approve = api.admin.approveRetention.useMutation();
  const execute = api.admin.executeRetention.useMutation();

  const runs = (runsQuery.data ?? []) as RetentionRunRow[];

  function userName(id: string | null): string {
    if (!id) return '-';
    if (id === 'system') return '시스템';
    return usersQuery.data?.rows.find((u) => u.id === id)?.displayName ?? id;
  }

  async function run(fn: () => Promise<unknown>, ok: string): Promise<void> {
    setError(null);
    setMessage(null);
    try {
      await fn();
      setMessage(ok);
      await utils.admin.retentionRuns.invalidate();
    } catch (err) {
      setError((err as { message?: string }).message ?? '처리에 실패했습니다.');
    }
  }

  function onPlan(): void {
    void run(
      () => plan.mutateAsync({ requestId: newRequestId() }),
      '계획을 수립했습니다. 아래에서 항목별 대상 건수를 확인하세요.',
    );
  }

  function onApprove(runId: string): void {
    void run(
      () => approve.mutateAsync({ runId, requestId: newRequestId() }),
      '계획을 승인했습니다. 이제 파기를 실행할 수 있습니다.',
    );
  }

  function openConfirm(runId: string): void {
    setConfirmRunId(runId);
    setConfirmInput('');
    setError(null);
    setMessage(null);
  }

  function closeConfirm(): void {
    setConfirmRunId(null);
    setConfirmInput('');
  }

  function onExecute(runId: string): void {
    void run(async () => {
      await execute.mutateAsync({ runId, requestId: newRequestId() });
      closeConfirm();
    }, '파기를 실행했습니다. 삭제된 개인정보는 복구할 수 없습니다.');
  }

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <header>
        <h1 className="text-lg font-semibold">개인정보 파기</h1>
        <p className="mt-0.5 text-sm text-slate-500">
          보유기간이 지난 개인정보를 계획 → 승인 → 실행 세 단계로 나누어 파기합니다. 계획 수립은 대상 건수를
          계산할 뿐 아무 것도 바꾸지 않고, 실행만 실제로 되돌릴 수 없는 파기를 수행합니다.
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

      <Card
        title="1단계 · 계획 수립"
        actions={
          <Button size="sm" variant="primary" disabled={plan.isPending} onClick={onPlan}>
            {plan.isPending ? '계획 수립 중' : '계획 수립'}
          </Button>
        }
      >
        <p className="text-sm text-slate-600">
          현재 보유기간 정책(DEC-06) 기준으로 파기·익명화 대상 건수를 계산해 새 계획을 만듭니다. 계산만 하며,
          아래에서 승인해야 실행할 수 있습니다.
        </p>
        {plan.data ? (
          <div className="mt-3 overflow-x-auto">
            <PlanItemsTable items={plan.data.items} />
          </div>
        ) : null}
      </Card>

      <Card title="2·3단계 · 승인과 실행 (이력)">
        {runsQuery.isLoading ? (
          <Spinner />
        ) : runs.length === 0 ? (
          <EmptyState
            title="아직 수립된 계획이 없습니다."
            description="위에서 계획 수립을 실행하면 여기에 나타납니다."
          />
        ) : (
          <ul className="flex flex-col gap-3">
            {runs.map((r) => {
              const status = r.status as RunStatus;
              const display = STATUS_DISPLAY[status] ?? { badgeStatus: r.status, label: r.status };
              const result = (r.result ?? null) as RunResult | null;
              const items = result?.items ?? [];
              const canApprove = status === 'PLANNED';
              const canExecute = status === 'APPROVED';

              return (
                <li key={r.id} className="rounded-md border border-slate-200 p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <StatusBadge status={display.badgeStatus} label={display.label} />
                      <span className="text-sm">
                        대상 <strong className="tabular">{fmt.count(r.targetCount)}</strong>건
                        {status === 'EXECUTED' ? (
                          <>
                            {' '}
                            · 처리 <strong className="tabular">{fmt.count(r.processedCount)}</strong>건
                          </>
                        ) : null}
                      </span>
                    </div>
                    <div className="flex flex-wrap items-center gap-3 text-xs text-slate-500">
                      <span>수립 {fmt.dateTime(r.createdAt as unknown as string)}</span>
                      <span>승인자 {userName(r.approvedById)}</span>
                      {r.executedAt ? (
                        <span>실행 {fmt.dateTime(r.executedAt as unknown as string)}</span>
                      ) : null}
                    </div>
                  </div>

                  {items.length > 0 ? (
                    <details className="mt-2">
                      <summary className="cursor-pointer text-xs text-slate-500">항목별 상세</summary>
                      <div className="mt-2 overflow-x-auto">
                        <PlanItemsTable items={items} executed={result?.executed} />
                      </div>
                    </details>
                  ) : null}

                  <div className="mt-3 flex flex-wrap items-start gap-4">
                    <div className="flex items-center gap-2">
                      <Button
                        size="sm"
                        disabled={!canApprove || approve.isPending}
                        onClick={() => onApprove(r.id)}
                      >
                        {approve.isPending ? '승인 처리 중' : '승인'}
                      </Button>
                      {!canApprove ? (
                        <span className="text-xs text-slate-400">
                          계획됨 상태만 승인할 수 있습니다 (현재: {display.label}).
                        </span>
                      ) : null}
                    </div>

                    <ExecuteControl
                      runId={r.id}
                      targetCount={r.targetCount}
                      disabled={!canExecute}
                      reason={
                        canExecute ? undefined : `승인됨 상태만 실행할 수 있습니다 (현재: ${display.label}).`
                      }
                      open={confirmRunId === r.id}
                      confirmInput={confirmInput}
                      pending={execute.isPending}
                      onOpen={() => openConfirm(r.id)}
                      onClose={closeConfirm}
                      onConfirmInputChange={setConfirmInput}
                      onExecute={() => onExecute(r.id)}
                    />
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </div>
  );
}

function PlanItemsTable({
  items,
  executed,
}: {
  items: RetentionPlanItem[];
  executed?: Record<string, number>;
}) {
  return (
    <table className="w-full min-w-[40rem] text-sm">
      <thead className="border-b border-slate-200 text-left text-slate-500">
        <tr>
          <th className="px-2 py-1.5 font-medium">항목</th>
          <th className="px-2 py-1.5 font-medium">처리</th>
          <th className="px-2 py-1.5 text-right font-medium">보유기간(년)</th>
          <th className="px-2 py-1.5 font-medium">기준일</th>
          <th className="px-2 py-1.5 text-right font-medium">
            {executed ? '파기 대상이었던 건수' : '파기 대상 건수'}
          </th>
          {executed ? <th className="px-2 py-1.5 text-right font-medium">실제 처리 건수</th> : null}
        </tr>
      </thead>
      <tbody>
        {items.map((it) => (
          <tr key={it.key} className="border-b border-slate-100 last:border-0">
            <td className="px-2 py-1.5">{it.label}</td>
            <td className="px-2 py-1.5">{ACTION_LABEL[it.action]}</td>
            <td className="tabular px-2 py-1.5 text-right">{it.years ?? '-'}</td>
            <td className="px-2 py-1.5">{it.cutoff ?? '-'}</td>
            <td
              className={`tabular px-2 py-1.5 text-right ${
                it.targetCount > 0 ? 'font-semibold text-red-700' : ''
              }`}
            >
              {fmt.count(it.targetCount)}
            </td>
            {executed ? (
              <td className="tabular px-2 py-1.5 text-right">{fmt.count(executed[it.key] ?? 0)}</td>
            ) : null}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * The destructive step, deliberately shaped to look nothing like the approve button next to
 * it: opening it does nothing by itself, and the real "파기 확정" button stays disabled until
 * the operator types back the exact count that is about to be destroyed. No window.confirm —
 * the restatement and the typed count both stay on the page so a mistaken read is visible.
 */
function ExecuteControl({
  runId,
  targetCount,
  disabled,
  reason,
  open,
  confirmInput,
  pending,
  onOpen,
  onClose,
  onConfirmInputChange,
  onExecute,
}: {
  runId: string;
  targetCount: number;
  disabled: boolean;
  reason?: string;
  open: boolean;
  confirmInput: string;
  pending: boolean;
  onOpen: () => void;
  onClose: () => void;
  onConfirmInputChange: (v: string) => void;
  onExecute: () => void;
}) {
  const matches = confirmInput.trim() !== '' && confirmInput.trim() === String(targetCount);
  const inputId = `retention-confirm-${runId}`;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <Button size="sm" variant="danger" disabled={disabled} onClick={onOpen}>
          파기 실행
        </Button>
        {disabled && reason ? <span className="text-xs text-slate-400">{reason}</span> : null}
      </div>

      {open ? (
        <div className="max-w-md rounded-md border border-red-300 bg-red-50 p-3">
          <p className="text-sm font-semibold text-red-800">
            이 작업은 되돌릴 수 없습니다. 총 {fmt.count(targetCount)}건의 개인정보가 지금 영구히 파기됩니다.
          </p>
          <p className="mt-1 text-xs text-red-700">
            대상 항목의 암호문(주민등록번호·계좌번호 등)은 null로 바뀌고, 첨부된 파일은 저장소에서 삭제됩니다.
            삭제 표시가 아니라 실제 삭제이며, 이후 복구할 수 없습니다.
          </p>
          <Field
            label={`계속하려면 파기될 건수(${targetCount})를 그대로 입력하세요`}
            htmlFor={inputId}
            className="mt-2"
          >
            <Input
              id={inputId}
              inputMode="numeric"
              autoComplete="off"
              value={confirmInput}
              onChange={(e) => onConfirmInputChange(e.target.value)}
            />
          </Field>
          <div className="mt-2 flex gap-2">
            <Button size="sm" variant="danger" disabled={!matches || pending} onClick={onExecute}>
              {pending ? '파기 실행 중' : `${targetCount}건 파기 확정`}
            </Button>
            <Button size="sm" variant="ghost" disabled={pending} onClick={onClose}>
              취소
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
