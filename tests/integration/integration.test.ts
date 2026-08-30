// covers: STEP 10 integration — APV-08, APV-09, APV-12, SLS-04..13, INV-01..09, ACC-03,
// INT-02, INT-04, INT-05, INT-06, INT-07, INT-10, E2E-01..E2E-04, B-08
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { actorFor, prepareDatabase, prisma, runTx, truncateBusinessData } from '../helpers/db';
import { withTransaction } from '@/server/core/context';
import type { Actor, TransactionContext } from '@/server/core/context';
import * as approval from '@/server/modules/approval/service';
import { __resetHandlers } from '@/server/modules/approval/handlers';
import { registerHrmHandlers } from '@/server/modules/approval/handlers/hrm';
import { registerSalesHandlers } from '@/server/modules/approval/handlers/sales';
import { registerInventoryHandlers } from '@/server/modules/approval/handlers/inventory';
import { registerAccountingHandlers } from '@/server/modules/approval/handlers/accounting';
import * as documents from '@/server/modules/documents/service';
import * as documentSubmit from '@/server/modules/documents/submit';
import * as policy from '@/server/modules/policy/service';
import * as quotation from '@/server/modules/sales/quotation';
import * as salesDocument from '@/server/modules/sales/sales-document';
import * as purchase from '@/server/modules/sales/purchase';
import * as settlement from '@/server/modules/sales/settlement';
import * as journal from '@/server/modules/accounting/journal';
import * as accountingPeriod from '@/server/modules/accounting/period';
import * as item from '@/server/modules/master/item';
import * as partnerModule from '@/server/modules/master/partner';
import * as employee from '@/server/modules/hrm/employee';
import * as organization from '@/server/modules/hrm/organization';
import * as ledger from '@/server/modules/inventory/ledger';
import { tick } from '@/server/jobs/worker';
import { AppError } from '@/server/core/errors';
import { hashPassword } from '@/server/core/crypto';

/**
 * STEP 10 asks for the modules to be connected as a real service rather than as parts that
 * each work alone. The tests here are therefore whole journeys: a document travels from
 * quotation through approval to a settled receivable, and every effect it left behind is
 * checked in the ledgers rather than on the document's own status field, because a status
 * that says CONFIRMED while the journal is empty is exactly the failure worth catching.
 */

let admin: Actor;
let drafter: Actor;
let manager: Actor;

let warehouseId = '';
let customerId = '';
let supplierId = '';
let itemA = '';
let deptId = '';

beforeAll(async () => {
  prepareDatabase();
  admin = await actorFor('admin');
  warehouseId = (await prisma.warehouse.findFirstOrThrow({ orderBy: { code: 'asc' } })).id;

  const hash = await hashPassword('Approve!123456');
  const salesRole = await prisma.role.findUniqueOrThrow({ where: { code: 'sales' } });
  const managerRole = await prisma.role.findUniqueOrThrow({ where: { code: 'manager' } });
  for (const [username, roleId, displayName] of [
    ['int-drafter', salesRole.id, '통합기안자'],
    ['int-manager', managerRole.id, '통합부서장'],
  ] as const) {
    await prisma.user.upsert({
      where: { username },
      create: { username, displayName, passwordHash: hash, roles: { create: [{ roleId }] } },
      update: { isActive: true },
    });
  }
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
  await prisma.$executeRawUnsafe(`DELETE FROM "ApprovalDocument"`);
  // each test decides its own DEC-03 matrix, so start from the seeded default every time
  await prisma.$executeRawUnsafe(
    `DELETE FROM "PolicyVersion" WHERE "policyKey" = 'approval.matrix' AND "version" > 1`,
  );
  await prisma.$executeRawUnsafe(`UPDATE "Item" SET "defaultSupplierId" = NULL`);
  await prisma.$executeRawUnsafe(`DELETE FROM "PartnerContact"`);
  await prisma.$executeRawUnsafe(`DELETE FROM "Item"`);
  await prisma.$executeRawUnsafe(`DELETE FROM "Partner"`);

  // every handler, unlike the module suites which each register only their own
  __resetHandlers();
  registerHrmHandlers();
  registerSalesHandlers();
  registerInventoryHandlers();
  registerAccountingHandlers();

  const dept = await runTx(admin, (t) =>
    organization.createDepartment(t, { code: 'INT-DEPT', name: '통합시험팀', validFrom: '2020-01-01' }),
  );
  deptId = dept.id;
  const head = await runTx(admin, (t) =>
    employee.create(t, {
      name: '통합부서장',
      hireDate: '2020-01-02',
      departmentId: deptId,
      jobTitle: '팀장',
    }),
  );
  await prisma.department.update({ where: { id: deptId }, data: { headEmployeeId: head.id } });
  const drafterEmployee = await runTx(admin, (t) =>
    employee.create(t, { name: '통합기안자', hireDate: '2022-03-02', departmentId: deptId }),
  );
  await prisma.user.update({ where: { username: 'int-manager' }, data: { employeeId: head.id } });
  await prisma.user.update({
    where: { username: 'int-drafter' },
    data: { employeeId: drafterEmployee.id },
  });
  drafter = await actorFor('int-drafter');
  manager = await actorFor('int-manager');

  itemA = (await runTx(admin, (t) => item.create(t, { name: '통합자재', unitCode: 'EA' }))).id;
  customerId = (
    await runTx(admin, (t) => partnerModule.create(t, { name: '통합상사', partnerType: 'CUSTOMER' }))
  ).id;
  supplierId = (
    await runTx(admin, (t) => partnerModule.create(t, { name: '통합공업', partnerType: 'SUPPLIER' }))
  ).id;
});

