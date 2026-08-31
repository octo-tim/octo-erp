'use client';

// HRM-03 발령, HRM-02 조직, HRM-11 계정연동
import { useMemo, useState } from 'react';
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
import { fmt } from '@/lib/format';
import { businessDate } from '@/lib/dates';

const STATUS_LABEL: Record<string, string> = { ACTIVE: '재직', ON_LEAVE: '휴직', RESIGNED: '퇴사' };
const ASSIGNMENT_LABEL: Record<string, string> = {
  HIRE: '입사',
  PROMOTION: '승진',
  TRANSFER: '이동',
  LEAVE_OF_ABSENCE: '휴직',
  RETURN: '복직',
  RESIGN: '퇴사',
};
const EMPLOYMENT_TYPE_LABEL: Record<string, string> = {
  REGULAR: '정규직',
  CONTRACT: '계약직',
  PARTTIME: '단시간',
  INTERN: '인턴',
};
const CHANGE_LABEL: Record<string, string> = {
  CREATED: '신설',
  RENAMED: '명칭변경',
  MOVED: '소속이동',
  HEAD_CHANGED: '부서장변경',
  CLOSED: '폐지',
  REORG: '개편',
};

interface EmployeeRow {
  id: string;
  employeeNo: string;
  name: string;
  status: string;
  department: { code: string; name: string } | null;
  jobTitle: string | null;
}

interface DeptOption {
  id: string;
  name: string;
  depth: number;
}

interface OrgNode {
  id: string;
  name: string;
  children: OrgNode[];
}

function flattenDepartments(nodes: OrgNode[] | undefined, depth = 0): DeptOption[] {
  return (nodes ?? []).flatMap((n) => [
    { id: n.id, name: n.name, depth },
    ...flattenDepartments(n.children, depth + 1),
  ]);
}

