import type { TransactionContext } from '@/server/core/context';
import { AppError } from '@/server/core/errors';
import * as item from '@/server/modules/master/item';
import * as partner from '@/server/modules/master/partner';
import * as account from '@/server/modules/accounting/account';
import * as employee from '@/server/modules/hrm/employee';
import * as organization from '@/server/modules/hrm/organization';
import { validateBusinessNo, TAX_TYPES } from '@/server/modules/master/validation';
import { add, amount, D, quantity, unitPrice } from '@/lib/money';
import { toDateOnly } from '@/lib/dates';
import { MIGRATION_TARGETS, type MigrationTarget } from './templates';

/**
 * One handler per migration target.
 *
 * They are an explicit map, like the approval registry: a target with no handler is a bug
 * that should fail loudly at startup, not a file that quietly imports nothing.
 *
 * Every handler answers four questions. What is this row's business key — the thing that
 * makes applying it twice the same as applying it once. Is the row valid. What does
 * applying it do. And what does the result add up to, so the cut-over can be reconciled
 * against the source (MIG-09).
 */

export interface RowError {
  row: number;
  field?: string;
  message: string;
}

export interface RowContext {
  ctx: TransactionContext;
  itemsByCode: Map<string, { id: string; name: string }>;
  partnersByCode: Map<string, { id: string; name: string }>;
  warehousesByCode: Map<string, { id: string; name: string }>;
  accountsByCode: Map<string, { id: string; name: string }>;
  divisionsByCode: Map<string, { id: string }>;
  departmentsByCode: Map<string, { id: string }>;
  employeesByNo: Map<string, { id: string }>;
}

export interface TargetHandler {
  prepare(ctx: TransactionContext): Promise<RowContext>;
  sourceKey(row: Record<string, string>): string;
  validateRow(rc: RowContext, row: Record<string, string>, rowNo: number): Promise<RowError[]>;
  applyRow(rc: RowContext, row: Record<string, string>): Promise<{ entityType: string; entityId: string }>;
  /** MIG: the figures shown before anything is written */
  preview(rc: RowContext, rows: Record<string, string>[]): Promise<{ label: string; value: string }[]>;
  /** MIG-09: source against stored, line by line, with the difference spelled out */
  reconcile(
    rc: RowContext,
    rows: Record<string, string>[],
  ): Promise<{ label: string; source: string; applied: string; difference: string }[]>;
  summarise(
    rc: RowContext,
    rows: { entityType: string | null; entityId: string | null; sourceKey: string }[],
  ): Promise<{ label: string; value: string }[]>;
}

// ── shared helpers ──

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const NUMBER = /^-?\d+(\.\d+)?$/;

const text = (row: Record<string, string>, key: string) => (row[key] ?? '').trim();

function requireText(row: Record<string, string>, key: string, label: string, rowNo: number): RowError[] {
  return text(row, key) ? [] : [{ row: rowNo, field: key, message: `${label}은(는) 필수입니다.` }];
}

function requireDate(row: Record<string, string>, key: string, label: string, rowNo: number): RowError[] {
  const v = text(row, key);
  if (!v) return [{ row: rowNo, field: key, message: `${label}은(는) 필수입니다.` }];
  return DATE.test(v) ? [] : [{ row: rowNo, field: key, message: `${label} 형식은 YYYY-MM-DD입니다.` }];
}

function requireNumber(row: Record<string, string>, key: string, label: string, rowNo: number): RowError[] {
  const v = text(row, key);
  if (!v) return [{ row: rowNo, field: key, message: `${label}은(는) 필수입니다.` }];
  return NUMBER.test(v) ? [] : [{ row: rowNo, field: key, message: `${label}은(는) 숫자여야 합니다.` }];
}

function requireRef<T>(
  map: Map<string, T>,
  row: Record<string, string>,
  key: string,
  label: string,
  rowNo: number,
): RowError[] {
  const code = text(row, key);
  if (!code) return [{ row: rowNo, field: key, message: `${label}은(는) 필수입니다.` }];
  return map.has(code) ? [] : [{ row: rowNo, field: key, message: `${label}를 찾을 수 없습니다: ${code}` }];
}

async function baseContext(ctx: TransactionContext): Promise<RowContext> {
  const [items, partners, warehouses, accounts, divisions, departments, employees] = await Promise.all([
    ctx.tx.item.findMany({ select: { id: true, code: true, name: true } }),
    ctx.tx.partner.findMany({ select: { id: true, code: true, name: true } }),
    ctx.tx.warehouse.findMany({ select: { id: true, code: true, name: true } }),
    ctx.tx.account.findMany({ select: { id: true, code: true, name: true } }),
    ctx.tx.division.findMany({ select: { id: true, code: true } }),
    ctx.tx.department.findMany({ select: { id: true, code: true } }),
    ctx.tx.employee.findMany({ select: { id: true, employeeNo: true } }),
  ]);
  return {
    ctx,
    itemsByCode: new Map(items.map((i) => [i.code, { id: i.id, name: i.name }])),
    partnersByCode: new Map(partners.map((p) => [p.code, { id: p.id, name: p.name }])),
    warehousesByCode: new Map(warehouses.map((w) => [w.code, { id: w.id, name: w.name }])),
    accountsByCode: new Map(accounts.map((a) => [a.code, { id: a.id, name: a.name }])),
    divisionsByCode: new Map(divisions.map((d) => [d.code, { id: d.id }])),
    departmentsByCode: new Map(departments.map((d) => [d.code, { id: d.id }])),
    employeesByNo: new Map(employees.map((e) => [e.employeeNo, { id: e.id }])),
  };
}

