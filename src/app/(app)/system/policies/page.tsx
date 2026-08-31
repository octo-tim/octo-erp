'use client';

/** DEC-01~09: policy versions are effective-dated and never applied retroactively. */

import { useState } from 'react';
import { api, newRequestId } from '@/lib/trpc';
import {
  Button,
  Card,
  EmptyState,
  Field,
  Input,
  Select,
  Spinner,
  StatusBadge,
} from '@/components/ui/primitives';
import { fmt } from '@/lib/format';

type PolicyKey =
  | 'inventory.valuation'
  | 'money'
  | 'approval.matrix'
  | 'accounting.period'
  | 'leave'
  | 'retention'
  | 'notification';

const POLICY_KEYS: PolicyKey[] = [
  'inventory.valuation',
  'money',
  'approval.matrix',
  'accounting.period',
  'leave',
  'retention',
  'notification',
];

const POLICY_KEY_LABEL: Record<PolicyKey, string> = {
  'inventory.valuation': '재고평가 (DEC-01)',
  money: '금액 정밀도 (DEC-02)',
  'approval.matrix': '결재 매트릭스 (DEC-03)',
  'accounting.period': '회계기간 (DEC-04)',
  leave: '휴가 (DEC-05)',
  retention: '보존기간 (DEC-06)',
  notification: '알림 (DEC-09)',
};

interface PolicyRow {
  id: string;
  policyKey: string;
  version: number;
  effectiveFrom: unknown;
  config: unknown;
  note: string | null;
  createdAt: unknown;
}

/** Mirrors the ordering `policy.resolve()` uses server-side: latest effectiveFrom<=today wins. */
function pickCurrent(rows: PolicyRow[], today: string): PolicyRow | undefined {
  return rows
    .filter((r) => fmt.date(r.effectiveFrom as string) <= today)
    .sort((a, b) => {
      const d = fmt.date(b.effectiveFrom as string).localeCompare(fmt.date(a.effectiveFrom as string));
      return d !== 0 ? d : b.version - a.version;
    })[0];
}

