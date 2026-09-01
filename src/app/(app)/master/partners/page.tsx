'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, newRequestId } from '@/lib/trpc';
import { StandardListPage, useSavedFilters } from '@/components/ui/standard-list-page';
import { DataGrid, type Column } from '@/components/ui/data-grid';
import { Button, Card, ExportNotice, Field, Input, Select, StatusBadge } from '@/components/ui/primitives';
import { FormErrorSummary, type FieldError } from '@/components/ui/form-error-summary';
import { formatBusinessNo } from '@/server/modules/master/validation';
import { runServerCsvExport } from '@/lib/csv';
import { businessDate } from '@/lib/dates';

/** BAS-04: partner list and registration with contacts. */
const TYPE_LABEL: Record<string, string> = { CUSTOMER: '매출처', SUPPLIER: '매입처', BOTH: '매출·매입' };

interface Row {
  id: string;
  code: string;
  name: string;
  businessNo: string | null;
  ceoName: string | null;
  partnerType: string;
  paymentTerms: string | null;
  creditLimit: string | null;
  isActive: boolean;
  contacts: { name: string; phone: string | null }[];
}

export default function PartnerListPage() {
  const router = useRouter();
  const { filters, setFilters, save, reset } = useSavedFilters('master.partners', {
    q: '',
    partnerType: '',
    activeOnly: true,
  });
  const [applied, setApplied] = useState(filters);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [creating, setCreating] = useState(false);

  const list = api.master.partners.useQuery({
    page,
    pageSize,
    sortDir: 'asc',
    activeOnly: applied.activeOnly,
    ...(applied.q ? { q: applied.q } : {}),
    ...(applied.partnerType ? { partnerType: applied.partnerType as 'CUSTOMER' } : {}),
  });

  const [exportNotice, setExportNotice] = useState<string | null>(null);
  const csvQuery = api.master.partnersCsv.useQuery(
    {
      activeOnly: applied.activeOnly,
      ...(applied.q ? { q: applied.q } : {}),
      ...(applied.partnerType ? { partnerType: applied.partnerType as 'CUSTOMER' } : {}),
    },
    { enabled: false },
  );

  async function exportCsv() {
    setExportNotice(
      await runServerCsvExport(() => csvQuery.refetch(), `거래처_${businessDate(new Date())}.csv`),
    );
  }

  const columns: Column<Row>[] = [
    { key: 'code', header: '거래처코드', width: 120 },
    { key: 'name', header: '거래처명' },
    {
      key: 'businessNo',
      header: '사업자번호',
      width: 130,
      render: (r) => (r.businessNo ? formatBusinessNo(r.businessNo) : '-'),
    },
    { key: 'ceoName', header: '대표자', width: 100, render: (r) => r.ceoName ?? '-' },
    {
      key: 'partnerType',
      header: '거래유형',
      width: 110,
      render: (r) => TYPE_LABEL[r.partnerType] ?? r.partnerType,
    },
    { key: 'paymentTerms', header: '결제조건', width: 110, render: (r) => r.paymentTerms ?? '-' },
    { key: 'creditLimit', header: '여신한도', type: 'money', width: 130 },
    { key: 'contact', header: '담당자', width: 140, render: (r) => r.contacts[0]?.name ?? '-' },
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
      title="거래처"
      description="매출처·매입처 정보와 결제조건·여신한도를 관리합니다."
      filterKey="master.partners"
      actions={
        <Button variant="primary" size="sm" onClick={() => setCreating((v) => !v)}>
          {creating ? '닫기' : '거래처 등록'}
        </Button>
      }
      filters={
        <>
          <Field label="검색어" htmlFor="pt-q" hint="코드·거래처명·사업자번호">
            <Input
              id="pt-q"
              value={filters.q}
              onChange={(e) => setFilters({ ...filters, q: e.target.value })}
            />
          </Field>
          <Field label="거래유형" htmlFor="pt-type">
            <Select
              id="pt-type"
              value={filters.partnerType}
              onChange={(e) => setFilters({ ...filters, partnerType: e.target.value })}
            >
              <option value="">전체</option>
              <option value="CUSTOMER">매출처</option>
              <option value="SUPPLIER">매입처</option>
            </Select>
          </Field>
          <Field label="사용여부" htmlFor="pt-active">
            <Select
              id="pt-active"
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
        setApplied({ q: '', partnerType: '', activeOnly: true });
        setPage(1);
      }}
    >
      {creating ? (
        <PartnerForm
          onDone={() => {
            setCreating(false);
            void list.refetch();
          }}
        />
      ) : null}

      <ExportNotice message={exportNotice} />

      <DataGrid<Row>
        gridKey="master.partners"
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
        onRowOpen={(r) => router.push(`/master/partners/${r.id}`)}
        emptyTitle="등록된 거래처가 없습니다."
        emptyDescription="매출처·매입처를 등록하면 견적·주문·매입전표에서 바로 선택할 수 있습니다."
        emptyAction={
          !creating ? (
            <Button variant="primary" size="sm" onClick={() => setCreating(true)}>
              지금 등록하기
            </Button>
          ) : undefined
        }
        onExport={(list.data?.total ?? 0) > 0 ? exportCsv : undefined}
      />
    </StandardListPage>
  );
}

