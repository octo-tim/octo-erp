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

/** HRM-04 / HRM-07: monthly attendance, correction requests and (HR) bulk excel upload. */
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
const ATTENDANCE_STATUS_VALUES = new Set(Object.keys(STATUS_LABEL));
const TIME_RE = /^\d{2}:\d{2}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export default function AttendancePage() {
  const today = businessDate();
  const [month, setMonth] = useState(today.slice(0, 7));
  const me = api.hrm.me.useQuery(undefined, { retry: false });
  const auth = api.auth.me.useQuery();
  const from = `${month}-01`;
  const to = `${month}-31`;

  const attendance = api.hrm.attendanceMonthly.useQuery(
    { employeeId: me.data?.id ?? '', from, to },
    { enabled: !!me.data },
  );
  const corrections = api.hrm.listCorrections.useQuery({ page: 1, pageSize: 50, sortDir: 'desc' });
  const [correcting, setCorrecting] = useState<string | null>(null);
  const canUpload = !!auth.data?.isAdmin || !!auth.data?.permissions.includes('hr.attendance');

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

      {canUpload ? <AttendanceUploadPanel /> : null}
    </div>
  );
}

type AttendanceStatusValue =
  'NORMAL' | 'LATE' | 'EARLY_LEAVE' | 'ABSENT' | 'LEAVE' | 'HALF_LEAVE' | 'HOLIDAY' | 'BUSINESS_TRIP';

interface AttendanceCsvRow {
  originalRow: number;
  employeeNo: string;
  workDate: string;
  checkIn?: string;
  checkOut?: string;
  status?: AttendanceStatusValue;
  note?: string;
}
interface CsvRowError {
  row: number;
  message: string;
}

/** Parses the pasted/uploaded CSV client-side: required columns, time/status format —
 *  anything the service itself would validate per row (사번 존재, 근무일 범위 등) is left
 *  to attendanceUpload so its message is shown, not duplicated here. */
function parseAttendanceCsv(text: string): {
  rows: AttendanceCsvRow[];
  clientErrors: CsvRowError[];
  parseError: string | null;
} {
  const lines = text
    .replace(/^﻿/, '')
    .split(/\r?\n/)
    .filter((l) => l.trim().length > 0);
  if (lines.length < 2) {
    return {
      rows: [],
      clientErrors: [],
      parseError: '데이터 행이 없습니다. 첫 행에 열 이름을, 그 아래에 데이터를 입력하세요.',
    };
  }
  const header = (lines[0] ?? '').split(',').map((s) => s.trim());
  if (!header.includes('employeeNo') || !header.includes('workDate')) {
    return {
      rows: [],
      clientErrors: [],
      parseError:
        '헤더에 employeeNo, workDate 열이 있어야 합니다. 예: employeeNo,workDate,checkIn,checkOut,status,note',
    };
  }

  const rows: AttendanceCsvRow[] = [];
  const clientErrors: CsvRowError[] = [];
  lines.slice(1).forEach((line, idx) => {
    const originalRow = idx + 1;
    const cells = line.split(',').map((s) => s.trim());
    const cell: Record<string, string> = {};
    header.forEach((key, i) => {
      cell[key] = cells[i] ?? '';
    });
    const employeeNo = cell['employeeNo'] ?? '';
    const workDate = cell['workDate'] ?? '';
    if (!employeeNo || !workDate) {
      clientErrors.push({ row: originalRow, message: '사번과 근무일은 필수입니다.' });
      return;
    }
    if (!DATE_RE.test(workDate)) {
      clientErrors.push({ row: originalRow, message: '근무일은 YYYY-MM-DD 형식이어야 합니다.' });
      return;
    }
    const checkIn = cell['checkIn'] ?? '';
    const checkOut = cell['checkOut'] ?? '';
    if (checkIn && !TIME_RE.test(checkIn)) {
      clientErrors.push({
        row: originalRow,
        message: `출근시각 형식이 올바르지 않습니다(HH:MM): ${checkIn}`,
      });
      return;
    }
    if (checkOut && !TIME_RE.test(checkOut)) {
      clientErrors.push({
        row: originalRow,
        message: `퇴근시각 형식이 올바르지 않습니다(HH:MM): ${checkOut}`,
      });
      return;
    }
    const status = cell['status'] ?? '';
    if (status && !ATTENDANCE_STATUS_VALUES.has(status)) {
      clientErrors.push({
        row: originalRow,
        message: `상태 값이 올바르지 않습니다: ${status} (허용: ${[...ATTENDANCE_STATUS_VALUES].join(', ')})`,
      });
      return;
    }
    rows.push({
      originalRow,
      employeeNo,
      workDate,
      ...(checkIn ? { checkIn } : {}),
      ...(checkOut ? { checkOut } : {}),
      ...(status ? { status: status as AttendanceStatusValue } : {}),
      ...(cell['note'] ? { note: cell['note'] } : {}),
    });
  });
  return { rows, clientErrors, parseError: null };
}

/** HRM-04: "웹·모바일 체크인 또는 엑셀 업로드" — the upload path. Validates every row and
 *  applies only the valid ones; nothing is written until 업로드 실행 is pressed. */
