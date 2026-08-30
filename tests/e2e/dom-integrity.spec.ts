// covers: UIX-02, UIX-05, NFR-UX-03
import { expect, test, type Page } from '@playwright/test';

const ADMIN = process.env['E2E_USERNAME'] ?? 'admin';
const ADMIN_PW = process.env['E2E_PASSWORD'] ?? 'Admin!2345';

async function login(page: Page) {
  await page.goto('/login');
  await page.getByLabel('아이디').fill(ADMIN);
  await page.getByLabel('비밀번호').fill(ADMIN_PW);
  await page.getByRole('button', { name: '로그인' }).click();
  await expect(page).toHaveURL(/\/home$/);
}

/**
 * A duplicate element id makes `label[for]` point at the wrong control, so a screen
 * reader announces the wrong field and clicking a label focuses the wrong input. The
 * stock screens shipped exactly that bug (a filter's 종료일 and a form's 입고 창고 both
 * used `sd-to`), so this sweep exists to keep it from coming back on any screen.
 */
const SCREENS: { path: string; open?: string }[] = [
  { path: '/home' },
  { path: '/master/items', open: '품목 등록' },
  { path: '/master/partners', open: '거래처 등록' },
  { path: '/master/warehouses' },
  { path: '/master/codes' },
  { path: '/master/numbering' },
  { path: '/inventory/stock-in', open: '입고 등록' },
  { path: '/inventory/stock-out', open: '출고 등록' },
  { path: '/inventory/moves', open: '이동 등록' },
  { path: '/inventory/status' },
  { path: '/inventory/ledger' },
  { path: '/inventory/counts', open: '실사 등록' },
  { path: '/inventory/valuation' },
  { path: '/accounting/accounts', open: '계정 추가' },
  { path: '/accounting/journals', open: '전표 등록' },
  { path: '/accounting/rules' },
  { path: '/accounting/ledger' },
  { path: '/accounting/income-statement' },
  { path: '/accounting/balance-sheet' },
  { path: '/accounting/close' },
  { path: '/approval/inbox' },
  { path: '/hr/employees' },
];

test.beforeEach(async ({ page }) => {
  await login(page);
});

for (const screen of SCREENS) {
  test(`${screen.path}: 중복 id가 없다`, async ({ page }) => {
    await page.goto(screen.path);
    // opening the create panel is where a form's ids meet the filter bar's ids
    if (screen.open) {
      const button = page.getByRole('button', { name: screen.open });
      if (await button.isVisible().catch(() => false)) await button.click();
    }
    await page.waitForTimeout(300);

    const duplicates = await page.evaluate(() => {
      const seen = new Map<string, number>();
      for (const el of Array.from(document.querySelectorAll('[id]'))) {
        const id = el.id;
        if (!id) continue;
        seen.set(id, (seen.get(id) ?? 0) + 1);
      }
      return [...seen.entries()].filter(([, n]) => n > 1).map(([id, n]) => `${id} x${n}`);
    });

    expect(duplicates, `중복 id: ${duplicates.join(', ')}`).toEqual([]);
  });

  test(`${screen.path}: 모든 라벨이 존재하는 컨트롤을 가리킨다`, async ({ page }) => {
    await page.goto(screen.path);
    if (screen.open) {
      const button = page.getByRole('button', { name: screen.open });
      if (await button.isVisible().catch(() => false)) await button.click();
    }
    await page.waitForTimeout(300);

    const dangling = await page.evaluate(() =>
      Array.from(document.querySelectorAll('label[for]'))
        .map((l) => (l as HTMLLabelElement).htmlFor)
        .filter((id) => !document.getElementById(id)),
    );

    expect(dangling, `대상이 없는 label[for]: ${dangling.join(', ')}`).toEqual([]);
  });
}
