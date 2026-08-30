'use client';

import { useState } from 'react';
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
import { FormErrorSummary, type FieldError } from '@/components/ui/form-error-summary';
import { fmt } from '@/lib/format';
import { businessDate } from '@/lib/dates';

/** HRM-04 / HRM-07: monthly attendance with correction requests. */
const STATUS_LABEL: Record<string, string> = {
  NORMAL: '정상',
  LATE: '지각',
  EARLY_LEAVE: '조퇴',
  ABSENT: '결근',
  LEAVE: '휴가',
  HALF_LEAVE: '반차',
  HOLIDAY: '휴일',
  BUSINESS_TRIP: '출장',
};

export default function AttendancePage() {
  const today = businessDate();
  const [month, setMonth] = useState(today.slice(0, 7));
  const me = api.hrm.me.useQuery(undefined, { retry: false });
  const from = `${month}-01`;
  const to = `${month}-31`;

  const attendance = api.hrm.attendanceMonthly.useQuery(
    { employeeId: me.data?.id ?? '', from, to },
    { enabled: !!me.data },
  );
  const corrections = api.hrm.listCorrections.useQuery({ page: 1, pageSize: 50, sortDir: 'desc' });
  const [correcting, setCorrecting] = useState<string | null>(null);

  if (me.isLoading) return <Spinner />;
  if (me.error) return <EmptyState title="근태를 조회할 수 없습니다." description={me.error.message} />;

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold">근태</h1>
          <p className="mt-0.5 text-sm text-slate-500">
            기록이 잘못된 날은 정정신청을 하면 결재 승인 후 반영됩니다.
          </p>
        </div>
        <Field label="조회 월" htmlFor="att-month" className="w-44">
          <Input id="att-month" type="month" value={month} onChange={(e) => setMonth(e.target.value)} />
        </Field>
      </header>

      {attendance.data ? (
        <Card title={`${month} 집계`}>
          <div className="flex flex-wrap gap-6 text-sm">
            <span>
              근무 <strong className="tabular">{Math.round(attendance.data.totals.workMinutes / 60)}</strong>
              시간
            </span>
            <span>
              연장{' '}
              <strong className="tabular">{Math.round(attendance.data.totals.overtimeMinutes / 60)}</strong>
              시간
            </span>
            <span>
              야간 <strong className="tabular">{Math.round(attendance.data.totals.nightMinutes / 60)}</strong>
              시간
            </span>
            <span>
              휴일{' '}
              <strong className="tabular">{Math.round(attendance.data.totals.holidayMinutes / 60)}</strong>
              시간
            </span>
            <span className="text-slate-500">
              지각 {attendance.data.counts.late}일 · 결근 {attendance.data.counts.absent}일 · 휴가{' '}
              {attendance.data.counts.leave}일
            </span>
          </div>
          {attendance.data.overtimeWarning ? (
            <p role="alert" className="mt-2 rounded bg-amber-50 px-3 py-2 text-sm text-amber-800">
              {attendance.data.overtimeWarning}
            </p>
          ) : null}
        </Card>
      ) : null}

      <Card title="일별 근태">
        {attendance.isLoading ? (
          <Spinner />
        ) : (attendance.data?.rows ?? []).length === 0 ? (
          <EmptyState
            title="해당 월의 근태 기록이 없습니다."
            description="출퇴근을 기록하거나 관리자에게 엑셀 업로드를 요청하세요."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-max text-sm">
              <thead className="bg-slate-50">
                <tr>
                  <th scope="col" className="px-3 py-2 text-left font-semibold">
                    근무일
                  </th>
                  <th scope="col" className="px-3 py-2 text-left font-semibold">
                    출근
                  </th>
                  <th scope="col" className="px-3 py-2 text-left font-semibold">
                    퇴근
                  </th>
                  <th scope="col" className="px-3 py-2 text-right font-semibold">
                    근무
                  </th>
                  <th scope="col" className="px-3 py-2 text-right font-semibold">
                    연장
                  </th>
                  <th scope="col" className="px-3 py-2 text-left font-semibold">
                    상태
                  </th>
                  <th scope="col" className="px-3 py-2 text-left font-semibold">
                    정정
                  </th>
                </tr>
              </thead>
              <tbody>
                {(attendance.data?.rows ?? []).map((r) => (
                  <tr key={r.id} className="border-b border-slate-100 last:border-0">
                    <td className="px-3 py-1.5">{r.workDate}</td>
                    <td className="px-3 py-1.5">
                      {r.checkIn ? fmt.dateTime(r.checkIn as unknown as string).slice(11) : '-'}
                    </td>
                    <td className="px-3 py-1.5">
                      {r.checkOut ? fmt.dateTime(r.checkOut as unknown as string).slice(11) : '-'}
                    </td>
                    <td className="px-3 py-1.5 tabular text-right">{Math.round(r.workMinutes / 6) / 10}h</td>
                    <td className="px-3 py-1.5 tabular text-right">
                      {Math.round(r.overtimeMinutes / 6) / 10}h
                    </td>
                    <td className="px-3 py-1.5">
                      <StatusBadge status={r.status} label={STATUS_LABEL[r.status] ?? r.status} />
                    </td>
                    <td className="px-3 py-1.5">
                      <Button size="sm" variant="ghost" onClick={() => setCorrecting(r.workDate)}>
                        정정신청
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {correcting ? (
        <CorrectionForm
          workDate={correcting}
          onDone={() => {
            setCorrecting(null);
            void corrections.refetch();
          }}
        />
      ) : null}

      <Card title="정정신청 내역">
        {(corrections.data?.rows ?? []).length === 0 ? (
          <EmptyState title="정정신청 내역이 없습니다." />
        ) : (
          <ul className="divide-y divide-slate-100 text-sm">
            {(corrections.data?.rows ?? []).map((c) => (
              <li key={c.id} className="flex items-center justify-between gap-2 py-2">
                <span>
                  {c.docNo} · {fmt.date(c.workDate as unknown as string)} · {c.reason}
                </span>
                <StatusBadge status={c.status} />
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

function CorrectionForm({ workDate, onDone }: { workDate: string; onDone: () => void }) {
  const request = api.hrm.requestCorrection.useMutation();
  const [errors, setErrors] = useState<FieldError[]>([]);
  const [form, setForm] = useState({ checkIn: '', checkOut: '', status: '', reason: '' });

  return (
    <Card title={`${workDate} 근태 정정신청`}>
      <form
        className="flex flex-col gap-3"
        onSubmit={async (e) => {
          e.preventDefault();
          if (form.reason.trim().length < 5) {
            setErrors([{ field: 'cor-reason', label: '사유', message: '정정 사유를 5자 이상 입력하세요.' }]);
            return;
          }
          setErrors([]);
          try {
            await request.mutateAsync({
              workDate,
              ...(form.checkIn ? { requestedCheckIn: form.checkIn } : {}),
              ...(form.checkOut ? { requestedCheckOut: form.checkOut } : {}),
              ...(form.status ? { requestedStatus: form.status as 'NORMAL' } : {}),
              reason: form.reason.trim(),
              requestId: newRequestId(),
            });
            onDone();
          } catch (err) {
            setErrors([
              {
                field: 'cor-reason',
                label: '신청',
                message: (err as { message?: string }).message ?? '신청에 실패했습니다.',
              },
            ]);
          }
        }}
      >
        <FormErrorSummary errors={errors} />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
          <Field label="출근 시각" htmlFor="cor-in" hint="HH:MM">
            <Input
              id="cor-in"
              type="time"
              value={form.checkIn}
              onChange={(e) => setForm({ ...form, checkIn: e.target.value })}
            />
          </Field>
          <Field label="퇴근 시각" htmlFor="cor-out" hint="HH:MM">
            <Input
              id="cor-out"
              type="time"
              value={form.checkOut}
              onChange={(e) => setForm({ ...form, checkOut: e.target.value })}
            />
          </Field>
          <Field label="상태" htmlFor="cor-status">
            <Select
              id="cor-status"
              value={form.status}
              onChange={(e) => setForm({ ...form, status: e.target.value })}
            >
              <option value="">변경 없음</option>
              {Object.entries(STATUS_LABEL).map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="사유" htmlFor="cor-reason" required>
            <Input
              id="cor-reason"
              name="cor-reason"
              value={form.reason}
              onChange={(e) => setForm({ ...form, reason: e.target.value })}
            />
          </Field>
        </div>
        <div className="flex justify-end gap-1.5">
          <Button type="button" size="sm" onClick={onDone}>
            취소
          </Button>
          <Button type="submit" size="sm" variant="primary" disabled={request.isPending}>
            신청
          </Button>
        </div>
      </form>
    </Card>
  );
}
