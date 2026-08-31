'use client';

import { use, useState } from 'react';
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
import { AttachmentPanel } from '@/components/ui/attachment-panel';
import { fmt } from '@/lib/format';

/** APV-07/APV-14/APV-15: document view, approve/reject/hold/release/resubmit, and print. */
const STEP_ROLE_LABEL: Record<string, string> = { APPROVE: '결재', AGREE: '합의', REFERENCE: '참조' };
const STEP_STATUS_LABEL: Record<string, string> = {
  PENDING: '대기',
  APPROVED: '승인',
  REJECTED: '반려',
  ON_HOLD: '보류',
  SKIPPED: '해당없음',
};
const ACTION_LABEL: Record<string, string> = {
  SUBMIT: '상신',
  APPROVE: '승인',
  REJECT: '반려',
  HOLD: '보류',
  WITHDRAW: '회수',
  RESUBMIT: '재상신',
  CANCEL: '취소',
  READ: '열람',
};

interface SchemaField {
  key: string;
  label: string;
  type: 'text' | 'textarea' | 'number' | 'money' | 'date' | 'select' | 'checkbox';
  required?: boolean;
  options?: { value: string; label: string }[];
  max?: number;
}

export default function ApprovalDocumentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const detail = api.approval.detail.useQuery({ documentId: id });
  const me = api.auth.me.useQuery();
  const approve = api.approval.approve.useMutation();
  const reject = api.approval.reject.useMutation();
  const hold = api.approval.hold.useMutation();
  const releaseHold = api.approval.releaseHold.useMutation();
  const withdraw = api.approval.withdraw.useMutation();
  const submit = api.approval.submit.useMutation();
  const resubmit = api.approval.resubmit.useMutation();
  const requestCancel = api.approval.requestCancel.useMutation();

  const [comment, setComment] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [resubmitOpen, setResubmitOpen] = useState(false);
  const [resubmitTitle, setResubmitTitle] = useState('');
  const [resubmitContent, setResubmitContent] = useState<Record<string, string>>({});

  if (detail.isLoading) return <Spinner />;
  if (detail.error)
    return <EmptyState title="결재문서를 열 수 없습니다." description={detail.error.message} />;
  const doc = detail.data!;
  const snapshot = doc.formSnapshot as unknown as {
    formName: string;
    version: number;
    fieldSchema: SchemaField[];
  };
  const content = doc.content as Record<string, string>;
  const amountFieldKey = snapshot.fieldSchema.find((f) => f.type === 'money' && f.key === 'amount')?.key;
  // APV-07: the step this actor put on hold — releasing it is offered to them specifically,
  // since a held step's status is ON_HOLD (not PENDING) and so falls outside doc.canAct.
  const heldStepForMe = doc.steps.some(
    (s) =>
      s.status === 'ON_HOLD' &&
      me.data &&
      (s.approverId === me.data.userId || s.actedByUserId === me.data.userId),
  );

  async function act(fn: () => Promise<unknown>, ok: string) {
    setError(null);
    setMessage(null);
    try {
      await fn();
      setMessage(ok);
      setComment('');
      await detail.refetch();
    } catch (err) {
      setError((err as { message?: string }).message ?? '처리에 실패했습니다.');
    }
  }

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h1 className="text-lg font-semibold">{doc.title}</h1>
          <p className="mt-0.5 text-sm text-slate-500">
            {doc.docNo} · {snapshot.formName} v{snapshot.version} · 상신{' '}
            {doc.submittedAt ? fmt.dateTime(doc.submittedAt as unknown as string) : '미상신'}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <StatusBadge status={doc.status} />
          <Button size="sm" className="no-print" onClick={() => window.print()}>
            인쇄 · PDF
          </Button>
        </div>
      </header>

      {message ? (
        <p role="status" className="rounded bg-green-50 px-3 py-2 text-sm text-green-800">
          {message}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="rounded bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      ) : null}

      <Card title="본문">
        <dl className="grid grid-cols-[8rem_1fr] gap-y-2 text-sm">
          {snapshot.fieldSchema.map((f) => (
            <div key={f.key} className="contents">
              <dt className="text-slate-500">{f.label}</dt>
              <dd className={f.type === 'money' ? 'tabular' : undefined}>
                {f.type === 'money' ? fmt.krw(content[f.key] ?? '') : (content[f.key] ?? '-')}
              </dd>
            </div>
          ))}
        </dl>
      </Card>

      <Card title="결재선">
        {doc.steps.length === 0 ? (
          <EmptyState
            title="아직 결재선이 없습니다."
            description="상신하면 부서·금액 규칙에 따라 결재선이 결정됩니다."
          />
        ) : (
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
                    결재자
                  </th>
                  <th scope="col" className="px-3 py-2 text-left font-semibold">
                    상태
                  </th>
                  <th scope="col" className="px-3 py-2 text-left font-semibold">
                    처리일시
                  </th>
                  <th scope="col" className="px-3 py-2 text-left font-semibold">
                    의견
                  </th>
                </tr>
              </thead>
              <tbody>
                {doc.steps.map((s) => (
                  <tr key={s.id} className="border-b border-slate-100 last:border-0">
                    <td className="px-3 py-1.5 tabular">{s.stepNo}</td>
                    <td className="px-3 py-1.5">
                      {STEP_ROLE_LABEL[s.role] ?? s.role}
                      {s.canFinalize ? <span className="ml-1 text-xs text-blue-700">전결가능</span> : null}
                    </td>
                    <td className="px-3 py-1.5">
                      {s.approverId}
                      {s.actedByUserId && s.actedByUserId !== s.approverId ? (
                        <span className="ml-1 text-xs text-amber-700">대결: {s.actedByUserId}</span>
                      ) : null}
                    </td>
                    <td className="px-3 py-1.5">{STEP_STATUS_LABEL[s.status] ?? s.status}</td>
                    <td className="px-3 py-1.5">
                      {s.actedAt ? fmt.dateTime(s.actedAt as unknown as string) : '-'}
                    </td>
                    <td className="px-3 py-1.5">{s.comment ?? '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {doc.status === 'ON_HOLD' && heldStepForMe ? (
        <Card title="보류 해제" className="no-print">
          <p className="mb-3 text-sm text-slate-600">
            이 문서를 보류시켰습니다. 해제하면 다시 결재 대기 상태로 돌아가 정상적으로 승인·반려할 수
            있습니다.
          </p>
          <Button
            variant="primary"
            size="sm"
            onClick={() =>
              act(
                () =>
                  releaseHold.mutateAsync({
                    documentId: id,
                    version: doc.version,
                    requestId: newRequestId(),
                  }),
                '보류를 해제했습니다.',
              )
            }
          >
            보류 해제
          </Button>
        </Card>
      ) : null}

      {doc.canAct ? (
        <Card title="결재 처리" className="no-print">
          <div className="flex flex-col gap-3">
            <Field label="의견" htmlFor="ap-comment" hint="반려·보류 시에는 의견이 필요합니다.">
              <Input id="ap-comment" value={comment} onChange={(e) => setComment(e.target.value)} />
            </Field>
            <div className="flex flex-wrap gap-1.5">
              <Button
                variant="primary"
                size="sm"
                onClick={() =>
                  act(
                    () =>
                      approve.mutateAsync({
                        documentId: id,
                        version: doc.version,
                        ...(comment ? { comment } : {}),
                        requestId: newRequestId(),
                      }),
                    '승인했습니다.',
                  )
                }
              >
                승인
              </Button>
              <Button
                variant="danger"
                size="sm"
                disabled={comment.trim().length < 2}
                onClick={() =>
                  act(
                    () =>
                      reject.mutateAsync({
                        documentId: id,
                        version: doc.version,
                        comment,
                        requestId: newRequestId(),
                      }),
                    '반려했습니다.',
                  )
                }
              >
                반려
              </Button>
              <Button
                size="sm"
                disabled={comment.trim().length < 2}
                onClick={() =>
                  act(
                    () =>
                      hold.mutateAsync({
                        documentId: id,
                        version: doc.version,
                        comment,
                        requestId: newRequestId(),
                      }),
                    '보류했습니다.',
                  )
                }
              >
                보류
              </Button>
            </div>
          </div>
        </Card>
      ) : null}

      {doc.isDrafter ? (
        <Card title="기안자 처리" className="no-print">
          <div className="flex flex-wrap gap-1.5">
            {doc.status === 'DRAFT' ? (
              <Button
                variant="primary"
                size="sm"
                onClick={() =>
                  act(
                    () =>
                      submit.mutateAsync({ documentId: id, version: doc.version, requestId: newRequestId() }),
                    '상신했습니다.',
                  )
                }
              >
                상신
              </Button>
            ) : null}
            {doc.status === 'IN_PROGRESS' || doc.status === 'ON_HOLD' ? (
              <Button
                size="sm"
                onClick={() =>
                  act(
                    () =>
                      withdraw.mutateAsync({
                        documentId: id,
                        version: doc.version,
                        requestId: newRequestId(),
                      }),
                    '회수했습니다.',
                  )
                }
              >
                회수
              </Button>
            ) : null}
            {(doc.status === 'REJECTED' || doc.status === 'WITHDRAWN') && !resubmitOpen ? (
              <Button
                variant="primary"
                size="sm"
                onClick={() => {
                  setResubmitTitle(doc.title);
                  setResubmitContent({ ...content });
                  setResubmitOpen(true);
                }}
              >
                재상신 작성
              </Button>
            ) : null}
            {doc.status === 'APPROVED' ? (
              <Button
                variant="danger"
                size="sm"
                disabled={comment.trim().length < 2}
                onClick={() =>
                  act(
                    () =>
                      requestCancel.mutateAsync({
                        documentId: id,
                        reason: comment,
                        requestId: newRequestId(),
                      }),
                    '취소 문서를 생성했습니다. 결재를 상신하세요.',
                  )
                }
              >
                취소 상신
              </Button>
            ) : null}
          </div>
          {doc.status === 'APPROVED' ? (
            <p className="mt-2 text-xs text-slate-500">
              완료된 문서는 수정할 수 없습니다. 취소는 별도 취소 문서의 결재로만 처리됩니다. 취소 사유를 위
              의견란에 입력하세요.
            </p>
          ) : null}

          {resubmitOpen ? (
            <div className="mt-3 flex flex-col gap-3 border-t border-slate-200 pt-3">
              <p className="text-xs text-slate-500">
                내용을 고쳐 다시 초안으로 저장합니다. 저장 후 목록의 상신 버튼으로 결재선을 새로 받으세요.
              </p>
              <Field label="제목" htmlFor="rs-title" required>
                <Input
                  id="rs-title"
                  value={resubmitTitle}
                  onChange={(e) => setResubmitTitle(e.target.value)}
                />
              </Field>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                {snapshot.fieldSchema.map((f) => (
                  <Field
                    key={f.key}
                    label={f.label}
                    htmlFor={`rs-${f.key}`}
                    required={f.required}
                    className={f.type === 'textarea' ? 'sm:col-span-2' : undefined}
                  >
                    {f.type === 'textarea' ? (
                      <textarea
                        id={`rs-${f.key}`}
                        rows={4}
                        maxLength={f.max}
                        className="w-full rounded-md border border-slate-300 px-2.5 py-1.5 text-sm"
                        value={resubmitContent[f.key] ?? ''}
                        onChange={(e) => setResubmitContent({ ...resubmitContent, [f.key]: e.target.value })}
                      />
                    ) : f.type === 'select' ? (
                      <Select
                        id={`rs-${f.key}`}
                        value={resubmitContent[f.key] ?? ''}
                        onChange={(e) => setResubmitContent({ ...resubmitContent, [f.key]: e.target.value })}
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
                        id={`rs-${f.key}`}
                        type={f.type === 'date' ? 'date' : 'text'}
                        inputMode={f.type === 'money' || f.type === 'number' ? 'numeric' : undefined}
                        maxLength={f.max}
                        className={
                          f.type === 'money' || f.type === 'number' ? 'tabular text-right' : undefined
                        }
                        value={resubmitContent[f.key] ?? ''}
                        onChange={(e) => setResubmitContent({ ...resubmitContent, [f.key]: e.target.value })}
                      />
                    )}
                  </Field>
                ))}
              </div>
              <div className="flex flex-wrap gap-1.5">
                <Button
                  variant="primary"
                  size="sm"
                  disabled={!resubmitTitle.trim() || resubmit.isPending}
                  onClick={() => {
                    const amountValue = amountFieldKey ? resubmitContent[amountFieldKey] : undefined;
                    return act(async () => {
                      await resubmit.mutateAsync({
                        documentId: id,
                        version: doc.version,
                        title: resubmitTitle.trim(),
                        content: resubmitContent,
                        ...(amountValue ? { amount: amountValue } : {}),
                        requestId: newRequestId(),
                      });
                      setResubmitOpen(false);
                    }, '재상신했습니다. 상신 버튼을 눌러 다시 결재를 올리세요.');
                  }}
                >
                  재상신
                </Button>
                <Button size="sm" onClick={() => setResubmitOpen(false)}>
                  취소
                </Button>
              </div>
            </div>
          ) : null}
        </Card>
      ) : null}

      <Card title="처리 이력">
        <ul className="divide-y divide-slate-100 text-sm">
          {doc.actions.map((a) => (
            <li key={a.id} className="flex flex-wrap items-center gap-2 py-1.5">
              <span className="text-slate-500">{fmt.dateTime(a.createdAt as unknown as string)}</span>
              <span className="font-medium">{ACTION_LABEL[a.action] ?? a.action}</span>
              {a.stepNo !== null ? <span className="text-slate-500">{a.stepNo}단계</span> : null}
              {a.comment ? <span>· {a.comment}</span> : null}
            </li>
          ))}
        </ul>
      </Card>

      <div className="no-print">
        <AttachmentPanel
          ownerType="APPROVAL_DOC"
          ownerId={id}
          readOnly={doc.status === 'APPROVED' || doc.status === 'CANCELED'}
        />
      </div>
    </div>
  );
}
