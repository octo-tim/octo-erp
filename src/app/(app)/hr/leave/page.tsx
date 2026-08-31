'use client';

import { useState } from 'react';
import { api, newRequestId } from '@/lib/trpc';
import { StandardListPage, useSavedFilters } from '@/components/ui/standard-list-page';
import { DataGrid, type Column } from '@/components/ui/data-grid';
import { Button, Card, Field, Input, Select, StatusBadge } from '@/components/ui/primitives';
import { FormErrorSummary, type FieldError } from '@/components/ui/form-error-summary';
import { businessDate } from '@/lib/dates';
import { cmp } from '@/lib/money';

/** HRM-05 / HRM-06: leave requests, annual balance, grant/expiry and cancellation. */
interface Row {
  id: string;
  docNo: string;
  startDate: string;
  endDate: string;
  days: string;
  leaveType: string;
  status: string;
  halfDay: string | null;
  reason: string | null;
  employee: { employeeNo: string; name: string };
}

interface PickedEmployee {
  id: string;
  employeeNo: string;
  name: string;
}

const DAYS_RE = /^\d+(\.\d)?$/;

export default function LeavePage() {
  const me = api.auth.me.useQuery();
  const today = businessDate();
  const yearStart = `${today.slice(0, 4)}-01-01`;

  const { filters, setFilters, save, reset } = useSavedFilters('hr.leave', {
    status: '',
    from: yearStart,
    to: `${today.slice(0, 4)}-12-31`,
  });
  const [applied, setApplied] = useState(filters);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [requesting, setRequesting] = useState(false);
  const [cancelingRow, setCancelingRow] = useState<Row | null>(null);

  const canLeaveAdmin = !!me.data?.isAdmin || !!me.data?.permissions.includes('hr.leave');
  const canReadUsage = canLeaveAdmin || !!me.data?.permissions.includes('hr.read');

  const list = api.hrm.listLeaveRequests.useQuery({
    page,
    pageSize,
    sortDir: 'desc',
    ...(applied.status ? { status: applied.status } : {}),
    ...(applied.from ? { from: applied.from } : {}),
    ...(applied.to ? { to: applied.to } : {}),
  });
  const myEmployee = api.hrm.me.useQuery(undefined, { retry: false });
  const balance = api.hrm.leaveBalance.useQuery(
    { employeeId: myEmployee.data?.id ?? '', leaveType: 'ANNUAL' },
    { enabled: !!myEmployee.data },
  );

  const columns: Column<Row>[] = [
    { key: 'docNo', header: '문서번호', width: 150 },
    {
      key: 'employee',
      header: '신청자',
      width: 120,
      render: (r) => `${r.employee.name} (${r.employee.employeeNo})`,
    },
    { key: 'leaveType', header: '휴가유형', width: 100 },
    { key: 'startDate', header: '시작일', type: 'date', width: 110 },
    { key: 'endDate', header: '종료일', type: 'date', width: 110 },
    { key: 'days', header: '일수', type: 'qty', width: 80, total: true },
    {
      key: 'halfDay',
      header: '반차',
      width: 70,
      render: (r) => (r.halfDay === 'AM' ? '오전' : r.halfDay === 'PM' ? '오후' : '-'),
    },
    { key: 'status', header: '상태', width: 90, render: (r) => <StatusBadge status={r.status} /> },
    { key: 'reason', header: '사유', render: (r) => r.reason ?? '-' },
    ...(canLeaveAdmin
      ? [
          {
            key: 'admin',
            header: '관리',
            width: 90,
            render: (r: Row) =>
              r.status === 'APPROVED' ? (
                <Button size="sm" variant="ghost" onClick={() => setCancelingRow(r)}>
                  취소처리
                </Button>
              ) : (
                '-'
              ),
          } satisfies Column<Row>,
        ]
      : []),
  ];

  return (
    <>
      <StandardListPage
        title="휴가·연차"
        description="휴가를 신청하고 연차 잔여일수를 확인합니다. 신청은 결재 승인 시점에 연차 사용원장과 근태에 반영됩니다."
        filterKey="hr.leave"
        actions={
          <Button variant="primary" size="sm" onClick={() => setRequesting((v) => !v)}>
            {requesting ? '닫기' : '휴가 신청'}
          </Button>
        }
        filters={
          <>
            <Field label="상태" htmlFor="lv-status">
              <Select
                id="lv-status"
                value={filters.status}
                onChange={(e) => setFilters({ ...filters, status: e.target.value })}
              >
                <option value="">전체</option>
                <option value="DRAFT">작성중</option>
                <option value="PENDING_APPROVAL">결재중</option>
                <option value="APPROVED">승인</option>
                <option value="REJECTED">반려</option>
                <option value="CANCELED">취소</option>
              </Select>
            </Field>
            <Field label="기간 시작" htmlFor="lv-from">
              <Input
                id="lv-from"
                type="date"
                value={filters.from}
                onChange={(e) => setFilters({ ...filters, from: e.target.value })}
              />
            </Field>
            <Field label="기간 종료" htmlFor="lv-to">
              <Input
                id="lv-to"
                type="date"
                value={filters.to}
                onChange={(e) => setFilters({ ...filters, to: e.target.value })}
              />
            </Field>
          </>
        }
        onSearch={() => {
          setApplied(filters);
          setPage(1);
          save(filters);
        }}
        onReset={() => {
          reset();
          setApplied({ status: '', from: yearStart, to: `${today.slice(0, 4)}-12-31` });
        }}
      >
        {balance.data ? (
          <Card>
            <div className="flex flex-wrap gap-6 text-sm">
              <span>
                부여 <strong className="tabular">{balance.data.granted}</strong>일
              </span>
              <span>
                사용 <strong className="tabular">{balance.data.used}</strong>일
              </span>
              <span className="text-blue-800">
                잔여 <strong className="tabular">{balance.data.remaining}</strong>일
              </span>
              <span className="text-slate-500">
                소멸 <span className="tabular">{balance.data.expired}</span>일
              </span>
            </div>
          </Card>
        ) : null}

        {requesting ? (
          <LeaveRequestForm
            remaining={balance.data?.remaining ?? '0.0'}
            onDone={() => {
              setRequesting(false);
              void list.refetch();
              void balance.refetch();
            }}
          />
        ) : null}

        <DataGrid<Row>
          gridKey="hr.leave"
          columns={columns}
          rows={(list.data?.rows ?? []) as unknown as Row[]}
          total={list.data?.total ?? 0}
          page={page}
          pageSize={pageSize}
          loading={list.isLoading}
          error={list.error?.message ?? null}
          onRetry={() => void list.refetch()}
          rowId={(r) => r.id}
          onPageChange={setPage}
          onPageSizeChange={(s) => {
            setPageSize(s);
            setPage(1);
          }}
          emptyTitle="휴가 신청 내역이 없습니다."
          emptyDescription={me.data ? '위의 "휴가 신청" 버튼으로 새 휴가를 신청할 수 있습니다.' : undefined}
        />
      </StandardListPage>

      {cancelingRow ? (
        <CancelLeaveForm
          row={cancelingRow}
          onDone={() => {
            setCancelingRow(null);
            void list.refetch();
            void balance.refetch();
          }}
        />
      ) : null}

      {canReadUsage ? <LeaveUsageSummaryPanel /> : null}
      {canLeaveAdmin ? <LeaveGrantAdminPanel /> : null}
    </>
  );
}

