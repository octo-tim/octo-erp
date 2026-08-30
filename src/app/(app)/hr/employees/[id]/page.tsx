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

/** HRM-01/03/08/09/12: employee detail with assignments, sensitive data and documents. */
const STATUS_LABEL: Record<string, string> = { ACTIVE: '재직', ON_LEAVE: '휴직', RESIGNED: '퇴사' };
const ASSIGNMENT_LABEL: Record<string, string> = {
  HIRE: '입사',
  PROMOTION: '승진',
  TRANSFER: '이동',
  LEAVE_OF_ABSENCE: '휴직',
  RETURN: '복직',
  RESIGN: '퇴사',
};

export default function EmployeeDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const me = api.auth.me.useQuery();
  const detail = api.hrm.detail.useQuery({ id });
  const assignments = api.hrm.assignmentHistory.useQuery({ employeeId: id });
  const balance = api.hrm.leaveBalance.useQuery({ employeeId: id, leaveType: 'ANNUAL' });

  if (detail.isLoading) return <Spinner />;
  if (detail.error) return <EmptyState title="사원을 찾을 수 없습니다." description={detail.error.message} />;
  const e = detail.data!;
  const canWrite = !!me.data?.isAdmin || !!me.data?.permissions.includes('hr.write');
  const canSensitive = !!me.data?.isAdmin || !!me.data?.permissions.includes('hr.sensitive.read');

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-lg font-semibold">
            {e.name} <span className="ml-1 text-sm font-normal text-slate-500">{e.employeeNo}</span>
          </h1>
          <p className="mt-0.5 text-sm text-slate-500">
            {e.department?.name ?? '부서 미지정'} · {e.jobTitle ?? '직위 미지정'}
          </p>
        </div>
        <StatusBadge status={e.status} label={STATUS_LABEL[e.status]} />
      </header>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="기본정보">
          <dl className="grid grid-cols-[7rem_1fr] gap-y-2 text-sm">
            <dt className="text-slate-500">입사일</dt>
            <dd>{fmt.date(e.hireDate as unknown as string)}</dd>
            <dt className="text-slate-500">퇴사일</dt>
            <dd>{e.leaveDate ? fmt.date(e.leaveDate as unknown as string) : '-'}</dd>
            <dt className="text-slate-500">연락처</dt>
            <dd>{e.phone ?? '-'}</dd>
            <dt className="text-slate-500">이메일</dt>
            <dd>{e.email ?? '-'}</dd>
            <dt className="text-slate-500">주소</dt>
            <dd>{e.address ?? '-'}</dd>
            <dt className="text-slate-500">계정</dt>
            <dd>{e.user ? `${e.user.username}${e.user.isActive ? '' : ' (비활성)'}` : '연결된 계정 없음'}</dd>
          </dl>
        </Card>

        <Card title="연차 현황">
          {balance.isLoading ? (
            <Spinner />
          ) : balance.data ? (
            <dl className="grid grid-cols-[7rem_1fr] gap-y-2 text-sm">
              <dt className="text-slate-500">부여</dt>
              <dd className="tabular">{balance.data.granted}일</dd>
              <dt className="text-slate-500">사용</dt>
              <dd className="tabular">{balance.data.used}일</dd>
              <dt className="text-slate-500">잔여</dt>
              <dd className="tabular font-semibold">{balance.data.remaining}일</dd>
              <dt className="text-slate-500">소멸</dt>
              <dd className="tabular">{balance.data.expired}일</dd>
            </dl>
          ) : (
            <EmptyState title="연차 정보가 없습니다." />
          )}
        </Card>
      </div>

      {canSensitive ? (
        <SensitivePanel employeeId={id} masked={e.sensitive} onSaved={() => void detail.refetch()} />
      ) : null}

      <Card title="발령 이력">
        {assignments.isLoading ? (
          <Spinner />
        ) : (assignments.data ?? []).length === 0 ? (
          <EmptyState title="발령 이력이 없습니다." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-max text-sm">
              <thead className="bg-slate-50">
                <tr>
                  <th scope="col" className="px-3 py-2 text-left font-semibold">
                    유형
                  </th>
                  <th scope="col" className="px-3 py-2 text-left font-semibold">
                    시행일
                  </th>
                  <th scope="col" className="px-3 py-2 text-left font-semibold">
                    종료일
                  </th>
                  <th scope="col" className="px-3 py-2 text-left font-semibold">
                    부서
                  </th>
                  <th scope="col" className="px-3 py-2 text-left font-semibold">
                    직위
                  </th>
                  <th scope="col" className="px-3 py-2 text-left font-semibold">
                    비고
                  </th>
                </tr>
              </thead>
              <tbody>
                {(assignments.data ?? []).map((a) => (
                  <tr key={a.id} className="border-b border-slate-100 last:border-0">
                    <td className="px-3 py-1.5">{ASSIGNMENT_LABEL[a.type] ?? a.type}</td>
                    <td className="px-3 py-1.5">{fmt.date(a.effectiveFrom as unknown as string)}</td>
                    <td className="px-3 py-1.5">
                      {a.effectiveTo ? fmt.date(a.effectiveTo as unknown as string) : '-'}
                    </td>
                    <td className="px-3 py-1.5">{a.department?.name ?? '-'}</td>
                    <td className="px-3 py-1.5">{a.jobTitle ?? '-'}</td>
                    <td className="px-3 py-1.5">{a.note ?? '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <AttachmentPanel ownerType="EMPLOYEE_DOC" ownerId={id} readOnly={!canWrite} />
    </div>
  );
}

/** HRM-12: reveal requires a reason and is logged; the panel never caches the plaintext. */
function SensitivePanel({
  employeeId,
  masked,
  onSaved,
}: {
  employeeId: string;
  masked: { residentNoMasked: string; bankName: string | null; bankAccountMasked: string } | null;
  onSaved: () => void;
}) {
  const reveal = api.hrm.revealSensitive.useMutation();
  const setSensitive = api.hrm.setSensitive.useMutation();
  const accessLog = api.hrm.sensitiveAccessLog.useQuery({ employeeId });

  const [reason, setReason] = useState('');
  const [field, setField] = useState<'residentNo' | 'bankAccount'>('residentNo');
  const [revealed, setRevealed] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({ residentNo: '', bankName: '', bankAccount: '' });

  async function doReveal() {
    setError(null);
    setRevealed(null);
    try {
      const res = await reveal.mutateAsync({ employeeId, field, reason });
      setRevealed(res.value);
      setReason('');
      await accessLog.refetch();
    } catch (err) {
      setError((err as { message?: string }).message ?? '조회에 실패했습니다.');
    }
  }

  return (
    <Card title="민감정보 (주민번호·계좌번호)">
      <p className="mb-3 text-xs text-slate-500">
        화면·로그·내보내기에서 항상 마스킹됩니다. 원문 조회는 사유를 남기며 접근이력에 기록됩니다.
      </p>

      <dl className="mb-4 grid grid-cols-[7rem_1fr] gap-y-2 text-sm">
        <dt className="text-slate-500">주민번호</dt>
        <dd className="tabular">{masked?.residentNoMasked ?? '미등록'}</dd>
        <dt className="text-slate-500">계좌</dt>
        <dd className="tabular">
          {masked ? `${masked.bankName ?? ''} ${masked.bankAccountMasked}` : '미등록'}
        </dd>
      </dl>

      <div className="flex flex-wrap items-end gap-2">
        <Field label="조회 항목" htmlFor="rev-field" className="w-40">
          <Select id="rev-field" value={field} onChange={(ev) => setField(ev.target.value as typeof field)}>
            <option value="residentNo">주민번호</option>
            <option value="bankAccount">계좌번호</option>
          </Select>
        </Field>
        <Field label="조회 사유" htmlFor="rev-reason" required className="min-w-56 flex-1">
          <Input
            id="rev-reason"
            value={reason}
            onChange={(ev) => setReason(ev.target.value)}
            placeholder="예: 4대보험 신고자료 작성"
          />
        </Field>
        <Button size="sm" onClick={doReveal} disabled={reason.trim().length < 5 || reveal.isPending}>
          원문 조회
        </Button>
        <Button size="sm" onClick={() => setEditing((v) => !v)}>
          {editing ? '입력 닫기' : '등록·수정'}
        </Button>
      </div>

      {error ? (
        <p role="alert" className="mt-2 rounded bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      ) : null}
      {revealed ? (
        <p className="mt-2 rounded bg-amber-50 px-3 py-2 text-sm">
          원문: <strong className="tabular">{revealed}</strong>{' '}
          <button type="button" className="ml-2 underline" onClick={() => setRevealed(null)}>
            가리기
          </button>
        </p>
      ) : null}

      {editing ? (
        <form
          className="mt-3 grid grid-cols-1 gap-3 border-t border-slate-200 pt-3 sm:grid-cols-3"
          onSubmit={async (ev) => {
            ev.preventDefault();
            setError(null);
            try {
              await setSensitive.mutateAsync({
                employeeId,
                ...(form.residentNo ? { residentNo: form.residentNo } : {}),
                ...(form.bankName ? { bankName: form.bankName } : {}),
                ...(form.bankAccount ? { bankAccount: form.bankAccount } : {}),
                requestId: newRequestId(),
              });
              setForm({ residentNo: '', bankName: '', bankAccount: '' });
              setEditing(false);
              onSaved();
            } catch (err) {
              setError((err as { message?: string }).message ?? '저장에 실패했습니다.');
            }
          }}
        >
          <Field label="주민번호" htmlFor="sens-rrn" hint="13자리, 하이픈 선택">
            <Input
              id="sens-rrn"
              value={form.residentNo}
              onChange={(ev) => setForm({ ...form, residentNo: ev.target.value })}
            />
          </Field>
          <Field label="은행" htmlFor="sens-bank">
            <Input
              id="sens-bank"
              value={form.bankName}
              onChange={(ev) => setForm({ ...form, bankName: ev.target.value })}
            />
          </Field>
          <Field label="계좌번호" htmlFor="sens-acc">
            <Input
              id="sens-acc"
              value={form.bankAccount}
              onChange={(ev) => setForm({ ...form, bankAccount: ev.target.value })}
            />
          </Field>
          <div className="sm:col-span-3 flex justify-end">
            <Button type="submit" size="sm" variant="primary" disabled={setSensitive.isPending}>
              저장
            </Button>
          </div>
        </form>
      ) : null}

      <details className="mt-4">
        <summary className="cursor-pointer text-sm font-medium">
          접근이력 ({(accessLog.data ?? []).length}건)
        </summary>
        <ul className="mt-2 space-y-1 text-sm">
          {(accessLog.data ?? []).map((l) => (
            <li key={l.id} className="text-slate-600">
              {fmt.dateTime(l.createdAt as unknown as string)} · {l.field} · {l.reason}
            </li>
          ))}
          {(accessLog.data ?? []).length === 0 ? <li className="text-slate-400">기록 없음</li> : null}
        </ul>
      </details>
    </Card>
  );
}
