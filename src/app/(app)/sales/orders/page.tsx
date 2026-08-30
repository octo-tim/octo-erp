'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/trpc';
import { StandardListPage } from '@/components/ui/standard-list-page';
import { DataGrid, type Column } from '@/components/ui/data-grid';
import { Field, Input, Select, StatusBadge } from '@/components/ui/primitives';
import { PartnerSelect } from '@/components/sales/partner-select';
import { fmt } from '@/lib/format';

/** SLS-03: sales orders. Created from a quotation, delivered by one or more sales documents. */
interface Row {
  id: string;
  docNo: string;
  docDate: string;
  deliveryDate: string | null;
  status: string;
  partner: { name: string };
  totalAmount: string;
}

const STATUS_LABEL: Record<string, string> = {
  DRAFT: '작성중',
  ACCEPTED: '접수',
  IN_PROGRESS: '진행중',
  COMPLETED: '완료',
  CANCELED: '취소',
};

export default function SalesOrdersPage() {
  const router = useRouter();
  const [filters, setFilters] = useState({ q: '', status: '', partnerId: '' });
  const [applied, setApplied] = useState(filters);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);

  const list = api.sales.salesOrders.useQuery({
    page,
    pageSize,
    ...(applied.q ? { q: applied.q } : {}),
    ...(applied.status ? { status: applied.status } : {}),
    ...(applied.partnerId ? { partnerId: applied.partnerId } : {}),
  });

  const columns: Column<Row>[] = [
    { key: 'docNo', header: '주문번호', width: 150 },
    { key: 'docDate', header: '주문일', width: 110, render: (r) => fmt.date(r.docDate) },
    { key: 'partner', header: '거래처', render: (r) => r.partner.name },
    {
      key: 'deliveryDate',
      header: '납기일',
      width: 110,
      render: (r) => (r.deliveryDate ? fmt.date(r.deliveryDate) : '-'),
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
      title="주문서"
      description="주문은 분할 출고될 수 있고, 출고된 만큼 잔여수량이 줄어 상태가 자동으로 바뀝니다."
      filterKey="sales.orders"
      filters={
        <>
          <Field label="검색어" htmlFor="sof-q" hint="주문번호·거래처명">
            <Input
              id="sof-q"
              value={filters.q}
              onChange={(e) => setFilters({ ...filters, q: e.target.value })}
            />
          </Field>
          <Field label="거래처" htmlFor="sof-partner">
            <PartnerSelect
              id="sof-partner"
              includeAll
              partnerType="CUSTOMER"
              value={filters.partnerId}
              onChange={(v) => setFilters({ ...filters, partnerId: v })}
            />
          </Field>
          <Field label="상태" htmlFor="sof-status">
            <Select
              id="sof-status"
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
        gridKey="sales.orders"
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
        onRowOpen={(r) => router.push(`/sales/orders/${r.id}`)}
        emptyTitle="주문서가 없습니다."
        emptyDescription="견적서에서 '주문으로 전환'하면 여기에 나타납니다."
      />
    </StandardListPage>
  );
}