function PartnerForm({ onDone }: { onDone: () => void }) {
  const create = api.master.createPartner.useMutation();
  const terms = api.master.codes.useQuery({ groupCode: 'PAYMENT_TERMS', activeOnly: true });
  const [errors, setErrors] = useState<FieldError[]>([]);
  const [form, setForm] = useState({
    name: '',
    businessNo: '',
    ceoName: '',
    businessType: '',
    businessItem: '',
    partnerType: 'BOTH' as 'CUSTOMER' | 'SUPPLIER' | 'BOTH',
    paymentTerms: '',
    creditLimit: '',
    phone: '',
    address: '',
    contactName: '',
    contactPhone: '',
  });

  return (
    <Card title="거래처 등록">
      <form
        className="flex flex-col gap-3"
        onSubmit={async (e) => {
          e.preventDefault();
          const found: FieldError[] = [];
          if (!form.name.trim())
            found.push({ field: 'pt-name', label: '거래처명', message: '거래처명을 입력하세요.' });
          setErrors(found);
          if (found.length) return;
          try {
            await create.mutateAsync({
              name: form.name.trim(),
              partnerType: form.partnerType,
              ...(form.businessNo ? { businessNo: form.businessNo } : {}),
              ...(form.ceoName ? { ceoName: form.ceoName } : {}),
              ...(form.businessType ? { businessType: form.businessType } : {}),
              ...(form.businessItem ? { businessItem: form.businessItem } : {}),
              ...(form.paymentTerms ? { paymentTerms: form.paymentTerms } : {}),
              ...(form.creditLimit ? { creditLimit: form.creditLimit } : {}),
              ...(form.phone ? { phone: form.phone } : {}),
              ...(form.address ? { address: form.address } : {}),
              ...(form.contactName
                ? {
                    contacts: [
                      { name: form.contactName, phone: form.contactPhone || undefined, isPrimary: true },
                    ],
                  }
                : {}),
              requestId: newRequestId(),
            });
            onDone();
          } catch (err) {
            setErrors([
              {
                field: 'pt-name',
                label: '저장',
                message: (err as { message?: string }).message ?? '저장에 실패했습니다.',
              },
            ]);
          }
        }}
      >
        <FormErrorSummary errors={errors} />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="거래처명" htmlFor="pt-name" required>
            <Input
              id="pt-name"
              name="pt-name"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          </Field>
          <Field label="사업자등록번호" htmlFor="pt-bizno" hint="없으면 비워둘 수 있습니다.">
            <Input
              id="pt-bizno"
              value={form.businessNo}
              onChange={(e) => setForm({ ...form, businessNo: e.target.value })}
            />
          </Field>
          <Field label="대표자" htmlFor="pt-ceo">
            <Input
              id="pt-ceo"
              value={form.ceoName}
              onChange={(e) => setForm({ ...form, ceoName: e.target.value })}
            />
          </Field>
          <Field label="거래유형" htmlFor="pt-form-type">
            <Select
              id="pt-form-type"
              value={form.partnerType}
              onChange={(e) => setForm({ ...form, partnerType: e.target.value as typeof form.partnerType })}
            >
              <option value="BOTH">매출·매입</option>
              <option value="CUSTOMER">매출처</option>
              <option value="SUPPLIER">매입처</option>
            </Select>
          </Field>
          <Field label="업태" htmlFor="pt-btype">
            <Input
              id="pt-btype"
              value={form.businessType}
              onChange={(e) => setForm({ ...form, businessType: e.target.value })}
            />
          </Field>
          <Field label="종목" htmlFor="pt-bitem">
            <Input
              id="pt-bitem"
              value={form.businessItem}
              onChange={(e) => setForm({ ...form, businessItem: e.target.value })}
            />
          </Field>
          <Field label="결제조건" htmlFor="pt-terms">
            <Select
              id="pt-terms"
              value={form.paymentTerms}
              onChange={(e) => setForm({ ...form, paymentTerms: e.target.value })}
            >
              <option value="">미지정</option>
              {(terms.data ?? []).map((t) => (
                <option key={t.code} value={t.code}>
                  {t.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="여신한도" htmlFor="pt-credit" hint="매출 확정 시 초과를 차단합니다.">
            <Input
              id="pt-credit"
              className="tabular text-right"
              value={form.creditLimit}
              onChange={(e) => setForm({ ...form, creditLimit: e.target.value })}
            />
          </Field>
          <Field label="전화번호" htmlFor="pt-phone">
            <Input
              id="pt-phone"
              value={form.phone}
              onChange={(e) => setForm({ ...form, phone: e.target.value })}
            />
          </Field>
          <Field label="주소" htmlFor="pt-address" className="sm:col-span-2">
            <Input
              id="pt-address"
              value={form.address}
              onChange={(e) => setForm({ ...form, address: e.target.value })}
            />
          </Field>
          <Field label="담당자" htmlFor="pt-contact">
            <Input
              id="pt-contact"
              value={form.contactName}
              onChange={(e) => setForm({ ...form, contactName: e.target.value })}
            />
          </Field>
          <Field label="담당자 연락처" htmlFor="pt-contact-phone">
            <Input
              id="pt-contact-phone"
              value={form.contactPhone}
              onChange={(e) => setForm({ ...form, contactPhone: e.target.value })}
            />
          </Field>
        </div>
        <p className="text-xs text-slate-500">
          거래처코드는 자동 채번됩니다. 담당자는 등록 후 상세 화면에서 추가할 수 있습니다.
        </p>
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
