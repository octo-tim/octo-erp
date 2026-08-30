// covers: UIX-01, UIX-02, UIX-03, UIX-04, UIX-05, UIX-06, UIX-08, NFR-UX-02, NFR-UX-03
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

test('UIX-01: 대시보드 위젯을 숨기고 순서를 바꾸면 저장된다', async ({ page }) => {
  await expect(page.getByRole('heading', { name: '당월 매출' })).toBeVisible();

  await page.getByRole('button', { name: '위젯 배치' }).click();
  const salesWidget = page.locator('section', { has: page.getByRole('heading', { name: '당월 매출' }) });
  await salesWidget.getByRole('button', { name: '숨김' }).click();
  await page.getByRole('button', { name: '배치 저장 완료' }).click();
  await expect(page.getByRole('heading', { name: '당월 매출' })).toBeHidden();

  await page.reload();
  await expect(page.getByRole('heading', { name: '당월 매출' })).toBeHidden();

  // restore so the suite is re-runnable
  await page.getByRole('button', { name: '위젯 배치' }).click();
  await page
    .locator('section', { has: page.getByRole('heading', { name: '당월 매출' }) })
    .getByRole('button', { name: '표시' })
    .click();
  await page.getByRole('button', { name: '배치 저장 완료' }).click();
});

test('UIX-06: 좁은 화면에서는 메뉴 버튼으로 내비게이션을 연다', async ({ page }, testInfo) => {
  const width = page.viewportSize()?.width ?? 1440;
  const menuButton = page.getByRole('button', { name: '메뉴' });
  if (width >= 1024) {
    await expect(page.getByRole('navigation', { name: '주 메뉴' })).toBeVisible();
    testInfo.skip(true, '데스크톱 폭에서는 메뉴가 항상 보인다');
  }
  await expect(menuButton).toBeVisible();
  await menuButton.click();
  await expect(page.getByRole('navigation', { name: '주 메뉴' })).toBeVisible();
});

test('UIX-08: 알림센터를 열고 모두 읽음 처리할 수 있다', async ({ page }) => {
  await page.getByRole('button', { name: /알림/ }).click();
  await expect(page.getByRole('dialog', { name: '알림센터' })).toBeVisible();
  await page.getByRole('button', { name: '모두 읽음' }).click();
  await expect(page.getByRole('dialog', { name: '알림센터' })).toBeVisible();
});

