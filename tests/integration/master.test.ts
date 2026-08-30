// covers: BAS-01..BAS-04, BAS-06..BAS-09, INT-11, INT-12, B-10
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { actorFor, prepareDatabase, prisma, runTx, truncateBusinessData } from '../helpers/db';
import * as item from '@/server/modules/master/item';
import * as partner from '@/server/modules/master/partner';
import * as reference from '@/server/modules/master/reference';
import * as importer from '@/server/modules/master/import';
import { hashPassword } from '@/server/core/crypto';
import type { Actor } from '@/server/core/context';

let admin: Actor;
let viewer: Actor;
let leafCategoryId = '';
let midCategoryId = '';

beforeAll(async () => {
  prepareDatabase();
  admin = await actorFor('admin');

  const viewerRole = await prisma.role.findUniqueOrThrow({ where: { code: 'viewer' } });
  await prisma.user.upsert({
    where: { username: 'masterviewer' },
    create: {
      username: 'masterviewer',
      displayName: '조회전용',
      passwordHash: await hashPassword('Viewer!123456'),
      roles: { create: [{ roleId: viewerRole.id }] },
    },
    update: { isActive: true },
  });
  viewer = await actorFor('masterviewer');

  const leaf = await prisma.itemCategory.findFirstOrThrow({ where: { level: 3 } });
  leafCategoryId = leaf.id;
  midCategoryId = leaf.parentId!;
});

beforeEach(async () => {
  await truncateBusinessData();
  await prisma.$executeRawUnsafe(`DELETE FROM "ImportBatch"`);
  await prisma.$executeRawUnsafe(`DELETE FROM "PartnerContact"`);
  await prisma.$executeRawUnsafe(`UPDATE "Item" SET "defaultSupplierId" = NULL`);
  await prisma.$executeRawUnsafe(`DELETE FROM "Item"`);
  await prisma.$executeRawUnsafe(`DELETE FROM "Partner"`);
  await prisma.$executeRawUnsafe(`DELETE FROM "Warehouse" WHERE code NOT IN ('W01','W02','W03','W04')`);
});

afterAll(() => prisma.$disconnect());

describe('BAS-01/BAS-02: items', () => {
  it('auto-numbers the code and stores supplementary fields', async () => {
    const created = await runTx(admin, (t) =>
      item.create(t, {
        name: '방염필름 1200mm',
        spec: '1200mm x 50m',
        unitCode: 'ROLL',
        categoryId: leafCategoryId,
        purchasePrice: '12000',
        salesPrice: '18000',
        taxType: 'TAXABLE',
        safetyStock: '10',
        leadTimeDays: 14,
        barcode: '8801234567893',
      }),
    );
    expect(created.code).toMatch(/^IT-\d{6}$/);
    expect(created.safetyStock?.toString()).toBe('10');
    expect(created.leadTimeDays).toBe(14);
    expect(created.salesPrice?.toString()).toBe('18000');
  });

  it('B-10: concurrent creation never produces a duplicate code (INT-11)', async () => {
    const results = await Promise.all(
      Array.from({ length: 25 }, (_, i) => runTx(admin, (t) => item.create(t, { name: `동시등록 ${i}` }))),
    );
    const codes = results.map((r) => r.code);
    expect(new Set(codes).size).toBe(25);
  });

  it('rejects an invalid barcode and an unknown tax type', async () => {
    await expect(
      runTx(admin, (t) => item.create(t, { name: '잘못된 바코드', barcode: '8801234567890' })),
    ).rejects.toThrow(/체크디지트/);
    await expect(
      runTx(admin, (t) => item.create(t, { name: '잘못된 과세', taxType: 'VAT' })),
    ).rejects.toThrow(/과세구분/);
  });

  it('BAS-01: items may only attach to the lowest category level', async () => {
    await expect(
      runTx(admin, (t) => item.create(t, { name: '중간분류', categoryId: midCategoryId })),
    ).rejects.toThrow(/최하위 분류/);
    await expect(
      runTx(admin, (t) => item.create(t, { name: '최하위분류', categoryId: leafCategoryId })),
    ).resolves.toBeTruthy();
  });

  it('refuses a duplicate item code', async () => {
    await runTx(admin, (t) => item.create(t, { code: 'MANUAL-1', name: '수동코드' }));
    await expect(runTx(admin, (t) => item.create(t, { code: 'MANUAL-1', name: '중복코드' }))).rejects.toThrow(
      /이미 사용 중인/,
    );
  });

  it('detects a stale version on update', async () => {
    const created = await runTx(admin, (t) => item.create(t, { name: '동시성 시험' }));
    await runTx(admin, (t) => item.update(t, created.id, { name: '1차 수정' }, created.version));
    await expect(
      runTx(admin, (t) => item.update(t, created.id, { name: '2차 수정' }, created.version)),
    ).rejects.toThrow(/다른 사용자에 의해 변경/);
  });

  it('BAS-08: the change history records the before and after values', async () => {
    const created = await runTx(admin, (t) => item.create(t, { name: '이력 시험', salesPrice: '1000' }));
    await runTx(admin, (t) =>
      item.update(t, created.id, { salesPrice: '1500', name: '이력 시험 수정' }, created.version),
    );

    const history = await runTx(admin, (t) => reference.changeHistory(t, 'Item', created.id));
    expect(history.map((h) => h.action)).toContain('item.update');
    const update = history.find((h) => h.action === 'item.update')!;
    expect((update.before as { salesPrice: string }).salesPrice).toBe('1000');
    expect((update.after as { salesPrice: string }).salesPrice).toBe('1500');
  });
});

