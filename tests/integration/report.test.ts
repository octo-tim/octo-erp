// covers: RPT-01..RPT-10, INT-04, INT-12
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { actorFor, prepareDatabase, prisma, runTx, truncateBusinessData } from '../helpers/db';
import type { Actor } from '@/server/core/context';
import * as salesReport from '@/server/modules/report/sales-report';
import * as operations from '@/server/modules/report/operations-report';
import * as drilldown from '@/server/modules/report/drilldown';
import * as salesDocument from '@/server/modules/sales/sales-document';
import * as purchase from '@/server/modules/sales/purchase';
import * as item from '@/server/modules/master/item';
import * as partnerModule from '@/server/modules/master/partner';
import { buildActor } from '@/server/modules/auth/service';
import { hashPassword } from '@/server/core/crypto';

/**
 * Reports are read-only, so what can go wrong with them is not a crash but a wrong number
 * or a number the reader was not entitled to see. These tests therefore build a known set
 * of documents and assert the exact figures, and they check the scope rules from the point
 * of view of a user who can only see part of the company.
 */

let admin: Actor;
let scoped: Actor;
let warehouseA = '';
let warehouseB = '';
let divisionA = '';
let customerId = '';
let supplierId = '';
let itemA = '';
let itemB = '';

const PERIOD = { from: '2026-06-01', to: '2026-06-30' };

beforeAll(async () => {
  prepareDatabase();
  admin = await actorFor('admin');
  const warehouses = await prisma.warehouse.findMany({ orderBy: { code: 'asc' }, take: 2 });
  warehouseA = warehouses[0]!.id;
  warehouseB = warehouses[1]!.id;

  const salesRole = await prisma.role.findUniqueOrThrow({ where: { code: 'sales' } });
  await prisma.user.upsert({
    where: { username: 'rpt-scoped' },
    create: {
      username: 'rpt-scoped',
      displayName: '범위제한',
      passwordHash: await hashPassword('Report!12345'),
      roles: { create: [{ roleId: salesRole.id }] },
    },
    update: { isActive: true },
  });
});