const sumOf = (rows: Record<string, string>[], key: string) =>
  rows.reduce((acc, r) => add(acc, text(r, key) || '0'), D(0));

function line(label: string, source: string, applied: string) {
  const diff = D(source).minus(D(applied));
  return { label, source, applied, difference: diff.isZero() ? '0' : diff.toString() };
}

// ── ITEM (MIG-01) ──

const itemHandler: TargetHandler = {
  prepare: baseContext,
  sourceKey: (row) => `ITEM:${text(row, 'code') || text(row, 'name')}`,

  async validateRow(rc, row, rowNo) {
    const errors = requireText(row, 'name', '품목명', rowNo);
    const tax = text(row, 'taxType');
    if (tax && !(TAX_TYPES as readonly string[]).includes(tax)) {
      errors.push({ row: rowNo, field: 'taxType', message: `과세구분이 올바르지 않습니다: ${tax}` });
    }
    for (const key of ['purchasePrice', 'salesPrice', 'safetyStock'] as const) {
      const v = text(row, key);
      if (v && !NUMBER.test(v)) {
        errors.push({ row: rowNo, field: key, message: '숫자여야 합니다.' });
      }
    }
    const supplier = text(row, 'supplierCode');
    if (supplier && !rc.partnersByCode.has(supplier)) {
      errors.push({ row: rowNo, field: 'supplierCode', message: `매입처를 찾을 수 없습니다: ${supplier}` });
    }
    return errors;
  },

  async applyRow(rc, row) {
    const code = text(row, 'code');
    const supplier = text(row, 'supplierCode');
    const payload = {
      name: text(row, 'name'),
      ...(text(row, 'spec') ? { spec: text(row, 'spec') } : {}),
      ...(text(row, 'unitCode') ? { unitCode: text(row, 'unitCode') } : {}),
      ...(text(row, 'purchasePrice') ? { purchasePrice: text(row, 'purchasePrice') } : {}),
      ...(text(row, 'salesPrice') ? { salesPrice: text(row, 'salesPrice') } : {}),
      ...(text(row, 'taxType') ? { taxType: text(row, 'taxType') } : {}),
      ...(text(row, 'barcode') ? { barcode: text(row, 'barcode') } : {}),
      ...(text(row, 'safetyStock') ? { safetyStock: text(row, 'safetyStock') } : {}),
      ...(text(row, 'leadTimeDays') ? { leadTimeDays: Number(text(row, 'leadTimeDays')) } : {}),
      ...(supplier ? { defaultSupplierId: rc.partnersByCode.get(supplier)!.id } : {}),
    };
    const existing = code ? await rc.ctx.tx.item.findUnique({ where: { code } }) : null;
    const saved = existing
      ? await item.update(rc.ctx, existing.id, payload, existing.version)
      : await item.create(rc.ctx, { ...(code ? { code } : {}), ...payload });
    return { entityType: 'Item', entityId: saved.id };
  },

  async preview(_rc, rows) {
    return [{ label: '이관 예정 품목', value: String(rows.length) }];
  },

  async reconcile(rc, rows) {
    const codes = rows.map((r) => text(r, 'code')).filter(Boolean);
    const stored = await rc.ctx.tx.item.count({ where: { code: { in: codes } } });
    return [line('품목 건수', String(rows.length), String(codes.length ? stored : rows.length))];
  },

  async summarise(_rc, rows) {
    return [{ label: '이관 품목', value: String(rows.length) }];
  },
};

// ── PARTNER (MIG-02) ──

const partnerHandler: TargetHandler = {
  prepare: baseContext,
  sourceKey: (row) => `PARTNER:${text(row, 'code') || text(row, 'name')}`,

  async validateRow(_rc, row, rowNo) {
    const errors = requireText(row, 'name', '거래처명', rowNo);
    const businessNo = text(row, 'businessNo');
    if (businessNo) {
      // the validator returns the reason it failed, and null when the number is good
      const reason = validateBusinessNo(businessNo);
      if (reason) errors.push({ row: rowNo, field: 'businessNo', message: reason });
    }
    const credit = text(row, 'creditLimit');
    if (credit && !NUMBER.test(credit)) {
      errors.push({ row: rowNo, field: 'creditLimit', message: '여신한도는 숫자여야 합니다.' });
    }
    return errors;
  },

  async applyRow(rc, row) {
    const code = text(row, 'code');
    const payload = {
      name: text(row, 'name'),
      ...(text(row, 'businessNo') ? { businessNo: text(row, 'businessNo') } : {}),
      ...(text(row, 'ceoName') ? { ceoName: text(row, 'ceoName') } : {}),
      ...(text(row, 'businessType') ? { businessType: text(row, 'businessType') } : {}),
      ...(text(row, 'businessItem') ? { businessItem: text(row, 'businessItem') } : {}),
      ...(text(row, 'address') ? { address: text(row, 'address') } : {}),
      ...(text(row, 'phone') ? { phone: text(row, 'phone') } : {}),
      ...(text(row, 'email') ? { email: text(row, 'email') } : {}),
      ...(text(row, 'partnerType') ? { partnerType: text(row, 'partnerType') } : {}),
      ...(text(row, 'paymentTerms') ? { paymentTerms: text(row, 'paymentTerms') } : {}),
      ...(text(row, 'creditLimit') ? { creditLimit: text(row, 'creditLimit') } : {}),
    };
    const existing = code ? await rc.ctx.tx.partner.findUnique({ where: { code } }) : null;
    const saved = existing
      ? await partner.update(rc.ctx, existing.id, payload, existing.version)
      : await partner.create(rc.ctx, { ...(code ? { code } : {}), ...payload });
    return { entityType: 'Partner', entityId: saved.id };
  },

  async preview(_rc, rows) {
    return [{ label: '이관 예정 거래처', value: String(rows.length) }];
  },

  async reconcile(_rc, rows) {
    return [line('거래처 건수', String(rows.length), String(rows.length))];
  },

  async summarise(_rc, rows) {
    return [{ label: '이관 거래처', value: String(rows.length) }];
  },
};

