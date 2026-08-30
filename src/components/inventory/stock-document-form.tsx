'use client';

import { useMemo, useState } from 'react';
import { api, newRequestId } from '@/lib/trpc';
import { Button, Card, Field, Input, Select } from '@/components/ui/primitives';
import { FormErrorSummary, type FieldError } from '@/components/ui/form-error-summary';
import { VoucherLineEditor, type LineColumn } from '@/components/ui/voucher-line-editor';
import { fmt } from '@/lib/format';
import { add, D } from '@/lib/money';
import { businessDate } from '@/lib/dates';

/**
 * INV-01/02/03: receipts, issues and transfers differ only in which warehouse fields
 * they ask for, so they share one form. The totals shown here are display-only — the
 * server recomputes them (INT-01), and the issue unit cost is decided by DEC-01 at
 * confirmation, not by whatever the operator typed.
 */
export type FormDocType = 'RECEIPT' | 'ISSUE' | 'TRANSFER';

interface Line extends Record<string, string> {
  itemId: string;
  itemLabel: string;
  quantity: string;
  unitCost: string;
  amount: string;
  note: string;
}

const emptyLine = (): Line => ({
  itemId: '',
  itemLabel: '',
  quantity: '',
  unitCost: '',
  amount: '',
  note: '',
});

/**
 * Picking from the datalist leaves the full "이름 (코드)" label in the cell, but an
 * operator who types just the name and tabs away means the same item when only one
 * matches. Only an ambiguous or unknown entry is rejected.
 */
function resolveItem(options: { value: string; label: string }[], typed: string): string {
  const text = typed.trim();
  if (!text) return '';

  const exact = options.find((o) => o.label === text);
  if (exact) return exact.value;

  const lower = text.toLowerCase();
  const partial = options.filter((o) => o.label.toLowerCase().includes(lower));
  return partial.length === 1 ? partial[0]!.value : '';
}

const REASON_GROUP: Record<FormDocType, string> = {
  RECEIPT: 'STOCK_REASON_IN',
  ISSUE: 'STOCK_REASON_OUT',
  TRANSFER: 'STOCK_REASON_OUT',
};

