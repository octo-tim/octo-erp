'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, newRequestId } from '@/lib/trpc';
import { StandardListPage } from '@/components/ui/standard-list-page';
import { DataGrid, type Column } from '@/components/ui/data-grid';
import { Button, Card, ExportNotice, Field, Input, Select, StatusBadge } from '@/components/ui/primitives';
import { fmt } from '@/lib/format';
import { businessDate } from '@/lib/dates';
import { runServerCsvExport } from '@/lib/csv';

/** INV-08: physical counts. */
interface Row {
  id: string;
  countNo: string;
  countDate: string;
  status: string;
  warehouse: { name: string };
  _count: { lines: number };
}

const STATUS_LABEL: Record<string, string> = {
  DRAFT: '작성중',
  COUNTING: '실사중',
  PENDING_APPROVAL: '결재중',
  APPROVED: '승인',
  CANCELED: '취소',
};

export default function StockCountListPage() {
  const router = useRouter();
  const utils = api.useUtils();

  const [filters, setFilters] = useState({ warehouseId: '', status: '' });
  const [applied, setApplied] = useState(filters);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ warehouseId: '', countDate: businessDate(new Date()), note: '' });
  const [error, setError] = useState<string | null>(null);

  const warehouses = api.master.warehouses.useQuery({ activeOnly: true });
  const create = api.inventory.createCount.useMutation({ onSuccess: () => utils.inventory.invalidate() });
  const list = api.inventory.counts.useQuery({
    page,
    pageSize,
    ...(applied.warehouseId ? { warehouseId: applied.warehouseId } : {}),
    ...(applied.status ? { status: applied.status } : {}),
  });

  const [exportNotice, setExportNotice] = useState<string | null>(null);
  const csvQuery = api.inventory.countsCsv.useQuery(
    {
      ...(applied.warehouseId ? { warehouseId: applied.warehouseId } : {}),
      ...(applied.status ? { status: applied.status } : {}),
    },
    { enabled: false },
  );

  async function exportCsv() {
    setExportNotice(
      await runServerCsvExport(() => csvQuery.refetch(), `재고실사_${businessDate(new Date())}.csv`),
    );
  }

  const columns: Column<Row>[] = [
    { key: 'countNo', header: '실사번호', width: 140 },
    { key: 'countDate', header: '실사일', width: 110, render: (r) => fmt.date(r.countDate) },
    { key: 'warehouse', header: '창고', width: 140, render: (r) => r.warehouse.name },
    { key: '_count', header: '품목수', width: 90, render: (r) => fmt.count(r._count.lines) },
    {
      key: 'status',
      header: '상태',
      width: 100,
      render: (r) => <StatusBadge status={r.status} label={STATUS_LABEL[r.status] ?? r.status} />,
    },
  ];

  return (
    <StandardListPage
      title="재고실사"
      description="실사 시작 시점의 전산재고를 동결하고, 실사수량과의 차이를 승인하면 조정전표가 자동 생성됩니다."
      filterKey="inventory.counts"
      actions={
        <Button variant="primary" size="sm" onClick={() => setCreating((v) => !v)}>
          {creating ? '닫기' : '실사 등록'}
        </Button>
      }
      filters={
        <>
          <Field label="창고" htmlFor="sc-wh">
            <Select
              id="sc-wh"
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
          <Field label="상태" htmlFor="sc-status">
            <Select
              id="sc-status"
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
        </>
      }
      onSearch={() => {
        setApplied(filters);
        setPage(1);
      }}
      onReset={() => {
        const empty = { warehouseId: '', status: '' };
        setFilters(empty);
        setApplied(empty);
      }}
    >
      {creating ? (
        <Card title="실사 등록" className="mb-4">
          {error ? (
            <p role="alert" className="mb-2 rounded bg-red-50 px-3 py-2 text-sm text-red-700">
              {error}
            </p>
          ) : null}
          <form
            className="grid grid-cols-1 gap-3 sm:grid-cols-4"
            onSubmit={async (e) => {
              e.preventDefault();
              setError(null);
              try {
                const created = await create.mutateAsync({
                  warehouseId: form.warehouseId,
                  countDate: form.countDate,
                  ...(form.note ? { note: form.note } : {}),
                  requestId: newRequestId(),
                });
                setCreating(false);
                router.push(`/inventory/counts/${created.id}`);
              } catch (err) {
                setError((err as { message?: string }).message ?? '등록에 실패했습니다.');
              }
            }}
          >
            <Field label="실사 창고" htmlFor="sc-new-wh" required>
              <Select
                id="sc-new-wh"
                required
                value={form.warehouseId}
                onChange={(e) => setForm({ ...form, warehouseId: e.target.value })}
              >
                <option value="">선택</option>
                {(warehouses.data ?? []).map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="실사일" htmlFor="sc-new-date" required>
              <Input
                id="sc-new-date"
                type="date"
                value={form.countDate}
                onChange={(e) => setForm({ ...form, countDate: e.target.value })}
              />
            </Field>
            <Field label="비고" htmlFor="sc-new-note">
              <Input
                id="sc-new-note"
                value={form.note}
                onChange={(e) => setForm({ ...form, note: e.target.value })}
              />
            </Field>
            <div className="flex items-end">
              <Button type="submit" variant="primary" size="sm" disabled={create.isPending}>
                등록
              </Button>
            </div>
          </form>
        </Card>
      ) : null}

      <ExportNotice message={exportNotice} />

      <DataGrid<Row>
        gridKey="inventory.counts"
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
        onRowOpen={(r) => router.push(`/inventory/counts/${r.id}`)}
        emptyTitle="실사 내역이 없습니다."
        emptyDescription="'실사 등록'으로 시작하세요."
        onExport={(list.data?.total ?? 0) > 0 ? exportCsv : undefined}
      />
    </StandardListPage>
  );
}
