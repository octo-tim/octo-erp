'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, newRequestId } from '@/lib/trpc';
import { StandardListPage, useSavedFilters } from '@/components/ui/standard-list-page';
import { DataGrid, type Column } from '@/components/ui/data-grid';
import { Button, Card, Field, Input, Select, StatusBadge } from '@/components/ui/primitives';
import { FormErrorSummary, type FieldError } from '@/components/ui/form-error-summary';

/** BAS-01/BAS-02: item list and registration. */
const TAX_LABEL: Record<string, string> = { TAXABLE: '과세', ZERO: '영세', EXEMPT: '면세' };

interface Row {
  id: string;
  code: string;
  name: string;
  spec: string | null;
  unitCode: string;
  taxType: string;
  salesPrice: string | null;
  purchasePrice: string | null;
  safetyStock: string | null;
  isActive: boolean;
  category: { code: string; name: string } | null;
  defaultSupplier: { code: string; name: string } | null;
}

export default function ItemListPage() {
  const router = useRouter();
  const { filters, setFilters, save, reset } = useSavedFilters('master.items', {
    q: '',
    categoryId: '',
    taxType: '',
    activeOnly: true,
  });
  const [applied, setApplied] = useState(filters);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [creating, setCreating] = useState(false);

  const categories = api.master.itemCategories.useQuery();
  const list = api.master.items.useQuery({
    page,
    pageSize,
    sortDir: 'asc',
    activeOnly: applied.activeOnly,
    ...(applied.q ? { q: applied.q } : {}),
    ...(applied.categoryId ? { categoryId: applied.categoryId } : {}),
    ...(applied.taxType ? { taxType: applied.taxType as 'TAXABLE' } : {}),
  });

  const columns: Column<Row>[] = [
    { key: 'code', header: '품목코드', width: 120 },
    { key: 'name', header: '품목명' },
    { key: 'spec', header: '규격', width: 140, render: (r) => r.spec ?? '-' },
    { key: 'unitCode', header: '단위', width: 70 },
    { key: 'category', header: '분류', width: 130, render: (r) => r.category?.name ?? '-' },
    { key: 'taxType', header: '과세', width: 70, render: (r) => TAX_LABEL[r.taxType] ?? r.taxType },
    { key: 'purchasePrice', header: '입고단가', type: 'money', width: 110 },
    { key: 'salesPrice', header: '출고단가', type: 'money', width: 110 },
    { key: 'safetyStock', header: '안전재고', type: 'qty', width: 100 },
    {
      key: 'isActive',
      header: '사용',
      width: 80,
      render: (r) => (
        <StatusBadge status={r.isActive ? 'CONFIRMED' : 'CANCELED'} label={r.isActive ? '사용' : '중지'} />
      ),
    },
  ];

  return (
    <StandardListPage
      title="품목"
      description="품목 기본정보와 안전재고·리드타임 등 부가정보를 관리합니다."
      filterKey="master.items"
      actions={
        <>
          <Button size="sm" onClick={() => router.push('/master/items/bulk')}>
            일괄등록
          </Button>
          <Button variant="primary" size="sm" onClick={() => setCreating((v) => !v)}>
            {creating ? '닫기' : '품목 등록'}
          </Button>
        </>
      }
      filters={
        <>
          <Field label="검색어" htmlFor="it-q" hint="코드·품목명·규격·바코드">
            <Input
              id="it-q"
              value={filters.q}
              onChange={(e) => setFilters({ ...filters, q: e.target.value })}
            />
          </Field>
          <Field label="분류" htmlFor="it-cat">
            <Select
              id="it-cat"
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
          <Field label="과세구분" htmlFor="it-tax">
            <Select
              id="it-tax"
              value={filters.taxType}
              onChange={(e) => setFilters({ ...filters, taxType: e.target.value })}
            >
              <option value="">전체</option>
              <option value="TAXABLE">과세</option>
              <option value="ZERO">영세</option>
              <option value="EXEMPT">면세</option>
            </Select>
          </Field>
          <Field label="사용여부" htmlFor="it-active">
            <Select
              id="it-active"
              value={filters.activeOnly ? 'Y' : 'N'}
              onChange={(e) => setFilters({ ...filters, activeOnly: e.target.value === 'Y' })}
            >
              <option value="Y">사용중만</option>
              <option value="N">전체</option>
            </Select>
          </Field>
        </>
      }
      onSearch={() => {
        setApplied(filters);
        setPage(1);
        save(filters);
      }}
      onReset={() => {
        reset();
        setApplied({ q: '', categoryId: '', taxType: '', activeOnly: true });
        setPage(1);
      }}
    >
      {creating ? (
        <ItemForm
          categories={(categories.data ?? []).filter((c) => c.level === 3)}
          onDone={() => {
            setCreating(false);
            void list.refetch();
          }}
        />
      ) : null}

      <DataGrid<Row>
        gridKey="master.items"
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
        onRowOpen={(r) => router.push(`/master/items/${r.id}`)}
        emptyTitle="등록된 품목이 없습니다."
        emptyDescription="'품목 등록'으로 한 건씩 등록하거나 '일괄등록'으로 엑셀 양식을 올릴 수 있습니다."
      />
    </StandardListPage>
  );
}