/** HRM-06: HR-administered cancellation of an already-approved (and applied) leave. */
function CancelLeaveForm({ row, onDone }: { row: Row; onDone: () => void }) {
  const cancel = api.hrm.cancelLeave.useMutation();
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  async function doCancel() {
    setError(null);
    try {
      await cancel.mutateAsync({ leaveRequestId: row.id, reason: reason.trim(), requestId: newRequestId() });
      onDone();
    } catch (err) {
      setError((err as { message?: string }).message ?? '취소 처리에 실패했습니다.');
      setConfirming(false);
    }
  }

  return (
    <Card title={`휴가 취소 처리 — ${row.docNo}`}>
      <p className="mb-3 text-sm text-slate-600">
        {row.employee.name}({row.employee.employeeNo})의 {row.startDate} ~ {row.endDate} ({row.days}일) 승인된
        휴가를 취소합니다. 취소하면 사용원장에 반대(음수) 기록이 남고 해당 근태가 원복되며, 되돌릴 수
        없습니다.
      </p>
      <div className="flex flex-wrap items-end gap-2">
        <Field label="취소 사유" htmlFor="cancel-reason" required className="min-w-56 flex-1">
          <Input id="cancel-reason" value={reason} onChange={(ev) => setReason(ev.target.value)} />
        </Field>
        {!confirming ? (
          <Button
            size="sm"
            variant="danger"
            disabled={reason.trim().length < 2}
            onClick={() => setConfirming(true)}
          >
            취소 처리
          </Button>
        ) : null}
        <Button size="sm" onClick={onDone}>
          닫기
        </Button>
      </div>

      {confirming ? (
        <div className="mt-3 rounded-md border border-amber-300 bg-amber-50 p-3">
          <p className="text-sm text-amber-900">
            {row.employee.name}님의 승인된 휴가 {row.days}일을 취소 처리합니다. 되돌릴 수 없는 작업입니다.
            계속하시겠습니까?
          </p>
          <div className="mt-2 flex justify-end gap-1.5">
            <Button size="sm" onClick={() => setConfirming(false)}>
              아니요
            </Button>
            <Button size="sm" variant="danger" onClick={() => void doCancel()} disabled={cancel.isPending}>
              {cancel.isPending ? '처리 중…' : '예, 취소 처리합니다'}
            </Button>
          </div>
        </div>
      ) : null}

      {error ? (
        <p role="alert" className="mt-2 rounded bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      ) : null}
    </Card>
  );
}

/** RPT-10 input surfaced for HR: remaining-day standing per employee for a period. */
function LeaveUsageSummaryPanel() {
  const today = businessDate();
  const [from, setFrom] = useState(`${today.slice(0, 4)}-01-01`);
  const [to, setTo] = useState(today);
  const [applied, setApplied] = useState({ from, to });

  const summary = api.hrm.leaveUsageSummary.useQuery({ from: applied.from, to: applied.to });
  const employees = api.hrm.list.useQuery({ page: 1, pageSize: 200, sortDir: 'asc' });
  const nameById = new Map((employees.data?.rows ?? []).map((e) => [e.id, `${e.name} (${e.employeeNo})`]));

  return (
    <Card
      title="연차 사용 현황 (잔여일수)"
      actions={
        <div className="flex items-end gap-2">
          <Field label="시작" htmlFor="usage-from" className="w-36">
            <Input id="usage-from" type="date" value={from} onChange={(ev) => setFrom(ev.target.value)} />
          </Field>
          <Field label="종료" htmlFor="usage-to" className="w-36">
            <Input id="usage-to" type="date" value={to} onChange={(ev) => setTo(ev.target.value)} />
          </Field>
          <Button size="sm" onClick={() => setApplied({ from, to })}>
            조회
          </Button>
        </div>
      }
    >
      {summary.error ? (
        <p role="alert" className="rounded bg-red-50 px-3 py-2 text-sm text-red-700">
          {summary.error.message}
        </p>
      ) : (summary.data ?? []).length === 0 ? (
        <p className="text-sm text-slate-500">해당 기간의 연차 사용 내역이 없습니다.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-max text-sm">
            <thead className="bg-slate-50">
              <tr>
                <th scope="col" className="px-3 py-2 text-left font-semibold">
                  사원
                </th>
                <th scope="col" className="px-3 py-2 text-right font-semibold">
                  부여
                </th>
                <th scope="col" className="px-3 py-2 text-right font-semibold">
                  사용
                </th>
                <th scope="col" className="px-3 py-2 text-right font-semibold">
                  잔여
                </th>
                <th scope="col" className="px-3 py-2 text-right font-semibold">
                  사용률
                </th>
              </tr>
            </thead>
            <tbody>
              {(summary.data ?? []).map((s) => (
                <tr key={s.employeeId} className="border-b border-slate-100 last:border-0">
                  <td className="px-3 py-1.5">{nameById.get(s.employeeId) ?? s.employeeId}</td>
                  <td className="px-3 py-1.5 tabular text-right">{s.granted}</td>
                  <td className="px-3 py-1.5 tabular text-right">{s.used}</td>
                  <td className="px-3 py-1.5 tabular text-right">{s.remaining}</td>
                  <td className="px-3 py-1.5 tabular text-right">{(s.rate * 100).toFixed(1)}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

/** Quick employee lookup by 사번/성명 for the grant/expiry admin forms below. */
function EmployeeLookup({
  idBase,
  label,
  value,
  onChange,
}: {
  idBase: string;
  label: string;
  value: PickedEmployee | null;
  onChange: (v: PickedEmployee | null) => void;
}) {
  const [q, setQ] = useState('');
  const search = api.hrm.list.useQuery(
    { page: 1, pageSize: 8, sortDir: 'asc', q },
    { enabled: q.trim().length > 0 && !value },
  );

  return (
    <div className="flex min-w-56 flex-1 flex-col gap-1">
      <Field label={label} htmlFor={idBase}>
        <Input
          id={idBase}
          value={value ? `${value.name} (${value.employeeNo})` : q}
          placeholder="사번 또는 성명 검색"
          onChange={(ev) => {
            onChange(null);
            setQ(ev.target.value);
          }}
        />
      </Field>
      {value ? (
        <button
          type="button"
          className="w-fit text-xs text-blue-700 underline"
          onClick={() => onChange(null)}
        >
          선택 해제
        </button>
      ) : q.trim() ? (
        <ul className="max-h-40 overflow-y-auto rounded-md border border-slate-200 bg-white text-sm shadow-sm">
          {(search.data?.rows ?? []).map((r) => (
            <li key={r.id}>
              <button
                type="button"
                className="block w-full px-2 py-1.5 text-left hover:bg-slate-50"
                onClick={() => {
                  onChange({ id: r.id, employeeNo: r.employeeNo, name: r.name });
                  setQ('');
                }}
              >
                {r.name} ({r.employeeNo})
              </button>
            </li>
          ))}
          {(search.data?.rows ?? []).length === 0 && !search.isLoading ? (
            <li className="px-2 py-1.5 text-slate-400">일치하는 사원이 없습니다.</li>
          ) : null}
        </ul>
      ) : null}
    </div>
  );
}

/** HRM-05: 연차 자동부여(정책 기준), 수동 부여, 소멸 처리. 모두 원장에 남는 되돌릴 수 없는 작업이라
 *  실행 전 명시적으로 무엇을, 누구에게 하는지 보여주고 별도로 확인받는다. */
function LeaveGrantAdminPanel() {
  const grantAnnual = api.hrm.grantAnnual.useMutation();
  const grantManual = api.hrm.grantManual.useMutation();
  const expireGrants = api.hrm.expireGrants.useMutation();
  const today = businessDate();

  // 자동부여
  const [autoEmployee, setAutoEmployee] = useState<PickedEmployee | null>(null);
  const [autoAsOf, setAutoAsOf] = useState(today);
  const [autoConfirm, setAutoConfirm] = useState(false);
  const [autoError, setAutoError] = useState<string | null>(null);
  const [autoResult, setAutoResult] = useState<string | null>(null);

  async function runAutoGrant() {
    if (!autoEmployee) return;
    setAutoError(null);
    setAutoResult(null);
    try {
      const res = await grantAnnual.mutateAsync({
        employeeId: autoEmployee.id,
        asOf: autoAsOf,
        requestId: newRequestId(),
      });
      setAutoResult(
        res.granted
          ? `${autoEmployee.name}님에게 ${res.days}일을 부여했습니다 (${res.reason}).`
          : `부여하지 않았습니다: ${res.reason}`,
      );
      setAutoConfirm(false);
    } catch (err) {
      setAutoError((err as { message?: string }).message ?? '부여에 실패했습니다.');
      setAutoConfirm(false);
    }
  }

  // 수동부여
  const [manEmployee, setManEmployee] = useState<PickedEmployee | null>(null);
  const [manForm, setManForm] = useState({
    leaveType: 'ANNUAL',
    days: '',
    grantDate: today,
    expiresAt: '',
    reason: '',
  });
  const [manErrors, setManErrors] = useState<FieldError[]>([]);
  const [manConfirm, setManConfirm] = useState(false);
  const [manResult, setManResult] = useState<string | null>(null);

  function validateManual(): FieldError[] {
    const found: FieldError[] = [];
    if (!manEmployee) found.push({ field: 'man-emp', label: '사원', message: '사원을 선택하세요.' });
    if (!DAYS_RE.test(manForm.days.trim()))
      found.push({ field: 'man-days', label: '일수', message: '일수는 0.1 단위 숫자여야 합니다(예: 1.5).' });
    else if (cmp(manForm.days.trim(), '0') <= 0)
      found.push({ field: 'man-days', label: '일수', message: '일수는 0보다 커야 합니다.' });
    if (!manForm.expiresAt)
      found.push({ field: 'man-exp', label: '유효기한', message: '유효기한을 입력하세요.' });
    if (manForm.reason.trim().length < 2)
      found.push({ field: 'man-reason', label: '사유', message: '사유를 2자 이상 입력하세요.' });
    return found;
  }

  async function runManualGrant() {
    setManResult(null);
    try {
      const res = await grantManual.mutateAsync({
        employeeId: manEmployee!.id,
        leaveType: manForm.leaveType.trim() || 'ANNUAL',
        days: manForm.days.trim(),
        grantDate: manForm.grantDate,
        expiresAt: manForm.expiresAt,
        reason: manForm.reason.trim(),
        requestId: newRequestId(),
      });
      setManResult(`${manEmployee!.name}님에게 ${res.days.toString()}일을 부여했습니다.`);
      setManConfirm(false);
      setManForm({ leaveType: 'ANNUAL', days: '', grantDate: today, expiresAt: '', reason: '' });
      setManEmployee(null);
    } catch (err) {
      setManErrors([
        {
          field: 'man-reason',
          label: '부여',
          message: (err as { message?: string }).message ?? '부여에 실패했습니다.',
        },
      ]);
      setManConfirm(false);
    }
  }

  // 소멸
  const [expireAsOf, setExpireAsOf] = useState(today);
  const [expireConfirm, setExpireConfirm] = useState(false);
  const [expireResult, setExpireResult] = useState<string | null>(null);
  const [expireError, setExpireError] = useState<string | null>(null);

  async function runExpire() {
    setExpireError(null);
    setExpireResult(null);
    try {
      const res = await expireGrants.mutateAsync({ asOf: expireAsOf, requestId: newRequestId() });
      setExpireResult(`${res.expired}건의 연차 부여를 소멸 처리했습니다.`);
      setExpireConfirm(false);
    } catch (err) {
      setExpireError((err as { message?: string }).message ?? '소멸 처리에 실패했습니다.');
      setExpireConfirm(false);
    }
  }

  return (
    <Card title="연차 부여·소멸 관리 (인사담당자)">
      <div className="flex flex-col gap-6">
        <section>
          <h3 className="mb-2 text-sm font-semibold">연차 자동부여 (취업규칙 기준)</h3>
          <div className="flex flex-wrap items-end gap-2">
            <EmployeeLookup idBase="auto-emp" label="사원" value={autoEmployee} onChange={setAutoEmployee} />
            <Field label="기준일" htmlFor="auto-asof" className="w-40">
              <Input
                id="auto-asof"
                type="date"
                value={autoAsOf}
                onChange={(ev) => setAutoAsOf(ev.target.value)}
              />
            </Field>
            {!autoConfirm ? (
              <Button size="sm" disabled={!autoEmployee} onClick={() => setAutoConfirm(true)}>
                부여 대상 확인
              </Button>
            ) : null}
          </div>
          {autoConfirm && autoEmployee ? (
            <div className="mt-2 rounded-md border border-amber-300 bg-amber-50 p-3">
              <p className="text-sm text-amber-900">
                {autoEmployee.name}({autoEmployee.employeeNo}) 1명에게 {autoAsOf} 기준 승인된 정책에 따라
                연차를 자동 부여합니다. 원장에 남는 되돌릴 수 없는 작업입니다.
              </p>
              <div className="mt-2 flex justify-end gap-1.5">
                <Button size="sm" onClick={() => setAutoConfirm(false)}>
                  아니요
                </Button>
                <Button
                  size="sm"
                  variant="primary"
                  onClick={() => void runAutoGrant()}
                  disabled={grantAnnual.isPending}
                >
                  {grantAnnual.isPending ? '처리 중…' : '예, 부여합니다'}
                </Button>
              </div>
            </div>
          ) : null}
          {autoError ? (
            <p role="alert" className="mt-2 rounded bg-red-50 px-3 py-2 text-sm text-red-700">
              {autoError}
            </p>
          ) : null}
          {autoResult ? (
            <p role="status" className="mt-2 rounded bg-green-50 px-3 py-2 text-sm text-green-800">
              {autoResult}
            </p>
          ) : null}
        </section>

        <section className="border-t border-slate-200 pt-4">
          <h3 className="mb-2 text-sm font-semibold">수동 부여 (정책 외 별도 지급)</h3>
          <FormErrorSummary errors={manErrors} />
          <div className="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
            <EmployeeLookup idBase="man-emp" label="사원" value={manEmployee} onChange={setManEmployee} />
            <Field label="휴가유형" htmlFor="man-type">
              <Input
                id="man-type"
                value={manForm.leaveType}
                onChange={(ev) => setManForm({ ...manForm, leaveType: ev.target.value })}
              />
            </Field>
            <Field label="일수" htmlFor="man-days" required hint="0.1 단위, 예: 1.5">
              <Input
                id="man-days"
                value={manForm.days}
                onChange={(ev) => setManForm({ ...manForm, days: ev.target.value })}
              />
            </Field>
            <Field label="부여일" htmlFor="man-grant" required>
              <Input
                id="man-grant"
                type="date"
                value={manForm.grantDate}
                onChange={(ev) => setManForm({ ...manForm, grantDate: ev.target.value })}
              />
            </Field>
            <Field label="유효기한" htmlFor="man-exp" required>
              <Input
                id="man-exp"
                type="date"
                value={manForm.expiresAt}
                onChange={(ev) => setManForm({ ...manForm, expiresAt: ev.target.value })}
              />
            </Field>
            <Field label="사유" htmlFor="man-reason" required className="lg:col-span-2">
              <Input
                id="man-reason"
                value={manForm.reason}
                onChange={(ev) => setManForm({ ...manForm, reason: ev.target.value })}
              />
            </Field>
          </div>
          <div className="mt-2 flex justify-end">
            {!manConfirm ? (
              <Button
                size="sm"
                onClick={() => {
                  const found = validateManual();
                  setManErrors(found);
                  if (found.length === 0) setManConfirm(true);
                }}
              >
                부여 내용 확인
              </Button>
            ) : null}
          </div>
          {manConfirm && manEmployee ? (
            <div className="mt-2 rounded-md border border-amber-300 bg-amber-50 p-3">
              <p className="text-sm text-amber-900">
                {manEmployee.name}({manEmployee.employeeNo}) 1명에게 {manForm.leaveType || 'ANNUAL'}{' '}
                {manForm.days}일을 부여합니다 (유효기한 {manForm.expiresAt}). 원장에 남는 되돌릴 수 없는
                작업입니다.
              </p>
              <div className="mt-2 flex justify-end gap-1.5">
                <Button size="sm" onClick={() => setManConfirm(false)}>
                  아니요
                </Button>
                <Button
                  size="sm"
                  variant="primary"
                  onClick={() => void runManualGrant()}
                  disabled={grantManual.isPending}
                >
                  {grantManual.isPending ? '처리 중…' : '예, 부여합니다'}
                </Button>
              </div>
            </div>
          ) : null}
          {manResult ? (
            <p role="status" className="mt-2 rounded bg-green-50 px-3 py-2 text-sm text-green-800">
              {manResult}
            </p>
          ) : null}
        </section>

        <section className="border-t border-slate-200 pt-4">
          <h3 className="mb-2 text-sm font-semibold">연차 소멸 처리</h3>
          <p className="mb-2 text-xs text-slate-500">
            유효기한이 지난 모든 연차 부여를 소멸(음수 원장) 처리합니다. 대상 인원·건수는 실행 전에는 알 수
            없으며, 실행 후 처리 건수가 표시됩니다. 이미 소멸 처리된 부여는 중복 처리되지 않습니다.
          </p>
          <div className="flex flex-wrap items-end gap-2">
            <Field label="기준일" htmlFor="exp-asof" className="w-40">
              <Input
                id="exp-asof"
                type="date"
                value={expireAsOf}
                onChange={(ev) => setExpireAsOf(ev.target.value)}
              />
            </Field>
            {!expireConfirm ? (
              <Button size="sm" onClick={() => setExpireConfirm(true)}>
                소멸 처리 실행
              </Button>
            ) : null}
          </div>
          {expireConfirm ? (
            <div className="mt-2 rounded-md border border-amber-300 bg-amber-50 p-3">
              <p className="text-sm text-amber-900">
                {expireAsOf} 기준으로 유효기한이 지난 전 사원의 연차 부여를 소멸 처리합니다. 되돌릴 수
                없습니다. 계속하시겠습니까?
              </p>
              <div className="mt-2 flex justify-end gap-1.5">
                <Button size="sm" onClick={() => setExpireConfirm(false)}>
                  아니요
                </Button>
                <Button
                  size="sm"
                  variant="danger"
                  onClick={() => void runExpire()}
                  disabled={expireGrants.isPending}
                >
                  {expireGrants.isPending ? '처리 중…' : '예, 소멸 처리합니다'}
                </Button>
              </div>
            </div>
          ) : null}
          {expireError ? (
            <p role="alert" className="mt-2 rounded bg-red-50 px-3 py-2 text-sm text-red-700">
              {expireError}
            </p>
          ) : null}
          {expireResult ? (
            <p role="status" className="mt-2 rounded bg-green-50 px-3 py-2 text-sm text-green-800">
              {expireResult}
            </p>
          ) : null}
        </section>
      </div>
    </Card>
  );
}

function LeaveRequestForm({ remaining, onDone }: { remaining: string; onDone: () => void }) {
  const request = api.hrm.requestLeave.useMutation();
  const [errors, setErrors] = useState<FieldError[]>([]);
  const [form, setForm] = useState({ startDate: '', endDate: '', halfDay: '', reason: '' });

  return (
    <Card title="휴가 신청">
      <form
        className="flex flex-col gap-3"
        onSubmit={async (e) => {
          e.preventDefault();
          const found: FieldError[] = [];
          if (!form.startDate)
            found.push({ field: 'lvf-start', label: '시작일', message: '시작일을 입력하세요.' });
          if (!form.endDate)
            found.push({ field: 'lvf-end', label: '종료일', message: '종료일을 입력하세요.' });
          setErrors(found);
          if (found.length) return;

          try {
            await request.mutateAsync({
              startDate: form.startDate,
              endDate: form.endDate,
              ...(form.halfDay ? { halfDay: form.halfDay as 'AM' | 'PM' } : {}),
              ...(form.reason ? { reason: form.reason } : {}),
              requestId: newRequestId(),
            });
            onDone();
          } catch (err) {
            setErrors([
              {
                field: 'lvf-start',
                label: '신청',
                message: (err as { message?: string }).message ?? '신청에 실패했습니다.',
              },
            ]);
          }
        }}
      >
        <FormErrorSummary errors={errors} />
        <p className="text-sm text-slate-600">
          신청 가능 잔여 <strong className="tabular">{remaining}</strong>일
        </p>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
          <Field label="시작일" htmlFor="lvf-start" required>
            <Input
              id="lvf-start"
              name="lvf-start"
              type="date"
              value={form.startDate}
              onChange={(e) =>
                setForm({ ...form, startDate: e.target.value, endDate: form.endDate || e.target.value })
              }
            />
          </Field>
          <Field label="종료일" htmlFor="lvf-end" required>
            <Input
              id="lvf-end"
              name="lvf-end"
              type="date"
              value={form.endDate}
              onChange={(e) => setForm({ ...form, endDate: e.target.value })}
            />
          </Field>
          <Field label="반차" htmlFor="lvf-half" hint="반차는 하루만 신청할 수 있습니다.">
            <Select
              id="lvf-half"
              value={form.halfDay}
              onChange={(e) => setForm({ ...form, halfDay: e.target.value })}
            >
              <option value="">종일</option>
              <option value="AM">오전 반차</option>
              <option value="PM">오후 반차</option>
            </Select>
          </Field>
          <Field label="사유" htmlFor="lvf-reason">
            <Input
              id="lvf-reason"
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
