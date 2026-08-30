import type { TransactionContext } from '@/server/core/context';
import { enqueue } from '@/server/modules/outbox/service';

export type NotificationCategory = 'APPROVAL' | 'STOCK' | 'CREDIT' | 'HR' | 'SYSTEM';

export interface NotifyInput {
  userIds: string[];
  category: NotificationCategory;
  title: string;
  body?: string;
  linkUrl?: string;
  email?: boolean;
  dedupKey?: string;
}

/** UIX-08 + DEC-09: in-app row is written in the transaction; email goes through the outbox. */
export async function notify(ctx: TransactionContext, input: NotifyInput): Promise<void> {
  const userIds = [...new Set(input.userIds)].filter(Boolean);
  if (userIds.length === 0) return;

  const users = await ctx.tx.user.findMany({
    where: { id: { in: userIds }, isActive: true },
    select: { id: true, email: true },
  });

  for (const user of users) {
    const notification = await ctx.tx.notification.create({
      data: {
        userId: user.id,
        category: input.category,
        title: input.title,
        body: input.body ?? null,
        linkUrl: input.linkUrl ?? null,
      },
    });

    if (input.email && user.email) {
      await ctx.tx.notificationDelivery.create({
        data: { notificationId: notification.id, channel: 'EMAIL' },
      });
      await enqueue(ctx, {
        topic: 'email.send',
        payload: {
          to: user.email,
          subject: input.title,
          text: `${input.body ?? input.title}\n\n${input.linkUrl ?? ''}`.trim(),
          notificationId: notification.id,
        },
        dedupKey: input.dedupKey ? `${input.dedupKey}:${user.id}` : `notif:${notification.id}`,
      });
    }
  }
}

export async function markRead(ctx: TransactionContext, notificationIds: string[]): Promise<number> {
  const res = await ctx.tx.notification.updateMany({
    where: { id: { in: notificationIds }, userId: ctx.actor.userId, readAt: null },
    data: { readAt: ctx.now },
  });
  return res.count;
}
