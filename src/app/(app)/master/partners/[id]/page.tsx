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
import { formatBusinessNo } from '@/server/modules/master/validation';
import { fmt } from '@/lib/format';

/** BAS-04/BAS-08/BAS-09: partner detail with multiple contacts. */
const TYPE_LABEL: Record<string, string> = { CUSTOMER: '매출처', SUPPLIER: '매입처', BOTH: '매출·매입' };

interface Contact {
  id?: string;
  name: string;
  position: string;
  phone: string;
  email: string;
  isPrimary: boolean;
}

export default function PartnerDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  // BAS-08: see the item detail screen - one invalidation keeps detail and history in step.
  const utils = api.useUtils();
  const refresh = { onSuccess: () => utils.master.invalidate() };

  const detail = api.master.partner.useQuery({ id });
  const terms = api.master.codes.useQuery({ groupCode: 'PAYMENT_TERMS', activeOnly: true });
  const update = api.master.updatePartner.useMutation(refresh);
  const setActive = api.master.setPartnerActive.useMutation(refresh);
  const remove = api.master.deletePartner.useMutation();

  const [editing, setEditing] = useState(false);
  const [errors, setErrors] = useState<FieldError[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  if (detail.isLoading) return <Spinner />;
  if (detail.error)
    return <EmptyState title="거래처를 찾을 수 없습니다." description={detail.error.message} />;
  const p = detail.data!;

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h1 className="text-lg font-semibold">
            {p.name} <span className="ml-1 text-sm font-normal text-slate-500">{p.code}</span>
          </h1>
          <p className="mt-0.5 text-sm text-slate-500">
            {TYPE_LABEL[p.partnerType] ?? p.partnerType}
            {p.businessNo ? ` · ${formatBusinessNo(p.businessNo)}` : ''}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <StatusBadge status={p.isActive ? 'CONFIRMED' : 'CANCELED'} label={p.isActive ? '사용' : '중지'} />
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
        <Card title="거래처 수정">
          <PartnerEditForm
            partner={p}
            terms={(terms.data ?? []).map((t) => ({ code: t.code, name: t.name }))}
            errors={errors}
            onSubmit={async (values) => {
              setErrors([]);
              try {
                await update.mutateAsync({ id, version: p.version, ...values, requestId: newRequestId() });
                setEditing(false);
                setMessage('저장했습니다.');
              } catch (err) {
                setErrors([
                  {
                    field: 'pe-name',
                    label: '저장',
                    message: (err as { message?: string }).message ?? '저장에 실패했습니다.',
                  },
                ]);
              }
            }}
          />
        </Card>
      ) : (
        <>
          <Card title="기본정보">
            <dl className="grid grid-cols-[7rem_1fr] gap-y-2 text-sm sm:grid-cols-[7rem_1fr_7rem_1fr]">
              <dt className="text-slate-500">대표자</dt>
              <dd>{p.ceoName ?? '-'}</dd>
              <dt className="text-slate-500">업태 / 종목</dt>
              <dd>{[p.businessType, p.businessItem].filter(Boolean).join(' / ') || '-'}</dd>
              <dt className="text-slate-500">전화</dt>
              <dd>{p.phone ?? '-'}</dd>
              <dt className="text-slate-500">이메일</dt>
              <dd>{p.email ?? '-'}</dd>
              <dt className="text-slate-500">주소</dt>
              <dd className="sm:col-span-3">{p.address ?? '-'}</dd>
              <dt className="text-slate-500">결제조건</dt>
              <dd>{p.paymentTerms ?? '-'}</dd>
              <dt className="text-slate-500">여신한도</dt>
              <dd className="tabular">{fmt.krw(p.creditLimit as unknown as string) || '-'}</dd>
            </dl>
          </Card>

          <Card title={`담당자 (${p.contacts.length}명)`}>
            {p.contacts.length === 0 ? (
              <EmptyState
                title="등록된 담당자가 없습니다."
                description="수정에서 담당자를 추가할 수 있습니다."
              />
            ) : (
              <ul className="divide-y divide-slate-100 text-sm">
                {p.contacts.map((c) => (
                  <li key={c.id} className="flex flex-wrap items-center gap-3 py-2">
                    <span className="font-medium">{c.name}</span>
                    {c.isPrimary ? (
                      <span className="rounded bg-blue-50 px-1.5 py-0.5 text-xs text-blue-800">주담당</span>
                    ) : null}
                    <span className="text-slate-500">{c.position ?? '-'}</span>
                    <span className="text-slate-500">{c.phone ?? '-'}</span>
                    <span className="text-slate-500">{c.email ?? '-'}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </>
      )}

      <Card title="사용 정책">
        <p className="mb-3 text-sm text-slate-600">
          관련 자료 {p.usageCount}건. 사용된 거래처는 삭제할 수 없고 사용중지로만 처리합니다.
        </p>
        {deleteError ? (
          <p role="alert" className="mb-3 rounded bg-red-50 px-3 py-2 text-sm text-red-700">
            {deleteError}
          </p>
        ) : null}
        <div className="flex flex-wrap items-center gap-1.5">
          <Button
            size="sm"
            onClick={async () => {
              await setActive.mutateAsync({ id, isActive: !p.isActive, requestId: newRequestId() });
              setMessage(p.isActive ? '사용중지 처리했습니다.' : '사용으로 되돌렸습니다.');
            }}
          >
            {p.isActive ? '사용중지' : '사용재개'}
          </Button>
          {!confirmDelete ? (
            <Button
              size="sm"
              variant="danger"
              disabled={p.usageCount > 0}
              title={p.usageCount > 0 ? '사용 이력이 있어 삭제할 수 없습니다.' : undefined}
              onClick={() => {
                setDeleteError(null);
                setConfirmDelete(true);
              }}
            >
              삭제
            </Button>
          ) : (
            <>
              <span className="text-sm text-red-700">
                &apos;{p.name}&apos; 거래처를 삭제하시겠습니까? 이 작업은 되돌릴 수 없습니다.
              </span>
              <Button
                size="sm"
                variant="danger"
                disabled={remove.isPending}
                onClick={async () => {
                  try {
                    await remove.mutateAsync({ id, requestId: newRequestId() });
                    window.location.href = '/master/partners';
                  } catch (err) {
                    setDeleteError((err as { message?: string }).message ?? '삭제에 실패했습니다.');
                    setConfirmDelete(false);
                  }
                }}
              >
                확인 삭제
              </Button>
              <Button size="sm" onClick={() => setConfirmDelete(false)}>
                취소
              </Button>
            </>
          )}
        </div>
      </Card>

      <AttachmentPanel ownerType="PARTNER" ownerId={id} />
      <ChangeHistory entityType="Partner" entityId={id} />
    </div>
  );
}

function PartnerEditForm({
  partner,
  terms,
  errors,
  onSubmit,
}: {
  partner: {
    name: string;
    businessNo: string | null;
    ceoName: string | null;
    businessType: string | null;
    businessItem: string | null;
    address: string | null;
    phone: string | null;
    email: string | null;
    partnerType: string;
    paymentTerms: string | null;
    creditLimit: unknown;
    contacts: {
      id: string;
      name: string;
      position: string | null;
      phone: string | null;
      email: string | null;
      isPrimary: boolean;
    }[];
  };
  terms: { code: string; name: string }[];
  errors: FieldError[];
  onSubmit: (values: Record<string, unknown>) => Promise<void>;
}) {
  const [form, setForm] = useState({
    name: partner.name,
    businessNo: partner.businessNo ?? '',
    ceoName: partner.ceoName ?? '',
    businessType: partner.businessType ?? '',
    businessItem: partner.businessItem ?? '',
    address: partner.address ?? '',
    phone: partner.phone ?? '',
    email: partner.email ?? '',
    partnerType: partner.partnerType as 'CUSTOMER' | 'SUPPLIER' | 'BOTH',
    paymentTerms: partner.paymentTerms ?? '',
    creditLimit: partner.creditLimit?.toString() ?? '',
  });
  const [contacts, setContacts] = useState<Contact[]>(
    partner.contacts.map((c) => ({
      name: c.name,
      position: c.position ?? '',
      phone: c.phone ?? '',
      email: c.email ?? '',
      isPrimary: c.isPrimary,
    })),
  );

  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={async (e) => {
        e.preventDefault();
        await onSubmit({
          name: form.name.trim(),
          partnerType: form.partnerType,
          businessNo: form.businessNo || undefined,
          ceoName: form.ceoName || undefined,
          businessType: form.businessType || undefined,
          businessItem: form.businessItem || undefined,
          address: form.address || undefined,
          phone: form.phone || undefined,
          email: form.email || undefined,
          paymentTerms: form.paymentTerms || undefined,
          creditLimit: form.creditLimit || undefined,
          contacts: contacts
            .filter((c) => c.name.trim())
            .map((c) => ({
              name: c.name.trim(),
              position: c.position || undefined,
              phone: c.phone || undefined,
              email: c.email || undefined,
              isPrimary: c.isPrimary,
            })),
        });
      }}
    >
      <FormErrorSummary errors={errors} />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="거래처명" htmlFor="pe-name" required>
          <Input
            id="pe-name"
            name="pe-name"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
        </Field>
        <Field label="사업자등록번호" htmlFor="pe-bizno">
          <Input
            id="pe-bizno"
            value={form.businessNo}
            onChange={(e) => setForm({ ...form, businessNo: e.target.value })}
          />
        </Field>
        <Field label="대표자" htmlFor="pe-ceo">
          <Input
            id="pe-ceo"
            value={form.ceoName}
            onChange={(e) => setForm({ ...form, ceoName: e.target.value })}
          />
        </Field>
        <Field label="거래유형" htmlFor="pe-type">
          <Select
            id="pe-type"
            value={form.partnerType}
            onChange={(e) => setForm({ ...form, partnerType: e.target.value as typeof form.partnerType })}
          >
            <option value="BOTH">매출·매입</option>
            <option value="CUSTOMER">매출처</option>
            <option value="SUPPLIER">매입처</option>
          </Select>
        </Field>
        <Field label="업태" htmlFor="pe-btype">
          <Input
            id="pe-btype"
            value={form.businessType}
            onChange={(e) => setForm({ ...form, businessType: e.target.value })}
          />
        </Field>
        <Field label="종목" htmlFor="pe-bitem">
          <Input
            id="pe-bitem"
            value={form.businessItem}
            onChange={(e) => setForm({ ...form, businessItem: e.target.value })}
          />
        </Field>
        <Field label="결제조건" htmlFor="pe-terms">
          <Select
            id="pe-terms"
            value={form.paymentTerms}
            onChange={(e) => setForm({ ...form, paymentTerms: e.target.value })}
          >
            <option value="">미지정</option>
            {terms.map((t) => (
              <option key={t.code} value={t.code}>
                {t.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="여신한도" htmlFor="pe-credit">
          <Input
            id="pe-credit"
            className="tabular text-right"
            value={form.creditLimit}
            onChange={(e) => setForm({ ...form, creditLimit: e.target.value })}
          />
        </Field>
        <Field label="전화" htmlFor="pe-phone">
          <Input
            id="pe-phone"
            value={form.phone}
            onChange={(e) => setForm({ ...form, phone: e.target.value })}
          />
        </Field>
        <Field label="이메일" htmlFor="pe-email">
          <Input
            id="pe-email"
            type="email"
            value={form.email}
            onChange={(e) => setForm({ ...form, email: e.target.value })}
          />
        </Field>
        <Field label="주소" htmlFor="pe-address" className="sm:col-span-2">
          <Input
            id="pe-address"
            value={form.address}
            onChange={(e) => setForm({ ...form, address: e.target.value })}
          />
        </Field>
      </div>

      <fieldset className="rounded-md border border-slate-200 p-3">
        <legend className="px-1 text-sm font-medium">담당자</legend>
        {contacts.map((c, i) => (
          <div key={i} className="mb-2 grid grid-cols-1 gap-2 sm:grid-cols-5">
            <Input
              aria-label={`담당자 ${i + 1} 이름`}
              placeholder="이름"
              value={c.name}
              onChange={(e) =>
                setContacts(contacts.map((x, j) => (i === j ? { ...x, name: e.target.value } : x)))
              }
            />
            <Input
              aria-label={`담당자 ${i + 1} 직위`}
              placeholder="직위"
              value={c.position}
              onChange={(e) =>
                setContacts(contacts.map((x, j) => (i === j ? { ...x, position: e.target.value } : x)))
              }
            />
            <Input
              aria-label={`담당자 ${i + 1} 연락처`}
              placeholder="연락처"
              value={c.phone}
              onChange={(e) =>
                setContacts(contacts.map((x, j) => (i === j ? { ...x, phone: e.target.value } : x)))
              }
            />
            <Input
              aria-label={`담당자 ${i + 1} 이메일`}
              placeholder="이메일"
              value={c.email}
              onChange={(e) =>
                setContacts(contacts.map((x, j) => (i === j ? { ...x, email: e.target.value } : x)))
              }
            />
            <div className="flex items-center gap-2">
              <label className="flex items-center gap-1 text-sm">
                <input
                  type="radio"
                  name="primary-contact"
                  checked={c.isPrimary}
                  onChange={() => setContacts(contacts.map((x, j) => ({ ...x, isPrimary: i === j })))}
                />
                주담당
              </label>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => setContacts(contacts.filter((_, j) => j !== i))}
              >
                삭제
              </Button>
            </div>
          </div>
        ))}
        <Button
          type="button"
          size="sm"
          onClick={() =>
            setContacts([
              ...contacts,
              { name: '', position: '', phone: '', email: '', isPrimary: contacts.length === 0 },
            ])
          }
        >
          담당자 추가
        </Button>
      </fieldset>

      <div className="flex justify-end">
        <Button type="submit" size="sm" variant="primary">
          저장
        </Button>
      </div>
    </form>
  );
}
