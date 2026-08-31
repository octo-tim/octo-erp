// covers: INV-01..INV-09, INT-04, INT-05, INT-06, INT-07, INT-08, INT-12, B-11
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { actorFor, prepareDatabase, prisma, runTx, truncateBusinessData } from '../helpers/db';
import * as stockDocument from '@/server/modules/inventory/stock-document';
import * as stockCount from '@/server/modules/inventory/stock-count';
import * as report from '@/server/modules/inventory/stock-report';
import * as safetyStock from '@/server/modules/inventory/safety-stock';
import * as valuation from '@/server/modules/inventory/valuation';
import * as ledger from '@/server/modules/inventory/ledger';
import * as item from '@/server/modules/master/item';
import { withTransaction } from '@/server/core/context';
import type { Actor } from '@/server/core/context';
import { hashPassword } from '@/server/core/crypto';
import { AppError } from '@/server/core/errors';

/** INT-12: assert the app code, not just that something threw — a bypass that reverts to
 *  preferring the requested id would fail differently (wrong rows, not a thrown error) and a
 *  bare `.rejects.toThrow()` would not catch it either way. */
function expectOutOfScope(promise: Promise<unknown>) {
  return expect(promise).rejects.toSatisfy(
    (err: unknown) => err instanceof AppError && err.code === 'OUT_OF_SCOPE',
  );
}

let admin: Actor;
let warehouseA = '';
let warehouseB = '';

beforeAll(async () => {
  prepareDatabase();
  admin = await actorFor('admin');
  const warehouses = await prisma.warehouse.findMany({ orderBy: { code: 'asc' }, take: 2 });
  warehouseA = warehouses[0]!.id;
  warehouseB = warehouses[1]!.id;
});

beforeEach(async () => {
  await truncateBusinessData();
  await prisma.$executeRawUnsafe(`UPDATE "Item" SET "defaultSupplierId" = NULL`);
  await prisma.$executeRawUnsafe(`DELETE FROM "Item"`);
});

afterAll(() => prisma.$disconnect());

async function makeItem(name: string, safety?: string): Promise<string> {
  const created = await runTx(admin, (t) =>
    item.create(t, { name, unitCode: 'EA', ...(safety ? { safetyStock: safety } : {}) }),
  );
  return created.id;
}

/** Creates and confirms a document in two transactions, the way a router would. */
async function receipt(
  itemId: string,
  qty: string,
  unitCost: string,
  opts: { warehouseId?: string; docDate?: string } = {},
) {
  const doc = await runTx(admin, (t) =>
    stockDocument.create(t, {
      docType: 'RECEIPT',
      toWarehouseId: opts.warehouseId ?? warehouseA,
      reasonCode: 'PURCHASE',
      ...(opts.docDate ? { docDate: opts.docDate } : {}),
      lines: [{ itemId, quantity: qty, unitCost }],
    }),
  );
  await runTx(admin, (t) => stockDocument.confirm(t, doc.id, doc.version));
  return doc;
}

async function issue(
  itemId: string,
  qty: string,
  opts: { warehouseId?: string; docDate?: string; confirm?: boolean } = {},
) {
  const doc = await runTx(admin, (t) =>
    stockDocument.create(t, {
      docType: 'ISSUE',
      fromWarehouseId: opts.warehouseId ?? warehouseA,
      reasonCode: 'SAMPLE',
      ...(opts.docDate ? { docDate: opts.docDate } : {}),
      lines: [{ itemId, quantity: qty }],
    }),
  );
  if (opts.confirm !== false) await runTx(admin, (t) => stockDocument.confirm(t, doc.id, doc.version));
  return doc;
}

async function onHandOf(itemId: string, warehouseId?: string): Promise<string> {
  const sum = await prisma.inventoryLedger.aggregate({
    where: { itemId, ...(warehouseId ? { warehouseId } : {}) },
    _sum: { quantity: true },
  });
  return (sum._sum.quantity ?? 0).toString();
}

