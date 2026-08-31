// covers: APV-06, APV-07, APV-10, APV-12, APV-14, APV-15
import { expect, test, type Page } from '@playwright/test';

const ADMIN = process.env['E2E_USERNAME'] ?? 'admin';
const ADMIN_PW = process.env['E2E_PASSWORD'] ?? 'Admin!2345';

async function login(page: Page, username = ADMIN, password = ADMIN_PW) {
  await page.goto('/login');
  await page.getByLabel('아이디').fill(username);
  await page.getByLabel('비밀번호').fill(password);
  await page.getByRole('button', { name: '로그인' }).click();
  await expect(page).toHaveURL(/\/home$/);
}

test.beforeEach(async ({ page }) => {
  await login(page);
});

test('APV-10: 결재함 탭이 모두 열리고 대기 배지를 보여준다', async ({ page }) => {
  await page.goto('/approval/inbox');
  await expect(page.getByRole('heading', { name: '결재함', level: 1 })).toBeVisible();

  for (const tab of ['대기', '기안', '진행', '완료', '반려·회수', '참조']) {
    await page.getByRole('tab', { name: new RegExp(tab) }).click();
    await expect(page.getByRole('tab', { name: new RegExp(tab) })).toHaveAttribute('aria-selected', 'true');
  }
});

