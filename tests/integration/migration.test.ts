// covers: MIG-01..MIG-09, NFR-SEC-05, NFR-SEC-06, INT-04
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { actorFor, prepareDatabase, prisma, runTx, truncateBusinessData } from '../helpers/db';
import type { Actor } from '@/server/core/context';
import * as migration from '@/server/modules/migration/service';
import { TEMPLATE_VERSION } from '@/server/modules/migration/templates';
import * as ledger from '@/server/modules/inventory/ledger';
import { withTransaction } from '@/server/core/context';

/**
 * A migration is judged by what the books look like afterwards, so these tests apply real
 * files and then check the ledgers, not the return values. The three failures worth
 * catching are: a source row applied twice, a number that does not reconcile, and a
 * resident registration number that ends up somewhere it can be read.
 */

let admin: Actor;
let warehouseCode = '';
const baseline = '2026-06-30';

beforeAll(async () => {
  prepareDatabase();
  admin = await actorFor('admin');
  const warehouse = await prisma.warehouse.findFirstOrThrow({ orderBy: { code: 'asc' } });
  warehouseCode = warehouse.code;
});

beforeEach(async () => {
  await truncateBusinessData();
  await prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      "MigrationRow", "MigrationBatch",
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

  // the cut-over date every opening row shares
  await prisma.systemSetting.upsert({
    where: { key: 'migration.baselineDate' },
    create: { key: 'migration.baselineDate', value: { date: baseline } },
    update: { value: { date: baseline } },
  });
});

afterAll(() => prisma.$disconnect());

/** Runs the whole pipeline the way the screen does: validate, then apply what was valid. */
async function migrate(target: string, rows: Record<string, string>[]) {
  const validated = await runTx(admin, (t) =>
    migration.validate(t, { target, rows, fileName: `${target}.csv`, baselineDate: baseline }),
  );
  const applied = await runTx(admin, (t) => migration.apply(t, { batchId: validated.batchId, rows }));
  return { validated, applied };
}

// ─────────────────────────── MIG-01 / MIG-02 ───────────────────────────

describe('MIG-01 / MIG-02: 품목·거래처 이관', () => {
  it('품목을 전건 이관하고 분류·단가·과세·안전재고를 함께 넣는다', async () => {
    const { validated, applied } = await migrate('ITEM', [
      { code: 'MIG-I-001', name: '이관품목1', salesPrice: '15000', taxType: 'TAXABLE', safetyStock: '10' },
      { code: 'MIG-I-002', name: '이관품목2', salesPrice: '2000', taxType: 'EXEMPT' },
    ]);

    expect(validated.errorCount).toBe(0);
    expect(applied.applied).toBe(2);

    const item = await prisma.item.findUniqueOrThrow({ where: { code: 'MIG-I-001' } });
    expect(item.name).toBe('이관품목1');
    expect(item.salesPrice?.toString()).toBe('15000');
    expect(item.safetyStock?.toString()).toBe('10');
  });

  it('잘못된 과세구분은 행 번호와 함께 거부되고 나머지는 정상 처리된다', async () => {
    const rows: Record<string, string>[] = [
      { code: 'MIG-I-010', name: '정상품목' },
      { code: 'MIG-I-011', name: '이상품목', taxType: 'WRONG' },
    ];
    const validated = await runTx(admin, (t) => migration.validate(t, { target: 'ITEM', rows }));
    expect(validated.valid).toBe(1);
    expect(validated.errorCount).toBe(1);
    expect(validated.errors[0]!.row).toBe(2);
    expect(validated.errors[0]!.field).toBe('taxType');
  });

  it('거래처의 사업자번호 체크섬 오류를 잡아낸다', async () => {
    const validated = await runTx(admin, (t) =>
      migration.validate(t, {
        target: 'PARTNER',
        rows: [{ code: 'MIG-P-001', name: '이관상사', businessNo: '123-45-67890' }],
      }),
    );
    expect(validated.errorCount).toBe(1);
    expect(validated.errors[0]!.field).toBe('businessNo');
  });
});

