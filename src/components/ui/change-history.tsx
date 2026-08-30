'use client';

import { api } from '@/lib/trpc';
import { Card, EmptyState, Spinner } from './primitives';
import { fmt } from '@/lib/format';

/** BAS-08: who changed what and when, read straight from the audit log. */
type EntityType = 'Item' | 'Partner' | 'Warehouse' | 'Division' | 'CommonCode';

const ACTION_LABEL: Record<string, string> = {
  'item.create': '등록',
  'item.update': '수정',
  'item.activate': '사용재개',
  'item.deactivate': '사용중지',
  'item.delete': '삭제',
  'partner.create': '등록',
  'partner.update': '수정',
  'partner.activate': '사용재개',
  'partner.deactivate': '사용중지',
  'warehouse.create': '등록',
  'warehouse.update': '수정',
  'division.create': '등록',
  'division.update': '수정',
};

function diff(before: unknown, after: unknown): { field: string; from: string; to: string }[] {
  if (!before || !after || typeof before !== 'object' || typeof after !== 'object') return [];
  const b = before as Record<string, unknown>;
  const a = after as Record<string, unknown>;
  return Object.keys(a)
    .filter((k) => String(b[k] ?? '') !== String(a[k] ?? ''))
    .map((k) => ({ field: k, from: String(b[k] ?? '-'), to: String(a[k] ?? '-') }));
}

const FIELD_LABEL: Record<string, string> = {
  name: '이름',
  spec: '규격',
  salesPrice: '출고단가',
  purchasePrice: '입고단가',
  taxType: '과세구분',
  safetyStock: '안전재고',
  businessNo: '사업자번호',
  partnerType: '거래유형',
  paymentTerms: '결제조건',
  creditLimit: '여신한도',
  isActive: '사용여부',
  type: '유형',
};

export function ChangeHistory({ entityType, entityId }: { entityType: EntityType; entityId: string }) {
  const history = api.master.changeHistory.useQuery({ entityType, entityId });

  return (
    <Card title="변경 이력">
      {history.isLoading ? (
        <Spinner />
      ) : (history.data ?? []).length === 0 ? (
        <EmptyState title="변경 이력이 없습니다." />
      ) : (
        <ul className="divide-y divide-slate-100 text-sm">
          {(history.data ?? []).map((h) => {
            const changes = diff(h.before, h.after);
            return (
              <li key={h.id} className="py-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-slate-500">{fmt.dateTime(h.createdAt as unknown as string)}</span>
                  <span className="font-medium">{ACTION_LABEL[h.action] ?? h.action}</span>
                  <span className="text-slate-500">{h.actorName ?? '-'}</span>
                </div>
                {changes.length > 0 ? (
                  <ul className="mt-1 pl-4 text-xs text-slate-600">
                    {changes.map((c) => (
                      <li key={c.field}>
                        {FIELD_LABEL[c.field] ?? c.field}: {c.from} → {c.to}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
