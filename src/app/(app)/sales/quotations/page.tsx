'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, newRequestId } from '@/lib/trpc';
import { StandardListPage } from '@/components/ui/standard-list-page';
import { DataGrid, type Column } from '@/components/ui/data-grid';
import { Button, Card, Field, Input, Select, StatusBadge } from '@/components/ui/primitives';
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

/** SLS-01: quotations. Converted partially into orders; never touch stock or the books. */
interface Row {
  id: string;
  docNo: string;
  docDate: string;
  validUntil: string | null;
  status: string;
  title: string | null;
  partner: { name: string };
  totalAmount: string;
}

const STATUS_LABEL: Record<string, string> = {
  DRAFT: '작성중',
  CONFIRMED: '확정',
  CONVERTED: '전환완료',
  CANCELED: '취소',
  EXPIRED: '기한만료',
};

export default function QuotationsPage() {
  const router = useRouter();
  const utils = api.useUtils();

  const [filters, setFilters] = useState({ q: '', status: '', partnerId: '' });
  const [applied, setApplied] = useState(filters);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [creating, setCreating] = useState(false);

  const [header, setHeader] = useState({
    docDate: businessDate(new Date()),
    validUntil: '',
    partnerId: '',
    title: '',
  });
  const [lines, setLines] = useState<TradeLine[]>([emptyTradeLine()]);
  const [errors, setErrors] = useState<FieldError[]>([]);

  const resolveItems = useItemResolver();
  const create = api.sales.createQuotation.useMutation({ onSuccess: () => utils.sales.invalidate() });
  const list = api.sales.quotations.useQuery({
    page,
    pageSize,
    ...(applied.q ? { q: applied.q } : {}),
    ...(applied.status ? { status: applied.status } : {}),
    ...(applied.partnerId ? { partnerId: applied.partnerId } : {}),
  });

  const columns: Column<Row>[] = [
    { key: 'docNo', header: '견적번호', width: 150 },
    { key: 'docDate', header: '견적일', width: 110, render: (r) => fmt.date(r.docDate) },
    { key: 'partner', header: '거래처', render: (r) => r.partner.name },
    { key: 'title', header: '제목', render: (r) => r.title ?? '-' },
    {
      key: 'validUntil',
      header: '유효기한',
      width: 110,
      render: (r) => (r.validUntil ? fmt.date(r.validUntil) : '-'),
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
      problems.push({ field: 'qt-partner', label: '거래처', message: '거래처를 선택하세요.' });
    if (entered.length === 0) {
      problems.push({ field: 'qt-lines', label: '품목', message: '품목을 한 건 이상 입력하세요.' });
    } else if (resolved && 'errors' in resolved) {
      for (const message of resolved.errors) problems.push({ field: 'qt-lines', label: '품목', message });
    }
    if (problems.length) {
      setErrors(problems);
      return;
    }

    try {
      const q = await create.mutateAsync({
        docDate: header.docDate,
        ...(header.validUntil ? { validUntil: header.validUntil } : {}),
        partnerId: header.partnerId,
        ...(header.title ? { title: header.title } : {}),
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
      router.push(`/sales/quotations/${q.id}`);
    } catch (err) {
      setErrors([
        {
          field: 'qt-date',
          label: '저장',
          message: (err as { message?: string }).message ?? '저장에 실패했습니다.',
        },
      ]);
    }
  }

  return (
    <StandardListPage
      title="견적서"
      description="견적은 주문으로 부분 전환할 수 있고, 전환된 수량만큼 잔여수량이 줄어듭니다."
      filterKey="sales.quotations"
      actions={
        <Button variant="primary" size="sm" onClick={() => setCreating((v) => !v)}>
          {creating ? '닫기' : '견적 등록'}
        </Button>
      }
      filters={
        <>
          <Field label="검색어" htmlFor="qtf-q" hint="견적번호·제목·거래처명">
            <Input
              id="qtf-q"
              value={filters.q}
              onChange={(e) => setFilters({ ...filters, q: e.target.value })}
            />
          </Field>
          <Field label="거래처" htmlFor="qtf-partner">
            <PartnerSelect
              id="qtf-partner"
              includeAll
              partnerType="CUSTOMER"
              value={filters.partnerId}
              onChange={(v) => setFilters({ ...filters, partnerId: v })}
            />
          </Field>
          <Field label="상태" htmlFor="qtf-status">
            <Select
              id="qtf-status"
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
        <Card title="견적 등록" className="mb-4">
          <FormErrorSummary errors={errors} />
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
            <Field label="견적일" htmlFor="qt-date" required>
              <Input
                id="qt-date"
                type="date"
                value={header.docDate}
                onChange={(e) => setHeader({ ...header, docDate: e.target.value })}
              />
            </Field>
            <Field label="거래처" htmlFor="qt-partner" required>
              <PartnerSelect
                id="qt-partner"
                partnerType="CUSTOMER"
                value={header.partnerId}
                onChange={(v) => setHeader({ ...header, partnerId: v })}
              />
            </Field>
            <Field label="유효기한" htmlFor="qt-valid">
              <Input
                id="qt-valid"
                type="date"
                value={header.validUntil}
                onChange={(e) => setHeader({ ...header, validUntil: e.target.value })}
              />
            </Field>
            <Field label="제목" htmlFor="qt-title">
              <Input
                id="qt-title"
                value={header.title}
                onChange={(e) => setHeader({ ...header, title: e.target.value })}
              />
            </Field>
          </div>

          <div className="mt-4" id="qt-lines">
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
        gridKey="sales.quotations"
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
        onRowOpen={(r) => router.push(`/sales/quotations/${r.id}`)}
        emptyTitle="견적서가 없습니다."
        emptyDescription="'견적 등록'으로 시작하세요."
      />
    </StandardListPage>
  );
}