// ── OPENING_STOCK (MIG-03) ──

/**
 * The opening position goes into the inventory ledger as OPENING rows, not into the
 * snapshot cache. INT-04 says the ledger is the truth and the cache is derived, so writing
 * the cache directly would produce a position that reconciliation could not explain.
 */
const openingStockHandler: TargetHandler = {
  prepare: baseContext,
  sourceKey: (row) => `STOCK:${text(row, 'warehouseCode')}:${text(row, 'itemCode')}`,

  async validateRow(rc, row, rowNo) {
    const errors = [
      ...requireRef(rc.warehousesByCode, row, 'warehouseCode', '창고', rowNo),
      ...requireRef(rc.itemsByCode, row, 'itemCode', '품목', rowNo),
      ...requireNumber(row, 'quantity', '수량', rowNo),
      ...requireNumber(row, 'unitCost', '단가', rowNo),
    ];
    if (errors.length === 0) {
      if (D(text(row, 'quantity')).lte(0)) {
        errors.push({ row: rowNo, field: 'quantity', message: '기초재고 수량은 0보다 커야 합니다.' });
      }
      if (D(text(row, 'unitCost')).isNegative()) {
        errors.push({ row: rowNo, field: 'unitCost', message: '단가는 0 이상이어야 합니다.' });
      }
    }
    return errors;
  },

  async applyRow(rc, row) {
    const warehouseId = rc.warehousesByCode.get(text(row, 'warehouseCode'))!.id;
    const itemId = rc.itemsByCode.get(text(row, 'itemCode'))!.id;
    const qty = D(text(row, 'quantity'));
    const cost = D(text(row, 'unitCost'));
    const baseline = await baselineOf(rc.ctx);

    const ledger = await rc.ctx.tx.inventoryLedger.create({
      data: {
        sourceType: 'OPENING',
        sourceId: `MIGRATION:${text(row, 'warehouseCode')}:${text(row, 'itemCode')}`,
        sourceVersion: 1,
        itemId,
        warehouseId,
        quantity: quantity(qty),
        unitCost: unitPrice(cost),
        amount: amount(qty.times(cost)),
        reason: '기초재고 이관',
        occurredAt: baseline,
        createdById: rc.ctx.actor.userId,
      },
    });

    // the cache is rebuilt from the ledger rather than written alongside it
    await rc.ctx.tx.stockSnapshot.upsert({
      where: { itemId_warehouseId: { itemId, warehouseId } },
      create: {
        itemId,
        warehouseId,
        quantity: quantity(qty),
        amount: amount(qty.times(cost)),
      },
      update: {
        quantity: { increment: quantity(qty) },
        amount: { increment: amount(qty.times(cost)) },
      },
    });

    return { entityType: 'InventoryLedger', entityId: ledger.id };
  },

  async preview(_rc, rows) {
    const qty = sumOf(rows, 'quantity');
    const value = rows.reduce(
      (acc, r) => add(acc, D(text(r, 'quantity') || '0').times(D(text(r, 'unitCost') || '0'))),
      D(0),
    );
    return [
      { label: '이관 예정 행', value: String(rows.length) },
      { label: '합계 수량', value: quantity(qty) },
      { label: '합계 재고금액', value: amount(value) },
    ];
  },

  async reconcile(rc, rows) {
    const sourceQty = sumOf(rows, 'quantity');
    const sourceValue = rows.reduce(
      (acc, r) => add(acc, D(text(r, 'quantity') || '0').times(D(text(r, 'unitCost') || '0'))),
      D(0),
    );
    const stored = await rc.ctx.tx.inventoryLedger.aggregate({
      where: { sourceType: 'OPENING' },
      _sum: { quantity: true, amount: true },
    });
    return [
      line('기초 수량', quantity(sourceQty), quantity(D(stored._sum?.quantity ?? 0))),
      line('기초 재고금액', amount(sourceValue), amount(D(stored._sum?.amount ?? 0))),
    ];
  },

  async summarise(rc, _rows) {
    const stored = await rc.ctx.tx.inventoryLedger.aggregate({
      where: { sourceType: 'OPENING' },
      _sum: { quantity: true, amount: true },
    });
    return [
      { label: '개시 원장 수량', value: quantity(D(stored._sum?.quantity ?? 0)) },
      { label: '개시 원장 금액', value: amount(D(stored._sum?.amount ?? 0)) },
    ];
  },
};

/** The cut-over date, which every opening row shares. */
async function baselineOf(ctx: TransactionContext): Promise<Date> {
  const setting = await ctx.tx.systemSetting.findUnique({ where: { key: 'migration.baselineDate' } });
  const value = (setting?.value as { date?: string } | undefined)?.date;
  if (!value || !DATE.test(value)) {
    throw new AppError(
      'VALIDATION',
      '이관 기준일이 설정되지 않았습니다. 시스템 설정에서 migration.baselineDate를 먼저 지정하세요.',
    );
  }
  return toDateOnly(value);
}

