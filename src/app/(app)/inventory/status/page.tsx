'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/trpc';
import { StandardListPage } from '@/components/ui/standard-list-page';
import { DataGrid, type Column } from '@/components/ui/data-grid';
import { Card, Field, Input, Select } from '@/components/ui/primitives';
import { fmt } from '@/lib/format';
import { downloadCsv, toCsv } from '@/lib/csv';
import { businessDate } from '@/lib/dates';

/**
 * INV-04 / INV-07: stock on hand by item and warehouse, with the safety-stock shortfall
 * called out. Rows below safety are marked rather than merely coloured, so the state
 * survives a monochrome print and a screen reader.
 */
interface Row {
  itemId: string;
  code: string;
  name: string;
  spec: string | null;
  unitCode: string;
  categoryName: string | null;
  warehouseId: string;
  warehouseName: string;
  quantity: string;
  amount: string;
  safetyStock: string | null;
  belowSafety: boolean;
}

export default function StockStatusPage() {
  const router = useRouter();
  const [filters, setFilters] = useState({
    q: '',
    warehouseId: '',
    categoryId: '',
    hideZero: true,
    belowSafetyOnly: false,
  });
  const [applied, setApplied] = useState(filters);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);

  const warehouses = api.master.warehouses.useQuery({ activeOnly: true });
  const categories = api.master.itemCategories.useQuery();
  // INV-07: every item below its safety stock, aggregated across warehouses — the
  // per-row 안전재고 column below only marks a warehouse's share of the same shortage.
  const shortfalls = api.inventory.safetyStock.useQuery();
  const list = api.inventory.onHand.useQuery({
    hideZero: applied.hideZero,
    belowSafetyOnly: applied.belowSafetyOnly,
    ...(applied.q ? { q: applied.q } : {}),
    ...(applied.warehouseId ? { warehouseId: applied.warehouseId } : {}),
    ...(applied.categoryId ? { categoryId: applied.categoryId } : {}),
  });

  const all = (list.data ?? []) as Row[];
  const rows = all.slice((page - 1) * pageSize, page * pageSize);

  /**
   * UIX-03: `onHand` returns the whole filtered result already (this screen paginates
   * client-side, not the server), so exporting `all` — not just `rows` — reflects every
   * row the current filters match, not merely the page on screen.
   */
  function exportCsv() {
    const warehouseName = applied.warehouseId
      ? (warehouses.data ?? []).find((w) => w.id === applied.warehouseId)?.name
      : undefined;
    const csv = toCsv(
      [
        '품목코드',
        '품목명',
        '규격',
        '분류',
        '창고',
        '재고수량',
        '단위',
        '재고금액',
        '안전재고',
        '안전재고미달',
      ],
      all.map((r) => [
        r.code,
        r.name,
        r.spec ?? '',
        r.categoryName ?? '',
        r.warehouseName,
        r.quantity,
        r.unitCode,
        r.amount,
        r.safetyStock ?? '',
        r.belowSafety ? 'Y' : 'N',
      ]),
    );
    downloadCsv(csv, `재고현황_${businessDate(new Date())}${warehouseName ? `_${warehouseName}` : ''}.csv`);
  }

  const columns: Column<Row>[] = [
    { key: 'code', header: '품목코드', width: 120 },
    { key: 'name', header: '품목명' },
    { key: 'spec', header: '규격', width: 130, render: (r) => r.spec ?? '-' },
    { key: 'categoryName', header: '분류', width: 120, render: (r) => r.categoryName ?? '-' },
    { key: 'warehouseName', header: '창고', width: 120 },
    { key: 'quantity', header: '재고수량', type: 'qty', width: 110 },
    { key: 'unitCode', header: '단위', width: 70 },
    { key: 'amount', header: '재고금액', type: 'money', width: 130 },
    {
      key: 'safetyStock',
      header: '안전재고',
      width: 130,
      render: (r) =>
        r.safetyStock === null ? (
          '-'
        ) : r.belowSafety ? (
          <span className="rounded bg-red-50 px-1.5 py-0.5 text-xs font-medium text-red-700">
            미달 ({r.safetyStock})
          </span>
        ) : (
          <span className="tabular text-slate-600">{r.safetyStock}</span>
        ),
    },
  ];

  return (
    <StandardListPage
      title="재고현황"
      description="창고·분류별 현재고입니다. 현재고는 재고 원장 합계이며, 안전재고 미달 품목이 강조됩니다."
      filterKey="inventory.status"
      filters={
        <>
          <Field label="검색어" htmlFor="st-q" hint="품목코드·품목명">
            <Input
              id="st-q"
              value={filters.q}
              onChange={(e) => setFilters({ ...filters, q: e.target.value })}
            />
          </Field>
          <Field label="창고" htmlFor="st-wh">
            <Select
              id="st-wh"
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
          <Field label="분류" htmlFor="st-cat">
            <Select
              id="st-cat"
              value={filters.categoryId}
              onChange={(e) => setFilters({ ...filters, categoryId: e.target.value })}
            >
              <option value="">전체</option>
              {(categories.data ?? [])
                .filter((c) => c.level === 3)
                .map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
            </Select>
          </Field>
          <div className="flex flex-col justify-end gap-1.5 text-sm">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={filters.hideZero}
                onChange={(e) => setFilters({ ...filters, hideZero: e.target.checked })}
              />
              재고 0 숨기기
            </label>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={filters.belowSafetyOnly}
                onChange={(e) => setFilters({ ...filters, belowSafetyOnly: e.target.checked })}
              />
              안전재고 미달만
            </label>
          </div>
        </>
      }
      onSearch={() => {
        setApplied(filters);
        setPage(1);
      }}
      onReset={() => {
        const empty = { q: '', warehouseId: '', categoryId: '', hideZero: true, belowSafetyOnly: false };
        setFilters(empty);
        setApplied(empty);
      }}
    >
      {(shortfalls.data ?? []).length > 0 ? (
        <Card title={`안전재고 미달 품목 (${shortfalls.data!.length}건)`} className="mb-4">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[36rem] text-sm">
              <thead className="border-b border-slate-200 text-left text-slate-500">
                <tr>
                  <th className="px-2 py-1.5 font-medium">품목코드</th>
                  <th className="px-2 py-1.5 font-medium">품목명</th>
                  <th className="px-2 py-1.5 text-right font-medium">현재고</th>
                  <th className="px-2 py-1.5 text-right font-medium">안전재고</th>
                  <th className="px-2 py-1.5 text-right font-medium">부족수량</th>
                </tr>
              </thead>
              <tbody>
                {shortfalls.data!.map((r) => (
                  <tr key={r.itemId} className="border-b border-slate-100">
                    <td className="tabular px-2 py-1.5 text-slate-500">{r.code}</td>
                    <td className="px-2 py-1.5">
                      <button
                        type="button"
                        className="text-blue-700 hover:underline"
                        onClick={() => router.push(`/inventory/ledger?itemId=${r.itemId}`)}
                      >
                        {r.name}
                      </button>
                    </td>
                    <td className="tabular px-2 py-1.5 text-right">
                      {fmt.qty(r.onHand)} {r.unitCode}
                    </td>
                    <td className="tabular px-2 py-1.5 text-right">
                      {fmt.qty(r.safetyStock)} {r.unitCode}
                    </td>
                    <td className="tabular px-2 py-1.5 text-right font-medium text-red-700">
                      {fmt.qty(r.shortage)} {r.unitCode}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      ) : null}

      <DataGrid<Row>
        gridKey="inventory.status"
        columns={columns}
        rows={rows}
        total={all.length}
        page={page}
        pageSize={pageSize}
        loading={list.isLoading}
        error={list.error?.message ?? null}
        onRetry={() => void list.refetch()}
        rowId={(r) => `${r.itemId}:${r.warehouseId}`}
        onPageChange={setPage}
        onPageSizeChange={(s) => {
          setPageSize(s);
          setPage(1);
        }}
        onRowOpen={(r) => router.push(`/inventory/ledger?itemId=${r.itemId}`)}
        emptyTitle="재고가 없습니다."
        emptyDescription="입고 전표를 확정하면 재고가 나타납니다."
        onExport={all.length > 0 ? exportCsv : undefined}
      />
    </StandardListPage>
  );
}
