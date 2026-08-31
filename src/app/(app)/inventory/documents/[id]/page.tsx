'use client';

import { use, useState } from 'react';
import Link from 'next/link';
import { api, newRequestId } from '@/lib/trpc';
import { ApprovalActions } from '@/components/documents/approval-actions';
import { AttachmentPanel } from '@/components/ui/attachment-panel';
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
import { ChangeHistory } from '@/components/ui/change-history';
import { FormErrorSummary, type FieldError } from '@/components/ui/form-error-summary';
import { VoucherLineEditor, type LineColumn } from '@/components/ui/voucher-line-editor';
import { itemLabel, matchErrorText, resolveItemLabels, searchTermOf } from '@/lib/item-match';
import { add, D } from '@/lib/money';
import { fmt } from '@/lib/format';

interface ApiErrorShape {
  message?: string;
  data?: { appCode?: string };
}

/** the three doc types this screen lets an operator correct while still DRAFT (INV-01/02/03) */
type EditableDocType = 'RECEIPT' | 'ISSUE' | 'TRANSFER';

interface EditLine extends Record<string, string> {
  itemId: string;
  itemLabel: string;
  quantity: string;
  unitCost: string;
  amount: string;
  note: string;
}

const emptyEditLine = (): EditLine => ({
  itemId: '',
  itemLabel: '',
  quantity: '',
  unitCost: '',
  amount: '',
  note: '',
});

/**
 * INV-01/02/03/04: one stock document, its lines, and the ledger rows it produced.
 * Showing the ledger rows here is deliberate — INT-04 says the ledger is the truth, so
 * the screen lets an operator see exactly what the confirmation wrote.
 */
const STATUS_LABEL: Record<string, string> = {
  DRAFT: '작성중',
  PENDING_APPROVAL: '결재중',
  CONFIRMED: '확정',
  CANCELED: '취소',
};
const MOVEMENT_LABEL: Record<string, string> = {
  REQUESTED: '요청',
  IN_TRANSIT: '이동중',
  COMPLETED: '완료',
  CANCELED: '취소',
};
const TYPE_LABEL: Record<string, string> = {
  RECEIPT: '입고',
  ISSUE: '출고',
  TRANSFER: '창고이동',
  ADJUST: '재고조정',
};