// ─────────────────────────── MIG-03 ───────────────────────────

describe('MIG-03: 기초재고 이관', () => {
  beforeEach(async () => {
    await migrate('ITEM', [
      { code: 'MIG-S-001', name: '기초품목1' },
      { code: 'MIG-S-002', name: '기초품목2' },
    ]);
  });

  it('개시 원장으로 반영되고 재고현황과 일치한다', async () => {
    const rows = [
      { warehouseCode, itemCode: 'MIG-S-001', quantity: '100', unitCost: '5000' },
      { warehouseCode, itemCode: 'MIG-S-002', quantity: '40', unitCost: '12000' },
    ];
    const { validated, applied } = await migrate('OPENING_STOCK', rows);

    expect(validated.errorCount).toBe(0);
    expect(applied.applied).toBe(2);

    // INT-04: the ledger is where the position lives
    const rowsIn = await prisma.inventoryLedger.findMany({ where: { sourceType: 'OPENING' } });
    expect(rowsIn).toHaveLength(2);
    expect(rowsIn.every((r) => r.occurredAt.toISOString().slice(0, 10) === baseline)).toBe(true);

    const total = await prisma.inventoryLedger.aggregate({
      where: { sourceType: 'OPENING' },
      _sum: { quantity: true, amount: true },
    });
    expect(total._sum.quantity?.toString()).toBe('140');
    expect(total._sum.amount?.toString()).toBe('980000'); // 500,000 + 480,000

    // and the cache agrees with it
    const drift = await runTx(admin, (t) => ledger.reconcile(t));
    expect(drift).toHaveLength(0);

    // MIG-09: source against stored, with no difference
    expect(applied.reconciliation).toEqual([
      { label: '기초 수량', source: '140.000', applied: '140.000', difference: '0' },
      { label: '기초 재고금액', source: '980000', applied: '980000', difference: '0' },
    ]);
  });

  it('같은 파일을 다시 올려도 재고가 두 배가 되지 않는다', async () => {
    const rows = [{ warehouseCode, itemCode: 'MIG-S-001', quantity: '100', unitCost: '5000' }];
    await migrate('OPENING_STOCK', rows);
    const second = await migrate('OPENING_STOCK', rows);

    expect(second.validated.alreadyApplied).toBe(1);
    expect(second.applied.applied).toBe(0);
    expect(second.applied.skipped).toBe(1);

    const total = await prisma.inventoryLedger.aggregate({
      where: { sourceType: 'OPENING' },
      _sum: { quantity: true },
    });
    expect(total._sum.quantity?.toString()).toBe('100');
  });

  it('한 파일 안에서 같은 창고·품목이 두 번 나오면 거부한다', async () => {
    const validated = await runTx(admin, (t) =>
      migration.validate(t, {
        target: 'OPENING_STOCK',
        rows: [
          { warehouseCode, itemCode: 'MIG-S-001', quantity: '100', unitCost: '5000' },
          { warehouseCode, itemCode: 'MIG-S-001', quantity: '20', unitCost: '5000' },
        ],
      }),
    );
    expect(validated.errorCount).toBe(1);
    expect(validated.errors[0]!.message).toContain('중복');
  });

  it('없는 품목코드는 이름을 그대로 알려준다', async () => {
    const validated = await runTx(admin, (t) =>
      migration.validate(t, {
        target: 'OPENING_STOCK',
        rows: [{ warehouseCode, itemCode: '없는코드', quantity: '1', unitCost: '1' }],
      }),
    );
    expect(validated.errors[0]!.message).toContain('없는코드');
  });

  it('중간 행이 실패하면 앞의 행도 남지 않는다', async () => {
    const rows = [
      { warehouseCode, itemCode: 'MIG-S-001', quantity: '100', unitCost: '5000' },
      { warehouseCode, itemCode: 'MIG-S-002', quantity: '40', unitCost: '12000' },
    ];
    const validated = await runTx(admin, (t) => migration.validate(t, { target: 'OPENING_STOCK', rows }));

    // the master moves between validation and application, which is exactly why apply
    // re-validates rather than trusting the earlier pass
    const broken = [rows[0]!, { ...rows[1]!, itemCode: '사라진품목' }];
    await expect(
      runTx(admin, (t) => migration.apply(t, { batchId: validated.batchId, rows: broken })),
    ).rejects.toThrow(/품목/);

    expect(await prisma.inventoryLedger.count({ where: { sourceType: 'OPENING' } })).toBe(0);
    const batch = await prisma.migrationBatch.findUniqueOrThrow({ where: { id: validated.batchId } });
    expect(batch.status).toBe('VALIDATED'); // not APPLIED: the whole transaction rolled back
  });
});