describe('INV-01/INV-02/INV-04: receipts and issues move the ledger', () => {
  it('a confirmed receipt adds stock and the snapshot agrees with the ledger', async () => {
    const id = await makeItem('입고시험품');
    await receipt(id, '10', '1000');

    expect(await onHandOf(id)).toBe('10');
    const snapshot = await prisma.stockSnapshot.findFirstOrThrow({ where: { itemId: id } });
    expect(snapshot.quantity.toString()).toBe('10');
    expect(snapshot.amount.toString()).toBe('10000');

    const drift = await runTx(admin, (t) => ledger.reconcile(t));
    expect(drift).toEqual([]);
  });

  it('a manual receipt or issue must carry a reason (INV-01/INV-02)', async () => {
    const id = await makeItem('사유없는품');
    await expect(
      runTx(admin, (t) =>
        stockDocument.create(t, {
          docType: 'RECEIPT',
          toWarehouseId: warehouseA,
          lines: [{ itemId: id, quantity: '1', unitCost: '100' }],
        }),
      ),
    ).rejects.toThrow(/사유/);
  });

  it('a draft posts nothing: only confirmation touches the ledger', async () => {
    const id = await makeItem('초안품');
    await issue(id, '1', { confirm: false });
    expect(await onHandOf(id)).toBe('0');
  });

  it('an issue is valued at the DEC-01 provisional average, not at the last price', async () => {
    const id = await makeItem('평가시험품');
    await receipt(id, '10', '1000');
    await receipt(id, '10', '1200');
    await issue(id, '5');

    const out = await prisma.inventoryLedger.findFirstOrThrow({
      where: { itemId: id, quantity: { lt: 0 } },
    });
    // (10,000 + 12,000) / 20 = 1,100 — a moving average would also say 1,100 here, so the
    // month-close test below is what actually distinguishes the two methods.
    expect(out.unitCost!.toString()).toBe('1100');
    expect(out.amount.toString()).toBe('-5500');
  });
});

describe('INT-05: confirming twice does not double-post', () => {
  it('the second confirm of the same document is refused', async () => {
    const id = await makeItem('중복확정품');
    const doc = await runTx(admin, (t) =>
      stockDocument.create(t, {
        docType: 'RECEIPT',
        toWarehouseId: warehouseA,
        reasonCode: 'PURCHASE',
        lines: [{ itemId: id, quantity: '5', unitCost: '100' }],
      }),
    );
    await runTx(admin, (t) => stockDocument.confirm(t, doc.id, doc.version));
    await expect(runTx(admin, (t) => stockDocument.confirm(t, doc.id, doc.version + 1))).rejects.toThrow();

    expect(await onHandOf(id)).toBe('5');
    expect(await prisma.inventoryLedger.count({ where: { itemId: id } })).toBe(1);
  });

  it('the same requestId replays the first result instead of posting again', async () => {
    const id = await makeItem('멱등확정품');
    const doc = await runTx(admin, (t) =>
      stockDocument.create(t, {
        docType: 'RECEIPT',
        toWarehouseId: warehouseA,
        reasonCode: 'PURCHASE',
        lines: [{ itemId: id, quantity: '7', unitCost: '100' }],
      }),
    );
    const rid = randomUUID();
    const first = await runTx(admin, (t) => stockDocument.confirm(t, doc.id, doc.version), rid);
    const second = await runTx(admin, (t) => stockDocument.confirm(t, doc.id, doc.version), rid);

    expect(second).toEqual(first);
    expect(await prisma.inventoryLedger.count({ where: { itemId: id } })).toBe(1);
  });
});

describe('INT-07: cancellation writes opposite rows and deletes nothing', () => {
  it('cancelling a confirmed receipt reverses it and keeps both rows', async () => {
    const id = await makeItem('취소시험품');
    const doc = await receipt(id, '10', '1000');
    const confirmed = await prisma.stockDocument.findUniqueOrThrow({ where: { id: doc.id } });

    await runTx(admin, (t) => stockDocument.cancel(t, doc.id, '오입력', confirmed.version));

    expect(await onHandOf(id)).toBe('0');
    const rows = await prisma.inventoryLedger.findMany({
      where: { itemId: id },
      orderBy: { sourceVersion: 'asc' },
    });
    expect(rows).toHaveLength(2);
    expect(rows[0]!.quantity.toString()).toBe('10');
    expect(rows[1]!.quantity.toString()).toBe('-10');
    expect(rows[1]!.reason).toContain('오입력');
  });

  it('cancelling twice is refused and does not reverse twice', async () => {
    const id = await makeItem('이중취소품');
    const doc = await receipt(id, '4', '100');
    const confirmed = await prisma.stockDocument.findUniqueOrThrow({ where: { id: doc.id } });
    await runTx(admin, (t) => stockDocument.cancel(t, doc.id, '오입력', confirmed.version));

    const canceled = await prisma.stockDocument.findUniqueOrThrow({ where: { id: doc.id } });
    await expect(
      runTx(admin, (t) => stockDocument.cancel(t, doc.id, '또 취소', canceled.version)),
    ).rejects.toThrow(/이미 취소/);
    expect(await prisma.inventoryLedger.count({ where: { itemId: id } })).toBe(2);
  });

  it('the append-only trigger refuses an update to a ledger row', async () => {
    const id = await makeItem('원장보호품');
    await receipt(id, '1', '100');
    const row = await prisma.inventoryLedger.findFirstOrThrow({ where: { itemId: id } });
    await expect(
      prisma.$executeRawUnsafe(`UPDATE "InventoryLedger" SET quantity = 999 WHERE id = $1`, row.id),
    ).rejects.toThrow(/append-only/);
  });
});

