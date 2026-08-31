'use client';

import { useMemo, useState } from 'react';
import { StandardListPage, useSavedFilters } from '@/components/ui/standard-list-page';
import { DataGrid, type Column } from '@/components/ui/data-grid';
import { VoucherLineEditor, type LineColumn } from '@/components/ui/voucher-line-editor';
import { FormErrorSummary, type FieldError } from '@/components/ui/form-error-summary';
import { AttachmentPanel } from '@/components/ui/attachment-panel';
import {
  Button,
  Card,
  EmptyState,
  ErrorState,
  Field,
  Input,
  Select,
  Spinner,
  StatusBadge,
} from '@/components/ui/primitives';
import { floorTo, mul } from '@/lib/money';
import { downloadCsv, toCsv } from '@/lib/csv';
import { businessDate } from '@/lib/dates';

/**
 * Component gallery (STEP 3 quality gate): every shared component rendered with real
 * behaviour so keyboard operation, empty/error states and viewports can be checked
 * without waiting for business screens. Not linked from the menu.
 */

interface DemoRow {
  id: string;
  docNo: string;
  partner: string;
  status: string;
  docDate: string;
  quantity: string;
  amount: string;
}

const DEMO_ROWS: DemoRow[] = Array.from({ length: 137 }, (_, i) => ({
  id: `row-${i + 1}`,
  docNo: `SL-202608-${String(i + 1).padStart(4, '0')}`,
  partner: ['한빛건재', '대성필름', '오션상사', '가온유통'][i % 4]!,
  status: ['DRAFT', 'PENDING_APPROVAL', 'CONFIRMED', 'CANCELED'][i % 4]!,
  docDate: `2026-08-${String((i % 28) + 1).padStart(2, '0')}`,
  quantity: String((i % 9) + 1),
  amount: String(((i % 9) + 1) * 137_500),
}));

interface DemoLine extends Record<string, string> {
  itemCode: string;
  itemName: string;
  quantity: string;
  unitPrice: string;
  taxType: string;
  supplyAmount: string;
  vatAmount: string;
}