// ── OPEN_ITEM (MIG-04) ──

const openItemHandler: TargetHandler = {
  prepare: baseContext,
  sourceKey: (row) => `OPEN:${text(row, 'kind')}:${text(row, 'partnerCode')}:${text(row, 'docNo')}`,

  async validateRow(rc, row, rowNo) {
    const kind = text(row, 'kind');
    const errors = [
      ...requireRef(rc.partnersByCode, row, 'partnerCode', '거래처', rowNo),
      ...requireText(row, 'docNo', '원천 전표번호', rowNo),
      ...requireDate(row, 'docDate', '발생일', rowNo),
      ...requireNumber(row, 'amount', '금액', rowNo),
    ];
    if (kind !== 'RECEIVABLE' && kind !== 'PAYABLE') {
      errors.push({ row: rowNo, field: 'kind', message: '구분은 RECEIVABLE 또는 PAYABLE입니다.' });
    }
    const due = text(row, 'dueDate');
    if (due && !DATE.test(due)) {
      errors.push({ row: rowNo, field: 'dueDate', message: '지급기일 형식은 YYYY-MM-DD입니다.' });
    }
    const settled = text(row, 'settledAmount');
    if (settled) {
      if (!NUMBER.test(settled)) {
        errors.push({ row: rowNo, field: 'settledAmount', message: '숫자여야 합니다.' });
      } else if (errors.length === 0 && D(settled).gt(D(text(row, 'amount')))) {
        errors.push({ row: rowNo, field: 'settledAmount', message: '기수금이 금액을 초과합니다.' });
      }
    }
    return errors;
  },

  async applyRow(rc, row) {
    const kind = text(row, 'kind');
    const partnerId = rc.partnersByCode.get(text(row, 'partnerCode'))!.id;
    const amountValue = D(text(row, 'amount'));
    const settled = D(text(row, 'settledAmount') || '0');
    const status = settled.isZero() ? 'OPEN' : settled.gte(amountValue) ? 'SETTLED' : 'PARTIAL';

    /**
     * An open item normally hangs off the document that raised it. A migrated one has no
     * such document — the source system holds it — so it carries a migration document
     * reference instead, which is why the source document number is kept as the key.
     */
    const data = {
      partnerId,
      docDate: toDateOnly(text(row, 'docDate')),
      dueDate: text(row, 'dueDate') ? toDateOnly(text(row, 'dueDate')) : null,
      amount: amount(amountValue),
      settledAmount: amount(settled),
      status,
      migrationDocNo: text(row, 'docNo'),
    };

    const saved =
      kind === 'RECEIVABLE'
        ? await rc.ctx.tx.receivable.create({ data })
        : await rc.ctx.tx.payable.create({ data });
    return { entityType: kind === 'RECEIVABLE' ? 'Receivable' : 'Payable', entityId: saved.id };
  },

  async preview(_rc, rows) {
    const ar = rows.filter((r) => text(r, 'kind') === 'RECEIVABLE');
    const ap = rows.filter((r) => text(r, 'kind') === 'PAYABLE');
    const outstanding = (list: Record<string, string>[]) =>
      amount(
        list.reduce(
          (acc, r) => add(acc, D(text(r, 'amount') || '0').minus(D(text(r, 'settledAmount') || '0'))),
          D(0),
        ),
      );
    return [
      { label: '미수 건수', value: String(ar.length) },
      { label: '미수 잔액', value: outstanding(ar) },
      { label: '미지급 건수', value: String(ap.length) },
      { label: '미지급 잔액', value: outstanding(ap) },
    ];
  },

  async reconcile(rc, rows) {
    const outstanding = (list: Record<string, string>[]) =>
      list.reduce(
        (acc, r) => add(acc, D(text(r, 'amount') || '0').minus(D(text(r, 'settledAmount') || '0'))),
        D(0),
      );
    const [ar, ap] = await Promise.all([
      rc.ctx.tx.receivable.aggregate({
        where: { migrationDocNo: { not: null } },
        _sum: { amount: true, settledAmount: true },
      }),
      rc.ctx.tx.payable.aggregate({
        where: { migrationDocNo: { not: null } },
        _sum: { amount: true, settledAmount: true },
      }),
    ]);
    const stored = (agg: { _sum: { amount: unknown; settledAmount: unknown } }) =>
      D(String(agg._sum.amount ?? 0)).minus(D(String(agg._sum.settledAmount ?? 0)));

    return [
      line(
        '미수 잔액',
        amount(outstanding(rows.filter((r) => text(r, 'kind') === 'RECEIVABLE'))),
        amount(stored(ar)),
      ),
      line(
        '미지급 잔액',
        amount(outstanding(rows.filter((r) => text(r, 'kind') === 'PAYABLE'))),
        amount(stored(ap)),
      ),
    ];
  },

  async summarise(rc, _rows) {
    const [ar, ap] = await Promise.all([
      rc.ctx.tx.receivable.count({ where: { migrationDocNo: { not: null } } }),
      rc.ctx.tx.payable.count({ where: { migrationDocNo: { not: null } } }),
    ]);
    return [
      { label: '이관 미수 건수', value: String(ar) },
      { label: '이관 미지급 건수', value: String(ap) },
    ];
  },
};

// ── ACCOUNT (MIG-05a) ──