afterAll(() => prisma.$disconnect());

/**
 * The seeded DEC-03 matrix exempts sales documents, which is the approved default. These
 * journeys are about what happens when a document IS in scope, so they publish a version
 * that puts sales and purchase in scope above a low threshold.
 */
async function requireApprovalFor(docTypes: string[], minAmount = '100000') {
  await runTx(admin, (t) =>
    policy.publish(t, {
      key: 'approval.matrix',
      effectiveFrom: '2020-01-01',
      note: 'STEP 10 통합시험',
      config: {
        creditLimit: 'BLOCK',
        rules: [
          ...docTypes.map((docType) => ({ docType, mode: 'REQUIRED' as const, minAmount })),
          { docType: 'PURCHASE_REQUEST', mode: 'REQUIRED' as const },
          { docType: 'JOURNAL', mode: 'REQUIRED' as const, minAmount: '5000000' },
        ],
      },
    }),
  );
}

/** Stock the warehouse so a sale has something to issue. Exempt so it needs no approval. */
async function stockUp(qty: string, unitCost: string, docDate = '2026-06-01') {
  const doc = await runTx(admin, (t) =>
    purchase.createDocument(t, {
      docDate,
      partnerId: supplierId,
      warehouseId,
      lines: [{ itemId: itemA, quantity: qty, unitPrice: unitCost, taxType: 'TAXABLE' }],
    }),
  );
  await runTx(admin, (t) => purchase.confirmDocument(t, doc.id, doc.version));
  return doc;
}

async function approveFully(documentId: string, approver: Actor = manager) {
  for (let i = 0; i < 5; i++) {
    const doc = await prisma.approvalDocument.findUniqueOrThrow({ where: { id: documentId } });
    if (doc.status !== 'IN_PROGRESS') return doc;
    await runTx(approver, (t) => approval.approve(t, { documentId, version: doc.version }));
  }
  return prisma.approvalDocument.findUniqueOrThrow({ where: { id: documentId } });
}

async function onHand(): Promise<string> {
  const sum = await prisma.inventoryLedger.aggregate({ where: { itemId: itemA }, _sum: { quantity: true } });
  return (sum._sum.quantity ?? 0).toString();
}

// ─────────────────────────── E2E-01 ───────────────────────────

