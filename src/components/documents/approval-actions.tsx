'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Button, Input } from '@/components/ui/primitives';

/**
 * APV-08 / APV-12 — the approval actions on a business document screen.
 *
 * A document over the DEC-03 threshold cannot be confirmed from here at all: it is
 * confirmed by its approval. So the screen offers the action that will actually work, and
 * says which approval document is carrying it. Before this existed the screen showed a
 * confirm button that was certain to be refused and no way to submit, which left the
 * operator with a document they could do nothing with.
 */

export interface ApprovalRef {
  id: string;
  docNo: string;
  status: string;
}

const STATUS_LABEL: Record<string, string> = {
  DRAFT: '작성중',
  IN_PROGRESS: '결재중',
  ON_HOLD: '보류',
  APPROVED: '승인',
  REJECTED: '반려',
  WITHDRAWN: '회수',
  CANCELED: '취소',
};

export function ApprovalActions({
  idPrefix,
  status,
  approvalRequired,
  approvalReason,
  approval,
  cancellationApproval,
  onSubmitForApproval,
  onSubmitCancellation,
}: {
  /** namespaces the field ids so a screen with several forms keeps them unique */
  idPrefix: string;
  status: string;
  approvalRequired: boolean;
  approvalReason?: string;
  approval: ApprovalRef | null;
  cancellationApproval: ApprovalRef | null;
  onSubmitForApproval: (note: string) => Promise<unknown>;
  onSubmitCancellation: (reason: string) => Promise<unknown>;
}) {
  const [note, setNote] = useState('');
  const [reason, setReason] = useState('');
  const [openSubmit, setOpenSubmit] = useState(false);
  const [openCancel, setOpenCancel] = useState(false);

  const live = approval && ['DRAFT', 'IN_PROGRESS', 'ON_HOLD'].includes(approval.status);
  const confirmedByApproval = approval?.status === 'APPROVED';

  return (
    <>
      {approval ? (
        <p className="rounded bg-slate-50 px-3 py-2 text-sm text-slate-700">
          결재문서{' '}
          <Link className="underline" href={`/approval/documents/${approval.id}`}>
            {approval.docNo}
          </Link>{' '}
          · {STATUS_LABEL[approval.status] ?? approval.status}
          {cancellationApproval ? (
            <>
              {' '}
              · 취소 결재{' '}
              <Link className="underline" href={`/approval/documents/${cancellationApproval.id}`}>
                {cancellationApproval.docNo}
              </Link>{' '}
              ({STATUS_LABEL[cancellationApproval.status] ?? cancellationApproval.status})
            </>
          ) : null}
        </p>
      ) : null}

      <div className="flex flex-wrap gap-1.5">
        {approvalRequired && status === 'DRAFT' && !live ? (
          <Button size="sm" variant="primary" onClick={() => setOpenSubmit((v) => !v)}>
            {openSubmit ? '상신 닫기' : '결재 상신'}
          </Button>
        ) : null}

        {confirmedByApproval && status === 'CONFIRMED' && !cancellationApproval ? (
          <Button size="sm" variant="danger" onClick={() => setOpenCancel((v) => !v)}>
            {openCancel ? '취소 상신 닫기' : '취소 상신'}
          </Button>
        ) : null}
      </div>

      {approvalRequired && status === 'DRAFT' && !live ? (
        <p className="text-sm text-amber-900">{approvalReason}. 승인되면 자동으로 확정됩니다.</p>
      ) : null}

      {openSubmit ? (
        <div className="flex flex-wrap items-end gap-2">
          <div className="min-w-0 flex-1">
            <label className="mb-1 block text-sm text-slate-600" htmlFor={`${idPrefix}-note`}>
              상신 사유
            </label>
            <Input id={`${idPrefix}-note`} value={note} onChange={(e) => setNote(e.target.value)} />
          </div>
          <Button
            size="sm"
            variant="primary"
            onClick={async () => {
              await onSubmitForApproval(note);
              setOpenSubmit(false);
              setNote('');
            }}
          >
            상신
          </Button>
        </div>
      ) : null}

      {openCancel ? (
        <div className="flex flex-wrap items-end gap-2">
          <div className="min-w-0 flex-1">
            <label className="mb-1 block text-sm text-slate-600" htmlFor={`${idPrefix}-cancel-note`}>
              취소 상신 사유
            </label>
            <Input
              id={`${idPrefix}-cancel-note`}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </div>
          <Button
            size="sm"
            variant="danger"
            disabled={reason.trim().length < 2}
            onClick={async () => {
              await onSubmitCancellation(reason);
              setOpenCancel(false);
              setReason('');
            }}
          >
            취소 상신
          </Button>
        </div>
      ) : null}
    </>
  );
}
