'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, newRequestId } from '@/lib/trpc';
import { StandardListPage } from '@/components/ui/standard-list-page';
import { DataGrid, type Column } from '@/components/ui/data-grid';
import { Button, Card, Field, Input, Select, StatusBadge } from '@/components/ui/primitives';
import { VoucherLineEditor, type LineColumn } from '@/components/ui/voucher-line-editor';
import { FormErrorSummary, type FieldError } from '@/components/ui/form-error-summary';
import { InternalNotice } from '@/components/accounting/internal-notice';
import { fmt } from '@/lib/format';
import { add, D } from '@/lib/money';
import { businessDate } from '@/lib/dates';

/** ACC-02: manual journal entries — 대체 / 입금 / 출금. */
interface Row {
  id: string;
  entryNo: string;
  entryDate: string;
  entryType: string;
  status: string;
  description: string | null;
  totalDebit: string;
  sourceType: string | null;
  _count: { lines: number };
}

interface Line extends Record<string, string> {
  accountLabel: string;
  debit: string;
  credit: string;
  description: string;
}

const emptyLine = (): Line => ({ accountLabel: '', debit: '', credit: '', description: '' });

const STATUS_LABEL: Record<string, string> = {
  DRAFT: '작성중',
  PENDING_APPROVAL: '결재중',
  CONFIRMED: '확정',
  CANCELED: '취소',
};
const TYPE_LABEL: Record<string, string> = { TRANSFER: '대체', RECEIPT: '입금', PAYMENT: '출금' };