describe('BAS-04: partners', () => {
  it('accepts a valid business number and stores it normalised', async () => {
    const created = await runTx(admin, (t) =>
      partner.create(t, {
        name: '한빛건재',
        businessNo: '220-81-62517',
        partnerType: 'CUSTOMER',
        creditLimit: '50000000',
        contacts: [
          { name: '김담당', position: '과장', phone: '010-1111-2222', isPrimary: true },
          { name: '이담당', phone: '010-3333-4444' },
        ],
      }),
    );
    expect(created.businessNo).toBe('2208162517');
    expect(created.contacts).toHaveLength(2);
    expect(created.creditLimit?.toString()).toBe('50000000');
  });

  it('rejects an invalid business number and a duplicate one', async () => {
    await expect(
      runTx(admin, (t) => partner.create(t, { name: '잘못된번호', businessNo: '123-45-67890' })),
    ).rejects.toThrow(/확인번호/);
    await runTx(admin, (t) => partner.create(t, { name: '첫번째', businessNo: '220-81-62517' }));
    await expect(
      runTx(admin, (t) => partner.create(t, { name: '두번째', businessNo: '2208162517' })),
    ).rejects.toThrow(/이미 있습니다/);
  });

  it('allows a partner without a business number by default, and enforces it when the policy says so', async () => {
    await expect(runTx(admin, (t) => partner.create(t, { name: '해외공급처' }))).resolves.toBeTruthy();

    await prisma.systemSetting.upsert({
      where: { key: 'partner.requireBusinessNo' },
      create: { key: 'partner.requireBusinessNo', value: { value: true } },
      update: { value: { value: true } },
    });
    await expect(runTx(admin, (t) => partner.create(t, { name: '번호없음' }))).rejects.toThrow(
      /사업자등록번호가 필수/,
    );
    await prisma.systemSetting.update({
      where: { key: 'partner.requireBusinessNo' },
      data: { value: { value: false } },
    });
  });

  it('BAS-08: partner history records the fields that changed, not the contact details', async () => {
    const created = await runTx(admin, (t) =>
      partner.create(t, {
        name: '이력거래처',
        creditLimit: '1000000',
        contacts: [{ name: '홍담당', phone: '010-9999-8888' }],
      }),
    );
    const history = await runTx(admin, (t) => reference.changeHistory(t, 'Partner', created.id));
    const dump = JSON.stringify(history);
    expect(dump).toContain('partner.create');
    expect(dump).not.toContain('010-9999-8888');
  });
});

describe('BAS-09: deletion policy', () => {
  it('blocks physical deletion of a master in use and allows deactivation', async () => {
    const supplier = await runTx(admin, (t) => partner.create(t, { name: '기본매입처' }));
    await runTx(admin, (t) => item.create(t, { name: '연결품목', defaultSupplierId: supplier.id }));

    await expect(runTx(admin, (t) => partner.remove(t, supplier.id))).rejects.toThrow(
      /사용중지로 처리하세요/,
    );

    await runTx(admin, (t) => partner.setActive(t, supplier.id, false));
    expect((await prisma.partner.findUniqueOrThrow({ where: { id: supplier.id } })).isActive).toBe(false);
  });

  it('allows deleting a master that has never been used', async () => {
    const unused = await runTx(admin, (t) => item.create(t, { name: '미사용품목' }));
    await runTx(admin, (t) => item.remove(t, unused.id));
    expect(await prisma.item.findUnique({ where: { id: unused.id } })).toBeNull();
  });

  it('blocks deactivating a common code that items still use', async () => {
    await runTx(admin, (t) => item.create(t, { name: '단위사용품목', unitCode: 'BOX' }));
    await expect(runTx(admin, (t) => reference.deactivateCode(t, 'UNIT', 'BOX'))).rejects.toThrow(
      /사용 중인 단위/,
    );
  });
});

