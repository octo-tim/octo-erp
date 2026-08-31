// covers: SLS-01..SLS-13, E2E-01, E2E-02, E2E-04, INT-05, INT-06, INT-07, INT-12, B-01
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { actorFor, prepareDatabase, prisma, runTx, truncateBusinessData } from '../helpers/db';
import * as quotation from '@/server/modules/sales/quotation';
import * as salesOrder from '@/server/modules/sales/sales-order';
import * as salesDocument from '@/server/modules/sales/sales-document';
import * as purchase from '@/server/modules/sales/purchase';
import * as receivable from '@/server/modules/sales/receivable';
import * as settlement from '@/server/modules/sales/settlement';
import * as taxInvoice from '@/server/modules/sales/tax-invoice';
import * as item from '@/server/modules/master/item';
import * as partnerModule from '@/server/modules/master/partner';
import * as closing from '@/server/modules/accounting/closing';
import { withTransaction } from '@/server/core/context';
import type { Actor } from '@/server/core/context';
import { hashPassword } from '@/server/core/crypto';

let admin: Actor;
let warehouseId = '';
let customerId = '';
let supplierId = '';
let itemA = '';
let itemB = '';

beforeAll(async () => {
  prepareDatabase();
  admin = await actorFor('admin');
  const warehouse = await prisma.warehouse.findFirstOrThrow({ orderBy: { code: 'asc' } });
  warehouseId = warehouse.id;
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
  await prisma.$executeRawUnsafe(`UPDATE "Item" SET "defaultSupplierId" = NULL`);
  await prisma.$executeRawUnsafe(`DELETE FROM "PartnerContact"`);
  await prisma.$executeRawUnsafe(`DELETE FROM "Item"`);
  await prisma.$executeRawUnsafe(`DELETE FROM "Partner"`);

  itemA = (await runTx(admin, (t) => item.create(t, { name: 'A자재', unitCode: 'EA' }))).id;
  itemB = (await runTx(admin, (t) => item.create(t, { name: 'B자재', unitCode: 'EA' }))).id;
  customerId = (
    await runTx(admin, (t) => partnerModule.create(t, { name: '한빛상사', partnerType: 'CUSTOMER' }))
  ).id;
  supplierId = (
    await runTx(admin, (t) => partnerModule.create(t, { name: '대성공업', partnerType: 'SUPPLIER' }))
  ).id;
});

afterAll(() => prisma.$disconnect());

/** Stock the warehouse so a sale has something to issue. */
async function stockUp(itemId: string, qty: string, unitCost: string, docDate = '2026-06-01') {
  const doc = await runTx(admin, (t) =>
    purchase.createDocument(t, {
      docDate,
      partnerId: supplierId,
      warehouseId,
      lines: [{ itemId, quantity: qty, unitPrice: unitCost, taxType: 'TAXABLE' }],
    }),
  );
  await runTx(admin, (t) => purchase.confirmDocument(t, doc.id, doc.version));
  return doc;
}

async function onHand(itemId: string): Promise<string> {
  const sum = await prisma.inventoryLedger.aggregate({
    where: { itemId },
    _sum: { quantity: true },
  });
  return (sum._sum.quantity ?? 0).toString();
}