export default function JournalsPage() {
  const router = useRouter();
  const utils = api.useUtils();

  const [filters, setFilters] = useState({ q: '', status: '', entryType: '', from: '', to: '' });
  const [applied, setApplied] = useState(filters);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [creating, setCreating] = useState(false);

  const [header, setHeader] = useState({
    entryDate: businessDate(new Date()),
    entryType: 'TRANSFER',
    description: '',
  });
  const [lines, setLines] = useState<Line[]>([emptyLine(), emptyLine()]);
  const [errors, setErrors] = useState<FieldError[]>([]);

  const accounts = api.accounting.postableAccounts.useQuery();
  const create = api.accounting.createEntry.useMutation({
    onSuccess: () => utils.accounting.invalidate(),
  });
  const list = api.accounting.entries.useQuery({
    page,
    pageSize,
    ...(applied.q ? { q: applied.q } : {}),
    ...(applied.status ? { status: applied.status } : {}),
    ...(applied.entryType ? { entryType: applied.entryType as 'TRANSFER' } : {}),
    ...(applied.from ? { from: applied.from } : {}),
    ...(applied.to ? { to: applied.to } : {}),
  });

  const suggestions = useMemo(
    () => (accounts.data ?? []).map((a) => ({ value: a.id, label: `${a.code} ${a.name}` })),
    [accounts.data],
  );

  const totalDebit = lines.reduce((acc, l) => add(acc, l.debit || '0'), D(0));
  const totalCredit = lines.reduce((acc, l) => add(acc, l.credit || '0'), D(0));
  const balanced = totalDebit.eq(totalCredit) && !totalDebit.isZero();

  const lineColumns: LineColumn<Line>[] = [
    { key: 'accountLabel', header: '계정과목', kind: 'text', required: true, suggestions },
    { key: 'debit', header: '차변', kind: 'money', width: 130, total: true },
    { key: 'credit', header: '대변', kind: 'money', width: 130, total: true },
    { key: 'description', header: '적요', kind: 'text' },
  ];

  const columns: Column<Row>[] = [
    { key: 'entryNo', header: '전표번호', width: 150 },
    { key: 'entryDate', header: '전표일', width: 110, render: (r) => fmt.date(r.entryDate) },
    { key: 'entryType', header: '유형', width: 80, render: (r) => TYPE_LABEL[r.entryType] ?? r.entryType },
    { key: 'description', header: '적요', render: (r) => r.description ?? '-' },
    {
      key: 'sourceType',
      header: '원천',
      width: 110,
      render: (r) => (r.sourceType ? r.sourceType : '수동'),
    },
    { key: 'totalDebit', header: '금액', type: 'money', width: 140 },
    {
      key: 'status',
      header: '상태',
      width: 90,
      render: (r) => <StatusBadge status={r.status} label={STATUS_LABEL[r.status] ?? r.status} />,
    },
  ];

  async function submit() {
    setErrors([]);
    const prepared = lines
      .filter((l) => l.accountLabel.trim() || l.debit.trim() || l.credit.trim())
      .map((l, i) => {
        const match = suggestions.find(
          (s) => s.label === l.accountLabel || s.label.startsWith(`${l.accountLabel.trim()} `),
        );
        return {
          index: i,
          accountId: match?.value ?? '',
          debit: l.debit || undefined,
          credit: l.credit || undefined,
          description: l.description || undefined,
        };
      });

    const missing = prepared.filter((l) => !l.accountId);
    if (missing.length > 0 || prepared.length < 2) {
      setErrors([
        {
          field: 'jv-lines',
          label: '계정과목',
          message:
            prepared.length < 2
              ? '차변·대변 각각 한 줄 이상 입력하세요.'
              : `${missing.map((m) => `${m.index + 1}행`).join(', ')}: 목록에서 계정과목을 선택하세요.`,
        },
      ]);
      return;
    }

    try {
      const entry = await create.mutateAsync({
        entryDate: header.entryDate,
        entryType: header.entryType as 'TRANSFER',
        ...(header.description ? { description: header.description } : {}),
        lines: prepared.map((l) => ({
          accountId: l.accountId,
          ...(l.debit ? { debit: l.debit } : {}),
          ...(l.credit ? { credit: l.credit } : {}),
          ...(l.description ? { description: l.description } : {}),
        })),
        requestId: newRequestId(),
      });
      setCreating(false);
      setLines([emptyLine(), emptyLine()]);
      router.push(`/accounting/journals/${entry.id}`);
    } catch (err) {
      setErrors([
        {
          field: 'jv-date',
          label: '저장',
          message: (err as { message?: string }).message ?? '저장에 실패했습니다.',
        },
      ]);
    }
  }

  return (
    <StandardListPage
      title="회계전표"
      description="대체·입금·출금 전표입니다. 차변과 대변 합계가 같아야 저장되며, 확정 전표는 역분개로만 정정합니다."
      filterKey="accounting.journals"
      actions={
        <Button variant="primary" size="sm" onClick={() => setCreating((v) => !v)}>
          {creating ? '닫기' : '전표 등록'}
        </Button>
      }
      filters={
        <>
          <Field label="검색어" htmlFor="jvf-q" hint="전표번호·적요">
            <Input
              id="jvf-q"
              value={filters.q}
              onChange={(e) => setFilters({ ...filters, q: e.target.value })}
            />
          </Field>
          <Field label="유형" htmlFor="jvf-type">
            <Select
              id="jvf-type"
              value={filters.entryType}
              onChange={(e) => setFilters({ ...filters, entryType: e.target.value })}
            >
              <option value="">전체</option>
              {Object.entries(TYPE_LABEL).map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="상태" htmlFor="jvf-status">
            <Select
              id="jvf-status"
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
            <Field label="시작일" htmlFor="jvf-from">
              <Input
                id="jvf-from"
                type="date"
                value={filters.from}
                onChange={(e) => setFilters({ ...filters, from: e.target.value })}
              />
            </Field>
            <Field label="종료일" htmlFor="jvf-to">
              <Input
                id="jvf-to"
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
        const empty = { q: '', status: '', entryType: '', from: '', to: '' };
        setFilters(empty);
        setApplied(empty);
      }}
    >
      <InternalNotice className="mb-4" />

      {creating ? (
        <Card title="전표 등록" className="mb-4">
          <FormErrorSummary errors={errors} />

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
            <Field label="전표일" htmlFor="jv-date" required>
              <Input
                id="jv-date"
                type="date"
                value={header.entryDate}
                onChange={(e) => setHeader({ ...header, entryDate: e.target.value })}
              />
            </Field>
            <Field label="전표유형" htmlFor="jv-type" required>
              <Select
                id="jv-type"
                value={header.entryType}
                onChange={(e) => setHeader({ ...header, entryType: e.target.value })}
              >
                {Object.entries(TYPE_LABEL).map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="적요" htmlFor="jv-desc" className="sm:col-span-2">
              <Input
                id="jv-desc"
                value={header.description}
                onChange={(e) => setHeader({ ...header, description: e.target.value })}
              />
            </Field>
          </div>

          <div className="mt-4" id="jv-lines">
            <VoucherLineEditor<Line>
              columns={lineColumns}
              lines={lines}
              onChange={setLines}
              newLine={emptyLine}
              minLines={2}
            />
          </div>

          <div className="mt-3 flex flex-wrap items-center justify-end gap-4 text-sm">
            <span>
              차변 <span className="tabular font-medium">{fmt.krw(totalDebit.toString())}</span>
            </span>
            <span>
              대변 <span className="tabular font-medium">{fmt.krw(totalCredit.toString())}</span>
            </span>
            {balanced ? (
              <span className="rounded bg-green-50 px-2 py-0.5 text-xs font-medium text-green-800">
                차대변 일치
              </span>
            ) : (
              <span className="rounded bg-red-50 px-2 py-0.5 text-xs font-medium text-red-700">
                차액 {fmt.krw(totalDebit.minus(totalCredit).abs().toString())}
              </span>
            )}
          </div>

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
        gridKey="accounting.journals"
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
        onRowOpen={(r) => router.push(`/accounting/journals/${r.id}`)}
        emptyTitle="회계전표가 없습니다."
        emptyDescription="'전표 등록'으로 수동 전표를 만들거나, 업무전표를 확정하면 자동분개가 생성됩니다."
      />
    </StandardListPage>
  );
}
