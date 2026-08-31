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
import { FormErrorSummary, type FieldError } from '@/components/ui/form-error-summary';
import { fmt } from '@/lib/format';

/** HRM-01/03/08/09/12/13: employee detail with assignments, sensitive data, documents,
 *  in-place editing and change-request review. */
const STATUS_LABEL: Record<string, string> = { ACTIVE: '재직', ON_LEAVE: '휴직', RESIGNED: '퇴사' };
const ASSIGNMENT_LABEL: Record<string, string> = {
  HIRE: '입사',
  PROMOTION: '승진',
  TRANSFER: '이동',
  LEAVE_OF_ABSENCE: '휴직',
  RETURN: '복직',
  RESIGN: '퇴사',
};
const TYPE_LABEL: Record<string, string> = {
  REGULAR: '정규직',
  CONTRACT: '계약직',
  PARTTIME: '단시간',
  INTERN: '인턴',
};

export default function EmployeeDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const me = api.auth.me.useQuery();
  const detail = api.hrm.detail.useQuery({ id });
  const assignments = api.hrm.assignmentHistory.useQuery({ employeeId: id });
  const balance = api.hrm.leaveBalance.useQuery({ employeeId: id, leaveType: 'ANNUAL' });
  const departments = api.hrm.orgChart.useQuery({});
  const [editing, setEditing] = useState(false);

  if (detail.isLoading) return <Spinner />;
  if (detail.error) return <EmptyState title="사원을 찾을 수 없습니다." description={detail.error.message} />;
  const e = detail.data!;
  const canWrite = !!me.data?.isAdmin || !!me.data?.permissions.includes('hr.write');
  const canSensitive = !!me.data?.isAdmin || !!me.data?.permissions.includes('hr.sensitive.read');

  const flatDepartments = (departments.data ?? []).flatMap(function flatten(n): {
    id: string;
    name: string;
  }[] {
    return [{ id: n.id, name: n.name }, ...n.children.flatMap(flatten)];
  });

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
        <div className="flex items-center gap-2">
          <StatusBadge status={e.status} label={STATUS_LABEL[e.status]} />
          {canWrite ? (
            <Button size="sm" onClick={() => setEditing((v) => !v)}>
              {editing ? '수정 닫기' : '정보 수정'}
            </Button>
          ) : null}
        </div>
      </header>

      {editing ? (
        <EmployeeEditForm
          employee={e}
          departments={flatDepartments}
          onDone={() => {
            setEditing(false);
            void detail.refetch();
          }}
        />
      ) : null}

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

      {canWrite ? <ChangeRequestReviewPanel employeeId={id} /> : null}

      <AttachmentPanel ownerType="EMPLOYEE_DOC" ownerId={id} readOnly={!canWrite} />
    </div>
  );
}

