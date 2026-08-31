'use client';

import { useState } from 'react';
import { api } from '@/lib/trpc';
import { Button, Card, EmptyState, Field, Select, Spinner } from '@/components/ui/primitives';

/**
 * UIX-01/UIX-02/RPT-07: per-user saved search filters, grid column layouts, dashboard
 * layout and report filters can be created from their own screens, but nothing lets a
 * user see what has accumulated or remove one — this is that screen.
 *
 * There is currently no link to this page in the app shell; see the handoff notes.
 */
const KIND_VALUES = ['SEARCH_FILTER', 'GRID_COLUMNS', 'DASHBOARD', 'REPORT_FILTER'] as const;
type Kind = (typeof KIND_VALUES)[number];
const KIND_LABEL: Record<Kind, string> = {
  SEARCH_FILTER: '저장된 검색조건',
  GRID_COLUMNS: '그리드 열 설정',
  DASHBOARD: '대시보드 배치',
  REPORT_FILTER: '보고서 필터',
};

export default function PreferencesPage() {
  const [kind, setKind] = useState<Kind>('SEARCH_FILTER');
  const [confirmKey, setConfirmKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const utils = api.useUtils();
  const list = api.preference.list.useQuery({ kind });
  const remove = api.preference.remove.useMutation({
    onSuccess: () => utils.preference.list.invalidate({ kind }),
  });

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <header>
        <h1 className="text-lg font-semibold">내 저장 설정</h1>
        <p className="mt-0.5 text-sm text-slate-500">
          화면마다 저장한 검색조건·그리드 열 배치 등을 확인하고, 더 이상 필요 없는 항목을 지울 수 있습니다.
        </p>
      </header>

      {error ? (
        <p role="alert" className="rounded bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      ) : null}

      <Card title="종류">
        <Field label="종류" htmlFor="pref-kind" className="max-w-xs">
          <Select
            id="pref-kind"
            value={kind}
            onChange={(e) => {
              setKind(e.target.value as Kind);
              setConfirmKey(null);
              setError(null);
            }}
          >
            {KIND_VALUES.map((k) => (
              <option key={k} value={k}>
                {KIND_LABEL[k]}
              </option>
            ))}
          </Select>
        </Field>
      </Card>

      <Card title={KIND_LABEL[kind]}>
        {list.isLoading ? (
          <Spinner />
        ) : list.error ? (
          <p role="alert" className="rounded bg-red-50 px-3 py-2 text-sm text-red-700">
            {list.error.message}
          </p>
        ) : (list.data ?? []).length === 0 ? (
          <EmptyState
            title="저장된 항목이 없습니다."
            description="목록 화면에서 검색조건을 저장하거나 그리드 열을 조정하면 여기에 나타납니다."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[40rem] text-sm">
              <thead className="bg-slate-50">
                <tr>
                  <th scope="col" className="px-3 py-2 text-left font-semibold">
                    화면/키
                  </th>
                  <th scope="col" className="px-3 py-2 text-left font-semibold">
                    저장된 값
                  </th>
                  <th scope="col" className="px-3 py-2 text-left font-semibold">
                    최근 수정
                  </th>
                  <th scope="col" className="px-3 py-2 text-left font-semibold">
                    작업
                  </th>
                </tr>
              </thead>
              <tbody>
                {(list.data ?? []).map((row) => (
                  <tr key={row.id} className="border-b border-slate-100 last:border-0">
                    <td className="px-3 py-1.5 font-mono">{row.key}</td>
                    <td
                      className="max-w-xs truncate px-3 py-1.5 text-slate-500"
                      title={JSON.stringify(row.value)}
                    >
                      {JSON.stringify(row.value)}
                    </td>
                    <td className="px-3 py-1.5 tabular text-slate-500">
                      {new Date(row.updatedAt as unknown as string)
                        .toISOString()
                        .slice(0, 16)
                        .replace('T', ' ')}
                    </td>
                    <td className="px-3 py-1.5">
                      {confirmKey === row.key ? (
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="text-xs text-red-700">
                            &apos;{row.key}&apos; 항목을 삭제할까요?
                          </span>
                          <Button
                            size="sm"
                            variant="danger"
                            disabled={remove.isPending}
                            onClick={async () => {
                              setError(null);
                              try {
                                await remove.mutateAsync({ kind, key: row.key });
                                setConfirmKey(null);
                              } catch (err) {
                                setError((err as { message?: string }).message ?? '삭제에 실패했습니다.');
                              }
                            }}
                          >
                            확인
                          </Button>
                          <Button size="sm" onClick={() => setConfirmKey(null)}>
                            취소
                          </Button>
                        </div>
                      ) : (
                        <Button size="sm" variant="ghost" onClick={() => setConfirmKey(row.key)}>
                          삭제
                        </Button>
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
