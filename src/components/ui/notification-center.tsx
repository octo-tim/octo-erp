'use client';

import { useState } from 'react';
import { api } from '@/lib/trpc';
import { fmt } from '@/lib/format';
import { Button, EmptyState, Spinner } from './primitives';
import { cn } from '@/lib/cn';

const CATEGORY_LABEL: Record<string, string> = {
  APPROVAL: '결재',
  STOCK: '재고',
  CREDIT: '여신',
  HR: '인사',
  SYSTEM: '시스템',
};

/** UIX-08: one place for stock, credit, approval and HR notifications. */
export function NotificationCenter() {
  const [open, setOpen] = useState(false);
  const unread = api.notification.unreadCount.useQuery(undefined, { refetchInterval: 60_000 });
  const list = api.notification.list.useQuery(
    { page: 1, pageSize: 20, sortDir: 'desc', unreadOnly: false },
    { enabled: open },
  );
  const markRead = api.notification.markRead.useMutation();
  const markAllRead = api.notification.markAllRead.useMutation();

  async function refresh() {
    await Promise.all([unread.refetch(), list.refetch()]);
  }

  return (
    <div className="relative">
      <Button
        size="sm"
        variant="ghost"
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((v) => !v)}
        aria-label={`알림 ${unread.data ?? 0}건`}
      >
        알림
        {unread.data ? (
          <span className="ml-1 inline-flex min-w-5 items-center justify-center rounded-full bg-red-600 px-1.5 text-xs font-semibold text-white tabular">
            {unread.data > 99 ? '99+' : unread.data}
          </span>
        ) : null}
      </Button>

      {open ? (
        <div
          role="dialog"
          aria-label="알림센터"
          className="absolute right-0 z-50 mt-1 max-h-[70vh] w-[min(24rem,calc(100vw-2rem))] overflow-y-auto rounded-lg border border-slate-200 bg-white shadow-lg"
        >
          <header className="flex items-center justify-between border-b border-slate-200 px-3 py-2">
            <h2 className="text-sm font-semibold">알림</h2>
            <Button
              size="sm"
              variant="ghost"
              onClick={async () => {
                await markAllRead.mutateAsync();
                await refresh();
              }}
            >
              모두 읽음
            </Button>
          </header>

          {list.isLoading ? (
            <Spinner />
          ) : (list.data?.rows ?? []).length === 0 ? (
            <EmptyState title="새 알림이 없습니다." />
          ) : (
            <ul className="divide-y divide-slate-100">
              {(list.data?.rows ?? []).map((n) => (
                <li key={n.id} className={cn('px-3 py-2', !n.readAt && 'bg-blue-50/60')}>
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-xs text-slate-500">
                        {CATEGORY_LABEL[n.category] ?? n.category} ·{' '}
                        {fmt.dateTime(n.createdAt as unknown as string)}
                      </p>
                      {n.linkUrl ? (
                        <a
                          href={n.linkUrl}
                          className="block truncate text-sm font-medium text-blue-700 hover:underline"
                          onClick={async () => {
                            await markRead.mutateAsync({ ids: [n.id] });
                            await refresh();
                          }}
                        >
                          {n.title}
                        </a>
                      ) : (
                        <p className="truncate text-sm font-medium">{n.title}</p>
                      )}
                      {n.body ? <p className="mt-0.5 line-clamp-2 text-sm text-slate-600">{n.body}</p> : null}
                    </div>
                    {!n.readAt ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={async () => {
                          await markRead.mutateAsync({ ids: [n.id] });
                          await refresh();
                        }}
                      >
                        읽음
                      </Button>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}