describe('INV-06: negative stock', () => {
  it('an issue beyond stock on hand is blocked with the shortfall spelled out', async () => {
    const id = await makeItem('부족시험품');
    await receipt(id, '3', '1000');

    await expect(issue(id, '5')).rejects.toThrow(/재고가 부족/);
    expect(await onHandOf(id)).toBe('3');
  });

  it('concurrent issues cannot both pass the check (INT-08)', async () => {
    const id = await makeItem('동시출고품');
    await receipt(id, '10', '1000');

    // two issues of 6 against 10 on hand: exactly one must succeed
    const docs = await Promise.all([
      runTx(admin, (t) =>
        stockDocument.create(t, {
          docType: 'ISSUE',
          fromWarehouseId: warehouseA,
          reasonCode: 'SAMPLE',
          lines: [{ itemId: id, quantity: '6' }],
        }),
      ),
      runTx(admin, (t) =>
        stockDocument.create(t, {
          docType: 'ISSUE',
          fromWarehouseId: warehouseA,
          reasonCode: 'SAMPLE',
          lines: [{ itemId: id, quantity: '6' }],
        }),
      ),
    ]);

    const results = await Promise.allSettled(
      docs.map((d) => runTx(admin, (t) => stockDocument.confirm(t, d.id, d.version))),
    );
    const ok = results.filter((r) => r.status === 'fulfilled');
    expect(ok).toHaveLength(1);
    expect(await onHandOf(id)).toBe('4');
  });

  it('repeated concurrent races never drive the ledger negative', async () => {
    const id = await makeItem('반복경쟁품');
    await receipt(id, '20', '1000');

    for (let round = 0; round < 5; round++) {
      const docs = await Promise.all(
        [0, 1, 2].map(() =>
          runTx(admin, (t) =>
            stockDocument.create(t, {
              docType: 'ISSUE',
              fromWarehouseId: warehouseA,
              reasonCode: 'SAMPLE',
              lines: [{ itemId: id, quantity: '3' }],
            }),
          ),
        ),
      );
      await Promise.allSettled(
        docs.map((d) => runTx(admin, (t) => stockDocument.confirm(t, d.id, d.version))),
      );
      expect(Number(await onHandOf(id))).toBeGreaterThanOrEqual(0);
    }

    const drift = await runTx(admin, (t) => ledger.reconcile(t));
    expect(drift).toEqual([]);
  });

  it('WARN mode lets the issue through and records a security event', async () => {
    await prisma.systemSetting.update({
      where: { key: 'inventory.allowNegative' },
      data: { value: { value: true } },
    });
    try {
      const id = await makeItem('경고모드품');
      await receipt(id, '1', '1000');
      await issue(id, '5');
      expect(await onHandOf(id)).toBe('-4');
      expect(await prisma.securityEvent.count({ where: { type: 'NEGATIVE_STOCK_WARNING' } })).toBe(1);
    } finally {
      await prisma.systemSetting.update({
        where: { key: 'inventory.allowNegative' },
        data: { value: { value: false } },
      });
    }
  });
});

describe('INV-03: warehouse transfer', () => {
  it('moves stock only on completion and both warehouses change together', async () => {
    const id = await makeItem('이동시험품');
    await receipt(id, '10', '1000');

    const doc = await runTx(admin, (t) =>
      stockDocument.create(t, {
        docType: 'TRANSFER',
        fromWarehouseId: warehouseA,
        toWarehouseId: warehouseB,
        lines: [{ itemId: id, quantity: '4' }],
      }),
    );
    expect(doc.movementState).toBe('REQUESTED');

    // requested is not yet a movement
    expect(await onHandOf(id, warehouseA)).toBe('10');
    expect(await onHandOf(id, warehouseB)).toBe('0');

    const shipped = await runTx(admin, (t) => stockDocument.ship(t, doc.id, doc.version));
    expect(shipped.movementState).toBe('IN_TRANSIT');
    expect(await onHandOf(id, warehouseA)).toBe('10');

    await runTx(admin, (t) => stockDocument.confirm(t, doc.id, shipped.version));
    expect(await onHandOf(id, warehouseA)).toBe('6');
    expect(await onHandOf(id, warehouseB)).toBe('4');
    // the total is unchanged: a transfer moves stock, it does not create or destroy it
    expect(await onHandOf(id)).toBe('10');
  });

  it('a transfer cannot be confirmed straight from 요청', async () => {
    const id = await makeItem('직행이동품');
    await receipt(id, '5', '1000');
    const doc = await runTx(admin, (t) =>
      stockDocument.create(t, {
        docType: 'TRANSFER',
        fromWarehouseId: warehouseA,
        toWarehouseId: warehouseB,
        lines: [{ itemId: id, quantity: '1' }],
      }),
    );
    await expect(runTx(admin, (t) => stockDocument.confirm(t, doc.id, doc.version))).rejects.toThrow(
      /이동중/,
    );
  });

  it('cancelling a completed transfer returns the stock to the origin', async () => {
    const id = await makeItem('이동취소품');
    await receipt(id, '10', '1000');
    const doc = await runTx(admin, (t) =>
      stockDocument.create(t, {
        docType: 'TRANSFER',
        fromWarehouseId: warehouseA,
        toWarehouseId: warehouseB,
        lines: [{ itemId: id, quantity: '4' }],
      }),
    );
    const shipped = await runTx(admin, (t) => stockDocument.ship(t, doc.id, doc.version));
    await runTx(admin, (t) => stockDocument.confirm(t, doc.id, shipped.version));

    const completed = await prisma.stockDocument.findUniqueOrThrow({ where: { id: doc.id } });
    await runTx(admin, (t) => stockDocument.cancel(t, doc.id, '이동 취소', completed.version));

    expect(await onHandOf(id, warehouseA)).toBe('10');
    expect(await onHandOf(id, warehouseB)).toBe('0');
  });

  it('a transfer to the same warehouse is refused', async () => {
    const id = await makeItem('동일창고품');
    await expect(
      runTx(admin, (t) =>
        stockDocument.create(t, {
          docType: 'TRANSFER',
          fromWarehouseId: warehouseA,
          toWarehouseId: warehouseA,
          lines: [{ itemId: id, quantity: '1' }],
        }),
      ),
    ).rejects.toThrow(/같을 수 없습니다/);
  });
});