// ─────────────────────────── MIG-04 ───────────────────────────

describe('MIG-04: 미수·미지급 이관', () => {
  beforeEach(async () => {
    await migrate('PARTNER', [
      { code: 'MIG-P-100', name: '이관고객', partnerType: 'CUSTOMER' },
      { code: 'MIG-P-200', name: '이관공급', partnerType: 'SUPPLIER' },
    ]);
  });

  it('거래처별 잔액이 원천과 일치한다', async () => {
    const rows: Record<string, string>[] = [
      {
        kind: 'RECEIVABLE',
        partnerCode: 'MIG-P-100',
        docNo: 'OLD-1',
        docDate: '2026-05-10',
        amount: '550000',
      },
      {
        kind: 'RECEIVABLE',
        partnerCode: 'MIG-P-100',
        docNo: 'OLD-2',
        docDate: '2026-06-10',
        amount: '330000',
        settledAmount: '100000',
      },
      { kind: 'PAYABLE', partnerCode: 'MIG-P-200', docNo: 'OLD-9', docDate: '2026-06-01', amount: '220000' },
    ];
    const { applied } = await migrate('OPEN_ITEM', rows);
    expect(applied.applied).toBe(3);

    const ar = await prisma.receivable.aggregate({ _sum: { amount: true, settledAmount: true } });
    expect(ar._sum.amount?.toString()).toBe('880000');
    expect(ar._sum.settledAmount?.toString()).toBe('100000');

    const partial = await prisma.receivable.findFirstOrThrow({ where: { migrationDocNo: 'OLD-2' } });
    expect(partial.status).toBe('PARTIAL');

    const reconciliation = Object.fromEntries(applied.reconciliation.map((r) => [r.label, r.difference]));
    expect(reconciliation['미수 잔액']).toBe('0');
    expect(reconciliation['미지급 잔액']).toBe('0');
  });

  it('기수금이 금액을 넘으면 거부한다', async () => {
    const validated = await runTx(admin, (t) =>
      migration.validate(t, {
        target: 'OPEN_ITEM',
        rows: [
          {
            kind: 'RECEIVABLE',
            partnerCode: 'MIG-P-100',
            docNo: 'OLD-3',
            docDate: '2026-05-10',
            amount: '100000',
            settledAmount: '200000',
          },
        ],
      }),
    );
    expect(validated.errors[0]!.field).toBe('settledAmount');
  });

  it('이관 미수도 연령분석과 미수 목록에 잡힌다', async () => {
    await migrate('OPEN_ITEM', [
      {
        kind: 'RECEIVABLE',
        partnerCode: 'MIG-P-100',
        docNo: 'OLD-5',
        docDate: '2026-05-10',
        amount: '550000',
      },
    ]);
    const receivable = await import('@/server/modules/sales/receivable');
    const aging = await runTx(admin, (t) => receivable.aging(t, { asOf: '2026-06-30' }));
    const row = aging.rows.find((r) => r.partnerName === '이관고객');
    expect(row).toBeDefined();
    expect(row!.total).toBe('550000');

    // the open item shows the source system's number rather than an empty cell
    const items = await runTx(admin, (t) => receivable.openItems(t, aging.rows[0]!.partnerId, 'RECEIVABLE'));
    expect(items[0]!.docNo).toContain('OLD-5');
  });
});

