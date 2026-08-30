import type { TransactionContext } from '@/server/core/context';
import { AppError } from '@/server/core/errors';
import { requirePermission } from '@/server/modules/rbac/service';
import * as audit from '@/server/modules/audit/service';
import * as item from './item';
import * as partner from './partner';
import { TAX_TYPES, validateBarcode, validateBusinessNo } from './validation';

/**
 * BAS-03: bulk registration. Every row is validated first and reported with its row
 * number; the user then applies only the rows they choose. Re-applying the same batch
 * is idempotent because rows are matched by their business key (code).
 */
export const TEMPLATE_VERSION = 1;

export const ITEM_TEMPLATE = [
  { key: 'code', label: '품목코드', required: false, note: '비우면 자동채번' },
  { key: 'name', label: '품목명', required: true },
  { key: 'spec', label: '규격', required: false },
  { key: 'unitCode', label: '단위', required: false, note: '기본 EA' },
  { key: 'categoryCode', label: '품목분류코드', required: false, note: '최하위 분류' },
  { key: 'purchasePrice', label: '입고단가', required: false },
  { key: 'salesPrice', label: '출고단가', required: false },
  { key: 'taxType', label: '과세구분', required: false, note: 'TAXABLE|ZERO|EXEMPT' },
  { key: 'barcode', label: '바코드', required: false },
  { key: 'safetyStock', label: '안전재고', required: false },
  { key: 'leadTimeDays', label: '리드타임(일)', required: false },
  { key: 'supplierCode', label: '기본매입처코드', required: false },
  { key: 'note', label: '비고', required: false },
] as const;

export const PARTNER_TEMPLATE = [
  { key: 'code', label: '거래처코드', required: false, note: '비우면 자동채번' },
  { key: 'name', label: '거래처명', required: true },
  { key: 'businessNo', label: '사업자등록번호', required: false },
  { key: 'ceoName', label: '대표자', required: false },
  { key: 'businessType', label: '업태', required: false },
  { key: 'businessItem', label: '종목', required: false },
  { key: 'address', label: '주소', required: false },
  { key: 'phone', label: '전화번호', required: false },
  { key: 'email', label: '이메일', required: false },
  { key: 'partnerType', label: '거래유형', required: false, note: 'CUSTOMER|SUPPLIER|BOTH' },
  { key: 'paymentTerms', label: '결제조건', required: false },
  { key: 'creditLimit', label: '여신한도', required: false },
] as const;

export type ImportTarget = 'ITEM' | 'PARTNER';

export interface RowError {
  row: number;
  field?: string;
  message: string;
}

export interface ValidationResult {
  batchId: string;
  total: number;
  valid: number;
  errorCount: number;
  errors: RowError[];
  /** 1-based row numbers that passed validation; the user picks from these. */
  validRows: number[];
  preview: { row: number; action: 'CREATE' | 'UPDATE'; summary: string }[];
}

const isBlank = (v: unknown) => v === undefined || v === null || String(v).trim() === '';
const num = /^-?\d+(\.\d+)?$/;

