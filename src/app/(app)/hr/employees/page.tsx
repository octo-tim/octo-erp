'use client';

import { useState } from 'react';
import { api, newRequestId } from '@/lib/trpc';
import { StandardListPage, useSavedFilters } from '@/components/ui/standard-list-page';
import { DataGrid, type Column } from '@/components/ui/data-grid';
import { Button, Card, Field, Input, Select, StatusBadge } from '@/components/ui/primitives';
import { FormErrorSummary, type FieldError } from '@/components/ui/form-error-summary';

/** HRM-01: employee list and registration. */
interface Row {
  id: string;
  employeeNo: string;
  name: string;
  hireDate: string;
  status: string;
  employmentType: string;
  jobTitle: string | null;
  department: { code: string; name: string } | null;
  user: { username: string; isActive: boolean } | null;
}

const STATUS_LABEL: Record<string, string> = { ACTIVE: '재직', ON_LEAVE: '휴직', RESIGNED: '퇴사' };
const TYPE_LABEL: Record<string, string> = {
  REGULAR: '정규직',
  CONTRACT: '계약직',
  PARTTIME: '단시간',
  INTERN: '인턴',
};

export default function EmployeeListPage() {
  const { filters, setFilters, save, reset } = useSavedFilters('hr.employees', {
    q: '',
    status: 'ACTIVE',
    departmentId: '',
  });
  const [applied, setApplied] = useState(filters);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [creating, setCreating] = useState(false);

  const departments = api.hrm.orgChart.useQuery({});
  const list = api.hrm.list.useQuery({
    page,
    pageSize,
    sortDir: 'asc',
    ...(applied.q ? { q: applied.q } : {}),
    ...(applied.status ? { status: applied.status } : {}),
    ...(applied.departmentId ? { departmentId: applied.departmentId } : {}),
  });

  const flatDepartments = (departments.data ?? []).flatMap(function flatten(n): {
    id: string;
    name: string;
  }[] {
    return [{ id: n.id, name: n.name }, ...n.children.flatMap(flatten)];
  });

  const columns: Column<Row>[] = [
    { key: 'employeeNo', header: '사번', width: 100 },
    { key: 'name', header: '성명', width: 110 },
    { key: 'department', header: '부서', render: (r) => r.department?.name ?? '-' },
    { key: 'jobTitle', header: '직위', width: 100, render: (r) => r.jobTitle ?? '-' },
    {
      key: 'employmentType',
      header: '고용형태',
      width: 100,
      render: (r) => TYPE_LABEL[r.employmentType] ?? r.employmentType,
    },
    { key: 'hireDate', header: '입사일', type: 'date', width: 110 },
    {
      key: 'status',
      header: '재직상태',
      width: 90,
      render: (r) => <StatusBadge status={r.status} label={STATUS_LABEL[r.status]} />,
    },
    {
      key: 'account',
      header: '계정',
      width: 120,
      render: (r) => (r.user ? `${r.user.username}${r.user.isActive ? '' : ' (비활성)'}` : '-'),
    },
  ];

  return (
    <StandardListPage
      title="사원"
      description="사원 기본정보와 소속·재직상태를 관리합니다. 민감정보는 별도 권한과 사유 입력이 필요합니다."
      filterKey="hr.employees"
      actions={
        <Button variant="primary" size="sm" onClick={() => setCreating((v) => !v)}>
          {creating ? '닫기' : '사원 등록'}
        </Button>
      }
      filters={
        <>
          <Field label="검색어" htmlFor="q" hint="사번 또는 성명">
            <Input id="q" value={filters.q} onChange={(e) => setFilters({ ...filters, q: e.target.value })} />
          </Field>
          <Field label="재직상태" htmlFor="status">
            <Select
              id="status"
              value={filters.status}
              onChange={(e) => setFilters({ ...filters, status: e.target.value })}
            >
              <option value="">전체</option>
              <option value="ACTIVE">재직</option>
              <option value="ON_LEAVE">휴직</option>
              <option value="RESIGNED">퇴사</option>
            </Select>
          </Field>
          <Field label="부서" htmlFor="dept">
            <Select
              id="dept"
              value={filters.departmentId}
              onChange={(e) => setFilters({ ...filters, departmentId: e.target.value })}
            >
              <option value="">전체</option>
              {flatDepartments.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </Select>
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
        setApplied({ q: '', status: 'ACTIVE', departmentId: '' });
        setPage(1);
      }}
    >
      {creating ? (
        <EmployeeForm
          departments={flatDepartments}
          onDone={() => {
            setCreating(false);
            void list.refetch();
          }}
        />
      ) : null}

      <DataGrid<Row>
        gridKey="hr.employees"
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
        onRowOpen={(r) => {
          window.location.href = `/hr/employees/${r.id}`;
        }}
        emptyTitle="조회된 사원이 없습니다."
        emptyDescription="재직상태를 '전체'로 바꾸거나 검색어를 지우고 다시 조회하세요."
      />
    </StandardListPage>
  );
}

