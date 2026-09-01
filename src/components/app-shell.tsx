'use client';

import { useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { api } from '@/lib/trpc';
import { cn } from '@/lib/cn';
import { Button, Spinner } from './ui/primitives';
import { NotificationCenter } from './ui/notification-center';
import { NAV, type NavItem } from './nav';

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

  /**
   * A temporary password issued by an admin is not a password the user chose, and it is one
   * the admin still knows. Until it is replaced the only reachable screen is the one that
   * replaces it — otherwise the flag is set, nothing acts on it, and the account keeps
   * running on a shared secret indefinitely.
   */
  if (me.data.mustChangePassword && pathname !== '/account') {
    if (typeof window !== 'undefined') router.replace('/account?force=1');
    return <Spinner label="비밀번호 변경 화면으로 이동 중" />;
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
