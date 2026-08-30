'use client';

import { use, useState } from 'react';
import Link from 'next/link';
import { api, newRequestId } from '@/lib/trpc';
import { Button, Card, EmptyState, Input, Spinner, StatusBadge } from '@/components/ui/primitives';
import { ChangeHistory } from '@/components/ui/change-history';
import { fmt } from '@/lib/format';

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

  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cancelReason, setCancelReason] = useState('');
  const [cancelling, setCancelling] = useState(false);

  if (detail.isLoading) return <Spinner />;
  if (detail.error) return <EmptyState title="전표를 찾을 수 없습니다." description={detail.error.message} />;
  const d = detail.data!;

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

  const canShip = d.docType === 'TRANSFER' && d.movementState === 'REQUESTED' && d.status === 'DRAFT';
  const canConfirm = d.status === 'DRAFT' && (d.docType !== 'TRANSFER' || d.movementState === 'IN_TRANSIT');
  const canCancel = d.status === 'CONFIRMED' || d.status === 'DRAFT';

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

      {d.approvalRequired && d.status !== 'CONFIRMED' ? (
        <p className="rounded bg-amber-50 px-3 py-2 text-sm text-amber-900">
          {d.approvalReason}. 전자결재에서 상신·승인되면 확정됩니다.
        </p>
      ) : null}

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
                  <td className="tabular px-2 py-1.5 text-right">{fmt.krw(l.amount as unknown as string)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card title="처리">
        <div className="flex flex-wrap gap-1.5">
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

      <ChangeHistory entityType="StockDocument" entityId={id} />

      <p className="text-sm">
        <Link className="text-blue-700 hover:underline" href="/inventory/status">
          재고현황으로 이동
        </Link>
      </p>
    </div>
  );
}
