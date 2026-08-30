// covers: BAS-01, BAS-03, BAS-04, BAS-06, BAS-07, BAS-08, BAS-09
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
 * BAS-04 forbids duplicate business numbers, so a run must not reuse the previous run's.
 * This mirrors the NTS check-digit rule to mint a fresh valid number each time.
 */
function validBusinessNo(): string {
  const body = String(Date.now()).slice(-9);
  const weights = [1, 3, 7, 1, 3, 7, 1, 3, 5];
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += Number(body[i]) * weights[i]!;
  sum += Math.floor((Number(body[8]) * 5) / 10);
  const check = (10 - (sum % 10)) % 10;
  const n = `${body}${check}`;
  return `${n.slice(0, 3)}-${n.slice(3, 5)}-${n.slice(5)}`;
}

test('BAS-01: 품목을 등록하면 자동채번된 코드로 목록에 나타난다', async ({ page }) => {
  const name = `시험품목${Date.now().toString().slice(-6)}`;
  await page.goto('/master/items');
  await page.getByRole('button', { name: '품목 등록' }).click();

  await page.getByLabel('품목명').fill(name);
  await page.getByLabel('규격').fill('1200mm');
  await page.getByLabel('출고단가').fill('18000');
  await page.getByRole('button', { name: '저장', exact: true }).click();

  await page.getByLabel('검색어').fill(name);
  await page.getByRole('button', { name: '조회' }).click();
  const row = page.locator('tbody tr', { hasText: name });
  await expect(row).toBeVisible();
  await expect(row.locator('td').first()).toHaveText(/^IT-\d{6}$/);
  await expect(row).toContainText('18,000');
});

test('BAS-01: 잘못된 바코드는 저장되지 않고 이유를 알려준다', async ({ page }) => {
  await page.goto('/master/items');
  await page.getByRole('button', { name: '품목 등록' }).click();
  await page.getByLabel('품목명').fill('바코드 오류 시험');
  await page.getByLabel('바코드').fill('8801234567890');
  await page.getByRole('button', { name: '저장', exact: true }).click();

  const summary = page.getByRole('alert').filter({ hasText: '입력값을 확인하세요' });
  await expect(summary).toContainText('체크디지트');
  await expect(page.getByLabel('품목명')).toHaveValue('바코드 오류 시험');
});

test('BAS-04: 거래처 사업자번호 체크섬을 검증한다', async ({ page }) => {
  await page.goto('/master/partners');
  await page.getByRole('button', { name: '거래처 등록' }).click();
  await page.getByLabel('거래처명').fill('사업자번호 시험');
  await page.getByLabel('사업자등록번호').fill('123-45-67890');
  await page.getByRole('button', { name: '저장', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: '입력값을 확인하세요' })).toContainText('확인번호');

  const name = `한빛건재${Date.now().toString().slice(-6)}`;
  const businessNo = validBusinessNo();
  await page.getByLabel('거래처명').fill(name);
  await page.getByLabel('사업자등록번호').fill(businessNo);
  await page.getByLabel('여신한도').fill('50000000');
  await page.getByLabel('담당자', { exact: true }).fill('김담당');
  await page.getByRole('button', { name: '저장', exact: true }).click();

  await page.getByLabel('검색어').fill(name);
  await page.getByRole('button', { name: '조회' }).click();
  const row = page.locator('tbody tr', { hasText: name });
  await expect(row).toContainText(businessNo);
  await expect(row).toContainText('50,000,000');
});

test('BAS-08/BAS-09: 품목 상세에서 변경 이력과 사용중지를 확인한다', async ({ page }) => {
  const name = `이력품목${Date.now().toString().slice(-6)}`;
  await page.goto('/master/items');
  await page.getByRole('button', { name: '품목 등록' }).click();
  await page.getByLabel('품목명').fill(name);
  await page.getByLabel('출고단가').fill('1000');
  await page.getByRole('button', { name: '저장', exact: true }).click();

  await page.getByLabel('검색어').fill(name);
  await page.getByRole('button', { name: '조회' }).click();
  await page.locator('tbody tr', { hasText: name }).getByRole('button').first().click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText(name);

  // edit and confirm the change history records both values
  await page.getByRole('button', { name: '수정' }).click();
  await page.getByLabel('출고단가').fill('1500');
  await page.getByRole('button', { name: '저장' }).click();
  await expect(page.getByText('저장했습니다.')).toBeVisible();

  const history = page.locator('section', { has: page.getByRole('heading', { name: '변경 이력' }) });
  await expect(history).toContainText('수정');
  await expect(history).toContainText('출고단가: 1000 → 1500');

  // BAS-09: an unused master can be deleted, but deactivation is always available
  await page.getByRole('button', { name: '사용중지' }).click();
  await expect(page.getByText('사용중지 처리했습니다.')).toBeVisible();
});