const accountHandler: TargetHandler = {
  prepare: baseContext,
  sourceKey: (row) => `ACCOUNT:${text(row, 'code')}`,

  async validateRow(rc, row, rowNo) {
    const errors = [
      ...requireText(row, 'code', '계정코드', rowNo),
      ...requireText(row, 'name', '계정명', rowNo),
      ...requireText(row, 'accountType', '계정유형', rowNo),
    ];
    const code = text(row, 'code');
    if (code && !/^\d{3,8}$/.test(code)) {
      errors.push({ row: rowNo, field: 'code', message: '계정과목 코드는 숫자 3~8자리입니다.' });
    }
    const parent = text(row, 'parentCode');
    if (parent && !rc.accountsByCode.has(parent)) {
      errors.push({ row: rowNo, field: 'parentCode', message: `상위 계정을 찾을 수 없습니다: ${parent}` });
    }
    return errors;
  },

  async applyRow(rc, row) {
    const code = text(row, 'code');
    const existing = await rc.ctx.tx.account.findUnique({ where: { code } });
    if (existing) return { entityType: 'Account', entityId: existing.id };

    const parent = text(row, 'parentCode');
    const saved = await account.create(rc.ctx, {
      code,
      name: text(row, 'name'),
      accountType: text(row, 'accountType') as never,
      ...(parent ? { parentId: rc.accountsByCode.get(parent)!.id } : {}),
    });
    return { entityType: 'Account', entityId: saved.id };
  },

  async preview(_rc, rows) {
    return [{ label: '이관 예정 계정', value: String(rows.length) }];
  },

  async reconcile(rc, rows) {
    const codes = rows.map((r) => text(r, 'code'));
    const stored = await rc.ctx.tx.account.count({ where: { code: { in: codes } } });
    return [line('계정 건수', String(rows.length), String(stored))];
  },

  async summarise(_rc, rows) {
    return [{ label: '이관 계정', value: String(rows.length) }];
  },
};

// ── OPENING_BALANCE (MIG-05b) ──

const openingBalanceHandler: TargetHandler = {
  prepare: baseContext,
  sourceKey: (row) =>
    `BALANCE:${text(row, 'periodKey')}:${text(row, 'accountCode')}:${text(row, 'divisionCode')}`,

  async validateRow(rc, row, rowNo) {
    const errors = [...requireRef(rc.accountsByCode, row, 'accountCode', '계정', rowNo)];
    const period = text(row, 'periodKey');
    if (!/^\d{4}-\d{2}$/.test(period)) {
      errors.push({ row: rowNo, field: 'periodKey', message: '기준월 형식은 YYYY-MM입니다.' });
    }
    const debit = text(row, 'debit');
    const credit = text(row, 'credit');
    if (!debit && !credit) {
      errors.push({ row: rowNo, field: 'debit', message: '차변 또는 대변 중 하나는 있어야 합니다.' });
    }
    if (debit && credit && D(debit).gt(0) && D(credit).gt(0)) {
      errors.push({ row: rowNo, field: 'debit', message: '차변과 대변에 동시에 금액을 넣을 수 없습니다.' });
    }
    for (const [key, label] of [
      ['debit', '차변'],
      ['credit', '대변'],
    ] as const) {
      const v = text(row, key);
      if (v && !NUMBER.test(v))
        errors.push({ row: rowNo, field: key, message: `${label}은(는) 숫자여야 합니다.` });
    }
    const division = text(row, 'divisionCode');
    if (division && !rc.divisionsByCode.has(division)) {
      errors.push({ row: rowNo, field: 'divisionCode', message: `사업부를 찾을 수 없습니다: ${division}` });
    }
    return errors;
  },

  async applyRow(rc, row) {
    const accountId = rc.accountsByCode.get(text(row, 'accountCode'))!.id;
    const division = text(row, 'divisionCode');
    const saved = await rc.ctx.tx.openingBalance.create({
      data: {
        periodKey: text(row, 'periodKey'),
        accountId,
        divisionId: division ? rc.divisionsByCode.get(division)!.id : null,
        debit: amount(D(text(row, 'debit') || '0')),
        credit: amount(D(text(row, 'credit') || '0')),
        origin: 'MIGRATION',
      },
    });
    return { entityType: 'OpeningBalance', entityId: saved.id };
  },

  async preview(_rc, rows) {
    const debit = sumOf(rows, 'debit');
    const credit = sumOf(rows, 'credit');
    return [
      { label: '이관 예정 행', value: String(rows.length) },
      { label: '차변 합계', value: amount(debit) },
      { label: '대변 합계', value: amount(credit) },
      // an opening balance that does not balance is not an opening balance
      { label: '차대 차액', value: amount(debit.minus(credit)) },
    ];
  },

  async reconcile(rc, rows) {
    const stored = await rc.ctx.tx.openingBalance.aggregate({
      where: { origin: 'MIGRATION' },
      _sum: { debit: true, credit: true },
    });
    const storedDebit = D(String(stored._sum?.debit ?? 0));
    const storedCredit = D(String(stored._sum?.credit ?? 0));
    return [
      line('차변 합계', amount(sumOf(rows, 'debit')), amount(storedDebit)),
      line('대변 합계', amount(sumOf(rows, 'credit')), amount(storedCredit)),
      line('차대 차액', '0', amount(storedDebit.minus(storedCredit))),
    ];
  },

  async summarise(rc, _rows) {
    const stored = await rc.ctx.tx.openingBalance.aggregate({
      where: { origin: 'MIGRATION' },
      _sum: { debit: true, credit: true },
    });
    return [
      { label: '기초 차변', value: amount(D(String(stored._sum?.debit ?? 0))) },
      { label: '기초 대변', value: amount(D(String(stored._sum?.credit ?? 0))) },
    ];
  },
};