describe('INV-04: the snapshot cache is recoverable from the ledger', () => {
  it('drift is detected and rebuild fixes it', async () => {
    const id = await makeItem('캐시시험품');
    await receipt(id, '10', '1000');

    // corrupt the cache on purpose
    await prisma.stockSnapshot.updateMany({ where: { itemId: id }, data: { quantity: '999' } });
    const drift = await runTx(admin, (t) => ledger.reconcile(t));
    expect(drift).toHaveLength(1);
    expect(drift[0]!.ledgerQuantity).toContain('10');
    expect(drift[0]!.snapshotQuantity).toContain('999');

    await runTx(admin, (t) => ledger.rebuild(t));
    expect(await runTx(admin, (t) => ledger.reconcile(t))).toEqual([]);
    const fixed = await prisma.stockSnapshot.findFirstOrThrow({ where: { itemId: id } });
    expect(fixed.quantity.toString()).toBe('10');
  });
});

describe('INV-05: the stock book', () => {
  it('reports opening, movements with their source document, and closing', async () => {
    const id = await makeItem('수불부품');
    await receipt(id, '10', '1000', { docDate: '2026-06-10' });
    await issue(id, '4', { docDate: '2026-06-20' });

    const book = await runTx(admin, (t) =>
      report.book(t, { itemId: id, from: '2026-06-01', to: '2026-06-30' }),
    );

    expect(book.opening.quantity).toBe('0.000');
    expect(book.rows).toHaveLength(2);
    expect(book.rows[0]!.inQty).toBe('10.000');
    expect(book.rows[0]!.docNo).toMatch(/^SI-/);
    expect(book.rows[1]!.outQty).toBe('4.000');
    expect(book.rows[1]!.balanceQty).toBe('6.000');
    expect(book.closing.quantity).toBe('6.000');
    expect(book.totals.inQty).toBe('10.000');
    expect(book.totals.outQty).toBe('4.000');
  });

  it('a later period sees the earlier one as opening balance', async () => {
    const id = await makeItem('기간경계품');
    await receipt(id, '10', '1000', { docDate: '2026-06-10' });

    const july = await runTx(admin, (t) =>
      report.book(t, { itemId: id, from: '2026-07-01', to: '2026-07-31' }),
    );
    expect(july.opening.quantity).toBe('10.000');
    expect(july.rows).toHaveLength(0);
    expect(july.closing.quantity).toBe('10.000');
  });

  it('exports as CSV with the opening and closing lines', async () => {
    const id = await makeItem('엑셀출력품');
    await receipt(id, '2', '500', { docDate: '2026-06-10' });
    const book = await runTx(admin, (t) =>
      report.book(t, { itemId: id, from: '2026-06-01', to: '2026-06-30' }),
    );
    const csv = report.bookToCsv(book);
    expect(csv.split('\n')[0]).toContain('전표번호');
    expect(csv).toContain('기초');
    expect(csv).toContain('기말');
  });

  it('the CSV has one row per movement, with amounts matching the book exactly', async () => {
    const id = await makeItem('수불부검증품');
    // fractional quantities exercise the 3-decimal quantity strings, not just amounts
    await receipt(id, '7.500', '12345', { docDate: '2026-06-10' });
    await issue(id, '2.250', { docDate: '2026-06-20' });

    const book = await runTx(admin, (t) =>
      report.book(t, { itemId: id, from: '2026-06-01', to: '2026-06-30' }),
    );
    expect(book.rows).toHaveLength(2);

    const csv = report.bookToCsv(book);
    const lines = csv.split('\n');
    expect(lines[0]!.split(',')).toEqual([
      '일자',
      '전표번호',
      '구분',
      '창고',
      '사유',
      '입고수량',
      '출고수량',
      '입고금액',
      '출고금액',
      '재고수량',
      '재고금액',
    ]);

    // header + opening line + one row per movement + closing line
    expect(lines).toHaveLength(book.rows.length + 3);

    book.rows.forEach((row, i) => {
      const cols = lines[i + 2]!.split(',');
      // string equality, never Number()/parseFloat: that is exactly the bug this guards
      expect(cols[5]).toBe(row.inQty);
      expect(cols[6]).toBe(row.outQty);
      expect(cols[7]).toBe(row.inAmount);
      expect(cols[8]).toBe(row.outAmount);
      expect(cols[9]).toBe(row.balanceQty);
      expect(cols[10]).toBe(row.balanceAmount);
    });

    const closingCols = lines[lines.length - 1]!.split(',');
    expect(closingCols[5]).toBe(book.totals.inQty);
    expect(closingCols[6]).toBe(book.totals.outQty);
    expect(closingCols[7]).toBe(book.totals.inAmount);
    expect(closingCols[8]).toBe(book.totals.outAmount);
    expect(closingCols[9]).toBe(book.closing.quantity);
    expect(closingCols[10]).toBe(book.closing.amount);
  });
});

