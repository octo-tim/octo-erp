'use client';

// HRM-09 증명서
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
import { fmt } from '@/lib/format';

const STATUS_LABEL: Record<string, string> = { ACTIVE: '재직', ON_LEAVE: '휴직', RESIGNED: '퇴사' };
const CERT_TYPE_LABEL: Record<string, string> = { EMPLOYMENT: '재직증명서', CAREER: '경력증명서' };

interface EmployeeRow {
  id: string;
  employeeNo: string;
  name: string;
  status: string;
  department: { code: string; name: string } | null;
}

interface CertificateDocument {
  issueNo: string;
  certType: 'EMPLOYMENT' | 'CAREER';
  employeeNo: string;
  name: string;
  department: string;
  jobTitle: string;
  hireDate: string;
  leaveDate: string | null;
  purpose: string;
  issuedAt: string;
}

export default function CertificatesPage() {
  const [q, setQ] = useState('');
  const [employeeId, setEmployeeId] = useState<string | null>(null);
  const [certType, setCertType] = useState<'EMPLOYMENT' | 'CAREER'>('EMPLOYMENT');
  const [purpose, setPurpose] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [printing, setPrinting] = useState<CertificateDocument | null>(null);

  // Defaults to the caller's own employee record until they explicitly pick someone else
  // (scope permitting) — no effect needed, this is a plain derived value.
  const myEmployee = api.hrm.me.useQuery(undefined, { retry: false });
  const activeEmployeeId = employeeId ?? myEmployee.data?.id ?? null;

  const employeeSearch = api.hrm.list.useQuery({
    page: 1,
    pageSize: 20,
    sortDir: 'asc',
    status: '',
    ...(q.trim() ? { q: q.trim() } : {}),
  });
  const rows = (employeeSearch.data?.rows ?? []) as unknown as EmployeeRow[];

  const detail = api.hrm.detail.useQuery({ id: activeEmployeeId ?? '' }, { enabled: !!activeEmployeeId });
  const issue = api.hrm.issueCertificate.useMutation();

  // HRM-09: real persisted history for the selected employee, not a session-only list —
  // it survives refresh and reflects every issuance, including ones from other sessions.
  const history = api.hrm.certificateHistory.useQuery(
    { employeeId: activeEmployeeId ?? undefined, take: 50 },
    { enabled: !!activeEmployeeId },
  );

  async function doIssue() {
    if (!activeEmployeeId) return;
    setError(null);
    try {
      const res = await issue.mutateAsync({
        employeeId: activeEmployeeId,
        certType,
        ...(purpose.trim() ? { purpose: purpose.trim() } : {}),
        requestId: newRequestId(),
      });
      setPrinting(res.document as CertificateDocument);
      await history.refetch();
    } catch (err) {
      setError((err as { message?: string }).message ?? '발급에 실패했습니다.');
    }
  }

  // History rows only carry issueNo/certType/purpose/createdAt — the employee's current
  // department·직위·입사일 (from the already-loaded detail) fill in the rest for reprinting.
  function toDocument(row: {
    issueNo: string;
    certType: string;
    purpose: string | null;
    createdAt: Date | string;
  }): CertificateDocument | null {
    if (!detail.data) return null;
    return {
      issueNo: row.issueNo,
      certType: row.certType as 'EMPLOYMENT' | 'CAREER',
      employeeNo: detail.data.employeeNo,
      name: detail.data.name,
      department: detail.data.department?.name ?? '',
      jobTitle: detail.data.jobTitle ?? '',
      hireDate: detail.data.hireDate as unknown as string,
      leaveDate: detail.data.leaveDate ? (detail.data.leaveDate as unknown as string) : null,
      purpose: row.purpose ?? '',
      issuedAt: row.createdAt as unknown as string,
    };
  }

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <style>{`
        @page { size: A4; margin: 20mm; }
        @media print { .cert-paper { box-shadow: none !important; border: none !important; } }
      `}</style>

      <div className="no-print flex flex-col gap-4">
        <header>
          <h1 className="text-lg font-semibold">증명서</h1>
          <p className="mt-0.5 text-sm text-slate-500">
            재직증명서·경력증명서를 발급하고 그 자리에서 인쇄합니다. 발급 결과는 서버가 만든 발급번호와 함께
            감사로그(발급이력 원장)에 영구히 남습니다.
          </p>
        </header>

        {error ? (
          <p role="alert" className="rounded bg-red-50 px-3 py-2 text-sm text-red-700">
            {error}
          </p>
        ) : null}

        <Card title="사원 선택">
          <Field label="검색어" htmlFor="cert-q" hint="사번 또는 성명" className="w-64">
            <Input id="cert-q" value={q} onChange={(e) => setQ(e.target.value)} />
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
                        'border-b border-slate-100 last:border-0' +
                        (r.id === activeEmployeeId ? ' bg-blue-50' : '')
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

        {activeEmployeeId && detail.data ? (
          <Card title="증명서 발급 (issueCertificate)">
            <dl className="mb-3 grid grid-cols-[6rem_1fr] gap-y-1 text-sm">
              <dt className="text-slate-500">사원</dt>
              <dd>
                {detail.data.name} ({detail.data.employeeNo})
              </dd>
              <dt className="text-slate-500">부서</dt>
              <dd>{detail.data.department?.name ?? '-'}</dd>
            </dl>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <Field label="증명서 종류" htmlFor="cert-type" required>
                <Select
                  id="cert-type"
                  value={certType}
                  onChange={(e) => setCertType(e.target.value as 'EMPLOYMENT' | 'CAREER')}
                >
                  <option value="EMPLOYMENT">재직증명서</option>
                  <option value="CAREER">경력증명서</option>
                </Select>
              </Field>
              <Field label="용도" htmlFor="cert-purpose" hint="예: 은행 제출용">
                <Input id="cert-purpose" value={purpose} onChange={(e) => setPurpose(e.target.value)} />
              </Field>
              <div className="flex items-end">
                <Button variant="primary" size="sm" onClick={doIssue} disabled={issue.isPending}>
                  {issue.isPending ? '발급 중…' : '발급'}
                </Button>
              </div>
            </div>
          </Card>
        ) : activeEmployeeId && detail.isLoading ? (
          <Spinner />
        ) : null}

        <Card title={activeEmployeeId ? `발급이력 (${history.data?.length ?? 0}건)` : '발급이력'}>
          {!activeEmployeeId ? (
            <EmptyState title="사원을 먼저 선택하세요." />
          ) : history.isLoading ? (
            <Spinner />
          ) : (history.data ?? []).length === 0 ? (
            <EmptyState
              title="발급한 증명서가 없습니다."
              description="위에서 증명서를 발급하면 여기에 나타나며, 각 건을 다시 선택해 인쇄할 수 있습니다."
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-max text-sm">
                <thead className="bg-slate-50">
                  <tr>
                    <th scope="col" className="px-3 py-2 text-left font-semibold">
                      발급번호
                    </th>
                    <th scope="col" className="px-3 py-2 text-left font-semibold">
                      종류
                    </th>
                    <th scope="col" className="px-3 py-2 text-left font-semibold">
                      대상자
                    </th>
                    <th scope="col" className="px-3 py-2 text-left font-semibold">
                      발급일
                    </th>
                    <th scope="col" className="px-3 py-2 text-left font-semibold">
                      용도
                    </th>
                    <th scope="col" className="px-3 py-2 text-left font-semibold">
                      인쇄
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {(history.data ?? []).map((row) => (
                    <tr key={row.id} className="border-b border-slate-100 last:border-0">
                      <td className="px-3 py-1.5">{row.issueNo}</td>
                      <td className="px-3 py-1.5">{CERT_TYPE_LABEL[row.certType] ?? row.certType}</td>
                      <td className="px-3 py-1.5">
                        {row.employee.name} ({row.employee.employeeNo})
                      </td>
                      <td className="px-3 py-1.5">{fmt.date(row.createdAt as unknown as string)}</td>
                      <td className="px-3 py-1.5">{row.purpose || '-'}</td>
                      <td className="px-3 py-1.5">
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => {
                            const doc = toDocument(row);
                            if (doc) setPrinting(doc);
                          }}
                        >
                          보기·인쇄
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>

      {printing ? (
        <div className="flex flex-col items-center gap-3">
          <Button variant="primary" size="sm" className="no-print" onClick={() => window.print()}>
            인쇄
          </Button>
          <CertificatePaper document={printing} />
        </div>
      ) : null}
    </div>
  );
}

function CertificatePaper({ document: doc }: { document: CertificateDocument }) {
  return (
    <section
      className="cert-paper mx-auto w-full max-w-[210mm] rounded-lg border border-slate-200 bg-white px-16 py-14 text-sm shadow-sm print:max-w-none"
      aria-label={CERT_TYPE_LABEL[doc.certType] ?? doc.certType}
    >
      <p className="text-right text-xs text-slate-500">발급번호: {doc.issueNo}</p>
      <h2 className="mt-6 mb-10 text-center text-2xl font-bold tracking-widest">
        {CERT_TYPE_LABEL[doc.certType] ?? doc.certType}
      </h2>

      <table className="w-full border-collapse text-sm">
        <tbody>
          <Row label="성명" value={doc.name} />
          <Row label="사번" value={doc.employeeNo} />
          <Row label="부서" value={doc.department || '-'} />
          <Row label="직위" value={doc.jobTitle || '-'} />
          <Row label="입사일" value={fmt.date(doc.hireDate)} />
          {doc.certType === 'CAREER' ? (
            <Row label="퇴사일" value={doc.leaveDate ? fmt.date(doc.leaveDate) : '재직중'} />
          ) : null}
          <Row label="용도" value={doc.purpose || '-'} />
        </tbody>
      </table>

      <p className="mt-12 text-center leading-7">
        위 사람은 위와 같이 {doc.certType === 'CAREER' ? '근무하였음을' : '재직하고 있음을'} 증명합니다.
      </p>

      <p className="mt-8 text-center">{fmt.date(doc.issuedAt)}</p>
      <p className="mt-10 text-center text-base font-semibold">주식회사 옥토웍스</p>
    </section>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <tr className="border-b border-slate-200">
      <th scope="row" className="w-32 bg-slate-50 px-3 py-2 text-left font-medium text-slate-600">
        {label}
      </th>
      <td className="px-3 py-2">{value}</td>
    </tr>
  );
}
