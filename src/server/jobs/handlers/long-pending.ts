import { withTransaction } from '@/server/core/context';
import type { Actor } from '@/server/core/context';
import { prisma } from '@/server/db';
import * as approval from '@/server/modules/approval/service';
import * as policy from '@/server/modules/policy/service';
import type { NotificationPolicy } from '@/server/modules/policy/service';
import { notify } from '@/server/modules/notification/service';

/**
 * APV-11 — nudging approvers about documents that have been sitting too long.
 *
 * `longPending` was written in STEP 5 and never called by anything: the query existed, the
 * test asserted the query returned rows, and no notification was ever produced. A document
 * that nobody looks at is exactly the case this requirement is about, so a query nobody
 * runs is no help at all.
 *
 * The reminder goes to the approver whose step is pending, not to everyone on the line —
 * an alert sent to people who cannot act on it teaches everyone to ignore alerts.
 */
export async function longPendingApprovalJob(): Promise<void> {
  const actor = systemActor();
  const now = new Date();

  const businessDays = await withTransaction(
    prisma,
    { actor, requestId: 'long-pending:policy', now },
    async (ctx) => {
      const resolved = await policy.resolve<NotificationPolicy>(ctx, 'notification');
      return resolved.config.longPendingBusinessDays;
    },
  );

  const documents = await withTransaction(prisma, { actor, requestId: 'long-pending:query', now }, (ctx) =>
    approval.longPending(ctx, businessDays),
  );

  for (const document of documents) {
    const approvers = document.steps.map((s) => s.approverId).filter(Boolean);
    if (approvers.length === 0) continue;

    const waitingDays = document.submittedAt
      ? Math.floor((now.getTime() - document.submittedAt.getTime()) / 86_400_000)
      : 0;

    await withTransaction(prisma, { actor, requestId: `long-pending:${document.id}`, now }, (ctx) =>
      notify(ctx, {
        userIds: approvers,
        category: 'APPROVAL',
        title: `장기 미결 결재: ${document.title}`,
        body: `${document.docNo}이(가) ${waitingDays}일째 결재를 기다리고 있습니다.`,
        linkUrl: `/approval/documents/${document.id}`,
        // one nudge per document per day, not one per run
        dedupKey: `long-pending:${document.id}:${now.toISOString().slice(0, 10)}`,
      }),
    );
  }
}

function systemActor(): Actor {
  return {
    userId: 'system',
    username: 'system',
    displayName: '시스템',
    employeeId: null,
    roles: ['system'],
    permissions: new Set(['*']),
    divisionIds: [],
    warehouseIds: [],
    isAdmin: true,
  };
}