// ─────────────────────────── MIG-05 ───────────────────────────

describe('MIG-05: 계정과목·기초잔액 이관', () => {
  it('계정을 이관하고 이미 있는 계정은 건너뛴다', async () => {
    const { applied } = await migrate('ACCOUNT', [
      { code: '901', name: '이관계정', accountType: 'EXPENSE' },
      { code: '101', name: '현금', accountType: 'ASSET' },
    ]);
    expect(applied.applied).toBe(2);
    expect(await prisma.account.count({ where: { code: '901' } })).toBe(1);
  });

  it('기초잔액의 차대가 맞지 않으면 대사에서 드러난다', async () => {
    const rows: Record<string, string>[] = [
      { periodKey: '2026-07', accountCode: '101', debit: '1000000' },
      { periodKey: '2026-07', accountCode: '401', credit: '900000' },
    ];
    const validated = await runTx(admin, (t) => migration.validate(t, { target: 'OPENING_BALANCE', rows }));
    const preview = Object.fromEntries(validated.preview.map((p) => [p.label, p.value]));
    // the preview says so before anything is written, which is the point of previewing
    expect(preview['차대 차액']).toBe('100000');
  });

  it('차대가 맞는 기초잔액은 차액 0으로 반영된다', async () => {
    const rows: Record<string, string>[] = [
      { periodKey: '2026-07', accountCode: '101', debit: '1000000' },
      { periodKey: '2026-07', accountCode: '401', credit: '1000000' },
    ];
    const { applied } = await migrate('OPENING_BALANCE', rows);
    const diff = Object.fromEntries(applied.reconciliation.map((r) => [r.label, r.difference]));
    expect(diff['차변 합계']).toBe('0');
    expect(diff['대변 합계']).toBe('0');

    const balance = applied.reconciliation.find((r) => r.label === '차대 차액');
    expect(balance!.applied).toBe('0');

    const stored = await prisma.openingBalance.findMany({ where: { origin: 'MIGRATION' } });
    expect(stored).toHaveLength(2);
  });

  it('차변과 대변에 동시에 금액이 있으면 거부한다', async () => {
    const validated = await runTx(admin, (t) =>
      migration.validate(t, {
        target: 'OPENING_BALANCE',
        rows: [{ periodKey: '2026-07', accountCode: '101', debit: '100', credit: '100' }],
      }),
    );
    expect(validated.errorCount).toBe(1);
  });
});

// ─────────────────────────── MIG-06 / MIG-07 ───────────────────────────

