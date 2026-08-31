// covers: NFR-SEC-03, NFR-SEC-04, NFR-UX-01, NFR-UX-03, UIX-06
import { expect, test } from '@playwright/test';
import { FIRST_LOGIN_PASSWORD, FIRST_LOGIN_USERNAME } from './accounts';

const USERNAME = process.env['E2E_USERNAME'] ?? 'admin';
const PASSWORD = process.env['E2E_PASSWORD'] ?? 'Admin!2345';

test('로그인하지 않은 사용자는 로그인 화면으로 이동한다', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole('heading', { name: '옥토웍스 경영관리' })).toBeVisible();
});

// Uses a non-existent account on purpose: repeatedly failing the real admin login
// would trip the 5-attempt lockout (NFR-SEC-04) and make the suite order-dependent.
test('잘못된 자격증명은 원인을 알려주는 오류를 보여준다', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('아이디').fill('no-such-user-e2e');
  await page.getByLabel('비밀번호').fill('definitely-wrong-1');
  await page.getByRole('button', { name: '로그인' }).click();
  await expect(page.getByTestId('login-error')).toContainText('올바르지 않습니다');
  await expect(page).toHaveURL(/\/login$/);
});

test('올바른 자격증명으로 로그인하면 홈으로 이동한다', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('아이디').fill(USERNAME);
  await page.getByLabel('비밀번호').fill(PASSWORD);
  await page.getByRole('button', { name: '로그인' }).click();
  await expect(page).toHaveURL(/\/home$/);
  await expect(page.getByRole('heading', { level: 1 })).toContainText('안녕하세요');
});

test('세션 쿠키는 HttpOnly이며 값이 노출되지 않는다', async ({ page, context }) => {
  await page.goto('/login');
  await page.getByLabel('아이디').fill(USERNAME);
  await page.getByLabel('비밀번호').fill(PASSWORD);
  await page.getByRole('button', { name: '로그인' }).click();
  await expect(page).toHaveURL(/\/home$/);

  const cookie = (await context.cookies()).find((c) => c.name === 'erp_session');
  expect(cookie).toBeTruthy();
  expect(cookie!.httpOnly).toBe(true);
  expect(cookie!.sameSite).toBe('Lax');
  expect(await page.evaluate(() => document.cookie)).not.toContain('erp_session');
});

test('키보드만으로 로그인 폼을 조작할 수 있다', async ({ page }) => {
  await page.goto('/login');
  await page.keyboard.press('Tab');
  await page.keyboard.type(USERNAME);
  await page.keyboard.press('Tab');
  await page.keyboard.type(PASSWORD);
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/home$/);
});

test('로그아웃하면 세션이 폐기된다', async ({ page, context }) => {
  await page.goto('/login');
  await page.getByLabel('아이디').fill(USERNAME);
  await page.getByLabel('비밀번호').fill(PASSWORD);
  await page.getByRole('button', { name: '로그인' }).click();
  await expect(page).toHaveURL(/\/home$/);

  const res = await page.request.post('/api/auth/logout');
  expect(res.ok()).toBe(true);
  await context.clearCookies();
  await page.goto('/');
  await expect(page).toHaveURL(/\/login$/);
});

/**
 * NFR-SEC-03: a temporary password issued by an admin has to be replaced before the account
 * can be used. The flag existed from the first migration and nothing acted on it, so an
 * account handed a password the admin knows kept it indefinitely.
 */
test('임시 비밀번호로 로그인하면 변경 화면을 벗어날 수 없다', async ({ page }, testInfo) => {
  /**
   * Desktop only, and not because the behaviour is desktop-specific. The test spends the
   * temporary password: once it has been replaced the account no longer has one, so the
   * second and third projects would have nothing left to test. Preparing the account is
   * globalSetup's job and globalSetup runs once for the whole suite, so the flow is walked
   * once. Nothing about it depends on viewport.
   */
  test.skip(testInfo.project.name !== 'desktop-chromium', '임시 비밀번호는 한 번만 소모된다');

  await page.goto('/login');
  await page.getByLabel('아이디').fill(FIRST_LOGIN_USERNAME);
  await page.getByLabel('비밀번호').fill(FIRST_LOGIN_PASSWORD);
  await page.getByRole('button', { name: '로그인' }).click();

  await expect(page).toHaveURL(/\/account/);
  await expect(page.getByText('관리자가 발급한 임시 비밀번호')).toBeVisible();

  // any other screen bounces straight back until the password is replaced
  await page.goto('/home');
  await expect(page).toHaveURL(/\/account/);

  const replacement = `Changed!${Date.now()}`;
  await page.getByLabel('현재 비밀번호').fill(FIRST_LOGIN_PASSWORD);
  await page.getByLabel('새 비밀번호', { exact: true }).fill(replacement);
  await page.getByLabel('새 비밀번호 확인').fill(replacement);
  await page.getByRole('button', { name: '비밀번호 변경' }).click();

  // changing the password revokes every session, so the user lands back on login
  await expect(page).toHaveURL(/\/login$/);

  await page.getByLabel('아이디').fill(FIRST_LOGIN_USERNAME);
  await page.getByLabel('비밀번호').fill(replacement);
  await page.getByRole('button', { name: '로그인' }).click();
  await expect(page).toHaveURL(/\/home$/);
});

test('상태점검 엔드포인트가 정상을 보고한다', async ({ request }) => {
  const res = await request.get('/api/health');
  expect(res.ok()).toBe(true);
  expect((await res.json()).status).toBe('ok');
});