describe('INV-07: safety stock', () => {
  it('an issue that drops stock below the safety level notifies the inventory role', async () => {
    const id = await makeItem('안전재고품', '10');
    await receipt(id, '12', '1000');
    expect(await runTx(admin, (t) => safetyStock.list(t))).toHaveLength(0);

    await issue(id, '5');
    const shortfalls = await runTx(admin, (t) => safetyStock.list(t));
    expect(shortfalls).toHaveLength(1);
    expect(shortfalls[0]!.onHand).toBe('7.000');
    expect(shortfalls[0]!.shortage).toBe('3.000');

    const notifications = await prisma.notification.findMany({ where: { category: 'STOCK' } });
    expect(notifications.length).toBeGreaterThan(0);
    expect(notifications[0]!.title).toContain('안전재고 미달');
  });

  it('one item produces one alert per day however many issues touch it', async () => {
    const id = await makeItem('중복알림품', '10');
    await receipt(id, '12', '1000');
    await issue(id, '3');
    await issue(id, '1');

    const notifications = await prisma.notification.findMany({ where: { category: 'STOCK' } });
    expect(notifications).toHaveLength(1);
  });
});

describe('INV-08: physical count', () => {
  it('freezes the system quantity, records differences and posts the adjustment', async () => {
    const id = await makeItem('실사시험품');
    await receipt(id, '10', '1000');

    const count = await runTx(admin, (t) => stockCount.create(t, { warehouseId: warehouseA }));
    const started = await runTx(admin, (t) => stockCount.start(t, count.id, {}, count.version));

    const lines = await runTx(admin, (t) => stockCount.differences(t, count.id));
    expect(lines).toHaveLength(1);
    expect(lines[0]!.systemQty).toBe('10.000');

    // the shelf says 8: two are missing
    await runTx(admin, (t) =>
      stockCount.record(t, count.id, [{ itemId: id, countedQty: '8', reason: '파손 폐기' }]),
    );
    const diffs = await runTx(admin, (t) => stockCount.differences(t, count.id));
    expect(diffs[0]!.difference).toBe('-2.000');

    const result = await runTx(admin, (t) => stockCount.approve(t, count.id, started.version));
    expect(result.adjustedLines).toBe(1);
    expect(await onHandOf(id)).toBe('8');

    const adjustment = await prisma.stockDocument.findUniqueOrThrow({
      where: { id: result.adjustmentId! },
    });
    expect(adjustment.docType).toBe('ADJUST');
    expect(adjustment.status).toBe('CONFIRMED');
    expect(adjustment.stockCountId).toBe(count.id);
  });

  it('an uncounted line blocks approval: not counted is not the same as no difference', async () => {
    const id = await makeItem('미입력실사품');
    await receipt(id, '5', '1000');
    const count = await runTx(admin, (t) => stockCount.create(t, { warehouseId: warehouseA }));
    const started = await runTx(admin, (t) => stockCount.start(t, count.id, {}, count.version));

    await expect(runTx(admin, (t) => stockCount.approve(t, count.id, started.version))).rejects.toThrow(
      /입력되지 않은/,
    );
  });

  it('a count with no differences approves without creating an adjustment', async () => {
    const id = await makeItem('차이없는품');
    await receipt(id, '6', '1000');
    const count = await runTx(admin, (t) => stockCount.create(t, { warehouseId: warehouseA }));
    const started = await runTx(admin, (t) => stockCount.start(t, count.id, {}, count.version));
    await runTx(admin, (t) => stockCount.record(t, count.id, [{ itemId: id, countedQty: '6' }]));

    const result = await runTx(admin, (t) => stockCount.approve(t, count.id, started.version));
    expect(result.adjustmentId).toBeNull();
    expect(await onHandOf(id)).toBe('6');
  });

  it('movements made after the freeze do not change the recorded difference', async () => {
    const id = await makeItem('동결시험품');
    await receipt(id, '10', '1000');
    const count = await runTx(admin, (t) => stockCount.create(t, { warehouseId: warehouseA }));
    await runTx(admin, (t) => stockCount.start(t, count.id, {}, count.version));

    // stock moves while the warehouse is being walked
    await issue(id, '2');

    const diffs = await runTx(admin, (t) => stockCount.differences(t, count.id));
    expect(diffs[0]!.systemQty).toBe('10.000');
  });
});

