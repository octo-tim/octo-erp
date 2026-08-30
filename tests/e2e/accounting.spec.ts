// covers: ACC-01, ACC-02, ACC-03, ACC-04, ACC-05, ACC-06, ACC-07, ACC-08
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

/** See inventory.spec.ts: UIX-06 scopes phones to 조회·대시보드·결재, not voucher entry. */
function desktopEntryOnly() {
  test.skip(test.info().project.name === 'mobile', 'UIX-06: 전표 입력은 데스크톱 범위');
}

async function fillJournalLine(page: Page, row: number, account: string, debit = '', credit = '') {
  const grid = page.getByRole('table').filter({ has: page.getByRole('columnheader', { name: '계정과목' }) });
  const tr = grid.locator('tbody tr').nth(row);
  await tr.locator('[data-col="0"]').fill(account);
  if (debit) await tr.locator('[data-col="1"]').fill(debit);
  if (credit) await tr.locator('[data-col="2"]').fill(credit);
}

test('ACC-02: 차대변이 맞아야 저장되고, 확정하면 원장에 반영된다', async ({ page }) => {
  desktopEntryOnly();
  const memo = `균형전표${Date.now().toString().slice(-6)}`;

  await page.goto('/accounting/journals');
  await page.getByRole('button', { name: '전표 등록' }).click();
  await page.getByLabel('적요', { exact: true }).fill(memo);

  await fillJournalLine(page, 0, '110 외상매출금', '660000');
  await fillJournalLine(page, 1, '401 상품매출', '', '600000');

  // the running總 tells the operator it is out of balance before they try to save
  await expect(page.getByText('차액 60,000')).toBeVisible();

  await page.getByRole('button', { name: '저장', exact: true }).click();
  const alert = page.getByRole('main').getByRole('alert');
  await expect(alert).toContainText('차액 60000원');

  // add the VAT line and it balances
  await page.getByRole('button', { name: '행 추가' }).click();
  await fillJournalLine(page, 2, '220 부가세예수금', '', '60000');
  await expect(page.getByText('차대변 일치')).toBeVisible();

  await page.getByRole('button', { name: '저장', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText('회계전표');
  // scoped to the header badge: '작성중' is also an option in the list screen's status filter
  await expect(page.getByRole('banner').or(page.locator('header')).getByText('작성중')).toBeVisible();

  await page.getByRole('button', { name: '확정', exact: true }).click();
  await expect(page.getByText('확정했습니다.')).toBeVisible();
  await expect(page.getByText('확정 전표는 수정할 수 없습니다.', { exact: false })).toBeVisible();
});

test('ACC-08 / INT-07: 확정 전표를 취소하면 역분개가 생기고 서로 연결된다', async ({ page }) => {
  desktopEntryOnly();
  const memo = `역분개시험${Date.now().toString().slice(-6)}`;

  await page.goto('/accounting/journals');
  await page.getByRole('button', { name: '전표 등록' }).click();
  await page.getByLabel('적요', { exact: true }).fill(memo);
  await fillJournalLine(page, 0, '110 외상매출금', '250000');
  await fillJournalLine(page, 1, '401 상품매출', '', '250000');
  await page.getByRole('button', { name: '저장', exact: true }).click();
  await page.getByRole('button', { name: '확정', exact: true }).click();
  await expect(page.getByText('확정했습니다.')).toBeVisible();

  await page.getByRole('button', { name: '전표 취소' }).click();
  await page.getByLabel('취소 사유').fill('거래 취소');
  await page.getByRole('button', { name: '취소 확정' }).click();
  await expect(page.getByText('역분개가 생성되었습니다.', { exact: false })).toBeVisible();

  // the original now points at its reversal, and following the link shows the mirror
  const link = page.getByRole('link', { name: /^JV-/ });
  await expect(link).toBeVisible();
  await link.click();
  await expect(page.getByText('의 역분개입니다.', { exact: false })).toBeVisible();
});

test('ACC-01: 표준 계정과목은 사용중지만 가능하다', async ({ page }) => {
  await page.goto('/accounting/accounts');
  await expect(page.getByRole('heading', { name: '계정과목', level: 1 })).toBeVisible();

  const row = page.locator('tbody tr', { hasText: '상품매출' }).first();
  await expect(row).toContainText('표준');
  await expect(row).toContainText('수익');

  // the mapped 매출 account is protected: deactivating it would break automatic posting
  await row.getByRole('button', { name: '사용중지' }).click();
  await expect(page.getByRole('main').getByRole('alert')).toContainText('계정 매핑에 사용 중');
});

test('ACC-03: 분개규칙 미리보기가 실제로 만들 분개를 보여준다', async ({ page }) => {
  await page.goto('/accounting/rules');
  await expect(page.getByRole('heading', { name: '분개규칙', level: 1 })).toBeVisible();

  // the mapping table resolves slots to real accounts
  await expect(page.getByRole('main')).toContainText('외상매출금');
  await expect(page.getByRole('main')).toContainText('부가세예수금');

  const preview = page.locator('section', { has: page.getByRole('heading', { name: '분개 미리보기' }) });
  await expect(preview).toContainText('1,000,000');
  await expect(preview).toContainText('100,000');
  await expect(preview).toContainText('일치');

  await page.getByLabel('규칙').selectOption('PURCHASE');
  await expect(preview).toContainText('부가세대급금');
});

test('ACC-04: 총계정원장에서 계정별원장과 원천전표로 이동한다', async ({ page }) => {
  desktopEntryOnly();
  await page.goto('/accounting/journals');
  await page.getByRole('button', { name: '전표 등록' }).click();
  await page.getByLabel('적요', { exact: true }).fill(`원장시험${Date.now().toString().slice(-6)}`);
  await fillJournalLine(page, 0, '110 외상매출금', '120000');
  await fillJournalLine(page, 1, '401 상품매출', '', '120000');
  await page.getByRole('button', { name: '저장', exact: true }).click();
  await page.getByRole('button', { name: '확정', exact: true }).click();
  await expect(page.getByText('확정했습니다.')).toBeVisible();

  await page.goto('/accounting/ledger');
  await page.getByRole('button', { name: '조회' }).click();
  await expect(page.getByRole('main')).toContainText('내부 관리용');

  // drilling from the trial balance into the account ledger, then into the entry
  await page.getByRole('button', { name: '외상매출금' }).first().click();
  await expect(page.getByRole('heading', { name: /계정별원장/ })).toBeVisible();
  await expect(page.getByRole('main')).toContainText('기초');

  await page.getByRole('link', { name: /^JV-/ }).first().click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText('회계전표');
});

test('ACC-05 / ACC-07: 손익계산서가 전월 비교와 부문별 손익을 함께 보여준다', async ({ page }) => {
  await page.goto('/accounting/income-statement');
  await expect(page.getByRole('heading', { name: '손익계산서', level: 1 })).toBeVisible();
  await expect(page.getByRole('main')).toContainText('내부 관리용');

  await page.getByRole('button', { name: '조회' }).click();
  await expect(page.getByRole('main')).toContainText('당기순이익');
  await expect(page.getByRole('main')).toContainText('비교월');

  const byDivision = page.locator('section', {
    has: page.getByRole('heading', { name: '부문별 손익 (ACC-07)' }),
  });
  await expect(byDivision).toContainText('전사 합계');
  await expect(byDivision).toContainText('부문 미지정');
});

test('ACC-06: 재무상태표가 차대 일치를 스스로 검증해 보여준다', async ({ page }) => {
  await page.goto('/accounting/balance-sheet');
  await expect(page.getByRole('heading', { name: '재무상태표', level: 1 })).toBeVisible();
  await expect(page.getByRole('main')).toContainText('내부 관리용');

  await page.getByRole('button', { name: '조회' }).click();
  const check = page.locator('section', { has: page.getByRole('heading', { name: '검증' }) });
  await expect(check).toContainText('자산');
  await expect(check).toContainText('당기순손익');
  await expect(check).toContainText('일치');
});

test('ACC-08 / B-01: 마감된 기간은 전표를 거부하고, 해제에는 사유가 필요하다', async ({ page }) => {
  desktopEntryOnly();
  // ADR-0006 constrains this from both sides: a month cannot close while an earlier month
  // with entries is open, and cannot reopen while a later month is closed. So the test uses
  // a month before any real data (nothing is dated 2019 here) and reopens it at the end, and
  // the block below repairs the state if an earlier run was interrupted before it could.
  const period = '2019-03';

  await page.goto('/accounting/close');
  await expect(page.getByRole('main')).toContainText('내부 관리용');

  // scoped to the period list: the closing-history card below lists the same period too
  const periodList = page.locator('section', { has: page.getByRole('heading', { name: '기간 목록' }) });
  // an earlier run may have left this month closed; reopen it so the test starts clean
  const existing = periodList.locator('li', { hasText: period });
  if ((await existing.getByRole('button', { name: '마감 해제' }).count()) > 0) {
    await page.getByLabel(`${period} 마감 해제 사유`).fill('시험 초기화');
    await existing.getByRole('button', { name: '마감 해제' }).click();
    await expect(page.getByText(`${period} 마감을 해제했습니다.`)).toBeVisible();
  }

  await page.getByLabel('마감 기간').fill(period);
  await page.getByRole('button', { name: '월 마감' }).click();
  await expect(page.getByText(`${period} 마감했습니다.`)).toBeVisible();

  // a voucher dated inside the closed month is refused
  await page.goto('/accounting/journals');
  await page.getByRole('button', { name: '전표 등록' }).click();
  await page.getByLabel('전표일').fill(`${period}-15`);
  await fillJournalLine(page, 0, '110 외상매출금', '1000');
  await fillJournalLine(page, 1, '401 상품매출', '', '1000');
  await page.getByRole('button', { name: '저장', exact: true }).click();
  await expect(page.getByRole('main').getByRole('alert')).toContainText('마감');

  // reopening needs a reason of at least five characters
  await page.goto('/accounting/close');
  const list = page.locator('section', { has: page.getByRole('heading', { name: '기간 목록' }) });
  const row = list.locator('li', { hasText: period });
  await expect(row).toContainText('마감');
  await page.getByLabel(`${period} 마감 해제 사유`).fill('전표 정정 필요');
  await row.getByRole('button', { name: '마감 해제' }).click();
  await expect(page.getByText(`${period} 마감을 해제했습니다.`)).toBeVisible();
  await expect(list.locator('li', { hasText: period })).toContainText('해제 사유: 전표 정정 필요');
});

test('ACC-08: 연 마감 미리보기가 대체 금액을 먼저 보여준다', async ({ page }) => {
  await page.goto('/accounting/close');
  await page.getByLabel('대상 연도').fill('2026');
  await page.getByRole('button', { name: '마감 미리보기' }).click();

  const card = page.locator('section', {
    has: page.getByRole('heading', { name: '연 마감 (손익대체·이월)' }),
  });
  await expect(card).toContainText('당기순손익');
  await expect(card).toContainText('이익잉여금');
});
