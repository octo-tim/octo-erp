'use client';

import { api } from '@/lib/trpc';
import { DashboardGrid, type Widget } from '@/components/ui/dashboard-grid';
import { fmt } from '@/lib/format';

/**
 * UIX-01: the home dashboard. Business widgets (매출, 이익률, 미수, 재고금액, 안전재고)
 * arrive in STEP 11 once their source ledgers exist; the layout, persistence and
 * "내 미결" widget are in place now.
 */
export default function HomePage() {
  const me = api.auth.me.useQuery();
  const unread = api.notification.unreadCount.useQuery();

  const widgets: Widget[] = [
    {
      id: 'my-pending',
      title: '내 미결',
      render: () => (
        <p className="text-sm text-slate-600">
          읽지 않은 알림 <strong className="tabular">{fmt.count(unread.data ?? 0)}</strong>건
        </p>
      ),
    },
    {
      id: 'monthly-sales',
      title: '당월 매출',
      render: () => <PlaceholderWidget step="STEP 11" />,
    },
    {
      id: 'gross-margin',
      title: '매출이익률',
      render: () => <PlaceholderWidget step="STEP 11" />,
    },
    {
      id: 'receivables',
      title: '미수금',
      render: () => <PlaceholderWidget step="STEP 11" />,
    },
    {
      id: 'inventory-value',
      title: '재고금액',
      render: () => <PlaceholderWidget step="STEP 11" />,
    },
    {
      id: 'safety-stock',
      title: '안전재고 미달',
      render: () => <PlaceholderWidget step="STEP 11" />,
    },
  ];

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-lg font-semibold">{me.data?.displayName}님, 안녕하세요.</h1>
      <DashboardGrid dashboardKey="home" widgets={widgets} />
    </div>
  );
}

function PlaceholderWidget({ step }: { step: string }) {
  return <p className="text-sm text-slate-400">{step}에서 연결됩니다.</p>;
}