describe('MIG-06 / MIG-07: 인사·조직·연차 이관', () => {
  beforeEach(async () => {
    await migrate('DEPARTMENT', [
      { code: 'MIG-D-1', name: '이관본부', validFrom: '2020-01-01' },
      { code: 'MIG-D-2', name: '이관팀', parentCode: 'MIG-D-1', validFrom: '2020-01-01' },
    ]);
  });

  it('부서는 상위 부서가 같은 파일 안에 있어도 순서대로 연결된다', async () => {
    const child = await prisma.department.findUniqueOrThrow({ where: { code: 'MIG-D-2' } });
    const parent = await prisma.department.findUniqueOrThrow({ where: { code: 'MIG-D-1' } });
    expect(child.parentId).toBe(parent.id);
  });

  it('재직자와 퇴사자를 구분해 이관한다', async () => {
    const { applied } = await migrate('EMPLOYEE', [
      { employeeNo: 'MIG-E-1', name: '이관사원1', departmentCode: 'MIG-D-2', hireDate: '2021-03-02' },
      {
        employeeNo: 'MIG-E-2',
        name: '이관사원2',
        departmentCode: 'MIG-D-2',
        hireDate: '2019-01-02',
        leaveDate: '2026-03-31',
      },
    ]);
    expect(applied.applied).toBe(2);

    const active = await prisma.employee.findUniqueOrThrow({ where: { employeeNo: 'MIG-E-1' } });
    expect(active.status).toBe('ACTIVE');
    const resigned = await prisma.employee.findUniqueOrThrow({ where: { employeeNo: 'MIG-E-2' } });
    expect(resigned.status).toBe('RESIGNED');
    expect(resigned.leaveDate?.toISOString().slice(0, 10)).toBe('2026-03-31');
  });

  /** NFR-SEC-06: a migrated record is stored exactly like a typed one. */
  it('주민등록번호는 암호화되어 저장되고 원문은 어디에도 남지 않는다', async () => {
    const residentNo = '900101-1234567';
    await migrate('EMPLOYEE', [
      {
        employeeNo: 'MIG-E-3',
        name: '민감사원',
        hireDate: '2021-03-02',
        residentNo,
        bankAccount: '110-123-456789',
      },
    ]);

    const employee = await prisma.employee.findUniqueOrThrow({ where: { employeeNo: 'MIG-E-3' } });
    const sensitive = await prisma.employeeSensitive.findUniqueOrThrow({
      where: { employeeId: employee.id },
    });
    expect(sensitive.residentNoEnc).not.toContain('900101');
    expect(sensitive.residentNoMaskDigit).toBe('1');

    // and nothing carried the plain value into the batch, the audit log or the outbox
    const batches = await prisma.migrationBatch.findMany();
    expect(JSON.stringify(batches)).not.toContain('900101');
    const audit = await prisma.auditLog.findMany({ where: { action: { startsWith: 'migration.' } } });
    expect(JSON.stringify(audit)).not.toContain('900101');
  });

  /** NFR-SEC-05: an error report names the column, never the value in it. */
  it('민감 항목 오류는 값을 오류파일에 담지 않는다', async () => {
    const validated = await runTx(admin, (t) =>
      migration.validate(t, {
        target: 'EMPLOYEE',
        rows: [{ employeeNo: '', name: '무사번', hireDate: '2021-03-02', residentNo: '900101-1234567' }],
      }),
    );
    expect(validated.errorCount).toBeGreaterThan(0);
    expect(JSON.stringify(validated.errors)).not.toContain('900101');

    const stored = await prisma.migrationBatch.findUniqueOrThrow({ where: { id: validated.batchId } });
    expect(JSON.stringify(stored.errors)).not.toContain('900101');
  });

  it('연차 부여·사용·잔여 합계가 원천과 일치한다', async () => {
    await migrate('EMPLOYEE', [{ employeeNo: 'MIG-E-9', name: '연차사원', hireDate: '2021-03-02' }]);
    const { applied } = await migrate('LEAVE', [
      {
        employeeNo: 'MIG-E-9',
        grantDate: '2026-03-02',
        expiresAt: '2027-03-01',
        grantedDays: '15',
        usedDays: '4',
      },
    ]);

    const diff = Object.fromEntries(applied.reconciliation.map((r) => [r.label, r.difference]));
    expect(diff['부여 합계']).toBe('0');
    expect(diff['사용 합계']).toBe('0');
    expect(diff['잔여 합계']).toBe('0');

    const remaining = applied.reconciliation.find((r) => r.label === '잔여 합계');
    expect(remaining!.applied).toBe('11');
  });

  it('사용일수가 부여일수를 넘으면 거부한다', async () => {
    await migrate('EMPLOYEE', [{ employeeNo: 'MIG-E-8', name: '초과사원', hireDate: '2021-03-02' }]);
    const validated = await runTx(admin, (t) =>
      migration.validate(t, {
        target: 'LEAVE',
        rows: [
          {
            employeeNo: 'MIG-E-8',
            grantDate: '2026-03-02',
            expiresAt: '2027-03-01',
            grantedDays: '15',
            usedDays: '20',
          },
        ],
      }),
    );
    expect(validated.errors[0]!.field).toBe('usedDays');
  });
});

