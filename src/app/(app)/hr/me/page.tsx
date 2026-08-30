'use client';

import { useState } from 'react';
import { api, newRequestId } from '@/lib/trpc';
import { Button, Card, EmptyState, Field, Input, Spinner } from '@/components/ui/primitives';
import { FormErrorSummary, type FieldError } from '@/components/ui/form-error-summary';
import { fmt } from '@/lib/format';
import { businessDate } from '@/lib/dates';

/** HRM-13: an employee's own information, attendance and leave, plus change requests. */
export default function MyInfoPage() {
  const me = api.hrm.me.useQuery();
  const today = businessDate();
  const monthStart = `${today.slice(0, 7)}-01`;

  const balance = api.hrm.leaveBalance.useQuery(
    { employeeId: me.data?.id ?? '', leaveType: 'ANNUAL' },
    { enabled: !!me.data },
  );
  const attendance = api.hrm.attendanceMonthly.useQuery(
    { employeeId: me.data?.id ?? '', from: monthStart, to: today },
    { enabled: !!me.data },
  );
  const checkIn = api.hrm.checkIn.useMutation();
  const checkOut = api.hrm.checkOut.useMutation();
  const [message, setMessage] = useState<string | null>(null);

  if (me.isLoading) return <Spinner />;
  if (me.error) return <EmptyState title="내 정보를 불러올 수 없습니다." description={me.error.message} />;
  const e = me.data!;

  async function punch(kind: 'in' | 'out') {
    setMessage(null);
    try {
      if (kind === 'in') await checkIn.mutateAsync({ requestId: newRequestId() });
      else await checkOut.mutateAsync({ requestId: newRequestId() });
      setMessage(kind === 'in' ? '출근이 기록되었습니다.' : '퇴근이 기록되었습니다.');
      await attendance.refetch();
    } catch (err) {
      setMessage((err as { message?: string }).message ?? '기록에 실패했습니다.');
    }
  }

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <h1 className="text-lg font-semibold">내 정보</h1>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="기본정보">
          <dl className="grid grid-cols-[6rem_1fr] gap-y-2 text-sm">
            <dt className="text-slate-500">사번</dt>
            <dd>{e.employeeNo}</dd>
            <dt className="text-slate-500">성명</dt>
            <dd>{e.name}</dd>
            <dt className="text-slate-500">부서</dt>
            <dd>{e.department?.name ?? '-'}</dd>
            <dt className="text-slate-500">직위</dt>
            <dd>{e.jobTitle ?? '-'}</dd>
            <dt className="text-slate-500">입사일</dt>
            <dd>{fmt.date(e.hireDate as unknown as string)}</dd>
            <dt className="text-slate-500">연락처</dt>
            <dd>{e.phone ?? '-'}</dd>
          </dl>
        </Card>

        <Card title="연차">
          {balance.data ? (
            <dl className="grid grid-cols-[5rem_1fr] gap-y-2 text-sm">
              <dt className="text-slate-500">부여</dt>
              <dd className="tabular">{balance.data.granted}일</dd>
              <dt className="text-slate-500">사용</dt>
              <dd className="tabular">{balance.data.used}일</dd>
              <dt className="text-slate-500">잔여</dt>
              <dd className="tabular text-base font-semibold">{balance.data.remaining}일</dd>
            </dl>
          ) : (
            <Spinner />
          )}
        </Card>

        <Card title="근태">
          <div className="flex gap-1.5">
            <Button size="sm" variant="primary" onClick={() => punch('in')} disabled={checkIn.isPending}>
              출근
            </Button>
            <Button size="sm" onClick={() => punch('out')} disabled={checkOut.isPending}>
              퇴근
            </Button>
          </div>
          {message ? (
            <p role="status" className="mt-2 text-sm text-slate-600">
              {message}
            </p>
          ) : null}
          {attendance.data ? (
            <dl className="mt-3 grid grid-cols-[6rem_1fr] gap-y-1.5 text-sm">
              <dt className="text-slate-500">근무</dt>
              <dd className="tabular">{Math.round(attendance.data.totals.workMinutes / 60)}시간</dd>
              <dt className="text-slate-500">연장</dt>
              <dd className="tabular">{Math.round(attendance.data.totals.overtimeMinutes / 60)}시간</dd>
              <dt className="text-slate-500">지각</dt>
              <dd className="tabular">{attendance.data.counts.late}일</dd>
            </dl>
          ) : null}
          {attendance.data?.overtimeWarning ? (
            <p role="alert" className="mt-2 rounded bg-amber-50 px-2 py-1.5 text-sm text-amber-800">
              {attendance.data.overtimeWarning}
            </p>
          ) : null}
        </Card>
      </div>

      <ChangeRequestForm current={{ phone: e.phone ?? '', email: e.email ?? '', address: e.address ?? '' }} />
    </div>
  );
}

function ChangeRequestForm({ current }: { current: { phone: string; email: string; address: string } }) {
  const request = api.hrm.requestChange.useMutation();
  const [form, setForm] = useState(current);
  const [errors, setErrors] = useState<FieldError[]>([]);
  const [done, setDone] = useState(false);

  return (
    <Card title="정보 변경신청">
      <form
        className="flex flex-col gap-3"
        onSubmit={async (e) => {
          e.preventDefault();
          setErrors([]);
          setDone(false);
          const changes: Record<string, { before: string | null; after: string }> = {};
          for (const key of ['phone', 'email', 'address'] as const) {
            if (form[key] !== current[key]) changes[key] = { before: current[key] || null, after: form[key] };
          }
          if (Object.keys(changes).length === 0) {
            setErrors([{ field: 'me-phone', label: '변경사항', message: '변경된 항목이 없습니다.' }]);
            return;
          }
          try {
            await request.mutateAsync({ changes, requestId: newRequestId() });
            setDone(true);
          } catch (err) {
            setErrors([
              {
                field: 'me-phone',
                label: '신청',
                message: (err as { message?: string }).message ?? '신청에 실패했습니다.',
              },
            ]);
          }
        }}
      >
        <FormErrorSummary errors={errors} />
        {done ? (
          <p role="status" className="rounded bg-green-50 px-3 py-2 text-sm text-green-800">
            변경신청이 접수되었습니다. 인사담당자 확인 후 반영됩니다.
          </p>
        ) : null}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Field label="연락처" htmlFor="me-phone">
            <Input
              id="me-phone"
              name="me-phone"
              value={form.phone}
              onChange={(e) => setForm({ ...form, phone: e.target.value })}
            />
          </Field>
          <Field label="이메일" htmlFor="me-email">
            <Input
              id="me-email"
              type="email"
              value={form.email}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
            />
          </Field>
          <Field label="주소" htmlFor="me-address">
            <Input
              id="me-address"
              value={form.address}
              onChange={(e) => setForm({ ...form, address: e.target.value })}
            />
          </Field>
        </div>
        <p className="text-xs text-slate-500">
          연락처·이메일·주소만 변경신청할 수 있습니다. 그 외 항목은 인사담당자에게 문의하세요.
        </p>
        <div className="flex justify-end">
          <Button type="submit" size="sm" variant="primary" disabled={request.isPending}>
            변경신청
          </Button>
        </div>
      </form>
    </Card>
  );
}
