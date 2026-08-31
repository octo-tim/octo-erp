'use client';

import { use, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
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
import { FormErrorSummary, type FieldError } from '@/components/ui/form-error-summary';
import { PartnerSelect } from '@/components/sales/partner-select';
import {
  useItemResolver,
  TradeLineEditor,
  TradeTotals,
  type TradeLine,
} from '@/components/sales/trade-line-editor';
import { itemLabel } from '@/lib/item-match';
import { fmt } from '@/lib/format';

/**
 * SLS-05/SLS-07/SLS-11: one sales document with everything its confirmation produced —
 * the receivable, the journal entry and the stock movement — each linked so a figure can
 * always be traced to the record behind it.
 */
const STATUS_LABEL: Record<string, string> = {
  DRAFT: '작성중',
  PENDING_APPROVAL: '결재중',
  CONFIRMED: '확정',
  CANCELED: '취소',
};
const TAX_LABEL: Record<string, string> = { TAXABLE: '과세', ZERO: '영세', EXEMPT: '면세' };

interface ApiErrorShape {
  message?: string;
  data?: { appCode?: string };
}

export default function SalesDocumentDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const utils = api.useUtils();
  const refresh = { onSuccess: () => utils.sales.invalidate() };

  const detail = api.sales.salesDocument.useQuery({ id });
  const warehouses = api.master.warehouses.useQuery({ activeOnly: true });
  const confirm = api.sales.confirmSalesDocument.useMutation(refresh);
  const cancel = api.sales.cancelSalesDocument.useMutation(refresh);
  const issueInvoice = api.sales.issueTaxInvoice.useMutation(refresh);
  const submitApproval = api.sales.submitSalesDocumentForApproval.useMutation(refresh);
  const submitCancellation = api.sales.submitSalesDocumentCancellation.useMutation(refresh);
  const update = api.sales.updateSalesDocument.useMutation(refresh);
  const history = api.sales.taxInvoiceHistory.useQuery({ documentId: id });

  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cancelReason, setCancelReason] = useState('');
  const [cancelling, setCancelling] = useState(false);
  const [invoiceEmail, setInvoiceEmail] = useState('');
  const [previewing, setPreviewing] = useState(false);

  // SLS-05: correcting a DRAFT sales document before it is confirmed
  const [editing, setEditing] = useState(false);
  const [editHeader, setEditHeader] = useState({ docDate: '', partnerId: '', warehouseId: '', note: '' });
  const [editLines, setEditLines] = useState<TradeLine[]>([]);
  const [formErrors, setFormErrors] = useState<FieldError[]>([]);
  const resolveItems = useItemResolver();

  if (detail.isLoading) return <Spinner />;
  if (detail.error) return <EmptyState title="전표를 찾을 수 없습니다." description={detail.error.message} />;
  const d = detail.data!;
  const isReturn = d.docType === 'RETURN_SALES';

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

  /**
   * A line created by 주문서 출고 consumes a quantity from the order line, and that link lives
   * in DocumentConversion rather than on the document line. Saving an edit releases the old
   * links and re-establishes only the ones the caller sends back — and the editor cannot send
   * them back reliably, because rows can be added, removed or reordered and there is nothing
   * stable to match them by. Editing such a document would quietly give the order its
   * quantity back while the goods stay shipped. So it is refused here: cancel the document
   * and issue it again from the order.
   */
  const orderLinked = d.lines.some((l) => l.sourceLineId);

  function startEdit() {
    setMessage(null);
    setError(null);
    setFormErrors([]);
    setEditHeader({
      docDate: fmt.date(d.docDate as unknown as string),
      partnerId: d.partner.id,
      warehouseId: d.warehouse.id,
      note: d.note ?? '',
    });
    setEditLines(
      d.lines.map((l) => ({
        itemLabel: itemLabel({ name: l.item.name, code: l.item.code }),
        description: l.description ?? '',
        quantity: l.quantity as unknown as string,
        unitPrice: l.unitPrice as unknown as string,
        taxType: l.taxType,
        supplyAmount: l.supplyAmount as unknown as string,
        vatAmount: l.vatAmount as unknown as string,
      })),
    );
    setEditing(true);
  }

  async function submitEdit() {
    setFormErrors([]);
    const entered = editLines.filter((l) => l.itemLabel.trim() || l.quantity.trim());
    // CR-14: the server resolves what was typed, so items outside the suggestion list are found
    const resolved = entered.length > 0 ? await resolveItems(entered.map((l) => l.itemLabel)) : null;
    const prepared =
      resolved && 'ids' in resolved
        ? entered.map((line, i) => ({ index: i, itemId: resolved.ids[i]!, line }))
        : [];

    const problems: FieldError[] = [];
    if (!editHeader.partnerId)
      problems.push({ field: 'sde-partner', label: '거래처', message: '거래처를 선택하세요.' });
    if (!editHeader.warehouseId)
      problems.push({ field: 'sde-wh', label: '창고', message: '창고를 선택하세요.' });
    if (entered.length === 0) {
      problems.push({ field: 'sde-lines', label: '품목', message: '품목을 한 건 이상 입력하세요.' });
    } else if (resolved && 'errors' in resolved) {
      for (const message of resolved.errors) problems.push({ field: 'sde-lines', label: '품목', message });
    }
    if (problems.length) {
      setFormErrors(problems);
      return;
    }

    try {
      await update.mutateAsync({
        id,
        version: d.version,
        docDate: editHeader.docDate,
        partnerId: editHeader.partnerId,
        warehouseId: editHeader.warehouseId,
        ...(editHeader.note ? { note: editHeader.note } : {}),
        ...(d.divisionId ? { divisionId: d.divisionId } : {}),
        lines: prepared.map((p) => ({
          itemId: p.itemId,
          ...(p.line.description ? { description: p.line.description } : {}),
          quantity: p.line.quantity,
          unitPrice: p.line.unitPrice,
          taxType: (p.line.taxType || 'TAXABLE') as 'TAXABLE',
        })),
        requestId: newRequestId(),
      });
      setEditing(false);
      setMessage('매출전표를 수정했습니다.');
    } catch (err) {
      const shape = err as ApiErrorShape;
      if (shape.data?.appCode === 'VERSION_CONFLICT') {
        // the on-screen copy is now stale; refetch instead of retrying with the old version
        await detail.refetch();
      }
      setFormErrors([{ field: 'sde-date', label: '저장', message: shape.message ?? '저장에 실패했습니다.' }]);
    }
  }

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h1 className="text-lg font-semibold">
            {isReturn ? '매출반품' : '매출전표'}{' '}
            <span className="ml-1 text-sm font-normal text-slate-500">{d.docNo}</span>
          </h1>
          <p className="mt-0.5 text-sm text-slate-500">
            {fmt.date(d.docDate as unknown as string)} · {d.partner.name} · {d.warehouse.name}
            {d.division ? ` · ${d.division.name}` : ''}
          </p>
        </div>
        <StatusBadge status={d.status} label={STATUS_LABEL[d.status] ?? d.status} />
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

      {d.original ? (
        <p className="rounded bg-blue-50 px-3 py-2 text-sm text-blue-900">
          원 전표{' '}
          <Link className="underline" href={`/sales/sales-documents/${d.original.id}`}>
            {d.original.docNo}
          </Link>
          의 반품입니다.
        </p>
      ) : null}

      {editing ? (
        <Card
          title="매출전표 수정"
          actions={
            <Button size="sm" onClick={() => setEditing(false)}>
              닫기
            </Button>
          }
        >
          <FormErrorSummary errors={formErrors} />
          <p className="mb-3 text-xs text-slate-500">품목을 변경해 저장하면 라인이 새로 채번됩니다.</p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
            <Field label="전표일" htmlFor="sde-date" required>
              <Input
                id="sde-date"
                type="date"
                value={editHeader.docDate}
                onChange={(e) => setEditHeader({ ...editHeader, docDate: e.target.value })}
              />
            </Field>
            <Field label="거래처" htmlFor="sde-partner" required>
              <PartnerSelect
                id="sde-partner"
                partnerType="CUSTOMER"
                value={editHeader.partnerId}
                onChange={(v) => setEditHeader({ ...editHeader, partnerId: v })}
              />
            </Field>
            <Field label="출고 창고" htmlFor="sde-wh" required>
              <Select
                id="sde-wh"
                value={editHeader.warehouseId}
                onChange={(e) => setEditHeader({ ...editHeader, warehouseId: e.target.value })}
              >
                <option value="">선택</option>
                {(warehouses.data ?? []).map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="비고" htmlFor="sde-note">
              <Input
                id="sde-note"
                value={editHeader.note}
                onChange={(e) => setEditHeader({ ...editHeader, note: e.target.value })}
              />
            </Field>
          </div>

          <div className="mt-4" id="sde-lines">
            <TradeLineEditor lines={editLines} onChange={setEditLines} />
          </div>
          <TradeTotals lines={editLines} />

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
            <table className="w-full min-w-[46rem] text-sm">
              <thead className="border-b border-slate-200 text-left text-slate-500">
                <tr>
                  <th className="px-2 py-1.5 font-medium">#</th>
                  <th className="px-2 py-1.5 font-medium">품목</th>
                  <th className="px-2 py-1.5 font-medium">규격</th>
                  <th className="px-2 py-1.5 font-medium">과세</th>
                  <th className="px-2 py-1.5 text-right font-medium">수량</th>
                  <th className="px-2 py-1.5 text-right font-medium">단가</th>
                  <th className="px-2 py-1.5 text-right font-medium">공급가액</th>
                  <th className="px-2 py-1.5 text-right font-medium">세액</th>
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
                    <td className="px-2 py-1.5">{TAX_LABEL[l.taxType] ?? l.taxType}</td>
                    <td className="tabular px-2 py-1.5 text-right">
                      {fmt.qty(l.quantity as unknown as string)} {l.item.unitCode}
                    </td>
                    <td className="tabular px-2 py-1.5 text-right">
                      {fmt.krw(l.unitPrice as unknown as string)}
                    </td>
                    <td className="tabular px-2 py-1.5 text-right">
                      {fmt.krw(l.supplyAmount as unknown as string)}
                    </td>
                    <td className="tabular px-2 py-1.5 text-right">
                      {fmt.krw(l.vatAmount as unknown as string)}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-slate-300 font-medium">
                  <td className="px-2 py-1.5" colSpan={6}>
                    합계
                  </td>
                  <td className="tabular px-2 py-1.5 text-right">
                    {fmt.krw(d.supplyAmount as unknown as string)}
                  </td>
                  <td className="tabular px-2 py-1.5 text-right">
                    {fmt.krw(d.vatAmount as unknown as string)}
                  </td>
                </tr>
                <tr className="font-semibold">
                  <td className="px-2 py-1.5" colSpan={6}>
                    총액
                  </td>
                  <td className="tabular px-2 py-1.5 text-right" colSpan={2}>
                    {fmt.krw(d.totalAmount as unknown as string)}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        </Card>
      )}

      <Card title="처리">
        <div className="mb-3 flex flex-col gap-2">
          <ApprovalActions
            idPrefix="sd-apv"
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
          {d.status === 'DRAFT' ? (
            <Button
              variant="primary"
              size="sm"
              disabled={!editing && orderLinked}
              title={
                orderLinked
                  ? '주문서 출고로 생성된 전표입니다. 취소 후 주문서에서 다시 출고하세요.'
                  : undefined
              }
              onClick={editing ? () => setEditing(false) : startEdit}
            >
              {editing ? '수정 닫기' : '수정'}
            </Button>
          ) : null}
          {(d.status === 'DRAFT' || d.status === 'PENDING_APPROVAL') && !d.approvalRequired ? (
            <Button
              variant="primary"
              size="sm"
              onClick={() =>
                run(
                  () => confirm.mutateAsync({ id, version: d.version, requestId: newRequestId() }),
                  '확정했습니다. 재고·미수금·회계 분개가 함께 반영되었습니다.',
                )
              }
            >
              확정
            </Button>
          ) : null}
          {d.status !== 'CANCELED' && d.approval?.status !== 'APPROVED' ? (
            <Button size="sm" variant="danger" onClick={() => setCancelling((v) => !v)}>
              {cancelling ? '취소 닫기' : '전표 취소'}
            </Button>
          ) : null}
          {d.status === 'CONFIRMED' && !isReturn ? (
            <Button size="sm" onClick={() => router.push(`/sales/returns?originalId=${id}`)}>
              반품 등록
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
                }, '취소했습니다. 재고 반대원장·채권 원복·회계 역분개가 생성되었습니다.')
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

      <Card title="연결된 기록">
        <dl className="grid grid-cols-[8rem_1fr] gap-y-2 text-sm">
          <dt className="text-slate-500">미수금</dt>
          <dd>
            {d.receivable ? (
              <>
                {fmt.krw(d.receivable.amount as unknown as string)}원 · 수금{' '}
                {fmt.krw(d.receivable.settledAmount as unknown as string)}원 · {d.receivable.status}
              </>
            ) : (
              '확정 시 생성됩니다.'
            )}
          </dd>
          <dt className="text-slate-500">회계 분개</dt>
          <dd>
            {d.journalEntry ? (
              <Link
                className="text-blue-700 hover:underline"
                href={`/accounting/journals/${d.journalEntry.id}`}
              >
                {d.journalEntry.entryNo}
              </Link>
            ) : (
              '확정 시 생성됩니다.'
            )}
          </dd>
          <dt className="text-slate-500">반품</dt>
          <dd>
            {d.returns.length === 0
              ? '없음'
              : d.returns.map((r) => (
                  <Link
                    key={r.id}
                    className="mr-2 text-blue-700 hover:underline"
                    href={`/sales/sales-documents/${r.id}`}
                  >
                    {r.docNo}
                  </Link>
                ))}
          </dd>
        </dl>
      </Card>

      {d.status === 'CONFIRMED' && !isReturn ? (
        <Card title="세금계산서 (SLS-07)">
          <p className="mb-3 text-sm text-slate-600">
            사내 관리용 서식입니다. 국세청에 전송되는 전자세금계산서가 아닙니다.
          </p>
          <div className="flex flex-wrap items-end gap-2">
            <div className="min-w-0 flex-1">
              <label className="mb-1 block text-sm text-slate-600" htmlFor="sd-invoice-email">
                받는 사람 이메일
              </label>
              <Input
                id="sd-invoice-email"
                type="email"
                placeholder={d.partner.email ?? 'buyer@example.com'}
                value={invoiceEmail}
                onChange={(e) => setInvoiceEmail(e.target.value)}
              />
            </div>
            <Button size="sm" onClick={() => setPreviewing((v) => !v)}>
              {previewing ? '미리보기 닫기' : '미리보기·인쇄'}
            </Button>
            <Button
              size="sm"
              onClick={() =>
                run(
                  () =>
                    issueInvoice.mutateAsync({
                      documentId: id,
                      send: false,
                      requestId: newRequestId(),
                    }),
                  '세금계산서를 발행했습니다.',
                )
              }
            >
              발행
            </Button>
            <Button
              size="sm"
              variant="primary"
              onClick={() =>
                run(
                  () =>
                    issueInvoice.mutateAsync({
                      documentId: id,
                      ...(invoiceEmail ? { email: invoiceEmail } : {}),
                      send: true,
                      requestId: newRequestId(),
                    }),
                  '세금계산서를 발행하고 이메일 발송을 예약했습니다.',
                )
              }
            >
              발행 후 이메일 발송
            </Button>
          </div>

          {previewing ? <TaxInvoicePreview documentId={id} /> : null}

          <h3 className="mt-4 text-sm font-semibold">발행 이력</h3>
          {history.isLoading ? (
            <Spinner />
          ) : history.error ? (
            <p role="alert" className="mt-2 text-sm text-red-700">
              {history.error.message}
            </p>
          ) : (history.data ?? []).length === 0 ? (
            <p className="mt-2 text-sm text-slate-500">아직 발행 이력이 없습니다.</p>
          ) : (
            <ul className="mt-2 divide-y divide-slate-100 text-sm">
              {(history.data ?? []).map((t) => (
                <li key={t.id} className="flex flex-wrap items-center gap-3 py-1.5">
                  <span>{fmt.dateTime(t.createdAt as unknown as string)}</span>
                  <span className="text-slate-500">{t.recipientEmail ?? '이메일 미발송'}</span>
                  <span className="ml-auto">{t.status === 'SENT' ? '발송' : '발행'}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      ) : null}

      <AttachmentPanel ownerType="SALES_DOC" ownerId={id} readOnly={d.status === 'CANCELED'} />
    </div>
  );
}

/**
 * SLS-07: the tax invoice as a printable A4 layout. No PDF library is used — the browser's
 * own print pipeline (window.print, @media print) turns this into a PDF or a paper copy.
 */
function TaxInvoicePreview({ documentId }: { documentId: string }) {
  const invoice = api.sales.taxInvoice.useQuery({ documentId });

  if (invoice.isLoading) return <Spinner />;
  if (invoice.error)
    return (
      <p role="alert" className="mt-3 rounded bg-red-50 px-3 py-2 text-sm text-red-700">
        {invoice.error.message}
      </p>
    );
  const { data } = invoice.data!;

  return (
    <div className="tax-invoice-print mt-3 rounded-md border border-slate-300 p-4">
      <style>{`
        .tax-invoice-print table { width: 100%; border-collapse: collapse; font-size: 12px; }
        .tax-invoice-print th, .tax-invoice-print td { border: 1px solid #94a3b8; padding: 4px 6px; }
        .tax-invoice-print th { background: #f1f5f9; font-weight: 600; }
        @media print {
          @page { size: A4; margin: 12mm; }
          body * { visibility: hidden; }
          .tax-invoice-print, .tax-invoice-print * { visibility: visible; }
          .tax-invoice-print { position: absolute; inset: 0; width: 100%; border: none; padding: 0; }
          .tax-invoice-print .no-print { display: none; }
        }
      `}</style>

      <div className="no-print mb-3 flex justify-end">
        <Button size="sm" variant="primary" onClick={() => window.print()}>
          인쇄
        </Button>
      </div>

      <h2 className="text-center text-lg font-bold tracking-[0.6em]">세 금 계 산 서</h2>
      <p className="mb-3 text-center text-sm text-slate-500">
        {data.docNo} · {data.docDate}
      </p>

      <table className="mb-2">
        <tbody>
          <tr>
            <td className="w-1/2 align-top">
              <strong>공급자</strong>
              <br />
              등록번호 {data.supplier.businessNo}
              <br />
              상호 {data.supplier.name} / 대표 {data.supplier.ceoName}
              <br />
              주소 {data.supplier.address}
              <br />
              업태 {data.supplier.businessType} / 종목 {data.supplier.businessItem}
            </td>
            <td className="w-1/2 align-top">
              <strong>공급받는자</strong>
              <br />
              등록번호 {data.buyer.businessNo}
              <br />
              상호 {data.buyer.name} / 대표 {data.buyer.ceoName}
              <br />
              주소 {data.buyer.address}
              <br />
              이메일 {data.buyer.email}
            </td>
          </tr>
        </tbody>
      </table>

      <table className="mb-2">
        <thead>
          <tr>
            <th className="w-8">#</th>
            <th>품목</th>
            <th className="w-24">규격</th>
            <th className="w-16">과세</th>
            <th className="w-20 text-right">수량</th>
            <th className="w-24 text-right">단가</th>
            <th className="w-28 text-right">공급가액</th>
            <th className="w-24 text-right">세액</th>
          </tr>
        </thead>
        <tbody>
          {data.lines.map((l) => (
            <tr key={l.lineNo}>
              <td className="text-center">{l.lineNo}</td>
              <td>{l.itemName}</td>
              <td>{l.spec}</td>
              <td className="text-center">{l.taxTypeLabel}</td>
              <td className="tabular text-right">{fmt.qty(l.quantity)}</td>
              <td className="tabular text-right">{l.unitPrice}</td>
              <td className="tabular text-right">{l.supplyAmount}</td>
              <td className="tabular text-right">{l.vatAmount}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <table>
        <tbody>
          <tr>
            <th className="w-24">공급가액</th>
            <td className="tabular text-right">{data.supplyAmount}</td>
            <th className="w-24">세액</th>
            <td className="tabular text-right">{data.vatAmount}</td>
            <th className="w-24">합계</th>
            <td className="tabular text-right font-semibold">{data.totalAmount}</td>
          </tr>
        </tbody>
      </table>

      <p className="mt-3 rounded border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800">
        {data.notice}
      </p>
    </div>
  );
}