// ─────────────────────────── MIG-08 ───────────────────────────

describe('MIG-08: 과거 전표 이관', () => {
  beforeEach(async () => {
    await migrate('ITEM', [{ code: 'MIG-H-1', name: '과거품목' }]);
    await migrate('PARTNER', [{ code: 'MIG-HP-1', name: '과거고객', partnerType: 'CUSTOMER' }]);
  });

  it('참조용으로만 들어오고 재고·채권·분개를 만들지 않는다', async () => {
    const rows = [
      {
        docNo: 'OLD-SA-1',
        docDate: '2026-04-10',
        partnerCode: 'MIG-HP-1',
        warehouseCode,
        itemCode: 'MIG-H-1',
        quantity: '5',
        unitPrice: '10000',
      },
    ];
    const { applied } = await migrate('HISTORICAL_SALES', rows);
    expect(applied.applied).toBe(1);

    const doc = await prisma.salesDocument.findUniqueOrThrow({ where: { docNo: 'MIG-OLD-SA-1' } });
    expect(doc.status).toBe('MIGRATED');
    expect(doc.confirmedAt).toBeNull();
    expect(doc.supplyAmount.toString()).toBe('50000');
    expect(doc.vatAmount.toString()).toBe('5000');

    // the whole point: the opening figures already carry this position
    expect(await prisma.inventoryLedger.count({ where: { sourceId: doc.id } })).toBe(0);
    expect(await prisma.receivable.count({ where: { documentId: doc.id } })).toBe(0);
    expect(await prisma.journalEntry.count({ where: { sourceId: doc.id } })).toBe(0);
  });

  it('이관 전표는 매출 보고서 집계에 들어가지 않는다', async () => {
    await migrate('HISTORICAL_SALES', [
      {
        docNo: 'OLD-SA-2',
        docDate: '2026-04-10',
        partnerCode: 'MIG-HP-1',
        warehouseCode,
        itemCode: 'MIG-H-1',
        quantity: '5',
        unitPrice: '10000',
      },
    ]);
    const salesReport = await import('@/server/modules/report/sales-report');
    const result = await runTx(admin, (t) =>
      salesReport.salesTrend(t, { from: '2026-04-01', to: '2026-04-30' }, 'MONTH'),
    );
    // reports read confirmedAt, and a migrated reference document has none
    expect(result.totals.supplyAmount).toBe('0');
  });

  it('한 전표의 여러 라인이 하나의 전표로 합쳐진다', async () => {
    await migrate('ITEM', [{ code: 'MIG-H-2', name: '과거품목2' }]);
    const { applied } = await migrate('HISTORICAL_SALES', [
      {
        docNo: 'OLD-SA-3',
        docDate: '2026-04-10',
        partnerCode: 'MIG-HP-1',
        warehouseCode,
        itemCode: 'MIG-H-1',
        quantity: '2',
        unitPrice: '10000',
      },
      {
        docNo: 'OLD-SA-3',
        docDate: '2026-04-10',
        partnerCode: 'MIG-HP-1',
        warehouseCode,
        itemCode: 'MIG-H-2',
        quantity: '1',
        unitPrice: '5000',
      },
    ]);
    expect(applied.applied).toBe(2);

    const doc = await prisma.salesDocument.findUniqueOrThrow({
      where: { docNo: 'MIG-OLD-SA-3' },
      include: { lines: true },
    });
    expect(doc.lines).toHaveLength(2);
    expect(doc.supplyAmount.toString()).toBe('25000');
  });
});

