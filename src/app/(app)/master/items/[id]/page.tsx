'use client';

import { use, useState } from 'react';
import { api, newRequestId } from '@/lib/trpc';
import {
  Button,
  Card,
  EmptyState,
  Field,
  Input,
  Select,
  Spinner,
  StatusBadge,
} from '@/components/ui/primitives';
import { AttachmentPanel } from '@/components/ui/attachment-panel';
import { ChangeHistory } from '@/components/ui/change-history';
import { FormErrorSummary, type FieldError } from '@/components/ui/form-error-summary';

/** BAS-01/BAS-02/BAS-08/BAS-09: item detail, edit, change history and deletion policy. */
const TAX_LABEL: Record<string, string> = { TAXABLE: '과세', ZERO: '영세', EXEMPT: '면세' };

export default function ItemDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  // BAS-08: any master mutation invalidates the whole master router, so the detail card
  // and the change history below it both reflect the change without a page reload.
  const utils = api.useUtils();
  const refresh = { onSuccess: () => utils.master.invalidate() };

  const detail = api.master.item.useQuery({ id });
  const categories = api.master.itemCategories.useQuery();
  const units = api.master.codes.useQuery({ groupCode: 'UNIT', activeOnly: true });
  const update = api.master.updateItem.useMutation(refresh);
  const setActive = api.master.setItemActive.useMutation(refresh);
  const remove = api.master.deleteItem.useMutation();

  const [editing, setEditing] = useState(false);
  const [errors, setErrors] = useState<FieldError[]>([]);
  const [message, setMessage] = useState<string | null>(null);

  if (detail.isLoading) return <Spinner />;
  if (detail.error) return <EmptyState title="품목을 찾을 수 없습니다." description={detail.error.message} />;
  const it = detail.data!;

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h1 className="text-lg font-semibold">
            {it.name} <span className="ml-1 text-sm font-normal text-slate-500">{it.code}</span>
          </h1>
          <p className="mt-0.5 text-sm text-slate-500">
            {it.category?.name ?? '분류 미지정'} · {TAX_LABEL[it.taxType] ?? it.taxType} · {it.unitCode}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <StatusBadge
            status={it.isActive ? 'CONFIRMED' : 'CANCELED'}
            label={it.isActive ? '사용' : '중지'}
          />
          <Button size="sm" onClick={() => setEditing((v) => !v)}>
            {editing ? '취소' : '수정'}
          </Button>
        </div>
      </header>

      {message ? (
        <p role="status" className="rounded bg-green-50 px-3 py-2 text-sm text-green-800">
          {message}
        </p>
      ) : null}

      {editing ? (
        <Card title="품목 수정">
          <ItemEditForm
            item={it}
            categories={(categories.data ?? []).filter((c) => c.level === 3)}
            units={(units.data ?? []).map((u) => ({ code: u.code, name: u.name }))}
            errors={errors}
            onSubmit={async (values) => {
              setErrors([]);
              try {
                await update.mutateAsync({ id, version: it.version, ...values, requestId: newRequestId() });
                setEditing(false);
                setMessage('저장했습니다.');
              } catch (err) {
                setErrors([
                  {
                    field: 'ie-name',
                    label: '저장',
                    message: (err as { message?: string }).message ?? '저장에 실패했습니다.',
                  },
                ]);
              }
            }}
          />
        </Card>
      ) : (
        <Card title="기본정보">
          <dl className="grid grid-cols-[7rem_1fr] gap-y-2 text-sm sm:grid-cols-[7rem_1fr_7rem_1fr]">
            <dt className="text-slate-500">규격</dt>
            <dd>{it.spec ?? '-'}</dd>
            <dt className="text-slate-500">바코드</dt>
            <dd className="tabular">{it.barcode ?? '-'}</dd>
            <dt className="text-slate-500">입고단가</dt>
            <dd className="tabular">{it.purchasePrice?.toString() ?? '-'}</dd>
            <dt className="text-slate-500">출고단가</dt>
            <dd className="tabular">{it.salesPrice?.toString() ?? '-'}</dd>
            <dt className="text-slate-500">안전재고</dt>
            <dd className="tabular">{it.safetyStock?.toString() ?? '-'}</dd>
            <dt className="text-slate-500">리드타임</dt>
            <dd className="tabular">{it.leadTimeDays !== null ? `${it.leadTimeDays}일` : '-'}</dd>
            <dt className="text-slate-500">기본 매입처</dt>
            <dd>{it.defaultSupplier?.name ?? '-'}</dd>
            <dt className="text-slate-500">비고</dt>
            <dd>{it.note ?? '-'}</dd>
          </dl>
        </Card>
      )}

      <Card title="사용 정책">
        <p className="mb-3 text-sm text-slate-600">
          관련 자료 {it.usageCount}건. 사용된 품목은 삭제할 수 없고 사용중지로만 처리합니다.
        </p>
        <div className="flex gap-1.5">
          <Button
            size="sm"
            onClick={async () => {
              await setActive.mutateAsync({ id, isActive: !it.isActive, requestId: newRequestId() });
              setMessage(it.isActive ? '사용중지 처리했습니다.' : '사용으로 되돌렸습니다.');
            }}
          >
            {it.isActive ? '사용중지' : '사용재개'}
          </Button>
          <Button
            size="sm"
            variant="danger"
            disabled={it.usageCount > 0}
            title={it.usageCount > 0 ? '사용 이력이 있어 삭제할 수 없습니다.' : undefined}
            onClick={async () => {
              try {
                await remove.mutateAsync({ id, requestId: newRequestId() });
                window.location.href = '/master/items';
              } catch (err) {
                setMessage((err as { message?: string }).message ?? '삭제에 실패했습니다.');
              }
            }}
          >
            삭제
          </Button>
        </div>
      </Card>

      <AttachmentPanel ownerType="ITEM" ownerId={id} />
      <ChangeHistory entityType="Item" entityId={id} />
    </div>
  );
}