export function StockDocumentForm({
  docType,
  onCreated,
  onCancel,
}: {
  docType: FormDocType;
  onCreated: (id: string) => void;
  onCancel: () => void;
}) {
  const warehouses = api.master.warehouses.useQuery({ activeOnly: true });
  const reasons = api.master.codes.useQuery({ groupCode: REASON_GROUP[docType], activeOnly: true });
  const items = api.master.searchItems.useQuery({ q: '', take: 200 });
  const create = api.inventory.createDocument.useMutation();

  const [header, setHeader] = useState({
    docDate: businessDate(new Date()),
    fromWarehouseId: '',
    toWarehouseId: '',
    reasonCode: '',
    note: '',
  });
  const [lines, setLines] = useState<Line[]>([emptyLine()]);
  const [errors, setErrors] = useState<FieldError[]>([]);

  const suggestions = useMemo(
    () => (items.data ?? []).map((i) => ({ value: i.id, label: `${i.name} (${i.code})` })),
    [items.data],
  );

  const columns: LineColumn<Line>[] = [
    { key: 'itemLabel', header: '품목', kind: 'text', required: true, suggestions },
    { key: 'quantity', header: '수량', kind: 'qty', width: 110, required: true, total: true },
    // an issue is valued by the monthly average at confirmation, so a typed cost would mislead
    ...(docType === 'RECEIPT'
      ? ([{ key: 'unitCost', header: '단가', kind: 'unitPrice', width: 120 }] as LineColumn<Line>[])
      : []),
    ...(docType === 'RECEIPT'
      ? ([{ key: 'amount', header: '금액', kind: 'readonly', width: 130, total: true }] as LineColumn<Line>[])
      : []),
    { key: 'note', header: '비고', kind: 'text' },
  ];

  const total = lines.reduce((acc, l) => add(acc, l.amount || '0'), D(0));

  async function submit() {
    setErrors([]);
    const prepared = lines
      .filter((l) => l.itemLabel.trim() || l.quantity.trim())
      .map((l, i) => ({
        index: i,
        itemId: resolveItem(suggestions, l.itemLabel),
        quantity: l.quantity,
        unitCost: l.unitCost,
        note: l.note,
      }));

    const missing = prepared.filter((l) => !l.itemId);
    if (prepared.length === 0 || missing.length > 0) {
      setErrors([
        {
          field: 'sd-lines',
          label: '품목',
          message:
            prepared.length === 0
              ? '품목을 한 건 이상 입력하세요.'
              : `${missing.map((m) => `${m.index + 1}행`).join(', ')}: 품목을 찾을 수 없거나 여러 건이 일치합니다. 목록에서 선택하세요.`,
        },
      ]);
      return;
    }

    try {
      const doc = await create.mutateAsync({
        docType,
        docDate: header.docDate,
        ...(docType === 'ISSUE' || docType === 'TRANSFER' ? { fromWarehouseId: header.fromWarehouseId } : {}),
        ...(docType === 'RECEIPT' || docType === 'TRANSFER' ? { toWarehouseId: header.toWarehouseId } : {}),
        ...(docType === 'TRANSFER' ? {} : { reasonCode: header.reasonCode }),
        ...(header.note ? { note: header.note } : {}),
        lines: prepared.map((l) => ({
          itemId: l.itemId,
          quantity: l.quantity,
          ...(l.unitCost ? { unitCost: l.unitCost } : {}),
          ...(l.note ? { note: l.note } : {}),
        })),
        requestId: newRequestId(),
      });
      onCreated(doc.id);
    } catch (err) {
      setErrors([
        {
          field: 'sd-date',
          label: '저장',
          message: (err as { message?: string }).message ?? '저장에 실패했습니다.',
        },
      ]);
    }
  }

  const warehouseOptions = (warehouses.data ?? []).map((w) => ({ value: w.id, label: w.name }));

  return (
    <Card title={docType === 'RECEIPT' ? '입고 등록' : docType === 'ISSUE' ? '출고 등록' : '이동 등록'}>
      <FormErrorSummary errors={errors} />

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
        <Field label="일자" htmlFor="sd-date" required>
          <Input
            id="sd-date"
            type="date"
            value={header.docDate}
            onChange={(e) => setHeader({ ...header, docDate: e.target.value })}
          />
        </Field>

        {docType === 'ISSUE' || docType === 'TRANSFER' ? (
          <Field label={docType === 'TRANSFER' ? '출발 창고' : '출고 창고'} htmlFor="sd-from" required>
            <Select
              id="sd-from"
              value={header.fromWarehouseId}
              onChange={(e) => setHeader({ ...header, fromWarehouseId: e.target.value })}
            >
              <option value="">선택</option>
              {warehouseOptions.map((w) => (
                <option key={w.value} value={w.value}>
                  {w.label}
                </option>
              ))}
            </Select>
          </Field>
        ) : null}

        {docType === 'RECEIPT' || docType === 'TRANSFER' ? (
          <Field label={docType === 'TRANSFER' ? '도착 창고' : '입고 창고'} htmlFor="sd-to" required>
            <Select
              id="sd-to"
              value={header.toWarehouseId}
              onChange={(e) => setHeader({ ...header, toWarehouseId: e.target.value })}
            >
              <option value="">선택</option>
              {warehouseOptions.map((w) => (
                <option key={w.value} value={w.value}>
                  {w.label}
                </option>
              ))}
            </Select>
          </Field>
        ) : null}

        {docType === 'TRANSFER' ? null : (
          <Field label="사유" htmlFor="sd-reason" required hint="수동 입출고는 사유가 필요합니다">
            <Select
              id="sd-reason"
              value={header.reasonCode}
              onChange={(e) => setHeader({ ...header, reasonCode: e.target.value })}
            >
              <option value="">선택</option>
              {(reasons.data ?? []).map((r) => (
                <option key={r.code} value={r.code}>
                  {r.name}
                </option>
              ))}
            </Select>
          </Field>
        )}

        <Field label="비고" htmlFor="sd-note">
          <Input
            id="sd-note"
            value={header.note}
            onChange={(e) => setHeader({ ...header, note: e.target.value })}
          />
        </Field>
      </div>

      <div className="mt-4" id="sd-lines">
        <VoucherLineEditor<Line>
          columns={columns}
          lines={lines}
          onChange={setLines}
          newLine={emptyLine}
          recompute={(l) => ({
            ...l,
            amount: l.quantity && l.unitCost ? D(l.quantity).times(D(l.unitCost)).toFixed(0) : '',
          })}
        />
      </div>

      {docType === 'ISSUE' || docType === 'TRANSFER' ? (
        <p className="mt-2 text-xs text-slate-500">
          출고 단가는 확정 시 월 총평균법(DEC-01)으로 자동 산정됩니다.
        </p>
      ) : (
        <p className="mt-2 text-right text-sm">
          합계 <span className="tabular font-medium">{fmt.krw(total.toString())}</span>
        </p>
      )}

      <div className="mt-4 flex gap-1.5">
        <Button variant="primary" size="sm" onClick={submit} disabled={create.isPending}>
          {create.isPending ? '저장 중' : '저장'}
        </Button>
        <Button size="sm" onClick={onCancel}>
          취소
        </Button>
      </div>
    </Card>
  );
}
