'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, newRequestId } from '@/lib/trpc';
import { StandardListPage } from '@/components/ui/standard-list-page';
import { DataGrid, type Column } from '@/components/ui/data-grid';
import { Button, Card, ExportNotice, Field, Input, Select, StatusBadge } from '@/components/ui/primitives';
import { FormErrorSummary, type FieldError } from '@/components/ui/form-error-summary';
import { PartnerSelect } from '@/components/sales/partner-select';
import {
  emptyTradeLine,
  useItemResolver,
  TradeLineEditor,
  TradeTotals,
  type TradeLine,
} from '@/components/sales/trade-line-editor';
import { fmt } from '@/lib/format';
import { businessDate } from '@/lib/dates';
import { runServerCsvExport } from '@/lib/csv';

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
  const utils = api.useUtils();
  const [filters, setFilters] = useState({ q: '', status: '', partnerId: '' });
  const [applied, setApplied] = useState(filters);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [creating, setCreating] = useState(false);

  const [header, setHeader] = useState({
    docDate: businessDate(new Date()),
    deliveryDate: '',
    partnerId: '',
    note: '',
  });
  const [lines, setLines] = useState<TradeLine[]>([emptyTradeLine()]);
  const [errors, setErrors] = useState<FieldError[]>([]);

  const resolveItems = useItemResolver();
  const create = api.sales.createSalesOrder.useMutation({ onSuccess: () => utils.sales.invalidate() });
  const list = api.sales.salesOrders.useQuery({
    page,
    pageSize,
    ...(applied.q ? { q: applied.q } : {}),
    ...(applied.status ? { status: applied.status } : {}),
    ...(applied.partnerId ? { partnerId: applied.partnerId } : {}),
  });

  const [exportNotice, setExportNotice] = useState<string | null>(null);
  const csvQuery = api.sales.salesOrdersCsv.useQuery(
    {
      ...(applied.q ? { q: applied.q } : {}),
      ...(applied.status ? { status: applied.status } : {}),
      ...(applied.partnerId ? { partnerId: applied.partnerId } : {}),
    },
    { enabled: false },
  );

  async function exportCsv() {
    setExportNotice(
      await runServerCsvExport(() => csvQuery.refetch(), `주문서_${businessDate(new Date())}.csv`),
    );
  }

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

  async function submit() {
    setErrors([]);
    const entered = lines.filter((l) => l.itemLabel.trim() || l.quantity.trim());
    // CR-14: the server resolves what was typed, so items outside the suggestion list are found
    const resolved = entered.length > 0 ? await resolveItems(entered.map((l) => l.itemLabel)) : null;
    const prepared =
      resolved && 'ids' in resolved
        ? entered.map((line, i) => ({ index: i, itemId: resolved.ids[i]!, line }))
        : [];

    const problems: FieldError[] = [];
    if (!header.partnerId)
      problems.push({ field: 'so-partner', label: '거래처', message: '거래처를 선택하세요.' });
    if (entered.length === 0) {
      problems.push({ field: 'so-lines', label: '품목', message: '품목을 한 건 이상 입력하세요.' });
    } else if (resolved && 'errors' in resolved) {
      for (const message of resolved.errors) problems.push({ field: 'so-lines', label: '품목', message });
    }
    if (problems.length) {
      setErrors(problems);
      return;
    }

    try {
      const order = await create.mutateAsync({
        docDate: header.docDate,
        ...(header.deliveryDate ? { deliveryDate: header.deliveryDate } : {}),
        partnerId: header.partnerId,
        ...(header.note ? { note: header.note } : {}),
        lines: prepared.map((p) => ({
          itemId: p.itemId,
          ...(p.line.description ? { description: p.line.description } : {}),
          quantity: p.line.quantity,
          unitPrice: p.line.unitPrice,
          taxType: (p.line.taxType || 'TAXABLE') as 'TAXABLE',
        })),
        requestId: newRequestId(),
      });
      setCreating(false);
      setLines([emptyTradeLine()]);
      router.push(`/sales/orders/${order.id}`);
    } catch (err) {
      setErrors([
        {
          field: 'so-date',
          label: '저장',
          message: (err as { message?: string }).message ?? '저장에 실패했습니다.',
        },
      ]);
    }
  }

  return (
    <StandardListPage
      title="주문서"
      description="주문은 분할 출고될 수 있고, 출고된 만큼 잔여수량이 줄어 상태가 자동으로 바뀝니다."
      filterKey="sales.orders"
      actions={
        <Button variant="primary" size="sm" onClick={() => setCreating((v) => !v)}>
          {creating ? '닫기' : '주문 등록'}
        </Button>
      }
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
      {creating ? (
        <Card title="주문 등록" className="mb-4">
          <FormErrorSummary errors={errors} />
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
            <Field label="주문일" htmlFor="so-date" required>
              <Input
                id="so-date"
                type="date"
                value={header.docDate}
                onChange={(e) => setHeader({ ...header, docDate: e.target.value })}
              />
            </Field>
            <Field label="거래처" htmlFor="so-partner" required>
              <PartnerSelect
                id="so-partner"
                partnerType="CUSTOMER"
                value={header.partnerId}
                onChange={(v) => setHeader({ ...header, partnerId: v })}
              />
            </Field>
            <Field label="납기일" htmlFor="so-delivery">
              <Input
                id="so-delivery"
                type="date"
                value={header.deliveryDate}
                onChange={(e) => setHeader({ ...header, deliveryDate: e.target.value })}
              />
            </Field>
            <Field label="비고" htmlFor="so-note">
              <Input
                id="so-note"
                value={header.note}
                onChange={(e) => setHeader({ ...header, note: e.target.value })}
              />
            </Field>
          </div>

          <div className="mt-4" id="so-lines">
            <TradeLineEditor lines={lines} onChange={setLines} />
          </div>
          <TradeTotals lines={lines} />

          <div className="mt-4 flex gap-1.5">
            <Button variant="primary" size="sm" onClick={submit} disabled={create.isPending}>
              {create.isPending ? '저장 중' : '저장'}
            </Button>
            <Button size="sm" onClick={() => setCreating(false)}>
              취소
            </Button>
          </div>
        </Card>
      ) : null}

      <ExportNotice message={exportNotice} />

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
        emptyDescription="견적서에서 '주문으로 전환'하거나 '주문 등록'으로 직접 생성할 수 있습니다."
        onExport={(list.data?.total ?? 0) > 0 ? exportCsv : undefined}
      />
    </StandardListPage>
  );
}
