// covers: SLS-01, SLS-02, SLS-03, SLS-04, SLS-05, SLS-06, SLS-08, SLS-10, SLS-11, SLS-13
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

/** UIX-06 scopes phones to 조회·대시보드·결재; voucher entry is a desktop task. */
function desktopEntryOnly() {
  test.skip(test.info().project.name === 'mobile', 'UIX-06: 전표 입력은 데스크톱 범위');
}

/**
 * The create panel opens below the filter bar, and both legitimately label their partner
 * picker the same way. Scoping to the card is what a person does visually, so the tests
 * do the same rather than forcing artificial label text onto the UI.
 */
function form(page: Page, title: string) {
  return page.locator('section', { has: page.getByRole('heading', { name: title, level: 2 }) });
}

/** The trade grid shared by every sales/purchase form. */
async function fillTradeLine(page: Page, row: number, item: string, quantity: string, unitPrice: string) {
  const grid = page.getByRole('table').filter({ has: page.getByRole('columnheader', { name: '공급가액' }) });
  const tr = grid.locator('tbody tr').nth(row);
  await tr.locator('[data-col="0"]').fill(item);
  await tr.locator('[data-col="2"]').fill(quantity);
  await tr.locator('[data-col="3"]').fill(unitPrice);
}

/** Every run makes its own item and partner so accumulated data never shifts an assertion. */
async function createItem(page: Page, name: string) {
  await page.goto('/master/items');
  await page.getByRole('button', { name: '품목 등록' }).click();
  await page.getByLabel('품목명').fill(name);
  await page.getByRole('button', { name: '저장', exact: true }).click();
  await expect(page.getByRole('button', { name: '품목 등록' })).toBeVisible();
}

async function createPartner(page: Page, name: string) {
  await page.goto('/master/partners');
  await page.getByRole('button', { name: '거래처 등록' }).click();
  await page.getByLabel('거래처명').fill(name);
  await page.getByRole('button', { name: '저장', exact: true }).click();
  await expect(page.getByRole('button', { name: '거래처 등록' })).toBeVisible();
}

