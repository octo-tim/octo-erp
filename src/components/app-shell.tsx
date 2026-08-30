'use client';

import { useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { api } from '@/lib/trpc';
import { cn } from '@/lib/cn';
import { Button, Spinner } from './ui/primitives';
import { NotificationCenter } from './ui/notification-center';

/** UIX-06 / NFR-SEC-01: the menu is filtered by permission, and the server re-checks anyway. */
interface NavItem {
  href: string;
  label: string;
  permission?: string;
  /** shown on mobile — the RFP requires approval and dashboards on phones (UIX-06) */
  mobile?: boolean;
}

interface NavGroup {
  label: string;
  items: NavItem[];
}

export const NAV: NavGroup[] = [
  {
    label: '홈',
    items: [
      { href: '/home', label: '대시보드', mobile: true },
      { href: '/approval/inbox', label: '결재함', permission: 'approval.use', mobile: true },
    ],
  },
  {
    label: '기초정보',
    items: [
      { href: '/master/items', label: '품목', permission: 'master.read' },
      { href: '/master/items/bulk', label: '품목 일괄등록', permission: 'master.write' },
      { href: '/master/partners', label: '거래처', permission: 'master.read' },
      { href: '/master/warehouses', label: '창고', permission: 'master.read' },
      { href: '/master/divisions', label: '사업부', permission: 'master.read' },
      { href: '/master/codes', label: '공통코드', permission: 'master.read' },
      { href: '/master/numbering', label: '채번규칙', permission: 'admin.settings' },
    ],
  },
  {
    label: '매출·매입·발주',
    items: [
      { href: '/sales/quotations', label: '견적', permission: 'sales.read' },
      { href: '/sales/orders', label: '주문', permission: 'sales.read' },
      { href: '/sales/sales-documents', label: '매출전표', permission: 'sales.read' },
      { href: '/sales/purchase-documents', label: '매입전표', permission: 'purchase.read' },
      { href: '/sales/purchase-requests', label: '구매요청', permission: 'purchase.read' },
      { href: '/sales/purchase-orders', label: '발주', permission: 'purchase.read' },
      { href: '/sales/returns', label: '반품', permission: 'sales.read' },
      { href: '/settlement/receipts', label: '수금', permission: 'settlement.read' },
      { href: '/settlement/payments', label: '지급', permission: 'settlement.read' },
      { href: '/settlement/receivables', label: '미수', permission: 'settlement.read' },
      { href: '/settlement/payables', label: '미지급', permission: 'settlement.read' },
    ],
  },
  {
    label: '재고',
    items: [
      { href: '/inventory/stock-in', label: '입고', permission: 'inventory.read' },
      { href: '/inventory/stock-out', label: '출고', permission: 'inventory.read' },
      { href: '/inventory/moves', label: '이동', permission: 'inventory.read' },
      { href: '/inventory/status', label: '재고현황', permission: 'inventory.read', mobile: true },
      { href: '/inventory/ledger', label: '수불부', permission: 'inventory.read' },
      { href: '/inventory/counts', label: '실사', permission: 'inventory.count' },
      { href: '/inventory/valuation', label: '재고평가·마감', permission: 'inventory.valuation' },
    ],
  },
  {
    label: '회계',
    items: [
      { href: '/accounting/accounts', label: '계정과목', permission: 'accounting.read' },
      { href: '/accounting/journals', label: '전표', permission: 'accounting.read' },
      { href: '/accounting/rules', label: '분개규칙', permission: 'accounting.rules' },
      { href: '/accounting/ledger', label: '원장', permission: 'accounting.read' },
      { href: '/accounting/income-statement', label: '손익', permission: 'accounting.read' },
      { href: '/accounting/balance-sheet', label: '재무상태', permission: 'accounting.read' },
      { href: '/accounting/close', label: '마감', permission: 'accounting.close' },
    ],
  },
  {
    label: '전자결재',
    items: [
      { href: '/approval/draft', label: '기안', permission: 'approval.use', mobile: true },
      { href: '/approval/forms', label: '양식', permission: 'approval.admin' },
      { href: '/approval/lines', label: '결재선·전결', permission: 'approval.admin' },
      { href: '/approval/search', label: '문서검색', permission: 'approval.use' },
    ],
  },
  {
    label: '인사',
    items: [
      { href: '/hr/employees', label: '사원', permission: 'hr.read' },
      { href: '/hr/org', label: '조직도', permission: 'hr.read' },
      { href: '/hr/assignments', label: '발령', permission: 'hr.write' },
      { href: '/hr/attendance', label: '근태', permission: 'hr.attendance', mobile: true },
      { href: '/hr/leave', label: '휴가·연차', permission: 'hr.self', mobile: true },
      { href: '/hr/documents', label: '인사서류', permission: 'hr.read' },
      { href: '/hr/certificates', label: '증명서', permission: 'hr.self' },
      { href: '/hr/overview', label: '인사현황', permission: 'hr.read' },
      { href: '/hr/me', label: '내 정보', permission: 'hr.self', mobile: true },
    ],
  },
  {
    label: '보고서',
    items: [
      { href: '/reports/sales', label: '매출', permission: 'report.read' },
      { href: '/reports/items', label: '품목', permission: 'report.read' },
      { href: '/reports/partners', label: '거래처', permission: 'report.read' },
      { href: '/reports/inventory', label: '재고', permission: 'report.read' },
      { href: '/reports/receivables', label: '채권채무', permission: 'report.read' },
      { href: '/reports/approval', label: '결재', permission: 'report.read' },
      { href: '/reports/hr', label: '근태·인원', permission: 'report.read' },
    ],
  },
  {
    label: '시스템',
    items: [
      { href: '/system/users', label: '사용자', permission: 'admin.users' },
      { href: '/system/roles', label: '권한', permission: 'admin.roles' },
      { href: '/system/policies', label: '정책설정', permission: 'admin.settings' },
      { href: '/system/jobs', label: '실패작업', permission: 'admin.jobs' },
      { href: '/system/audit', label: '감사로그', permission: 'admin.audit' },
      { href: '/system/migration', label: '데이터 이관', permission: 'admin.migration' },
    ],
  },
];

export function AppShell({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const me = api.auth.me.useQuery();
  const [menuOpen, setMenuOpen] = useState(false);

  if (me.isLoading) return <Spinner label="사용자 정보를 불러오는 중" />;
  if (!me.data) {
    if (typeof window !== 'undefined') router.replace('/login');
    return <Spinner label="로그인 화면으로 이동 중" />;
  }

  const permissions = new Set(me.data.permissions);
  const allowed = (item: NavItem) => !item.permission || me.data!.isAdmin || permissions.has(item.permission);
  const groups = NAV.map((g) => ({ ...g, items: g.items.filter(allowed) })).filter((g) => g.items.length > 0);

  async function logout() {
    await fetch('/api/auth/logout', { method: 'POST' });
    router.push('/login');
    router.refresh();
  }

  return (
    <div className="flex min-h-screen flex-col">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded focus:bg-white focus:px-3 focus:py-2"
      >
        본문으로 건너뛰기
      </a>

      <header className="no-print sticky top-0 z-40 flex h-14 items-center justify-between gap-2 border-b border-slate-200 bg-white px-3">
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="ghost"
            className="lg:hidden"
            aria-expanded={menuOpen}
            aria-controls="main-nav"
            onClick={() => setMenuOpen((v) => !v)}
          >
            메뉴
          </Button>
          <Link href="/home" className="text-sm font-semibold">
            옥토웍스 경영관리
          </Link>
        </div>
        <div className="flex items-center gap-1.5">
          <NotificationCenter />
          <span className="hidden text-sm text-slate-600 sm:inline">{me.data.displayName}</span>
          <Button size="sm" variant="ghost" onClick={logout}>
            로그아웃
          </Button>
        </div>
      </header>

      <div className="flex flex-1">
        <nav
          id="main-nav"
          aria-label="주 메뉴"
          className={cn(
            'no-print w-60 shrink-0 overflow-y-auto border-r border-slate-200 bg-white p-3',
            'lg:block',
            menuOpen ? 'fixed inset-y-14 left-0 z-30 block shadow-lg' : 'hidden',
          )}
        >
          {groups.map((group) => (
            <div key={group.label} className="mb-3">
              <p className="px-2 py-1 text-xs font-semibold uppercase tracking-wide text-slate-400">
                {group.label}
              </p>
              <ul>
                {group.items.map((item) => (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      onClick={() => setMenuOpen(false)}
                      aria-current={pathname === item.href ? 'page' : undefined}
                      className={cn(
                        'block rounded px-2 py-1.5 text-sm hover:bg-slate-100',
                        pathname === item.href && 'bg-blue-50 font-medium text-blue-800',
                      )}
                    >
                      {item.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </nav>

        <main id="main" className="min-w-0 flex-1 p-4 lg:p-6">
          {children}
        </main>
      </div>
    </div>
  );
}