export default function PoliciesPage() {
  const list = api.admin.listPolicies.useQuery({});
  const publish = api.admin.publishPolicy.useMutation();

  const [key, setKey] = useState<PolicyKey>('money');
  const [effectiveFrom, setEffectiveFrom] = useState('');
  const [configText, setConfigText] = useState('{}');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const today = new Date().toISOString().slice(0, 10);
  const byKey = new Map<string, PolicyRow[]>();
  for (const row of (list.data ?? []) as PolicyRow[]) {
    const arr = byKey.get(row.policyKey) ?? [];
    arr.push(row);
    byKey.set(row.policyKey, arr);
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setMessage(null);
    let config: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(configText);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        setError('설정값은 JSON 객체({...}) 형식이어야 합니다.');
        return;
      }
      config = parsed as Record<string, unknown>;
    } catch {
      setError('설정값이 올바른 JSON 형식이 아닙니다.');
      return;
    }
    try {
      const published = await publish.mutateAsync({
        key,
        effectiveFrom,
        config,
        ...(note ? { note } : {}),
        requestId: newRequestId(),
      });
      setMessage(
        `${POLICY_KEY_LABEL[key]} v${published.version}을(를) ${published.effectiveFrom}부터 적용하도록 발행했습니다.`,
      );
      setNote('');
      await list.refetch();
    } catch (err) {
      setError((err as { message?: string }).message ?? '발행에 실패했습니다.');
    }
  }

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <header>
        <h1 className="text-lg font-semibold">정책설정</h1>
        <p className="mt-0.5 text-sm text-slate-500">
          업무 계산·판정 로직(DEC-01~09)은 정책 버전을 읽어 동작합니다. 새 버전을 발행해도 이미 확정된 전표는
          계산 당시 정책 버전을 그대로 유지하며, 과거 문서는 새 정책으로 재계산되지 않습니다.
        </p>
      </header>

      <Card title="새 버전 발행">
        <form className="grid grid-cols-1 gap-3 sm:grid-cols-4" onSubmit={onSubmit}>
          <Field label="정책" htmlFor="pol-key" required>
            <Select id="pol-key" value={key} onChange={(e) => setKey(e.target.value as PolicyKey)}>
              {POLICY_KEYS.map((k) => (
                <option key={k} value={k}>
                  {POLICY_KEY_LABEL[k]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="시행일" htmlFor="pol-effective" required hint="이 날짜부터 새 버전이 적용됩니다.">
            <Input
              id="pol-effective"
              type="date"
              value={effectiveFrom}
              onChange={(e) => setEffectiveFrom(e.target.value)}
            />
          </Field>
          <Field label="비고" htmlFor="pol-note">
            <Input id="pol-note" value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />
          </Field>
          <div className="flex items-end">
            <Button type="submit" size="sm" variant="primary" disabled={!effectiveFrom || publish.isPending}>
              {publish.isPending ? '발행 중' : '발행'}
            </Button>
          </div>
          <Field
            label="설정값 (JSON)"
            htmlFor="pol-config"
            required
            className="sm:col-span-4"
            hint={'정책별 설정 항목을 JSON 객체로 입력하세요. 예: {"vatRate": "0.1"}'}
          >
            <textarea
              id="pol-config"
              rows={5}
              className="w-full rounded-md border border-slate-300 px-2.5 py-1.5 font-mono text-xs"
              value={configText}
              onChange={(e) => setConfigText(e.target.value)}
            />
          </Field>
        </form>
        {message ? (
          <p role="status" className="mt-2 rounded bg-green-50 px-3 py-2 text-sm text-green-800">
            {message}
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="mt-2 rounded bg-red-50 px-3 py-2 text-sm text-red-700">
            {error}
          </p>
        ) : null}
      </Card>

      {list.isLoading ? (
        <Card title="정책 버전">
          <Spinner />
        </Card>
      ) : (list.data ?? []).length === 0 ? (
        <Card title="정책 버전">
          <EmptyState
            title="등록된 정책 버전이 없습니다."
            description="위 양식으로 최초 버전을 발행하세요. 발행 전에는 정책을 사용하는 계산이 실패합니다."
          />
        </Card>
      ) : (
        POLICY_KEYS.filter((k) => (byKey.get(k) ?? []).length > 0).map((k) => {
          const rows = (byKey.get(k) ?? []).slice().sort((a, b) => b.version - a.version);
          const current = pickCurrent(rows, today);
          return (
            <Card key={k} title={POLICY_KEY_LABEL[k]}>
              {current ? (
                <p className="mb-3 text-sm text-slate-600">
                  현재 적용 버전 <strong className="tabular">v{current.version}</strong> · 시행일{' '}
                  <strong className="tabular">{fmt.date(current.effectiveFrom as string)}</strong>
                </p>
              ) : (
                <p className="mb-3 rounded bg-amber-50 px-3 py-2 text-sm text-amber-900">
                  오늘({today}) 기준으로 적용되는 버전이 없습니다. 시행일이 오늘 이전인 버전을 발행하세요.
                </p>
              )}
              <div className="overflow-x-auto">
                <table className="w-full min-w-max text-sm">
                  <thead className="bg-slate-50">
                    <tr>
                      <th scope="col" className="px-3 py-2 text-left font-semibold">
                        버전
                      </th>
                      <th scope="col" className="px-3 py-2 text-left font-semibold">
                        시행일
                      </th>
                      <th scope="col" className="px-3 py-2 text-left font-semibold">
                        상태
                      </th>
                      <th scope="col" className="px-3 py-2 text-left font-semibold">
                        비고
                      </th>
                      <th scope="col" className="px-3 py-2 text-left font-semibold">
                        설정값
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => {
                      const isCurrent = current?.id === r.id;
                      const isFuture = fmt.date(r.effectiveFrom as string) > today;
                      return (
                        <tr key={r.id} className="border-b border-slate-100 last:border-0">
                          <td className="px-3 py-1.5 tabular">v{r.version}</td>
                          <td className="px-3 py-1.5 tabular">{fmt.date(r.effectiveFrom as string)}</td>
                          <td className="px-3 py-1.5">
                            {isCurrent ? (
                              <StatusBadge status="CONFIRMED" label="현재 적용" />
                            ) : isFuture ? (
                              <StatusBadge status="PENDING_APPROVAL" label="예정" />
                            ) : (
                              <StatusBadge status="CANCELED" label="이전 버전" />
                            )}
                          </td>
                          <td className="px-3 py-1.5">{r.note ?? '-'}</td>
                          <td className="px-3 py-1.5">
                            <details>
                              <summary className="cursor-pointer text-xs text-slate-500">보기</summary>
                              <pre className="mt-1 max-w-md overflow-x-auto whitespace-pre-wrap break-all rounded bg-slate-50 p-2 text-xs">
                                {JSON.stringify(r.config, null, 2)}
                              </pre>
                            </details>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </Card>
          );
        })
      )}
    </div>
  );
}
