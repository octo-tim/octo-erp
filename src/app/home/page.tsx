'use client';

import { api } from '@/lib/trpc';

export default function HomePage() {
  const me = api.auth.me.useQuery();
  const unread = api.notification.unreadCount.useQuery(undefined, { enabled: !!me.data });

  if (me.isLoading) return <main className="p-8">불러오는 중…</main>;
  if (!me.data)
    return (
      <main className="p-8">
        <a href="/login" className="text-blue-600 underline">
          로그인이 필요합니다.
        </a>
      </main>
    );

  return (
    <main className="mx-auto max-w-5xl p-8">
      <h1 className="mb-2 text-xl font-semibold">{me.data.displayName}님, 안녕하세요.</h1>
      <p className="mb-6 text-sm" style={{ color: 'var(--text-muted)' }}>
        역할: {me.data.roles.join(', ') || '없음'} · 읽지 않은 알림 {unread.data ?? 0}건
      </p>
      <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
        업무 화면은 이후 단계에서 추가됩니다.
      </p>
    </main>
  );
}
