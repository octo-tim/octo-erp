'use client';

import { useState } from 'react';
import { api, newRequestId } from '@/lib/trpc';
import { StandardListPage, useSavedFilters } from '@/components/ui/standard-list-page';
import { DataGrid, type Column } from '@/components/ui/data-grid';
import { Button, Card, Field, Input, Select, StatusBadge } from '@/components/ui/primitives';
import { FormErrorSummary, type FieldError } from '@/components/ui/form-error-summary';
import { businessDate } from '@/lib/dates';

/** HRM-05 / HRM-06: leave requests and annual balance. */
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
  ];

  return (
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