/** HRM-01: edit an employee's non-sensitive fields with optimistic-lock (version) protection. */
function EmployeeEditForm({
  employee,
  departments,
  onDone,
}: {
  employee: {
    id: string;
    version: number;
    name: string;
    birthDate: unknown;
    phone: string | null;
    email: string | null;
    address: string | null;
    hireDate: unknown;
    departmentId: string | null;
    positionCode: string | null;
    jobTitle: string | null;
    employmentType: string;
    contractEndDate: unknown;
  };
  departments: { id: string; name: string }[];
  onDone: () => void;
}) {
  const update = api.hrm.update.useMutation();
  const [errors, setErrors] = useState<FieldError[]>([]);
  const [form, setForm] = useState({
    name: employee.name,
    birthDate: fmt.date(employee.birthDate as string),
    phone: employee.phone ?? '',
    email: employee.email ?? '',
    address: employee.address ?? '',
    hireDate: fmt.date(employee.hireDate as string),
    departmentId: employee.departmentId ?? '',
    positionCode: employee.positionCode ?? '',
    jobTitle: employee.jobTitle ?? '',
    employmentType: employee.employmentType as 'REGULAR' | 'CONTRACT' | 'PARTTIME' | 'INTERN',
    contractEndDate: fmt.date(employee.contractEndDate as string),
  });

  async function submit(ev: React.FormEvent) {
    ev.preventDefault();
    const found: FieldError[] = [];
    if (!form.name.trim()) found.push({ field: 'ee-name', label: '성명', message: '성명을 입력하세요.' });
    if (!form.hireDate) found.push({ field: 'ee-hire', label: '입사일', message: '입사일을 입력하세요.' });
    setErrors(found);
    if (found.length) return;

    try {
      await update.mutateAsync({
        id: employee.id,
        version: employee.version,
        name: form.name.trim(),
        hireDate: form.hireDate,
        employmentType: form.employmentType,
        ...(form.birthDate ? { birthDate: form.birthDate } : {}),
        ...(form.phone.trim() ? { phone: form.phone.trim() } : {}),
        ...(form.email.trim() ? { email: form.email.trim() } : {}),
        ...(form.address.trim() ? { address: form.address.trim() } : {}),
        // Not sending departmentId when "미지정" is selected leaves the current department
        // unchanged — the router's cuid schema has no way to express "clear it".
        ...(form.departmentId ? { departmentId: form.departmentId } : {}),
        ...(form.positionCode.trim() ? { positionCode: form.positionCode.trim() } : {}),
        ...(form.jobTitle.trim() ? { jobTitle: form.jobTitle.trim() } : {}),
        ...(form.contractEndDate ? { contractEndDate: form.contractEndDate } : {}),
        requestId: newRequestId(),
      });
      onDone();
    } catch (err) {
      setErrors([
        {
          field: 'ee-name',
          label: '저장',
          message: (err as { message?: string }).message ?? '저장에 실패했습니다.',
        },
      ]);
    }
  }

  return (
    <Card title="사원정보 수정">
      <form className="flex flex-col gap-3" onSubmit={submit}>
        <FormErrorSummary errors={errors} />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="성명" htmlFor="ee-name" required>
            <Input
              id="ee-name"
              name="ee-name"
              value={form.name}
              onChange={(ev) => setForm({ ...form, name: ev.target.value })}
            />
          </Field>
          <Field label="생년월일" htmlFor="ee-birth">
            <Input
              id="ee-birth"
              type="date"
              value={form.birthDate}
              onChange={(ev) => setForm({ ...form, birthDate: ev.target.value })}
            />
          </Field>
          <Field label="입사일" htmlFor="ee-hire" required>
            <Input
              id="ee-hire"
              name="ee-hire"
              type="date"
              value={form.hireDate}
              onChange={(ev) => setForm({ ...form, hireDate: ev.target.value })}
            />
          </Field>
          <Field label="계약종료일" htmlFor="ee-contract-end" hint="계약직 등에 한해 입력">
            <Input
              id="ee-contract-end"
              type="date"
              value={form.contractEndDate}
              onChange={(ev) => setForm({ ...form, contractEndDate: ev.target.value })}
            />
          </Field>
          <Field label="부서" htmlFor="ee-dept">
            <Select
              id="ee-dept"
              value={form.departmentId}
              onChange={(ev) => setForm({ ...form, departmentId: ev.target.value })}
            >
              <option value="">변경 없음</option>
              {departments.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="직위" htmlFor="ee-title">
            <Input
              id="ee-title"
              value={form.jobTitle}
              onChange={(ev) => setForm({ ...form, jobTitle: ev.target.value })}
            />
          </Field>
          <Field label="직위코드" htmlFor="ee-position">
            <Input
              id="ee-position"
              value={form.positionCode}
              onChange={(ev) => setForm({ ...form, positionCode: ev.target.value })}
            />
          </Field>
          <Field label="고용형태" htmlFor="ee-type">
            <Select
              id="ee-type"
              value={form.employmentType}
              onChange={(ev) =>
                setForm({ ...form, employmentType: ev.target.value as typeof form.employmentType })
              }
            >
              {Object.entries(TYPE_LABEL).map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="연락처" htmlFor="ee-phone">
            <Input
              id="ee-phone"
              value={form.phone}
              onChange={(ev) => setForm({ ...form, phone: ev.target.value })}
            />
          </Field>
          <Field label="이메일" htmlFor="ee-email">
            <Input
              id="ee-email"
              type="email"
              value={form.email}
              onChange={(ev) => setForm({ ...form, email: ev.target.value })}
            />
          </Field>
          <Field label="주소" htmlFor="ee-address" className="sm:col-span-2">
            <Input
              id="ee-address"
              value={form.address}
              onChange={(ev) => setForm({ ...form, address: ev.target.value })}
            />
          </Field>
        </div>
        <p className="text-xs text-slate-500">
          부서를 &quot;변경 없음&quot;으로 두면 현재 소속이 유지됩니다. 다른 사용자가 먼저 저장한 경우 저장이
          거부되며, 이 화면을 새로고침한 뒤 다시 수정하세요.
        </p>
        <div className="flex justify-end gap-1.5">
          <Button type="button" size="sm" onClick={onDone}>
            취소
          </Button>
          <Button type="submit" size="sm" variant="primary" disabled={update.isPending}>
            {update.isPending ? '저장 중…' : '저장'}
          </Button>
        </div>
      </form>
    </Card>
  );
}

const CHANGE_FIELD_LABEL: Record<string, string> = { phone: '연락처', email: '이메일', address: '주소' };

interface ChangeRequestRow {
  id: string;
  employeeId: string;
  employee: { id: string; employeeNo: string; name: string };
  changes: Record<string, { before: string | null; after: string }>;
  createdAt: string;
}

/**
 * HRM-13: employees submit their own change requests (연락처·이메일·주소); HR reviews them
 * here from a real queue (hrm.pendingChangeRequests) instead of pasting a request id copied
 * out of the audit log. The queue is global, not filtered to this employee — filtering it
 * would hide any other employee's pending request from every reviewer, since this panel is
 * the only place the queue is visible. This employee's own request (if any) is highlighted.
 */
function ChangeRequestReviewPanel({ employeeId }: { employeeId: string }) {
  const pending = api.hrm.pendingChangeRequests.useQuery({ status: 'PENDING' });
  const review = api.hrm.reviewChange.useMutation();
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const rows = (pending.data ?? []) as unknown as ChangeRequestRow[];

  async function decide(requestId: string, approve: boolean) {
    setError(null);
    setBusyId(requestId);
    try {
      await review.mutateAsync({ requestId, approve, idempotencyKey: newRequestId() });
      await pending.refetch();
    } catch (err) {
      setError((err as { message?: string }).message ?? '처리에 실패했습니다.');
    } finally {
      setBusyId(null);
    }
  }

  return (
    <Card title={`정보 변경신청 검토 (대기 ${rows.length}건)`}>
      <p className="mb-3 text-xs text-slate-500">
        사원 본인이 신청한 연락처·이메일·주소 변경신청 전체 대기열입니다. 승인하면 즉시 사원정보에 반영됩니다.
        이 사원의 신청은 강조 표시됩니다.
      </p>
      {error ? (
        <p role="alert" className="mb-2 rounded bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      ) : null}
      {pending.isLoading ? (
        <Spinner />
      ) : rows.length === 0 ? (
        <EmptyState title="대기 중인 변경신청이 없습니다." />
      ) : (
        <ul className="flex flex-col gap-3">
          {rows.map((r) => (
            <li
              key={r.id}
              className={
                'rounded border p-3' +
                (r.employeeId === employeeId ? ' border-blue-300 bg-blue-50' : ' border-slate-200')
              }
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="text-sm">
                  <span className="font-medium">{r.employee.name}</span>{' '}
                  <span className="text-slate-500">({r.employee.employeeNo})</span>
                  <span className="ml-2 text-xs text-slate-400">{fmt.dateTime(r.createdAt)} 신청</span>
                </div>
                <div className="flex gap-1.5">
                  <Button
                    size="sm"
                    variant="primary"
                    disabled={busyId === r.id}
                    onClick={() => void decide(r.id, true)}
                  >
                    승인
                  </Button>
                  <Button
                    size="sm"
                    variant="danger"
                    disabled={busyId === r.id}
                    onClick={() => void decide(r.id, false)}
                  >
                    반려
                  </Button>
                </div>
              </div>
              <div className="mt-2 flex flex-col gap-1 text-sm">
                {Object.entries(r.changes).map(([field, change]) => (
                  <div key={field} className="flex flex-wrap items-baseline gap-2">
                    <span className="w-16 shrink-0 text-slate-500">{CHANGE_FIELD_LABEL[field] ?? field}</span>
                    <span className="text-slate-400 line-through">{change.before || '(없음)'}</span>
                    <span aria-hidden="true">→</span>
                    <span className="font-medium">{change.after}</span>
                  </div>
                ))}
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
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