describe('E2E-01: 견적에서 수금까지, 결재를 거쳐서', () => {
  it('견적→주문→매출전표→결재→확정→출고→분개→수금→채권소진', async () => {
    await requireApprovalFor(['SALES']);
    await stockUp('50', '4000');

    const quote = await runTx(admin, (t) =>
      quotation.create(t, {
        docDate: '2026-06-10',
        partnerId: customerId,
        lines: [{ itemId: itemA, quantity: '10', unitPrice: '50000', taxType: 'TAXABLE' }],
      }),
    );

    const order = await runTx(admin, (t) =>
      quotation.convertToOrder(t, quote.id, {
        lines: quote.lines.map((l) => ({ sourceLineId: l.id, quantity: l.quantity.toString() })),
      }),
    );

    const doc = await runTx(admin, (t) =>
      salesDocument.create(t, {
        docDate: '2026-06-11',
        partnerId: customerId,
        warehouseId,
        lines: order.lines.map((l) => ({
          itemId: l.itemId,
          quantity: l.quantity.toString(),
          unitPrice: l.unitPrice.toString(),
          taxType: l.taxType,
          sourceLineId: l.id,
        })),
      }),
    );

    // APV-08: over the threshold, so the document refuses to confirm on its own
    await expect(
      runTx(admin, (t) =>
        documents.confirmBusinessDocument(t, {
          type: 'SALES_DOCUMENT',
          id: doc.id,
          version: doc.version,
        }),
      ),
    ).rejects.toThrow(/결재/);

    const submitted = await runTx(drafter, (t) =>
      documentSubmit.submitForApproval(t, {
        type: 'SALES_DOCUMENT',
        id: doc.id,
        version: doc.version,
        note: '통합시험 상신',
      }),
    );

    // nothing has happened to the books yet
    expect(await prisma.receivable.count()).toBe(0);
    const pending = await prisma.salesDocument.findUniqueOrThrow({ where: { id: doc.id } });
    expect(pending.status).toBe('PENDING_APPROVAL');

    await approveFully(submitted.id);

    // the approval callback did the whole confirm, in the approval's own transaction
    const confirmed = await prisma.salesDocument.findUniqueOrThrow({ where: { id: doc.id } });
    expect(confirmed.status).toBe('CONFIRMED');
    expect(confirmed.confirmedAt).not.toBeNull();

    expect(await onHand()).toBe('40'); // 50 in, 10 out

    const receivable = await prisma.receivable.findUniqueOrThrow({ where: { documentId: doc.id } });
    expect(receivable.amount.toString()).toBe('550000'); // 500,000 + 50,000 VAT
    expect(receivable.status).toBe('OPEN');

    const entry = await prisma.journalEntry.findFirstOrThrow({
      where: { sourceType: 'SALES', sourceId: doc.id },
      include: { lines: { include: { account: true } } },
    });
    const byAccount = Object.fromEntries(
      entry.lines.map((l) => [l.account.code, { d: l.debit.toString(), c: l.credit.toString() }]),
    );
    expect(byAccount['110']?.d).toBe('550000'); // 외상매출금
    expect(byAccount['401']?.c).toBe('500000'); // 매출
    expect(byAccount['220']?.c).toBe('50000'); // 부가세예수금
    expect(byAccount['501']?.d).toBe('40000'); // 매출원가 10 x 4,000

    // the order is now fully delivered
    const after = await prisma.salesOrder.findUniqueOrThrow({ where: { id: order.id } });
    expect(after.status).toBe('COMPLETED');

    // SLS-10: money comes in and the receivable goes to zero
    const receipt = await runTx(admin, (t) =>
      settlement.create(t, {
        docType: 'RECEIPT',
        docDate: '2026-06-20',
        partnerId: customerId,
        amount: '550000',
      }),
    );
    await runTx(admin, (t) => settlement.autoAllocate(t, receipt.id));
    const loadedReceipt = await prisma.settlement.findUniqueOrThrow({ where: { id: receipt.id } });
    await runTx(admin, (t) => settlement.confirm(t, receipt.id, loadedReceipt.version));

    const settled = await prisma.receivable.findUniqueOrThrow({ where: { documentId: doc.id } });
    expect(settled.status).toBe('SETTLED');
    expect(settled.settledAmount.toString()).toBe('550000');
  });
});

// ─────────────────────────── E2E-02 ───────────────────────────