export default function StockDocumentDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const utils = api.useUtils();
  const refresh = { onSuccess: () => utils.inventory.invalidate() };

  const detail = api.inventory.document.useQuery({ id });
  const confirm = api.inventory.confirmDocument.useMutation(refresh);
  const cancel = api.inventory.cancelDocument.useMutation(refresh);
  const ship = api.inventory.shipTransfer.useMutation(refresh);
  const submitApproval = api.inventory.submitForApproval.useMutation(refresh);
  const submitCancellation = api.inventory.submitCancellation.useMutation(refresh);
  const update = api.inventory.updateDocument.useMutation(refresh);

  const warehouses = api.master.warehouses.useQuery({ activeOnly: true });
  const reasonsIn = api.master.codes.useQuery({ groupCode: 'STOCK_REASON_IN', activeOnly: true });
  const reasonsOut = api.master.codes.useQuery({ groupCode: 'STOCK_REASON_OUT', activeOnly: true });

  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cancelReason, setCancelReason] = useState('');
  const [cancelling, setCancelling] = useState(false);

  // INV-05: correcting a DRAFT stock document before it is confirmed
  const [editing, setEditing] = useState(false);
  const [editHeader, setEditHeader] = useState({
    docDate: '',
    fromWarehouseId: '',
    toWarehouseId: '',
    reasonCode: '',
    note: '',
  });
  const [editLines, setEditLines] = useState<EditLine[]>([]);
  const [formErrors, setFormErrors] = useState<FieldError[]>([]);
  const [itemQuery, setItemQuery] = useState('');
  const items = api.master.searchItems.useQuery({ q: itemQuery, take: 20 });

  if (detail.isLoading) return <Spinner />;
  if (detail.error) return <EmptyState title="전표를 찾을 수 없습니다." description={detail.error.message} />;
  const d = detail.data!;
  const editableType = d.docType as EditableDocType;
  // ADJUST documents are created and confirmed together by 재고실사 and never sit in DRAFT
  // here, so correcting one is only ever offered for a manual/이동 document.
  const canEdit = d.status === 'DRAFT' && d.docType !== 'ADJUST';
  const reasons = editableType === 'RECEIPT' ? reasonsIn : reasonsOut;

  async function run(fn: () => Promise<unknown>, ok: string) {
    setError(null);
    setMessage(null);
    try {
      await fn();
      setMessage(ok);
    } catch (err) {
      setError((err as { message?: string }).message ?? '처리에 실패했습니다.');
    }
  }

  const suggestions = (items.data ?? []).map((i) => ({ value: i.id, label: itemLabel(i) }));

  function startEdit() {
    setMessage(null);
    setError(null);
    setFormErrors([]);
    setEditHeader({
      docDate: fmt.date(d.docDate as unknown as string),
      fromWarehouseId: d.fromWarehouse?.id ?? '',
      toWarehouseId: d.toWarehouse?.id ?? '',
      reasonCode: d.reasonCode ?? '',
      note: d.note ?? '',
    });
    setEditLines(
      d.lines.map((l) => ({
        itemId: l.item.id,
        itemLabel: itemLabel({ name: l.item.name, code: l.item.code }),
        quantity: l.quantity as unknown as string,
        unitCost: l.unitCost ? (l.unitCost as unknown as string) : '',
        amount: l.amount as unknown as string,
        note: l.note ?? '',
      })),
    );
    setEditing(true);
  }

  const onEditLinesChange = (next: EditLine[]) => {
    const changed = next.find((l, i) => l.itemLabel !== (editLines[i]?.itemLabel ?? ''));
    if (changed) setItemQuery(searchTermOf(changed.itemLabel));
    setEditLines(next);
  };

  async function submitEdit() {
    setFormErrors([]);
    const problems: FieldError[] = [];
    if ((editableType === 'ISSUE' || editableType === 'TRANSFER') && !editHeader.fromWarehouseId) {
      problems.push({ field: 'sde-from', label: '출고 창고', message: '창고를 선택하세요.' });
    }
    if ((editableType === 'RECEIPT' || editableType === 'TRANSFER') && !editHeader.toWarehouseId) {
      problems.push({ field: 'sde-to', label: '입고 창고', message: '창고를 선택하세요.' });
    }
    if (editableType !== 'TRANSFER' && !editHeader.reasonCode) {
      problems.push({ field: 'sde-reason', label: '사유', message: '사유를 선택하세요.' });
    }

    const entered = editLines.filter((l) => l.itemLabel.trim() || l.quantity.trim());
    if (entered.length === 0) {
      problems.push({ field: 'sde-lines', label: '품목', message: '품목을 한 건 이상 입력하세요.' });
    }

    // CR-14: the server resolves what was typed, so an item outside the suggestion list is found
    const matches =
      entered.length > 0
        ? await resolveItemLabels(
            entered.map((l) => l.itemLabel),
            (term) => utils.master.searchItems.fetch({ q: term, take: 5 }),
          )
        : [];
    for (const [i, m] of matches.entries()) {
      const message = matchErrorText(i + 1, m);
      if (message) problems.push({ field: 'sde-lines', label: '품목', message });
    }

    if (problems.length) {
      setFormErrors(problems);
      return;
    }

    const prepared = entered.map((l, i) => ({
      itemId: (matches[i] as { kind: 'OK'; id: string }).id,
      quantity: l.quantity,
      ...(l.unitCost ? { unitCost: l.unitCost } : {}),
      ...(l.note ? { note: l.note } : {}),
    }));

    try {
      await update.mutateAsync({
        id,
        version: d.version,
        docType: editableType,
        docDate: editHeader.docDate,
        ...(editableType === 'ISSUE' || editableType === 'TRANSFER'
          ? { fromWarehouseId: editHeader.fromWarehouseId }
          : {}),
        ...(editableType === 'RECEIPT' || editableType === 'TRANSFER'
          ? { toWarehouseId: editHeader.toWarehouseId }
          : {}),
        ...(editableType === 'TRANSFER' ? {} : { reasonCode: editHeader.reasonCode }),
        ...(d.partner ? { partnerId: d.partner.id } : {}),
        ...(d.divisionId ? { divisionId: d.divisionId } : {}),
        ...(editHeader.note ? { note: editHeader.note } : {}),
        lines: prepared,
        requestId: newRequestId(),
      });
      setEditing(false);
      setMessage('재고전표를 수정했습니다.');
    } catch (err) {
      const shape = err as ApiErrorShape;
      if (shape.data?.appCode === 'VERSION_CONFLICT') {
        // the on-screen copy is now stale; refetch instead of retrying with the old version
        await detail.refetch();
      }
      setFormErrors([{ field: 'sde-date', label: '저장', message: shape.message ?? '저장에 실패했습니다.' }]);
    }
  }

  const editColumns: LineColumn<EditLine>[] = [
    { key: 'itemLabel', header: '품목', kind: 'text', required: true, suggestions },
    { key: 'quantity', header: '수량', kind: 'qty', width: 110, required: true, total: true },
    ...(editableType === 'RECEIPT'
      ? ([{ key: 'unitCost', header: '단가', kind: 'unitPrice', width: 120 }] as LineColumn<EditLine>[])
      : []),
    ...(editableType === 'RECEIPT'
      ? ([
          { key: 'amount', header: '금액', kind: 'readonly', width: 130, total: true },
        ] as LineColumn<EditLine>[])
      : []),
    { key: 'note', header: '비고', kind: 'text' },
  ];

  const canShip = d.docType === 'TRANSFER' && d.movementState === 'REQUESTED' && d.status === 'DRAFT';
  // APV-08: a document an approval must carry is never confirmed from this screen
  const canConfirm =
    d.status === 'DRAFT' &&
    !d.approvalRequired &&
    (d.docType !== 'TRANSFER' || d.movementState === 'IN_TRANSIT');
  const canCancel = (d.status === 'CONFIRMED' || d.status === 'DRAFT') && d.approval?.status !== 'APPROVED';

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h1 className="text-lg font-semibold">
            {TYPE_LABEL[d.docType] ?? d.docType}{' '}
            <span className="ml-1 text-sm font-normal text-slate-500">{d.docNo}</span>
          </h1>
          <p className="mt-0.5 text-sm text-slate-500">
            {fmt.date(d.docDate as unknown as string)} ·{' '}
            {d.fromWarehouse?.name ? `${d.fromWarehouse.name} → ` : ''}
            {d.toWarehouse?.name ?? ''}
            {d.reasonCode ? ` · ${d.reasonCode}` : ''}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {d.movementState ? (
            <span className="rounded bg-slate-100 px-2 py-0.5 text-xs text-slate-700">
              {MOVEMENT_LABEL[d.movementState] ?? d.movementState}
            </span>
          ) : null}
          <StatusBadge status={d.status} label={STATUS_LABEL[d.status] ?? d.status} />
        </div>
      </header>

      {message ? (
        <p role="status" className="rounded bg-green-50 px-3 py-2 text-sm text-green-800">
          {message}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="whitespace-pre-line rounded bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      ) : null}

      {editing ? (
        <Card
          title="재고전표 수정"
          actions={
            <Button size="sm" onClick={() => setEditing(false)}>
              닫기
            </Button>
          }
        >
          <FormErrorSummary errors={formErrors} />
          <p className="mb-3 text-xs text-slate-500">품목을 변경해 저장하면 라인이 새로 채번됩니다.</p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
            <Field label="일자" htmlFor="sde-date" required>
              <Input
                id="sde-date"
                type="date"
                value={editHeader.docDate}
                onChange={(e) => setEditHeader({ ...editHeader, docDate: e.target.value })}
              />
            </Field>
            {editableType === 'ISSUE' || editableType === 'TRANSFER' ? (
              <Field
                label={editableType === 'TRANSFER' ? '출발 창고' : '출고 창고'}
                htmlFor="sde-from"
                required
              >
                <Select
                  id="sde-from"
                  value={editHeader.fromWarehouseId}
                  onChange={(e) => setEditHeader({ ...editHeader, fromWarehouseId: e.target.value })}
                >
                  <option value="">선택</option>
                  {(warehouses.data ?? []).map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.name}
                    </option>
                  ))}
                </Select>
              </Field>
            ) : null}
            {editableType === 'RECEIPT' || editableType === 'TRANSFER' ? (
              <Field
                label={editableType === 'TRANSFER' ? '도착 창고' : '입고 창고'}
                htmlFor="sde-to"
                required
              >
                <Select
                  id="sde-to"
                  value={editHeader.toWarehouseId}
                  onChange={(e) => setEditHeader({ ...editHeader, toWarehouseId: e.target.value })}
                >
                  <option value="">선택</option>
                  {(warehouses.data ?? []).map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.name}
                    </option>
                  ))}
                </Select>
              </Field>
            ) : null}
            {editableType === 'TRANSFER' ? null : (
              <Field label="사유" htmlFor="sde-reason" required hint="수동 입출고는 사유가 필요합니다">
                <Select
                  id="sde-reason"
                  value={editHeader.reasonCode}
                  onChange={(e) => setEditHeader({ ...editHeader, reasonCode: e.target.value })}
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
            <Field label="비고" htmlFor="sde-note">
              <Input
                id="sde-note"
                value={editHeader.note}
                onChange={(e) => setEditHeader({ ...editHeader, note: e.target.value })}
              />
            </Field>
          </div>

          <div className="mt-4" id="sde-lines">
            <VoucherLineEditor<EditLine>
              columns={editColumns}
              lines={editLines}
              onChange={onEditLinesChange}
              newLine={emptyEditLine}
              recompute={(l) => ({
                ...l,
                amount: l.quantity && l.unitCost ? D(l.quantity).times(D(l.unitCost)).toFixed(0) : '',
              })}
            />
          </div>

          {editableType === 'ISSUE' || editableType === 'TRANSFER' ? (
            <p className="mt-2 text-xs text-slate-500">
              출고 단가는 확정 시 월 총평균법(DEC-01)으로 자동 산정됩니다.
            </p>
          ) : (
            <p className="mt-2 text-right text-sm">
              합계{' '}
              <span className="tabular font-medium">
                {fmt.krw(editLines.reduce((acc, l) => add(acc, l.amount || '0'), D(0)).toString())}
              </span>
            </p>
          )}

          <div className="mt-4 flex gap-1.5">
            <Button variant="primary" size="sm" onClick={submitEdit} disabled={update.isPending}>
              {update.isPending ? '저장 중' : '저장'}
            </Button>
            <Button size="sm" onClick={() => setEditing(false)}>
              취소
            </Button>
          </div>
        </Card>
      ) : (
        <Card title="품목">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[40rem] text-sm">
              <thead className="border-b border-slate-200 text-left text-slate-500">
                <tr>
                  <th className="px-2 py-1.5 font-medium">#</th>
                  <th className="px-2 py-1.5 font-medium">품목</th>
                  <th className="px-2 py-1.5 font-medium">규격</th>
                  <th className="px-2 py-1.5 text-right font-medium">수량</th>
                  <th className="px-2 py-1.5 text-right font-medium">단가</th>
                  <th className="px-2 py-1.5 text-right font-medium">금액</th>
                </tr>
              </thead>
              <tbody>
                {d.lines.map((l) => (
                  <tr key={l.id} className="border-b border-slate-100">
                    <td className="px-2 py-1.5">{l.lineNo}</td>
                    <td className="px-2 py-1.5">
                      {l.item.name} <span className="text-slate-500">{l.item.code}</span>
                    </td>
                    <td className="px-2 py-1.5">{l.item.spec ?? '-'}</td>
                    <td className="tabular px-2 py-1.5 text-right">
                      {fmt.qty(l.quantity as unknown as string)} {l.item.unitCode}
                    </td>
                    <td className="tabular px-2 py-1.5 text-right">
                      {l.unitCost ? fmt.krw(l.unitCost as unknown as string) : '-'}
                    </td>
                    <td className="tabular px-2 py-1.5 text-right">
                      {fmt.krw(l.amount as unknown as string)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      <Card title="처리">
        <div className="mb-3 flex flex-col gap-2">
          <ApprovalActions
            idPrefix="std-apv"
            status={d.status}
            approvalRequired={d.approvalRequired}
            approvalReason={d.approvalReason}
            approval={d.approval}
            cancellationApproval={d.cancellationApproval}
            onSubmitForApproval={(note) =>
              run(
                () =>
                  submitApproval.mutateAsync({
                    id,
                    version: d.version,
                    ...(note ? { note } : {}),
                    requestId: newRequestId(),
                  }),
                '결재를 상신했습니다. 승인되면 전표가 확정됩니다.',
              )
            }
            onSubmitCancellation={(reason) =>
              run(
                () => submitCancellation.mutateAsync({ id, reason, requestId: newRequestId() }),
                '취소 결재를 상신했습니다. 승인되면 전표가 취소됩니다.',
              )
            }
          />
        </div>
        <div className="flex flex-wrap gap-1.5">
          {canEdit ? (
            <Button variant="primary" size="sm" onClick={editing ? () => setEditing(false) : startEdit}>
              {editing ? '수정 닫기' : '수정'}
            </Button>
          ) : null}
          {canShip ? (
            <Button
              size="sm"
              onClick={() =>
                run(
                  () => ship.mutateAsync({ id, version: d.version, requestId: newRequestId() }),
                  '이동중으로 변경했습니다.',
                )
              }
            >
              출발 처리
            </Button>
          ) : null}
          {canConfirm ? (
            <Button
              variant="primary"
              size="sm"
              onClick={() =>
                run(
                  () => confirm.mutateAsync({ id, version: d.version, requestId: newRequestId() }),
                  '확정했습니다. 재고 원장에 반영되었습니다.',
                )
              }
            >
              {d.docType === 'TRANSFER' ? '도착 처리(확정)' : '확정'}
            </Button>
          ) : null}
          {canCancel ? (
            <Button size="sm" variant="danger" onClick={() => setCancelling((v) => !v)}>
              {cancelling ? '취소 닫기' : '전표 취소'}
            </Button>
          ) : null}
        </div>

        {cancelling ? (
          <div className="mt-3 flex flex-wrap items-end gap-2">
            <div className="min-w-0 flex-1">
              <label className="mb-1 block text-sm text-slate-600" htmlFor="sd-cancel-reason">
                취소 사유
              </label>
              <Input
                id="sd-cancel-reason"
                value={cancelReason}
                onChange={(e) => setCancelReason(e.target.value)}
              />
            </div>
            <Button
              size="sm"
              variant="danger"
              disabled={cancelReason.trim().length < 2}
              onClick={() =>
                run(async () => {
                  await cancel.mutateAsync({
                    id,
                    reason: cancelReason,
                    version: d.version,
                    requestId: newRequestId(),
                  });
                  setCancelling(false);
                  setCancelReason('');
                }, '취소했습니다. 반대 원장이 생성되었습니다.')
              }
            >
              취소 확정
            </Button>
          </div>
        ) : null}

        {d.status === 'CANCELED' && d.cancelReason ? (
          <p className="mt-3 text-sm text-slate-600">취소 사유: {d.cancelReason}</p>
        ) : null}
      </Card>

      <Card title="재고 원장 반영">
        {d.ledgerRows.length === 0 ? (
          <EmptyState title="아직 원장에 반영되지 않았습니다." description="확정 시점에 원장이 생성됩니다." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[36rem] text-sm">
              <thead className="border-b border-slate-200 text-left text-slate-500">
                <tr>
                  <th className="px-2 py-1.5 font-medium">일자</th>
                  <th className="px-2 py-1.5 font-medium">품목</th>
                  <th className="px-2 py-1.5 font-medium">창고</th>
                  <th className="px-2 py-1.5 text-right font-medium">수량</th>
                  <th className="px-2 py-1.5 text-right font-medium">금액</th>
                  <th className="px-2 py-1.5 font-medium">사유</th>
                </tr>
              </thead>
              <tbody>
                {d.ledgerRows.map((r) => (
                  <tr key={r.id} className="border-b border-slate-100">
                    <td className="px-2 py-1.5">{fmt.date(r.occurredAt as unknown as string)}</td>
                    <td className="px-2 py-1.5">{r.item.name}</td>
                    <td className="px-2 py-1.5">{r.warehouse.name}</td>
                    <td className="tabular px-2 py-1.5 text-right">
                      {fmt.qty(r.quantity as unknown as string)}
                    </td>
                    <td className="tabular px-2 py-1.5 text-right">
                      {fmt.krw(r.amount as unknown as string)}
                    </td>
                    <td className="px-2 py-1.5">{r.reason ?? '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="mt-2 text-xs text-slate-500">
          원장 행은 수정·삭제되지 않습니다. 취소 시 반대 부호의 행이 추가됩니다.
        </p>
      </Card>

      <AttachmentPanel ownerType="STOCK_DOC" ownerId={id} readOnly={d.status === 'CANCELED'} />

      <ChangeHistory entityType="StockDocument" entityId={id} />

      <p className="text-sm">
        <Link className="text-blue-700 hover:underline" href="/inventory/status">
          재고현황으로 이동
        </Link>
      </p>
    </div>
  );
}
