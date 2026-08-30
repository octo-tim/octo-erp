'use client';

import { api } from '@/lib/trpc';
import { Card, EmptyState, Spinner } from '@/components/ui/primitives';
import { fmt } from '@/lib/format';

/** APV-01/APV-02: form catalogue and published versions. */
const TYPE_LABEL: Record<string, string> = {
  text: '텍스트',
  textarea: '여러 줄',
  number: '숫자',
  money: '금액',
  date: '날짜',
  select: '선택',
  checkbox: '체크',
};

export default function ApprovalFormsPage() {
  const forms = api.approval.forms.useQuery();
  const versions = api.approval.listFormVersions.useQuery({}, { retry: false });

  if (forms.isLoading) return <Spinner />;

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <header>
        <h1 className="text-lg font-semibold">결재양식</h1>
        <p className="mt-0.5 text-sm text-slate-500">
          양식은 버전으로 관리됩니다. 새 버전을 발행해도 이전 문서는 상신 당시의 양식 그대로 재현됩니다.
        </p>
      </header>

      {(forms.data ?? []).map((f) => (
        <Card key={f.code} title={`${f.name} (${f.code}) · v${f.currentVersion ?? '-'}`}>
          {f.fieldSchema.length === 0 ? (
            <EmptyState title="발행된 버전이 없습니다." />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-max text-sm">
                <thead className="bg-slate-50">
                  <tr>
                    <th scope="col" className="px-3 py-2 text-left font-semibold">
                      항목키
                    </th>
                    <th scope="col" className="px-3 py-2 text-left font-semibold">
                      라벨
                    </th>
                    <th scope="col" className="px-3 py-2 text-left font-semibold">
                      유형
                    </th>
                    <th scope="col" className="px-3 py-2 text-left font-semibold">
                      필수
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {f.fieldSchema.map((field) => (
                    <tr key={field.key} className="border-b border-slate-100 last:border-0">
                      <td className="px-3 py-1.5 font-mono text-xs">{field.key}</td>
                      <td className="px-3 py-1.5">{field.label}</td>
                      <td className="px-3 py-1.5">{TYPE_LABEL[field.type] ?? field.type}</td>
                      <td className="px-3 py-1.5">{field.required ? '필수' : '-'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {f.targetType ? (
            <p className="mt-2 text-xs text-slate-500">
              연동 대상: {f.targetType} — 승인 시 해당 업무가 같은 트랜잭션에서 처리됩니다.
            </p>
          ) : null}
        </Card>
      ))}

      {versions.data ? (
        <Card title="버전 이력">
          <ul className="divide-y divide-slate-100 text-sm">
            {versions.data.map((v) => (
              <li key={v.id} className="flex flex-wrap gap-3 py-1.5">
                <span className="font-medium">{v.form.name}</span>
                <span>v{v.version}</span>
                <span className="text-slate-500">적용 {fmt.date(v.effectiveFrom as unknown as string)}</span>
                <span className="text-slate-500">발행 {fmt.dateTime(v.createdAt as unknown as string)}</span>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
    </div>
  );
}