describe('E2E-01: 견적 → 주문 → 매출 → 확정 → 출고 → 분개 → 수금', () => {
  it('부분 전환과 잔여수량이 원천 라인별로 관리된다 (SLS-02)', async () => {
    const q = await runTx(admin, (t) =>
      quotation.create(t, {
        partnerId: customerId,
        docDate: '2026-06-01',
        lines: [{ itemId: itemA, quantity: '10', unitPrice: '100000', taxType: 'TAXABLE' }],
      }),
    );

    // convert 6 of 10
    const order = await runTx(admin, (t) =>
      quotation.convertToOrder(t, q.id, {
        lines: [{ sourceLineId: q.lines[0]!.id, quantity: '6' }],
      }),
    );
    expect(order.lines[0]!.quantity.toString()).toBe('6');

    const afterFirst = await runTx(admin, (t) => quotation.detail(t, q.id));
    expect(afterFirst.lines[0]!.remaining).toBe('4.000');
    expect(afterFirst.status).toBe('DRAFT'); // not fully converted yet

    // converting the remaining 4 completes the quotation
    await runTx(admin, (t) =>
      quotation.convertToOrder(t, q.id, { lines: [{ sourceLineId: q.lines[0]!.id, quantity: '4' }] }),
    );
    const afterSecond = await runTx(admin, (t) => quotation.detail(t, q.id));
    expect(afterSecond.lines[0]!.remaining).toBe('0.000');
    expect(afterSecond.status).toBe('CONVERTED');

    // and a third conversion has nothing left to take
    await expect(
      runTx(admin, (t) =>
        quotation.convertToOrder(t, q.id, { lines: [{ sourceLineId: q.lines[0]!.id, quantity: '1' }] }),
      ),
    ).rejects.toThrow(/잔여수량/);
  });

  it('동시 부분전환에서도 잔여수량을 초과하지 않는다', async () => {
    const q = await runTx(admin, (t) =>
      quotation.create(t, {
        partnerId: customerId,
        lines: [{ itemId: itemA, quantity: '10', unitPrice: '1000' }],
      }),
    );

    // two conversions of 6 against 10: exactly one can succeed
    const results = await Promise.allSettled([
      runTx(admin, (t) =>
        quotation.convertToOrder(t, q.id, { lines: [{ sourceLineId: q.lines[0]!.id, quantity: '6' }] }),
      ),
      runTx(admin, (t) =>
        quotation.convertToOrder(t, q.id, { lines: [{ sourceLineId: q.lines[0]!.id, quantity: '6' }] }),
      ),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);

    const detail = await runTx(admin, (t) => quotation.detail(t, q.id));
    expect(detail.lines[0]!.remaining).toBe('4.000');
  });

  it('확정 한 번에 재고·채권·분개·감사가 모두 생긴다 (INT-06)', async () => {
    await stockUp(itemA, '20', '40000');

    const order = await runTx(admin, (t) =>
      salesOrder.create(t, {
        partnerId: customerId,
        docDate: '2026-06-10',
        lines: [{ itemId: itemA, quantity: '6', unitPrice: '100000', taxType: 'TAXABLE' }],
      }),
    );

    const doc = await runTx(admin, (t) =>
      salesDocument.create(t, {
        docDate: '2026-06-10',
        partnerId: customerId,
        warehouseId,
        lines: [
          {
            itemId: itemA,
            quantity: '6',
            unitPrice: '100000',
            taxType: 'TAXABLE',
            sourceLineId: order.lines[0]!.id,
          },
        ],
      }),
    );
    expect(doc.supplyAmount.toString()).toBe('600000');
    expect(doc.vatAmount.toString()).toBe('60000');
    expect(doc.totalAmount.toString()).toBe('660000');

    await runTx(admin, (t) => salesDocument.confirm(t, doc.id, doc.version));

    // stock: 20 in, 6 out
    expect(await onHand(itemA)).toBe('14');
    const issue = await prisma.inventoryLedger.findFirstOrThrow({
      where: { sourceType: 'SALES', sourceId: doc.id },
    });
    expect(issue.quantity.toString()).toBe('-6');

    // receivable 660,000
    const rec = await prisma.receivable.findUniqueOrThrow({ where: { documentId: doc.id } });
    expect(rec.amount.toString()).toBe('660000');
    expect(rec.status).toBe('OPEN');

    // journal: 660,000 receivable + 240,000 COGS on the debit side
    const entry = await prisma.journalEntry.findFirstOrThrow({
      where: { sourceType: 'SALES', sourceId: doc.id },
      include: { lines: { include: { account: true } } },
    });
    const byCode = new Map(entry.lines.map((l) => [l.account.code, l]));
    expect(byCode.get('110')!.debit.toString()).toBe('660000');
    expect(byCode.get('401')!.credit.toString()).toBe('600000');
    expect(byCode.get('220')!.credit.toString()).toBe('60000');
    expect(byCode.get('501')!.debit.toString()).toBe('240000'); // 6 x 40,000
    expect(entry.totalDebit.toString()).toBe(entry.totalCredit.toString());

    // the order is now fully delivered
    const orderAfter = await runTx(admin, (t) => salesOrder.detail(t, order.id));
    expect(orderAfter.status).toBe('COMPLETED');
    expect(orderAfter.lines[0]!.remaining).toBe('0.000');
    expect(orderAfter.deliveries).toHaveLength(1);

    const log = await prisma.auditLog.findFirst({ where: { action: 'sales.confirm' } });
    expect(log).not.toBeNull();
  });

  it('수금이 오래된 미결부터 자동 배분되고 채권이 소진된다 (SLS-10)', async () => {
    await stockUp(itemA, '30', '10000');

    const first = await sale('2026-06-01', '5', '100000'); // 550,000
    const second = await sale('2026-06-15', '3', '100000'); // 330,000

    const receipt = await runTx(admin, (t) =>
      settlement.create(t, {
        docType: 'RECEIPT',
        docDate: '2026-06-20',
        partnerId: customerId,
        amount: '700000',
      }),
    );
    const result = await runTx(admin, (t) => settlement.autoAllocate(t, receipt.id));

    // oldest first: the whole 550,000 then 150,000 of the second
    expect(result.applied).toHaveLength(2);
    expect(result.applied[0]!.amount).toBe('550000');
    expect(result.applied[1]!.amount).toBe('150000');
    expect(result.unapplied).toBe('0');

    const firstRec = await prisma.receivable.findUniqueOrThrow({ where: { documentId: first.id } });
    expect(firstRec.status).toBe('SETTLED');
    const secondRec = await prisma.receivable.findUniqueOrThrow({ where: { documentId: second.id } });
    expect(secondRec.status).toBe('PARTIAL');
    expect(secondRec.settledAmount.toString()).toBe('150000');

    expect((await runTx(admin, (t) => receivable.outstandingOf(t, customerId))).toString()).toBe('180000');
  });

  it('수금 확정 시 수금 분개가 생긴다', async () => {
    await stockUp(itemA, '10', '10000');
    await sale('2026-06-01', '2', '100000');

    const receipt = await runTx(admin, (t) =>
      settlement.create(t, {
        docType: 'RECEIPT',
        docDate: '2026-06-20',
        partnerId: customerId,
        amount: '220000',
      }),
    );
    await runTx(admin, (t) => settlement.autoAllocate(t, receipt.id));
    const loaded = await prisma.settlement.findUniqueOrThrow({ where: { id: receipt.id } });
    await runTx(admin, (t) => settlement.confirm(t, receipt.id, loaded.version));

    const entry = await prisma.journalEntry.findFirstOrThrow({
      where: { sourceType: 'RECEIPT', sourceId: receipt.id },
      include: { lines: { include: { account: true } } },
    });
    const byCode = new Map(entry.lines.map((l) => [l.account.code, l]));
    expect(byCode.get('102')!.debit.toString()).toBe('220000');
    expect(byCode.get('110')!.credit.toString()).toBe('220000');
  });
});

/** A confirmed sale, used by several tests. */
async function sale(docDate: string, qty: string, price: string) {
  const doc = await runTx(admin, (t) =>
    salesDocument.create(t, {
      docDate,
      partnerId: customerId,
      warehouseId,
      lines: [{ itemId: itemA, quantity: qty, unitPrice: price, taxType: 'TAXABLE' }],
    }),
  );
  await runTx(admin, (t) => salesDocument.confirm(t, doc.id, doc.version));
  return doc;
}

describe('SLS-10: allocation limits', () => {
  it('미결 잔액을 초과해 배분할 수 없다', async () => {
    await stockUp(itemA, '10', '10000');
    const doc = await sale('2026-06-01', '1', '100000'); // 110,000
    const rec = await prisma.receivable.findUniqueOrThrow({ where: { documentId: doc.id } });

    const receipt = await runTx(admin, (t) =>
      settlement.create(t, { docType: 'RECEIPT', partnerId: customerId, amount: '500000' }),
    );
    await expect(
      runTx(admin, (t) =>
        settlement.reallocate(t, receipt.id, [{ targetId: rec.id, amount: '200000' }], '초과 시험'),
      ),
    ).rejects.toThrow(/잔액.*초과/);
  });

  it('수납액을 초과해 배분할 수 없다', async () => {
    await stockUp(itemA, '20', '10000');
    const a = await sale('2026-06-01', '1', '100000');
    const b = await sale('2026-06-02', '1', '100000');
    const recA = await prisma.receivable.findUniqueOrThrow({ where: { documentId: a.id } });
    const recB = await prisma.receivable.findUniqueOrThrow({ where: { documentId: b.id } });

    const receipt = await runTx(admin, (t) =>
      settlement.create(t, { docType: 'RECEIPT', partnerId: customerId, amount: '150000' }),
    );
    await expect(
      runTx(admin, (t) =>
        settlement.reallocate(
          t,
          receipt.id,
          [
            { targetId: recA.id, amount: '110000' },
            { targetId: recB.id, amount: '110000' },
          ],
          '초과 시험',
        ),
      ),
    ).rejects.toThrow(/수납액.*초과/);
  });

  it('동시 배분에서도 과배분되지 않는다', async () => {
    await stockUp(itemA, '10', '10000');
    const doc = await sale('2026-06-01', '1', '100000');
    const rec = await prisma.receivable.findUniqueOrThrow({ where: { documentId: doc.id } });

    const r1 = await runTx(admin, (t) =>
      settlement.create(t, { docType: 'RECEIPT', partnerId: customerId, amount: '110000' }),
    );
    const r2 = await runTx(admin, (t) =>
      settlement.create(t, { docType: 'RECEIPT', partnerId: customerId, amount: '110000' }),
    );

    const results = await Promise.allSettled([
      runTx(admin, (t) => settlement.reallocate(t, r1.id, [{ targetId: rec.id, amount: '110000' }], '동시1')),
      runTx(admin, (t) => settlement.reallocate(t, r2.id, [{ targetId: rec.id, amount: '110000' }], '동시2')),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);

    const after = await prisma.receivable.findUniqueOrThrow({ where: { id: rec.id } });
    expect(after.settledAmount.toString()).toBe('110000');
  });

  it('수동 재배분은 기존 배분을 되돌린 이력을 남긴다', async () => {
    await stockUp(itemA, '20', '10000');
    const a = await sale('2026-06-01', '1', '100000');
    const b = await sale('2026-06-02', '1', '100000');
    const recA = await prisma.receivable.findUniqueOrThrow({ where: { documentId: a.id } });
    const recB = await prisma.receivable.findUniqueOrThrow({ where: { documentId: b.id } });

    const receipt = await runTx(admin, (t) =>
      settlement.create(t, { docType: 'RECEIPT', partnerId: customerId, amount: '110000' }),
    );
    await runTx(admin, (t) => settlement.autoAllocate(t, receipt.id));
    expect(
      (await prisma.receivable.findUniqueOrThrow({ where: { id: recA.id } })).settledAmount.toString(),
    ).toBe('110000');

    // move the money to the second invoice instead
    await runTx(admin, (t) =>
      settlement.reallocate(t, receipt.id, [{ targetId: recB.id, amount: '110000' }], '거래처 요청'),
    );

    expect(
      (await prisma.receivable.findUniqueOrThrow({ where: { id: recA.id } })).settledAmount.toString(),
    ).toBe('0');
    expect(
      (await prisma.receivable.findUniqueOrThrow({ where: { id: recB.id } })).settledAmount.toString(),
    ).toBe('110000');

    // the history shows all three steps rather than a single edited number
    const matches = await prisma.settlementMatch.findMany({
      where: { settlementId: receipt.id },
      orderBy: { createdAt: 'asc' },
    });
    expect(matches.map((m) => m.origin)).toEqual(['AUTO', 'REVERSAL', 'MANUAL']);
  });
});

describe('E2E-02: 구매요청 → 발주 → 입고·매입 → 분개 → 지급', () => {
  it('승인된 구매요청만 발주할 수 있고 부분 발주가 가능하다 (SLS-13)', async () => {
    const request = await runTx(admin, (t) =>
      purchase.createRequest(t, {
        docDate: '2026-06-01',
        lines: [{ itemId: itemB, quantity: '100', unitPrice: '5000', taxType: 'TAXABLE' }],
      }),
    );

    await expect(
      runTx(admin, (t) =>
        purchase.convertRequestToOrder(t, request.id, {
          partnerId: supplierId,
          lines: [{ sourceLineId: request.lines[0]!.id, quantity: '60' }],
        }),
      ),
    ).rejects.toThrow(/승인된 구매요청만/);

    await runTx(admin, (t) => purchase.markRequestApproved(t, request.id));

    const order = await runTx(admin, (t) =>
      purchase.convertRequestToOrder(t, request.id, {
        partnerId: supplierId,
        lines: [{ sourceLineId: request.lines[0]!.id, quantity: '60' }],
      }),
    );
    expect(order.status).toBe('ORDERED');

    const afterPartial = await runTx(admin, (t) => purchase.requestDetail(t, request.id));
    expect(afterPartial.lines[0]!.remaining).toBe('40.000');
    expect(afterPartial.status).toBe('APPROVED');

    await runTx(admin, (t) =>
      purchase.convertRequestToOrder(t, request.id, {
        partnerId: supplierId,
        lines: [{ sourceLineId: request.lines[0]!.id, quantity: '40' }],
      }),
    );
    const afterFull = await runTx(admin, (t) => purchase.requestDetail(t, request.id));
    expect(afterFull.status).toBe('ORDERED');
    expect(afterFull.lines[0]!.remaining).toBe('0.000');
  });

  it('매입 확정 시 재고가 매입단가로 들어오고 채무와 분개가 생긴다', async () => {
    const request = await runTx(admin, (t) =>
      purchase.createRequest(t, {
        docDate: '2026-06-01',
        lines: [{ itemId: itemB, quantity: '60', unitPrice: '5000', taxType: 'TAXABLE' }],
      }),
    );
    await runTx(admin, (t) => purchase.markRequestApproved(t, request.id));
    const order = await runTx(admin, (t) =>
      purchase.convertRequestToOrder(t, request.id, {
        partnerId: supplierId,
        lines: [{ sourceLineId: request.lines[0]!.id, quantity: '60' }],
      }),
    );

    const doc = await runTx(admin, (t) =>
      purchase.createDocument(t, {
        docDate: '2026-06-05',
        partnerId: supplierId,
        warehouseId,
        lines: [
          {
            itemId: itemB,
            quantity: '60',
            unitPrice: '5000',
            taxType: 'TAXABLE',
            sourceLineId: order.lines[0]!.id,
          },
        ],
      }),
    );
    expect(doc.totalAmount.toString()).toBe('330000');

    await runTx(admin, (t) => purchase.confirmDocument(t, doc.id, doc.version));

    // E2E-02: ledger B/W1 +60 at unitCost 5,000
    const row = await prisma.inventoryLedger.findFirstOrThrow({
      where: { sourceType: 'PURCHASE', sourceId: doc.id },
    });
    expect(row.quantity.toString()).toBe('60');
    expect(row.unitCost!.toString()).toBe('5000');
    expect(row.amount.toString()).toBe('300000');

    const payable = await prisma.payable.findUniqueOrThrow({ where: { documentId: doc.id } });
    expect(payable.amount.toString()).toBe('330000');

    const entry = await prisma.journalEntry.findFirstOrThrow({
      where: { sourceType: 'PURCHASE', sourceId: doc.id },
      include: { lines: { include: { account: true } } },
    });
    const byCode = new Map(entry.lines.map((l) => [l.account.code, l]));
    expect(byCode.get('150')!.debit.toString()).toBe('300000');
    expect(byCode.get('120')!.debit.toString()).toBe('30000');
    expect(byCode.get('210')!.credit.toString()).toBe('330000');

    const orderAfter = await runTx(admin, (t) => purchase.orderDetail(t, order.id));
    expect(orderAfter.status).toBe('COMPLETED');
  });

  it('지급이 채무를 소진하고 지급 분개가 생긴다', async () => {
    const doc = await stockUp(itemB, '60', '5000', '2026-06-05');
    const payment = await runTx(admin, (t) =>
      settlement.create(t, {
        docType: 'PAYMENT',
        docDate: '2026-06-25',
        partnerId: supplierId,
        amount: '330000',
      }),
    );
    await runTx(admin, (t) => settlement.autoAllocate(t, payment.id));
    const loaded = await prisma.settlement.findUniqueOrThrow({ where: { id: payment.id } });
    await runTx(admin, (t) => settlement.confirm(t, payment.id, loaded.version));

    const payable = await prisma.payable.findUniqueOrThrow({ where: { documentId: doc.id } });
    expect(payable.status).toBe('SETTLED');

    const entry = await prisma.journalEntry.findFirstOrThrow({
      where: { sourceType: 'PAYMENT', sourceId: payment.id },
      include: { lines: { include: { account: true } } },
    });
    const byCode = new Map(entry.lines.map((l) => [l.account.code, l]));
    expect(byCode.get('210')!.debit.toString()).toBe('330000');
    expect(byCode.get('102')!.credit.toString()).toBe('330000');
  });
});

describe('E2E-04 / INT-07: 확정 전표 취소', () => {
  it('재고 반대원장·채권 원복·회계 역분개가 한 트랜잭션에서 생긴다', async () => {
    await stockUp(itemA, '20', '40000');
    const doc = await sale('2026-06-10', '6', '100000');
    expect(await onHand(itemA)).toBe('14');

    const confirmed = await prisma.salesDocument.findUniqueOrThrow({ where: { id: doc.id } });
    await runTx(admin, (t) => salesDocument.cancel(t, doc.id, '거래 취소', confirmed.version));

    // stock returns, with both rows kept
    expect(await onHand(itemA)).toBe('20');
    const rows = await prisma.inventoryLedger.findMany({
      where: { sourceType: 'SALES', sourceId: doc.id },
      orderBy: { sourceVersion: 'asc' },
    });
    expect(rows).toHaveLength(2);
    expect(rows[1]!.quantity.toString()).toBe('6');

    // receivable is zeroed
    const rec = await prisma.receivable.findUniqueOrThrow({ where: { documentId: doc.id } });
    expect(rec.status).toBe('CANCELED');
    expect((await runTx(admin, (t) => receivable.outstandingOf(t, customerId))).toString()).toBe('0');

    // journal has a reversal pointing at the original
    const entries = await prisma.journalEntry.findMany({
      where: { sourceType: 'SALES', sourceId: doc.id },
      orderBy: { sourceVersion: 'asc' },
    });
    expect(entries).toHaveLength(2);
    expect(entries[0]!.status).toBe('CANCELED');
    expect(entries[1]!.reversalOfId).toBe(entries[0]!.id);
  });

  it('수금된 전표는 취소를 거부하고 이유를 알려준다', async () => {
    await stockUp(itemA, '10', '10000');
    const doc = await sale('2026-06-01', '2', '100000');
    const rec = await prisma.receivable.findUniqueOrThrow({ where: { documentId: doc.id } });

    const receipt = await runTx(admin, (t) =>
      settlement.create(t, { docType: 'RECEIPT', partnerId: customerId, amount: '100000' }),
    );
    await runTx(admin, (t) =>
      settlement.reallocate(t, receipt.id, [{ targetId: rec.id, amount: '100000' }], '부분수금'),
    );

    const confirmed = await prisma.salesDocument.findUniqueOrThrow({ where: { id: doc.id } });
    await expect(
      runTx(admin, (t) => salesDocument.cancel(t, doc.id, '취소 시도', confirmed.version)),
    ).rejects.toThrow(/수금된 전표/);
  });

  it('취소하면 주문의 잔여수량이 돌아온다', async () => {
    await stockUp(itemA, '20', '10000');
    const order = await runTx(admin, (t) =>
      salesOrder.create(t, {
        partnerId: customerId,
        lines: [{ itemId: itemA, quantity: '10', unitPrice: '1000' }],
      }),
    );
    const doc = await runTx(admin, (t) =>
      salesDocument.create(t, {
        partnerId: customerId,
        warehouseId,
        lines: [{ itemId: itemA, quantity: '10', unitPrice: '1000', sourceLineId: order.lines[0]!.id }],
      }),
    );
    await runTx(admin, (t) => salesDocument.confirm(t, doc.id, doc.version));
    expect((await runTx(admin, (t) => salesOrder.detail(t, order.id))).status).toBe('COMPLETED');

    const confirmed = await prisma.salesDocument.findUniqueOrThrow({ where: { id: doc.id } });
    await runTx(admin, (t) => salesDocument.cancel(t, doc.id, '출고 취소', confirmed.version));

    const after = await runTx(admin, (t) => salesOrder.detail(t, order.id));
    expect(after.lines[0]!.remaining).toBe('10.000');
    expect(after.status).toBe('ACCEPTED');
  });
});

describe('SLS-11: 반품은 음수 수량이 아니라 별도 문서유형이다', () => {
  it('매출반품이 재고를 되돌리고 채권을 줄이고 역방향 분개를 만든다', async () => {
    await stockUp(itemA, '20', '40000');
    const original = await sale('2026-06-10', '10', '100000'); // 1,100,000

    const ret = await runTx(admin, (t) =>
      salesDocument.create(t, {
        docType: 'RETURN_SALES',
        docDate: '2026-06-20',
        partnerId: customerId,
        warehouseId,
        originalId: original.id,
        lines: [
          {
            itemId: itemA,
            quantity: '3',
            unitPrice: '100000',
            taxType: 'TAXABLE',
            originalLineId: original.lines[0]!.id,
          },
        ],
      }),
    );
    expect(ret.docNo).toMatch(/^RS-/);
    await runTx(admin, (t) => salesDocument.confirm(t, ret.id, ret.version));

    // 20 - 10 + 3
    expect(await onHand(itemA)).toBe('13');

    // the original receivable is reduced, not a second one created
    const rec = await prisma.receivable.findUniqueOrThrow({ where: { documentId: original.id } });
    expect(rec.amount.toString()).toBe('770000'); // 1,100,000 - 330,000

    const entry = await prisma.journalEntry.findFirstOrThrow({
      where: { sourceType: 'RETURN_SALES', sourceId: ret.id },
      include: { lines: { include: { account: true } } },
    });
    const byCode = new Map(entry.lines.map((l) => [l.account.code, l]));
    expect(byCode.get('401')!.debit.toString()).toBe('300000'); // revenue reversed
    expect(byCode.get('110')!.credit.toString()).toBe('330000');
  });

  it('원 전표 수량을 초과하는 반품은 거부한다', async () => {
    await stockUp(itemA, '20', '10000');
    const original = await sale('2026-06-10', '5', '100000');

    await expect(
      runTx(admin, (t) =>
        salesDocument.create(t, {
          docType: 'RETURN_SALES',
          partnerId: customerId,
          warehouseId,
          originalId: original.id,
          lines: [
            {
              itemId: itemA,
              quantity: '6',
              unitPrice: '100000',
              originalLineId: original.lines[0]!.id,
            },
          ],
        }),
      ),
    ).rejects.toThrow(/반품 가능 수량/);
  });

  it('여러 번 나눠 반품해도 합계가 원 수량을 넘지 않는다', async () => {
    await stockUp(itemA, '20', '10000');
    const original = await sale('2026-06-10', '5', '100000');

    const makeReturn = (qty: string) =>
      runTx(admin, (t) =>
        salesDocument.create(t, {
          docType: 'RETURN_SALES',
          partnerId: customerId,
          warehouseId,
          originalId: original.id,
          lines: [
            { itemId: itemA, quantity: qty, unitPrice: '100000', originalLineId: original.lines[0]!.id },
          ],
        }),
      );

    await makeReturn('3');
    await expect(makeReturn('3')).rejects.toThrow(/반품 가능 수량 2/);
  });

  it('확정되지 않은 전표는 반품할 수 없다', async () => {
    const draft = await runTx(admin, (t) =>
      salesDocument.create(t, {
        partnerId: customerId,
        warehouseId,
        lines: [{ itemId: itemA, quantity: '1', unitPrice: '1000' }],
      }),
    );
    await expect(
      runTx(admin, (t) =>
        salesDocument.create(t, {
          docType: 'RETURN_SALES',
          partnerId: customerId,
          warehouseId,
          originalId: draft.id,
          lines: [{ itemId: itemA, quantity: '1', unitPrice: '1000', originalLineId: draft.lines[0]!.id }],
        }),
      ),
    ).rejects.toThrow(/확정된 매출전표만/);
  });
});

describe('SLS-08: 여신한도', () => {
  it('한도를 넘는 매출은 확정이 차단된다', async () => {
    await stockUp(itemA, '100', '10000');
    const partner = await prisma.partner.findUniqueOrThrow({ where: { id: customerId } });
    await runTx(admin, (t) =>
      partnerModule.update(t, customerId, { creditLimit: '500000' }, partner.version),
    );

    const doc = await runTx(admin, (t) =>
      salesDocument.create(t, {
        partnerId: customerId,
        warehouseId,
        lines: [{ itemId: itemA, quantity: '10', unitPrice: '100000', taxType: 'TAXABLE' }],
      }),
    );
    await expect(runTx(admin, (t) => salesDocument.confirm(t, doc.id, doc.version))).rejects.toThrow(
      /여신한도를 초과/,
    );
  });

  it('연령분석이 거래처별 구간으로 나뉜다', async () => {
    await stockUp(itemA, '50', '10000');
    await sale('2026-06-01', '1', '100000'); // recent
    await sale('2026-01-01', '2', '100000'); // long overdue

    const result = await runTx(admin, (t) => receivable.aging(t, { asOf: '2026-06-20' }));
    const row = result.rows.find((r) => r.partnerId === customerId)!;
    expect(row.buckets.CURRENT).toBe('110000');
    expect(row.buckets.OVER90).toBe('220000');
    expect(row.total).toBe('330000');
  });
});

describe('SLS-12 / B-01: 마감기간', () => {
  it('마감된 기간에는 매출전표를 만들 수 없다', async () => {
    await stockUp(itemA, '10', '10000', '2026-05-01');
    await runTx(admin, (t) => closing.closeMonth(t, '2026-05'));

    await expect(
      runTx(admin, (t) =>
        salesDocument.create(t, {
          docDate: '2026-05-20',
          partnerId: customerId,
          warehouseId,
          lines: [{ itemId: itemA, quantity: '1', unitPrice: '1000' }],
        }),
      ),
    ).rejects.toThrow(/마감/);
  });
});

describe('SLS-07: 세금계산서', () => {
  it('확정 전표만 발행되고, 국세청 전송본이 아님을 명시한다', async () => {
    await stockUp(itemA, '10', '10000');
    const draft = await runTx(admin, (t) =>
      salesDocument.create(t, {
        partnerId: customerId,
        warehouseId,
        lines: [{ itemId: itemA, quantity: '1', unitPrice: '100000', taxType: 'TAXABLE' }],
      }),
    );
    await expect(runTx(admin, (t) => taxInvoice.build(t, draft.id))).rejects.toThrow(/확정된 매출전표만/);

    await runTx(admin, (t) => salesDocument.confirm(t, draft.id, draft.version));
    const data = await runTx(admin, (t) => taxInvoice.build(t, draft.id));
    expect(data.supplyAmount).toBe('100,000');
    expect(data.vatAmount).toBe('10,000');
    expect(data.notice).toContain('전자세금계산서가 아닙니다');

    const html = taxInvoice.render(data);
    expect(html).toContain('세 금 계 산 서');
    expect(html).toContain('전자세금계산서가 아닙니다');
  });

  it('발행 이력이 남고 이메일은 아웃박스로 나간다', async () => {
    await stockUp(itemA, '10', '10000');
    const doc = await sale('2026-06-01', '1', '100000');

    await runTx(admin, (t) => taxInvoice.issue(t, doc.id, { email: 'buyer@example.com', send: true }));

    const outputs = await runTx(admin, (t) => taxInvoice.history(t, doc.id));
    expect(outputs).toHaveLength(1);
    expect(outputs[0]!.status).toBe('SENT');

    const outbox = await prisma.outboxEvent.findFirst({ where: { topic: 'email.send' } });
    expect(outbox).not.toBeNull();
  });
});

describe('INT-05 / INT-06: 멱등성과 트랜잭션', () => {
  it('같은 requestId로 확정을 두 번 호출해도 효과는 한 번이다', async () => {
    await stockUp(itemA, '10', '10000');
    const doc = await runTx(admin, (t) =>
      salesDocument.create(t, {
        partnerId: customerId,
        warehouseId,
        lines: [{ itemId: itemA, quantity: '2', unitPrice: '100000' }],
      }),
    );

    const rid = randomUUID();
    const first = await runTx(admin, (t) => salesDocument.confirm(t, doc.id, doc.version), rid);
    const second = await runTx(admin, (t) => salesDocument.confirm(t, doc.id, doc.version), rid);
    expect(second).toEqual(first);

    expect(await prisma.receivable.count({ where: { documentId: doc.id } })).toBe(1);
    expect(await prisma.journalEntry.count({ where: { sourceType: 'SALES', sourceId: doc.id } })).toBe(1);
    expect(await prisma.inventoryLedger.count({ where: { sourceType: 'SALES', sourceId: doc.id } })).toBe(1);
  });

  it('분개 단계에서 장애가 나면 재고와 채권도 남지 않는다 (B-08)', async () => {
    await stockUp(itemA, '10', '10000');
    const doc = await runTx(admin, (t) =>
      salesDocument.create(t, {
        partnerId: customerId,
        warehouseId,
        lines: [{ itemId: itemA, quantity: '2', unitPrice: '100000' }],
      }),
    );

    await expect(
      withTransaction(prisma, { actor: admin, requestId: randomUUID(), now: new Date() }, async (t) => {
        await salesDocument.confirm(t, doc.id, doc.version);
        throw new Error('주입된 장애');
      }),
    ).rejects.toThrow('주입된 장애');

    expect(await prisma.receivable.count({ where: { documentId: doc.id } })).toBe(0);
    expect(await prisma.inventoryLedger.count({ where: { sourceType: 'SALES', sourceId: doc.id } })).toBe(0);
    expect(await prisma.journalEntry.count({ where: { sourceType: 'SALES', sourceId: doc.id } })).toBe(0);
    expect((await prisma.salesDocument.findUniqueOrThrow({ where: { id: doc.id } })).status).toBe('DRAFT');
  });

  it('재고가 부족하면 매출 확정이 차단되고 아무것도 남지 않는다 (INV-06)', async () => {
    await stockUp(itemA, '2', '10000');
    const doc = await runTx(admin, (t) =>
      salesDocument.create(t, {
        partnerId: customerId,
        warehouseId,
        lines: [{ itemId: itemA, quantity: '5', unitPrice: '100000' }],
      }),
    );
    await expect(runTx(admin, (t) => salesDocument.confirm(t, doc.id, doc.version))).rejects.toThrow(
      /재고가 부족/,
    );
    expect(await prisma.receivable.count({ where: { documentId: doc.id } })).toBe(0);
  });
});

describe('SLS-01: 견적서', () => {
  it('복사하면 라인은 같고 상태는 새 초안이다', async () => {
    const q = await runTx(admin, (t) =>
      quotation.create(t, {
        partnerId: customerId,
        title: '6월 견적',
        lines: [
          { itemId: itemA, quantity: '3', unitPrice: '1333', taxType: 'TAXABLE' },
          { itemId: itemB, quantity: '1.5', unitPrice: '1001', taxType: 'EXEMPT' },
        ],
      }),
    );
    // B-12 figures
    expect(q.supplyAmount.toString()).toBe('5500');
    expect(q.vatAmount.toString()).toBe('399');
    expect(q.totalAmount.toString()).toBe('5899');

    const copy = await runTx(admin, (t) => quotation.copy(t, q.id));
    expect(copy.id).not.toBe(q.id);
    expect(copy.status).toBe('DRAFT');
    expect(copy.title).toBe('6월 견적 (복사)');
    expect(copy.totalAmount.toString()).toBe('5899');
  });

  it('전환된 견적서는 수정할 수 없다', async () => {
    const q = await runTx(admin, (t) =>
      quotation.create(t, {
        partnerId: customerId,
        lines: [{ itemId: itemA, quantity: '5', unitPrice: '1000' }],
      }),
    );
    await runTx(admin, (t) =>
      quotation.convertToOrder(t, q.id, { lines: [{ sourceLineId: q.lines[0]!.id, quantity: '2' }] }),
    );

    const loaded = await prisma.quotation.findUniqueOrThrow({ where: { id: q.id } });
    await expect(
      runTx(admin, (t) =>
        quotation.update(
          t,
          q.id,
          { partnerId: customerId, lines: [{ itemId: itemA, quantity: '9', unitPrice: '1000' }] },
          loaded.version,
        ),
      ),
    ).rejects.toThrow(/이미 주문으로 전환된/);
  });

  it('DRAFT 견적서를 수정하면 라인과 공급가액·세액이 새로 계산된다', async () => {
    const q = await runTx(admin, (t) =>
      quotation.create(t, {
        partnerId: customerId,
        title: '수정 전',
        lines: [{ itemId: itemA, quantity: '2', unitPrice: '10000', taxType: 'TAXABLE' }],
      }),
    );
    expect(q.supplyAmount.toString()).toBe('20000');
    expect(q.vatAmount.toString()).toBe('2000');

    const updated = await runTx(admin, (t) =>
      quotation.update(
        t,
        q.id,
        {
          partnerId: customerId,
          title: '수정 후',
          lines: [
            { itemId: itemA, quantity: '3', unitPrice: '10000', taxType: 'TAXABLE' },
            { itemId: itemB, quantity: '2', unitPrice: '5000', taxType: 'EXEMPT' },
          ],
        },
        q.version,
      ),
    );

    expect(updated.version).toBe(q.version + 1);
    expect(updated.title).toBe('수정 후');
    // 3 x 10,000 taxable (+10% vat) plus 2 x 5,000 exempt (no vat)
    expect(updated.supplyAmount.toString()).toBe('40000');
    expect(updated.vatAmount.toString()).toBe('3000');
    expect(updated.totalAmount.toString()).toBe('43000');

    const detail = await runTx(admin, (t) => quotation.detail(t, q.id));
    expect(detail.lines).toHaveLength(2);
    expect(detail.lines[0]!.quantity.toString()).toBe('3');
    expect(detail.lines[1]!.quantity.toString()).toBe('2');
  });

  it('오래된 버전으로 견적서를 수정하면 VERSION_CONFLICT로 거부된다', async () => {
    const q = await runTx(admin, (t) =>
      quotation.create(t, {
        partnerId: customerId,
        lines: [{ itemId: itemA, quantity: '1', unitPrice: '1000' }],
      }),
    );
    // someone else's edit lands first and bumps the version
    await runTx(admin, (t) =>
      quotation.update(
        t,
        q.id,
        { partnerId: customerId, lines: [{ itemId: itemA, quantity: '2', unitPrice: '1000' }] },
        q.version,
      ),
    );

    await expect(
      runTx(admin, (t) =>
        quotation.update(
          t,
          q.id,
          { partnerId: customerId, lines: [{ itemId: itemA, quantity: '5', unitPrice: '1000' }] },
          q.version, // stale: the real version is now q.version + 1
        ),
      ),
    ).rejects.toThrow(/다른 사용자에 의해 변경/);
  });

  /**
   * INT-03. The guard used to name CONVERTED and CANCELED only, so a quotation already
   * confirmed and sent to the customer could have its lines and totals rewritten in place —
   * the customer's copy and the stored copy would disagree with nothing recording that they
   * ever did. EXPIRED had the same hole.
   */
  it('확정·만료된 견적서는 수정할 수 없다', async () => {
    for (const status of ['CONFIRMED', 'EXPIRED'] as const) {
      const q = await runTx(admin, (t) =>
        quotation.create(t, {
          partnerId: customerId,
          lines: [{ itemId: itemA, quantity: '1', unitPrice: '1000' }],
        }),
      );
      await runTx(admin, (t) => quotation.setStatus(t, q.id, 'CONFIRMED', q.version));
      let current = await runTx(admin, (t) => quotation.detail(t, q.id));
      if (status === 'EXPIRED') {
        await runTx(admin, (t) => quotation.setStatus(t, q.id, 'EXPIRED', current.version));
        current = await runTx(admin, (t) => quotation.detail(t, q.id));
      }

      await expect(
        runTx(admin, (t) =>
          quotation.update(
            t,
            q.id,
            { partnerId: customerId, lines: [{ itemId: itemA, quantity: '99', unitPrice: '1' }] },
            current.version,
          ),
        ),
      ).rejects.toThrow(/수정할 수 없습니다/);

      // and the stored figures are untouched by the attempt
      const after = await runTx(admin, (t) => quotation.detail(t, q.id));
      expect(after.lines).toHaveLength(1);
      expect(after.lines[0]!.quantity.toString()).toBe('1');
      expect(after.totalAmount.toString()).toBe(current.totalAmount.toString());
    }
  });
});

describe('SLS-05: 매출전표 수정', () => {
  it('DRAFT 전표를 수정하면 라인과 합계가 새로 계산된다', async () => {
    await stockUp(itemA, '20', '10000');
    const doc = await runTx(admin, (t) =>
      salesDocument.create(t, {
        partnerId: customerId,
        warehouseId,
        lines: [{ itemId: itemA, quantity: '2', unitPrice: '50000', taxType: 'TAXABLE' }],
      }),
    );
    expect(doc.totalAmount.toString()).toBe('110000');

    const updated = await runTx(admin, (t) =>
      salesDocument.update(
        t,
        doc.id,
        {
          partnerId: customerId,
          warehouseId,
          lines: [{ itemId: itemA, quantity: '3', unitPrice: '50000', taxType: 'TAXABLE' }],
        },
        doc.version,
      ),
    );

    expect(updated.version).toBe(doc.version + 1);
    expect(updated.supplyAmount.toString()).toBe('150000');
    expect(updated.vatAmount.toString()).toBe('15000');
    expect(updated.totalAmount.toString()).toBe('165000');
    expect(updated.lines).toHaveLength(1);
    expect(updated.lines[0]!.quantity.toString()).toBe('3');
  });

  it('확정된 전표는 수정할 수 없다', async () => {
    await stockUp(itemA, '10', '10000');
    const doc = await sale('2026-06-01', '1', '50000');
    const confirmed = await prisma.salesDocument.findUniqueOrThrow({ where: { id: doc.id } });

    await expect(
      runTx(admin, (t) =>
        salesDocument.update(
          t,
          doc.id,
          {
            partnerId: customerId,
            warehouseId,
            lines: [{ itemId: itemA, quantity: '2', unitPrice: '50000' }],
          },
          confirmed.version,
        ),
      ),
    ).rejects.toThrow(/작성 중인 전표만/);
  });

  it('오래된 버전으로 수정하면 VERSION_CONFLICT로 거부된다', async () => {
    await stockUp(itemA, '10', '10000');
    const doc = await runTx(admin, (t) =>
      salesDocument.create(t, {
        partnerId: customerId,
        warehouseId,
        lines: [{ itemId: itemA, quantity: '1', unitPrice: '50000' }],
      }),
    );
    await runTx(admin, (t) =>
      salesDocument.update(
        t,
        doc.id,
        { partnerId: customerId, warehouseId, lines: [{ itemId: itemA, quantity: '2', unitPrice: '50000' }] },
        doc.version,
      ),
    );

    await expect(
      runTx(admin, (t) =>
        salesDocument.update(
          t,
          doc.id,
          {
            partnerId: customerId,
            warehouseId,
            lines: [{ itemId: itemA, quantity: '3', unitPrice: '50000' }],
          },
          doc.version, // stale: the real version is now doc.version + 1
        ),
      ),
    ).rejects.toThrow(/다른 사용자에 의해 변경/);
  });

  it('주문에서 만든 전표를 수정해도 원천 라인의 잔여수량이 이중 반영되지 않는다', async () => {
    await stockUp(itemA, '20', '10000');
    const order = await runTx(admin, (t) =>
      salesOrder.create(t, {
        partnerId: customerId,
        lines: [{ itemId: itemA, quantity: '10', unitPrice: '50000' }],
      }),
    );
    const doc = await runTx(admin, (t) =>
      salesDocument.create(t, {
        partnerId: customerId,
        warehouseId,
        lines: [{ itemId: itemA, quantity: '6', unitPrice: '50000', sourceLineId: order.lines[0]!.id }],
      }),
    );
    const afterCreate = await runTx(admin, (t) => salesOrder.detail(t, order.id));
    expect(afterCreate.lines[0]!.remaining).toBe('4.000');

    // correcting the quantity from 6 to 7 releases the old reservation before making a new one
    const updated = await runTx(admin, (t) =>
      salesDocument.update(
        t,
        doc.id,
        {
          partnerId: customerId,
          warehouseId,
          lines: [{ itemId: itemA, quantity: '7', unitPrice: '50000', sourceLineId: order.lines[0]!.id }],
        },
        doc.version,
      ),
    );

    const afterUpdate = await runTx(admin, (t) => salesOrder.detail(t, order.id));
    // 10 - 7, never 10 - 6 - 7: the first reservation must not still be counted
    expect(afterUpdate.lines[0]!.remaining).toBe('3.000');
    expect(afterUpdate.status).toBe('IN_PROGRESS');
    expect(updated.lines[0]!.quantity.toString()).toBe('7');

    // exactly one active reservation lives against this order line and document
    const active = await prisma.documentConversion.count({
      where: {
        sourceType: 'SALES_ORDER',
        sourceId: order.id,
        sourceLineId: order.lines[0]!.id,
        targetType: 'SALES',
        targetId: doc.id,
        canceledAt: null,
      },
    });
    expect(active).toBe(1);
  });
});

describe('UIX-03: server-side CSV export', () => {
  it('quotation.listCsv returns every matching row, not a page, and respects a filter', async () => {
    const other = await runTx(admin, (t) =>
      partnerModule.create(t, { name: '다른거래처', partnerType: 'CUSTOMER' }),
    );
    for (let i = 0; i < 12; i++) {
      await runTx(admin, (t) =>
        quotation.create(t, {
          partnerId: customerId,
          lines: [{ itemId: itemA, quantity: '1', unitPrice: '1000' }],
        }),
      );
    }
    for (let i = 0; i < 3; i++) {
      await runTx(admin, (t) =>
        quotation.create(t, {
          partnerId: other.id,
          lines: [{ itemId: itemA, quantity: '1', unitPrice: '1000' }],
        }),
      );
    }
    const all = await runTx(admin, (t) => quotation.listCsv(t, {}));
    expect(all.total).toBe(15);
    expect(all.rowCount).toBe(15);
    expect(all.truncated).toBe(false);
    expect(all.csv.trim().split('\r\n')).toHaveLength(16);
    expect(all.csv).toContain('견적번호');

    const filtered = await runTx(admin, (t) => quotation.listCsv(t, { partnerId: other.id }));
    expect(filtered.total).toBe(3);
  });

  it('salesOrder.listCsv returns every matching row and respects a filter', async () => {
    const other = await runTx(admin, (t) =>
      partnerModule.create(t, { name: '다른주문처', partnerType: 'CUSTOMER' }),
    );
    for (let i = 0; i < 8; i++) {
      await runTx(admin, (t) =>
        salesOrder.create(t, {
          partnerId: customerId,
          lines: [{ itemId: itemA, quantity: '1', unitPrice: '1000' }],
        }),
      );
    }
    await runTx(admin, (t) =>
      salesOrder.create(t, {
        partnerId: other.id,
        lines: [{ itemId: itemA, quantity: '1', unitPrice: '1000' }],
      }),
    );
    const all = await runTx(admin, (t) => salesOrder.listCsv(t, {}));
    expect(all.total).toBe(9);
    expect(all.csv.trim().split('\r\n')).toHaveLength(10);

    const filtered = await runTx(admin, (t) => salesOrder.listCsv(t, { partnerId: other.id }));
    expect(filtered.total).toBe(1);
  });

  it('salesDocument.listCsv respects a filter, and a division-scoped user does not see another division', async () => {
    const [divA, divB] = await prisma.division.findMany({ orderBy: { code: 'asc' }, take: 2 });
    await stockUp(itemA, '100', '1000');

    const docA = await runTx(admin, (t) =>
      salesDocument.create(t, {
        partnerId: customerId,
        warehouseId,
        divisionId: divA!.id,
        lines: [{ itemId: itemA, quantity: '1', unitPrice: '5000' }],
      }),
    );
    const docB = await runTx(admin, (t) =>
      salesDocument.create(t, {
        partnerId: customerId,
        warehouseId,
        divisionId: divB!.id,
        lines: [{ itemId: itemA, quantity: '1', unitPrice: '5000' }],
      }),
    );

    // filter: a search term that matches only docB's document number
    const byDocNo = await runTx(admin, (t) => salesDocument.listCsv(t, { q: docB.docNo }));
    expect(byDocNo.total).toBe(1);
    expect(byDocNo.csv).toContain(docB.docNo);
    expect(byDocNo.csv).not.toContain(docA.docNo);

    // scope: a user whose division scope is limited to divA must not see divB's document
    const viewerRole = await prisma.role.findUniqueOrThrow({ where: { code: 'viewer' } });
    const scopedUser = await prisma.user.upsert({
      where: { username: 'sales-div-scoped' },
      create: {
        username: 'sales-div-scoped',
        displayName: '사업부범위영업',
        passwordHash: await hashPassword('Scoped!123456'),
        roles: { create: [{ roleId: viewerRole.id }] },
        divisionScopes: { create: [{ divisionId: divA!.id }] },
      },
      update: { isActive: true },
    });
    const scoped = await actorFor('sales-div-scoped');
    const scopedExport = await runTx(scoped, (t) => salesDocument.listCsv(t, {}));
    expect(scopedExport.total).toBe(1);
    expect(scopedExport.csv).toContain(docA.docNo);
    expect(scopedExport.csv).not.toContain(docB.docNo);

    await prisma.userDivisionScope.deleteMany({ where: { userId: scopedUser.id } });
  });

  it('purchase.listRequestsCsv / listOrdersCsv / listDocumentsCsv return every matching row and respect a filter', async () => {
    // requests: one left DRAFT, one approved
    const draftReq = await runTx(admin, (t) =>
      purchase.createRequest(t, {
        lines: [{ itemId: itemA, quantity: '10', unitPrice: '1000', taxType: 'TAXABLE' }],
      }),
    );
    const approvedReq = await runTx(admin, (t) =>
      purchase.createRequest(t, {
        lines: [{ itemId: itemA, quantity: '20', unitPrice: '1000', taxType: 'TAXABLE' }],
      }),
    );
    await runTx(admin, (t) => purchase.markRequestApproved(t, approvedReq.id));

    const allRequests = await runTx(admin, (t) => purchase.listRequestsCsv(t, {}));
    expect(allRequests.total).toBe(2);
    expect(allRequests.csv).toContain('요청번호');

    const approvedOnly = await runTx(admin, (t) => purchase.listRequestsCsv(t, { status: 'APPROVED' }));
    expect(approvedOnly.total).toBe(1);
    expect(approvedOnly.csv).toContain(approvedReq.docNo);
    expect(approvedOnly.csv).not.toContain(draftReq.docNo);

    // orders: convert the approved request into an order
    const order = await runTx(admin, (t) =>
      purchase.convertRequestToOrder(t, approvedReq.id, {
        partnerId: supplierId,
        lines: [{ sourceLineId: approvedReq.lines[0]!.id, quantity: '20' }],
      }),
    );
    const allOrders = await runTx(admin, (t) => purchase.listOrdersCsv(t, {}));
    expect(allOrders.total).toBe(1);
    expect(allOrders.csv).toContain(order.docNo);

    const otherSupplier = await runTx(admin, (t) =>
      partnerModule.create(t, { name: '다른매입처', partnerType: 'SUPPLIER' }),
    );
    const noMatch = await runTx(admin, (t) => purchase.listOrdersCsv(t, { partnerId: otherSupplier.id }));
    expect(noMatch.total).toBe(0);

    // documents: two purchase documents, filtered by partner
    const doc1 = await runTx(admin, (t) =>
      purchase.createDocument(t, {
        partnerId: supplierId,
        warehouseId,
        lines: [{ itemId: itemA, quantity: '5', unitPrice: '1000', taxType: 'TAXABLE' }],
      }),
    );
    const otherSupplierDoc = await runTx(admin, (t) =>
      purchase.createDocument(t, {
        partnerId: otherSupplier.id,
        warehouseId,
        lines: [{ itemId: itemA, quantity: '5', unitPrice: '1000', taxType: 'TAXABLE' }],
      }),
    );
    const allDocs = await runTx(admin, (t) => purchase.listDocumentsCsv(t, {}));
    expect(allDocs.total).toBe(2);

    const supplierOnly = await runTx(admin, (t) => purchase.listDocumentsCsv(t, { partnerId: supplierId }));
    expect(supplierOnly.total).toBe(1);
    expect(supplierOnly.csv).toContain(doc1.docNo);
    expect(supplierOnly.csv).not.toContain(otherSupplierDoc.docNo);
  });
});

/**
 * INT-12: five list queries never applied division scope at all (quotation.list,
 * salesOrder.list, purchase.listRequests/listOrders/listDocuments), and salesDocument.list
 * applied it by spreading an `OR` key next to the keyword search's own `OR` key, so the
 * later key silently replaced the earlier one and a scoped user's keyword search came back
 * unfiltered. Each fixture set below has two documents in the scoped user's own division —
 * one that matches the search keyword and one that does not — so the collision case fails
 * loudly if the fix ever regresses to a spread: a dropped keyword filter would let the
 * non-matching same-division document leak into the results.
 */
describe('INT-12: 목록 조회에 사업부 범위가 적용된다', () => {
  let divA = '';
  let divB = '';
  let scoped: Actor;

  beforeAll(async () => {
    const divisions = await prisma.division.findMany({ orderBy: { code: 'asc' }, take: 2 });
    divA = divisions[0]!.id;
    divB = divisions[1]!.id;

    const viewerRole = await prisma.role.findUniqueOrThrow({ where: { code: 'viewer' } });
    await prisma.user.upsert({
      where: { username: 'int12-list-scoped' },
      create: {
        username: 'int12-list-scoped',
        displayName: '사업부범위조회자',
        passwordHash: await hashPassword('Scoped!123456'),
        roles: { create: [{ roleId: viewerRole.id }] },
        divisionScopes: { create: [{ divisionId: divA }] },
      },
      update: { isActive: true },
    });
    scoped = await actorFor('int12-list-scoped');
  });

  afterAll(async () => {
    const user = await prisma.user.findUnique({ where: { username: 'int12-list-scoped' } });
    if (user) await prisma.userDivisionScope.deleteMany({ where: { userId: user.id } });
  });

  it('quotation.list: 사업부 범위 밖 문서는 제외되고 미지정 문서는 포함되며 관리자는 전체를 본다', async () => {
    const a1 = await runTx(admin, (t) =>
      quotation.create(t, {
        partnerId: customerId,
        divisionId: divA,
        lines: [{ itemId: itemA, quantity: '1', unitPrice: '1000' }],
      }),
    );
    const a2 = await runTx(admin, (t) =>
      quotation.create(t, {
        partnerId: customerId,
        divisionId: divA,
        lines: [{ itemId: itemA, quantity: '1', unitPrice: '1000' }],
      }),
    );
    const b = await runTx(admin, (t) =>
      quotation.create(t, {
        partnerId: customerId,
        divisionId: divB,
        lines: [{ itemId: itemA, quantity: '1', unitPrice: '1000' }],
      }),
    );
    const n = await runTx(admin, (t) =>
      quotation.create(t, {
        partnerId: customerId,
        lines: [{ itemId: itemA, quantity: '1', unitPrice: '1000' }],
      }),
    );

    const scopedIds = (await runTx(scoped, (t) => quotation.list(t, { skip: 0, take: 50 }))).rows.map(
      (r) => r.id,
    );
    expect(scopedIds).toEqual(expect.arrayContaining([a1.id, a2.id, n.id]));
    expect(scopedIds).not.toContain(b.id);

    const adminIds = (await runTx(admin, (t) => quotation.list(t, { skip: 0, take: 50 }))).rows.map(
      (r) => r.id,
    );
    expect(adminIds).toEqual(expect.arrayContaining([a1.id, a2.id, b.id, n.id]));
  });

  it('quotation.list: 검색어와 사업부 범위가 함께(AND) 적용된다 — OR 충돌 회귀 방지', async () => {
    const a1 = await runTx(admin, (t) =>
      quotation.create(t, {
        partnerId: customerId,
        divisionId: divA,
        lines: [{ itemId: itemA, quantity: '1', unitPrice: '1000' }],
      }),
    );
    const a2 = await runTx(admin, (t) =>
      quotation.create(t, {
        partnerId: customerId,
        divisionId: divA,
        lines: [{ itemId: itemA, quantity: '1', unitPrice: '1000' }],
      }),
    );
    const b = await runTx(admin, (t) =>
      quotation.create(t, {
        partnerId: customerId,
        divisionId: divB,
        lines: [{ itemId: itemA, quantity: '1', unitPrice: '1000' }],
      }),
    );
    const n = await runTx(admin, (t) =>
      quotation.create(t, {
        partnerId: customerId,
        lines: [{ itemId: itemA, quantity: '1', unitPrice: '1000' }],
      }),
    );

    const ids = (await runTx(scoped, (t) => quotation.list(t, { q: a1.docNo, skip: 0, take: 50 }))).rows.map(
      (r) => r.id,
    );
    expect(ids).toEqual([a1.id]);
    expect(ids).not.toContain(a2.id); // same division, wrong keyword — must not leak back in
    expect(ids).not.toContain(b.id);
    expect(ids).not.toContain(n.id);
  });

  it('salesOrder.list: 사업부 범위 밖 문서는 제외되고 미지정 문서는 포함되며 관리자는 전체를 본다', async () => {
    const a1 = await runTx(admin, (t) =>
      salesOrder.create(t, {
        partnerId: customerId,
        divisionId: divA,
        lines: [{ itemId: itemA, quantity: '1', unitPrice: '1000' }],
      }),
    );
    const a2 = await runTx(admin, (t) =>
      salesOrder.create(t, {
        partnerId: customerId,
        divisionId: divA,
        lines: [{ itemId: itemA, quantity: '1', unitPrice: '1000' }],
      }),
    );
    const b = await runTx(admin, (t) =>
      salesOrder.create(t, {
        partnerId: customerId,
        divisionId: divB,
        lines: [{ itemId: itemA, quantity: '1', unitPrice: '1000' }],
      }),
    );
    const n = await runTx(admin, (t) =>
      salesOrder.create(t, {
        partnerId: customerId,
        lines: [{ itemId: itemA, quantity: '1', unitPrice: '1000' }],
      }),
    );

    const scopedIds = (await runTx(scoped, (t) => salesOrder.list(t, { skip: 0, take: 50 }))).rows.map(
      (r) => r.id,
    );
    expect(scopedIds).toEqual(expect.arrayContaining([a1.id, a2.id, n.id]));
    expect(scopedIds).not.toContain(b.id);

    const adminIds = (await runTx(admin, (t) => salesOrder.list(t, { skip: 0, take: 50 }))).rows.map(
      (r) => r.id,
    );
    expect(adminIds).toEqual(expect.arrayContaining([a1.id, a2.id, b.id, n.id]));
  });

  it('salesOrder.list: 검색어와 사업부 범위가 함께(AND) 적용된다 — OR 충돌 회귀 방지', async () => {
    const a1 = await runTx(admin, (t) =>
      salesOrder.create(t, {
        partnerId: customerId,
        divisionId: divA,
        lines: [{ itemId: itemA, quantity: '1', unitPrice: '1000' }],
      }),
    );
    const a2 = await runTx(admin, (t) =>
      salesOrder.create(t, {
        partnerId: customerId,
        divisionId: divA,
        lines: [{ itemId: itemA, quantity: '1', unitPrice: '1000' }],
      }),
    );
    const b = await runTx(admin, (t) =>
      salesOrder.create(t, {
        partnerId: customerId,
        divisionId: divB,
        lines: [{ itemId: itemA, quantity: '1', unitPrice: '1000' }],
      }),
    );
    const n = await runTx(admin, (t) =>
      salesOrder.create(t, {
        partnerId: customerId,
        lines: [{ itemId: itemA, quantity: '1', unitPrice: '1000' }],
      }),
    );

    const ids = (await runTx(scoped, (t) => salesOrder.list(t, { q: a1.docNo, skip: 0, take: 50 }))).rows.map(
      (r) => r.id,
    );
    expect(ids).toEqual([a1.id]);
    expect(ids).not.toContain(a2.id);
    expect(ids).not.toContain(b.id);
    expect(ids).not.toContain(n.id);
  });

  it('salesDocument.list: 사업부 범위 밖 문서는 제외되고 미지정 문서는 포함되며 관리자는 전체를 본다', async () => {
    const a1 = await runTx(admin, (t) =>
      salesDocument.create(t, {
        partnerId: customerId,
        warehouseId,
        divisionId: divA,
        docDate: '2026-06-01',
        lines: [{ itemId: itemA, quantity: '1', unitPrice: '1000' }],
      }),
    );
    const a2 = await runTx(admin, (t) =>
      salesDocument.create(t, {
        partnerId: customerId,
        warehouseId,
        divisionId: divA,
        docDate: '2026-06-01',
        lines: [{ itemId: itemA, quantity: '1', unitPrice: '1000' }],
      }),
    );
    const b = await runTx(admin, (t) =>
      salesDocument.create(t, {
        partnerId: customerId,
        warehouseId,
        divisionId: divB,
        docDate: '2026-06-01',
        lines: [{ itemId: itemA, quantity: '1', unitPrice: '1000' }],
      }),
    );
    const n = await runTx(admin, (t) =>
      salesDocument.create(t, {
        partnerId: customerId,
        warehouseId,
        docDate: '2026-06-01',
        lines: [{ itemId: itemA, quantity: '1', unitPrice: '1000' }],
      }),
    );

    const scopedIds = (await runTx(scoped, (t) => salesDocument.list(t, { skip: 0, take: 50 }))).rows.map(
      (r) => r.id,
    );
    expect(scopedIds).toEqual(expect.arrayContaining([a1.id, a2.id, n.id]));
    expect(scopedIds).not.toContain(b.id);

    const adminIds = (await runTx(admin, (t) => salesDocument.list(t, { skip: 0, take: 50 }))).rows.map(
      (r) => r.id,
    );
    expect(adminIds).toEqual(expect.arrayContaining([a1.id, a2.id, b.id, n.id]));
  });

  it('salesDocument.list: 검색어와 사업부 범위가 함께(AND) 적용된다 — OR 충돌 회귀 방지 (원 결함)', async () => {
    const a1 = await runTx(admin, (t) =>
      salesDocument.create(t, {
        partnerId: customerId,
        warehouseId,
        divisionId: divA,
        docDate: '2026-06-01',
        lines: [{ itemId: itemA, quantity: '1', unitPrice: '1000' }],
      }),
    );
    const a2 = await runTx(admin, (t) =>
      salesDocument.create(t, {
        partnerId: customerId,
        warehouseId,
        divisionId: divA,
        docDate: '2026-06-01',
        lines: [{ itemId: itemA, quantity: '1', unitPrice: '1000' }],
      }),
    );
    const b = await runTx(admin, (t) =>
      salesDocument.create(t, {
        partnerId: customerId,
        warehouseId,
        divisionId: divB,
        docDate: '2026-06-01',
        lines: [{ itemId: itemA, quantity: '1', unitPrice: '1000' }],
      }),
    );
    const n = await runTx(admin, (t) =>
      salesDocument.create(t, {
        partnerId: customerId,
        warehouseId,
        docDate: '2026-06-01',
        lines: [{ itemId: itemA, quantity: '1', unitPrice: '1000' }],
      }),
    );

    const ids = (
      await runTx(scoped, (t) => salesDocument.list(t, { q: a1.docNo, skip: 0, take: 50 }))
    ).rows.map((r) => r.id);
    expect(ids).toEqual([a1.id]);
    expect(ids).not.toContain(a2.id);
    expect(ids).not.toContain(b.id);
    expect(ids).not.toContain(n.id);
  });

  /** Builds a PurchaseRequest, approves it and converts it into a PurchaseOrder in one division. */
  async function purchaseOrderIn(divisionId?: string) {
    const req = await runTx(admin, (t) =>
      purchase.createRequest(t, {
        ...(divisionId ? { divisionId } : {}),
        lines: [{ itemId: itemA, quantity: '5', unitPrice: '1000', taxType: 'TAXABLE' }],
      }),
    );
    await runTx(admin, (t) => purchase.markRequestApproved(t, req.id));
    return runTx(admin, (t) =>
      purchase.convertRequestToOrder(t, req.id, {
        partnerId: supplierId,
        lines: [{ sourceLineId: req.lines[0]!.id, quantity: '5' }],
      }),
    );
  }

  it('purchase.listRequests: 사업부 범위 밖 문서는 제외되고 미지정 문서는 포함되며 관리자는 전체를 본다', async () => {
    const a1 = await runTx(admin, (t) =>
      purchase.createRequest(t, {
        divisionId: divA,
        lines: [{ itemId: itemA, quantity: '1', unitPrice: '1000', taxType: 'TAXABLE' }],
      }),
    );
    const a2 = await runTx(admin, (t) =>
      purchase.createRequest(t, {
        divisionId: divA,
        lines: [{ itemId: itemA, quantity: '1', unitPrice: '1000', taxType: 'TAXABLE' }],
      }),
    );
    const b = await runTx(admin, (t) =>
      purchase.createRequest(t, {
        divisionId: divB,
        lines: [{ itemId: itemA, quantity: '1', unitPrice: '1000', taxType: 'TAXABLE' }],
      }),
    );
    const n = await runTx(admin, (t) =>
      purchase.createRequest(t, {
        lines: [{ itemId: itemA, quantity: '1', unitPrice: '1000', taxType: 'TAXABLE' }],
      }),
    );

    const scopedIds = (await runTx(scoped, (t) => purchase.listRequests(t, { skip: 0, take: 50 }))).rows.map(
      (r) => r.id,
    );
    expect(scopedIds).toEqual(expect.arrayContaining([a1.id, a2.id, n.id]));
    expect(scopedIds).not.toContain(b.id);

    const adminIds = (await runTx(admin, (t) => purchase.listRequests(t, { skip: 0, take: 50 }))).rows.map(
      (r) => r.id,
    );
    expect(adminIds).toEqual(expect.arrayContaining([a1.id, a2.id, b.id, n.id]));
  });

  it('purchase.listRequests: 검색어와 사업부 범위가 함께(AND) 적용된다', async () => {
    const a1 = await runTx(admin, (t) =>
      purchase.createRequest(t, {
        divisionId: divA,
        lines: [{ itemId: itemA, quantity: '1', unitPrice: '1000', taxType: 'TAXABLE' }],
      }),
    );
    const a2 = await runTx(admin, (t) =>
      purchase.createRequest(t, {
        divisionId: divA,
        lines: [{ itemId: itemA, quantity: '1', unitPrice: '1000', taxType: 'TAXABLE' }],
      }),
    );
    const b = await runTx(admin, (t) =>
      purchase.createRequest(t, {
        divisionId: divB,
        lines: [{ itemId: itemA, quantity: '1', unitPrice: '1000', taxType: 'TAXABLE' }],
      }),
    );
    const n = await runTx(admin, (t) =>
      purchase.createRequest(t, {
        lines: [{ itemId: itemA, quantity: '1', unitPrice: '1000', taxType: 'TAXABLE' }],
      }),
    );

    const ids = (
      await runTx(scoped, (t) => purchase.listRequests(t, { q: a1.docNo, skip: 0, take: 50 }))
    ).rows.map((r) => r.id);
    expect(ids).toEqual([a1.id]);
    expect(ids).not.toContain(a2.id);
    expect(ids).not.toContain(b.id);
    expect(ids).not.toContain(n.id);
  });

  it('purchase.listOrders: 사업부 범위 밖 문서는 제외되고 미지정 문서는 포함되며 관리자는 전체를 본다', async () => {
    const a1 = await purchaseOrderIn(divA);
    const a2 = await purchaseOrderIn(divA);
    const b = await purchaseOrderIn(divB);
    const n = await purchaseOrderIn(undefined);

    const scopedIds = (await runTx(scoped, (t) => purchase.listOrders(t, { skip: 0, take: 50 }))).rows.map(
      (r) => r.id,
    );
    expect(scopedIds).toEqual(expect.arrayContaining([a1.id, a2.id, n.id]));
    expect(scopedIds).not.toContain(b.id);

    const adminIds = (await runTx(admin, (t) => purchase.listOrders(t, { skip: 0, take: 50 }))).rows.map(
      (r) => r.id,
    );
    expect(adminIds).toEqual(expect.arrayContaining([a1.id, a2.id, b.id, n.id]));
  });

  it('purchase.listOrders: 검색어와 사업부 범위가 함께(AND) 적용된다', async () => {
    const a1 = await purchaseOrderIn(divA);
    const a2 = await purchaseOrderIn(divA);
    const b = await purchaseOrderIn(divB);
    const n = await purchaseOrderIn(undefined);

    const ids = (
      await runTx(scoped, (t) => purchase.listOrders(t, { q: a1.docNo, skip: 0, take: 50 }))
    ).rows.map((r) => r.id);
    expect(ids).toEqual([a1.id]);
    expect(ids).not.toContain(a2.id);
    expect(ids).not.toContain(b.id);
    expect(ids).not.toContain(n.id);
  });

  it('purchase.listDocuments: 사업부 범위 밖 문서는 제외되고 미지정 문서는 포함되며 관리자는 전체를 본다', async () => {
    const a1 = await runTx(admin, (t) =>
      purchase.createDocument(t, {
        partnerId: supplierId,
        warehouseId,
        divisionId: divA,
        docDate: '2026-06-01',
        lines: [{ itemId: itemA, quantity: '1', unitPrice: '1000', taxType: 'TAXABLE' }],
      }),
    );
    const a2 = await runTx(admin, (t) =>
      purchase.createDocument(t, {
        partnerId: supplierId,
        warehouseId,
        divisionId: divA,
        docDate: '2026-06-01',
        lines: [{ itemId: itemA, quantity: '1', unitPrice: '1000', taxType: 'TAXABLE' }],
      }),
    );
    const b = await runTx(admin, (t) =>
      purchase.createDocument(t, {
        partnerId: supplierId,
        warehouseId,
        divisionId: divB,
        docDate: '2026-06-01',
        lines: [{ itemId: itemA, quantity: '1', unitPrice: '1000', taxType: 'TAXABLE' }],
      }),
    );
    const n = await runTx(admin, (t) =>
      purchase.createDocument(t, {
        partnerId: supplierId,
        warehouseId,
        docDate: '2026-06-01',
        lines: [{ itemId: itemA, quantity: '1', unitPrice: '1000', taxType: 'TAXABLE' }],
      }),
    );

    const scopedIds = (await runTx(scoped, (t) => purchase.listDocuments(t, { skip: 0, take: 50 }))).rows.map(
      (r) => r.id,
    );
    expect(scopedIds).toEqual(expect.arrayContaining([a1.id, a2.id, n.id]));
    expect(scopedIds).not.toContain(b.id);

    const adminIds = (await runTx(admin, (t) => purchase.listDocuments(t, { skip: 0, take: 50 }))).rows.map(
      (r) => r.id,
    );
    expect(adminIds).toEqual(expect.arrayContaining([a1.id, a2.id, b.id, n.id]));
  });

  it('purchase.listDocuments: 검색어와 사업부 범위가 함께(AND) 적용된다 — OR 충돌 회귀 방지', async () => {
    const a1 = await runTx(admin, (t) =>
      purchase.createDocument(t, {
        partnerId: supplierId,
        warehouseId,
        divisionId: divA,
        docDate: '2026-06-01',
        lines: [{ itemId: itemA, quantity: '1', unitPrice: '1000', taxType: 'TAXABLE' }],
      }),
    );
    const a2 = await runTx(admin, (t) =>
      purchase.createDocument(t, {
        partnerId: supplierId,
        warehouseId,
        divisionId: divA,
        docDate: '2026-06-01',
        lines: [{ itemId: itemA, quantity: '1', unitPrice: '1000', taxType: 'TAXABLE' }],
      }),
    );
    const b = await runTx(admin, (t) =>
      purchase.createDocument(t, {
        partnerId: supplierId,
        warehouseId,
        divisionId: divB,
        docDate: '2026-06-01',
        lines: [{ itemId: itemA, quantity: '1', unitPrice: '1000', taxType: 'TAXABLE' }],
      }),
    );
    const n = await runTx(admin, (t) =>
      purchase.createDocument(t, {
        partnerId: supplierId,
        warehouseId,
        docDate: '2026-06-01',
        lines: [{ itemId: itemA, quantity: '1', unitPrice: '1000', taxType: 'TAXABLE' }],
      }),
    );

    const ids = (
      await runTx(scoped, (t) => purchase.listDocuments(t, { q: a1.docNo, skip: 0, take: 50 }))
    ).rows.map((r) => r.id);
    expect(ids).toEqual([a1.id]);
    expect(ids).not.toContain(a2.id);
    expect(ids).not.toContain(b.id);
    expect(ids).not.toContain(n.id);
  });
});
