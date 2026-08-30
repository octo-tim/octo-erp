'use client';

import { useState } from 'react';
import { api } from '@/lib/trpc';
import { StandardListPage, useSavedFilters } from '@/components/ui/standard-list-page';
import { DataGrid, type Column } from '@/components/ui/data-grid';
import { Field, Input, Select, StatusBadge } from '@/components/ui/primitives';

/** APV-13: multi-condition document search across the inboxes the user may see. */
interface Row {
  id: string;
  docNo: string;
  title: string;
  status: string;
  amount: string | null;
  createdAt: string;
}

export default function ApprovalSearchPage() {
  const { filters, setFilters, save, reset } = useSavedFilters('approval.search', {
    q: '',
    scope: 'COMPLETED' as 'DRAFTED' | 'COMPLETED' | 'REJECTED' | 'REFERENCE',
    from: '',
    to: '',
  });
  const [applied, setApplied] = useState(filters);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);

  const list = api.approval.inbox.useQuery({
    inbox: applied.scope,
    page,
    pageSize,
    sortDir: 'desc',
    ...(applied.q ? { q: applied.q } : {}),
    ...(applied.from ? { from: applied.from } : {}),
    ...(applied.to ? { to: applied.to } : {}),
  });

  const columns: Column<Row>[] = [
    { key: 'docNo', header: '문서번호', width: 160 },
    { key: 'title', header: '제목' },
    { key: 'amount', header: '금액', type: 'money', width: 130 },
    { key: 'status', header: '상태', width: 100, render: (r) => <StatusBadge status={r.status} /> },
    { key: 'createdAt', header: '작성일시', type: 'dateTime', width: 150 },
  ];

  return (
    <StandardListPage
      title="문서검색"
      description="내가 기안했거나 결재·참조한 문서를 조건으로 찾습니다."
      filterKey="approval.search"
      filters={
        <>
          <Field label="검색어" htmlFor="as-q" hint="문서번호 또는 제목">
            <Input
              id="as-q"
              value={filters.q}
              onChange={(e) => setFilters({ ...filters, q: e.target.value })}
            />
          </Field>
          <Field label="범위" htmlFor="as-scope">
            <Select
              id="as-scope"
              value={filters.scope}
              onChange={(e) => setFilters({ ...filters, scope: e.target.value as typeof filters.scope })}
            >
              <option value="COMPLETED">완료 문서</option>
              <option value="DRAFTED">내가 기안</option>
              <option value="REJECTED">반려·회수</option>
              <option value="REFERENCE">참조 문서</option>
            </Select>
          </Field>
          <Field label="작성일 시작" htmlFor="as-from">
            <Input
              id="as-from"
              type="date"
              value={filters.from}
              onChange={(e) => setFilters({ ...filters, from: e.target.value })}
            />
          </Field>
          <Field label="작성일 종료" htmlFor="as-to">
            <Input
              id="as-to"
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
        setApplied({ q: '', scope: 'COMPLETED', from: '', to: '' });
        setPage(1);
      }}
    >
      <DataGrid<Row>
        gridKey="approval.search"
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
        emptyTitle="조건에 맞는 문서가 없습니다."
        emptyDescription="범위를 바꾸거나 기간을 넓혀 다시 조회하세요."
      />
    </StandardListPage>
  );
}