describe('E2E-02: 구매요청에서 지급까지, 결재를 거쳐서', () => {
  it('구매요청→결재→발주→입고·매입→분개→지급→채무소진', async () => {
    await requireApprovalFor(['PURCHASE']);

    const request = await runTx(admin, (t) =>
      purchase.createRequest(t, {
        docDate: '2026-06-05',
        lines: [{ itemId: itemA, quantity: '20', unitPrice: '5000', suggestedSupplierId: supplierId }],
      }),
    );

    // SLS-13: an unapproved request cannot become a purchase order
    await expect(
      runTx(admin, (t) =>
        purchase.convertRequestToOrder(t, request.id, {
          partnerId: supplierId,
          lines: request.lines.map((l) => ({ sourceLineId: l.id, quantity: l.quantity.toString() })),
        }),
      ),
    ).rejects.toThrow(/승인/);

    const approvalDoc = await runTx(drafter, (t) =>
      approval.draft(t, {
        docNo: 'AP-INT-PR',
        formCode: 'PURCHASE_REQUEST',
        title: '통합 구매요청',
        content: { purpose: '통합시험', requiredDate: '2026-06-20', amount: '100000' },
        amount: '100000',
        departmentId: deptId,
        target: { targetType: 'PURCHASE_REQUEST', targetId: request.id, targetVersion: request.version },
      }),
    );
    await runTx(drafter, (t) =>
      approval.submit(t, { documentId: approvalDoc.id, version: approvalDoc.version }),
    );
    await approveFully(approvalDoc.id);

    const approvedRequest = await prisma.purchaseRequest.findUniqueOrThrow({ where: { id: request.id } });
    expect(approvedRequest.status).toBe('APPROVED');

    const order = await runTx(admin, (t) =>
      purchase.convertRequestToOrder(t, request.id, {
        partnerId: supplierId,
        lines: request.lines.map((l) => ({ sourceLineId: l.id, quantity: '20' })),
      }),
    );
    expect(order.lines).toHaveLength(1);

    const doc = await runTx(admin, (t) =>
      purchase.createDocument(t, {
        docDate: '2026-06-12',
        partnerId: supplierId,
        warehouseId,
        lines: [{ itemId: itemA, quantity: '20', unitPrice: '5000', taxType: 'TAXABLE' }],
      }),
    );

    const submitted = await runTx(drafter, (t) =>
      documentSubmit.submitForApproval(t, {
        type: 'PURCHASE_DOCUMENT',
        id: doc.id,
        version: doc.version,
      }),
    );
    expect(await prisma.payable.count()).toBe(0);
    await approveFully(submitted.id);

    expect(await onHand()).toBe('20');
    const payable = await prisma.payable.findUniqueOrThrow({ where: { documentId: doc.id } });
    expect(payable.amount.toString()).toBe('110000');

    const entry = await prisma.journalEntry.findFirstOrThrow({
      where: { sourceType: 'PURCHASE', sourceId: doc.id },
      include: { lines: { include: { account: true } } },
    });
    const codes = entry.lines.map((l) => l.account.code);
    expect(codes).toContain('210'); // 외상매입금

    const payment = await runTx(admin, (t) =>
      settlement.create(t, {
        docType: 'PAYMENT',
        docDate: '2026-06-25',
        partnerId: supplierId,
        amount: '110000',
      }),
    );
    await runTx(admin, (t) => settlement.autoAllocate(t, payment.id));
    const loadedPayment = await prisma.settlement.findUniqueOrThrow({ where: { id: payment.id } });
    await runTx(admin, (t) => settlement.confirm(t, payment.id, loadedPayment.version));

    const settledPayable = await prisma.payable.findUniqueOrThrow({ where: { documentId: doc.id } });
    expect(settledPayable.status).toBe('SETTLED');
  });
});

// ─────────────────────────── E2E-04 ───────────────────────────