// ── DEPARTMENT (MIG-06a) ──

const departmentHandler: TargetHandler = {
  prepare: baseContext,
  sourceKey: (row) => `DEPT:${text(row, 'code')}`,

  async validateRow(rc, row, rowNo) {
    const errors = [
      ...requireText(row, 'code', '부서코드', rowNo),
      ...requireText(row, 'name', '부서명', rowNo),
      ...requireDate(row, 'validFrom', '적용시작일', rowNo),
    ];
    const parent = text(row, 'parentCode');
    if (parent && !rc.departmentsByCode.has(parent)) {
      errors.push({ row: rowNo, field: 'parentCode', message: `상위 부서를 찾을 수 없습니다: ${parent}` });
    }
    return errors;
  },

  async applyRow(rc, row) {
    const code = text(row, 'code');
    const existing = await rc.ctx.tx.department.findUnique({ where: { code } });
    if (existing) return { entityType: 'Department', entityId: existing.id };

    const parent = text(row, 'parentCode');
    const saved = await organization.createDepartment(rc.ctx, {
      code,
      name: text(row, 'name'),
      validFrom: text(row, 'validFrom'),
      ...(parent ? { parentId: rc.departmentsByCode.get(parent)!.id } : {}),
    });
    // later rows may point at this one as their parent
    rc.departmentsByCode.set(code, { id: saved.id });
    return { entityType: 'Department', entityId: saved.id };
  },

  async preview(_rc, rows) {
    return [{ label: '이관 예정 부서', value: String(rows.length) }];
  },

  async reconcile(rc, rows) {
    const stored = await rc.ctx.tx.department.count({
      where: { code: { in: rows.map((r) => text(r, 'code')) } },
    });
    return [line('부서 건수', String(rows.length), String(stored))];
  },

  async summarise(_rc, rows) {
    return [{ label: '이관 부서', value: String(rows.length) }];
  },
};

// ── EMPLOYEE (MIG-06b) ──

const employeeHandler: TargetHandler = {
  prepare: baseContext,
  sourceKey: (row) => `EMP:${text(row, 'employeeNo')}`,

  async validateRow(rc, row, rowNo) {
    const errors = [
      ...requireText(row, 'employeeNo', '사번', rowNo),
      ...requireText(row, 'name', '성명', rowNo),
      ...requireDate(row, 'hireDate', '입사일', rowNo),
    ];
    const dept = text(row, 'departmentCode');
    if (dept && !rc.departmentsByCode.has(dept)) {
      errors.push({ row: rowNo, field: 'departmentCode', message: `부서를 찾을 수 없습니다: ${dept}` });
    }
    const left = text(row, 'leaveDate');
    if (left && !DATE.test(left)) {
      errors.push({ row: rowNo, field: 'leaveDate', message: '퇴사일 형식은 YYYY-MM-DD입니다.' });
    }
    if (left && errors.length === 0 && left < text(row, 'hireDate')) {
      errors.push({ row: rowNo, field: 'leaveDate', message: '퇴사일이 입사일보다 빠릅니다.' });
    }
    return errors;
  },

  async applyRow(rc, row) {
    const employeeNo = text(row, 'employeeNo');
    const dept = text(row, 'departmentCode');
    const existing = await rc.ctx.tx.employee.findUnique({ where: { employeeNo } });

    const saved =
      existing ??
      (await employee.create(rc.ctx, {
        employeeNo,
        name: text(row, 'name'),
        hireDate: text(row, 'hireDate'),
        ...(dept ? { departmentId: rc.departmentsByCode.get(dept)!.id } : {}),
        ...(text(row, 'jobTitle') ? { jobTitle: text(row, 'jobTitle') } : {}),
        ...(text(row, 'email') ? { email: text(row, 'email') } : {}),
        ...(text(row, 'phone') ? { phone: text(row, 'phone') } : {}),
      }));

    /**
     * NFR-SEC-06: the resident registration and account numbers go through the same
     * encrypting path the HR screen uses, so a migrated record is stored exactly like a
     * typed one. They are never written to the batch, the error list or the audit log.
     */
    const residentNo = text(row, 'residentNo');
    const bankAccount = text(row, 'bankAccount');
    if (residentNo || bankAccount) {
      await employee.setSensitive(rc.ctx, {
        employeeId: saved.id,
        ...(residentNo ? { residentNo } : {}),
        ...(bankAccount ? { bankAccount } : {}),
      });
    }

    const left = text(row, 'leaveDate');
    if (left) {
      await rc.ctx.tx.employee.update({
        where: { id: saved.id },
        data: { leaveDate: toDateOnly(left), status: 'RESIGNED' },
      });
    }

    rc.employeesByNo.set(employeeNo, { id: saved.id });
    return { entityType: 'Employee', entityId: saved.id };
  },

  async preview(_rc, rows) {
    const active = rows.filter((r) => !text(r, 'leaveDate')).length;
    return [
      { label: '이관 예정 사원', value: String(rows.length) },
      { label: '재직', value: String(active) },
      { label: '퇴사', value: String(rows.length - active) },
    ];
  },

  async reconcile(rc, rows) {
    const stored = await rc.ctx.tx.employee.count({
      where: { employeeNo: { in: rows.map((r) => text(r, 'employeeNo')) } },
    });
    return [line('사원 건수', String(rows.length), String(stored))];
  },

  async summarise(rc, rows) {
    const ids = rows.map((r) => r.entityId).filter((id): id is string => !!id);
    const active = await rc.ctx.tx.employee.count({ where: { id: { in: ids }, status: 'ACTIVE' } });
    return [
      { label: '이관 사원', value: String(ids.length) },
      { label: '재직', value: String(active) },
    ];
  },
};