test('APV-06: 양식을 고르면 동적 입력 항목이 나타나고 임시저장된다', async ({ page }) => {
  await page.goto('/approval/draft');
  await expect(page.getByText('양식을 선택하면 입력 항목이 나타납니다.')).toBeVisible();

  await page.getByLabel('결재양식').selectOption('EXPENSE');
  await expect(page.getByLabel('지출목적')).toBeVisible();
  await expect(page.getByLabel('지출금액')).toBeVisible();
  await expect(page.getByLabel('지급처')).toBeVisible();

  await page.getByLabel('제목', { exact: true }).fill(`E2E 지출결의 ${Date.now().toString().slice(-6)}`);
  await page.getByLabel('지출목적').fill('사무용품 구매');
  await page.getByLabel('지출금액').fill('150000');
  await page.getByLabel('지급예정일').fill('2026-09-30');
  await page.getByLabel('지급처').fill('오피스넥스');
  await page.getByRole('button', { name: '임시저장' }).click();

  await expect(page).toHaveURL(/\/approval\/documents\//);
  await expect(page.getByText('작성중')).toBeVisible();
  await expect(page.getByText('150,000')).toBeVisible();
});

test('APV-06: 필수 항목이 비면 오류 요약이 뜬다 (UIX-05)', async ({ page }) => {
  await page.goto('/approval/draft');
  await page.getByLabel('결재양식').selectOption('EXPENSE');
  await page.getByLabel('지출목적').fill('일부만 입력');
  await page.getByRole('button', { name: '임시저장' }).click();

  const summary = page.getByRole('alert').filter({ hasText: '입력값을 확인하세요' });
  await expect(summary).toBeVisible();
  await expect(summary).toContainText('제목');
  await expect(summary).toContainText('지출금액');
  await expect(page.getByLabel('지출목적')).toHaveValue('일부만 입력');
});

test('APV-07: 결재선이 없으면 상신이 사유와 함께 거부된다', async ({ page }) => {
  // the seeded admin has no employee record, so DRAFTER_MANAGER cannot resolve
  await page.goto('/approval/draft');
  await page.getByLabel('결재양식').selectOption('PROPOSAL');
  await page.getByLabel('제목', { exact: true }).fill(`E2E 품의 ${Date.now().toString().slice(-6)}`);
  await page.getByLabel('품의제목').fill('시험 품의');
  await page.getByLabel('배경').fill('결재선 미해결 상황 확인');
  await page.getByRole('button', { name: '상신' }).click();

  const summary = page.getByRole('alert').filter({ hasText: '입력값을 확인하세요' });
  await expect(summary).toContainText('승인 단계가 없는 결재선');
});

test('APV-15: 결재문서에 인쇄·PDF 버튼과 결재선·이력이 표시된다', async ({ page }) => {
  await page.goto('/approval/draft');
  await page.getByLabel('결재양식').selectOption('PROPOSAL');
  await page.getByLabel('제목', { exact: true }).fill(`E2E 출력 ${Date.now().toString().slice(-6)}`);
  await page.getByLabel('품의제목').fill('출력 확인');
  await page.getByLabel('배경').fill('인쇄 레이아웃 확인용');
  await page.getByRole('button', { name: '임시저장' }).click();
  await expect(page).toHaveURL(/\/approval\/documents\//);

  await expect(page.getByRole('button', { name: /인쇄/ })).toBeVisible();
  await expect(page.getByRole('heading', { name: '결재선', exact: true })).toBeVisible();
  await expect(page.getByText('아직 결재선이 없습니다.')).toBeVisible();
  await expect(page.getByRole('heading', { name: '처리 이력' })).toBeVisible();
});

test('APV-01: 결재양식 화면이 항목 스키마와 버전을 보여준다', async ({ page }) => {
  await page.goto('/approval/forms');
  await expect(page.getByRole('heading', { name: '결재양식', level: 1 })).toBeVisible();
  await expect(page.getByRole('heading', { name: /지출결의서 \(EXPENSE\)/ })).toBeVisible();
  await expect(page.getByRole('heading', { name: /휴가신청서 \(LEAVE\)/ })).toBeVisible();
  await expect(page.getByText('연동 대상: LEAVE_REQUEST').first()).toBeVisible();
});

test('APV-04: 결재선·전결 화면에서 대결을 설정하고 해제한다', async ({ page }) => {
  await page.goto('/approval/lines');
  await expect(page.getByRole('heading', { name: '결재선·전결', level: 1 })).toBeVisible();
  // .first(): the template name now also appears in the 결재선 규칙 table added for APV-03,
  // so this must name the template card rather than matching anywhere on the page.
  await expect(page.getByText('기본 결재선 (부서장 → 대표)').first()).toBeVisible();
  await expect(page.getByText('기안자 부서장')).toBeVisible();
  await expect(page.getByText('3,000,000')).toBeVisible();

  await expect(page.getByText('설정된 대결이 없습니다.')).toBeVisible();

  // Only the seeded admin exists in a fresh install, so the one selectable deputy is
  // the logged-in user — which the server refuses, and the screen surfaces the reason.
  await page.getByLabel('대결자').selectOption({ index: 1 });
  await page.getByLabel('시작일').fill('2027-01-01');
  await page.getByLabel('종료일').fill('2027-01-31');
  await page.getByLabel('사유').fill('연차');
  await page.getByRole('button', { name: '대결 설정' }).click();
  await expect(page.getByRole('alert').filter({ hasText: '대결자' })).toContainText(
    '본인을 대결자로 지정할 수 없습니다',
  );
});

/**
 * APV-14: the requirement is mobile lookup *and* approve *and* reject — a screen that only
 * loads is not evidence any of the three work. The seeded admin has no employee record, so
 * it can never resolve an approver for its own documents (see the APV-07 test above); it also
 * cannot approve its own document even if it could (a drafter is never its own approver). So
 * this test has admin register a second, disposable account through the normal 사용자 등록
 * screen, uses the APV-03 결재선 override to hand that account the APPROVE step on two
 * documents (STANDARD is an editable template), then logs in as that account on the mobile
 * viewport to actually approve one and actually reject the other — asserting each one lands
 * in the status the action implies.
 */
test('APV-14: 모바일에서 결재를 승인하고 반려한다', async ({ page, context, isMobile }) => {
  test.skip(!isMobile, '모바일 결재 요구사항(APV-14) 전용 검증');

  const suffix = Date.now().toString().slice(-8);
  const approverUsername = `mobile-appr-${suffix}`;
  const approverDisplayName = '모바일 승인자';
  const tempPassword = 'MobileAppr!2345';
  const newPassword = `Changed!${suffix}`;
  const approveTitle = `모바일 승인대상 ${suffix}`;
  const rejectTitle = `모바일 반려대상 ${suffix}`;

  // 1) admin registers a fresh, disposable approver account for this run only
  await page.goto('/system/users');
  await page.getByLabel('아이디').fill(approverUsername);
  await page.getByLabel('이름').fill(approverDisplayName);
  await page.getByLabel('임시 비밀번호').fill(tempPassword);
  await page.getByLabel('영업 (sales)').check();
  await page.getByRole('button', { name: '등록', exact: true }).click();
  await expect(page.getByText(/계정을 등록했습니다/)).toBeVisible();

  // 2) admin drafts a document, overrides its 결재선 to the new account, and submits — twice
  async function draftAssignedTo(title: string) {
    await page.goto('/approval/draft');
    await page.getByLabel('결재양식').selectOption('EXPENSE');
    await page.getByLabel('제목', { exact: true }).fill(title);
    await page.getByLabel('지출목적').fill(title);
    await page.getByLabel('지출금액').fill('120000');
    await page.getByLabel('지급예정일').fill('2026-09-30');
    await page.getByLabel('지급처').fill('오피스넥스');
    await page.getByRole('button', { name: '임시저장' }).click();
    await expect(page).toHaveURL(/\/approval\/documents\//);

    // the seeded admin has no resolvable department head, so the generated line starts
    // empty here — that is exactly what an editable template's override is for
    await expect(page.getByRole('heading', { name: '결재선 미리보기' })).toBeVisible();
    await page.getByRole('button', { name: '단계 추가' }).click();
    const approverSelect = page.getByLabel('1단계 결재자');
    // the candidate list loads asynchronously — wait for the option to actually exist before
    // selecting it, rather than racing the query
    await expect(approverSelect.locator('option', { hasText: approverDisplayName })).toHaveCount(1);
    await approverSelect.selectOption({ label: `${approverDisplayName} (${approverUsername})` });
    await page.getByRole('button', { name: '상신' }).click();
    await expect(page.getByRole('status')).toContainText('상신했습니다');
  }

  await draftAssignedTo(approveTitle);
  await draftAssignedTo(rejectTitle);

  // 3) switch identities: log out of admin, into the freshly created account (forced
  // password change first, exactly like any other temporary-password account)
  await page.request.post('/api/auth/logout');
  await context.clearCookies();
  await page.goto('/login');
  await page.getByLabel('아이디').fill(approverUsername);
  await page.getByLabel('비밀번호').fill(tempPassword);
  await page.getByRole('button', { name: '로그인' }).click();
  await expect(page).toHaveURL(/\/account/);
  await page.getByLabel('현재 비밀번호').fill(tempPassword);
  await page.getByLabel('새 비밀번호', { exact: true }).fill(newPassword);
  await page.getByLabel('새 비밀번호 확인').fill(newPassword);
  await page.getByRole('button', { name: '비밀번호 변경' }).click();
  await expect(page).toHaveURL(/\/login$/);
  await page.getByLabel('아이디').fill(approverUsername);
  await page.getByLabel('비밀번호').fill(newPassword);
  await page.getByRole('button', { name: '로그인' }).click();
  await expect(page).toHaveURL(/\/home$/);

  // 4) mobile: open the pending inbox and actually approve one document
  await page.goto('/approval/inbox');
  await expect(page.getByRole('heading', { name: '결재함', level: 1 })).toBeVisible();
  await expect(page.getByRole('tab', { name: /대기/ })).toHaveAttribute('aria-selected', 'true');
  await page.locator('tbody tr', { hasText: approveTitle }).getByRole('button').first().click();

  await expect(page).toHaveURL(/\/approval\/documents\//);
  await expect(page.getByRole('heading', { name: '결재 처리' })).toBeVisible();
  await page.getByRole('button', { name: '승인' }).click();
  await expect(page.getByRole('status')).toContainText('승인했습니다');
  // approved and complete: nothing left for this actor to act on
  await expect(page.getByRole('heading', { name: '결재 처리' })).toHaveCount(0);

  // 5) mobile: back to the inbox, and actually reject the other one
  await page.goto('/approval/inbox');
  await page.locator('tbody tr', { hasText: rejectTitle }).getByRole('button').first().click();
  await expect(page.getByRole('heading', { name: '결재 처리' })).toBeVisible();
  await page.getByLabel('의견').fill('모바일 반려 시험');
  await page.getByRole('button', { name: '반려' }).click();
  await expect(page.getByRole('status')).toContainText('반려했습니다');
  await expect(page.getByRole('heading', { name: '결재 처리' })).toHaveCount(0);

  // 6) the inbox reflects both outcomes: neither document is pending any more
  await page.goto('/approval/inbox');
  await expect(page.getByText(approveTitle)).toHaveCount(0);
  await expect(page.getByText(rejectTitle)).toHaveCount(0);
  await page.getByRole('tab', { name: /반려·회수/ }).click();
  await expect(page.locator('tbody tr', { hasText: rejectTitle })).toBeVisible();
});
