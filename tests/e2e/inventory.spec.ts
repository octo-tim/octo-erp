// covers: INV-01, INV-02, INV-03, INV-04, INV-05, INV-06, INV-07, INV-08, INV-09
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

test.beforeEach(async ({ page }) => {
  await login(page);
});

/**
 * UIX-06 scopes phones to 조회·대시보드·결재; voucher entry is a desktop task. The entry
 * flows here also hit a Chrome phone-emulation quirk where the layout and visual viewports
 * disagree, so elementFromPoint returns the filter bar for a click on the form below it.
 * The read-only phone journey UIX-06 *does* require is covered by its own test at the
 * bottom of this file, which runs on every viewport.
 */
function desktopEntryOnly() {
  test.skip(test.info().project.name === 'mobile', 'UIX-06: 전표 입력은 데스크톱 범위');
}

/** Each run makes its own item so accumulated test data never changes an assertion. */
async function createItem(page: Page, name: string, opts: { safetyStock?: string } = {}) {
  await page.goto('/master/items');
  await page.getByRole('button', { name: '품목 등록' }).click();
  await page.getByLabel('품목명').fill(name);
  if (opts.safetyStock) await page.getByLabel('안전재고').fill(opts.safetyStock);
  await page.getByRole('button', { name: '저장', exact: true }).click();
  await expect(page.getByRole('button', { name: '품목 등록' })).toBeVisible();
}

/** Fills the shared stock-document form. The item cell is an autocomplete on the label. */
async function fillLine(page: Page, itemName: string, quantity: string, unitCost?: string) {
  const grid = page.getByRole('table').filter({ has: page.getByRole('columnheader', { name: '품목' }) });
  const firstRow = grid.locator('tbody tr').first();
  await firstRow.locator('[data-col="0"]').fill(itemName);
  await firstRow.locator('[data-col="1"]').fill(quantity);
  if (unitCost !== undefined) await firstRow.locator('[data-col="2"]').fill(unitCost);
}

test('INV-01/INV-04: 입고를 확정하면 재고현황과 원장에 반영된다', async ({ page }) => {
  desktopEntryOnly();
  const name = `입고품${Date.now().toString().slice(-6)}`;
  await createItem(page, name);

  await page.goto('/inventory/stock-in');
  await page.getByRole('button', { name: '입고 등록' }).click();
  await page.getByLabel('입고 창고').selectOption({ index: 1 });
  await page.getByLabel('사유').selectOption({ index: 1 });
  await fillLine(page, name, '10', '1000');
  await page.getByRole('button', { name: '저장', exact: true }).click();

  // the detail screen opens on the new draft
  await expect(page.getByRole('heading', { level: 1 })).toContainText('입고');
  await expect(page.getByText('작성중')).toBeVisible();

  await page.getByRole('button', { name: '확정', exact: true }).click();
  await expect(page.getByText('재고 원장에 반영되었습니다.')).toBeVisible();

  // INT-04: the screen shows exactly what the confirmation wrote to the ledger
  const ledgerCard = page.locator('section', { has: page.getByRole('heading', { name: '재고 원장 반영' }) });
  await expect(ledgerCard).toContainText('10');
  await expect(ledgerCard).toContainText('10,000');

  await page.goto('/inventory/status');
  await page.getByLabel('검색어').fill(name);
  await page.getByRole('button', { name: '조회' }).click();
  await expect(page.locator('tbody tr', { hasText: name })).toContainText('10');
});

test('INV-06: 재고보다 많은 출고는 사유와 함께 차단된다', async ({ page }) => {
  desktopEntryOnly();
  const name = `부족품${Date.now().toString().slice(-6)}`;
  await createItem(page, name);

  await page.goto('/inventory/stock-in');
  await page.getByRole('button', { name: '입고 등록' }).click();
  await page.getByLabel('입고 창고').selectOption({ index: 1 });
  await page.getByLabel('사유').selectOption({ index: 1 });
  await fillLine(page, name, '3', '1000');
  await page.getByRole('button', { name: '저장', exact: true }).click();
  await page.getByRole('button', { name: '확정', exact: true }).click();
  await expect(page.getByText('재고 원장에 반영되었습니다.')).toBeVisible();

  await page.goto('/inventory/stock-out');
  await page.getByRole('button', { name: '출고 등록' }).click();
  await page.getByLabel('출고 창고').selectOption({ index: 1 });
  await page.getByLabel('사유').selectOption({ index: 1 });
  await fillLine(page, name, '5');
  await page.getByRole('button', { name: '저장', exact: true }).click();
  await page.getByRole('button', { name: '확정', exact: true }).click();

  const alert = page.getByRole('main').getByRole('alert');
  await expect(alert).toContainText('재고가 부족');
  // the message names the shortfall rather than just refusing
  await expect(alert).toContainText(name);
});

