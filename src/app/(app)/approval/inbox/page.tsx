'use client';

import { useState } from 'react';
import { api } from '@/lib/trpc';
import { StandardListPage, useSavedFilters } from '@/components/ui/standard-list-page';
import { DataGrid, type Column } from '@/components/ui/data-grid';
import { Button, ExportNotice, Field, Input, StatusBadge } from '@/components/ui/primitives';
import { cn } from '@/lib/cn';
import { businessDate } from '@/lib/dates';
import { runServerCsvExport } from '@/lib/csv';

/** APV-10: the six approval inboxes with the pending badge. */
type Inbox = 'PENDING' | 'DRAFTED' | 'IN_PROGRESS' | 'COMPLETED' | 'REJECTED' | 'REFERENCE';

const TABS: { key: Inbox; label: string }[] = [
  { key: 'PENDING', label: '대기' },
  { key: 'DRAFTED', label: '기안' },
  { key: 'IN_PROGRESS', label: '진행' },
  { key: 'COMPLETED', label: '완료' },
  { key: 'REJECTED', label: '반려·회수' },
  { key: 'REFERENCE', label: '참조' },
];

interface Row {
  id: string;
  docNo: string;
  title: string;
  status: string;
  amount: string | null;
  createdAt: string;
  submittedAt: string | null;
}

export default function ApprovalInboxPage() {
  const [inbox, setInbox] = useState<Inbox>('PENDING');
  const { filters, setFilters, save, reset } = useSavedFilters('approval.inbox', { q: '', from: '', to: '' });
  const [applied, setApplied] = useState(filters);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);

  const pending = api.approval.pendingCount.useQuery(undefined, { refetchInterval: 60_000 });
  const list = api.approval.inbox.useQuery({
    inbox,
    page,
    pageSize,
    sortDir: 'desc',
    ...(applied.q ? { q: applied.q } : {}),
    ...(applied.from ? { from: applied.from } : {}),
    ...(applied.to ? { to: applied.to } : {}),
  });

  const [exportNotice, setExportNotice] = useState<string | null>(null);
  const csvQuery = api.approval.inboxCsv.useQuery(
    {
      inbox,
      ...(applied.q ? { q: applied.q } : {}),
      ...(applied.from ? { from: applied.from } : {}),
      ...(applied.to ? { to: applied.to } : {}),
    },
    { enabled: false },
  );

  async function exportCsv() {
    const tabLabel = TABS.find((t) => t.key === inbox)?.label ?? inbox;
    const period = `${applied.from || '처음'}_${applied.to || businessDate(new Date())}`;
    setExportNotice(await runServerCsvExport(() => csvQuery.refetch(), `결재함_${tabLabel}_${period}.csv`));
  }

  const columns: Column<Row>[] = [
    { key: 'docNo', header: '문서번호', width: 160 },
    { key: 'title', header: '제목' },
    { key: 'amount', header: '금액', type: 'money', width: 130, total: true },
    { key: 'status', header: '상태', width: 100, render: (r) => <StatusBadge status={r.status} /> },
    { key: 'submittedAt', header: '상신일시', type: 'dateTime', width: 150 },
    { key: 'createdAt', header: '작성일시', type: 'dateTime', width: 150 },
  ];

  return (
    <StandardListPage
      title="결재함"
      description="내가 처리할 문서와 내가 관련된 문서를 함께 확인합니다."
      filterKey="approval.inbox"
      actions={
        <Button
          variant="primary"
          size="sm"
          onClick={() => {
            window.location.href = '/approval/draft';
          }}
        >
          기안하기
        </Button>
      }
      filters={
        <>
          <Field label="검색어" htmlFor="ap-q" hint="문서번호 또는 제목">
            <Input
              id="ap-q"
              value={filters.q}
              onChange={(e) => setFilters({ ...filters, q: e.target.value })}
            />
          </Field>
          <Field label="작성일 시작" htmlFor="ap-from">
            <Input
              id="ap-from"
              type="date"
              value={filters.from}
              onChange={(e) => setFilters({ ...filters, from: e.target.value })}
            />
          </Field>
          <Field label="작성일 종료" htmlFor="ap-to">
            <Input
              id="ap-to"
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
        setApplied({ q: '', from: '', to: '' });
        setPage(1);
      }}
    >
      <div role="tablist" aria-label="결재함 종류" className="flex flex-wrap gap-1.5">
        {TABS.map((t) => (
          <button
            key={t.key}
            role="tab"
            aria-selected={inbox === t.key}
            onClick={() => {
              setInbox(t.key);
              setPage(1);
            }}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm',
              inbox === t.key
                ? 'border-blue-600 bg-blue-600 text-white'
                : 'border-slate-300 bg-white hover:bg-slate-50',
            )}
          >
            {t.label}
            {t.key === 'PENDING' && pending.data ? (
              <span className="inline-flex min-w-5 items-center justify-center rounded-full bg-red-600 px-1.5 text-xs font-semibold text-white tabular">
                {pending.data}
              </span>
            ) : null}
          </button>
        ))}
      </div>

      <ExportNotice message={exportNotice} />

      <DataGrid<Row>
        gridKey="approval.inbox"
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
          window.location.href = `/approval/documents/${r.id}`;
        }}
        emptyTitle={inbox === 'PENDING' ? '처리할 결재가 없습니다.' : '해당 결재함에 문서가 없습니다.'}
        emptyDescription="다른 결재함 탭을 확인하거나 조회 기간을 넓혀 보세요."
        onExport={(list.data?.total ?? 0) > 0 ? exportCsv : undefined}
      />
    </StandardListPage>
  );
}
