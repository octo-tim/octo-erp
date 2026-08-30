'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/trpc';
import { StandardListPage } from '@/components/ui/standard-list-page';
import { DataGrid, type Column } from '@/components/ui/data-grid';
import { Button, Field, Input, Select, StatusBadge } from '@/components/ui/primitives';
import { StockDocumentForm, type FormDocType } from './stock-document-form';
import { fmt } from '@/lib/format';

/**
 * The list half of 입고/출고/이동. All three are the same screen with a different
 * docType, so the columns and filters live here once.
 */
interface Row {
  id: string;
  docNo: string;
  docDate: string;
  status: string;
  movementState: string | null;
  fromWarehouse: { name: string } | null;
  toWarehouse: { name: string } | null;
  reasonCode: string | null;
  totalQuantity: string;
  totalAmount: string;
  _count: { lines: number };
}

const STATUS_LABEL: Record<string, string> = {
  DRAFT: '작성중',
  PENDING_APPROVAL: '결재중',
  CONFIRMED: '확정',
  CANCELED: '취소',
};

const MOVEMENT_LABEL: Record<string, string> = {
  REQUESTED: '요청',
  IN_TRANSIT: '이동중',
  COMPLETED: '완료',
  CANCELED: '취소',
};

export function StockDocumentList({
  docType,
  title,
  description,
  createLabel,
}: {
  docType: FormDocType;
  title: string;
  description: string;
  createLabel: string;
}) {
  const router = useRouter();
  const [filters, setFilters] = useState({ q: '', status: '', warehouseId: '', from: '', to: '' });
  const [applied, setApplied] = useState(filters);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [creating, setCreating] = useState(false);

  const warehouses = api.master.warehouses.useQuery({ activeOnly: true });
  const list = api.inventory.documents.useQuery({
    docType,
    page,
    pageSize,
    ...(applied.q ? { q: applied.q } : {}),
    ...(applied.status ? { status: applied.status } : {}),
    ...(applied.warehouseId ? { warehouseId: applied.warehouseId } : {}),
    ...(applied.from ? { from: applied.from } : {}),
    ...(applied.to ? { to: applied.to } : {}),
  });

  const columns: Column<Row>[] = [
    { key: 'docNo', header: '전표번호', width: 140 },
    { key: 'docDate', header: '일자', width: 110, render: (r) => fmt.date(r.docDate) },
    ...(docType === 'TRANSFER'
      ? ([
          { key: 'fromWarehouse', header: '출발', width: 120, render: (r) => r.fromWarehouse?.name ?? '-' },
          { key: 'toWarehouse', header: '도착', width: 120, render: (r) => r.toWarehouse?.name ?? '-' },
          {
            key: 'movementState',
            header: '이동상태',
            width: 100,
            render: (r) => (r.movementState ? MOVEMENT_LABEL[r.movementState] : '-'),
          },
        ] as Column<Row>[])
      : ([
          {
            key: 'toWarehouse',
            header: '창고',
            width: 140,
            render: (r) => r.toWarehouse?.name ?? r.fromWarehouse?.name ?? '-',
          },
          { key: 'reasonCode', header: '사유', width: 120, render: (r) => r.reasonCode ?? '-' },
        ] as Column<Row>[])),
    { key: 'totalQuantity', header: '수량', type: 'qty', width: 110 },
    ...(docType === 'RECEIPT'
      ? ([{ key: 'totalAmount', header: '금액', type: 'money', width: 130 }] as Column<Row>[])
      : []),
    {
      key: 'status',
      header: '상태',
      width: 90,
      render: (r) => <StatusBadge status={r.status} label={STATUS_LABEL[r.status] ?? r.status} />,
    },
  ];

  return (
    <StandardListPage
      title={title}
      description={description}
      filterKey={`inventory.${docType}`}
      actions={
        <Button variant="primary" size="sm" onClick={() => setCreating((v) => !v)}>
          {creating ? '닫기' : createLabel}
        </Button>
      }
      filters={
        <>
          <Field label="검색어" htmlFor="sdf-q" hint="전표번호">
            <Input
              id="sdf-q"
              value={filters.q}
              onChange={(e) => setFilters({ ...filters, q: e.target.value })}
            />
          </Field>
          <Field label="창고" htmlFor="sdf-wh">
            <Select
              id="sdf-wh"
              value={filters.warehouseId}
              onChange={(e) => setFilters({ ...filters, warehouseId: e.target.value })}
            >
              <option value="">전체</option>
              {(warehouses.data ?? []).map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="상태" htmlFor="sdf-status">
            <Select
              id="sdf-status"
              value={filters.status}
              onChange={(e) => setFilters({ ...filters, status: e.target.value })}
            >
              <option value="">전체</option>
              {Object.entries(STATUS_LABEL).map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </Select>
          </Field>
          <div className="grid grid-cols-2 gap-2">
            <Field label="시작일" htmlFor="sdf-from">
              <Input
                id="sdf-from"
                type="date"
                value={filters.from}
                onChange={(e) => setFilters({ ...filters, from: e.target.value })}
              />
            </Field>
            <Field label="종료일" htmlFor="sdf-to">
              <Input
                id="sdf-to"
                type="date"
                value={filters.to}
                onChange={(e) => setFilters({ ...filters, to: e.target.value })}
              />
            </Field>
          </div>
        </>
      }
      onSearch={() => {
        setApplied(filters);
        setPage(1);
      }}
      onReset={() => {
        const empty = { q: '', status: '', warehouseId: '', from: '', to: '' };
        setFilters(empty);
        setApplied(empty);
      }}
    >
      {creating ? (
        <div className="mb-4">
          <StockDocumentForm
            docType={docType}
            onCreated={(id) => {
              setCreating(false);
              router.push(`/inventory/documents/${id}`);
            }}
            onCancel={() => setCreating(false)}
          />
        </div>
      ) : null}

      <DataGrid<Row>
        gridKey={`inventory.${docType}`}
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
        onRowOpen={(r) => router.push(`/inventory/documents/${r.id}`)}
        emptyTitle="전표가 없습니다."
        emptyDescription={`'${createLabel}'으로 등록하세요.`}
      />
    </StandardListPage>
  );
}