function ItemEditForm({
  item,
  categories,
  units,
  errors,
  onSubmit,
}: {
  item: {
    name: string;
    spec: string | null;
    unitCode: string;
    categoryId: string | null;
    taxType: string;
    purchasePrice: unknown;
    salesPrice: unknown;
    safetyStock: unknown;
    leadTimeDays: number | null;
    barcode: string | null;
    note: string | null;
  };
  categories: { id: string; name: string }[];
  units: { code: string; name: string }[];
  errors: FieldError[];
  onSubmit: (values: Record<string, unknown>) => Promise<void>;
}) {
  const [form, setForm] = useState({
    name: item.name,
    spec: item.spec ?? '',
    unitCode: item.unitCode,
    categoryId: item.categoryId ?? '',
    taxType: item.taxType as 'TAXABLE' | 'ZERO' | 'EXEMPT',
    purchasePrice: item.purchasePrice?.toString() ?? '',
    salesPrice: item.salesPrice?.toString() ?? '',
    safetyStock: item.safetyStock?.toString() ?? '',
    leadTimeDays: item.leadTimeDays?.toString() ?? '',
    barcode: item.barcode ?? '',
    note: item.note ?? '',
  });

  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={async (e) => {
        e.preventDefault();
        await onSubmit({
          name: form.name.trim(),
          unitCode: form.unitCode,
          taxType: form.taxType,
          spec: form.spec || undefined,
          categoryId: form.categoryId || undefined,
          purchasePrice: form.purchasePrice || undefined,
          salesPrice: form.salesPrice || undefined,
          safetyStock: form.safetyStock || undefined,
          leadTimeDays: form.leadTimeDays ? Number(form.leadTimeDays) : undefined,
          barcode: form.barcode || undefined,
          note: form.note || undefined,
        });
      }}
    >
      <FormErrorSummary errors={errors} />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="품목명" htmlFor="ie-name" required>
          <Input
            id="ie-name"
            name="ie-name"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
        </Field>
        <Field label="규격" htmlFor="ie-spec">
          <Input
            id="ie-spec"
            value={form.spec}
            onChange={(e) => setForm({ ...form, spec: e.target.value })}
          />
        </Field>
        <Field label="단위" htmlFor="ie-unit">
          <Select
            id="ie-unit"
            value={form.unitCode}
            onChange={(e) => setForm({ ...form, unitCode: e.target.value })}
          >
            {units.map((u) => (
              <option key={u.code} value={u.code}>
                {u.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="분류" htmlFor="ie-cat">
          <Select
            id="ie-cat"
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
        <Field label="과세구분" htmlFor="ie-tax">
          <Select
            id="ie-tax"
            value={form.taxType}
            onChange={(e) => setForm({ ...form, taxType: e.target.value as typeof form.taxType })}
          >
            <option value="TAXABLE">과세</option>
            <option value="ZERO">영세</option>
            <option value="EXEMPT">면세</option>
          </Select>
        </Field>
        <Field label="입고단가" htmlFor="ie-buy">
          <Input
            id="ie-buy"
            className="tabular text-right"
            value={form.purchasePrice}
            onChange={(e) => setForm({ ...form, purchasePrice: e.target.value })}
          />
        </Field>
        <Field label="출고단가" htmlFor="ie-sell">
          <Input
            id="ie-sell"
            className="tabular text-right"
            value={form.salesPrice}
            onChange={(e) => setForm({ ...form, salesPrice: e.target.value })}
          />
        </Field>
        <Field label="안전재고" htmlFor="ie-safety">
          <Input
            id="ie-safety"
            className="tabular text-right"
            value={form.safetyStock}
            onChange={(e) => setForm({ ...form, safetyStock: e.target.value })}
          />
        </Field>
        <Field label="리드타임(일)" htmlFor="ie-lead">
          <Input
            id="ie-lead"
            className="tabular text-right"
            value={form.leadTimeDays}
            onChange={(e) => setForm({ ...form, leadTimeDays: e.target.value })}
          />
        </Field>
        <Field label="바코드" htmlFor="ie-barcode">
          <Input
            id="ie-barcode"
            value={form.barcode}
            onChange={(e) => setForm({ ...form, barcode: e.target.value })}
          />
        </Field>
        <Field label="비고" htmlFor="ie-note" className="sm:col-span-2">
          <Input
            id="ie-note"
            value={form.note}
            onChange={(e) => setForm({ ...form, note: e.target.value })}
          />
        </Field>
      </div>
      <div className="flex justify-end">
        <Button type="submit" size="sm" variant="primary">
          저장
        </Button>
      </div>
    </form>
  );
}