async function validateItemRows(
  ctx: TransactionContext,
  rows: Record<string, string>[],
): Promise<{ errors: RowError[]; preview: ValidationResult['preview']; validRows: number[] }> {
  const errors: RowError[] = [];
  const preview: ValidationResult['preview'] = [];
  const validRows: number[] = [];

  const categories = await ctx.tx.itemCategory.findMany({ select: { id: true, code: true, isActive: true } });
  const categoryByCode = new Map(categories.map((c) => [c.code, c]));
  const suppliers = await ctx.tx.partner.findMany({ select: { id: true, code: true } });
  const supplierByCode = new Map(suppliers.map((p) => [p.code, p]));
  const codes = rows.map((r) => r['code']).filter((c): c is string => !isBlank(c));
  const existing = await ctx.tx.item.findMany({
    where: { code: { in: codes } },
    select: { code: true, name: true },
  });
  const existingByCode = new Map(existing.map((i) => [i.code, i]));

  const seen = new Set<string>();

  rows.forEach((row, i) => {
    const rowNo = i + 1;
    const rowErrors: RowError[] = [];

    if (isBlank(row['name'])) rowErrors.push({ row: rowNo, field: 'name', message: '품목명은 필수입니다.' });

    const code = row['code']?.trim();
    if (code) {
      if (seen.has(code))
        rowErrors.push({ row: rowNo, field: 'code', message: `파일 안에서 중복된 품목코드입니다: ${code}` });
      seen.add(code);
    }

    if (!isBlank(row['taxType']) && !TAX_TYPES.includes(row['taxType']!.trim() as never)) {
      rowErrors.push({
        row: rowNo,
        field: 'taxType',
        message: '과세구분은 TAXABLE, ZERO, EXEMPT 중 하나여야 합니다.',
      });
    }
    for (const field of ['purchasePrice', 'salesPrice', 'safetyStock'] as const) {
      if (!isBlank(row[field]) && !num.test(row[field]!.trim())) {
        rowErrors.push({ row: rowNo, field, message: '숫자만 입력할 수 있습니다.' });
      }
    }
    if (!isBlank(row['leadTimeDays']) && !/^\d+$/.test(row['leadTimeDays']!.trim())) {
      rowErrors.push({ row: rowNo, field: 'leadTimeDays', message: '리드타임은 0 이상의 정수여야 합니다.' });
    }
    if (!isBlank(row['barcode'])) {
      const message = validateBarcode(row['barcode']!.trim());
      if (message) rowErrors.push({ row: rowNo, field: 'barcode', message });
    }
    if (!isBlank(row['categoryCode'])) {
      const category = categoryByCode.get(row['categoryCode']!.trim());
      if (!category)
        rowErrors.push({ row: rowNo, field: 'categoryCode', message: '존재하지 않는 품목분류코드입니다.' });
      else if (!category.isActive)
        rowErrors.push({ row: rowNo, field: 'categoryCode', message: '사용 중지된 품목분류입니다.' });
    }
    if (!isBlank(row['supplierCode']) && !supplierByCode.has(row['supplierCode']!.trim())) {
      rowErrors.push({ row: rowNo, field: 'supplierCode', message: '존재하지 않는 거래처코드입니다.' });
    }

    if (rowErrors.length) {
      errors.push(...rowErrors);
      return;
    }
    validRows.push(rowNo);
    const isUpdate = !!code && existingByCode.has(code);
    preview.push({
      row: rowNo,
      action: isUpdate ? 'UPDATE' : 'CREATE',
      summary: `${code ?? '(자동채번)'} ${row['name']}${row['spec'] ? ` / ${row['spec']}` : ''}`,
    });
  });

  return { errors, preview, validRows };
}

async function validatePartnerRows(
  ctx: TransactionContext,
  rows: Record<string, string>[],
): Promise<{ errors: RowError[]; preview: ValidationResult['preview']; validRows: number[] }> {
  const errors: RowError[] = [];
  const preview: ValidationResult['preview'] = [];
  const validRows: number[] = [];

  const codes = rows.map((r) => r['code']).filter((c): c is string => !isBlank(c));
  const existing = await ctx.tx.partner.findMany({ where: { code: { in: codes } }, select: { code: true } });
  const existingCodes = new Set(existing.map((p) => p.code));
  const seenCodes = new Set<string>();
  const seenBusinessNos = new Set<string>();

  rows.forEach((row, i) => {
    const rowNo = i + 1;
    const rowErrors: RowError[] = [];

    if (isBlank(row['name']))
      rowErrors.push({ row: rowNo, field: 'name', message: '거래처명은 필수입니다.' });

    const code = row['code']?.trim();
    if (code) {
      if (seenCodes.has(code))
        rowErrors.push({
          row: rowNo,
          field: 'code',
          message: `파일 안에서 중복된 거래처코드입니다: ${code}`,
        });
      seenCodes.add(code);
    }

    if (!isBlank(row['businessNo'])) {
      const message = validateBusinessNo(row['businessNo']!);
      if (message) rowErrors.push({ row: rowNo, field: 'businessNo', message });
      else {
        const normalized = row['businessNo']!.replace(/\D/g, '');
        if (seenBusinessNos.has(normalized)) {
          rowErrors.push({
            row: rowNo,
            field: 'businessNo',
            message: '파일 안에서 중복된 사업자등록번호입니다.',
          });
        }
        seenBusinessNos.add(normalized);
      }
    }
    if (!isBlank(row['creditLimit']) && !num.test(row['creditLimit']!.trim())) {
      rowErrors.push({ row: rowNo, field: 'creditLimit', message: '여신한도는 숫자만 입력할 수 있습니다.' });
    }
    if (
      !isBlank(row['partnerType']) &&
      !['CUSTOMER', 'SUPPLIER', 'BOTH'].includes(row['partnerType']!.trim())
    ) {
      rowErrors.push({
        row: rowNo,
        field: 'partnerType',
        message: '거래유형은 CUSTOMER, SUPPLIER, BOTH 중 하나여야 합니다.',
      });
    }

    if (rowErrors.length) {
      errors.push(...rowErrors);
      return;
    }
    validRows.push(rowNo);
    preview.push({
      row: rowNo,
      action: code && existingCodes.has(code) ? 'UPDATE' : 'CREATE',
      summary: `${code ?? '(자동채번)'} ${row['name']}`,
    });
  });

  return { errors, preview, validRows };
}

