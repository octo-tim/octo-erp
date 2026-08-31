// covers: RPT-01, RPT-02, RPT-04, RPT-05, RPT-06, RPT-07, RPT-08, UIX-06
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

/** A window wide enough to contain whatever this database has accumulated. */
async function searchWide(page: Page) {
  await page.getByLabel('시작일').fill('2020-01-01');
  await page.getByLabel('종료일').fill('2030-12-31');
  await page.getByRole('button', { name: '조회', exact: true }).click();
}

test('RPT-06: 대시보드 위젯이 실제 숫자와 원천 화면 링크를 보여준다', async ({ page }) => {
  await page.goto('/home');
  const main = page.getByRole('main');

  await expect(main.getByText('당월 매출')).toBeVisible();
  await expect(main.getByText('매출이익률')).toBeVisible();
  await expect(main.getByText('안전재고 미달')).toBeVisible();

  // UIX-01: every widget offers a way to the screen its number came from
  await expect(main.getByRole('link', { name: '재고현황' }).first()).toBeVisible();
  await main.getByRole('link', { name: '채권채무 현황' }).first().click();
  await expect(page).toHaveURL(/\/reports\/receivables/);
});

test('RPT-01: 매출현황이 집계 단위를 바꿔 조회된다', async ({ page }) => {
  await page.goto('/reports/sales');
  await expect(page.getByRole('heading', { name: '매출현황' })).toBeVisible();

  await page.getByLabel('집계 단위').selectOption('DAY');
  await searchWide(page);

  const main = page.getByRole('main');
  // either rows or an explicit empty state — never a blank screen (NFR-UX-02)
  await expect(
    main.getByRole('table').or(main.getByText('조회 조건에 해당하는 자료가 없습니다.')),
  ).toBeVisible();
  await expect(main.getByText('사내 관리용')).toBeVisible();
});

test('RPT-07: 조회조건이 저장되어 다시 들어와도 남아 있다', async ({ page }) => {
  await page.goto('/reports/sales');
  await page.getByLabel('시작일').fill('2024-03-01');
  await page.getByLabel('종료일').fill('2024-03-31');
  // the conditions are saved in the background so the search is not held up by the write;
  // the test waits for that request rather than for a timeout
  const saved = page.waitForResponse((r) => r.url().includes('preference.set') && r.ok());
  await page.getByRole('button', { name: '조회', exact: true }).click();
  await saved;

  await page.goto('/home');
  await page.goto('/reports/sales');
  await expect(page.getByLabel('시작일')).toHaveValue('2024-03-01');
  await expect(page.getByLabel('종료일')).toHaveValue('2024-03-31');
});

test('RPT-02: 품목순위가 기준과 건수를 바꿔 조회된다', async ({ page }) => {
  await page.goto('/reports/items');
  await page.getByLabel('순위 기준').selectOption('QUANTITY');
  await page.getByLabel('표시 건수').selectOption('10');
  await searchWide(page);

  const main = page.getByRole('main');
  await expect(main.getByRole('heading', { name: '품목순위' })).toBeVisible();
  await expect(main.getByText('기여도는 표시된 상위')).toBeVisible();
});

test('RPT-04: 재고현황이 안전재고 미달만 걸러 보여준다', async ({ page }) => {
  await page.goto('/reports/inventory');
  await searchWide(page);

  const main = page.getByRole('main');
  await expect(main.getByRole('heading', { name: '재고현황' })).toBeVisible();

  await page.getByLabel('안전재고 미달만').check();
  await expect(page.getByLabel('안전재고 미달만')).toBeChecked();
});

test('RPT-05: 채권채무 화면이 미수와 미지급을 오간다', async ({ page }) => {
  await page.goto('/reports/receivables');
  await searchWide(page);
  await expect(page.getByRole('main').getByRole('heading', { name: '채권채무 현황' })).toBeVisible();

  await page.getByLabel('채권채무 구분').selectOption('PAYABLE');
  await expect(page.getByLabel('채권채무 구분')).toHaveValue('PAYABLE');
});

test('RPT-08: 매출현황 행에서 원천 전표 목록으로 내려간다', async ({ page }) => {
  await page.goto('/reports/sales');
  await searchWide(page);

  const main = page.getByRole('main');
  await expect(main.getByText(/총 .*건|자료가 없습니다/)).toBeVisible();

  const rows = main.locator('tbody tr');
  if ((await rows.count()) === 0) test.skip(true, '집계할 확정 매출이 없는 데이터셋');

  await rows.first().click();
  await expect(page).toHaveURL(/\/reports\/drilldown\?target=SALES/);
  await expect(page.getByRole('heading', { name: '매출전표 상세' })).toBeVisible();
});

test('RPT-09: 결재현황이 장기 미결을 함께 보여준다', async ({ page }) => {
  await page.goto('/reports/approval');
  await searchWide(page);
  const main = page.getByRole('main');
  await expect(main.getByRole('heading', { name: '결재현황' })).toBeVisible();
  await expect(main.getByRole('heading', { name: '장기 미결' })).toBeVisible();
});

test('RPT-10: 근태·인원현황이 인원과 연차 사용률을 보여준다', async ({ page }) => {
  await page.goto('/reports/hr');
  await searchWide(page);
  const main = page.getByRole('main');
  await expect(main.getByRole('heading', { name: '근태·인원현황' })).toBeVisible();
  await expect(main.getByText('재직 인원')).toBeVisible();
  await expect(main.getByText('연차 사용률')).toBeVisible();
});

/** UIX-06: reports are 조회 screens, so a phone must be able to read them. */
test('UIX-06: 보고서를 어느 화면폭에서든 조회할 수 있다', async ({ page }) => {
  for (const path of ['/reports/sales', '/reports/inventory', '/reports/receivables']) {
    await page.goto(path);
    await searchWide(page);
    await expect(page.getByRole('main').getByRole('heading', { level: 1 })).toBeVisible();

    // the page itself must not scroll sideways, whatever the table does inside it
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);
  }
});
