'use client';

/** BAS-08/INT-09: audit log and security events. Sensitive values are redacted server-side. */

import { useState } from 'react';
import { api } from '@/lib/trpc';
import { Button, Card, EmptyState, Field, Input, Select, Spinner } from '@/components/ui/primitives';
import { fmt } from '@/lib/format';

const SECURITY_EVENT_TYPE_LABEL: Record<string, string> = {
  LOGIN_FAILED: '로그인 실패',
  ACCOUNT_LOCKED: '계정 잠금',
  ACCOUNT_UNLOCKED: '계정 잠금 해제',
  PASSWORD_RESET: '비밀번호 재설정',
  FORBIDDEN: '권한 없음',
  SENSITIVE_ACCESS: '민감정보 접근',
  SESSION_REVOKED: '세션 강제 종료',
};

type Tab = 'log' | 'security';
const pageSize = 50;

export default function AuditPage() {
  const [tab, setTab] = useState<Tab>('log');

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <header>
        <h1 className="text-lg font-semibold">감사로그</h1>
        <p className="mt-0.5 text-sm text-slate-500">
          모든 업무 변경은 같은 트랜잭션에서 감사로그로 남습니다. 비밀번호·계좌번호 등 민감 항목은 서버에서
          이미 마스킹되어 저장되며, 이 화면에서 원문을 복원할 수 없습니다.
        </p>
      </header>

      <div role="tablist" aria-label="감사로그 구분" className="flex gap-1.5 border-b border-slate-200">
        <TabButton active={tab === 'log'} onClick={() => setTab('log')}>
          감사로그
        </TabButton>
        <TabButton active={tab === 'security'} onClick={() => setTab('security')}>
          보안 이벤트
        </TabButton>
      </div>

      {tab === 'log' ? <AuditLogTab /> : <SecurityEventsTab />}
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium ${
        active ? 'border-blue-600 text-blue-700' : 'border-transparent text-slate-500 hover:text-slate-700'
      }`}
    >
      {children}
    </button>
  );
}

function AuditLogTab() {
  const [entityType, setEntityType] = useState('');
  const [actorId, setActorId] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [page, setPage] = useState(1);

  const users = api.admin.listUsers.useQuery(
    { page: 1, pageSize: 200, sortDir: 'asc', activeOnly: false },
    { retry: false },
  );
  const list = api.admin.auditLog.useQuery({
    page,
    pageSize,
    ...(entityType.trim() ? { entityType: entityType.trim() } : {}),
    ...(actorId ? { actorId } : {}),
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
  });

  const rows = list.data?.rows ?? [];
  const total = list.data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  function resetPage() {
    setPage(1);
  }

  return (
    <Card title="감사로그 조회">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
        <Field label="대상 유형" htmlFor="al-entity" hint="예: SalesDocument, Item, User">
          <Input
            id="al-entity"
            value={entityType}
            onChange={(e) => {
              setEntityType(e.target.value);
              resetPage();
            }}
          />
        </Field>
        <Field label="행위자" htmlFor="al-actor">
          <Select
            id="al-actor"
            value={actorId}
            onChange={(e) => {
              setActorId(e.target.value);
              resetPage();
            }}
          >
            <option value="">전체</option>
            {(users.data?.rows ?? []).map((u) => (
              <option key={u.id} value={u.id}>
                {u.displayName} ({u.username})
              </option>
            ))}
          </Select>
        </Field>
        <Field label="시작일" htmlFor="al-from">
          <Input
            id="al-from"
            type="date"
            value={from}
            onChange={(e) => {
              setFrom(e.target.value);
              resetPage();
            }}
          />
        </Field>
        <Field label="종료일" htmlFor="al-to">
          <Input
            id="al-to"
            type="date"
            value={to}
            onChange={(e) => {
              setTo(e.target.value);
              resetPage();
            }}
          />
        </Field>
      </div>

      <div className="mt-4">
        {list.isLoading ? (
          <Spinner />
        ) : rows.length === 0 ? (
          <EmptyState
            title="조건에 맞는 감사로그가 없습니다."
            description="필터를 완화하거나 기간을 넓혀 다시 조회하세요."
          />
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full min-w-max text-sm">
                <thead className="bg-slate-50">
                  <tr>
                    <th scope="col" className="px-3 py-2 text-left font-semibold">
                      일시
                    </th>
                    <th scope="col" className="px-3 py-2 text-left font-semibold">
                      행위자
                    </th>
                    <th scope="col" className="px-3 py-2 text-left font-semibold">
                      액션
                    </th>
                    <th scope="col" className="px-3 py-2 text-left font-semibold">
                      대상
                    </th>
                    <th scope="col" className="px-3 py-2 text-left font-semibold">
                      변경 내용
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id} className="border-b border-slate-100 last:border-0 align-top">
                      <td className="whitespace-nowrap px-3 py-1.5">
                        {fmt.dateTime(r.createdAt as unknown as string)}
                      </td>
                      <td className="px-3 py-1.5">{r.actorName ?? '시스템'}</td>
                      <td className="px-3 py-1.5">{r.action}</td>
                      <td className="px-3 py-1.5">
                        {r.entityType}
                        <span className="block text-xs text-slate-400">{r.entityId}</span>
                      </td>
                      <td className="px-3 py-1.5">
                        {r.before || r.after || r.meta ? (
                          <details>
                            <summary className="cursor-pointer text-xs text-slate-500">상세</summary>
                            <div className="mt-1 flex max-w-md flex-col gap-1">
                              {r.before ? (
                                <pre className="overflow-x-auto whitespace-pre-wrap break-all rounded bg-slate-50 p-2 text-xs">
                                  이전: {JSON.stringify(r.before, null, 2)}
                                </pre>
                              ) : null}
                              {r.after ? (
                                <pre className="overflow-x-auto whitespace-pre-wrap break-all rounded bg-slate-50 p-2 text-xs">
                                  이후: {JSON.stringify(r.after, null, 2)}
                                </pre>
                              ) : null}
                              {r.meta ? (
                                <pre className="overflow-x-auto whitespace-pre-wrap break-all rounded bg-slate-50 p-2 text-xs">
                                  기타: {JSON.stringify(r.meta, null, 2)}
                                </pre>
                              ) : null}
                            </div>
                          </details>
                        ) : (
                          '-'
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="mt-3 flex items-center justify-between text-sm text-slate-500">
              <span>
                {page} / {totalPages} 페이지 (총 {fmt.count(total)}건)
              </span>
              <div className="flex gap-1.5">
                <Button size="sm" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>
                  이전
                </Button>
                <Button
                  size="sm"
                  disabled={page >= totalPages}
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                >
                  다음
                </Button>
              </div>
            </div>
          </>
        )}
      </div>
    </Card>
  );
}

function SecurityEventsTab() {
  const [type, setType] = useState('');
  const [page, setPage] = useState(1);

  const list = api.admin.securityEvents.useQuery({
    page,
    pageSize,
    ...(type ? { type } : {}),
  });

  const rows = list.data?.rows ?? [];
  const total = list.data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <Card
      title="보안 이벤트"
      actions={
        <Field label="유형" htmlFor="se-type" className="w-48">
          <Select
            id="se-type"
            value={type}
            onChange={(e) => {
              setType(e.target.value);
              setPage(1);
            }}
          >
            <option value="">전체</option>
            {Object.entries(SECURITY_EVENT_TYPE_LABEL).map(([code, label]) => (
              <option key={code} value={code}>
                {label}
              </option>
            ))}
          </Select>
        </Field>
      }
    >
      {list.isLoading ? (
        <Spinner />
      ) : rows.length === 0 ? (
        <EmptyState
          title="조건에 맞는 보안 이벤트가 없습니다."
          description="유형 필터를 바꾸어 다시 확인하세요."
        />
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className="w-full min-w-max text-sm">
              <thead className="bg-slate-50">
                <tr>
                  <th scope="col" className="px-3 py-2 text-left font-semibold">
                    일시
                  </th>
                  <th scope="col" className="px-3 py-2 text-left font-semibold">
                    유형
                  </th>
                  <th scope="col" className="px-3 py-2 text-left font-semibold">
                    대상 사용자
                  </th>
                  <th scope="col" className="px-3 py-2 text-left font-semibold">
                    IP
                  </th>
                  <th scope="col" className="px-3 py-2 text-left font-semibold">
                    상세
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="border-b border-slate-100 last:border-0">
                    <td className="whitespace-nowrap px-3 py-1.5">
                      {fmt.dateTime(r.createdAt as unknown as string)}
                    </td>
                    <td className="px-3 py-1.5">{SECURITY_EVENT_TYPE_LABEL[r.type] ?? r.type}</td>
                    <td className="px-3 py-1.5">{r.userId ?? '-'}</td>
                    <td className="px-3 py-1.5">{r.ip ?? '-'}</td>
                    <td className="px-3 py-1.5">
                      {r.meta ? (
                        <details>
                          <summary className="cursor-pointer text-xs text-slate-500">보기</summary>
                          <pre className="mt-1 max-w-md overflow-x-auto whitespace-pre-wrap break-all rounded bg-slate-50 p-2 text-xs">
                            {JSON.stringify(r.meta, null, 2)}
                          </pre>
                        </details>
                      ) : (
                        '-'
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="mt-3 flex items-center justify-between text-sm text-slate-500">
            <span>
              {page} / {totalPages} 페이지 (총 {fmt.count(total)}건)
            </span>
            <div className="flex gap-1.5">
              <Button size="sm" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>
                이전
              </Button>
              <Button
                size="sm"
                disabled={page >= totalPages}
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              >
                다음
              </Button>
            </div>
          </div>
        </>
      )}
    </Card>
  );
}