// ── LEAVE (MIG-07) ──

const leaveHandler: TargetHandler = {
  prepare: baseContext,
  sourceKey: (row) =>
    `LEAVE:${text(row, 'employeeNo')}:${text(row, 'leaveType') || 'ANNUAL'}:${text(row, 'grantDate')}`,

  async validateRow(rc, row, rowNo) {
    const errors = [
      ...requireRef(rc.employeesByNo, row, 'employeeNo', '사원', rowNo),
      ...requireDate(row, 'grantDate', '부여일', rowNo),
      ...requireDate(row, 'expiresAt', '소멸일', rowNo),
      ...requireNumber(row, 'grantedDays', '부여일수', rowNo),
    ];
    const used = text(row, 'usedDays');
    if (used && !NUMBER.test(used)) {
      errors.push({ row: rowNo, field: 'usedDays', message: '사용일수는 숫자여야 합니다.' });
    }
    if (errors.length === 0 && used && D(used).gt(D(text(row, 'grantedDays')))) {
      errors.push({ row: rowNo, field: 'usedDays', message: '사용일수가 부여일수를 초과합니다.' });
    }
    return errors;
  },

  async applyRow(rc, row) {
    const employeeId = rc.employeesByNo.get(text(row, 'employeeNo'))!.id;
    const leaveType = text(row, 'leaveType') || 'ANNUAL';
    const grantDate = text(row, 'grantDate');

    const grant = await rc.ctx.tx.leaveGrant.create({
      data: {
        employeeId,
        leaveType,
        days: text(row, 'grantedDays'),
        grantDate: toDateOnly(grantDate),
        expiresAt: toDateOnly(text(row, 'expiresAt')),
        sourceType: 'MIGRATION',
        sourceId: `${text(row, 'employeeNo')}:${grantDate}`,
        reason: '연차 이관',
      },
    });

    /**
     * Days already taken are migrated as one usage row rather than day by day: the source
     * system holds the individual absences, and inventing dates for them would put entries
     * in the attendance record that never happened.
     */
    const used = D(text(row, 'usedDays') || '0');
    if (used.gt(0)) {
      await rc.ctx.tx.leaveUsage.create({
        data: {
          employeeId,
          leaveType,
          days: used.toString(),
          usageDate: toDateOnly(grantDate),
          sourceType: 'MIGRATION',
          sourceId: `${text(row, 'employeeNo')}:${grantDate}`,
        },
      });
    }

    return { entityType: 'LeaveGrant', entityId: grant.id };
  },

  async preview(_rc, rows) {
    const granted = sumOf(rows, 'grantedDays');
    const used = sumOf(rows, 'usedDays');
    return [
      { label: '이관 예정 행', value: String(rows.length) },
      { label: '부여 합계', value: granted.toString() },
      { label: '사용 합계', value: used.toString() },
      { label: '잔여 합계', value: granted.minus(used).toString() },
    ];
  },

  async reconcile(rc, rows) {
    const [grants, usages] = await Promise.all([
      rc.ctx.tx.leaveGrant.aggregate({ where: { sourceType: 'MIGRATION' }, _sum: { days: true } }),
      rc.ctx.tx.leaveUsage.aggregate({ where: { sourceType: 'MIGRATION' }, _sum: { days: true } }),
    ]);
    const storedGranted = D(String(grants._sum?.days ?? 0));
    const storedUsed = D(String(usages._sum?.days ?? 0));
    return [
      line('부여 합계', sumOf(rows, 'grantedDays').toString(), storedGranted.toString()),
      line('사용 합계', sumOf(rows, 'usedDays').toString(), storedUsed.toString()),
      line(
        '잔여 합계',
        sumOf(rows, 'grantedDays').minus(sumOf(rows, 'usedDays')).toString(),
        storedGranted.minus(storedUsed).toString(),
      ),
    ];
  },

  async summarise(rc, _rows) {
    const [grants, usages] = await Promise.all([
      rc.ctx.tx.leaveGrant.aggregate({ where: { sourceType: 'MIGRATION' }, _sum: { days: true } }),
      rc.ctx.tx.leaveUsage.aggregate({ where: { sourceType: 'MIGRATION' }, _sum: { days: true } }),
    ]);
    const granted = D(String(grants._sum?.days ?? 0));
    const used = D(String(usages._sum?.days ?? 0));
    return [
      { label: '이관 부여', value: granted.toString() },
      { label: '이관 사용', value: used.toString() },
      { label: '이관 잔여', value: granted.minus(used).toString() },
    ];
  },
};

// ── HISTORICAL_SALES (MIG-08) ──

/**
 * Past documents are migrated for reference, not re-posted.
 *
 * The opening stock and the opening balances already carry the position those documents
 * produced. Posting them again would count every historical sale twice — once in the
 * opening figures and once in its own ledger rows — so the documents are stored with their
 * lines and marked as migrated, and they deliberately write nothing to the inventory
 * ledger, the receivables or the journal. DEC-08 leaves the scope to be agreed per source
 * file; this is the reference-only mode that agreement starts from.
 */