describe('BAS-06/BAS-07 + INT-12: reference data and scope', () => {
  it('a non-admin only sees warehouses in their scope', async () => {
    const all = await runTx(admin, (t) => reference.listWarehouses(t));
    expect(all.length).toBeGreaterThanOrEqual(4);

    const scoped = await runTx(viewer, (t) => reference.listWarehouses(t));
    expect(scoped).toHaveLength(0); // the viewer has no warehouse scope

    const w1 = all[0]!;
    await prisma.userWarehouseScope.createMany({
      data: [{ userId: viewer.userId, warehouseId: w1.id }],
      skipDuplicates: true,
    });
    const refreshed = await actorFor('masterviewer');
    const nowVisible = await runTx(refreshed, (t) => reference.listWarehouses(t));
    expect(nowVisible.map((w) => w.id)).toEqual([w1.id]);
    await prisma.userWarehouseScope.deleteMany({ where: { userId: viewer.userId } });
  });

  it('rejects an invalid warehouse type and a duplicate code', async () => {
    await expect(
      runTx(admin, (t) => reference.createWarehouse(t, { code: 'W90', name: '잘못된유형', type: 'VIRTUAL' })),
    ).rejects.toThrow(/정상·불량·위탁/);
    await runTx(admin, (t) => reference.createWarehouse(t, { code: 'W91', name: '신규창고' }));
    await expect(
      runTx(admin, (t) => reference.createWarehouse(t, { code: 'W91', name: '중복창고' })),
    ).rejects.toThrow(/이미 사용 중인 창고코드/);
  });

  it('rejects an unknown common code group', async () => {
    await expect(
      runTx(admin, (t) => reference.upsertCode(t, { groupCode: 'NOPE', code: 'X', name: '없는그룹' })),
    ).rejects.toThrow(/알 수 없는 코드그룹/);
  });

  it('validates numbering rule changes', async () => {
    await expect(
      runTx(admin, (t) =>
        reference.updateNumberingRule(t, {
          docType: 'SALES',
          prefix: 'sl',
          periodKind: 'MONTH',
          seqLength: 4,
        }),
      ),
    ).rejects.toThrow(/영문 대문자/);
    await expect(
      runTx(admin, (t) =>
        reference.updateNumberingRule(t, {
          docType: 'SALES',
          prefix: 'SL',
          periodKind: 'MONTH',
          seqLength: 2,
        }),
      ),
    ).rejects.toThrow(/3~10/);
    await expect(
      runTx(admin, (t) =>
        reference.updateNumberingRule(t, {
          docType: 'SALES',
          prefix: 'SLS',
          periodKind: 'MONTH',
          seqLength: 5,
        }),
      ),
    ).resolves.toBeTruthy();
    await runTx(admin, (t) =>
      reference.updateNumberingRule(t, { docType: 'SALES', prefix: 'SL', periodKind: 'MONTH', seqLength: 4 }),
    );
  });

  it('a viewer cannot write master data', async () => {
    await expect(runTx(viewer, (t) => item.create(t, { name: '권한없음' }))).rejects.toThrow(
      /권한이 없습니다/,
    );
    await expect(
      runTx(viewer, (t) => reference.createWarehouse(t, { code: 'W92', name: '권한없음' })),
    ).rejects.toThrow(/권한이 없습니다/);
  });
});