test.describe('공통 컴포넌트', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/dev/components');
    await expect(page.getByRole('heading', { name: '공통 컴포넌트 갤러리' })).toBeVisible();
  });

  // the gallery renders several components on one page, so each test scopes to its section

  test('UIX-02/03: 조회조건이 저장되고 그리드가 서버 페이징처럼 동작한다', async ({ page }) => {
    const grid = page.getByTestId('section-grid');
    await expect(grid.getByText('총 137건')).toBeVisible();
    await expect(grid.locator('tbody tr')).toHaveCount(25);

    await grid.getByLabel('상태').selectOption('CONFIRMED');
    await grid.getByRole('button', { name: '조회' }).click();
    await expect(grid.getByText(/총 3[0-9]건/)).toBeVisible();

    await page.reload();
    await expect(page.getByTestId('section-grid').getByLabel('상태')).toHaveValue('CONFIRMED');

    await page.getByTestId('section-grid').getByRole('button', { name: '초기화' }).click();
    await expect(page.getByTestId('section-grid').getByText('총 137건')).toBeVisible();
  });

  test('UIX-03: 정렬·다중선택·합계·컬럼 설정이 동작한다', async ({ page }) => {
    const grid = page.getByTestId('section-grid');
    // first click sorts descending, second ascending
    await grid.getByRole('button', { name: /전표번호/ }).click();
    await expect(grid.locator('tbody tr').first()).toContainText('SL-202608-0137');
    await grid.getByRole('button', { name: /전표번호/ }).click();
    await expect(grid.locator('tbody tr').first()).toContainText('SL-202608-0001');

    await grid.getByLabel('전체 선택').check();
    await expect(grid.getByText('25건 선택')).toBeVisible();
    await expect(grid.locator('tfoot')).toContainText('합계 (현재 페이지)');

    await grid.getByRole('button', { name: '컬럼 설정' }).click();
    await grid.getByRole('checkbox', { name: '거래처' }).uncheck();
    await expect(grid.getByRole('columnheader', { name: '거래처' })).toBeHidden();

    await page.reload();
    const reloaded = page.getByTestId('section-grid');
    await expect(reloaded.getByRole('columnheader', { name: '거래처' })).toBeHidden();
    await reloaded.getByRole('button', { name: '컬럼 설정' }).click();
    await reloaded.getByRole('checkbox', { name: '거래처' }).check();
    await expect(reloaded.getByRole('columnheader', { name: '거래처' })).toBeVisible();
  });

  // UIX-06 scopes phones to 조회·대시보드·결재; the gallery stacks every component on one
  // very tall page, where Chrome's phone emulation desyncs the layout and visual viewports
  // and hit-testing lands on the wrong element. Business list screens are covered on
  // desktop and tablet, and the phone flows have their own specs.
  test('UIX-03: 페이지 이동과 페이지 크기 변경', async ({ page, isMobile }) => {
    test.skip(!!isMobile, '모바일은 UIX-06 범위(조회·대시보드·결재)만 검증한다');
    const grid = page.getByTestId('section-grid');
    await grid.getByRole('button', { name: '다음 페이지' }).click();
    await expect(grid.getByText('2 / 6')).toBeVisible();
    await grid.getByLabel('페이지당').selectOption('100');
    await expect(grid.locator('tbody tr')).toHaveCount(100);
  });

  test('UIX-03: 빈 상태와 오류 상태가 다음 행동을 안내한다 (NFR-UX-02)', async ({ page }) => {
    const grid = page.getByTestId('section-grid');
    await grid.getByRole('button', { name: '빈 상태', exact: true }).click();
    await expect(grid.getByText('조회된 자료가 없습니다.')).toBeVisible();
    await expect(grid.getByText('조회조건을 바꾸거나 기간을 넓혀 다시 조회하세요.')).toBeVisible();

    await grid.getByRole('button', { name: '오류', exact: true }).click();
    await expect(
      grid.getByText('조회 중 오류가 발생했습니다. 조회 기간을 좁혀 다시 시도하세요.'),
    ).toBeVisible();
    await grid.getByRole('button', { name: '다시 시도' }).click();
    await expect(grid.getByText('총 137건')).toBeVisible();
  });

  test('UIX-04: 전표 라인은 키보드만으로 입력·행추가·복사·삭제된다', async ({ page }) => {
    const lines = page.getByTestId('section-lines');
    const qty = lines.getByLabel('1행 수량');

    await lines.getByLabel('1행 품목코드').fill('IT-000001');
    await qty.fill('3');
    await lines.getByLabel('1행 단가').fill('1333');
    // DEC-02: 3 x 1,333 = 3,999 supply, 399 VAT
    await expect(lines.locator('tbody tr').first()).toContainText('3,999');
    await expect(lines.locator('tbody tr').first()).toContainText('399');

    // Enter on the last row appends a line and keeps focus in the same column
    await qty.focus();
    await page.keyboard.press('Enter');
    await expect(lines.getByLabel('2행 수량')).toBeFocused();

    // Ctrl+D copies the focused line
    await lines.getByLabel('1행 수량').focus();
    await page.keyboard.press('Control+d');
    await expect(lines.getByLabel('2행 수량')).toHaveValue('3');

    await page.keyboard.press('Control+Delete');
    await expect(lines.getByLabel('3행 수량')).toBeHidden();
  });

  test('UIX-05: 저장 실패 시 오류 요약이 뜨고 입력값이 남는다', async ({ page, isMobile }) => {
    test.skip(!!isMobile, '모바일은 UIX-06 범위(조회·대시보드·결재)만 검증한다');
    const form = page.getByTestId('section-form');
    const nameInput = form.getByLabel('거래처명');
    await nameInput.fill('  ');
    await form.getByRole('button', { name: '저장' }).click();

    const summary = form.getByRole('alert').filter({ hasText: '입력값을 확인하세요' });
    await expect(summary).toBeVisible();
    await expect(summary).toContainText('거래처명: 거래처명을 입력하세요.');
    await expect(nameInput).toHaveValue('  ');
    await expect(nameInput).toHaveAttribute('aria-invalid', 'true');

    await summary.getByRole('button').first().click();
    await expect(nameInput).toBeFocused();
  });

  test('NFR-UX-03: 상태는 색상만이 아니라 항상 라벨로 표시된다', async ({ page }) => {
    const badges = page.getByTestId('status-badges');
    for (const label of ['작성중', '결재중', '확정', '취소', '승인', '반려', '보류', '이동중']) {
      await expect(badges.getByText(label, { exact: true })).toBeVisible();
    }
  });
});
