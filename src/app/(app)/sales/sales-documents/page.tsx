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

/** SLS-05: sales documents. Confirming one issues stock, raises the receivable and posts. */
interface Row {
  id: string;
  docNo: string;
  docDate: string;
  docType: string;
  status: string;
  partner: { name: string };
  warehouse: { name: string };
  supplyAmount: string;
  vatAmount: string;
  totalAmount: string;
}

const STATUS_LABEL: Record<string, string> = {
  DRAFT: '작성중',
  PENDING_APPROVAL: '결재중',
  CONFIRMED: '확정',
  CANCELED: '취소',
};

export default function SalesDocumentsPage() {
  const router = useRouter();
  const utils = api.useUtils();

  const [filters, setFilters] = useState({ q: '', status: '', partnerId: '', from: '', to: '' });
  const [applied, setApplied] = useState(filters);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [creating, setCreating] = useState(false);

  const [header, setHeader] = useState({
    docDate: businessDate(new Date()),
    partnerId: '',
    warehouseId: '',
    note: '',
  });
  const [lines, setLines] = useState<TradeLine[]>([emptyTradeLine()]);
  const [errors, setErrors] = useState<FieldError[]>([]);

  const warehouses = api.master.warehouses.useQuery({ activeOnly: true });
  const resolveItems = useItemResolver();
  const create = api.sales.createSalesDocument.useMutation({
    onSuccess: () => utils.sales.invalidate(),
  });
  const list = api.sales.salesDocuments.useQuery({
    docType: 'SALES',
    page,
    pageSize,
    ...(applied.q ? { q: applied.q } : {}),
    ...(applied.status ? { status: applied.status } : {}),
    ...(applied.partnerId ? { partnerId: applied.partnerId } : {}),
    ...(applied.from ? { from: applied.from } : {}),
    ...(applied.to ? { to: applied.to } : {}),
  });

  const [exportNotice, setExportNotice] = useState<string | null>(null);
  const csvQuery = api.sales.salesDocumentsCsv.useQuery(
    {
      docType: 'SALES',
      ...(applied.q ? { q: applied.q } : {}),
      ...(applied.status ? { status: applied.status } : {}),
      ...(applied.partnerId ? { partnerId: applied.partnerId } : {}),
      ...(applied.from ? { from: applied.from } : {}),
      ...(applied.to ? { to: applied.to } : {}),
    },
    { enabled: false },
  );

  async function exportCsv() {
    const period = `${applied.from || '처음'}_${applied.to || businessDate(new Date())}`;
    setExportNotice(await runServerCsvExport(() => csvQuery.refetch(), `매출전표_${period}.csv`));
  }

  const columns: Column<Row>[] = [
    { key: 'docNo', header: '전표번호', width: 150 },
    { key: 'docDate', header: '전표일', width: 110, render: (r) => fmt.date(r.docDate) },
    { key: 'partner', header: '거래처', render: (r) => r.partner.name },
    { key: 'warehouse', header: '창고', width: 120, render: (r) => r.warehouse.name },
    { key: 'supplyAmount', header: '공급가액', type: 'money', width: 130 },
    { key: 'vatAmount', header: '세액', type: 'money', width: 110 },
    { key: 'totalAmount', header: '합계', type: 'money', width: 140 },
    {
      key: 'status',
      header: '상태',
      width: 90,
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
      problems.push({ field: 'sd-partner', label: '거래처', message: '거래처를 선택하세요.' });
    if (!header.warehouseId) problems.push({ field: 'sd-wh', label: '창고', message: '창고를 선택하세요.' });
    if (entered.length === 0) {
      problems.push({ field: 'sd-lines', label: '품목', message: '품목을 한 건 이상 입력하세요.' });
    } else if (resolved && 'errors' in resolved) {
      for (const message of resolved.errors) problems.push({ field: 'sd-lines', label: '품목', message });
    }
    if (problems.length) {
      setErrors(problems);
      return;
    }

    try {
      const doc = await create.mutateAsync({
        docDate: header.docDate,
        partnerId: header.partnerId,
        warehouseId: header.warehouseId,
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
      router.push(`/sales/sales-documents/${doc.id}`);
    } catch (err) {
      setErrors([
        {
          field: 'sd-date',
          label: '저장',
          message: (err as { message?: string }).message ?? '저장에 실패했습니다.',
        },
      ]);
    }
  }

  return (
    <StandardListPage
      title="매출전표"
      description="확정 시 재고 출고, 미수금, 회계 분개가 하나의 트랜잭션으로 함께 처리됩니다."
      filterKey="sales.documents"
      actions={
        <Button variant="primary" size="sm" onClick={() => setCreating((v) => !v)}>
          {creating ? '닫기' : '매출전표 등록'}
        </Button>
      }
      filters={
        <>
          <Field label="검색어" htmlFor="sdf-q" hint="전표번호·거래처명">
            <Input
              id="sdf-q"
              value={filters.q}
              onChange={(e) => setFilters({ ...filters, q: e.target.value })}
            />
          </Field>
          <Field label="거래처" htmlFor="sdf-partner">
            <PartnerSelect
              id="sdf-partner"
              includeAll
              partnerType="CUSTOMER"
              value={filters.partnerId}
              onChange={(v) => setFilters({ ...filters, partnerId: v })}
            />
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
        const empty = { q: '', status: '', partnerId: '', from: '', to: '' };
        setFilters(empty);
        setApplied(empty);
      }}
    >
      {creating ? (
        <Card title="매출전표 등록" className="mb-4">
          <FormErrorSummary errors={errors} />

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
            <Field label="전표일" htmlFor="sd-date" required>
              <Input
                id="sd-date"
                type="date"
                value={header.docDate}
                onChange={(e) => setHeader({ ...header, docDate: e.target.value })}
              />
            </Field>
            <Field label="거래처" htmlFor="sd-partner" required>
              <PartnerSelect
                id="sd-partner"
                partnerType="CUSTOMER"
                value={header.partnerId}
                onChange={(v) => setHeader({ ...header, partnerId: v })}
              />
            </Field>
            <Field label="출고 창고" htmlFor="sd-wh" required>
              <Select
                id="sd-wh"
                value={header.warehouseId}
                onChange={(e) => setHeader({ ...header, warehouseId: e.target.value })}
              >
                <option value="">선택</option>
                {(warehouses.data ?? []).map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="비고" htmlFor="sd-note">
              <Input
                id="sd-note"
                value={header.note}
                onChange={(e) => setHeader({ ...header, note: e.target.value })}
              />
            </Field>
          </div>

          <div className="mt-4" id="sd-lines">
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
        gridKey="sales.documents"
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
        onRowOpen={(r) => router.push(`/sales/sales-documents/${r.id}`)}
        emptyTitle="매출전표가 없습니다."
        emptyDescription="'매출전표 등록'으로 등록하거나 주문에서 전환하세요."
        onExport={(list.data?.total ?? 0) > 0 ? exportCsv : undefined}
      />
    </StandardListPage>
  );
}