/** Step 1: validate every row and store the batch. Nothing is written to the masters yet. */
export async function validateBatch(
  ctx: TransactionContext,
  input: {
    targetType: ImportTarget;
    rows: Record<string, string>[];
    fileName?: string;
    templateVersion?: number;
  },
): Promise<ValidationResult> {
  requirePermission(ctx.actor, 'master.write');
  if ((input.templateVersion ?? TEMPLATE_VERSION) !== TEMPLATE_VERSION) {
    throw new AppError(
      'VALIDATION',
      `양식 버전이 다릅니다. 최신 양식(v${TEMPLATE_VERSION})을 내려받아 다시 작성하세요.`,
    );
  }
  if (input.rows.length === 0) throw new AppError('VALIDATION', '업로드할 행이 없습니다.');
  if (input.rows.length > 5000) throw new AppError('VALIDATION', '한 번에 5,000행까지 업로드할 수 있습니다.');

  const result =
    input.targetType === 'ITEM'
      ? await validateItemRows(ctx, input.rows)
      : await validatePartnerRows(ctx, input.rows);

  const batch = await ctx.tx.importBatch.create({
    data: {
      targetType: input.targetType,
      templateVersion: TEMPLATE_VERSION,
      fileName: input.fileName ?? null,
      totalRows: input.rows.length,
      validRows: result.validRows.length,
      errorRows: input.rows.length - result.validRows.length,
      errors: result.errors as never,
      createdById: ctx.actor.userId,
    },
  });

  return {
    batchId: batch.id,
    total: input.rows.length,
    valid: result.validRows.length,
    errorCount: result.errors.length,
    errors: result.errors,
    validRows: result.validRows,
    preview: result.preview,
  };
}

/**
 * Step 2: apply the selected rows. Runs inside the caller's transaction, so a failure
 * on any row rolls the whole application back rather than leaving a half-imported file.
 */