describe('BAS-03: bulk registration', () => {
  const itemRows: Record<string, string>[] = [
    { code: '', name: '일괄품목 A', spec: '100mm', unitCode: 'EA', salesPrice: '10000', taxType: 'TAXABLE' },
    { code: '', name: '', salesPrice: '1000' }, // missing name
    { code: '', name: '일괄품목 C', salesPrice: 'abc' }, // non-numeric price
    { code: '', name: '일괄품목 D', barcode: '8801234567890' }, // bad checksum
    { code: '', name: '일괄품목 E', taxType: 'ZERO' },
  ];

  it('reports errors per row and applies only the selected valid rows', async () => {
    const result = await runTx(admin, (t) =>
      importer.validateBatch(t, { targetType: 'ITEM', rows: itemRows, fileName: 'items.xlsx' }),
    );
    expect(result.total).toBe(5);
    expect(result.valid).toBe(2);
    expect(result.validRows).toEqual([1, 5]);
    expect(result.errors.map((e) => e.row).sort()).toEqual([2, 3, 4]);
    expect(result.errors.find((e) => e.row === 4)?.message).toMatch(/체크디지트/);
    // nothing has been written yet
    expect(await prisma.item.count()).toBe(0);

    const applied = await runTx(admin, (t) =>
      importer.applyBatch(t, {
        batchId: result.batchId,
        targetType: 'ITEM',
        rows: itemRows,
        selectedRows: [1],
      }),
    );
    expect(applied).toEqual({ applied: 1, created: 1, updated: 0 });
    expect(await prisma.item.count()).toBe(1);
    expect((await prisma.item.findFirstOrThrow()).name).toBe('일괄품목 A');
  });

  it('updates existing rows matched by code and refuses to re-apply a batch', async () => {
    await runTx(admin, (t) => item.create(t, { code: 'BULK-1', name: '기존품목', salesPrice: '1000' }));
    const rows = [{ code: 'BULK-1', name: '수정된품목', salesPrice: '2000' }];

    const result = await runTx(admin, (t) => importer.validateBatch(t, { targetType: 'ITEM', rows }));
    expect(result.preview[0]?.action).toBe('UPDATE');

    const applied = await runTx(admin, (t) =>
      importer.applyBatch(t, { batchId: result.batchId, targetType: 'ITEM', rows, selectedRows: [1] }),
    );
    expect(applied).toEqual({ applied: 1, created: 0, updated: 1 });
    const updated = await prisma.item.findUniqueOrThrow({ where: { code: 'BULK-1' } });
    expect(updated.name).toBe('수정된품목');
    expect(updated.salesPrice?.toString()).toBe('2000');

    await expect(
      runTx(admin, (t) =>
        importer.applyBatch(t, { batchId: result.batchId, targetType: 'ITEM', rows, selectedRows: [1] }),
      ),
    ).rejects.toThrow(/이미 반영된/);
  });

  it('catches duplicates inside the file itself', async () => {
    const rows: Record<string, string>[] = [
      { code: 'DUP-1', name: '첫번째' },
      { code: 'DUP-1', name: '두번째' },
    ];
    const result = await runTx(admin, (t) => importer.validateBatch(t, { targetType: 'ITEM', rows }));
    expect(result.errors.some((e) => e.message.includes('중복된 품목코드'))).toBe(true);
    expect(result.valid).toBe(1);
  });

  it('validates partner rows including business numbers', async () => {
    const rows: Record<string, string>[] = [
      { name: '일괄거래처 A', businessNo: '220-81-62517', partnerType: 'CUSTOMER' },
      { name: '일괄거래처 B', businessNo: '123-45-67890' },
      { name: '', businessNo: '124-81-00998' },
      { name: '일괄거래처 D', creditLimit: 'x' },
    ];
    const result = await runTx(admin, (t) => importer.validateBatch(t, { targetType: 'PARTNER', rows }));
    expect(result.valid).toBe(1);
    expect(result.errors.map((e) => e.row).sort()).toEqual([2, 3, 4]);

    await runTx(admin, (t) =>
      importer.applyBatch(t, { batchId: result.batchId, targetType: 'PARTNER', rows, selectedRows: [1] }),
    );
    const created = await prisma.partner.findFirstOrThrow();
    expect(created.businessNo).toBe('2208162517');
  });

  it('rolls the whole application back when one row fails', async () => {
    const rows: Record<string, string>[] = [
      { code: 'ROLL-1', name: '정상행' },
      { code: 'ROLL-2', name: '정상행2' },
    ];
    const result = await runTx(admin, (t) => importer.validateBatch(t, { targetType: 'ITEM', rows }));

    // selecting a row number outside the file aborts the transaction
    await expect(
      runTx(admin, (t) =>
        importer.applyBatch(t, { batchId: result.batchId, targetType: 'ITEM', rows, selectedRows: [1, 99] }),
      ),
    ).rejects.toThrow(/선택한 행이 파일에 없습니다/);
    expect(await prisma.item.count()).toBe(0);
  });

  it('rejects an outdated template version', async () => {
    await expect(
      runTx(admin, (t) =>
        importer.validateBatch(t, { targetType: 'ITEM', rows: [{ name: 'x' }], templateVersion: 0 }),
      ),
    ).rejects.toThrow(/양식 버전이 다릅니다/);
  });
});
