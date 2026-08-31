'use client';

import Link from 'next/link';
import { api } from '@/lib/trpc';
import { DashboardGrid, type Widget } from '@/components/ui/dashboard-grid';
import { fmt } from '@/lib/format';

/**
 * UIX-01 / RPT-06: the home dashboard.
 *
 * Every figure comes from one server call rather than from six, so the widgets always show
 * one consistent moment rather than a mix of times, and every widget links to the screen
 * the number came from — a figure the reader cannot get behind is not much use.
 */
export default function HomePage() {
  const me = api.auth.me.useQuery();
  const unread = api.notification.unreadCount.useQuery();
  const board = api.report.dashboard.useQuery();
  const d = board.data;

  const month = new Date().toISOString().slice(0, 7);
  const monthRange = `from=${month}-01&to=${lastDayOf(month)}`;

  const widgets: Widget[] = [
    {
      id: 'my-pending',
      title: '내 미결',
      render: () => (
        <Metric
          value={`${fmt.count(d?.myPendingApprovals ?? 0)}건`}
          note={`읽지 않은 알림 ${fmt.count(unread.data ?? 0)}건`}
          href="/approval/inbox"
          linkLabel="결재함"
        />
      ),
    },
    {
      id: 'monthly-sales',
      title: '당월 매출',
      render: () => (
        <Metric
          value={`${fmt.krw(d?.monthlySales ?? '0')}원`}
          note="확정 매출전표 기준"
          href={`/reports/sales?${monthRange}`}
          linkLabel="매출현황"
        />
      ),
    },
    {
      id: 'gross-margin',
      title: '매출이익률',
      render: () => (
        <Metric
          value={d?.marginRate === '-' || !d ? '-' : `${d.marginRate}%`}
          note={`매출이익 ${fmt.krw(d?.monthlyProfit ?? '0')}원`}
          href={`/reports/sales?${monthRange}`}
          linkLabel="매출현황"
        />
      ),
    },
    {
      id: 'receivables',
      title: '미수금',
      render: () => (
        <Metric
          value={`${fmt.krw(d?.outstandingReceivable ?? '0')}원`}
          note="미결제·부분결제 잔액"
          href="/reports/receivables"
          linkLabel="채권채무 현황"
        />
      ),
    },
    {
      id: 'inventory-value',
      title: '재고금액',
      render: () => (
        <Metric
          value={`${fmt.krw(d?.inventoryValue ?? '0')}원`}
          note="재고 원장 합계"
          href="/reports/inventory"
          linkLabel="재고현황"
        />
      ),
    },
    {
      id: 'safety-stock',
      title: '안전재고 미달',
      render: () => (
        <Metric
          value={`${fmt.count(d?.belowSafetyStock ?? 0)}건`}
          note={d && d.belowSafetyStock > 0 ? '보충이 필요합니다.' : '미달 품목이 없습니다.'}
          href="/reports/inventory"
          linkLabel="재고현황"
          alert={!!d && d.belowSafetyStock > 0}
        />
      ),
    },
  ];

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-lg font-semibold">{me.data?.displayName}님, 안녕하세요.</h1>
      <DashboardGrid dashboardKey="home" widgets={widgets} />
    </div>
  );
}

function Metric({
  value,
  note,
  href,
  linkLabel,
  alert,
}: {
  value: string;
  note: string;
  href: string;
  linkLabel: string;
  alert?: boolean;
}) {
  return (
    <div className="flex flex-col gap-1">
      <p className={`tabular text-2xl font-semibold ${alert ? 'text-red-700' : 'text-slate-900'}`}>{value}</p>
      <p className="text-sm text-slate-600">{note}</p>
      <Link className="text-sm text-blue-700 underline" href={href}>
        {linkLabel}
      </Link>
    </div>
  );
}

function lastDayOf(month: string): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}