beforeEach(async () => {
  await truncateBusinessData();
  await prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      "SettlementMatch", "Settlement", "Receivable", "Payable",
      "TaxDocumentOutput", "DocumentConversion",
      "SalesDocumentLine", "SalesDocument", "SalesOrderLine", "SalesOrder",
      "QuotationLine", "Quotation",
      "PurchaseDocumentLine", "PurchaseDocument", "PurchaseOrderLine", "PurchaseOrder",
      "PurchaseRequestLine", "PurchaseRequest"
    RESTART IDENTITY CASCADE`);
  await prisma.$executeRawUnsafe(`DELETE FROM "UserDivisionScope"`);
  await prisma.$executeRawUnsafe(`DELETE FROM "UserWarehouseScope"`);
  await prisma.$executeRawUnsafe(`UPDATE "Item" SET "defaultSupplierId" = NULL`);
  await prisma.$executeRawUnsafe(`DELETE FROM "PartnerContact"`);
  await prisma.$executeRawUnsafe(`DELETE FROM "Item"`);
  await prisma.$executeRawUnsafe(`DELETE FROM "Partner"`);

  const division = await prisma.division.findFirstOrThrow({ orderBy: { code: 'asc' } });
  divisionA = division.id;

  itemA = (await runTx(admin, (t) => item.create(t, { name: '보고서A', unitCode: 'EA' }))).id;
  itemB = (await runTx(admin, (t) => item.create(t, { name: '보고서B', unitCode: 'EA' }))).id;
  customerId = (
    await runTx(admin, (t) => partnerModule.create(t, { name: '보고상사', partnerType: 'CUSTOMER' }))
  ).id;
  supplierId = (
    await runTx(admin, (t) => partnerModule.create(t, { name: '보고공업', partnerType: 'SUPPLIER' }))
  ).id;

  // a user who may see only warehouse B, to prove the scope rules
  const user = await prisma.user.findUniqueOrThrow({ where: { username: 'rpt-scoped' } });
  await prisma.userWarehouseScope.create({ data: { userId: user.id, warehouseId: warehouseB } });
  scoped = await buildActor(prisma, user.id);
});

afterAll(() => prisma.$disconnect());

async function stockUp(itemId: string, qty: string, unitCost: string, warehouseId = warehouseA) {
  const doc = await runTx(admin, (t) =>
    purchase.createDocument(t, {
      docDate: '2026-06-01',
      partnerId: supplierId,
      warehouseId,
      lines: [{ itemId, quantity: qty, unitPrice: unitCost, taxType: 'TAXABLE' }],
    }),
  );
  await runTx(admin, (t) => purchase.confirmDocument(t, doc.id, doc.version));
  return doc;
}

async function sell(
  itemId: string,
  qty: string,
  price: string,
  docDate = '2026-06-10',
  warehouseId = warehouseA,
) {
  const doc = await runTx(admin, (t) =>
    salesDocument.create(t, {
      docDate,
      partnerId: customerId,
      warehouseId,
      divisionId: divisionA,
      lines: [{ itemId, quantity: qty, unitPrice: price, taxType: 'TAXABLE' }],
    }),
  );
  await runTx(admin, (t) => salesDocument.confirm(t, doc.id, doc.version));
  return doc;
}

describe('RPT-01 매출현황', () => {
  it('매출·원가·이익을 기간별로 집계한다', async () => {
    await stockUp(itemA, '100', '4000');
    await sell(itemA, '10', '10000', '2026-06-10');
    await sell(itemA, '5', '10000', '2026-07-10'); // outside the window

    const result = await runTx(admin, (t) => salesReport.salesTrend(t, PERIOD, 'MONTH'));

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]!.bucket).toBe('2026-06');
    expect(result.rows[0]!.supplyAmount).toBe('100000');
    expect(result.rows[0]!.costAmount).toBe('40000'); // 10 x 4,000, from the journal
    expect(result.rows[0]!.profitAmount).toBe('60000');
    expect(result.rows[0]!.marginRate).toBe('60');
    expect(result.totals.supplyAmount).toBe('100000');
  });

  it('반품은 매출을 줄인다: 별도 문서유형이지만 부호가 반대다', async () => {
    await stockUp(itemA, '100', '4000');
    const sale = await sell(itemA, '10', '10000');

    const doc = await runTx(admin, (t) =>
      salesDocument.create(t, {
        docType: 'RETURN_SALES',
        docDate: '2026-06-20',
        partnerId: customerId,
        warehouseId: warehouseA,
        divisionId: divisionA,
        originalId: sale.id,
        lines: [
          {
            itemId: itemA,
            quantity: '4',
            unitPrice: '10000',
            taxType: 'TAXABLE',
            originalLineId: sale.lines[0]!.id,
          },
        ],
      }),
    );
    await runTx(admin, (t) => salesDocument.confirm(t, doc.id, doc.version));

    const result = await runTx(admin, (t) => salesReport.salesTrend(t, PERIOD, 'MONTH'));
    expect(result.totals.supplyAmount).toBe('60000'); // 100,000 - 40,000
  });

  it('확정되지 않은 전표는 집계에 들어가지 않는다', async () => {
    await stockUp(itemA, '100', '4000');
    await runTx(admin, (t) =>
      salesDocument.create(t, {
        docDate: '2026-06-10',
        partnerId: customerId,
        warehouseId: warehouseA,
        lines: [{ itemId: itemA, quantity: '10', unitPrice: '10000', taxType: 'TAXABLE' }],
      }),
    );
    const result = await runTx(admin, (t) => salesReport.salesTrend(t, PERIOD, 'MONTH'));
    expect(result.rows).toHaveLength(0);
  });

  it('일 단위로도 나눈다', async () => {
    await stockUp(itemA, '100', '4000');
    await sell(itemA, '1', '10000', '2026-06-10');
    await sell(itemA, '2', '10000', '2026-06-11');

    const result = await runTx(admin, (t) => salesReport.salesTrend(t, PERIOD, 'DAY'));
    expect(result.rows.map((r) => r.bucket)).toEqual(['2026-06-10', '2026-06-11']);
  });
});

describe('RPT-02 품목순위', () => {
  it('금액 순으로 매기고 기여도를 표시한다', async () => {
    await stockUp(itemA, '100', '4000');
    await stockUp(itemB, '100', '1000');
    await sell(itemA, '10', '10000');
    await sell(itemB, '10', '2500');

    const result = await runTx(admin, (t) => salesReport.itemRanking(t, PERIOD, { top: 10 }));
    expect(result.rows.map((r) => r.name)).toEqual(['보고서A', '보고서B']);
    expect(result.rows[0]!.supplyAmount).toBe('100000');
    expect(result.rows[0]!.share).toBe('80'); // 100,000 of 125,000
    expect(result.totalAmount).toBe('125000');
  });

  it('수량 기준으로 바꾸면 순위가 바뀐다', async () => {
    await stockUp(itemA, '100', '4000');
    await stockUp(itemB, '100', '1000');
    await sell(itemA, '2', '50000');
    await sell(itemB, '40', '1000');

    const byAmount = await runTx(admin, (t) => salesReport.itemRanking(t, PERIOD, { by: 'AMOUNT' }));
    const byQuantity = await runTx(admin, (t) => salesReport.itemRanking(t, PERIOD, { by: 'QUANTITY' }));
    expect(byAmount.rows[0]!.name).toBe('보고서A');
    expect(byQuantity.rows[0]!.name).toBe('보고서B');
  });

  it('상위 N개만 돌려준다', async () => {
    await stockUp(itemA, '100', '4000');
    await stockUp(itemB, '100', '1000');
    await sell(itemA, '10', '10000');
    await sell(itemB, '10', '2500');

    const result = await runTx(admin, (t) => salesReport.itemRanking(t, PERIOD, { top: 1 }));
    expect(result.rows).toHaveLength(1);
  });
});

describe('RPT-03 거래처실적', () => {
  it('전년동기가 없으면 증감률을 만들어내지 않는다', async () => {
    await stockUp(itemA, '100', '4000');
    await sell(itemA, '10', '10000');

    const result = await runTx(admin, (t) => salesReport.partnerPerformance(t, PERIOD));
    const row = result.rows.find((r) => r.name === '보고상사');
    expect(row?.salesAmount).toBe('100000');
    expect(row?.priorSalesAmount).toBe('0');
    expect(row?.changeRate).toBe('-');
  });

  it('전년동기가 있으면 증감률을 계산한다', async () => {
    await stockUp(itemA, '200', '4000');
    await sell(itemA, '10', '10000', '2025-06-10');
    await sell(itemA, '15', '10000', '2026-06-10');

    const result = await runTx(admin, (t) => salesReport.partnerPerformance(t, PERIOD));
    const row = result.rows.find((r) => r.name === '보고상사');
    expect(row?.salesAmount).toBe('150000');
    expect(row?.priorSalesAmount).toBe('100000');
    expect(row?.changeRate).toBe('50');
  });

  it('매입만 있는 거래처도 목록에 나온다', async () => {
    await stockUp(itemA, '100', '4000');
    const result = await runTx(admin, (t) => salesReport.partnerPerformance(t, PERIOD));
    const row = result.rows.find((r) => r.name === '보고공업');
    expect(row?.purchaseAmount).toBe('400000');
    expect(row?.salesAmount).toBe('0');
  });
});

describe('RPT-04 재고현황', () => {
  it('창고별 수량과 금액을 원장에서 집계한다', async () => {
    await stockUp(itemA, '100', '4000', warehouseA);
    await stockUp(itemA, '50', '4000', warehouseB);

    const result = await runTx(admin, (t) => operations.stockStatus(t, PERIOD));
    expect(result.rows).toHaveLength(2);
    expect(result.totals.quantity).toBe('150.000');
    expect(result.totals.amount).toBe('600000');
  });

  it('안전재고 미달을 표시한다', async () => {
    await runTx(admin, (t) => item.update(t, itemA, { safetyStock: '200' }, 1));
    await stockUp(itemA, '100', '4000');

    const result = await runTx(admin, (t) => operations.stockStatus(t, PERIOD));
    expect(result.rows[0]!.belowSafety).toBe(true);
    expect(result.totals.belowSafety).toBe(1);
  });

  /** INT-12: the report is one more way to read data, so the scope applies to it too. */
  it('권한 범위 밖 창고의 재고는 보이지 않는다', async () => {
    await stockUp(itemA, '100', '4000', warehouseA);
    await stockUp(itemA, '50', '4000', warehouseB);

    const result = await runTx(scoped, (t) => operations.stockStatus(t, PERIOD));
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]!.warehouseId).toBe(warehouseB);
    expect(result.totals.quantity).toBe('50.000');
  });
});

describe('RPT-05 채권채무', () => {
  it('연령 구간별로 미수를 나눈다', async () => {
    await stockUp(itemA, '100', '4000');
    await sell(itemA, '10', '10000', '2026-06-10');

    // as of 2026-06-30 the receivable is 20 days old, so it is still current
    const result = await runTx(admin, (t) => operations.openItems(t, PERIOD, 'RECEIVABLE'));
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]!.current).toBe('110000');
    expect(result.rows[0]!.total).toBe('110000');
    expect(result.totals.total).toBe('110000');
  });

  it('오래된 미수는 초과 구간으로 간다', async () => {
    await stockUp(itemA, '100', '4000');
    await sell(itemA, '10', '10000', '2026-01-10');

    const result = await runTx(admin, (t) =>
      operations.openItems(t, { from: '2026-01-01', to: '2026-06-30' }, 'RECEIVABLE'),
    );
    expect(result.rows[0]!.over90).toBe('110000');
    expect(result.rows[0]!.current).toBe('0');
  });

  it('매입은 미지급으로 집계된다', async () => {
    await stockUp(itemA, '100', '4000');
    const result = await runTx(admin, (t) => operations.openItems(t, PERIOD, 'PAYABLE'));
    expect(result.totals.total).toBe('440000'); // 400,000 + 10% VAT
  });
});

describe('RPT-06 대시보드', () => {
  it('당월 매출·이익률·미수·재고금액을 한 번에 돌려준다', async () => {
    const now = new Date();
    const day = `${now.toISOString().slice(0, 8)}05`;
    await stockUp(itemA, '100', '4000');
    await sell(itemA, '10', '10000', day);

    const board = await runTx(admin, (t) => operations.dashboard(t));
    expect(board.monthlySales).toBe('100000');
    expect(board.marginRate).toBe('60');
    expect(Number(board.outstandingReceivable)).toBeGreaterThan(0);
    expect(Number(board.inventoryValue)).toBeGreaterThan(0);
  });

  it('매출이 없으면 이익률을 0으로 꾸미지 않는다', async () => {
    const board = await runTx(admin, (t) => operations.dashboard(t));
    expect(board.monthlySales).toBe('0');
    expect(board.marginRate).toBe('-');
  });
});

describe('RPT-08 드릴다운', () => {
  it('집계에서 원천 전표로 내려간다', async () => {
    await stockUp(itemA, '100', '4000');
    const sale = await sell(itemA, '10', '10000');

    const result = await runTx(admin, (t) => drilldown.drillDown(t, PERIOD, { target: 'SALES' }));
    expect(result.total).toBe(1);
    expect(result.rows[0]!.docNo).toBe(sale.docNo);
    expect(result.rows[0]!.href).toContain('/sales/sales-documents/');
  });

  it('품목을 지정하면 그 품목이 든 전표만 나온다', async () => {
    await stockUp(itemA, '100', '4000');
    await stockUp(itemB, '100', '1000');
    await sell(itemA, '10', '10000');
    await sell(itemB, '10', '2500');

    const result = await runTx(admin, (t) =>
      drilldown.drillDown(t, PERIOD, { target: 'SALES', itemId: itemA }),
    );
    expect(result.total).toBe(1);
  });

  /** the drill-down must not show documents the aggregate would not have counted */
  it('권한 범위 밖 창고의 전표로는 내려갈 수 없다', async () => {
    await stockUp(itemA, '100', '4000', warehouseA);
    await sell(itemA, '10', '10000', '2026-06-10', warehouseA);

    const result = await runTx(scoped, (t) => drilldown.drillDown(t, PERIOD, { target: 'SALES' }));
    expect(result.total).toBe(0);
  });

  it('미수 드릴다운은 남은 금액을 보여준다', async () => {
    await stockUp(itemA, '100', '4000');
    await sell(itemA, '10', '10000');

    const result = await runTx(admin, (t) => drilldown.drillDown(t, PERIOD, { target: 'RECEIVABLE' }));
    expect(result.rows[0]!.amount).toBe('110000');
  });
});

describe('RPT-09 결재현황', () => {
  it('상신이 없으면 빈 결과를 돌려준다', async () => {
    const result = await runTx(admin, (t) => operations.approvalStats(t, PERIOD));
    expect(result.rows).toHaveLength(0);
    expect(result.stale).toHaveLength(0);
  });
});

describe('RPT-10 근태·인원', () => {
  it('인사 권한이 없으면 거부한다', async () => {
    await expect(runTx(scoped, (t) => operations.workforceStats(t, PERIOD))).rejects.toThrow(/권한/);
  });

  it('관리자는 인원과 연차 사용률을 본다', async () => {
    const result = await runTx(admin, (t) => operations.workforceStats(t, PERIOD));
    expect(result.headcount.current).toBeGreaterThanOrEqual(0);
    expect(result.leave.usageRate).toBe('-'); // nothing granted, so no rate to show
  });
});