function EmployeeForm({
  departments,
  onDone,
}: {
  departments: { id: string; name: string }[];
  onDone: () => void;
}) {
  const create = api.hrm.create.useMutation();
  const [errors, setErrors] = useState<FieldError[]>([]);
  const [form, setForm] = useState({
    name: '',
    hireDate: '',
    departmentId: '',
    jobTitle: '',
    employmentType: 'REGULAR' as 'REGULAR' | 'CONTRACT' | 'PARTTIME' | 'INTERN',
    phone: '',
    email: '',
  });

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const found: FieldError[] = [];
    if (!form.name.trim()) found.push({ field: 'emp-name', label: '성명', message: '성명을 입력하세요.' });
    if (!form.hireDate) found.push({ field: 'emp-hire', label: '입사일', message: '입사일을 입력하세요.' });
    setErrors(found);
    if (found.length) return;

    try {
      await create.mutateAsync({
        name: form.name.trim(),
        hireDate: form.hireDate,
        employmentType: form.employmentType,
        ...(form.departmentId ? { departmentId: form.departmentId } : {}),
        ...(form.jobTitle ? { jobTitle: form.jobTitle } : {}),
        ...(form.phone ? { phone: form.phone } : {}),
        ...(form.email ? { email: form.email } : {}),
        requestId: newRequestId(),
      });
      onDone();
    } catch (err) {
      setErrors([
        {
          field: 'emp-name',
          label: '저장',
          message: (err as { message?: string }).message ?? '저장에 실패했습니다.',
        },
      ]);
    }
  }

  return (
    <Card title="사원 등록">
      <form className="flex flex-col gap-3" onSubmit={submit}>
        <FormErrorSummary errors={errors} />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="성명" htmlFor="emp-name" required>
            <Input
              id="emp-name"
              name="emp-name"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          </Field>
          <Field label="입사일" htmlFor="emp-hire" required>
            <Input
              id="emp-hire"
              name="emp-hire"
              type="date"
              value={form.hireDate}
              onChange={(e) => setForm({ ...form, hireDate: e.target.value })}
            />
          </Field>
          <Field label="부서" htmlFor="emp-dept">
            <Select
              id="emp-dept"
              value={form.departmentId}
              onChange={(e) => setForm({ ...form, departmentId: e.target.value })}
            >
              <option value="">미지정</option>
              {departments.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="직위" htmlFor="emp-title">
            <Input
              id="emp-title"
              value={form.jobTitle}
              onChange={(e) => setForm({ ...form, jobTitle: e.target.value })}
            />
          </Field>
          <Field label="고용형태" htmlFor="emp-type">
            <Select
              id="emp-type"
              value={form.employmentType}
              onChange={(e) =>
                setForm({ ...form, employmentType: e.target.value as typeof form.employmentType })
              }
            >
              {Object.entries(TYPE_LABEL).map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="연락처" htmlFor="emp-phone">
            <Input
              id="emp-phone"
              value={form.phone}
              onChange={(e) => setForm({ ...form, phone: e.target.value })}
            />
          </Field>
          <Field label="이메일" htmlFor="emp-email">
            <Input
              id="emp-email"
              type="email"
              value={form.email}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
            />
          </Field>
        </div>
        <p className="text-xs text-slate-500">
          사번은 입사연도 기준으로 자동 채번됩니다. 주민번호·계좌번호는 등록 후 상세 화면에서 별도 권한으로
          입력합니다.
        </p>
        <div className="flex justify-end gap-1.5">
          <Button type="button" size="sm" onClick={onDone}>
            취소
          </Button>
          <Button type="submit" size="sm" variant="primary" disabled={create.isPending}>
            {create.isPending ? '저장 중…' : '저장'}
          </Button>
        </div>
      </form>
    </Card>
  );
}