export default function AssignmentsPage() {
  const utils = api.useUtils();
  const me = api.auth.me.useQuery();
  const canWrite = !!me.data?.isAdmin || !!me.data?.permissions.includes('hr.write');

  const [q, setQ] = useState('');
  const [employeeId, setEmployeeId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const employeeSearch = api.hrm.list.useQuery({
    page: 1,
    pageSize: 20,
    sortDir: 'asc',
    status: '',
    ...(q.trim() ? { q: q.trim() } : {}),
  });
  const rows = (employeeSearch.data?.rows ?? []) as unknown as EmployeeRow[];

  const detail = api.hrm.detail.useQuery({ id: employeeId ?? '' }, { enabled: !!employeeId });
  const history = api.hrm.assignmentHistory.useQuery(
    { employeeId: employeeId ?? '' },
    { enabled: !!employeeId },
  );
  const orgChart = api.hrm.orgChart.useQuery({});
  const departmentHistory = api.hrm.departmentHistory.useQuery({});

  const departmentOptions: DeptOption[] = useMemo(() => flattenDepartments(orgChart.data), [orgChart.data]);

  async function run(fn: () => Promise<unknown>, ok: string) {
    setError(null);
    setMessage(null);
    try {
      await fn();
      setMessage(ok);
    } catch (err) {
      setError((err as { message?: string }).message ?? '처리에 실패했습니다.');
    }
  }

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <header>
        <h1 className="text-lg font-semibold">발령 · 조직관리</h1>
        <p className="mt-0.5 text-sm text-slate-500">
          발령은 시행일 기준으로 이력에 쌓이며, 지난 발령은 절대 다시 쓰지 않습니다. 조직 개편도 같은 방식으로
          시점별 이력을 남깁니다.
        </p>
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

      <Card title="사원 선택">
        <div className="flex flex-wrap items-end gap-2">
          <Field label="검색어" htmlFor="as-q" hint="사번 또는 성명" className="w-64">
            <Input id="as-q" value={q} onChange={(e) => setQ(e.target.value)} />
          </Field>
        </div>
        <div className="mt-3 overflow-x-auto">
          {employeeSearch.isLoading ? (
            <Spinner />
          ) : rows.length === 0 ? (
            <EmptyState title="조회된 사원이 없습니다." />
          ) : (
            <table className="w-full min-w-max text-sm">
              <thead className="bg-slate-50">
                <tr>
                  <th scope="col" className="px-3 py-2 text-left font-semibold">
                    사번
                  </th>
                  <th scope="col" className="px-3 py-2 text-left font-semibold">
                    성명
                  </th>
                  <th scope="col" className="px-3 py-2 text-left font-semibold">
                    부서
                  </th>
                  <th scope="col" className="px-3 py-2 text-left font-semibold">
                    직위
                  </th>
                  <th scope="col" className="px-3 py-2 text-left font-semibold">
                    재직상태
                  </th>
                  <th scope="col" className="px-3 py-2 text-left font-semibold">
                    선택
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr
                    key={r.id}
                    className={
                      'border-b border-slate-100 last:border-0' + (r.id === employeeId ? ' bg-blue-50' : '')
                    }
                  >
                    <td className="px-3 py-1.5">{r.employeeNo}</td>
                    <td className="px-3 py-1.5">{r.name}</td>
                    <td className="px-3 py-1.5">{r.department?.name ?? '-'}</td>
                    <td className="px-3 py-1.5">{r.jobTitle ?? '-'}</td>
                    <td className="px-3 py-1.5">
                      <StatusBadge status={r.status} label={STATUS_LABEL[r.status] ?? r.status} />
                    </td>
                    <td className="px-3 py-1.5">
                      <Button size="sm" variant="ghost" onClick={() => setEmployeeId(r.id)}>
                        선택
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </Card>

      {employeeId && detail.data ? (
        <EmployeePanel
          employee={detail.data}
          canWrite={canWrite}
          departmentOptions={departmentOptions}
          history={history.data ?? []}
          historyLoading={history.isLoading}
          run={run}
          onChanged={() => {
            void detail.refetch();
            void history.refetch();
            void utils.hrm.invalidate();
          }}
        />
      ) : employeeId && detail.isLoading ? (
        <Spinner />
      ) : null}

      {canWrite ? (
        <OrganizationPanel
          departmentOptions={departmentOptions}
          departmentHistory={departmentHistory.data ?? []}
          historyLoading={departmentHistory.isLoading}
          selectedEmployeeId={employeeId}
          run={run}
          onChanged={() => {
            void orgChart.refetch();
            void departmentHistory.refetch();
          }}
        />
      ) : null}
    </div>
  );
}

interface EmployeeDetail {
  id: string;
  name: string;
  employeeNo: string;
  status: string;
  hireDate: unknown;
  leaveDate: unknown;
  department: { name: string } | null;
  jobTitle: string | null;
  employmentType: string;
  user: { username: string; isActive: boolean } | null;
}

interface AssignmentRow {
  id: string;
  type: string;
  effectiveFrom: unknown;
  effectiveTo: unknown;
  department: { name: string } | null;
  jobTitle: string | null;
  note: string | null;
}

function EmployeePanel({
  employee,
  canWrite,
  departmentOptions,
  history,
  historyLoading,
  run,
  onChanged,
}: {
  employee: EmployeeDetail;
  canWrite: boolean;
  departmentOptions: DeptOption[];
  history: AssignmentRow[];
  historyLoading: boolean;
  run: (fn: () => Promise<unknown>, ok: string) => Promise<void>;
  onChanged: () => void;
}) {
  const assign = api.hrm.assign.useMutation();
  const resign = api.hrm.resign.useMutation();
  const positionAtQuery = api.hrm.positionAt;

  const [assignForm, setAssignForm] = useState({
    type: 'TRANSFER' as 'HIRE' | 'PROMOTION' | 'TRANSFER' | 'LEAVE_OF_ABSENCE' | 'RETURN' | 'RESIGN',
    effectiveFrom: businessDate(),
    departmentId: '',
    positionCode: '',
    jobTitle: '',
    employmentType: '',
    note: '',
  });
  const [asOf, setAsOf] = useState(businessDate());
  const positionAt = positionAtQuery.useQuery({ employeeId: employee.id, asOf });

  const [resignDate, setResignDate] = useState(businessDate());
  const [resignReason, setResignReason] = useState('');
  const [resignConfirmed, setResignConfirmed] = useState(false);

  const isResigned = employee.status === 'RESIGNED';

  return (
    <>
      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="현재 정보" className="lg:col-span-1">
          <dl className="grid grid-cols-[6rem_1fr] gap-y-2 text-sm">
            <dt className="text-slate-500">사원</dt>
            <dd>
              {employee.name} ({employee.employeeNo})
            </dd>
            <dt className="text-slate-500">재직상태</dt>
            <dd>
              <StatusBadge status={employee.status} label={STATUS_LABEL[employee.status]} />
            </dd>
            <dt className="text-slate-500">부서</dt>
            <dd>{employee.department?.name ?? '-'}</dd>
            <dt className="text-slate-500">직위</dt>
            <dd>{employee.jobTitle ?? '-'}</dd>
            <dt className="text-slate-500">고용형태</dt>
            <dd>{EMPLOYMENT_TYPE_LABEL[employee.employmentType] ?? employee.employmentType}</dd>
          </dl>
        </Card>

        <Card title="연동 계정 (HRM-11)" className="lg:col-span-1">
          <p className="text-xs text-slate-500">
            로그인 계정과 사원 상태는 항상 함께 갑니다. 퇴사 처리를 하면 연동된 계정이 같은 트랜잭션에서
            자동으로 비활성화되어, 퇴사자는 세션을 유지할 수 없습니다.
          </p>
          <dl className="mt-3 grid grid-cols-[6rem_1fr] gap-y-2 text-sm">
            <dt className="text-slate-500">계정</dt>
            <dd>{employee.user?.username ?? '연결된 계정 없음'}</dd>
            <dt className="text-slate-500">계정상태</dt>
            <dd>
              {employee.user ? (
                <StatusBadge
                  status={employee.user.isActive ? 'CONFIRMED' : 'CANCELED'}
                  label={employee.user.isActive ? '사용' : '비활성'}
                />
              ) : (
                '-'
              )}
            </dd>
          </dl>
        </Card>

        <Card title="시점 조회 (positionAt)" className="lg:col-span-1">
          <Field label="기준일" htmlFor="pos-asof" required>
            <Input id="pos-asof" type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} />
          </Field>
          <div className="mt-3 text-sm">
            {positionAt.isLoading ? (
              <Spinner />
            ) : positionAt.data ? (
              <dl className="grid grid-cols-[6rem_1fr] gap-y-1">
                <dt className="text-slate-500">유형</dt>
                <dd>{ASSIGNMENT_LABEL[positionAt.data.type] ?? positionAt.data.type}</dd>
                <dt className="text-slate-500">부서</dt>
                <dd>{positionAt.data.departmentName ?? '-'}</dd>
                <dt className="text-slate-500">직위</dt>
                <dd>{positionAt.data.jobTitle ?? '-'}</dd>
                <dt className="text-slate-500">기간</dt>
                <dd>
                  {positionAt.data.effectiveFrom} ~ {positionAt.data.effectiveTo ?? '현재'}
                </dd>
              </dl>
            ) : (
              <p className="text-slate-500">해당 기준일에 유효한 발령이 없습니다.</p>
            )}
          </div>
        </Card>
      </div>

      {canWrite ? (
        <Card title="발령 등록 (assign)">
          <p className="mb-3 rounded bg-amber-50 px-3 py-2 text-xs text-amber-900">
            시행일(effectiveFrom)은 이 발령이 효력을 갖는 날짜이며 필수입니다. 등록하면 이전 발령은 시행일
            전날로 종료되고, 과거 이력 자체는 수정되지 않습니다.
          </p>
          <form
            className="grid grid-cols-1 gap-3 sm:grid-cols-3 lg:grid-cols-6"
            onSubmit={async (e) => {
              e.preventDefault();
              await run(async () => {
                await assign.mutateAsync({
                  employeeId: employee.id,
                  type: assignForm.type,
                  effectiveFrom: assignForm.effectiveFrom,
                  ...(assignForm.departmentId ? { departmentId: assignForm.departmentId } : {}),
                  ...(assignForm.positionCode ? { positionCode: assignForm.positionCode } : {}),
                  ...(assignForm.jobTitle ? { jobTitle: assignForm.jobTitle } : {}),
                  ...(assignForm.employmentType ? { employmentType: assignForm.employmentType } : {}),
                  ...(assignForm.note ? { note: assignForm.note } : {}),
                  requestId: newRequestId(),
                });
                setAssignForm((f) => ({ ...f, positionCode: '', note: '' }));
                onChanged();
              }, '발령이 등록되었습니다.');
            }}
          >
            <Field label="시행일" htmlFor="asg-from" required className="sm:col-span-1">
              <Input
                id="asg-from"
                type="date"
                value={assignForm.effectiveFrom}
                onChange={(e) => setAssignForm({ ...assignForm, effectiveFrom: e.target.value })}
              />
            </Field>
            <Field label="발령유형" htmlFor="asg-type" required className="sm:col-span-1">
              <Select
                id="asg-type"
                value={assignForm.type}
                onChange={(e) =>
                  setAssignForm({ ...assignForm, type: e.target.value as typeof assignForm.type })
                }
              >
                {(Object.keys(ASSIGNMENT_LABEL) as (keyof typeof ASSIGNMENT_LABEL)[])
                  .filter((t) => t !== 'RESIGN')
                  .map((t) => (
                    <option key={t} value={t}>
                      {ASSIGNMENT_LABEL[t]}
                    </option>
                  ))}
              </Select>
            </Field>
            <Field label="이동 부서" htmlFor="asg-dept" className="sm:col-span-1">
              <Select
                id="asg-dept"
                value={assignForm.departmentId}
                onChange={(e) => setAssignForm({ ...assignForm, departmentId: e.target.value })}
              >
                <option value="">변경 안함</option>
                {departmentOptions.map((d) => (
                  <option key={d.id} value={d.id}>
                    {'　'.repeat(d.depth)}
                    {d.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="직위코드" htmlFor="asg-poscode" className="sm:col-span-1">
              <Input
                id="asg-poscode"
                value={assignForm.positionCode}
                onChange={(e) => setAssignForm({ ...assignForm, positionCode: e.target.value })}
              />
            </Field>
            <Field label="직책" htmlFor="asg-title" className="sm:col-span-1">
              <Input
                id="asg-title"
                value={assignForm.jobTitle}
                onChange={(e) => setAssignForm({ ...assignForm, jobTitle: e.target.value })}
              />
            </Field>
            <Field label="고용형태" htmlFor="asg-emptype" className="sm:col-span-1">
              <Select
                id="asg-emptype"
                value={assignForm.employmentType}
                onChange={(e) => setAssignForm({ ...assignForm, employmentType: e.target.value })}
              >
                <option value="">변경 안함</option>
                {Object.entries(EMPLOYMENT_TYPE_LABEL).map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="비고" htmlFor="asg-note" className="sm:col-span-2 lg:col-span-3">
              <Input
                id="asg-note"
                value={assignForm.note}
                onChange={(e) => setAssignForm({ ...assignForm, note: e.target.value })}
              />
            </Field>
            <div className="flex items-end sm:col-span-1">
              <Button
                type="submit"
                size="sm"
                variant="primary"
                disabled={isResigned || !assignForm.effectiveFrom || assign.isPending}
              >
                발령 등록
              </Button>
            </div>
          </form>
          {isResigned ? (
            <p className="mt-2 text-xs text-slate-500">퇴사한 사원에게는 발령을 등록할 수 없습니다.</p>
          ) : null}
        </Card>
      ) : null}

      <Card title="발령 이력">
        {historyLoading ? (
          <Spinner />
        ) : history.length === 0 ? (
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
                {history.map((a) => (
                  <tr key={a.id} className="border-b border-slate-100 last:border-0">
                    <td className="px-3 py-1.5">{ASSIGNMENT_LABEL[a.type] ?? a.type}</td>
                    <td className="px-3 py-1.5">{fmt.date(a.effectiveFrom as unknown as string)}</td>
                    <td className="px-3 py-1.5">
                      {a.effectiveTo ? fmt.date(a.effectiveTo as unknown as string) : '현재'}
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

      {canWrite && !isResigned ? (
        <Card title="퇴사 처리 (resign)">
          <p className="mb-3 text-xs text-slate-500">
            퇴사 처리는 되돌릴 수 없는 발령입니다. 처리 즉시 연동 계정이 비활성화되고, 열려 있던 발령 기간이
            퇴사일로 종료됩니다.
          </p>
          <form
            className="grid grid-cols-1 gap-3 sm:grid-cols-4"
            onSubmit={async (e) => {
              e.preventDefault();
              if (!resignConfirmed) return;
              await run(async () => {
                await resign.mutateAsync({
                  employeeId: employee.id,
                  leaveDate: resignDate,
                  ...(resignReason ? { reason: resignReason } : {}),
                  requestId: newRequestId(),
                });
                setResignConfirmed(false);
                setResignReason('');
                onChanged();
              }, '퇴사 처리되었습니다. 연동 계정이 비활성화되었습니다.');
            }}
          >
            <Field label="퇴사일" htmlFor="rsg-date" required>
              <Input
                id="rsg-date"
                type="date"
                value={resignDate}
                onChange={(e) => setResignDate(e.target.value)}
              />
            </Field>
            <Field label="사유" htmlFor="rsg-reason" className="sm:col-span-2">
              <Input id="rsg-reason" value={resignReason} onChange={(e) => setResignReason(e.target.value)} />
            </Field>
            <div className="flex flex-col justify-end gap-2">
              <label className="flex items-center gap-1.5 text-xs text-slate-600">
                <input
                  type="checkbox"
                  checked={resignConfirmed}
                  onChange={(e) => setResignConfirmed(e.target.checked)}
                />
                퇴사 처리를 확인합니다
              </label>
              <Button
                type="submit"
                size="sm"
                variant="danger"
                disabled={!resignConfirmed || !resignDate || resign.isPending}
              >
                퇴사 처리
              </Button>
            </div>
          </form>
        </Card>
      ) : null}
    </>
  );
}

interface DepartmentHistoryRow {
  id: string;
  effectiveDate: unknown;
  changeType: string;
  department: { name: string } | null;
}

function OrganizationPanel({
  departmentOptions,
  departmentHistory,
  historyLoading,
  selectedEmployeeId,
  run,
  onChanged,
}: {
  departmentOptions: DeptOption[];
  departmentHistory: DepartmentHistoryRow[];
  historyLoading: boolean;
  selectedEmployeeId: string | null;
  run: (fn: () => Promise<unknown>, ok: string) => Promise<void>;
  onChanged: () => void;
}) {
  const createDepartment = api.hrm.createDepartment.useMutation();
  const reorganize = api.hrm.reorganize.useMutation();

  const [deptForm, setDeptForm] = useState({
    code: '',
    name: '',
    parentId: '',
    validFrom: businessDate(),
    sortOrder: '',
    headFromSelected: false,
  });

  const [reorgForm, setReorgForm] = useState({
    departmentId: '',
    effectiveDate: businessDate(),
    name: '',
    parentId: '',
    parentToRoot: false,
    headFromSelected: false,
    close: false,
  });

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card title="부서 신설 (createDepartment)">
        <form
          className="grid grid-cols-1 gap-3 sm:grid-cols-2"
          onSubmit={async (e) => {
            e.preventDefault();
            await run(async () => {
              await createDepartment.mutateAsync({
                code: deptForm.code.trim().toUpperCase(),
                name: deptForm.name.trim(),
                validFrom: deptForm.validFrom,
                ...(deptForm.parentId ? { parentId: deptForm.parentId } : {}),
                ...(deptForm.headFromSelected && selectedEmployeeId
                  ? { headEmployeeId: selectedEmployeeId }
                  : {}),
                ...(deptForm.sortOrder ? { sortOrder: Number(deptForm.sortOrder) } : {}),
                requestId: newRequestId(),
              });
              setDeptForm({
                code: '',
                name: '',
                parentId: '',
                validFrom: businessDate(),
                sortOrder: '',
                headFromSelected: false,
              });
              onChanged();
            }, '부서가 신설되었습니다.');
          }}
        >
          <Field label="부서코드" htmlFor="dp-code" required>
            <Input
              id="dp-code"
              value={deptForm.code}
              onChange={(e) => setDeptForm({ ...deptForm, code: e.target.value.toUpperCase() })}
            />
          </Field>
          <Field label="부서명" htmlFor="dp-name" required>
            <Input
              id="dp-name"
              value={deptForm.name}
              onChange={(e) => setDeptForm({ ...deptForm, name: e.target.value })}
            />
          </Field>
          <Field label="상위부서" htmlFor="dp-parent">
            <Select
              id="dp-parent"
              value={deptForm.parentId}
              onChange={(e) => setDeptForm({ ...deptForm, parentId: e.target.value })}
            >
              <option value="">최상위</option>
              {departmentOptions.map((d) => (
                <option key={d.id} value={d.id}>
                  {'　'.repeat(d.depth)}
                  {d.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="유효 시작일" htmlFor="dp-validfrom" required>
            <Input
              id="dp-validfrom"
              type="date"
              value={deptForm.validFrom}
              onChange={(e) => setDeptForm({ ...deptForm, validFrom: e.target.value })}
            />
          </Field>
          <Field label="정렬순서" htmlFor="dp-sort" hint="숫자, 선택 입력">
            <Input
              id="dp-sort"
              inputMode="numeric"
              value={deptForm.sortOrder}
              onChange={(e) => setDeptForm({ ...deptForm, sortOrder: e.target.value.replace(/\D/g, '') })}
            />
          </Field>
          <div className="flex items-end">
            <label className="flex items-center gap-1.5 text-xs text-slate-600">
              <input
                type="checkbox"
                checked={deptForm.headFromSelected}
                disabled={!selectedEmployeeId}
                onChange={(e) => setDeptForm({ ...deptForm, headFromSelected: e.target.checked })}
              />
              선택된 사원을 부서장으로 지정
            </label>
          </div>
          <div className="sm:col-span-2 flex justify-end">
            <Button
              type="submit"
              size="sm"
              variant="primary"
              disabled={!deptForm.code.trim() || !deptForm.name.trim() || createDepartment.isPending}
            >
              부서 신설
            </Button>
          </div>
        </form>
      </Card>

      <Card title="조직 개편 (reorganize)">
        <form
          className="grid grid-cols-1 gap-3 sm:grid-cols-2"
          onSubmit={async (e) => {
            e.preventDefault();
            await run(
              async () => {
                await reorganize.mutateAsync({
                  departmentId: reorgForm.departmentId,
                  effectiveDate: reorgForm.effectiveDate,
                  ...(reorgForm.close
                    ? { close: true }
                    : {
                        ...(reorgForm.name.trim() ? { name: reorgForm.name.trim() } : {}),
                        ...(reorgForm.parentToRoot
                          ? { parentId: null }
                          : reorgForm.parentId
                            ? { parentId: reorgForm.parentId }
                            : {}),
                        ...(reorgForm.headFromSelected && selectedEmployeeId
                          ? { headEmployeeId: selectedEmployeeId }
                          : {}),
                      }),
                  requestId: newRequestId(),
                });
                setReorgForm({
                  departmentId: '',
                  effectiveDate: businessDate(),
                  name: '',
                  parentId: '',
                  parentToRoot: false,
                  headFromSelected: false,
                  close: false,
                });
                onChanged();
              },
              reorgForm.close ? '부서가 폐지되었습니다.' : '조직 개편이 반영되었습니다.',
            );
          }}
        >
          <Field label="대상 부서" htmlFor="rg-dept" required className="sm:col-span-2">
            <Select
              id="rg-dept"
              value={reorgForm.departmentId}
              onChange={(e) => setReorgForm({ ...reorgForm, departmentId: e.target.value })}
            >
              <option value="">선택하세요</option>
              {departmentOptions.map((d) => (
                <option key={d.id} value={d.id}>
                  {'　'.repeat(d.depth)}
                  {d.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="시행일" htmlFor="rg-effdate" required>
            <Input
              id="rg-effdate"
              type="date"
              value={reorgForm.effectiveDate}
              onChange={(e) => setReorgForm({ ...reorgForm, effectiveDate: e.target.value })}
            />
          </Field>
          <div className="flex items-end">
            <label className="flex items-center gap-1.5 text-xs text-slate-600">
              <input
                type="checkbox"
                checked={reorgForm.close}
                onChange={(e) => setReorgForm({ ...reorgForm, close: e.target.checked })}
              />
              이 부서를 폐지합니다 (소속 인원 0명일 때만 가능)
            </label>
          </div>
          {!reorgForm.close ? (
            <>
              <Field label="새 부서명" htmlFor="rg-name" hint="비우면 변경 안함">
                <Input
                  id="rg-name"
                  value={reorgForm.name}
                  onChange={(e) => setReorgForm({ ...reorgForm, name: e.target.value })}
                />
              </Field>
              <Field label="새 상위부서" htmlFor="rg-parent" hint="비우면 변경 안함">
                <Select
                  id="rg-parent"
                  value={reorgForm.parentToRoot ? '__ROOT__' : reorgForm.parentId}
                  onChange={(e) => {
                    const v = e.target.value;
                    setReorgForm({
                      ...reorgForm,
                      parentToRoot: v === '__ROOT__',
                      parentId: v === '__ROOT__' ? '' : v,
                    });
                  }}
                >
                  <option value="">변경 안함</option>
                  <option value="__ROOT__">최상위로 이동</option>
                  {departmentOptions.map((d) => (
                    <option key={d.id} value={d.id}>
                      {'　'.repeat(d.depth)}
                      {d.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <div className="flex items-end">
                <label className="flex items-center gap-1.5 text-xs text-slate-600">
                  <input
                    type="checkbox"
                    checked={reorgForm.headFromSelected}
                    disabled={!selectedEmployeeId}
                    onChange={(e) => setReorgForm({ ...reorgForm, headFromSelected: e.target.checked })}
                  />
                  선택된 사원을 부서장으로 지정
                </label>
              </div>
            </>
          ) : null}
          <div className="sm:col-span-2 flex justify-end">
            <Button
              type="submit"
              size="sm"
              variant={reorgForm.close ? 'danger' : 'primary'}
              disabled={!reorgForm.departmentId || !reorgForm.effectiveDate || reorganize.isPending}
            >
              {reorgForm.close ? '부서 폐지' : '개편 반영'}
            </Button>
          </div>
        </form>
      </Card>

      <Card title="최근 개편 이력" className="lg:col-span-2">
        {historyLoading ? (
          <Spinner />
        ) : departmentHistory.length === 0 ? (
          <EmptyState title="개편 이력이 없습니다." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-max text-sm">
              <thead className="bg-slate-50">
                <tr>
                  <th scope="col" className="px-3 py-2 text-left font-semibold">
                    시행일
                  </th>
                  <th scope="col" className="px-3 py-2 text-left font-semibold">
                    부서
                  </th>
                  <th scope="col" className="px-3 py-2 text-left font-semibold">
                    변경유형
                  </th>
                </tr>
              </thead>
              <tbody>
                {departmentHistory.slice(0, 10).map((h) => (
                  <tr key={h.id} className="border-b border-slate-100 last:border-0">
                    <td className="px-3 py-1.5">{fmt.date(h.effectiveDate as unknown as string)}</td>
                    <td className="px-3 py-1.5">{h.department?.name ?? '-'}</td>
                    <td className="px-3 py-1.5">{CHANGE_LABEL[h.changeType] ?? h.changeType}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