export default function ComponentGalleryPage() {
  // ── StandardListPage + DataGrid ──
  const { filters, setFilters, save, reset } = useSavedFilters('demo.list', {
    keyword: '',
    status: '',
    from: '2026-08-01',
    to: '2026-08-31',
  });
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [sortBy, setSortBy] = useState('docDate');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const [selected, setSelected] = useState<string[]>([]);
  const [gridState, setGridState] = useState<'data' | 'empty' | 'loading' | 'error'>('data');

  const sorted = useMemo(() => {
    const filtered = DEMO_ROWS.filter(
      (r) =>
        (!filters.keyword || r.docNo.includes(filters.keyword) || r.partner.includes(filters.keyword)) &&
        (!filters.status || r.status === filters.status),
    );
    return [...filtered].sort((a, b) => {
      const av = String(a[sortBy as keyof DemoRow] ?? '');
      const bv = String(b[sortBy as keyof DemoRow] ?? '');
      return sortDir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av);
    });
  }, [filters, sortBy, sortDir]);

  const pageRows = gridState === 'empty' ? [] : sorted.slice((page - 1) * pageSize, page * pageSize);

  const columns: Column<DemoRow>[] = [
    { key: 'docNo', header: '전표번호', sortable: true, width: 160 },
    { key: 'docDate', header: '전표일', type: 'date', sortable: true, width: 110 },
    { key: 'partner', header: '거래처', sortable: true },
    { key: 'status', header: '상태', width: 100, render: (r) => <StatusBadge status={r.status} /> },
    { key: 'quantity', header: '수량', type: 'qty', total: true, width: 100 },
    { key: 'amount', header: '금액', type: 'money', total: true, sortable: true, width: 140 },
  ];

  // ── VoucherLineEditor ──
  const lineColumns: LineColumn<DemoLine>[] = [
    {
      key: 'itemCode',
      header: '품목코드',
      kind: 'text',
      required: true,
      width: 140,
      suggestions: [
        { value: 'IT-000001', label: 'IT-000001 · 마감몰딩 3m' },
        { value: 'IT-000002', label: 'IT-000002 · 방염필름 1200mm' },
      ],
    },
    { key: 'itemName', header: '품목명', kind: 'text', width: 200 },
    { key: 'quantity', header: '수량', kind: 'qty', required: true, width: 100 },
    { key: 'unitPrice', header: '단가', kind: 'unitPrice', required: true, width: 120 },
    {
      key: 'taxType',
      header: '과세구분',
      kind: 'select',
      width: 110,
      options: [
        { value: 'TAXABLE', label: '과세' },
        { value: 'ZERO', label: '영세' },
        { value: 'EXEMPT', label: '면세' },
      ],
    },
    { key: 'supplyAmount', header: '공급가액', kind: 'readonly', width: 130, total: true },
    { key: 'vatAmount', header: '부가세', kind: 'readonly', width: 120, total: true },
  ];

  const newLine = (): DemoLine => ({
    itemCode: '',
    itemName: '',
    quantity: '',
    unitPrice: '',
    taxType: 'TAXABLE',
    supplyAmount: '0',
    vatAmount: '0',
  });

  // DEC-02 display-side preview; the server recomputes and is authoritative.
  const recompute = (line: DemoLine): DemoLine => {
    const supply = floorTo(mul(line.quantity || '0', line.unitPrice || '0'));
    const vat = line.taxType === 'TAXABLE' ? floorTo(mul(supply, '0.1')) : floorTo('0');
    return { ...line, supplyAmount: supply.toFixed(0), vatAmount: vat.toFixed(0) };
  };

  const [lines, setLines] = useState<DemoLine[]>([newLine()]);

  // ── FormErrorSummary ──
  const [formErrors, setFormErrors] = useState<FieldError[]>([]);
  const [savedName, setSavedName] = useState('');

  return (
    <div className="flex min-w-0 flex-col gap-8">
      <header>
        <h1 className="text-lg font-semibold">공통 컴포넌트 갤러리</h1>
        <p className="mt-0.5 text-sm text-slate-500">
          STEP 3 산출물 확인용. 실제 업무 화면은 각 모듈 단계에서 이 컴포넌트들을 사용합니다.
        </p>
      </header>

      <section className="flex min-w-0 flex-col gap-3" data-testid="section-grid">
        <h2 className="text-base font-semibold">UIX-02/03 표준 조회 + 그리드</h2>
        <div className="flex flex-wrap gap-1.5">
          {(['data', 'empty', 'loading', 'error'] as const).map((s) => (
            <Button
              key={s}
              size="sm"
              variant={gridState === s ? 'primary' : 'default'}
              onClick={() => setGridState(s)}
            >
              {{ data: '정상', empty: '빈 상태', loading: '로딩', error: '오류' }[s]}
            </Button>
          ))}
        </div>

        <StandardListPage
          title="매출전표 (예시)"
          description="조회조건은 사용자별로 저장되어 다음 접속 시 복원됩니다."
          filterKey="demo.list"
          filters={
            <>
              <Field label="검색어" htmlFor="f-keyword" hint="전표번호 또는 거래처명">
                <Input
                  id="f-keyword"
                  value={filters.keyword}
                  onChange={(e) => setFilters({ ...filters, keyword: e.target.value })}
                />
              </Field>
              <Field label="상태" htmlFor="f-status">
                <Select
                  id="f-status"
                  value={filters.status}
                  onChange={(e) => setFilters({ ...filters, status: e.target.value })}
                >
                  <option value="">전체</option>
                  <option value="DRAFT">작성중</option>
                  <option value="PENDING_APPROVAL">결재중</option>
                  <option value="CONFIRMED">확정</option>
                  <option value="CANCELED">취소</option>
                </Select>
              </Field>
              <Field label="전표일 (시작)" htmlFor="f-from">
                <Input
                  id="f-from"
                  type="date"
                  value={filters.from}
                  onChange={(e) => setFilters({ ...filters, from: e.target.value })}
                />
              </Field>
              <Field label="전표일 (종료)" htmlFor="f-to">
                <Input
                  id="f-to"
                  type="date"
                  value={filters.to}
                  onChange={(e) => setFilters({ ...filters, to: e.target.value })}
                />
              </Field>
            </>
          }
          onSearch={() => {
            setPage(1);
            save(filters);
          }}
          onReset={() => {
            setPage(1);
            reset();
          }}
        >
          <DataGrid<DemoRow>
            gridKey="demo.grid"
            columns={columns}
            rows={pageRows}
            total={gridState === 'empty' ? 0 : sorted.length}
            page={page}
            pageSize={pageSize}
            loading={gridState === 'loading'}
            error={
              gridState === 'error' ? '조회 중 오류가 발생했습니다. 조회 기간을 좁혀 다시 시도하세요.' : null
            }
            onRetry={() => setGridState('data')}
            rowId={(r) => r.id}
            onPageChange={setPage}
            onPageSizeChange={(s) => {
              setPageSize(s);
              setPage(1);
            }}
            sortBy={sortBy}
            sortDir={sortDir}
            onSortChange={(by, dir) => {
              setSortBy(by);
              setSortDir(dir);
            }}
            selectable
            selected={selected}
            onSelectedChange={setSelected}
            onExport={() => {
              // gallery demo only: `sorted` is the whole filtered+sorted set, not just the
              // page on screen — real business screens export the same way (see
              // src/app/(app)/inventory/status/page.tsx) or, when server-paged, through a
              // server export procedure rather than the rows already fetched to the page.
              const csv = toCsv(
                ['전표번호', '전표일', '거래처', '상태', '수량', '금액'],
                sorted.map((r) => [r.docNo, r.docDate, r.partner, r.status, r.quantity, r.amount]),
              );
              downloadCsv(csv, `컴포넌트_갤러리_예시_${businessDate(new Date())}.csv`);
            }}
          />
        </StandardListPage>
      </section>

      <section className="flex min-w-0 flex-col gap-3" data-testid="section-lines">
        <h2 className="text-base font-semibold">UIX-04 전표 라인 편집기</h2>
        <VoucherLineEditor<DemoLine>
          columns={lineColumns}
          lines={lines}
          onChange={setLines}
          newLine={newLine}
          recompute={recompute}
          errors={lines[0]?.quantity === '' ? { 0: { quantity: '수량을 입력하세요.' } } : {}}
        />
      </section>

      <section className="flex min-w-0 flex-col gap-3" data-testid="section-form">
        <h2 className="text-base font-semibold">UIX-05 입력검증과 오류 요약</h2>
        <Card>
          <form
            className="flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              const errs: FieldError[] = [];
              if (!savedName.trim())
                errs.push({ field: 'demo-name', label: '거래처명', message: '거래처명을 입력하세요.' });
              if (savedName.trim().length > 20)
                errs.push({ field: 'demo-name', label: '거래처명', message: '20자 이내로 입력하세요.' });
              setFormErrors(errs);
            }}
          >
            <FormErrorSummary errors={formErrors} />
            <Field
              label="거래처명"
              htmlFor="demo-name"
              required
              error={formErrors.find((e) => e.field === 'demo-name')?.message}
            >
              <Input
                id="demo-name"
                name="demo-name"
                value={savedName}
                aria-invalid={formErrors.some((e) => e.field === 'demo-name')}
                onChange={(e) => setSavedName(e.target.value)}
              />
            </Field>
            <p className="text-xs text-slate-500">저장에 실패해도 입력값은 유지됩니다.</p>
            <div>
              <Button type="submit" variant="primary" size="sm">
                저장
              </Button>
            </div>
          </form>
        </Card>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-base font-semibold">UIX-07 첨부파일</h2>
        <AttachmentPanel ownerType="ITEM" ownerId="demo-item" />
      </section>

      <section className="flex min-w-0 flex-col gap-3" data-testid="section-status">
        <h2 className="text-base font-semibold">상태 표시와 빈/오류 상태</h2>
        <Card>
          <div className="flex flex-wrap gap-2" data-testid="status-badges">
            {[
              'DRAFT',
              'PENDING_APPROVAL',
              'CONFIRMED',
              'CANCELED',
              'APPROVED',
              'REJECTED',
              'ON_HOLD',
              'IN_TRANSIT',
            ].map((s) => (
              <StatusBadge key={s} status={s} />
            ))}
          </div>
        </Card>
        <div className="grid gap-3 md:grid-cols-3">
          <Card>
            <Spinner />
          </Card>
          <Card>
            <EmptyState
              title="조회된 자료가 없습니다."
              description="조회조건을 바꾸거나 기간을 넓혀 다시 조회하세요."
            />
          </Card>
          <Card>
            <ErrorState message="서버와 통신하지 못했습니다." onRetry={() => undefined} />
          </Card>
        </div>
      </section>
    </div>
  );
}