describe('UIX-03: server-side CSV export', () => {
  it('stockCount.listCsv returns every matching row, not a page, and respects a filter', async () => {
    const id = await makeItem('내보내기실사품');
    await receipt(id, '10', '1000');
    for (let i = 0; i < 5; i++) {
      await runTx(admin, (t) => stockCount.create(t, { warehouseId: warehouseA }));
    }
    const started = await runTx(admin, (t) => stockCount.create(t, { warehouseId: warehouseA }));
    await runTx(admin, (t) => stockCount.start(t, started.id, {}, started.version));

    const all = await runTx(admin, (t) => stockCount.listCsv(t, {}));
    expect(all.total).toBe(6);
    expect(all.rowCount).toBe(6);
    expect(all.truncated).toBe(false);
    expect(all.csv.trim().split('\r\n')).toHaveLength(7);
    expect(all.csv).toContain('실사번호');

    const counting = await runTx(admin, (t) => stockCount.listCsv(t, { status: 'COUNTING' }));
    expect(counting.total).toBe(1);
    expect(counting.csv).toContain(started.countNo);
  });

  it('a warehouse-scoped user does not get another warehouse’s count in their export', async () => {
    const countA = await runTx(admin, (t) => stockCount.create(t, { warehouseId: warehouseA }));
    const countB = await runTx(admin, (t) => stockCount.create(t, { warehouseId: warehouseB }));

    const viewerRole = await prisma.role.findUniqueOrThrow({ where: { code: 'viewer' } });
    const scopedUser = await prisma.user.upsert({
      where: { username: 'inv-wh-scoped' },
      create: {
        username: 'inv-wh-scoped',
        displayName: '창고범위재고',
        passwordHash: await hashPassword('Scoped!123456'),
        roles: { create: [{ roleId: viewerRole.id }] },
        warehouseScopes: { create: [{ warehouseId: warehouseA }] },
      },
      update: { isActive: true },
    });
    const scoped = await actorFor('inv-wh-scoped');
    const scopedExport = await runTx(scoped, (t) => stockCount.listCsv(t, {}));
    expect(scopedExport.total).toBe(1);
    expect(scopedExport.csv).toContain(countA.countNo);
    expect(scopedExport.csv).not.toContain(countB.countNo);

    await prisma.userWarehouseScope.deleteMany({ where: { userId: scopedUser.id } });
  });
});

