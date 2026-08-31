'use client';

import { useState } from 'react';
import { api, newRequestId } from '@/lib/trpc';
import { Button, Card, EmptyState, Field, Input, Select, Spinner } from '@/components/ui/primitives';
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
  const targetTypes = api.approval.targetTypes.useQuery(undefined, { retry: false });
  const publish = api.approval.publishFormVersion.useMutation();

  const [publishFormCode, setPublishFormCode] = useState('');
  const [effectiveFrom, setEffectiveFrom] = useState('');
  const [schemaText, setSchemaText] = useState('[]');
  const [publishError, setPublishError] = useState<string | null>(null);
  const [publishMessage, setPublishMessage] = useState<string | null>(null);

  if (forms.isLoading) return <Spinner />;

  function selectFormForPublish(code: string) {
    setPublishFormCode(code);
    setPublishError(null);
    setPublishMessage(null);
    const current = (forms.data ?? []).find((f) => f.code === code);
    setSchemaText(JSON.stringify(current?.fieldSchema ?? [], null, 2));
  }

  async function onPublish(e: React.FormEvent) {
    e.preventDefault();
    setPublishError(null);
    setPublishMessage(null);

    let fieldSchema: unknown;
    try {
      fieldSchema = JSON.parse(schemaText);
    } catch {
      setPublishError('항목 스키마가 올바른 JSON 형식이 아닙니다.');
      return;
    }
    if (!Array.isArray(fieldSchema)) {
      setPublishError(
        '항목 스키마는 배열([...]) 형식이어야 합니다. 예: [{"key":"amount","label":"금액","type":"money"}]',
      );
      return;
    }

    try {
      const version = await publish.mutateAsync({
        formCode: publishFormCode,
        fieldSchema: fieldSchema as never,
        effectiveFrom,
        requestId: newRequestId(),
      });
      setPublishMessage(
        `v${version.version}을(를) ${effectiveFrom}부터 적용하도록 발행했습니다. 이미 상신되었거나 임시저장된 문서는 상신 당시(또는 지금까지)의 이전 버전 그대로 유지되며 바뀌지 않습니다.`,
      );
      await Promise.all([forms.refetch(), versions.refetch()]);
    } catch (err) {
      setPublishError((err as { message?: string }).message ?? '발행에 실패했습니다.');
    }
  }

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <header>
        <h1 className="text-lg font-semibold">결재양식</h1>
        <p className="mt-0.5 text-sm text-slate-500">
          양식은 버전으로 관리됩니다. 새 버전을 발행해도 이전 문서는 상신 당시의 양식 그대로 재현됩니다.
        </p>
      </header>

      {versions.data ? (
        <Card title="새 버전 발행">
          <form className="grid grid-cols-1 gap-3 sm:grid-cols-3" onSubmit={onPublish}>
            <Field label="양식" htmlFor="pf-form" required>
              <Select
                id="pf-form"
                value={publishFormCode}
                onChange={(e) => selectFormForPublish(e.target.value)}
              >
                <option value="">양식을 선택하세요</option>
                {(forms.data ?? []).map((f) => (
                  <option key={f.code} value={f.code}>
                    {f.name} ({f.code})
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="시행일" htmlFor="pf-effective" required hint="이 날짜부터 새 버전이 적용됩니다.">
              <Input
                id="pf-effective"
                type="date"
                value={effectiveFrom}
                onChange={(e) => setEffectiveFrom(e.target.value)}
              />
            </Field>
            <div className="flex items-end">
              <Button
                type="submit"
                size="sm"
                variant="primary"
                disabled={!publishFormCode || !effectiveFrom || publish.isPending}
              >
                {publish.isPending ? '발행 중' : '발행'}
              </Button>
            </div>
            <Field
              label="항목 스키마 (JSON)"
              htmlFor="pf-schema"
              required
              className="sm:col-span-3"
              hint='필드 배열을 JSON으로 입력하세요. 예: [{"key":"amount","label":"금액","type":"money","required":true}]'
            >
              <textarea
                id="pf-schema"
                rows={8}
                className="w-full rounded-md border border-slate-300 px-2.5 py-1.5 font-mono text-xs"
                value={schemaText}
                onChange={(e) => setSchemaText(e.target.value)}
              />
            </Field>
          </form>
          <p className="mt-2 text-xs text-slate-500">
            발행은 새 버전을 추가할 뿐 기존 버전을 바꾸지 않습니다. 이미 상신되었거나 임시저장 중인 문서는
            상신(작성) 당시 양식 버전의 스냅샷 그대로 남고, 새 버전은 이 시행일 이후 새로 작성하는 문서부터
            적용됩니다.
          </p>
          {publishMessage ? (
            <p role="status" className="mt-2 rounded bg-green-50 px-3 py-2 text-sm text-green-800">
              {publishMessage}
            </p>
          ) : null}
          {publishError ? (
            <p role="alert" className="mt-2 rounded bg-red-50 px-3 py-2 text-sm text-red-700">
              {publishError}
            </p>
          ) : null}
        </Card>
      ) : null}

      {targetTypes.data ? (
        <Card title="연동 가능한 업무문서 유형">
          {targetTypes.data.length === 0 ? (
            <EmptyState title="등록된 연동 대상 유형이 없습니다." />
          ) : (
            <ul className="flex flex-wrap gap-2 text-sm">
              {targetTypes.data.map((t) => (
                <li
                  key={t}
                  className="rounded-full border border-slate-300 bg-slate-50 px-2.5 py-1 font-mono text-xs"
                >
                  {t}
                </li>
              ))}
            </ul>
          )}
          <p className="mt-2 text-xs text-slate-500">
            결재양식을 업무문서와 연동하려면(승인 시 자동 처리) 위 유형 중 하나를 양식의 연동 대상으로
            지정해야 합니다.
          </p>
        </Card>
      ) : null}

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
