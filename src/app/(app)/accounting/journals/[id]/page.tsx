'use client';

import { use, useMemo, useState } from 'react';
import Link from 'next/link';
import { api, newRequestId } from '@/lib/trpc';
import { ApprovalActions } from '@/components/documents/approval-actions';
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
import { VoucherLineEditor, type LineColumn } from '@/components/ui/voucher-line-editor';
import { FormErrorSummary, type FieldError } from '@/components/ui/form-error-summary';
import { InternalNotice } from '@/components/accounting/internal-notice';
import { fmt } from '@/lib/format';
import { add, cmp, D } from '@/lib/money';

/** ACC-02/ACC-04/ACC-08: one entry, its lines, and its reversal relationship. */
const STATUS_LABEL: Record<string, string> = {
  DRAFT: '작성중',
  PENDING_APPROVAL: '결재중',
  CONFIRMED: '확정',
  CANCELED: '취소',
};
const TYPE_LABEL: Record<string, string> = { TRANSFER: '대체', RECEIPT: '입금', PAYMENT: '출금' };

interface ApiErrorShape {
  message?: string;
  data?: { appCode?: string };
}

// ACC-02: correcting a DRAFT entry — carries hidden partner/division per line so a
// correction never silently drops a tag the create screen itself does not surface.
interface EditLine extends Record<string, string> {
  accountLabel: string;
  debit: string;
  credit: string;
  description: string;
  divisionId: string;
  partnerId: string;
}

const emptyEditLine = (): EditLine => ({
  accountLabel: '',
  debit: '',
  credit: '',
  description: '',
  divisionId: '',
  partnerId: '',
});