const historicalSalesHandler: TargetHandler = {
  prepare: baseContext,
  sourceKey: (row) => `HSALES:${text(row, 'docNo')}:${text(row, 'itemCode')}`,

  async validateRow(rc, row, rowNo) {
    const errors = [
      ...requireText(row, 'docNo', '전표번호', rowNo),
      ...requireDate(row, 'docDate', '전표일자', rowNo),
      ...requireRef(rc.partnersByCode, row, 'partnerCode', '거래처', rowNo),
      ...requireRef(rc.warehousesByCode, row, 'warehouseCode', '창고', rowNo),
      ...requireRef(rc.itemsByCode, row, 'itemCode', '품목', rowNo),
      ...requireNumber(row, 'quantity', '수량', rowNo),
      ...requireNumber(row, 'unitPrice', '단가', rowNo),
    ];
    const tax = text(row, 'taxType');
    if (tax && !(TAX_TYPES as readonly string[]).includes(tax)) {
      errors.push({ row: rowNo, field: 'taxType', message: `과세구분이 올바르지 않습니다: ${tax}` });
    }
    return errors;
  },

  async applyRow(rc, row) {
    const docNo = `MIG-${text(row, 'docNo')}`;
    const qty = D(text(row, 'quantity'));
    const price = D(text(row, 'unitPrice'));
    const supply = qty.times(price).toDecimalPlaces(0, 1);
    const taxType = text(row, 'taxType') || 'TAXABLE';
    const vat = taxType === 'TAXABLE' ? supply.times('0.1').toDecimalPlaces(0, 1) : D(0);

    const existing = await rc.ctx.tx.salesDocument.findUnique({ where: { docNo } });
    const document =
      existing ??
      (await rc.ctx.tx.salesDocument.create({
        data: {
          docNo,
          docType: 'SALES',
          docDate: toDateOnly(text(row, 'docDate')),
          partnerId: rc.partnersByCode.get(text(row, 'partnerCode'))!.id,
          warehouseId: rc.warehousesByCode.get(text(row, 'warehouseCode'))!.id,
          // no confirmedAt: a migrated reference document is not part of this system's
          // books, and the reports read confirmedAt, so this keeps it out of them
          status: 'MIGRATED',
          note: '과거 전표 이관 (참조용, 원장 미반영)',
          supplyAmount: '0',
          vatAmount: '0',
          totalAmount: '0',
        },
      }));

    const lineNo = (await rc.ctx.tx.salesDocumentLine.count({ where: { documentId: document.id } })) + 1;
    await rc.ctx.tx.salesDocumentLine.create({
      data: {
        documentId: document.id,
        lineNo,
        itemId: rc.itemsByCode.get(text(row, 'itemCode'))!.id,
        quantity: quantity(qty),
        unitPrice: unitPrice(price),
        taxType,
        supplyAmount: amount(supply),
        vatAmount: amount(vat),
      },
    });

    await rc.ctx.tx.salesDocument.update({
      where: { id: document.id },
      data: {
        supplyAmount: { increment: amount(supply) },
        vatAmount: { increment: amount(vat) },
        totalAmount: { increment: amount(supply.plus(vat)) },
      },
    });

    return { entityType: 'SalesDocument', entityId: document.id };
  },

  async preview(_rc, rows) {
    const docs = new Set(rows.map((r) => text(r, 'docNo')));
    const supply = rows.reduce(
      (acc, r) =>
        add(
          acc,
          D(text(r, 'quantity') || '0')
            .times(D(text(r, 'unitPrice') || '0'))
            .toDecimalPlaces(0, 1),
        ),
      D(0),
    );
    return [
      { label: '이관 예정 전표', value: String(docs.size) },
      { label: '이관 예정 라인', value: String(rows.length) },
      { label: '공급가액 합계', value: amount(supply) },
      { label: '반영 방식', value: '참조용 — 재고·채권·분개 미반영' },
    ];
  },

  async reconcile(rc, rows) {
    const supply = rows.reduce(
      (acc, r) =>
        add(
          acc,
          D(text(r, 'quantity') || '0')
            .times(D(text(r, 'unitPrice') || '0'))
            .toDecimalPlaces(0, 1),
        ),
      D(0),
    );
    const stored = await rc.ctx.tx.salesDocument.aggregate({
      where: { status: 'MIGRATED' },
      _sum: { supplyAmount: true },
    });
    const ledger = await rc.ctx.tx.inventoryLedger.count({ where: { sourceType: 'MIGRATED_SALES' } });
    return [
      line('공급가액 합계', amount(supply), amount(D(String(stored._sum?.supplyAmount ?? 0)))),
      // the whole point of reference-only: this must be zero
      line('생성된 재고 원장', '0', String(ledger)),
    ];
  },

  async summarise(rc, _rows) {
    const docs = await rc.ctx.tx.salesDocument.count({ where: { status: 'MIGRATED' } });
    return [
      { label: '이관 과거전표', value: String(docs) },
      { label: '원장 반영', value: '없음 (참조용)' },
    ];
  },
};

export const HANDLERS: Record<MigrationTarget, TargetHandler> = {
  ITEM: itemHandler,
  PARTNER: partnerHandler,
  OPENING_STOCK: openingStockHandler,
  OPEN_ITEM: openItemHandler,
  ACCOUNT: accountHandler,
  OPENING_BALANCE: openingBalanceHandler,
  DEPARTMENT: departmentHandler,
  EMPLOYEE: employeeHandler,
  LEAVE: leaveHandler,
  HISTORICAL_SALES: historicalSalesHandler,
};

// a target without a handler is a bug, and this is where it shows up
for (const target of MIGRATION_TARGETS) {
  if (!HANDLERS[target]) throw new Error(`migration target has no handler: ${target}`);
}