test('INV-03: 이동은 도착 처리 시점에 양쪽 창고가 함께 바뀐다', async ({ page }) => {
  desktopEntryOnly();
  const name = `이동품${Date.now().toString().slice(-6)}`;
  await createItem(page, name);

  await page.goto('/inventory/stock-in');
  await page.getByRole('button', { name: '입고 등록' }).click();
  await page.getByLabel('입고 창고').selectOption({ index: 1 });
  await page.getByLabel('사유').selectOption({ index: 1 });
  await fillLine(page, name, '10', '1000');
  await page.getByRole('button', { name: '저장', exact: true }).click();
  await page.getByRole('button', { name: '확정', exact: true }).click();
  await expect(page.getByText('재고 원장에 반영되었습니다.')).toBeVisible();

  await page.goto('/inventory/moves');
  await page.getByRole('button', { name: '이동 등록' }).click();
  await page.getByLabel('출발 창고').selectOption({ index: 1 });
  await page.getByLabel('도착 창고').selectOption({ index: 2 });
  await fillLine(page, name, '4');
  await page.getByRole('button', { name: '저장', exact: true }).click();

  await expect(page.getByText('요청')).toBeVisible();
  // a requested transfer has not moved anything yet, so 확정 is not offered
  await expect(page.getByRole('button', { name: '도착 처리(확정)' })).toHaveCount(0);

  await page.getByRole('button', { name: '출발 처리' }).click();
  await expect(page.getByText('이동중으로 변경했습니다.')).toBeVisible();

  await page.getByRole('button', { name: '도착 처리(확정)' }).click();
  await expect(page.getByText('재고 원장에 반영되었습니다.')).toBeVisible();

  // one document, two ledger rows: out of the origin and into the destination
  const ledgerCard = page.locator('section', { has: page.getByRole('heading', { name: '재고 원장 반영' }) });
  await expect(ledgerCard).toContainText('창고이동 출고');
  await expect(ledgerCard).toContainText('창고이동 입고');
});

test('INV-05: 수불부가 기초·이동·기말과 원천전표를 보여준다', async ({ page }) => {
  desktopEntryOnly();
  const name = `수불품${Date.now().toString().slice(-6)}`;
  await createItem(page, name);

  await page.goto('/inventory/stock-in');
  await page.getByRole('button', { name: '입고 등록' }).click();
  await page.getByLabel('입고 창고').selectOption({ index: 1 });
  await page.getByLabel('사유').selectOption({ index: 1 });
  await fillLine(page, name, '7', '2000');
  await page.getByRole('button', { name: '저장', exact: true }).click();
  await page.getByRole('button', { name: '확정', exact: true }).click();
  await expect(page.getByText('재고 원장에 반영되었습니다.')).toBeVisible();

  await page.goto('/inventory/ledger');
  const option = page.getByLabel('품목').locator('option', { hasText: name });
  await page.getByLabel('품목').selectOption(await option.getAttribute('value'));
  await page.getByRole('button', { name: '조회' }).click();

  const table = page.getByRole('main').getByRole('table');
  await expect(table).toContainText('기초');
  await expect(table).toContainText('기말');
  await expect(table.getByRole('link', { name: /^SI-/ })).toBeVisible();
  await expect(table).toContainText('14,000');
});

test('INV-07: 안전재고 미달이 재고현황에서 강조된다', async ({ page }) => {
  desktopEntryOnly();
  const name = `안전품${Date.now().toString().slice(-6)}`;
  await createItem(page, name, { safetyStock: '10' });

  await page.goto('/inventory/stock-in');
  await page.getByRole('button', { name: '입고 등록' }).click();
  await page.getByLabel('입고 창고').selectOption({ index: 1 });
  await page.getByLabel('사유').selectOption({ index: 1 });
  await fillLine(page, name, '4', '1000');
  await page.getByRole('button', { name: '저장', exact: true }).click();
  await page.getByRole('button', { name: '확정', exact: true }).click();
  await expect(page.getByText('재고 원장에 반영되었습니다.')).toBeVisible();

  await page.goto('/inventory/status');
  await page.getByLabel('검색어').fill(name);
  await page.getByRole('button', { name: '조회' }).click();
  await expect(page.locator('tbody tr', { hasText: name })).toContainText('미달');
});

