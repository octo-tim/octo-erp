'use client';

import { useState } from 'react';
import { api, newRequestId } from '@/lib/trpc';
import { Button, Card, EmptyState, Field, Input, Select, Spinner } from '@/components/ui/primitives';
import { fmt } from '@/lib/format';

/** APV-03/APV-04: line templates, rules and delegation. */
const RESOLVE_LABEL: Record<string, string> = {
  USER: '지정 사용자',
  POSITION: '직위',
  DEPARTMENT_HEAD: '부서장',
  DRAFTER_MANAGER: '기안자 부서장',
};

export default function ApprovalLinesPage() {
  const templates = api.approval.lineTemplates.useQuery();
  const forms = api.approval.forms.useQuery();
  const rules = api.approval.rules.useQuery(undefined, { retry: false });
  const delegations = api.approval.listDelegations.useQuery();
  const users = api.admin.listUsers.useQuery(
    { page: 1, pageSize: 100, sortDir: 'asc', activeOnly: true },
    { retry: false },
  );

  const templateLabelById = new Map(
    (templates.data ?? []).map((t) => [t.id, `${t.name} (${t.code})`] as const),
  );
  const formLabelById = new Map((forms.data ?? []).map((f) => [f.id, `${f.name} (${f.code})`] as const));
  const setDelegation = api.approval.setDelegation.useMutation();
  const endDelegation = api.approval.endDelegation.useMutation();

  const [form, setForm] = useState({ toUserId: '', validFrom: '', validTo: '', reason: '' });
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <h1 className="text-lg font-semibold">결재선·전결</h1>

      <Card title="결재선 서식">
        {templates.isLoading ? (
          <Spinner />
        ) : (templates.data ?? []).length === 0 ? (
          <EmptyState title="등록된 결재선 서식이 없습니다." />
        ) : (
          (templates.data ?? []).map((t) => (
            <div key={t.id} className="mb-4 last:mb-0">
              <p className="mb-1 text-sm font-medium">
                {t.name} <span className="text-xs text-slate-500">{t.code}</span>
              </p>
              <div className="overflow-x-auto">
                <table className="w-full min-w-max text-sm">
                  <thead className="bg-slate-50">
                    <tr>
                      <th scope="col" className="px-3 py-2 text-left font-semibold">
                        단계
                      </th>
                      <th scope="col" className="px-3 py-2 text-left font-semibold">
                        구분
                      </th>
                      <th scope="col" className="px-3 py-2 text-left font-semibold">
                        결재자 결정
                      </th>
                      <th scope="col" className="px-3 py-2 text-right font-semibold">
                        적용 최소금액
                      </th>
                      <th scope="col" className="px-3 py-2 text-left font-semibold">
                        전결
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {t.steps.map((s) => (
                      <tr key={s.id} className="border-b border-slate-100 last:border-0">
                        <td className="px-3 py-1.5 tabular">{s.stepNo}</td>
                        <td className="px-3 py-1.5">
                          {s.role === 'AGREE' ? '합의' : s.role === 'REFERENCE' ? '참조' : '결재'}
                        </td>
                        <td className="px-3 py-1.5">
                          {RESOLVE_LABEL[s.resolveBy] ?? s.resolveBy}
                          {s.positionCode ? ` (${s.positionCode})` : ''}
                        </td>
                        <td className="px-3 py-1.5 tabular text-right">
                          {s.minAmount ? fmt.krw(s.minAmount as unknown as string) : '-'}
                        </td>
                        <td className="px-3 py-1.5">{s.canFinalize ? '가능' : '-'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ))
        )}
      </Card>

      {rules.data ? (
        <Card title="결재선 규칙">
          {rules.data.length === 0 ? (
            <EmptyState
              title="등록된 결재선 규칙이 없습니다."
              description="규칙이 없으면 상신할 때 결재선을 정할 수 없습니다."
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-max text-sm">
                <thead className="bg-slate-50">
                  <tr>
                    <th scope="col" className="px-3 py-2 text-left font-semibold">
                      코드
                    </th>
                    <th scope="col" className="px-3 py-2 text-left font-semibold">
                      이름
                    </th>
                    <th scope="col" className="px-3 py-2 text-left font-semibold">
                      적용 양식
                    </th>
                    <th scope="col" className="px-3 py-2 text-right font-semibold">
                      최소금액
                    </th>
                    <th scope="col" className="px-3 py-2 text-right font-semibold">
                      최대금액
                    </th>
                    <th scope="col" className="px-3 py-2 text-left font-semibold">
                      결재선
                    </th>
                    <th scope="col" className="px-3 py-2 text-right font-semibold">
                      우선순위
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rules.data
                    .slice()
                    .sort((a, b) => b.priority - a.priority)
                    .map((r) => (
                      <tr key={r.id} className="border-b border-slate-100 last:border-0">
                        <td className="px-3 py-1.5 font-mono text-xs">{r.code}</td>
                        <td className="px-3 py-1.5">{r.name}</td>
                        <td className="px-3 py-1.5">
                          {r.formId ? (formLabelById.get(r.formId) ?? r.formId) : '전체 양식'}
                        </td>
                        <td className="px-3 py-1.5 tabular text-right">
                          {r.minAmount ? fmt.krw(r.minAmount as unknown as string) : '-'}
                        </td>
                        <td className="px-3 py-1.5 tabular text-right">
                          {r.maxAmount ? fmt.krw(r.maxAmount as unknown as string) : '-'}
                        </td>
                        <td className="px-3 py-1.5">
                          {templateLabelById.get(r.lineTemplateId) ?? r.lineTemplateId}
                        </td>
                        <td className="px-3 py-1.5 tabular text-right">{r.priority}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="mt-2 text-xs text-slate-500">
            상신 시 적용 양식·부서·금액 조건이 모두 맞는 규칙 중 우선순위가 가장 높은 것으로 결재선이
            정해집니다.
          </p>
        </Card>
      ) : null}

      <Card title="대결 설정">
        <form
          className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-5"
          onSubmit={async (e) => {
            e.preventDefault();
            setError(null);
            try {
              await setDelegation.mutateAsync({
                toUserId: form.toUserId,
                validFrom: form.validFrom,
                validTo: form.validTo,
                ...(form.reason ? { reason: form.reason } : {}),
                requestId: newRequestId(),
              });
              setForm({ toUserId: '', validFrom: '', validTo: '', reason: '' });
              await delegations.refetch();
            } catch (err) {
              setError((err as { message?: string }).message ?? '설정에 실패했습니다.');
            }
          }}
        >
          <Field label="대결자" htmlFor="dg-to" required>
            <Select
              id="dg-to"
              value={form.toUserId}
              onChange={(e) => setForm({ ...form, toUserId: e.target.value })}
            >
              <option value="">선택</option>
              {(users.data?.rows ?? []).map((u) => (
                <option key={u.id} value={u.id}>
                  {u.displayName} ({u.username})
                </option>
              ))}
            </Select>
          </Field>
          <Field label="시작일" htmlFor="dg-from" required>
            <Input
              id="dg-from"
              type="date"
              value={form.validFrom}
              onChange={(e) => setForm({ ...form, validFrom: e.target.value })}
            />
          </Field>
          <Field label="종료일" htmlFor="dg-to-date" required>
            <Input
              id="dg-to-date"
              type="date"
              value={form.validTo}
              onChange={(e) => setForm({ ...form, validTo: e.target.value })}
            />
          </Field>
          <Field label="사유" htmlFor="dg-reason">
            <Input
              id="dg-reason"
              value={form.reason}
              onChange={(e) => setForm({ ...form, reason: e.target.value })}
            />
          </Field>
          <div className="flex items-end">
            <Button
              type="submit"
              size="sm"
              variant="primary"
              disabled={!form.toUserId || !form.validFrom || !form.validTo}
            >
              대결 설정
            </Button>
          </div>
        </form>

        {error ? (
          <p role="alert" className="mb-3 rounded bg-red-50 px-3 py-2 text-sm text-red-700">
            {error}
          </p>
        ) : null}

        {(delegations.data ?? []).length === 0 ? (
          <EmptyState
            title="설정된 대결이 없습니다."
            description="부재 기간에 대신 결재할 사람을 지정할 수 있습니다."
          />
        ) : (
          <ul className="divide-y divide-slate-100 text-sm">
            {(delegations.data ?? []).map((d) => (
              <li key={d.id} className="flex items-center justify-between gap-2 py-2">
                <span>
                  {fmt.date(d.validFrom as unknown as string)} ~ {fmt.date(d.validTo as unknown as string)} ·{' '}
                  {d.reason ?? '사유 없음'}
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={async () => {
                    await endDelegation.mutateAsync({ delegationId: d.id, requestId: newRequestId() });
                    await delegations.refetch();
                  }}
                >
                  해제
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
