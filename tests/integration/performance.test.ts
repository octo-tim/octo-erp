// covers: NFR-PERF-01, NFR-PERF-02, NFR-PERF-03
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { actorFor, prepareDatabase, prisma, runTx } from '../helpers/db';
import type { Actor } from '@/server/core/context';
import * as salesReport from '@/server/modules/report/sales-report';
import * as operations from '@/server/modules/report/operations-report';
import * as salesDocument from '@/server/modules/sales/sales-document';
import * as item from '@/server/modules/master/item';
import * as partnerModule from '@/server/modules/master/partner';
import * as purchase from '@/server/modules/sales/purchase';

/**
 * NFR-PERF-01/02/03, measured rather than asserted from intuition.
 *
 * The dataset is a year of documents with a realistic distribution — a few partners and
 * items carrying most of the value, most documents small and a few large, volume rising
 * towards month end — because a uniform dataset makes every index look good and hides the
 * queries that are actually slow.
 *
 * The thresholds here are the RFP's, and they are budgets rather than expectations: the
 * measured figures are printed so a regression shows up as a number moving, not only as a
 * test going red on the day it crosses the line. This runs on the same machine as the
 * database, so it measures query and service cost, not network latency.
 */

let admin: Actor;
const YEAR = { from: '2025-09-01', to: '2026-08-31' };

/** Measures once after a warm-up, so the first-call plan cost is not what gets reported. */
async function measure(label: string, fn: () => Promise<unknown>): Promise<number> {
  await fn();
  const started = performance.now();
  await fn();
  const ms = performance.now() - started;
  console.log(`    ${label}: ${ms.toFixed(0)}ms`);
  return ms;
}

beforeAll(async () => {
  prepareDatabase();
  admin = await actorFor('admin');

  const url = process.env['DATABASE_URL_TEST'] ?? '';
  // the fixture is idempotent, so a re-run measures the same shape of data
  execFileSync(
    'node',
    ['tools/seed-perf.mjs', '--reset', '--months', '12', '--per-day', '40', '--url', url],
    {
      stdio: 'pipe',
      env: { ...process.env, DATABASE_URL: url },
    },
  );
}, 300_000);

afterAll(() => prisma.$disconnect());