function ItemForm({
  categories,
  onDone,
}: {
  categories: { id: string; name: string }[];
  onDone: () => void;
}) {
  const create = api.master.createItem.useMutation();
  const units = api.master.codes.useQuery({ groupCode: 'UNIT', activeOnly: true });
  const [errors, setErrors] = useState<FieldError[]>([]);
  const [form, setForm] = useState({
    name: '',
    spec: '',
    unitCode: 'EA',
    categoryId: '',
    taxType: 'TAXABLE' as 'TAXABLE' | 'ZERO' | 'EXEMPT',
    purchasePrice: '',
    salesPrice: '',
    safetyStock: '',
    leadTimeDays: '',
    barcode: '',
  });

  return (
    <Card title="품목 등록">
      <form
        className="flex flex-col gap-3"
        onSubmit={async (e) => {
          e.preventDefault();
          const found: FieldError[] = [];
          if (!form.name.trim())
            found.push({ field: 'it-name', label: '품목명', message: '품목명을 입력하세요.' });
          setErrors(found);
          if (found.length) return;
          try {
            await create.mutateAsync({
              name: form.name.trim(),
              unitCode: form.unitCode,
              taxType: form.taxType,
              ...(form.spec ? { spec: form.spec } : {}),
              ...(form.categoryId ? { categoryId: form.categoryId } : {}),
              ...(form.purchasePrice ? { purchasePrice: form.purchasePrice } : {}),
              ...(form.salesPrice ? { salesPrice: form.salesPrice } : {}),
              ...(form.safetyStock ? { safetyStock: form.safetyStock } : {}),
              ...(form.leadTimeDays ? { leadTimeDays: Number(form.leadTimeDays) } : {}),
              ...(form.barcode ? { barcode: form.barcode } : {}),
              requestId: newRequestId(),
            });
            onDone();
          } catch (err) {
            setErrors([
              {
                field: 'it-name',
                label: '저장',
                message: (err as { message?: string }).message ?? '저장에 실패했습니다.',
              },
            ]);
          }
        }}
      >
        <FormErrorSummary errors={errors} />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="품목명" htmlFor="it-name" required>
            <Input
              id="it-name"
              name="it-name"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          </Field>
          <Field label="규격" htmlFor="it-spec">
            <Input
              id="it-spec"
              value={form.spec}
              onChange={(e) => setForm({ ...form, spec: e.target.value })}
            />
          </Field>
          <Field label="단위" htmlFor="it-unit">
            <Select
              id="it-unit"
              value={form.unitCode}
              onChange={(e) => setForm({ ...form, unitCode: e.target.value })}
            >
              {(units.data ?? []).map((u) => (
                <option key={u.code} value={u.code}>
                  {u.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="분류" htmlFor="it-form-cat" hint="최하위 분류만 선택할 수 있습니다.">
            <Select
              id="it-form-cat"
              value={form.categoryId}
              onChange={(e) => setForm({ ...form, categoryId: e.target.value })}
            >
              <option value="">미지정</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="과세구분" htmlFor="it-form-tax">
            <Select
              id="it-form-tax"
              value={form.taxType}
              onChange={(e) => setForm({ ...form, taxType: e.target.value as typeof form.taxType })}
            >
              <option value="TAXABLE">과세</option>
              <option value="ZERO">영세</option>
              <option value="EXEMPT">면세</option>
            </Select>
          </Field>
          <Field label="입고단가" htmlFor="it-buy">
            <Input
              id="it-buy"
              className="tabular text-right"
              value={form.purchasePrice}
              onChange={(e) => setForm({ ...form, purchasePrice: e.target.value })}
            />
          </Field>
          <Field label="출고단가" htmlFor="it-sell">
            <Input
              id="it-sell"
              className="tabular text-right"
              value={form.salesPrice}
              onChange={(e) => setForm({ ...form, salesPrice: e.target.value })}
            />
          </Field>
          <Field label="안전재고" htmlFor="it-safety">
            <Input
              id="it-safety"
              className="tabular text-right"
              value={form.safetyStock}
              onChange={(e) => setForm({ ...form, safetyStock: e.target.value })}
            />
          </Field>
          <Field label="리드타임(일)" htmlFor="it-lead">
            <Input
              id="it-lead"
              className="tabular text-right"
              value={form.leadTimeDays}
              onChange={(e) => setForm({ ...form, leadTimeDays: e.target.value })}
            />
          </Field>
          <Field label="바코드" htmlFor="it-barcode" hint="EAN-8 또는 EAN-13">
            <Input
              id="it-barcode"
              value={form.barcode}
              onChange={(e) => setForm({ ...form, barcode: e.target.value })}
            />
          </Field>
        </div>
        <p className="text-xs text-slate-500">품목코드는 자동 채번됩니다.</p>
        <div className="flex justify-end gap-1.5">
          <Button type="button" size="sm" onClick={onDone}>
            취소
          </Button>
          <Button type="submit" size="sm" variant="primary" disabled={create.isPending}>
            저장
          </Button>
        </div>
      </form>
    </Card>
  );
}
