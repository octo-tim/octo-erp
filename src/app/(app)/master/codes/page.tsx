'use client';

import { useState } from 'react';
import { api, newRequestId } from '@/lib/trpc';
import { Button, Card, EmptyState, Field, Input, Spinner, StatusBadge } from '@/components/ui/primitives';

/** BAS-07: common codes the business screens draw their dropdowns from. */
export default function CommonCodePage() {
  const groups = api.master.codeGroups.useQuery();
  const [groupCode, setGroupCode] = useState('UNIT');
  const codes = api.master.codes.useQuery({ groupCode, activeOnly: false });
  const upsert = api.master.upsertCode.useMutation();
  const deactivate = api.master.deactivateCode.useMutation();

  const [form, setForm] = useState({ code: '', name: '', sortOrder: '' });
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <header>
        <h1 className="text-lg font-semibold">공통코드</h1>
        <p className="mt-0.5 text-sm text-slate-500">
          단위·결제수단·직위 등 화면 선택 목록을 관리자가 직접 유지합니다. 사용 중인 코드는 삭제할 수 없고
          사용중지만 가능합니다.
        </p>
      </header>

      <Card title="코드그룹">
        <div className="flex flex-wrap gap-1.5">
          {(groups.data ?? []).map((g) => (
            <Button
              key={g.group}
              size="sm"
              variant={groupCode === g.group ? 'primary' : 'default'}
              onClick={() => setGroupCode(g.group)}
            >
              {g.label}
            </Button>
          ))}
        </div>
      </Card>

      <Card title="코드 등록·수정">
        <form
          className="grid grid-cols-1 gap-3 sm:grid-cols-4"
          onSubmit={async (e) => {
            e.preventDefault();
            setError(null);
            try {
              await upsert.mutateAsync({
                groupCode,
                code: form.code.trim().toUpperCase(),
                name: form.name.trim(),
                ...(form.sortOrder ? { sortOrder: Number(form.sortOrder) } : {}),
                requestId: newRequestId(),
              });
              setForm({ code: '', name: '', sortOrder: '' });
              await codes.refetch();
            } catch (err) {
              setError((err as { message?: string }).message ?? '저장에 실패했습니다.');
            }
          }}
        >
          <Field label="코드" htmlFor="cc-code" required>
            <Input
              id="cc-code"
              value={form.code}
              onChange={(e) => setForm({ ...form, code: e.target.value })}
            />
          </Field>
          <Field label="명칭" htmlFor="cc-name" required>
            <Input
              id="cc-name"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          </Field>
          <Field label="정렬순서" htmlFor="cc-sort">
            <Input
              id="cc-sort"
              className="tabular text-right"
              value={form.sortOrder}
              onChange={(e) => setForm({ ...form, sortOrder: e.target.value })}
            />
          </Field>
          <div className="flex items-end">
            <Button type="submit" size="sm" variant="primary" disabled={!form.code || !form.name}>
              저장
            </Button>
          </div>
        </form>
        {error ? (
          <p role="alert" className="mt-2 rounded bg-red-50 px-3 py-2 text-sm text-red-700">
            {error}
          </p>
        ) : null}
      </Card>

      <Card title={`${(groups.data ?? []).find((g) => g.group === groupCode)?.label ?? groupCode} 코드`}>
        {codes.isLoading ? (
          <Spinner />
        ) : (codes.data ?? []).length === 0 ? (
          <EmptyState title="등록된 코드가 없습니다." description="위 폼에서 코드를 추가하세요." />
        ) : (
          <ul className="divide-y divide-slate-100 text-sm">
            {(codes.data ?? []).map((c) => (
              <li key={c.id} className="flex items-center justify-between gap-3 py-2">
                <span>
                  <span className="font-mono text-xs text-slate-500">{c.code}</span>{' '}
                  <span className="font-medium">{c.name}</span>
                </span>
                <span className="flex items-center gap-2">
                  <StatusBadge
                    status={c.isActive ? 'CONFIRMED' : 'CANCELED'}
                    label={c.isActive ? '사용' : '중지'}
                  />
                  {c.isActive ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={async () => {
                        setError(null);
                        try {
                          await deactivate.mutateAsync({
                            groupCode,
                            code: c.code,
                            requestId: newRequestId(),
                          });
                          await codes.refetch();
                        } catch (err) {
                          setError((err as { message?: string }).message ?? '사용중지에 실패했습니다.');
                        }
                      }}
                    >
                      사용중지
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={async () => {
                        await upsert.mutateAsync({
                          groupCode,
                          code: c.code,
                          name: c.name,
                          isActive: true,
                          requestId: newRequestId(),
                        });
                        await codes.refetch();
                      }}
                    >
                      사용재개
                    </Button>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
