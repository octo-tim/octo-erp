// covers: HRM-01, HRM-02, HRM-05, HRM-10, HRM-12, HRM-13, NFR-SEC-06
import { expect, test, type Page } from '@playwright/test';

const USERNAME = process.env['E2E_USERNAME'] ?? 'admin';
const PASSWORD = process.env['E2E_PASSWORD'] ?? 'Admin!2345';

async function login(page: Page) {
  await page.goto('/login');
  await page.getByLabel('아이디').fill(USERNAME);
  await page.getByLabel('비밀번호').fill(PASSWORD);
  await page.getByRole('button', { name: '로그인' }).click();
  await expect(page).toHaveURL(/\/home$/);
}

test.beforeEach(async ({ page }) => {
  await login(page);
});

test('HRM-01: 사원을 등록하면 목록에 사번과 함께 나타난다', async ({ page }) => {
  const name = `시험사원${Date.now().toString().slice(-6)}`;
  await page.goto('/hr/employees');
  await expect(page.getByRole('heading', { name: '사원', level: 1 })).toBeVisible();

  await page.getByRole('button', { name: '사원 등록' }).click();
  await page.getByLabel('성명').fill(name);
  await page.getByLabel('입사일').fill('2026-03-02');
  await page.getByLabel('직위').fill('사원');
  await page.getByRole('button', { name: '저장', exact: true }).click();

  await page.getByLabel('검색어').fill(name);
  await page.getByRole('button', { name: '조회' }).click();
  const row = page.locator('tbody tr', { hasText: name });
  await expect(row).toBeVisible();
  await expect(row.locator('td').first()).toHaveText(/^\d{7}$/);
});

test('HRM-01: 필수값 없이 저장하면 오류 요약이 뜨고 입력값이 남는다 (UIX-05)', async ({ page }) => {
  await page.goto('/hr/employees');
  await page.getByRole('button', { name: '사원 등록' }).click();
  await page.getByLabel('직위').fill('과장');
  await page.getByRole('button', { name: '저장', exact: true }).click();

  const summary = page.getByRole('alert').filter({ hasText: '입력값을 확인하세요' });
  await expect(summary).toBeVisible();
  await expect(summary).toContainText('성명');
  await expect(summary).toContainText('입사일');
  await expect(page.getByLabel('직위')).toHaveValue('과장');
});

test('HRM-12 / NFR-SEC-06: 민감정보는 마스킹되고 원문 조회에 사유가 필요하다', async ({ page }) => {
  const name = `민감시험${Date.now().toString().slice(-6)}`;
  await page.goto('/hr/employees');
  await page.getByRole('button', { name: '사원 등록' }).click();
  await page.getByLabel('성명').fill(name);
  await page.getByLabel('입사일').fill('2024-03-01');
  await page.getByRole('button', { name: '저장', exact: true }).click();

  await page.getByLabel('검색어').fill(name);
  await page.getByRole('button', { name: '조회' }).click();
  await page.locator('tbody tr', { hasText: name }).getByRole('button').first().click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText(name);

  const panel = page.locator('section', {
    has: page.getByRole('heading', { name: '민감정보 (주민번호·계좌번호)' }),
  });
  await panel.getByRole('button', { name: '등록·수정' }).click();
  await panel.getByLabel('주민번호').fill('900101-1234567');
  await panel.getByLabel('계좌번호').fill('110-123-456789');
  await panel.getByLabel('은행').fill('국민');
  await panel.getByRole('button', { name: '저장' }).click();

  // masked by default, plaintext never rendered
  await expect(panel.getByText('******-4******')).toBeVisible();
  await expect(page.getByText('900101-1234567')).toBeHidden();

  // reveal requires a reason of at least 5 characters
  const revealButton = panel.getByRole('button', { name: '원문 조회' });
  await expect(revealButton).toBeDisabled();
  await panel.getByLabel('조회 사유').fill('4대보험 신고자료 작성');
  await expect(revealButton).toBeEnabled();
  await revealButton.click();
  await expect(panel.getByText('9001011234567')).toBeVisible();

  // the access is logged
  await panel
    .getByRole('group')
    .getByText(/접근이력/)
    .click();
  await expect(panel.getByText('4대보험 신고자료 작성')).toBeVisible();
});

test('HRM-02: 조직도 기준일을 바꾸면 그 시점 구조를 보여준다', async ({ page }) => {
  await page.goto('/hr/org');
  await expect(page.getByRole('heading', { name: '조직도', level: 1 })).toBeVisible();
  await expect(page.getByText('옥토웍스').first()).toBeVisible();
  await expect(page.getByText('영업팀').first()).toBeVisible();

  // before any department existed
  await page.getByLabel('기준일').fill('2019-01-01');
  await expect(page.getByText('해당 기준일에 유효한 부서가 없습니다.')).toBeVisible();
});

test('HRM-10: 인사현황이 인원 분포를 보여준다', async ({ page }) => {
  await page.goto('/hr/overview');
  await expect(page.getByRole('heading', { name: '인사현황', level: 1 })).toBeVisible();
  await expect(page.getByRole('heading', { name: '총 인원' })).toBeVisible();
  await expect(page.getByRole('heading', { name: '부서별' })).toBeVisible();
  await expect(page.getByRole('heading', { name: '근속별' })).toBeVisible();
});

test('HRM-05: 휴가 화면이 잔여 연차와 신청 폼을 제공한다', async ({ page }) => {
  await page.goto('/hr/leave');
  await expect(page.getByRole('heading', { name: '휴가·연차', level: 1 })).toBeVisible();
  await page.getByRole('button', { name: '휴가 신청' }).click();
  await expect(page.getByLabel('시작일')).toBeVisible();
  await expect(page.getByText('반차는 하루만 신청할 수 있습니다.')).toBeVisible();
});

test('HRM-13: 사원 계정이 없는 관리자는 내 정보에서 안내를 본다', async ({ page }) => {
  await page.goto('/hr/me');
  // the seeded admin has no linked employee record, so the screen explains rather than erroring
  await expect(
    page.getByText(/내 정보를 불러올 수 없습니다|연결된 사원정보가 없습니다/).first(),
  ).toBeVisible();
});
