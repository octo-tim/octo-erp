'use client';

import { useState } from 'react';
import { api, newRequestId } from '@/lib/trpc';
import { Button, Card, EmptyState, Field, Input, Select, Spinner } from '@/components/ui/primitives';

/** ACC-01: the chart of accounts. Standard accounts may be deactivated but not renamed. */
const TYPE_LABEL: Record<string, string> = {
  ASSET: '자산',
  LIABILITY: '부채',
  EQUITY: '자본',
  REVENUE: '수익',
  EXPENSE: '비용',
};

export default function AccountsPage() {
  const utils = api.useUtils();
  const refresh = { onSuccess: () => utils.accounting.invalidate() };

  const [q, setQ] = useState('');
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ code: '', name: '', accountType: 'EXPENSE', parentId: '' });
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const accounts = api.accounting.accounts.useQuery({ activeOnly: false });
  const create = api.accounting.createAccount.useMutation(refresh);
  const update = api.accounting.updateAccount.useMutation(refresh);
  const remove = api.accounting.deleteAccount.useMutation(refresh);
  const [deleting, setDeleting] = useState<string | null>(null);

  const rows = (accounts.data ?? []).filter((a) => !q || a.code.includes(q) || a.name.includes(q));
  const parents = (accounts.data ?? []).filter((a) => a.level === 1);

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
          <h1 className="text-lg font-semibold">계정과목</h1>
          <p className="mt-0.5 text-sm text-slate-500">
            표준 계정과목은 명칭 변경·삭제가 불가하고 사용중지만 가능합니다. 하위 계정이 있는 계정에는 전기할
            수 없습니다.
          </p>
        </div>
        <Button variant="primary" size="sm" onClick={() => setCreating((v) => !v)}>
          {creating ? '닫기' : '계정 추가'}
        </Button>
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

      {creating ? (
        <Card title="계정과목 추가">
          <form
            className="grid grid-cols-1 gap-3 sm:grid-cols-5"
            onSubmit={async (e) => {
              e.preventDefault();
              await run(async () => {
                await create.mutateAsync({
                  code: form.code.trim(),
                  name: form.name.trim(),
                  accountType: form.accountType as 'EXPENSE',
                  ...(form.parentId ? { parentId: form.parentId } : {}),
                  requestId: newRequestId(),
                });
                setForm({ code: '', name: '', accountType: 'EXPENSE', parentId: '' });
                setCreating(false);
              }, '계정과목을 추가했습니다.');
            }}
          >
            <Field label="계정코드" htmlFor="ac-code" required hint="숫자 3~8자리">
              <Input
                id="ac-code"
                required
                value={form.code}
                onChange={(e) => setForm({ ...form, code: e.target.value })}
              />
            </Field>
            <Field label="계정명" htmlFor="ac-name" required>
              <Input
                id="ac-name"
                required
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
            </Field>
            <Field label="계정구분" htmlFor="ac-type" required>
              <Select
                id="ac-type"
                value={form.accountType}
                onChange={(e) => setForm({ ...form, accountType: e.target.value })}
              >
                {Object.entries(TYPE_LABEL).map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="상위 계정" htmlFor="ac-parent">
              <Select
                id="ac-parent"
                value={form.parentId}
                onChange={(e) => setForm({ ...form, parentId: e.target.value })}
              >
                <option value="">없음</option>
                {parents
                  .filter((p) => p.accountType === form.accountType)
                  .map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.code} {p.name}
                    </option>
                  ))}
              </Select>
            </Field>
            <div className="flex items-end">
              <Button type="submit" variant="primary" size="sm" disabled={create.isPending}>
                추가
              </Button>
            </div>
          </form>
        </Card>
      ) : null}

      <Card title="계정과목 목록">
        <div className="mb-3 max-w-xs">
          <Field label="검색어" htmlFor="ac-q" hint="계정코드·계정명">
            <Input id="ac-q" value={q} onChange={(e) => setQ(e.target.value)} />
          </Field>
        </div>

        {accounts.isLoading ? (
          <Spinner />
        ) : rows.length === 0 ? (
          <EmptyState title="계정과목이 없습니다." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[40rem] text-sm">
              <thead className="border-b border-slate-200 text-left text-slate-500">
                <tr>
                  <th className="px-2 py-1.5 font-medium">계정코드</th>
                  <th className="px-2 py-1.5 font-medium">계정명</th>
                  <th className="px-2 py-1.5 font-medium">구분</th>
                  <th className="px-2 py-1.5 font-medium">증가</th>
                  <th className="px-2 py-1.5 font-medium">전기</th>
                  <th className="px-2 py-1.5 font-medium">사용</th>
                  <th className="px-2 py-1.5 font-medium" />
                </tr>
              </thead>
              <tbody>
                {rows.map((a) => (
                  <tr key={a.id} className="border-b border-slate-100">
                    <td className="tabular px-2 py-1.5">{a.code}</td>
                    <td className="px-2 py-1.5" style={{ paddingLeft: `${0.5 + (a.level - 1) * 1}rem` }}>
                      {a.name}
                      {a.isStandard ? (
                        <span className="ml-2 rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-600">
                          표준
                        </span>
                      ) : null}
                    </td>
                    <td className="px-2 py-1.5">{TYPE_LABEL[a.accountType] ?? a.accountType}</td>
                    <td className="px-2 py-1.5">{a.normalSide === 'DEBIT' ? '차변' : '대변'}</td>
                    <td className="px-2 py-1.5">{a.isPostable ? '가능' : '불가'}</td>
                    <td className="px-2 py-1.5">{a.isActive ? '사용' : '중지'}</td>
                    <td className="px-2 py-1.5 text-right">
                      {deleting === a.id ? (
                        <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
                          <span className="text-xs text-red-700">
                            &apos;{a.code} {a.name}&apos; 삭제할까요?
                          </span>
                          <Button
                            size="sm"
                            variant="danger"
                            onClick={() =>
                              run(async () => {
                                await remove.mutateAsync({ id: a.id, requestId: newRequestId() });
                                setDeleting(null);
                              }, `'${a.name}' 계정과목을 삭제했습니다.`)
                            }
                          >
                            삭제 확정
                          </Button>
                          <Button size="sm" onClick={() => setDeleting(null)}>
                            취소
                          </Button>
                        </span>
                      ) : (
                        <span className="inline-flex gap-1.5">
                          <Button
                            size="sm"
                            onClick={() =>
                              run(
                                () =>
                                  update.mutateAsync({
                                    id: a.id,
                                    version: a.version,
                                    isActive: !a.isActive,
                                    requestId: newRequestId(),
                                  }),
                                a.isActive ? '사용중지 처리했습니다.' : '사용으로 되돌렸습니다.',
                              )
                            }
                          >
                            {a.isActive ? '사용중지' : '사용재개'}
                          </Button>
                          <Button
                            size="sm"
                            variant="danger"
                            disabled={!a.canDelete}
                            title={
                              a.canDelete
                                ? undefined
                                : a.isStandard
                                  ? '표준 계정과목은 삭제할 수 없습니다.'
                                  : '사용 중인 계정과목은 삭제할 수 없습니다(분개·하위계정·자동분개 매핑). 사용중지로 처리하세요.'
                            }
                            onClick={() => setDeleting(a.id)}
                          >
                            삭제
                          </Button>
                        </span>
                      )}
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