/** Stock the warehouse through a purchase, which is also the SLS-06 path. */
async function purchaseIn(page: Page, item: string, partner: string, qty: string, price: string) {
  await page.goto('/sales/purchase-documents');
  await page.getByRole('button', { name: '매입전표 등록' }).click();
  const card = form(page, '매입전표 등록');
  await card.getByLabel('매입처').selectOption({ label: partner });
  await card.getByLabel('입고창고').selectOption({ index: 1 });
  await fillTradeLine(page, 0, item, qty, price);
  await page.getByRole('button', { name: '저장', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText('매입전표');
  await page.getByRole('button', { name: '확정', exact: true }).click();
  await expect(page.getByText('미지급금·회계 분개가 함께 반영되었습니다.', { exact: false })).toBeVisible();
}

test('DEC-02: 라인별로 계산한 공급가액과 세액이 저장 전에 보인다', async ({ page }) => {
  desktopEntryOnly();
  const suffix = Date.now().toString().slice(-6);
  const item = `계산품${suffix}`;
  const partner = `계산상사${suffix}`;
  await createItem(page, item);
  await createPartner(page, partner);

  await page.goto('/sales/quotations');
  await page.getByRole('button', { name: '견적 등록' }).click();
  await form(page, '견적 등록').getByLabel('거래처').selectOption({ label: partner });

  // B-12: 3 x 1,333 taxable -> 3,999 / 399
  await fillTradeLine(page, 0, item, '3', '1333');
  const grid = page.getByRole('table').filter({ has: page.getByRole('columnheader', { name: '공급가액' }) });
  await expect(grid).toContainText('3,999');
  await expect(grid).toContainText('399');

  await page.getByRole('button', { name: '저장', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText('견적서');
  // the stored total matches what the grid showed
  await expect(page.getByRole('main')).toContainText('4,398');
});

test('SLS-02/SLS-03: 견적을 부분 전환하면 잔여수량이 남는다', async ({ page }) => {
  desktopEntryOnly();
  const suffix = Date.now().toString().slice(-6);
  const item = `전환품${suffix}`;
  const partner = `전환상사${suffix}`;
  await createItem(page, item);
  await createPartner(page, partner);

  await page.goto('/sales/quotations');
  await page.getByRole('button', { name: '견적 등록' }).click();
  await form(page, '견적 등록').getByLabel('거래처').selectOption({ label: partner });
  await fillTradeLine(page, 0, item, '10', '100000');
  await page.getByRole('button', { name: '저장', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText('견적서');

  await page.getByRole('button', { name: '주문으로 전환' }).click();
  await page.getByLabel(new RegExp(`${item}.*전환수량`)).fill('6');
  await page.getByRole('button', { name: '선택 수량으로 주문 생성' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText('주문서');
  await expect(page.getByRole('main')).toContainText('접수');

  // back on the quotation, 4 remain
  await page.goBack();
  await page.reload();
  const row = page.locator('tbody tr', { hasText: item });
  await expect(row).toContainText('6');
  await expect(row).toContainText('4');
});

test('SLS-04/E2E-01: 주문에서 출고하면 재고·미수·분개가 함께 생긴다', async ({ page }) => {
  desktopEntryOnly();
  const suffix = Date.now().toString().slice(-6);
  const item = `출고품${suffix}`;
  const partner = `출고상사${suffix}`;
  await createItem(page, item);
  await createPartner(page, partner);
  await purchaseIn(page, item, partner, '20', '40000');

  await page.goto('/sales/quotations');
  await page.getByRole('button', { name: '견적 등록' }).click();
  await form(page, '견적 등록').getByLabel('거래처').selectOption({ label: partner });
  await fillTradeLine(page, 0, item, '6', '100000');
  await page.getByRole('button', { name: '저장', exact: true }).click();
  await page.getByRole('button', { name: '주문으로 전환' }).click();
  await page.getByLabel(new RegExp(`${item}.*전환수량`)).fill('6');
  await page.getByRole('button', { name: '선택 수량으로 주문 생성' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText('주문서');

  await page.getByRole('button', { name: '매출전표 생성(출고)' }).click();
  await page.getByLabel('출고 창고').selectOption({ index: 1 });
  await page.getByLabel(new RegExp(`${item}.*출고수량`)).fill('6');
  await page.getByRole('button', { name: '매출전표 생성', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText('매출전표');

  await page.getByRole('button', { name: '확정', exact: true }).click();
  await expect(
    page.getByText('재고·미수금·회계 분개가 함께 반영되었습니다.', { exact: false }),
  ).toBeVisible();

  // the linked records card shows all three effects
  const linked = page.locator('section', { has: page.getByRole('heading', { name: '연결된 기록' }) });
  await expect(linked).toContainText('660,000');
  await expect(linked.getByRole('link', { name: /^JV-/ })).toBeVisible();

  // and the stock has moved
  await page.goto('/inventory/status');
  await page.getByLabel('검색어').fill(item);
  await page.getByRole('button', { name: '조회' }).click();
  await expect(page.locator('tbody tr', { hasText: item })).toContainText('14');
});

test('SLS-08/SLS-10: 수금이 오래된 미결부터 자동 배분된다', async ({ page }) => {
  desktopEntryOnly();
  const suffix = Date.now().toString().slice(-6);
  const item = `수금품${suffix}`;
  const partner = `수금상사${suffix}`;
  await createItem(page, item);
  await createPartner(page, partner);
  await purchaseIn(page, item, partner, '30', '10000');

  // two sales on different dates
  for (const [date, qty] of [
    ['2026-06-01', '5'],
    ['2026-06-15', '3'],
  ] as const) {
    await page.goto('/sales/sales-documents');
    await page.getByRole('button', { name: '매출전표 등록' }).click();
    const card = form(page, '매출전표 등록');
    await card.getByLabel('전표일').fill(date);
    await card.getByLabel('거래처').selectOption({ label: partner });
    await card.getByLabel('출고 창고').selectOption({ index: 1 });
    await fillTradeLine(page, 0, item, qty, '100000');
    await page.getByRole('button', { name: '저장', exact: true }).click();
    await page.getByRole('button', { name: '확정', exact: true }).click();
    await expect(
      page.getByText('재고·미수금·회계 분개가 함께 반영되었습니다.', { exact: false }),
    ).toBeVisible();
  }

  // the aging report shows what is owed
  await page.goto('/settlement/receivables');
  await page.getByLabel('거래처').selectOption({ label: partner });
  await page.getByRole('button', { name: '조회' }).click();
  await expect(page.locator('tbody tr', { hasText: partner })).toContainText('880,000');

  // a receipt of 700,000 clears the older invoice and part of the newer one
  await page.goto('/settlement/receipts');
  await page.getByRole('button', { name: '수금 등록' }).click();
  const receiptCard = form(page, '수금 등록');
  await receiptCard.getByLabel('거래처').selectOption({ label: partner });
  await receiptCard.getByLabel('금액').fill('700000');
  await page.getByRole('button', { name: '등록', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText('수금');

  await page.getByRole('button', { name: '자동 배분' }).click();
  await expect(page.getByText('오래된 미결부터 자동 배분했습니다.')).toBeVisible();

  const history = page.locator('section', { has: page.getByRole('heading', { name: '배분 이력' }) });
  await expect(history).toContainText('550,000');
  await expect(history).toContainText('150,000');
  await expect(history).toContainText('자동배분');

  await page.getByRole('button', { name: '확정', exact: true }).click();
  await expect(page.getByText('회계 분개가 생성되었습니다.', { exact: false })).toBeVisible();
});

test('SLS-11: 반품은 원 전표 수량을 넘을 수 없다', async ({ page }) => {
  desktopEntryOnly();
  const suffix = Date.now().toString().slice(-6);
  const item = `반품품${suffix}`;
  const partner = `반품상사${suffix}`;
  await createItem(page, item);
  await createPartner(page, partner);
  await purchaseIn(page, item, partner, '20', '40000');

  await page.goto('/sales/sales-documents');
  await page.getByRole('button', { name: '매출전표 등록' }).click();
  const salesCard = form(page, '매출전표 등록');
  await salesCard.getByLabel('거래처').selectOption({ label: partner });
  await salesCard.getByLabel('출고 창고').selectOption({ index: 1 });
  await fillTradeLine(page, 0, item, '5', '100000');
  await page.getByRole('button', { name: '저장', exact: true }).click();
  await page.getByRole('button', { name: '확정', exact: true }).click();
  await expect(
    page.getByText('재고·미수금·회계 분개가 함께 반영되었습니다.', { exact: false }),
  ).toBeVisible();

  await page.getByRole('button', { name: '반품 등록' }).click();
  await expect(page.getByRole('heading', { name: '반품', level: 1 })).toBeVisible();

  // more than was sold is refused, with the allowable quantity named
  await page.getByLabel(new RegExp(`${item}.*반품수량`)).fill('6');
  await page.getByRole('button', { name: '반품전표 생성' }).click();
  await expect(page.getByRole('main').getByRole('alert')).toContainText('반품 가능 수량');

  // within the sold quantity it works, and the return reverses the stock
  await page.getByLabel(new RegExp(`${item}.*반품수량`)).fill('2');
  await page.getByRole('button', { name: '반품전표 생성' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText('매출반품');
  await page.getByRole('button', { name: '확정', exact: true }).click();
  await expect(
    page.getByText('재고·미수금·회계 분개가 함께 반영되었습니다.', { exact: false }),
  ).toBeVisible();

  await page.goto('/inventory/status');
  await page.getByLabel('검색어').fill(item);
  await page.getByRole('button', { name: '조회' }).click();
  await expect(page.locator('tbody tr', { hasText: item })).toContainText('17');
});

test('SLS-13: 승인 전 구매요청은 발주할 수 없다', async ({ page }) => {
  desktopEntryOnly();
  const suffix = Date.now().toString().slice(-6);
  const item = `요청품${suffix}`;
  await createItem(page, item);

  await page.goto('/sales/purchase-requests');
  await page.getByRole('button', { name: '구매요청 등록' }).click();
  await fillTradeLine(page, 0, item, '100', '5000');
  await page.getByRole('button', { name: '저장', exact: true }).click();

  await expect(page.getByRole('heading', { level: 1 })).toContainText('구매요청');
  await expect(page.getByText('결재 승인 후에만 발주할 수 있습니다.', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: '발주서 생성' })).toBeDisabled();
});

test('E2E-04: 확정 매출을 취소하면 재고·채권·분개가 함께 원복된다', async ({ page }) => {
  desktopEntryOnly();
  const suffix = Date.now().toString().slice(-6);
  const item = `취소품${suffix}`;
  const partner = `취소상사${suffix}`;
  await createItem(page, item);
  await createPartner(page, partner);
  await purchaseIn(page, item, partner, '20', '40000');

  await page.goto('/sales/sales-documents');
  await page.getByRole('button', { name: '매출전표 등록' }).click();
  const salesCard = form(page, '매출전표 등록');
  await salesCard.getByLabel('거래처').selectOption({ label: partner });
  await salesCard.getByLabel('출고 창고').selectOption({ index: 1 });
  await fillTradeLine(page, 0, item, '6', '100000');
  await page.getByRole('button', { name: '저장', exact: true }).click();
  await page.getByRole('button', { name: '확정', exact: true }).click();
  await expect(
    page.getByText('재고·미수금·회계 분개가 함께 반영되었습니다.', { exact: false }),
  ).toBeVisible();

  await page.getByRole('button', { name: '전표 취소' }).click();
  await page.getByLabel('취소 사유').fill('거래 취소');
  await page.getByRole('button', { name: '취소 확정' }).click();
  await expect(
    page.getByText('재고 반대원장·채권 원복·회계 역분개가 생성되었습니다.', { exact: false }),
  ).toBeVisible();

  await page.goto('/inventory/status');
  await page.getByLabel('검색어').fill(item);
  await page.getByRole('button', { name: '조회' }).click();
  await expect(page.locator('tbody tr', { hasText: item })).toContainText('20');
});

test('SLS-08/SLS-09: 미수·미지급 화면이 잔액과 연령을 보여준다', async ({ page }) => {
  await page.goto('/settlement/receivables');
  await expect(page.getByRole('heading', { name: '미수금', level: 1 })).toBeVisible();
  await page.getByRole('button', { name: '조회' }).click();

  await page.goto('/settlement/payables');
  await expect(page.getByRole('heading', { name: '미지급금', level: 1 })).toBeVisible();
  await page.getByRole('button', { name: '조회' }).click();
  await expect(page.getByRole('main')).toContainText('미지급');
});