describe('INV-09 / DEC-01: monthly total average close (B-11)', () => {
  it('reproduces the approved calculation example exactly', async () => {
    const id = await makeItem('B11품목');

    // previous month: 10 @ 1,000 confirmed
    await receipt(id, '10', '1000', { docDate: '2026-05-10' });
    await runTx(admin, (t) => valuation.close(t, '2026-05'));

    // this month: in 10 @1,200, out 5, in 10 @1,500, out 8
    await receipt(id, '10', '1200', { docDate: '2026-06-05' });
    await issue(id, '5', { docDate: '2026-06-06' });
    await receipt(id, '10', '1500', { docDate: '2026-06-10' });
    await issue(id, '8', { docDate: '2026-06-11' });

    // provisional: first issue at 1,100, second at (22,000+15,000)/30 = 1,233
    const issues = await prisma.inventoryLedger.findMany({
      where: { itemId: id, quantity: { lt: 0 } },
      orderBy: { occurredAt: 'asc' },
    });
    expect(issues[0]!.unitCost!.toString()).toBe('1100');
    expect(issues[0]!.amount.toString()).toBe('-5500');
    expect(issues[1]!.unitCost!.toString()).toBe('1233');
    expect(issues[1]!.amount.toString()).toBe('-9864');

    const preview = await runTx(admin, (t) => valuation.preview(t, '2026-06'));
    expect(preview.lines).toHaveLength(1);
    const line = preview.lines[0]!;
    expect(line.averageCost).toBe('1233.0000');
    expect(line.outQty).toBe('13.000');
    expect(line.provisionalOutAmount).toBe('15364');
    expect(line.finalOutAmount).toBe('16029');
    expect(line.adjustment).toBe('665');
    expect(line.closingQty).toBe('17.000');
    expect(line.closingAmount).toBe('20971');

    await runTx(admin, (t) => valuation.close(t, '2026-06'));

    // the adjustment row moves value only: quantity stays 17, amount becomes 20,971
    const totals = await prisma.inventoryLedger.aggregate({
      where: { itemId: id },
      _sum: { quantity: true, amount: true },
    });
    expect(totals._sum.quantity!.toString()).toBe('17');
    expect(totals._sum.amount!.toString()).toBe('20971');

    const adjustRows = await prisma.inventoryLedger.findMany({
      where: { itemId: id, sourceType: 'VALUATION_ADJUST' },
    });
    expect(adjustRows).toHaveLength(1);
    expect(adjustRows[0]!.quantity.toString()).toBe('0');
    expect(adjustRows[0]!.amount.toString()).toBe('-665');

    const drift = await runTx(admin, (t) => ledger.reconcile(t));
    expect(drift).toEqual([]);
  });

  it('a closed month refuses new movements until it is reopened', async () => {
    const id = await makeItem('마감기간품');
    await receipt(id, '5', '1000', { docDate: '2026-05-10' });
    await runTx(admin, (t) => valuation.close(t, '2026-05'));

    await expect(receipt(id, '1', '1000', { docDate: '2026-05-20' })).rejects.toThrow(/마감/);

    await runTx(admin, (t) => valuation.reopen(t, '2026-05', '단가 오류 정정'));
    await receipt(id, '1', '1000', { docDate: '2026-05-20' });
    expect(await onHandOf(id)).toBe('6');
  });

  it('closing twice is refused, and reopening needs a reason', async () => {
    const id = await makeItem('중복마감품');
    await receipt(id, '1', '1000', { docDate: '2026-05-10' });
    await runTx(admin, (t) => valuation.close(t, '2026-05'));

    await expect(runTx(admin, (t) => valuation.close(t, '2026-05'))).rejects.toThrow(/이미 마감/);
    await expect(runTx(admin, (t) => valuation.reopen(t, '2026-05', '오타'))).rejects.toThrow(/5자/);
  });

  it('months must close in order', async () => {
    const id = await makeItem('순서마감품');
    await receipt(id, '1', '1000', { docDate: '2026-05-10' });
    await receipt(id, '1', '1000', { docDate: '2026-06-10' });

    await expect(runTx(admin, (t) => valuation.close(t, '2026-06'))).rejects.toThrow(/이전 기간/);
  });

  it('the closed month becomes the next month opening position', async () => {
    const id = await makeItem('이월시험품');
    await receipt(id, '10', '1000', { docDate: '2026-05-10' });
    await runTx(admin, (t) => valuation.close(t, '2026-05'));

    // no receipts in June: an issue is valued at the carried-forward average
    await issue(id, '2', { docDate: '2026-06-05' });
    const out = await prisma.inventoryLedger.findFirstOrThrow({
      where: { itemId: id, quantity: { lt: 0 } },
    });
    expect(out.unitCost!.toString()).toBe('1000');
  });
});

describe('INT-06: the whole confirmation shares one transaction', () => {
  it('a failure after the ledger post leaves no rows behind', async () => {
    const id = await makeItem('롤백시험품');
    const doc = await runTx(admin, (t) =>
      stockDocument.create(t, {
        docType: 'RECEIPT',
        toWarehouseId: warehouseA,
        reasonCode: 'PURCHASE',
        lines: [{ itemId: id, quantity: '5', unitCost: '100' }],
      }),
    );

    await expect(
      withTransaction(prisma, { actor: admin, requestId: randomUUID(), now: new Date() }, async (t) => {
        await stockDocument.confirm(t, doc.id, doc.version);
        throw new Error('주입된 장애');
      }),
    ).rejects.toThrow('주입된 장애');

    expect(await onHandOf(id)).toBe('0');
    expect(await prisma.inventoryLedger.count({ where: { itemId: id } })).toBe(0);
    const after = await prisma.stockDocument.findUniqueOrThrow({ where: { id: doc.id } });
    expect(after.status).toBe('DRAFT');
  });
});

