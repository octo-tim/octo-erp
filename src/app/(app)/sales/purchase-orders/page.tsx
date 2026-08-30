'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/trpc';
import { StandardListPage } from '@/components/ui/standard-list-page';
import { DataGrid, type Column } from '@/components/ui/data-grid';
import { Field, Input, Select, StatusBadge } from '@/components/ui/primitives';
import { PartnerSelect } from '@/components/sales/partner-select';
import { fmt } from '@/lib/format';

/** SLS-13: purchase orders, received against by one or more purchase documents. */
interface Row {
  id: string;
  docNo: string;
  docDate: string;
  dueDate: string | null;
  status: string;
  partner: { name: string };
  totalAmount: string;
}

const STATUS_LABEL: Record<string, string> = {
  DRAFT: '작성중',
  ORDERED: '발주',
  RECEIVING: '입고중',
  COMPLETED: '완료',
  CANCELED: '취소',
};

export default function PurchaseOrdersPage() {
  const router = useRouter();
  const [filters, setFilters] = useState({ q: '', status: '', partnerId: '' });
  const [applied, setApplied] = useState(filters);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);

  const list = api.sales.purchaseOrders.useQuery({
    page,
    pageSize,
    ...(applied.q ? { q: applied.q } : {}),
    ...(applied.status ? { status: applied.status } : {}),
    ...(applied.partnerId ? { partnerId: applied.partnerId } : {}),
  });

  const columns: Column<Row>[] = [
    { key: 'docNo', header: '발주번호', width: 150 },
    { key: 'docDate', header: '발주일', width: 110, render: (r) => fmt.date(r.docDate) },
    { key: 'partner', header: '발주처', render: (r) => r.partner.name },
    {
      key: 'dueDate',
      header: '납기일',
      width: 110,
      render: (r) => (r.dueDate ? fmt.date(r.dueDate) : '-'),
    },
    { key: 'totalAmount', header: '합계', type: 'money', width: 140 },
    {
      key: 'status',
      header: '상태',
      width: 100,
      render: (r) => <StatusBadge status={r.status} label={STATUS_LABEL[r.status] ?? r.status} />,
    },
  ];

  return (
    <StandardListPage
      title="발주서"
      description="승인된 구매요청에서 생성됩니다. 입고된 만큼 잔여수량이 줄어 상태가 자동으로 바뀝니다."
      filterKey="sales.purchaseOrders"
      filters={
        <>
          <Field label="검색어" htmlFor="pof-q" hint="발주번호">
            <Input
              id="pof-q"
              value={filters.q}
              onChange={(e) => setFilters({ ...filters, q: e.target.value })}
            />
          </Field>
          <Field label="발주처" htmlFor="pof-partner">
            <PartnerSelect
              id="pof-partner"
              includeAll
              partnerType="SUPPLIER"
              value={filters.partnerId}
              onChange={(v) => setFilters({ ...filters, partnerId: v })}
            />
          </Field>
          <Field label="상태" htmlFor="pof-status">
            <Select
              id="pof-status"
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
        const empty = { q: '', status: '', partnerId: '' };
        setFilters(empty);
        setApplied(empty);
      }}
    >
      <DataGrid<Row>
        gridKey="sales.purchaseOrders"
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
        onRowOpen={(r) => router.push(`/sales/purchase-orders/${r.id}`)}
        emptyTitle="발주서가 없습니다."
        emptyDescription="구매요청 승인 후 '발주서 생성'하면 여기에 나타납니다."
      />
    </StandardListPage>
  );
}
