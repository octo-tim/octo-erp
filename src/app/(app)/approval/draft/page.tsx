'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, newRequestId } from '@/lib/trpc';
import { Button, Card, EmptyState, Field, Input, Select, Spinner } from '@/components/ui/primitives';
import { FormErrorSummary, type FieldError } from '@/components/ui/form-error-summary';

/** APV-06: draft a document against the selected form's dynamic field schema (APV-01). */
interface SchemaField {
  key: string;
  label: string;
  type: 'text' | 'textarea' | 'number' | 'money' | 'date' | 'select' | 'checkbox';
  required?: boolean;
  options?: { value: string; label: string }[];
  max?: number;
}

export default function DraftPage() {
  const router = useRouter();
  const forms = api.approval.forms.useQuery();
  const draft = api.approval.draft.useMutation();
  const submit = api.approval.submit.useMutation();

  const [formCode, setFormCode] = useState('');
  const [title, setTitle] = useState('');
  const [content, setContent] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<FieldError[]>([]);

  if (forms.isLoading) return <Spinner />;
  const selected = (forms.data ?? []).find((f) => f.code === formCode);
  const fields = (selected?.fieldSchema ?? []) as SchemaField[];
  const amountField = fields.find((f) => f.type === 'money' && f.key === 'amount');

  async function save(andSubmit: boolean) {
    const found: FieldError[] = [];
    if (!formCode) found.push({ field: 'ap-form', label: '양식', message: '결재양식을 선택하세요.' });
    if (!title.trim()) found.push({ field: 'ap-title', label: '제목', message: '제목을 입력하세요.' });
    for (const f of fields) {
      if (f.required && !content[f.key])
        found.push({ field: `ap-${f.key}`, label: f.label, message: `${f.label}을(를) 입력하세요.` });
    }
    setErrors(found);
    if (found.length) return;

    try {
      const doc = await draft.mutateAsync({
        formCode,
        title: title.trim(),
        content,
        ...(amountField && content[amountField.key] ? { amount: content[amountField.key]! } : {}),
        requestId: newRequestId(),
      });
      if (andSubmit) {
        await submit.mutateAsync({ documentId: doc.id, version: doc.version, requestId: newRequestId() });
      }
      router.push(`/approval/documents/${doc.id}`);
    } catch (err) {
      setErrors([
        {
          field: 'ap-title',
          label: '저장',
          message: (err as { message?: string }).message ?? '저장에 실패했습니다.',
        },
      ]);
    }
  }

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <h1 className="text-lg font-semibold">기안</h1>

      <Card title="문서 정보">
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void save(true);
          }}
        >
          <FormErrorSummary errors={errors} />

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="결재양식" htmlFor="ap-form" required>
              <Select
                id="ap-form"
                name="ap-form"
                value={formCode}
                onChange={(e) => {
                  setFormCode(e.target.value);
                  setContent({});
                }}
              >
                <option value="">양식을 선택하세요</option>
                {(forms.data ?? []).map((f) => (
                  <option key={f.code} value={f.code}>
                    {f.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="제목" htmlFor="ap-title" required>
              <Input id="ap-title" name="ap-title" value={title} onChange={(e) => setTitle(e.target.value)} />
            </Field>
          </div>

          {!selected ? (
            <EmptyState
              title="양식을 선택하면 입력 항목이 나타납니다."
              description="양식마다 필요한 항목이 다릅니다."
            />
          ) : (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {fields.map((f) => (
                <Field
                  key={f.key}
                  label={f.label}
                  htmlFor={`ap-${f.key}`}
                  required={f.required}
                  className={f.type === 'textarea' ? 'sm:col-span-2' : undefined}
                  error={errors.find((e) => e.field === `ap-${f.key}`)?.message}
                >
                  {f.type === 'textarea' ? (
                    <textarea
                      id={`ap-${f.key}`}
                      name={`ap-${f.key}`}
                      rows={4}
                      maxLength={f.max}
                      className="w-full rounded-md border border-slate-300 px-2.5 py-1.5 text-sm"
                      value={content[f.key] ?? ''}
                      onChange={(e) => setContent({ ...content, [f.key]: e.target.value })}
                    />
                  ) : f.type === 'select' ? (
                    <Select
                      id={`ap-${f.key}`}
                      value={content[f.key] ?? ''}
                      onChange={(e) => setContent({ ...content, [f.key]: e.target.value })}
                    >
                      <option value="">선택</option>
                      {(f.options ?? []).map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </Select>
                  ) : (
                    <Input
                      id={`ap-${f.key}`}
                      name={`ap-${f.key}`}
                      type={f.type === 'date' ? 'date' : 'text'}
                      inputMode={f.type === 'money' || f.type === 'number' ? 'numeric' : undefined}
                      maxLength={f.max}
                      className={f.type === 'money' || f.type === 'number' ? 'tabular text-right' : undefined}
                      value={content[f.key] ?? ''}
                      onChange={(e) => setContent({ ...content, [f.key]: e.target.value })}
                    />
                  )}
                </Field>
              ))}
            </div>
          )}

          <p className="text-xs text-slate-500">
            결재선은 부서·금액 규칙에 따라 상신 시 자동으로 결정됩니다. 임시저장 후 나중에 상신할 수도
            있습니다.
          </p>

          <div className="flex justify-end gap-1.5">
            <Button type="button" size="sm" onClick={() => void save(false)} disabled={draft.isPending}>
              임시저장
            </Button>
            <Button type="submit" size="sm" variant="primary" disabled={draft.isPending || submit.isPending}>
              {draft.isPending || submit.isPending ? '처리 중…' : '상신'}
            </Button>
          </div>
        </form>
      </Card>
    </div>
  );
}