describe('NFR-PERF: 1년치 실데이터 분포에서 목표 시간 안에 끝난다', () => {
  it('데이터가 실제로 쌓여 있는지 먼저 확인한다', async () => {
    const docs = await prisma.salesDocument.count();
    const lines = await prisma.inventoryLedger.count();
    console.log(`    데이터: 매출전표 ${docs}건, 재고원장 ${lines}행`);
    expect(docs).toBeGreaterThan(10_000);
    expect(lines).toBeGreaterThan(10_000);
  });

  it('NFR-PERF-01: 1만 건 이상 목록 조회가 2초 이내', async () => {
    const ms = await measure('목록 조회', () =>
      runTx(admin, (t) => salesDocument.list(t, { skip: 0, take: 50 })),
    );
    expect(ms).toBeLessThan(2000);
  });

  it('NFR-PERF-01: 조건을 건 목록 조회도 2초 이내', async () => {
    const partner = await prisma.partner.findFirstOrThrow({ where: { code: { startsWith: 'PERFC' } } });
    const ms = await measure('조건 목록 조회', () =>
      runTx(admin, (t) =>
        salesDocument.list(t, {
          partnerId: partner.id,
          from: YEAR.from,
          to: YEAR.to,
          skip: 0,
          take: 50,
        }),
      ),
    );
    expect(ms).toBeLessThan(2000);
  });

  it('NFR-PERF-01: 마지막 페이지로 건너뛰어도 2초 이내', async () => {
    // deep paging is where an unindexed sort shows itself
    const ms = await measure('깊은 페이지', () =>
      runTx(admin, (t) => salesDocument.list(t, { skip: 10_000, take: 50 })),
    );
    expect(ms).toBeLessThan(2000);
  });

  it('NFR-PERF-03: 1년 매출현황 집계가 5초 이내', async () => {
    const ms = await measure('매출현황 1년 월별', () =>
      runTx(admin, (t) => salesReport.salesTrend(t, YEAR, 'MONTH')),
    );
    expect(ms).toBeLessThan(5000);
  });

  it('NFR-PERF-03: 일 단위 1년 집계도 5초 이내', async () => {
    const ms = await measure('매출현황 1년 일별', () =>
      runTx(admin, (t) => salesReport.salesTrend(t, YEAR, 'DAY')),
    );
    expect(ms).toBeLessThan(5000);
  });

  it('NFR-PERF-03: 품목순위 1년 집계가 5초 이내', async () => {
    const ms = await measure('품목순위 1년', () =>
      runTx(admin, (t) => salesReport.itemRanking(t, YEAR, { top: 50 })),
    );
    expect(ms).toBeLessThan(5000);
  });

  it('NFR-PERF-03: 거래처실적은 전년동기 비교까지 포함해 5초 이내', async () => {
    const ms = await measure('거래처실적 1년', () =>
      runTx(admin, (t) => salesReport.partnerPerformance(t, YEAR)),
    );
    expect(ms).toBeLessThan(5000);
  });

  it('NFR-PERF-03: 재고현황 집계가 5초 이내', async () => {
    const ms = await measure('재고현황', () => runTx(admin, (t) => operations.stockStatus(t, YEAR)));
    expect(ms).toBeLessThan(5000);
  });

  it('NFR-PERF-03: 대시보드가 5초 이내', async () => {
    const ms = await measure('대시보드', () => runTx(admin, (t) => operations.dashboard(t)));
    expect(ms).toBeLessThan(5000);
  });

  it('NFR-PERF-02: 전표 저장이 1초 이내', async () => {
    const warehouse = await prisma.warehouse.findFirstOrThrow({ orderBy: { code: 'asc' } });
    const partner = await prisma.partner.findFirstOrThrow({ where: { code: { startsWith: 'PERFC' } } });
    const items = await prisma.item.findMany({ where: { code: { startsWith: 'PERF-' } }, take: 5 });

    const ms = await measure('전표 저장 5행', () =>
      runTx(admin, (t) =>
        salesDocument.create(t, {
          docDate: '2026-08-20',
          partnerId: partner.id,
          warehouseId: warehouse.id,
          lines: items.map((i) => ({
            itemId: i.id,
            quantity: '3',
            unitPrice: '12000',
            taxType: 'TAXABLE',
          })),
        }),
      ),
    );
    expect(ms).toBeLessThan(1000);
  });

  it('NFR-PERF-02: 확정도 1초 이내 — 재고·채권·분개를 한 트랜잭션에서 처리한다', async () => {
    const warehouse = await prisma.warehouse.findFirstOrThrow({ orderBy: { code: 'asc' } });
    const partner = await prisma.partner.findFirstOrThrow({ where: { code: { startsWith: 'PERFC' } } });
    const supplier = await prisma.partner.findFirstOrThrow({ where: { code: { startsWith: 'PERFS' } } });
    const perfItem = await runTx(admin, (t) =>
      item.create(t, { name: `확정성능${Date.now()}`, unitCode: 'EA' }),
    );

    // stock it first, so the confirmation has something to issue
    const receipt = await runTx(admin, (t) =>
      purchase.createDocument(t, {
        docDate: '2026-08-01',
        partnerId: supplier.id,
        warehouseId: warehouse.id,
        lines: [{ itemId: perfItem.id, quantity: '500', unitPrice: '5000', taxType: 'TAXABLE' }],
      }),
    );
    await runTx(admin, (t) => purchase.confirmDocument(t, receipt.id, receipt.version));

    async function confirmOne() {
      const doc = await runTx(admin, (t) =>
        salesDocument.create(t, {
          docDate: '2026-08-20',
          partnerId: partner.id,
          warehouseId: warehouse.id,
          lines: [{ itemId: perfItem.id, quantity: '2', unitPrice: '12000', taxType: 'TAXABLE' }],
        }),
      );
      return runTx(admin, (t) => salesDocument.confirm(t, doc.id, doc.version));
    }

    const ms = await measure('전표 확정', confirmOne);
    expect(ms).toBeLessThan(1000);
  });

  it('마스터 검색이 500건 품목에서도 즉시 응답한다', async () => {
    const ms = await measure('품목 검색', () => runTx(admin, (t) => item.search(t, '성능시험', 20)));
    expect(ms).toBeLessThan(1000);
  });

  it('거래처 검색도 즉시 응답한다', async () => {
    const ms = await measure('거래처 검색', () =>
      runTx(admin, (t) => partnerModule.search(t, '성능', undefined, 20)),
    );
    expect(ms).toBeLessThan(1000);
  });
});