describe('E2E-04 / APV-12: 결재로 확정한 전표의 취소', () => {
  it('직접 취소는 거부되고, 취소 결재가 승인되면 재고·채권·분개가 함께 원복된다', async () => {
    await requireApprovalFor(['SALES']);
    await stockUp('30', '4000');

    const doc = await runTx(admin, (t) =>
      salesDocument.create(t, {
        docDate: '2026-06-11',
        partnerId: customerId,
        warehouseId,
        lines: [{ itemId: itemA, quantity: '5', unitPrice: '50000', taxType: 'TAXABLE' }],
      }),
    );
    const submitted = await runTx(drafter, (t) =>
      documentSubmit.submitForApproval(t, { type: 'SALES_DOCUMENT', id: doc.id, version: doc.version }),
    );
    await approveFully(submitted.id);

    const confirmed = await prisma.salesDocument.findUniqueOrThrow({ where: { id: doc.id } });
    expect(confirmed.status).toBe('CONFIRMED');
    expect(await onHand()).toBe('25');

    // APV-12: the approval record and the document must not disagree, so the direct cancel
    // is refused and the operator is pointed at the cancellation approval
    await expect(
      runTx(admin, (t) =>
        documents.cancelBusinessDocument(t, {
          type: 'SALES_DOCUMENT',
          id: doc.id,
          reason: '직접 취소 시도',
          version: confirmed.version,
        }),
      ),
    ).rejects.toThrow(/취소 상신/);

    const cancelDoc = await runTx(drafter, (t) =>
      documentSubmit.submitCancellation(t, {
        type: 'SALES_DOCUMENT',
        id: doc.id,
        reason: '고객 주문 철회',
      }),
    );
    const cancelDocRow = await prisma.approvalDocument.findUniqueOrThrow({ where: { id: cancelDoc.id } });
    await runTx(drafter, (t) =>
      approval.submit(t, { documentId: cancelDoc.id, version: cancelDocRow.version }),
    );
    await approveFully(cancelDoc.id);

    // INT-07: opposite rows, not deleted rows
    const canceled = await prisma.salesDocument.findUniqueOrThrow({ where: { id: doc.id } });
    expect(canceled.status).toBe('CANCELED');
    expect(await onHand()).toBe('30');

    const rows = await prisma.inventoryLedger.findMany({
      where: { sourceType: 'SALES', sourceId: doc.id },
      orderBy: { sourceVersion: 'asc' },
    });
    expect(rows).toHaveLength(2);
    expect(rows[0]!.quantity.toString()).toBe('-5');
    expect(rows[1]!.quantity.toString()).toBe('5');

    const receivable = await prisma.receivable.findUniqueOrThrow({ where: { documentId: doc.id } });
    expect(receivable.status).toBe('CANCELED');

    const entries = await prisma.journalEntry.findMany({
      where: { sourceType: 'SALES', sourceId: doc.id },
      orderBy: { sourceVersion: 'asc' },
    });
    expect(entries).toHaveLength(2);
    expect(entries[0]!.status).toBe('CANCELED');
    expect(entries[1]!.reversalOfId).toBe(entries[0]!.id);
  });
});

// ─────────────────────────── DEC-03 for manual journals ───────────────────────────

describe('DEC-03: 수동전표 결재', () => {
  const bigEntry = async () => {
    const cash = await prisma.account.findUniqueOrThrow({ where: { code: '101' } });
    const sales = await prisma.account.findUniqueOrThrow({ where: { code: '401' } });
    return runTx(admin, (t) =>
      journal.create(t, {
        entryDate: '2026-06-15',
        description: '대형 수동전표',
        lines: [
          { accountId: cash.id, debit: '9000000' },
          { accountId: sales.id, credit: '9000000' },
        ],
      }),
    );
  };

  it('기준금액 이상 수동전표는 직접 확정되지 않는다', async () => {
    const entry = await bigEntry();
    await expect(runTx(admin, (t) => journal.confirm(t, entry.id, entry.version))).rejects.toThrow(
      /결재 상신/,
    );
  });

  it('결재가 승인되면 확정되고 원장에 반영된다', async () => {
    const entry = await bigEntry();
    const submitted = await runTx(drafter, (t) =>
      documentSubmit.submitForApproval(t, {
        type: 'JOURNAL_ENTRY',
        id: entry.id,
        version: entry.version,
      }),
    );
    expect((await prisma.journalEntry.findUniqueOrThrow({ where: { id: entry.id } })).status).toBe(
      'PENDING_APPROVAL',
    );

    await approveFully(submitted.id);
    const confirmed = await prisma.journalEntry.findUniqueOrThrow({ where: { id: entry.id } });
    expect(confirmed.status).toBe('CONFIRMED');
    expect(confirmed.confirmedAt).not.toBeNull();
  });

  it('업무전표에서 생성된 분개는 따로 결재하지 않는다', async () => {
    await stockUp('10', '4000');
    const posted = await prisma.journalEntry.findFirstOrThrow({ where: { sourceType: 'PURCHASE' } });
    expect(posted.status).toBe('CONFIRMED');
  });
});