describe('INT-12: 요청한 창고는 범위를 대체하지 않는다', () => {
  let scoped: Actor;

  beforeAll(async () => {
    const viewerRole = await prisma.role.findUniqueOrThrow({ where: { code: 'viewer' } });
    await prisma.user.upsert({
      where: { username: 'inv-wh-int12' },
      create: {
        username: 'inv-wh-int12',
        displayName: 'INT12 창고범위',
        passwordHash: await hashPassword('Scoped!123456'),
        roles: { create: [{ roleId: viewerRole.id }] },
        warehouseScopes: { create: [{ warehouseId: warehouseA }] },
      },
      update: { isActive: true },
    });
    scoped = await actorFor('inv-wh-int12');
  });

  afterAll(async () => {
    await prisma.userWarehouseScope.deleteMany({ where: { user: { username: 'inv-wh-int12' } } });
  });

  /** One receipt into warehouseA (in scope), one into warehouseB (out of scope). Every stock
   *  document names a real warehouse — unlike a journal line there is no "unassigned" variant
   *  here — so the no-filter case is checked against "not the other warehouse's", not against
   *  an unassigned bucket. */
  async function seedWarehouseDocs() {
    const id = await makeItem('INT12 범위품목');
    const a = await runTx(admin, (t) =>
      stockDocument.create(t, {
        docType: 'RECEIPT',
        toWarehouseId: warehouseA,
        reasonCode: 'PURCHASE',
        lines: [{ itemId: id, quantity: '1', unitCost: '100' }],
      }),
    );
    const b = await runTx(admin, (t) =>
      stockDocument.create(t, {
        docType: 'RECEIPT',
        toWarehouseId: warehouseB,
        reasonCode: 'PURCHASE',
        lines: [{ itemId: id, quantity: '1', unitCost: '100' }],
      }),
    );
    return { a, b };
  }

  it('범위 밖 창고(warehouseB)를 지정하면 OUT_OF_SCOPE로 거부된다', async () => {
    await seedWarehouseDocs();
    await expectOutOfScope(
      runTx(scoped, (t) => stockDocument.list(t, { warehouseId: warehouseB, skip: 0, take: 20 })),
    );
  });

  it('범위 안 창고(warehouseA)를 지정하면 그 창고로만 좁혀진다', async () => {
    const { a } = await seedWarehouseDocs();
    const result = await runTx(scoped, (t) =>
      stockDocument.list(t, { warehouseId: warehouseA, skip: 0, take: 20 }),
    );
    expect(result.rows.map((r) => r.docNo)).toEqual([a.docNo]);
  });

  it('아무 창고도 지정하지 않으면 본인 범위 창고의 전표만 보인다', async () => {
    const { a, b } = await seedWarehouseDocs();
    const result = await runTx(scoped, (t) => stockDocument.list(t, { skip: 0, take: 20 }));
    const docNos = result.rows.map((r) => r.docNo);
    expect(docNos).toContain(a.docNo);
    expect(docNos).not.toContain(b.docNo);
  });

  it('admin은 warehouseId 필터와 무관하게 모든 창고의 전표를 볼 수 있다', async () => {
    const { a, b } = await seedWarehouseDocs();
    const all = await runTx(admin, (t) => stockDocument.list(t, { skip: 0, take: 20 }));
    expect(all.rows.map((r) => r.docNo)).toEqual(expect.arrayContaining([a.docNo, b.docNo]));

    const filtered = await runTx(admin, (t) =>
      stockDocument.list(t, { warehouseId: warehouseB, skip: 0, take: 20 }),
    );
    expect(filtered.rows.map((r) => r.docNo)).toEqual([b.docNo]);
  });
});

describe('DEC-03: the approval gate on stock documents', () => {
  it('an issue at or above the threshold cannot be confirmed directly', async () => {
    const id = await makeItem('결재필요품');
    // build the stock up in receipts that each stay under the STOCK_IN threshold, so the
    // setup itself does not trip the gate we are trying to test
    for (let i = 0; i < 3; i++) await receipt(id, '40', '20000');

    const doc = await runTx(admin, (t) =>
      stockDocument.create(t, {
        docType: 'ISSUE',
        fromWarehouseId: warehouseA,
        reasonCode: 'SAMPLE',
        // 60 x 20,000 = 1,200,000 which is over the 1,000,000 STOCK_OUT threshold
        lines: [{ itemId: id, quantity: '60', unitCost: '20000' }],
      }),
    );
    await expect(runTx(admin, (t) => stockDocument.confirm(t, doc.id, doc.version))).rejects.toThrow(/결재/);
  });

  it('below the threshold it confirms directly', async () => {
    const id = await makeItem('결재불요품');
    await receipt(id, '100', '1000');
    const doc = await runTx(admin, (t) =>
      stockDocument.create(t, {
        docType: 'ISSUE',
        fromWarehouseId: warehouseA,
        reasonCode: 'SAMPLE',
        lines: [{ itemId: id, quantity: '5', unitCost: '1000' }],
      }),
    );
    await runTx(admin, (t) => stockDocument.confirm(t, doc.id, doc.version));
    expect(await onHandOf(id)).toBe('95');
  });
});