test('BAS-03: 일괄등록 화면이 양식과 검증 절차를 안내한다', async ({ page }) => {
  await page.goto('/master/items/bulk');
  await expect(page.getByRole('heading', { name: '일괄등록', level: 1 })).toBeVisible();
  await expect(page.getByRole('button', { name: /양식 다운로드/ })).toBeVisible();
  await expect(
    page.getByText('선택한 정상 행만 반영되며, 한 건이라도 실패하면 전체가 취소됩니다.'),
  ).toBeVisible();

  await page.getByText(/양식 항목/).click();
  await expect(page.getByText('품목명').first()).toBeVisible();

  await page.getByLabel('대상').selectOption('PARTNER');
  await page.getByText(/양식 항목/).click();
  await expect(page.getByText('사업자등록번호').first()).toBeVisible();
});

test('BAS-06: 창고를 등록하고 사용중지할 수 있다', async ({ page }) => {
  const code = `W${Date.now().toString().slice(-3)}`;
  await page.goto('/master/warehouses');
  await page.getByLabel('창고코드').fill(code);
  await page.getByLabel('창고명').fill('시험창고');
  await page.getByLabel('유형').selectOption('DEFECT');
  await page.getByRole('button', { name: '등록' }).click();

  const row = page.locator('tbody tr', { hasText: code });
  await expect(row).toContainText('불량');
  await row.getByRole('button', { name: '사용중지' }).click();
  await expect(page.locator('tbody tr', { hasText: code })).toContainText('중지');
});

test('BAS-07: 공통코드 그룹을 전환하고 코드를 추가한다', async ({ page }) => {
  const main = page.getByRole('main');
  await page.goto('/master/codes');
  // UNIT is the default group. Scope to main and match the heading: a bare '개' also
  // matches nav entries such as '분개규칙' hidden in the mobile drawer.
  await expect(main.getByRole('heading', { name: '단위 코드' })).toBeVisible();

  await page.getByRole('button', { name: '결제수단' }).click();
  await expect(main.getByText('계좌이체')).toBeVisible();

  // the name carries the run's suffix too: earlier runs leave their codes behind
  const code = `TEST${Date.now().toString().slice(-4)}`;
  const label = `시험결제수단${code}`;
  await page.getByLabel('코드').fill(code);
  await page.getByLabel('명칭').fill(label);
  await page.getByRole('button', { name: '저장' }).click();
  await expect(page.getByText(label)).toBeVisible();
});

test('BAS-07: 사용 중인 단위는 사용중지 시 이유를 알려준다', async ({ page }) => {
  // create an item that uses the BOX unit
  await page.goto('/master/items');
  await page.getByRole('button', { name: '품목 등록' }).click();
  await page.getByLabel('품목명').fill(`단위사용${Date.now().toString().slice(-6)}`);
  await page.getByLabel('단위').selectOption('BOX');
  await page.getByRole('button', { name: '저장', exact: true }).click();

  await page.goto('/master/codes');
  const boxRow = page.locator('li', { hasText: '박스' });
  await boxRow.getByRole('button', { name: '사용중지' }).click();
  // scoped to main: Next renders its own empty role=alert route announcer on <body>
  await expect(page.getByRole('main').getByRole('alert')).toContainText('사용 중인 단위');
});

test('채번규칙 화면이 예시와 최근 발행 번호를 보여준다', async ({ page }) => {
  await page.goto('/master/numbering');
  await expect(page.getByRole('heading', { name: '채번규칙', level: 1 })).toBeVisible();
  const salesRow = page.locator('tbody tr', { hasText: '매출전표' });
  await expect(salesRow).toContainText('SL');
  await expect(salesRow).toContainText('SL-202609-0001');
});
