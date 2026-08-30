'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, newRequestId } from '@/lib/trpc';
import { StandardListPage } from '@/components/ui/standard-list-page';
import { DataGrid, type Column } from '@/components/ui/data-grid';
import { Button, Card, Field, Input, Select, StatusBadge } from '@/components/ui/primitives';
import { PartnerSelect } from '@/components/sales/partner-select';
import { fmt } from '@/lib/format';
import { businessDate } from '@/lib/dates';

/**
 * SLS-10 — receipts and payments share one screen shape. The allocation is deliberately a
 * separate step from the entry: the operator records the money that arrived, then decides
 * (or accepts the automatic decision) which invoices it settles.
 */
interface Row {
  id: string;
  docNo: string;
  docDate: string;
  status: string;
  partner: { name: string };
  amount: string;
  allocatedAmount: string;
  method: string | null;
}

const STATUS_LABEL: Record<string, string> = {
  DRAFT: '작성중',
  CONFIRMED: '확정',
  CANCELED: '취소',
};

export function SettlementScreen({
  docType,
  title,
  description,
  partnerLabel,
  partnerType,
}: {
  docType: 'RECEIPT' | 'PAYMENT';
  title: string;
  description: string;
  partnerLabel: string;
  partnerType: 'CUSTOMER' | 'SUPPLIER';
}) {
  const router = useRouter();
  const utils = api.useUtils();
  const prefix = docType === 'RECEIPT' ? 'rc' : 'pm';

  const [filters, setFilters] = useState({ status: '', partnerId: '' });
  const [applied, setApplied] = useState(filters);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [creating, setCreating] = useState(false);

  const [form, setForm] = useState({
    docDate: businessDate(new Date()),
    partnerId: '',
    amount: '',
    method: '',
    note: '',
  });
  const [error, setError] = useState<string | null>(null);

  const methods = api.master.codes.useQuery({ groupCode: 'PAYMENT_METHOD', activeOnly: true });
  const create = api.sales.createSettlement.useMutation({ onSuccess: () => utils.sales.invalidate() });
  const list = api.sales.settlements.useQuery({
    docType,
    page,
    pageSize,
    ...(applied.status ? { status: applied.status } : {}),
    ...(applied.partnerId ? { partnerId: applied.partnerId } : {}),
  });

  const columns: Column<Row>[] = [
    { key: 'docNo', header: '전표번호', width: 150 },
    { key: 'docDate', header: '일자', width: 110, render: (r) => fmt.date(r.docDate) },
    { key: 'partner', header: partnerLabel, render: (r) => r.partner.name },
    { key: 'method', header: '수단', width: 110, render: (r) => r.method ?? '-' },
    { key: 'amount', header: '금액', type: 'money', width: 140 },
    { key: 'allocatedAmount', header: '배분', type: 'money', width: 140 },
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
      filterKey={`settlement.${docType}`}
      actions={
        <Button variant="primary" size="sm" onClick={() => setCreating((v) => !v)}>
          {creating ? '닫기' : `${title} 등록`}
        </Button>
      }
      filters={
        <>
          <Field label={partnerLabel} htmlFor={`${prefix}f-partner`}>
            <PartnerSelect
              id={`${prefix}f-partner`}
              includeAll
              partnerType={partnerType}
              value={filters.partnerId}
              onChange={(v) => setFilters({ ...filters, partnerId: v })}
            />
          </Field>
          <Field label="상태" htmlFor={`${prefix}f-status`}>
            <Select
              id={`${prefix}f-status`}
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
        const empty = { status: '', partnerId: '' };
        setFilters(empty);
        setApplied(empty);
      }}
    >
      {creating ? (
        <Card title={`${title} 등록`} className="mb-4">
          {error ? (
            <p role="alert" className="mb-3 rounded bg-red-50 px-3 py-2 text-sm text-red-700">
              {error}
            </p>
          ) : null}
          <form
            className="grid grid-cols-1 gap-3 sm:grid-cols-5"
            onSubmit={async (e) => {
              e.preventDefault();
              setError(null);
              try {
                const created = await create.mutateAsync({
                  docType,
                  docDate: form.docDate,
                  partnerId: form.partnerId,
                  amount: form.amount,
                  ...(form.method ? { method: form.method } : {}),
                  ...(form.note ? { note: form.note } : {}),
                  requestId: newRequestId(),
                });
                setCreating(false);
                router.push(`/settlement/receipts/${created.id}`);
              } catch (err) {
                setError((err as { message?: string }).message ?? '등록에 실패했습니다.');
              }
            }}
          >
            <Field label="일자" htmlFor={`${prefix}-date`} required>
              <Input
                id={`${prefix}-date`}
                type="date"
                value={form.docDate}
                onChange={(e) => setForm({ ...form, docDate: e.target.value })}
              />
            </Field>
            <Field label={partnerLabel} htmlFor={`${prefix}-partner`} required>
              <PartnerSelect
                id={`${prefix}-partner`}
                partnerType={partnerType}
                value={form.partnerId}
                onChange={(v) => setForm({ ...form, partnerId: v })}
              />
            </Field>
            <Field label="금액" htmlFor={`${prefix}-amount`} required>
              <Input
                id={`${prefix}-amount`}
                inputMode="numeric"
                className="text-right"
                value={form.amount}
                onChange={(e) => setForm({ ...form, amount: e.target.value })}
              />
            </Field>
            <Field label="수단" htmlFor={`${prefix}-method`}>
              <Select
                id={`${prefix}-method`}
                value={form.method}
                onChange={(e) => setForm({ ...form, method: e.target.value })}
              >
                <option value="">선택</option>
                {(methods.data ?? []).map((m) => (
                  <option key={m.code} value={m.name}>
                    {m.name}
                  </option>
                ))}
              </Select>
            </Field>
            <div className="flex items-end">
              <Button type="submit" variant="primary" size="sm" disabled={create.isPending}>
                등록
              </Button>
            </div>
          </form>
          <p className="mt-2 text-xs text-slate-500">
            등록 후 배분 화면에서 자동 배분(오래된 미결부터)하거나 직접 배분할 수 있습니다.
          </p>
        </Card>
      ) : null}

      <DataGrid<Row>
        gridKey={`settlement.${docType}`}
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
        onRowOpen={(r) => router.push(`/settlement/receipts/${r.id}`)}
        emptyTitle={`${title} 내역이 없습니다.`}
        emptyDescription={`'${title} 등록'으로 시작하세요.`}
      />
    </StandardListPage>
  );
}
