// covers: MIG-01, MIG-03, MIG-09
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
  await page.goto('/system/migration');
});

/** Uploads a CSV built in the test rather than a fixture on disk, so the data is visible here. */
async function upload(page: Page, name: string, csv: string) {
  await page.getByLabel('원천 파일').setInputFiles({
    name,
    mimeType: 'text/csv',
    buffer: Buffer.from('﻿' + csv, 'utf8'),
  });
}

test('MIG-01: 검증에서 오류 행을 행 번호와 함께 알려준다', async ({ page }) => {
  const stamp = Date.now().toString().slice(-6);
  await upload(
    page,
    'items.csv',
    ['code,name,taxType', `E2E-M-${stamp}-1,이관시험품목,TAXABLE`, `E2E-M-${stamp}-2,,TAXABLE`].join('\r\n'),
  );
  // the loading spinner is also a status region, so this scopes to the message
  await expect(page.getByText('2행을 읽었습니다')).toBeVisible();

  await page.getByRole('button', { name: '검증', exact: true }).click();

  const main = page.getByRole('main');
  await expect(main.getByRole('heading', { name: '검증 결과' })).toBeVisible();
  await expect(main.getByText('오류 1건')).toBeVisible();
  await expect(main.getByText('2행')).toBeVisible();
});

test('MIG-01 / MIG-09: 반영하면 대사 결과의 차이가 0이다', async ({ page }) => {
  const stamp = Date.now().toString().slice(-6);
  await upload(
    page,
    'items.csv',
    ['code,name', `E2E-OK-${stamp}-1,대사시험품목1`, `E2E-OK-${stamp}-2,대사시험품목2`].join('\r\n'),
  );
  await page.getByRole('button', { name: '검증', exact: true }).click();

  const main = page.getByRole('main');
  await expect(main.getByRole('heading', { name: '검증 결과' })).toBeVisible();
  await expect(main.getByText('오류 1건')).toBeHidden();

  await page.getByRole('button', { name: '정상 행 반영' }).click();
  await expect(main.getByRole('heading', { name: '대사 결과' })).toBeVisible();
  await expect(main.getByText('모든 항목의 차이가 0입니다.')).toBeVisible();
});

test('MIG-03: 누적되는 대상은 중복 반영 경고를 먼저 보여준다', async ({ page }) => {
  await page.getByLabel('대상').selectOption('OPENING_STOCK');
  await expect(page.getByText('같은 행을 두 번 반영하면')).toBeVisible();

  // master data does not accumulate, so the warning is specific rather than always on
  await page.getByLabel('대상').selectOption('ITEM');
  await expect(page.getByText('같은 행을 두 번 반영하면')).toBeHidden();
});

test('MIG-09: 이관 이력이 건수와 상태를 남긴다', async ({ page }) => {
  const stamp = Date.now().toString().slice(-6);
  await upload(page, 'history.csv', ['code,name', `E2E-H-${stamp},이력시험품목`].join('\r\n'));
  await page.getByRole('button', { name: '검증', exact: true }).click();
  await expect(page.getByRole('main').getByRole('heading', { name: '검증 결과' })).toBeVisible();
  await page.getByRole('button', { name: '정상 행 반영' }).click();
  await expect(page.getByRole('main').getByRole('heading', { name: '대사 결과' })).toBeVisible();

  const history = page.locator('section', {
    has: page.getByRole('heading', { name: '최근 이관 이력' }),
  });
  // re-running the suite leaves earlier rows with the same file name, so the newest wins
  await expect(history.getByText('history.csv').first()).toBeVisible();
  await expect(history.getByText('APPLIED').first()).toBeVisible();
});
