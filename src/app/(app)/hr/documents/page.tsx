'use client';

// HRM-08 인사서류
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
import { AttachmentPanel } from '@/components/ui/attachment-panel';
import { fmt } from '@/lib/format';
import { businessDate, daysBetween } from '@/lib/dates';

const STATUS_LABEL: Record<string, string> = { ACTIVE: '재직', ON_LEAVE: '휴직', RESIGNED: '퇴사' };
const EMPLOYMENT_TYPE_LABEL: Record<string, string> = {
  REGULAR: '정규직',
  CONTRACT: '계약직',
  PARTTIME: '단시간',
  INTERN: '인턴',
};
const EXPIRY_WINDOW_DAYS = 30;

interface EmployeeRow {
  id: string;
  employeeNo: string;
  name: string;
  status: string;
  employmentType: string;
  contractEndDate: string | null;
  department: { code: string; name: string } | null;
}

export default function HrDocumentsPage() {
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

  // Contract expiry is a per-employee field (Employee.contractEndDate); there is no dedicated
  // "expiring soon" query, so this list is computed client-side from the first page of active
  // employees. hrm.list caps pageSize at 200 — with more employees than that, this reminder
  // view would need a server-side query, which was not added (none exists to call).
  const allActive = api.hrm.list.useQuery({ page: 1, pageSize: 200, sortDir: 'asc', status: 'ACTIVE' });
  const today = businessDate();
  const expiring = useMemo(() => {
    const list = (allActive.data?.rows ?? []) as unknown as EmployeeRow[];
    return list
      .filter((e) => !!e.contractEndDate)
      .map((e) => ({ ...e, daysLeft: daysBetween(today, e.contractEndDate as string) }))
      .filter((e) => e.daysLeft <= EXPIRY_WINDOW_DAYS)
      .sort((a, b) => a.daysLeft - b.daysLeft);
  }, [allActive.data, today]);

  const detail = api.hrm.detail.useQuery({ id: employeeId ?? '' }, { enabled: !!employeeId });

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <header>
        <h1 className="text-lg font-semibold">인사서류</h1>
        <p className="mt-0.5 text-sm text-slate-500">
          사원별 서류를 첨부·열람합니다. 첨부는 서버에서 권한(hr.read/hr.write)과 본인 여부를 다시 확인하므로,
          화면에서 숨겨도 서버 접근권한 없이는 열람할 수 없습니다.
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

      <Card
        title={`계약만료 임박 (${EXPIRY_WINDOW_DAYS}일 이내, ${expiring.length}명)`}
        actions={
          <span className="text-xs text-slate-500">계약만료 알림 작업이 이 날짜를 기준으로 발송합니다.</span>
        }
      >
        {allActive.isLoading ? (
          <Spinner />
        ) : expiring.length === 0 ? (
          <EmptyState title="30일 이내 계약만료 예정인 계약직 사원이 없습니다." />
        ) : (
          <div className="overflow-x-auto">
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
                    계약종료일
                  </th>
                  <th scope="col" className="px-3 py-2 text-left font-semibold">
                    잔여일
                  </th>
                  <th scope="col" className="px-3 py-2 text-left font-semibold">
                    서류 보기
                  </th>
                </tr>
              </thead>
              <tbody>
                {expiring.map((e) => (
                  <tr key={e.id} className="border-b border-slate-100 last:border-0">
                    <td className="px-3 py-1.5">{e.employeeNo}</td>
                    <td className="px-3 py-1.5">{e.name}</td>
                    <td className="px-3 py-1.5">{e.department?.name ?? '-'}</td>
                    <td className="px-3 py-1.5">{fmt.date(e.contractEndDate)}</td>
                    <td className="px-3 py-1.5">
                      {e.daysLeft < 0 ? (
                        <StatusBadge status="CANCELED" label={`${-e.daysLeft}일 경과`} />
                      ) : (
                        <StatusBadge status="PENDING_APPROVAL" label={`D-${e.daysLeft}`} />
                      )}
                    </td>
                    <td className="px-3 py-1.5">
                      <Button size="sm" variant="ghost" onClick={() => setEmployeeId(e.id)}>
                        서류 보기
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card title="사원 선택">
        <Field label="검색어" htmlFor="doc-q" hint="사번 또는 성명" className="w-64">
          <Input id="doc-q" value={q} onChange={(e) => setQ(e.target.value)} />
        </Field>
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
        <ContractPanel
          employee={detail.data}
          canWrite={canWrite}
          onDone={(msg) => {
            setMessage(msg);
            setError(null);
            void detail.refetch();
            void allActive.refetch();
          }}
          onError={(msg) => {
            setError(msg);
            setMessage(null);
          }}
        />
      ) : employeeId && detail.isLoading ? (
        <Spinner />
      ) : null}

      {employeeId ? (
        <AttachmentPanel ownerType="EMPLOYEE_DOC" ownerId={employeeId} readOnly={!canWrite} />
      ) : (
        <EmptyState title="첨부서류를 보려면 위에서 사원을 선택하세요." />
      )}
    </div>
  );
}

interface EmployeeDetail {
  id: string;
  name: string;
  employeeNo: string;
  version: number;
  employmentType: string;
  contractEndDate: unknown;
  department: { name: string } | null;
}

function ContractPanel({
  employee,
  canWrite,
  onDone,
  onError,
}: {
  employee: EmployeeDetail;
  canWrite: boolean;
  onDone: (msg: string) => void;
  onError: (msg: string) => void;
}) {
  const update = api.hrm.update.useMutation();
  const currentEndDate = employee.contractEndDate
    ? fmt.date(employee.contractEndDate as unknown as string)
    : '';
  const [form, setForm] = useState({
    employmentType: employee.employmentType,
    contractEndDate: currentEndDate,
  });

  return (
    <Card title="계약 정보">
      <dl className="mb-3 grid grid-cols-[8rem_1fr] gap-y-2 text-sm">
        <dt className="text-slate-500">사원</dt>
        <dd>
          {employee.name} ({employee.employeeNo})
        </dd>
        <dt className="text-slate-500">고용형태</dt>
        <dd>{EMPLOYMENT_TYPE_LABEL[employee.employmentType] ?? employee.employmentType}</dd>
        <dt className="text-slate-500">계약종료일</dt>
        <dd>{currentEndDate || '미등록 (정규직 등 기간의 정함이 없는 경우 비워둡니다)'}</dd>
      </dl>

      {canWrite ? (
        <form
          className="grid grid-cols-1 gap-3 sm:grid-cols-3"
          onSubmit={async (e) => {
            e.preventDefault();
            try {
              await update.mutateAsync({
                id: employee.id,
                version: employee.version,
                employmentType: form.employmentType as 'REGULAR' | 'CONTRACT' | 'PARTTIME' | 'INTERN',
                ...(form.contractEndDate ? { contractEndDate: form.contractEndDate } : {}),
                requestId: newRequestId(),
              });
              onDone('계약 정보가 저장되었습니다. 계약만료 알림이 새로 예약되었습니다.');
            } catch (err) {
              onError((err as { message?: string }).message ?? '저장에 실패했습니다.');
            }
          }}
        >
          <Field label="고용형태" htmlFor="ct-type">
            <Select
              id="ct-type"
              value={form.employmentType}
              onChange={(e) => setForm({ ...form, employmentType: e.target.value })}
            >
              {Object.entries(EMPLOYMENT_TYPE_LABEL).map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </Select>
          </Field>
          <Field
            label="계약종료일"
            htmlFor="ct-end"
            hint="계약직 만료 알림(30일 전 리마인더)의 기준 날짜입니다."
          >
            <Input
              id="ct-end"
              type="date"
              value={form.contractEndDate}
              onChange={(e) => setForm({ ...form, contractEndDate: e.target.value })}
            />
          </Field>
          <div className="flex items-end">
            <Button type="submit" size="sm" variant="primary" disabled={update.isPending}>
              계약 정보 저장
            </Button>
          </div>
        </form>
      ) : null}
    </Card>
  );
}
