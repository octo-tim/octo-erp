'use client';

import { useState } from 'react';
import { api, newRequestId } from '@/lib/trpc';
import { Button, Card, EmptyState, Field, Input, Spinner, StatusBadge } from '@/components/ui/primitives';

/** BAS-07: business divisions — the unit that separates P&L and data scope (ACC-07, INT-12). */
export default function DivisionPage() {
  const list = api.master.divisions.useQuery({ activeOnly: false });
  const create = api.master.createDivision.useMutation();
  const update = api.master.updateDivision.useMutation();
  const [form, setForm] = useState({ code: '', name: '' });
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <header>
        <h1 className="text-lg font-semibold">사업부</h1>
        <p className="mt-0.5 text-sm text-slate-500">
          부문별 손익과 데이터 접근범위의 기준입니다. 전표 라인마다 사업부가 기록됩니다.
        </p>
      </header>

      <Card title="사업부 등록">
        <form
          className="grid grid-cols-1 gap-3 sm:grid-cols-4"
          onSubmit={async (e) => {
            e.preventDefault();
            setError(null);
            try {
              await create.mutateAsync({
                code: form.code.trim(),
                name: form.name.trim(),
                requestId: newRequestId(),
              });
              setForm({ code: '', name: '' });
              await list.refetch();
            } catch (err) {
              setError((err as { message?: string }).message ?? '등록에 실패했습니다.');
            }
          }}
        >
          <Field label="사업부코드" htmlFor="dv-code" required>
            <Input
              id="dv-code"
              value={form.code}
              onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase() })}
            />
          </Field>
          <Field label="사업부명" htmlFor="dv-name" required>
            <Input
              id="dv-name"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          </Field>
          <div className="flex items-end">
            <Button type="submit" size="sm" variant="primary" disabled={!form.code || !form.name}>
              등록
            </Button>
          </div>
        </form>
        {error ? (
          <p role="alert" className="mt-2 rounded bg-red-50 px-3 py-2 text-sm text-red-700">
            {error}
          </p>
        ) : null}
      </Card>

      <Card title={`사업부 목록 (${(list.data ?? []).length}개)`}>
        {list.isLoading ? (
          <Spinner />
        ) : (list.data ?? []).length === 0 ? (
          <EmptyState
            title="조회 가능한 사업부가 없습니다."
            description="관리자에게 사업부 권한을 요청하세요."
          />
        ) : (
          <ul className="divide-y divide-slate-100 text-sm">
            {(list.data ?? []).map((d) => (
              <li key={d.id} className="flex items-center justify-between gap-3 py-2">
                <span>
                  <span className="font-medium">{d.name}</span>{' '}
                  <span className="text-slate-500">{d.code}</span>
                </span>
                <span className="flex items-center gap-2">
                  <StatusBadge
                    status={d.isActive ? 'CONFIRMED' : 'CANCELED'}
                    label={d.isActive ? '사용' : '중지'}
                  />
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={async () => {
                      await update.mutateAsync({
                        id: d.id,
                        isActive: !d.isActive,
                        requestId: newRequestId(),
                      });
                      await list.refetch();
                    }}
                  >
                    {d.isActive ? '사용중지' : '사용재개'}
                  </Button>
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
