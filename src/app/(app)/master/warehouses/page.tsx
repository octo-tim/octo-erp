'use client';

import { useState } from 'react';
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

/** BAS-06: warehouses (normal / defect / consigned). */
const TYPE_LABEL: Record<string, string> = { NORMAL: '정상', DEFECT: '불량', CONSIGNED: '위탁' };

export default function WarehousePage() {
  const list = api.master.warehouses.useQuery({ activeOnly: false });
  const create = api.master.createWarehouse.useMutation();
  const update = api.master.updateWarehouse.useMutation();
  const [form, setForm] = useState({
    code: '',
    name: '',
    type: 'NORMAL' as 'NORMAL' | 'DEFECT' | 'CONSIGNED',
    address: '',
  });
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <header>
        <h1 className="text-lg font-semibold">창고</h1>
        <p className="mt-0.5 text-sm text-slate-500">
          재고는 창고별로 관리됩니다. 사용자에게 부여된 창고만 조회·입출고할 수 있습니다.
        </p>
      </header>

      <Card title="창고 등록">
        <form
          className="grid grid-cols-1 gap-3 sm:grid-cols-5"
          onSubmit={async (e) => {
            e.preventDefault();
            setError(null);
            try {
              await create.mutateAsync({
                code: form.code.trim(),
                name: form.name.trim(),
                type: form.type,
                ...(form.address ? { address: form.address } : {}),
                requestId: newRequestId(),
              });
              setForm({ code: '', name: '', type: 'NORMAL', address: '' });
              await list.refetch();
            } catch (err) {
              setError((err as { message?: string }).message ?? '등록에 실패했습니다.');
            }
          }}
        >
          <Field label="창고코드" htmlFor="wh-code" required>
            <Input
              id="wh-code"
              value={form.code}
              onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase() })}
            />
          </Field>
          <Field label="창고명" htmlFor="wh-name" required>
            <Input
              id="wh-name"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          </Field>
          <Field label="유형" htmlFor="wh-type">
            <Select
              id="wh-type"
              value={form.type}
              onChange={(e) => setForm({ ...form, type: e.target.value as typeof form.type })}
            >
              <option value="NORMAL">정상</option>
              <option value="DEFECT">불량</option>
              <option value="CONSIGNED">위탁</option>
            </Select>
          </Field>
          <Field label="주소" htmlFor="wh-address">
            <Input
              id="wh-address"
              value={form.address}
              onChange={(e) => setForm({ ...form, address: e.target.value })}
            />
          </Field>
          <div className="flex items-end">
            <Button type="submit" size="sm" variant="primary" disabled={!form.code || !form.name}>
              등록
            </Button>
          </div>
        </form>
        {error ? (
          <p role="alert" className="mt-2 rounded bg-red-50 px-3 py-2 text-sm text-red-700">
            {error}
          </p>
        ) : null}
      </Card>

      <Card title={`창고 목록 (${(list.data ?? []).length}개)`}>
        {list.isLoading ? (
          <Spinner />
        ) : (list.data ?? []).length === 0 ? (
          <EmptyState
            title="조회 가능한 창고가 없습니다."
            description="관리자에게 창고 권한을 요청하거나 창고를 등록하세요."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-max text-sm">
              <thead className="bg-slate-50">
                <tr>
                  <th scope="col" className="px-3 py-2 text-left font-semibold">
                    코드
                  </th>
                  <th scope="col" className="px-3 py-2 text-left font-semibold">
                    창고명
                  </th>
                  <th scope="col" className="px-3 py-2 text-left font-semibold">
                    유형
                  </th>
                  <th scope="col" className="px-3 py-2 text-left font-semibold">
                    주소
                  </th>
                  <th scope="col" className="px-3 py-2 text-left font-semibold">
                    사용
                  </th>
                  <th scope="col" className="px-3 py-2 text-left font-semibold">
                    작업
                  </th>
                </tr>
              </thead>
              <tbody>
                {(list.data ?? []).map((w) => (
                  <tr key={w.id} className="border-b border-slate-100 last:border-0">
                    <td className="px-3 py-1.5">{w.code}</td>
                    <td className="px-3 py-1.5">{w.name}</td>
                    <td className="px-3 py-1.5">{TYPE_LABEL[w.type] ?? w.type}</td>
                    <td className="px-3 py-1.5">{w.address ?? '-'}</td>
                    <td className="px-3 py-1.5">
                      <StatusBadge
                        status={w.isActive ? 'CONFIRMED' : 'CANCELED'}
                        label={w.isActive ? '사용' : '중지'}
                      />
                    </td>
                    <td className="px-3 py-1.5">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={async () => {
                          await update.mutateAsync({
                            id: w.id,
                            isActive: !w.isActive,
                            requestId: newRequestId(),
                          });
                          await list.refetch();
                        }}
                      >
                        {w.isActive ? '사용중지' : '사용재개'}
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