export default function JournalDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const utils = api.useUtils();
  const refresh = { onSuccess: () => utils.accounting.invalidate() };

  const detail = api.accounting.entry.useQuery({ id });
  const accounts = api.accounting.postableAccounts.useQuery();
  const confirm = api.accounting.confirmEntry.useMutation(refresh);
  const cancel = api.accounting.cancelEntry.useMutation(refresh);
  const updateEntry = api.accounting.updateEntry.useMutation(refresh);
  const submitApproval = api.accounting.submitEntryForApproval.useMutation(refresh);
  const submitCancellation = api.accounting.submitEntryCancellation.useMutation(refresh);

  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cancelReason, setCancelReason] = useState('');
  const [cancelling, setCancelling] = useState(false);

  // ACC-02: a DRAFT entry can be corrected; the balance is shown before the user ever saves
  const [editing, setEditing] = useState(false);
  const [editHeader, setEditHeader] = useState({ entryDate: '', entryType: 'TRANSFER', description: '' });
  const [editLines, setEditLines] = useState<EditLine[]>([]);
  const [formErrors, setFormErrors] = useState<FieldError[]>([]);

  const suggestions = useMemo(
    () => (accounts.data ?? []).map((a) => ({ value: a.id, label: `${a.code} ${a.name}` })),
    [accounts.data],
  );
  const lineColumns: LineColumn<EditLine>[] = [
    { key: 'accountLabel', header: '계정과목', kind: 'text', required: true, suggestions },
    { key: 'debit', header: '차변', kind: 'money', width: 130, total: true },
    { key: 'credit', header: '대변', kind: 'money', width: 130, total: true },
    { key: 'description', header: '적요', kind: 'text' },
  ];
  const totalDebit = editLines.reduce((acc, l) => add(acc, l.debit || '0'), D(0));
  const totalCredit = editLines.reduce((acc, l) => add(acc, l.credit || '0'), D(0));
  const editBalanced = cmp(totalDebit, totalCredit) === 0 && !totalDebit.isZero();

  if (detail.isLoading) return <Spinner />;
  if (detail.error) return <EmptyState title="전표를 찾을 수 없습니다." description={detail.error.message} />;
  const e = detail.data!;

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

  // ACC-02: only a DRAFT, manually-entered entry in an open period can be corrected —
  // the control is disabled rather than left to fail against the server's own checks.
  const editBlockedReason = e.sourceType
    ? '업무전표에서 자동 생성된 분개는 직접 수정할 수 없습니다.'
    : e.status !== 'DRAFT'
      ? '작성중인 전표만 수정할 수 있습니다.'
      : e.period.status === 'CLOSED'
        ? '마감된 기간의 전표는 수정할 수 없습니다. 마감을 해제한 뒤 다시 시도하세요.'
        : null;
  const canEdit = editBlockedReason === null;

  function startEdit() {
    setMessage(null);
    setError(null);
    setFormErrors([]);
    setEditHeader({
      entryDate: fmt.date(e.entryDate as unknown as string),
      entryType: e.entryType,
      description: e.description ?? '',
    });
    setEditLines(
      e.lines.map((l) => ({
        accountLabel: `${l.account.code} ${l.account.name}`,
        debit: l.debit.toString() === '0' ? '' : l.debit.toString(),
        credit: l.credit.toString() === '0' ? '' : l.credit.toString(),
        description: l.description ?? '',
        divisionId: l.division?.id ?? '',
        partnerId: l.partner?.id ?? '',
      })),
    );
    setEditing(true);
  }

  async function submitEdit() {
    setFormErrors([]);
    const prepared = editLines
      .filter((l) => l.accountLabel.trim() || l.debit.trim() || l.credit.trim())
      .map((l, i) => {
        const match = suggestions.find(
          (s) => s.label === l.accountLabel || s.label.startsWith(`${l.accountLabel.trim()} `),
        );
        return { index: i, accountId: match?.value ?? '', line: l };
      });

    const missing = prepared.filter((p) => !p.accountId);
    if (missing.length > 0 || prepared.length < 2) {
      setFormErrors([
        {
          field: 'je-lines',
          label: '계정과목',
          message:
            prepared.length < 2
              ? '차변·대변 각각 한 줄 이상 입력하세요.'
              : `${missing.map((m) => `${m.index + 1}행`).join(', ')}: 목록에서 계정과목을 선택하세요.`,
        },
      ]);
      return;
    }
    if (!editBalanced) {
      setFormErrors([
        {
          field: 'je-lines',
          label: '차대변',
          message: `차변(${fmt.krw(totalDebit.toString())})과 대변(${fmt.krw(totalCredit.toString())})이 일치해야 저장할 수 있습니다.`,
        },
      ]);
      return;
    }

    try {
      await updateEntry.mutateAsync({
        id,
        version: e.version,
        entryDate: editHeader.entryDate,
        entryType: editHeader.entryType as 'TRANSFER',
        ...(editHeader.description ? { description: editHeader.description } : {}),
        lines: prepared.map((p) => ({
          accountId: p.accountId,
          ...(p.line.debit ? { debit: p.line.debit } : {}),
          ...(p.line.credit ? { credit: p.line.credit } : {}),
          ...(p.line.description ? { description: p.line.description } : {}),
          ...(p.line.divisionId ? { divisionId: p.line.divisionId } : {}),
          ...(p.line.partnerId ? { partnerId: p.line.partnerId } : {}),
        })),
        requestId: newRequestId(),
      });
      setEditing(false);
      setMessage('전표를 수정했습니다.');
    } catch (err) {
      const shape = err as ApiErrorShape;
      if (shape.data?.appCode === 'VERSION_CONFLICT') {
        await detail.refetch();
        setFormErrors([
          {
            field: 'je-date',
            label: '저장',
            message:
              '다른 곳에서 먼저 저장되어 전표가 변경되었습니다. 새로 고친 내용을 확인한 뒤 다시 수정하세요.',
          },
        ]);
        return;
      }
      setFormErrors([{ field: 'je-date', label: '저장', message: shape.message ?? '저장에 실패했습니다.' }]);
    }
  }

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h1 className="text-lg font-semibold">
            회계전표 <span className="ml-1 text-sm font-normal text-slate-500">{e.entryNo}</span>
          </h1>
          <p className="mt-0.5 text-sm text-slate-500">
            {fmt.date(e.entryDate as unknown as string)} · {TYPE_LABEL[e.entryType] ?? e.entryType} ·{' '}
            {e.period.periodKey} 기간 {e.period.status === 'CLOSED' ? '마감' : '진행'}
            {e.sourceType ? ` · 원천 ${e.sourceType}` : ' · 수동 입력'}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {e.isClosingEntry ? (
            <span className="rounded bg-slate-100 px-2 py-0.5 text-xs text-slate-700">마감분개</span>
          ) : null}
          <StatusBadge status={e.status} label={STATUS_LABEL[e.status] ?? e.status} />
        </div>
      </header>

      <InternalNotice />

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

      {e.reversalOf ? (
        <p className="rounded bg-blue-50 px-3 py-2 text-sm text-blue-900">
          이 전표는{' '}
          <Link className="underline" href={`/accounting/journals/${e.reversalOf.id}`}>
            {e.reversalOf.entryNo}
          </Link>
          의 역분개입니다.
        </p>
      ) : null}
      {e.reversedBy ? (
        <p className="rounded bg-amber-50 px-3 py-2 text-sm text-amber-900">
          이 전표는{' '}
          <Link className="underline" href={`/accounting/journals/${e.reversedBy.id}`}>
            {e.reversedBy.entryNo}
          </Link>
          으로 역분개되었습니다.
        </p>
      ) : null}

      <Card
        title="분개"
        actions={
          !editing ? (
            <div className="flex items-center gap-2">
              {editBlockedReason ? <span className="text-xs text-slate-500">{editBlockedReason}</span> : null}
              <Button size="sm" disabled={!canEdit} onClick={startEdit}>
                수정
              </Button>
            </div>
          ) : null
        }
      >
        {editing ? (
          <div className="flex flex-col gap-3">
            <FormErrorSummary errors={formErrors} />
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <Field label="전표일" htmlFor="je-date" required>
                <Input
                  id="je-date"
                  type="date"
                  value={editHeader.entryDate}
                  onChange={(ev) => setEditHeader({ ...editHeader, entryDate: ev.target.value })}
                />
              </Field>
              <Field label="전표유형" htmlFor="je-type" required>
                <Select
                  id="je-type"
                  value={editHeader.entryType}
                  onChange={(ev) => setEditHeader({ ...editHeader, entryType: ev.target.value })}
                >
                  {Object.entries(TYPE_LABEL).map(([v, l]) => (
                    <option key={v} value={v}>
                      {l}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="적요" htmlFor="je-desc">
                <Input
                  id="je-desc"
                  value={editHeader.description}
                  onChange={(ev) => setEditHeader({ ...editHeader, description: ev.target.value })}
                />
              </Field>
            </div>

            <div id="je-lines">
              <VoucherLineEditor<EditLine>
                columns={lineColumns}
                lines={editLines}
                onChange={setEditLines}
                newLine={emptyEditLine}
                minLines={2}
              />
            </div>

            <div className="flex flex-wrap items-center justify-end gap-4 text-sm">
              <span>
                차변 <span className="tabular font-medium">{fmt.krw(totalDebit.toString())}</span>
              </span>
              <span>
                대변 <span className="tabular font-medium">{fmt.krw(totalCredit.toString())}</span>
              </span>
              {editBalanced ? (
                <span className="rounded bg-green-50 px-2 py-0.5 text-xs font-medium text-green-800">
                  차대변 일치
                </span>
              ) : (
                <span className="rounded bg-red-50 px-2 py-0.5 text-xs font-medium text-red-700">
                  차액 {fmt.krw(totalDebit.minus(totalCredit).abs().toString())}
                </span>
              )}
            </div>

            <div className="flex gap-1.5">
              <Button
                variant="primary"
                size="sm"
                disabled={updateEntry.isPending || !editBalanced}
                onClick={() => void submitEdit()}
              >
                {updateEntry.isPending ? '저장 중' : '저장'}
              </Button>
              <Button size="sm" onClick={() => setEditing(false)}>
                취소
              </Button>
            </div>
          </div>
        ) : (
          <>
            <p className="mb-3 text-sm text-slate-600">{e.description ?? '적요 없음'}</p>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[44rem] text-sm">
                <thead className="border-b border-slate-200 text-left text-slate-500">
                  <tr>
                    <th className="px-2 py-1.5 font-medium">#</th>
                    <th className="px-2 py-1.5 font-medium">계정과목</th>
                    <th className="px-2 py-1.5 font-medium">적요</th>
                    <th className="px-2 py-1.5 font-medium">거래처</th>
                    <th className="px-2 py-1.5 font-medium">부문</th>
                    <th className="px-2 py-1.5 text-right font-medium">차변</th>
                    <th className="px-2 py-1.5 text-right font-medium">대변</th>
                  </tr>
                </thead>
                <tbody>
                  {e.lines.map((l) => (
                    <tr key={l.id} className="border-b border-slate-100">
                      <td className="px-2 py-1.5">{l.lineNo}</td>
                      <td className="px-2 py-1.5">
                        <span className="tabular text-slate-500">{l.account.code}</span> {l.account.name}
                      </td>
                      <td className="px-2 py-1.5">{l.description ?? '-'}</td>
                      <td className="px-2 py-1.5">{l.partner?.name ?? '-'}</td>
                      <td className="px-2 py-1.5">{l.division?.name ?? '-'}</td>
                      <td className="tabular px-2 py-1.5 text-right">
                        {l.debit.toString() === '0' ? '' : fmt.krw(l.debit as unknown as string)}
                      </td>
                      <td className="tabular px-2 py-1.5 text-right">
                        {l.credit.toString() === '0' ? '' : fmt.krw(l.credit as unknown as string)}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t-2 border-slate-300 font-medium">
                    <td className="px-2 py-1.5" colSpan={5}>
                      합계
                    </td>
                    <td className="tabular px-2 py-1.5 text-right">
                      {fmt.krw(e.totalDebit as unknown as string)}
                    </td>
                    <td className="tabular px-2 py-1.5 text-right">
                      {fmt.krw(e.totalCredit as unknown as string)}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </>
        )}
      </Card>

      <Card title="처리">
        <div className="mb-3 flex flex-col gap-2">
          <ApprovalActions
            idPrefix="je-apv"
            status={e.status}
            approvalRequired={e.approvalRequired}
            approvalReason={e.approvalReason}
            approval={e.approval}
            cancellationApproval={e.cancellationApproval}
            onSubmitForApproval={(note) =>
              run(
                () =>
                  submitApproval.mutateAsync({
                    id,
                    version: e.version,
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
          {(e.status === 'DRAFT' || e.status === 'PENDING_APPROVAL') && !e.approvalRequired ? (
            <Button
              variant="primary"
              size="sm"
              disabled={editing}
              onClick={() =>
                run(
                  () => confirm.mutateAsync({ id, version: e.version, requestId: newRequestId() }),
                  '확정했습니다.',
                )
              }
            >
              확정
            </Button>
          ) : null}
          {e.status !== 'CANCELED' && !e.isClosingEntry && e.approval?.status !== 'APPROVED' ? (
            <Button size="sm" variant="danger" disabled={editing} onClick={() => setCancelling((v) => !v)}>
              {cancelling ? '취소 닫기' : '전표 취소'}
            </Button>
          ) : null}
        </div>

        {cancelling ? (
          <div className="mt-3 flex flex-wrap items-end gap-2">
            <div className="min-w-0 flex-1">
              <label className="mb-1 block text-sm text-slate-600" htmlFor="jv-cancel-reason">
                취소 사유
              </label>
              <Input
                id="jv-cancel-reason"
                value={cancelReason}
                onChange={(ev) => setCancelReason(ev.target.value)}
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
                    version: e.version,
                    requestId: newRequestId(),
                  });
                  setCancelling(false);
                  setCancelReason('');
                }, '취소했습니다. 확정 전표였다면 역분개가 생성되었습니다.')
              }
            >
              취소 확정
            </Button>
          </div>
        ) : null}

        {e.status === 'CANCELED' && e.cancelReason ? (
          <p className="mt-3 text-sm text-slate-600">취소 사유: {e.cancelReason}</p>
        ) : null}
        {e.status === 'CONFIRMED' ? (
          <p className="mt-3 text-xs text-slate-500">
            확정 전표는 수정할 수 없습니다. 정정이 필요하면 취소하여 역분개를 만든 뒤 새 전표를 작성하세요.
          </p>
        ) : null}
      </Card>
    </div>
  );
}