function AttendanceUploadPanel() {
  const upload = api.hrm.attendanceUpload.useMutation();
  const [text, setText] = useState('');
  const [fileName, setFileName] = useState('');
  const [parsed, setParsed] = useState<AttendanceCsvRow[]>([]);
  const [clientErrors, setClientErrors] = useState<CsvRowError[]>([]);
  const [parseError, setParseError] = useState<string | null>(null);
  const [result, setResult] = useState<{ total: number; applied: number; errors: CsvRowError[] } | null>(
    null,
  );

  function runParse(raw: string) {
    setResult(null);
    const { rows, clientErrors: ce, parseError: pe } = parseAttendanceCsv(raw);
    setParsed(rows);
    setClientErrors(ce);
    setParseError(pe);
  }

  async function onFile(ev: React.ChangeEvent<HTMLInputElement>) {
    const file = ev.target.files?.[0];
    if (!file) return;
    const raw = await file.text();
    setText(raw);
    setFileName(file.name);
    runParse(raw);
    ev.target.value = '';
  }

  async function apply() {
    if (parsed.length === 0) return;
    setResult(null);
    try {
      const res = await upload.mutateAsync({
        rows: parsed.map(({ originalRow: _originalRow, ...row }) => row),
        requestId: newRequestId(),
      });
      // Map the service's per-row index (position within the submitted rows) back to the
      // original CSV line number so the two error lists line up for the user.
      const mappedErrors = res.errors.map((e) => ({
        row: parsed[e.row - 1]?.originalRow ?? e.row,
        message: e.message,
      }));
      setResult({ total: res.total, applied: res.applied, errors: mappedErrors });
    } catch (err) {
      setResult(null);
      setParseError((err as { message?: string }).message ?? '업로드에 실패했습니다.');
    }
  }

  const allErrors = [...clientErrors, ...(result?.errors ?? [])].sort((a, b) => a.row - b.row);

  return (
    <Card title="근태 엑셀 업로드 (관리자)">
      <p className="mb-3 text-xs text-slate-500">
        열: employeeNo, workDate(YYYY-MM-DD), checkIn(HH:MM, 선택), checkOut(HH:MM, 선택), status(선택),
        note(선택). 첫 행은 열 이름이며, 형식 오류가 있는 행은 반영되지 않고 오류로 표시됩니다.
      </p>

      <div className="flex flex-wrap items-end gap-2">
        <label className="inline-flex">
          <input type="file" accept=".csv,text/csv" className="sr-only" onChange={onFile} />
          <span className="inline-flex h-9 cursor-pointer items-center rounded-md border border-slate-300 bg-white px-3 text-sm">
            파일 올리기
          </span>
        </label>
        {fileName ? <span className="text-sm text-slate-500">{fileName}</span> : null}
      </div>

      <Field label="또는 직접 붙여넣기" htmlFor="att-csv-text" className="mt-3">
        <textarea
          id="att-csv-text"
          value={text}
          onChange={(ev) => {
            setText(ev.target.value);
            setFileName('');
          }}
          rows={5}
          placeholder={'employeeNo,workDate,checkIn,checkOut,status,note\n2024001,2026-08-01,09:00,18:00,,'}
          className="w-full rounded-md border border-slate-300 bg-white px-2.5 py-2 font-mono text-xs"
        />
      </Field>
      <div className="mt-2 flex justify-end gap-1.5">
        <Button size="sm" onClick={() => runParse(text)} disabled={!text.trim()}>
          구문분석
        </Button>
        <Button
          size="sm"
          variant="primary"
          onClick={() => void apply()}
          disabled={parsed.length === 0 || upload.isPending}
        >
          {upload.isPending ? '업로드 중…' : `업로드 실행 (${parsed.length}행)`}
        </Button>
      </div>

      {parseError ? (
        <p role="alert" className="mt-3 rounded bg-red-50 px-3 py-2 text-sm text-red-700">
          {parseError}
        </p>
      ) : null}

      {result ? (
        <p role="status" className="mt-3 rounded bg-green-50 px-3 py-2 text-sm text-green-800">
          전체 {result.total}행 중 {result.applied}행 반영, {result.errors.length}행 오류.
        </p>
      ) : null}

      {parsed.length > 0 || allErrors.length > 0 ? (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-max text-sm">
            <thead className="bg-slate-50">
              <tr>
                <th scope="col" className="px-3 py-2 text-left font-semibold">
                  행
                </th>
                <th scope="col" className="px-3 py-2 text-left font-semibold">
                  사번
                </th>
                <th scope="col" className="px-3 py-2 text-left font-semibold">
                  근무일
                </th>
                <th scope="col" className="px-3 py-2 text-left font-semibold">
                  출근
                </th>
                <th scope="col" className="px-3 py-2 text-left font-semibold">
                  퇴근
                </th>
                <th scope="col" className="px-3 py-2 text-left font-semibold">
                  오류
                </th>
              </tr>
            </thead>
            <tbody>
              {parsed.map((r) => {
                const rowErrors = allErrors.filter((e) => e.row === r.originalRow);
                return (
                  <tr
                    key={r.originalRow}
                    className={rowErrors.length ? 'bg-red-50/60' : 'border-b border-slate-100 last:border-0'}
                  >
                    <td className="px-3 py-1.5 tabular">{r.originalRow}</td>
                    <td className="px-3 py-1.5">{r.employeeNo}</td>
                    <td className="px-3 py-1.5">{r.workDate}</td>
                    <td className="px-3 py-1.5">{r.checkIn ?? '-'}</td>
                    <td className="px-3 py-1.5">{r.checkOut ?? '-'}</td>
                    <td className="px-3 py-1.5 text-red-700">
                      {rowErrors.map((e) => e.message).join(' / ')}
                    </td>
                  </tr>
                );
              })}
              {clientErrors
                .filter((e) => !parsed.some((r) => r.originalRow === e.row))
                .map((e) => (
                  <tr key={`ce-${e.row}`} className="bg-red-50/60">
                    <td className="px-3 py-1.5 tabular">{e.row}</td>
                    <td className="px-3 py-1.5" colSpan={4}>
                      (형식 오류로 제외됨)
                    </td>
                    <td className="px-3 py-1.5 text-red-700">{e.message}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </Card>
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
