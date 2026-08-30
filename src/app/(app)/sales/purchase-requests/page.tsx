'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, newRequestId } from '@/lib/trpc';
import { StandardListPage } from '@/components/ui/standard-list-page';
import { DataGrid, type Column } from '@/components/ui/data-grid';
import { Button, Card, Field, Input, Select, StatusBadge } from '@/components/ui/primitives';
import { FormErrorSummary, type FieldError } from '@/components/ui/form-error-summary';
import {
  emptyTradeLine,
  useItemResolver,
  TradeLineEditor,
  TradeTotals,
  type TradeLine,
} from '@/components/sales/trade-line-editor';
import { fmt } from '@/lib/format';
import { businessDate } from '@/lib/dates';

/** SLS-13: purchase requests. Always require approval (DEC-03) before they can be ordered. */
interface Row {
  id: string;
  docNo: string;
  docDate: string;
  requiredDate: string | null;
  status: string;
  purpose: string | null;
  division: { name: string } | null;
  totalAmount: string;
}

const STATUS_LABEL: Record<string, string> = {
  DRAFT: '작성중',
  PENDING_APPROVAL: '결재중',
  APPROVED: '승인',
  REJECTED: '반려',
  ORDERED: '발주완료',
  CANCELED: '취소',
};

export default function PurchaseRequestsPage() {
  const router = useRouter();
  const utils = api.useUtils();

  const [filters, setFilters] = useState({ q: '', status: '' });
  const [applied, setApplied] = useState(filters);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [creating, setCreating] = useState(false);

  const [header, setHeader] = useState({
    docDate: businessDate(new Date()),
    requiredDate: '',
    purpose: '',
  });
  const [lines, setLines] = useState<TradeLine[]>([emptyTradeLine()]);
  const [errors, setErrors] = useState<FieldError[]>([]);

  const resolveItems = useItemResolver();
  const create = api.sales.createPurchaseRequest.useMutation({
    onSuccess: () => utils.sales.invalidate(),
  });
  const list = api.sales.purchaseRequests.useQuery({
    page,
    pageSize,
    ...(applied.q ? { q: applied.q } : {}),
    ...(applied.status ? { status: applied.status } : {}),
  });

  const columns: Column<Row>[] = [
    { key: 'docNo', header: '요청번호', width: 150 },
    { key: 'docDate', header: '요청일', width: 110, render: (r) => fmt.date(r.docDate) },
    { key: 'purpose', header: '목적', render: (r) => r.purpose ?? '-' },
    { key: 'division', header: '사업부', width: 120, render: (r) => r.division?.name ?? '-' },
    {
      key: 'requiredDate',
      header: '필요일',
      width: 110,
      render: (r) => (r.requiredDate ? fmt.date(r.requiredDate) : '-'),
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

    if (entered.length === 0) {
      setErrors([{ field: 'pr-lines', label: '품목', message: '품목을 한 건 이상 입력하세요.' }]);
      return;
    }
    if (resolved && 'errors' in resolved) {
      setErrors(resolved.errors.map((message) => ({ field: 'pr-lines', label: '품목', message })));
      return;
    }

    try {
      const request = await create.mutateAsync({
        docDate: header.docDate,
        ...(header.requiredDate ? { requiredDate: header.requiredDate } : {}),
        ...(header.purpose ? { purpose: header.purpose } : {}),
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
      router.push(`/sales/purchase-requests/${request.id}`);
    } catch (err) {
      setErrors([
        {
          field: 'pr-date',
          label: '저장',
          message: (err as { message?: string }).message ?? '저장에 실패했습니다.',
        },
      ]);
    }
  }

  return (
    <StandardListPage
      title="구매요청"
      description="구매요청은 결재 승인 후에만 발주할 수 있습니다. 부분 발주가 가능하며 잔여수량이 관리됩니다."
      filterKey="sales.purchaseRequests"
      actions={
        <Button variant="primary" size="sm" onClick={() => setCreating((v) => !v)}>
          {creating ? '닫기' : '구매요청 등록'}
        </Button>
      }
      filters={
        <>
          <Field label="검색어" htmlFor="prf-q" hint="요청번호">
            <Input
              id="prf-q"
              value={filters.q}
              onChange={(e) => setFilters({ ...filters, q: e.target.value })}
            />
          </Field>
          <Field label="상태" htmlFor="prf-status">
            <Select
              id="prf-status"
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
        const empty = { q: '', status: '' };
        setFilters(empty);
        setApplied(empty);
      }}
    >
      {creating ? (
        <Card title="구매요청 등록" className="mb-4">
          <FormErrorSummary errors={errors} />
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Field label="요청일" htmlFor="pr-date" required>
              <Input
                id="pr-date"
                type="date"
                value={header.docDate}
                onChange={(e) => setHeader({ ...header, docDate: e.target.value })}
              />
            </Field>
            <Field label="필요일" htmlFor="pr-required">
              <Input
                id="pr-required"
                type="date"
                value={header.requiredDate}
                onChange={(e) => setHeader({ ...header, requiredDate: e.target.value })}
              />
            </Field>
            <Field label="목적" htmlFor="pr-purpose">
              <Input
                id="pr-purpose"
                value={header.purpose}
                onChange={(e) => setHeader({ ...header, purpose: e.target.value })}
              />
            </Field>
          </div>

          <div className="mt-4" id="pr-lines">
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

      <DataGrid<Row>
        gridKey="sales.purchaseRequests"
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
        onRowOpen={(r) => router.push(`/sales/purchase-requests/${r.id}`)}
        emptyTitle="구매요청이 없습니다."
        emptyDescription="'구매요청 등록'으로 시작하세요."
      />
    </StandardListPage>
  );
}