export async function applyBatch(
  ctx: TransactionContext,
  input: {
    batchId: string;
    targetType: ImportTarget;
    rows: Record<string, string>[];
    selectedRows: number[];
  },
): Promise<{ applied: number; created: number; updated: number }> {
  requirePermission(ctx.actor, 'master.write');
  const batch = await ctx.tx.importBatch.findUniqueOrThrow({ where: { id: input.batchId } });
  if (batch.status === 'APPLIED') throw new AppError('DUPLICATE_EFFECT', '이미 반영된 업로드 배치입니다.');

  const categories = await ctx.tx.itemCategory.findMany({ select: { id: true, code: true } });
  const categoryByCode = new Map(categories.map((c) => [c.code, c.id]));
  const partners = await ctx.tx.partner.findMany({ select: { id: true, code: true } });
  const partnerByCode = new Map(partners.map((p) => [p.code, p.id]));

  let created = 0;
  let updated = 0;

  for (const rowNo of input.selectedRows) {
    const row = input.rows[rowNo - 1];
    if (!row) throw new AppError('VALIDATION', `선택한 행이 파일에 없습니다: ${rowNo}행`);

    if (input.targetType === 'ITEM') {
      const code = row['code']?.trim();
      const existing = code ? await ctx.tx.item.findUnique({ where: { code } }) : null;
      const payload = {
        name: row['name']!.trim(),
        ...(row['spec'] ? { spec: row['spec'] } : {}),
        ...(row['unitCode'] ? { unitCode: row['unitCode'] } : {}),
        ...(row['categoryCode'] ? { categoryId: categoryByCode.get(row['categoryCode'].trim())! } : {}),
        ...(row['purchasePrice'] ? { purchasePrice: row['purchasePrice'] } : {}),
        ...(row['salesPrice'] ? { salesPrice: row['salesPrice'] } : {}),
        ...(row['taxType'] ? { taxType: row['taxType'].trim() } : {}),
        ...(row['barcode'] ? { barcode: row['barcode'].trim() } : {}),
        ...(row['safetyStock'] ? { safetyStock: row['safetyStock'] } : {}),
        ...(row['leadTimeDays'] ? { leadTimeDays: Number(row['leadTimeDays']) } : {}),
        ...(row['supplierCode'] ? { defaultSupplierId: partnerByCode.get(row['supplierCode'].trim())! } : {}),
        ...(row['note'] ? { note: row['note'] } : {}),
      };
      if (existing) {
        await item.update(ctx, existing.id, payload, existing.version);
        updated++;
      } else {
        await item.create(ctx, { ...(code ? { code } : {}), ...payload });
        created++;
      }
    } else {
      const code = row['code']?.trim();
      const existing = code ? await ctx.tx.partner.findUnique({ where: { code } }) : null;
      const payload = {
        name: row['name']!.trim(),
        ...(row['businessNo'] ? { businessNo: row['businessNo'] } : {}),
        ...(row['ceoName'] ? { ceoName: row['ceoName'] } : {}),
        ...(row['businessType'] ? { businessType: row['businessType'] } : {}),
        ...(row['businessItem'] ? { businessItem: row['businessItem'] } : {}),
        ...(row['address'] ? { address: row['address'] } : {}),
        ...(row['phone'] ? { phone: row['phone'] } : {}),
        ...(row['email'] ? { email: row['email'] } : {}),
        ...(row['partnerType'] ? { partnerType: row['partnerType'].trim() } : {}),
        ...(row['paymentTerms'] ? { paymentTerms: row['paymentTerms'] } : {}),
        ...(row['creditLimit'] ? { creditLimit: row['creditLimit'] } : {}),
      };
      if (existing) {
        await partner.update(ctx, existing.id, payload, existing.version);
        updated++;
      } else {
        await partner.create(ctx, { ...(code ? { code } : {}), ...payload });
        created++;
      }
    }
  }

  await ctx.tx.importBatch.update({
    where: { id: input.batchId },
    data: { status: 'APPLIED', appliedRows: created + updated, appliedAt: ctx.now },
  });

  await audit.record(ctx, {
    action: 'import.apply',
    entityType: 'ImportBatch',
    entityId: input.batchId,
    after: { targetType: input.targetType, created, updated, selected: input.selectedRows.length },
  });

  return { applied: created + updated, created, updated };
}

export async function listBatches(ctx: TransactionContext, targetType?: ImportTarget, take = 50) {
  requirePermission(ctx.actor, 'master.read');
  return ctx.tx.importBatch.findMany({
    where: targetType ? { targetType } : {},
    orderBy: { createdAt: 'desc' },
    take,
  });
}

export function templateFor(targetType: ImportTarget) {
  return {
    version: TEMPLATE_VERSION,
    columns: targetType === 'ITEM' ? ITEM_TEMPLATE : PARTNER_TEMPLATE,
  };
}