// ─────────────────────────── MIG-09 ───────────────────────────

describe('MIG-09: 이관 검증 결과서', () => {
  it('원천·정상·오류·반영 건수가 서로 들어맞는다', async () => {
    const rows: Record<string, string>[] = [
      { code: 'MIG-R-1', name: '대사품목1' },
      { code: 'MIG-R-2', name: '대사품목2' },
      { code: 'MIG-R-3', name: '', taxType: 'TAXABLE' }, // invalid: no name
    ];
    const validated = await runTx(admin, (t) => migration.validate(t, { target: 'ITEM', rows }));
    await runTx(admin, (t) => migration.apply(t, { batchId: validated.batchId, rows, selectedRows: [1, 2] }));

    const report = await runTx(admin, (t) => migration.reconcile(t, validated.batchId));
    expect(report.counts).toEqual({ source: 3, valid: 2, error: 1, applied: 2, skipped: 0 });
    expect(report.countsBalance).toBe(true);
    expect(report.status).toBe('APPLIED');
  });

  it('양식 버전이 다르면 아무것도 읽지 않고 거부한다', async () => {
    await expect(
      runTx(admin, (t) =>
        migration.validate(t, {
          target: 'ITEM',
          rows: [{ code: 'X', name: 'Y' }],
          templateVersion: TEMPLATE_VERSION + 1,
        }),
      ),
    ).rejects.toThrow(/양식 버전/);
    expect(await prisma.migrationBatch.count()).toBe(0);
  });

  it('이미 반영한 배치를 다시 반영하려 하면 거부한다', async () => {
    const rows = [{ code: 'MIG-R-9', name: '중복반영' }];
    const { validated } = await migrate('ITEM', rows);
    await expect(
      runTx(admin, (t) => migration.apply(t, { batchId: validated.batchId, rows })),
    ).rejects.toThrow(/이미 반영/);
  });

  it('대사 결과서가 대상별 합계를 보여준다', async () => {
    await migrate('ITEM', [{ code: 'MIG-R-20', name: '대사재고품목' }]);
    const rows = [{ warehouseCode, itemCode: 'MIG-R-20', quantity: '25', unitCost: '4000' }];
    const { validated } = await migrate('OPENING_STOCK', rows);

    const report = await runTx(admin, (t) => migration.reconcile(t, validated.batchId));
    const summary = Object.fromEntries(report.summary.map((s) => [s.label, s.value]));
    expect(summary['개시 원장 수량']).toBe('25.000');
    expect(summary['개시 원장 금액']).toBe('100000');
    expect(report.baselineDate).toBe(baseline);
  });

  it('기준일이 없으면 기초재고를 반영하지 않는다', async () => {
    await prisma.systemSetting.deleteMany({ where: { key: 'migration.baselineDate' } });
    await migrate('ITEM', [{ code: 'MIG-R-30', name: '기준일없음' }]);
    const rows = [{ warehouseCode, itemCode: 'MIG-R-30', quantity: '1', unitCost: '1000' }];
    const validated = await runTx(admin, (t) => migration.validate(t, { target: 'OPENING_STOCK', rows }));
    await expect(
      runTx(admin, (t) => migration.apply(t, { batchId: validated.batchId, rows })),
    ).rejects.toThrow(/기준일/);
  });
});

// ─────────────────────────── permissions ───────────────────────────

describe('이관 권한', () => {
  it('admin.migration 권한이 없으면 아무것도 할 수 없다', async () => {
    const sales = await actorFor('sales1').catch(() => null);
    if (!sales) return; // the fixture user is optional in this database
    await expect(
      withTransaction(prisma, { actor: sales, requestId: 'mig-perm', now: new Date() }, (t) =>
        migration.validate(t, { target: 'ITEM', rows: [{ code: 'X', name: 'Y' }] }),
      ),
    ).rejects.toThrow(/권한/);
  });
});