test('INV-08: 실사 차이를 승인하면 조정전표가 생성된다', async ({ page }) => {
  desktopEntryOnly();
  const name = `실사품${Date.now().toString().slice(-6)}`;
  await createItem(page, name);

  await page.goto('/inventory/stock-in');
  await page.getByRole('button', { name: '입고 등록' }).click();
  await page.getByLabel('입고 창고').selectOption({ index: 1 });
  await page.getByLabel('사유').selectOption({ index: 1 });
  await fillLine(page, name, '10', '1000');
  await page.getByRole('button', { name: '저장', exact: true }).click();
  await page.getByRole('button', { name: '확정', exact: true }).click();
  await expect(page.getByText('재고 원장에 반영되었습니다.')).toBeVisible();

  await page.goto('/inventory/counts');
  await page.getByRole('button', { name: '실사 등록' }).click();
  await page.getByLabel('실사 창고').selectOption({ index: 1 });
  await page.getByRole('button', { name: '등록', exact: true }).click();

  await expect(page.getByRole('heading', { level: 1 })).toContainText('재고실사');
  await page.getByRole('button', { name: '실사 시작' }).click();
  await expect(page.getByText('전산재고를 동결했습니다.')).toBeVisible();

  // a real count walks every shelf: the warehouse holds items from earlier runs too, and
  // approval is refused until each one has a number, so fill them all with what the system
  // says and then record the one genuine difference.
  const rows = page.getByRole('main').locator('tbody tr');
  for (let i = 0; i < (await rows.count()); i++) {
    const row = rows.nth(i);
    const systemQty = (await row.locator('td').nth(2).innerText()).trim().split(' ')[0]!;
    await row.locator('input').first().fill(systemQty.replace(/,/g, ''));
  }

  await page.getByLabel(`${name} 실사수량`).fill('8');
  await page.getByLabel(`${name} 사유`).fill('파손 폐기');
  // the difference is shown before anything is saved
  await expect(page.locator('tbody tr', { hasText: name })).toContainText('-2');

  await page.getByRole('button', { name: '실사수량 저장' }).click();
  await expect(page.getByText(/건을 저장했습니다\./)).toBeVisible();

  await page.getByRole('button', { name: '승인' }).click();
  await expect(page.getByText('조정전표가 생성됩니다.')).toBeVisible();
  await expect(page.getByRole('link', { name: /^SA-/ })).toBeVisible();

  await page.goto('/inventory/status');
  await page.getByLabel('검색어').fill(name);
  await page.getByRole('button', { name: '조회' }).click();
  await expect(page.locator('tbody tr', { hasText: name })).toContainText('8');
});

test('INT-07: 확정된 전표를 취소하면 반대 원장이 생긴다', async ({ page }) => {
  desktopEntryOnly();
  const name = `취소품${Date.now().toString().slice(-6)}`;
  await createItem(page, name);

  await page.goto('/inventory/stock-in');
  await page.getByRole('button', { name: '입고 등록' }).click();
  await page.getByLabel('입고 창고').selectOption({ index: 1 });
  await page.getByLabel('사유').selectOption({ index: 1 });
  await fillLine(page, name, '6', '1000');
  await page.getByRole('button', { name: '저장', exact: true }).click();
  await page.getByRole('button', { name: '확정', exact: true }).click();
  await expect(page.getByText('재고 원장에 반영되었습니다.')).toBeVisible();

  await page.getByRole('button', { name: '전표 취소' }).click();
  await page.getByLabel('취소 사유').fill('오입력');
  await page.getByRole('button', { name: '취소 확정' }).click();
  await expect(page.getByText('반대 원장이 생성되었습니다.')).toBeVisible();

  // both rows remain: the original is never deleted
  const ledgerCard = page.locator('section', { has: page.getByRole('heading', { name: '재고 원장 반영' }) });
  await expect(ledgerCard.locator('tbody tr')).toHaveCount(2);
  await expect(ledgerCard).toContainText('취소: 오입력');
});

test('INV-09: 마감 미리보기가 조정 금액을 먼저 보여준다', async ({ page }) => {
  await page.goto('/inventory/valuation');
  await expect(page.getByRole('heading', { name: '재고 평가·월마감', level: 1 })).toBeVisible();
  await expect(page.getByText(/월 총평균법/)).toBeVisible();

  await page.getByRole('button', { name: '마감 미리보기' }).click();
  await expect(page.getByText(/마감조정 합계/)).toBeVisible();
  // the close button only appears alongside the preview it would post
  await expect(page.getByRole('button', { name: '마감 확정' })).toBeVisible();
});

test('INV-04: 원장과 캐시 대조가 불일치 없음을 보고한다', async ({ page }) => {
  await page.goto('/inventory/valuation');
  await page.getByRole('button', { name: '대조 실행' }).click();
  await expect(page.getByText('불일치가 없습니다.')).toBeVisible();
});

/**
 * UIX-06: what a phone is actually for here — looking things up. This runs on every
 * viewport, so the mobile project keeps real inventory coverage rather than only skips.
 */
test('UIX-06: 재고현황과 수불부를 어느 화면폭에서든 조회할 수 있다', async ({ page }) => {
  await page.goto('/inventory/status');
  await expect(page.getByRole('heading', { name: '재고현황', level: 1 })).toBeVisible();

  await page.getByLabel('검색어').fill('');
  await page.getByRole('button', { name: '조회' }).click();
  // the grid scrolls inside itself; the page itself must never scroll sideways
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);

  await page.goto('/inventory/ledger');
  await expect(page.getByRole('heading', { name: '수불부', level: 1 })).toBeVisible();
  await expect(page.getByLabel('품목')).toBeVisible();
});