// ─────────────────────────── fault injection ───────────────────────────

describe('장애주입', () => {
  it('B-08: 재고가 성공한 뒤 회계에서 실패하면 재고도 채권도 남지 않는다', async () => {
    await stockUp('20', '4000');
    const before = await onHand();

    const doc = await runTx(admin, (t) =>
      salesDocument.create(t, {
        docDate: '2026-06-11',
        partnerId: customerId,
        warehouseId,
        lines: [{ itemId: itemA, quantity: '5', unitPrice: '50000', taxType: 'TAXABLE' }],
      }),
    );

    /**
     * The fault is a real one, not a mock: the account mapping the sales posting rule needs
     * is removed, which is exactly what a half-configured chart of accounts looks like. It
     * fails at the seam STEP 10 asks about — the stock rows are already written when the
     * journal step gives up — and it fails the way production would.
     */
    const removed = await prisma.accountMapping.findUniqueOrThrow({ where: { slot: 'SALES' } });
    await prisma.accountMapping.delete({ where: { slot: 'SALES' } });
    try {
      await expect(runTx(admin, (t) => salesDocument.confirm(t, doc.id, doc.version))).rejects.toThrow(
        /자동분개 계정/,
      );
    } finally {
      await prisma.accountMapping.create({
        data: { slot: removed.slot, label: removed.label, accountId: removed.accountId },
      });
    }

    expect(await onHand()).toBe(before);
    expect(await prisma.receivable.count({ where: { documentId: doc.id } })).toBe(0);
    expect(await prisma.journalEntry.count({ where: { sourceId: doc.id } })).toBe(0);
    const after = await prisma.salesDocument.findUniqueOrThrow({ where: { id: doc.id } });
    expect(after.status).toBe('DRAFT');
  });

  it('INT-05: 같은 결재를 동시에 두 번 승인해도 부작용은 한 번만 생긴다', async () => {
    await requireApprovalFor(['SALES']);
    await stockUp('30', '4000');

    const doc = await runTx(admin, (t) =>
      salesDocument.create(t, {
        docDate: '2026-06-11',
        partnerId: customerId,
        warehouseId,
        lines: [{ itemId: itemA, quantity: '5', unitPrice: '50000', taxType: 'TAXABLE' }],
      }),
    );
    const submitted = await runTx(drafter, (t) =>
      documentSubmit.submitForApproval(t, { type: 'SALES_DOCUMENT', id: doc.id, version: doc.version }),
    );
    const row = await prisma.approvalDocument.findUniqueOrThrow({ where: { id: submitted.id } });

    const results = await Promise.allSettled([
      runTx(manager, (t) => approval.approve(t, { documentId: submitted.id, version: row.version })),
      runTx(manager, (t) => approval.approve(t, { documentId: submitted.id, version: row.version })),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);

    // one confirm means one of everything
    expect(await prisma.receivable.count({ where: { documentId: doc.id } })).toBe(1);
    expect(await prisma.journalEntry.count({ where: { sourceType: 'SALES', sourceId: doc.id } })).toBe(1);
    expect(await prisma.inventoryLedger.count({ where: { sourceType: 'SALES', sourceId: doc.id } })).toBe(1);
    expect(await onHand()).toBe('25');
  });

  it('INT-10: 커밋 뒤 전송이 실패해도 업무 데이터는 남고 아웃박스만 재시도된다', async () => {
    const { enqueue } = await import('@/server/modules/outbox/service');
    const sale = await runTx(admin, (t) =>
      salesDocument.create(t, {
        docDate: '2026-06-11',
        partnerId: customerId,
        warehouseId,
        lines: [{ itemId: itemA, quantity: '1', unitPrice: '1000', taxType: 'TAXABLE' }],
      }),
    );

    /**
     * A row the current build cannot dispatch — what an older deploy's topic looks like
     * after a release — standing in for delivery failing after the business commit. No
     * mocking: the worker really runs and really fails on this row. It goes in with raw
     * SQL precisely because the typed enqueue would not accept an unknown topic.
     */
    const badKey = `int-broken:${sale.id}`;
    const goodKey = `int-ok:${sale.id}`;
    await prisma.$executeRawUnsafe(
      `INSERT INTO "OutboxEvent" ("id", "topic", "payload", "dedupKey", "status", "attempt", "nextAttemptAt", "createdAt", "updatedAt")
       VALUES (gen_random_uuid()::text, 'email.retired', '{"to":"buyer@example.com"}'::jsonb, $1, 'PENDING', 0, NOW(), NOW(), NOW())`,
      badKey,
    );
    await runTx(admin, (t) =>
      enqueue(t, {
        topic: 'email.send',
        payload: { to: 'buyer@example.com', subject: '통합시험', text: '본문' },
        dedupKey: goodKey,
      }),
    );

    await tick();

    // the business document is untouched; only the outbox row carries the failure
    const stillThere = await prisma.salesDocument.findUniqueOrThrow({ where: { id: sale.id } });
    expect(stillThere.docNo).toBe(sale.docNo);

    const failed = await prisma.outboxEvent.findFirstOrThrow({ where: { dedupKey: badKey } });
    expect(failed.status).toBe('PENDING'); // scheduled for another go, not lost
    expect(failed.attempt).toBe(1);
    expect(failed.lastError).toContain('unknown outbox topic');
    expect(failed.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());

    // a healthy delivery in the same batch is unaffected by its neighbour's failure
    const ok = await prisma.outboxEvent.findFirstOrThrow({ where: { dedupKey: goodKey } });
    expect(ok.status).toBe('DONE');
  });

  it('제출 후 마감된 기간의 전표는 승인 콜백에서 거부되고 결재도 함께 되돌아간다', async () => {
    await requireApprovalFor(['SALES']);
    await stockUp('30', '4000', '2026-05-02');

    const doc = await runTx(admin, (t) =>
      salesDocument.create(t, {
        docDate: '2026-05-10',
        partnerId: customerId,
        warehouseId,
        lines: [{ itemId: itemA, quantity: '5', unitPrice: '50000', taxType: 'TAXABLE' }],
      }),
    );
    const submitted = await runTx(drafter, (t) =>
      documentSubmit.submitForApproval(t, { type: 'SALES_DOCUMENT', id: doc.id, version: doc.version }),
    );

    // the month closes while the document sits in someone's inbox
    await runTx(admin, (t) => accountingPeriod.close(t, '2026-05'));

    const row = await prisma.approvalDocument.findUniqueOrThrow({ where: { id: submitted.id } });
    await expect(
      runTx(manager, (t) => approval.approve(t, { documentId: submitted.id, version: row.version })),
    ).rejects.toThrow(/마감/);

    // B-08: the approval rolled back with the business effect, so it can be approved again
    // once the period is reopened rather than being left half-done
    const stillPending = await prisma.approvalDocument.findUniqueOrThrow({ where: { id: submitted.id } });
    expect(stillPending.status).toBe('IN_PROGRESS');
    expect(await prisma.receivable.count({ where: { documentId: doc.id } })).toBe(0);
    expect(await prisma.journalEntry.count({ where: { sourceId: doc.id } })).toBe(0);
  });
});

// ─────────────────────────── the orchestration contract ───────────────────────────

describe('confirmBusinessDocument 계약', () => {
  it('결재가 진행 중인 전표는 정책이 바뀌어도 직접 확정되지 않는다', async () => {
    await requireApprovalFor(['SALES']);
    await stockUp('30', '4000');

    const doc = await runTx(admin, (t) =>
      salesDocument.create(t, {
        docDate: '2026-06-11',
        partnerId: customerId,
        warehouseId,
        lines: [{ itemId: itemA, quantity: '5', unitPrice: '50000', taxType: 'TAXABLE' }],
      }),
    );
    await runTx(drafter, (t) =>
      documentSubmit.submitForApproval(t, { type: 'SALES_DOCUMENT', id: doc.id, version: doc.version }),
    );

    // the threshold is raised far above this document while it is in approval, so the
    // amount check alone would now say "no approval needed" and let it through
    await requireApprovalFor(['SALES'], '999999999');

    const pending = await prisma.salesDocument.findUniqueOrThrow({ where: { id: doc.id } });
    await expect(
      runTx(admin, (t) =>
        documents.confirmBusinessDocument(t, {
          type: 'SALES_DOCUMENT',
          id: doc.id,
          version: pending.version,
        }),
      ),
    ).rejects.toThrow(/결재 진행 중/);
  });

  it('결재 대상이 아닌 전표는 상신할 수 없다', async () => {
    await stockUp('30', '4000');
    const doc = await runTx(admin, (t) =>
      salesDocument.create(t, {
        docDate: '2026-06-11',
        partnerId: customerId,
        warehouseId,
        lines: [{ itemId: itemA, quantity: '1', unitPrice: '1000', taxType: 'TAXABLE' }],
      }),
    );
    await expect(
      runTx(drafter, (t) =>
        documentSubmit.submitForApproval(t, {
          type: 'SALES_DOCUMENT',
          id: doc.id,
          version: doc.version,
        }),
      ),
    ).rejects.toThrow(/결재 없이/);
  });

  it('알 수 없는 전표유형은 조용히 넘어가지 않는다', async () => {
    await expect(
      runTx(admin, (t) =>
        documents.confirmBusinessDocument(t, {
          type: 'NOT_A_TYPE' as never,
          id: 'x',
          version: 1,
        }),
      ),
    ).rejects.toThrow(AppError);
  });
});

// ─────────────────────────── reversal dating ───────────────────────────

describe('DEC-04: 역분개 일자는 두 달력을 모두 본다', () => {
  it('회계는 열려 있고 재고 평가만 마감된 달에는 역분개가 다음 열린 달로 간다', async () => {
    const original = new Date('2026-05-10T00:00:00.000Z');
    await prisma.inventoryValuationPeriod.upsert({
      where: { period: '2026-05' },
      create: { period: '2026-05', status: 'CLOSED' },
      update: { status: 'CLOSED' },
    });

    const date = await withTransaction(
      prisma,
      { actor: admin, requestId: 'rev-1', now: new Date() },
      (t: TransactionContext) =>
        import('@/server/modules/documents/reversal').then((m) =>
          m.reversalDate(t, original, ['ACCOUNTING', 'INVENTORY']),
        ),
    );
    expect(date.toISOString().slice(0, 10)).toBe('2026-06-01');
  });

  it('두 달력이 모두 열려 있으면 원전표 일자를 그대로 쓴다', async () => {
    const original = new Date('2026-06-10T00:00:00.000Z');
    const date = await withTransaction(
      prisma,
      { actor: admin, requestId: 'rev-2', now: new Date() },
      (t: TransactionContext) =>
        import('@/server/modules/documents/reversal').then((m) =>
          m.reversalDate(t, original, ['ACCOUNTING', 'INVENTORY']),
        ),
    );
    expect(date.toISOString().slice(0, 10)).toBe('2026-06-10');
  });
});

// ─────────────────────────── ledger is the truth ───────────────────────────

describe('INT-04: 원장이 진실이다', () => {
  it('결재로 확정한 매출 뒤에도 캐시와 원장이 일치한다', async () => {
    await requireApprovalFor(['SALES']);
    await stockUp('40', '4000');

    const doc = await runTx(admin, (t) =>
      salesDocument.create(t, {
        docDate: '2026-06-11',
        partnerId: customerId,
        warehouseId,
        lines: [{ itemId: itemA, quantity: '7', unitPrice: '50000', taxType: 'TAXABLE' }],
      }),
    );
    const submitted = await runTx(drafter, (t) =>
      documentSubmit.submitForApproval(t, { type: 'SALES_DOCUMENT', id: doc.id, version: doc.version }),
    );
    await approveFully(submitted.id);

    const drift = await runTx(admin, (t) => ledger.reconcile(t));
    expect(drift).toHaveLength(0);
  });
});
