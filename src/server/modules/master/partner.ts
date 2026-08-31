import type { TransactionContext } from '@/server/core/context';
import { AppError } from '@/server/core/errors';
import { requirePermission } from '@/server/modules/rbac/service';
import * as audit from '@/server/modules/audit/service';
import { nextDocNo } from '@/server/modules/numbering/service';
import { formatBusinessNo, normalizeBusinessNo, PARTNER_TYPES, validateBusinessNo } from './validation';
import { amount } from '@/lib/money';
import { buildCsvExport, type CsvExport } from '@/server/core/list-export';

const PARTNER_TYPE_LABEL: Record<string, string> = {
  CUSTOMER: '매출처',
  SUPPLIER: '매입처',
  BOTH: '매출·매입',
};

/** BAS-04/BAS-08/BAS-09: partners, contacts, change history and the no-hard-delete rule. */

export interface ContactInput {
  id?: string;
  name: string;
  position?: string;
  phone?: string;
  email?: string;
  isPrimary?: boolean;
  note?: string;
}

export interface PartnerInput {
  code?: string;
  name: string;
  businessNo?: string;
  ceoName?: string;
  businessType?: string;
  businessItem?: string;
  address?: string;
  phone?: string;
  email?: string;
  partnerType?: string;
  paymentTerms?: string;
  creditLimit?: string;
  note?: string;
  contacts?: ContactInput[];
}

/**
 * BAS-04: the business number is validated when present. The RFP explicitly allows
 * partners without one, so a blank value is accepted and a setting controls whether
 * it is required per partner type.
 */
async function validate(
  ctx: TransactionContext,
  input: Partial<PartnerInput>,
  partnerId?: string,
): Promise<void> {
  const errors: string[] = [];
  if (input.name !== undefined && !input.name.trim()) errors.push('거래처명을 입력하세요.');
  if (input.partnerType !== undefined && !PARTNER_TYPES.includes(input.partnerType as never)) {
    errors.push('거래유형이 올바르지 않습니다.');
  }

  if (input.businessNo) {
    const message = validateBusinessNo(input.businessNo);
    if (message) errors.push(message);
    else {
      const normalized = normalizeBusinessNo(input.businessNo);
      const duplicate = await ctx.tx.partner.findFirst({
        where: { businessNo: normalized, ...(partnerId ? { id: { not: partnerId } } : {}) },
      });
      if (duplicate)
        errors.push(`같은 사업자등록번호의 거래처가 이미 있습니다: ${duplicate.name} (${duplicate.code})`);
    }
  } else if (input.businessNo === '' || input.businessNo === undefined) {
    const setting = await ctx.tx.systemSetting.findUnique({ where: { key: 'partner.requireBusinessNo' } });
    const required = (setting?.value as { value?: boolean } | null)?.value === true;
    if (required && input.name !== undefined) errors.push('정책상 사업자등록번호가 필수입니다.');
  }

  if (input.creditLimit && Number(input.creditLimit) < 0) errors.push('여신한도는 0 이상이어야 합니다.');
  if (errors.length) throw new AppError('VALIDATION', errors.join('\n'), { errors });
}

export async function create(ctx: TransactionContext, input: PartnerInput) {
  requirePermission(ctx.actor, 'master.write');
  await validate(ctx, input);

  const code = input.code ?? (await nextDocNo(ctx, 'PARTNER'));
  try {
    const partner = await ctx.tx.partner.create({
      data: {
        code,
        name: input.name.trim(),
        businessNo: input.businessNo ? normalizeBusinessNo(input.businessNo) : null,
        ceoName: input.ceoName ?? null,
        businessType: input.businessType ?? null,
        businessItem: input.businessItem ?? null,
        address: input.address ?? null,
        phone: input.phone ?? null,
        email: input.email ?? null,
        partnerType: input.partnerType ?? 'BOTH',
        paymentTerms: input.paymentTerms ?? null,
        creditLimit: input.creditLimit ? amount(input.creditLimit) : null,
        note: input.note ?? null,
        contacts: input.contacts?.length
          ? {
              create: input.contacts.map((c, i) => ({
                name: c.name,
                position: c.position ?? null,
                phone: c.phone ?? null,
                email: c.email ?? null,
                isPrimary: c.isPrimary ?? i === 0,
                note: c.note ?? null,
              })),
            }
          : undefined,
      },
      include: { contacts: true },
    });

    // BAS-08: contact details are minimised in the audit trail
    await audit.record(ctx, {
      action: 'partner.create',
      entityType: 'Partner',
      entityId: partner.id,
      after: {
        code,
        name: partner.name,
        businessNo: partner.businessNo,
        partnerType: partner.partnerType,
        creditLimit: partner.creditLimit?.toString() ?? null,
        contactCount: partner.contacts.length,
      },
    });
    return partner;
  } catch (e) {
    if ((e as { code?: string }).code === 'P2002')
      throw new AppError('CONFLICT', `이미 사용 중인 거래처코드입니다: ${code}`);
    throw e;
  }
}

export async function update(
  ctx: TransactionContext,
  id: string,
  input: Partial<PartnerInput>,
  version: number,
) {
  requirePermission(ctx.actor, 'master.write');
  await validate(ctx, input, id);

  const before = await ctx.tx.partner.findUniqueOrThrow({ where: { id } });
  if (before.version !== version) {
    throw new AppError(
      'VERSION_CONFLICT',
      '거래처가 다른 사용자에 의해 변경되었습니다. 새로 고친 뒤 다시 시도하세요.',
    );
  }

  const after = await ctx.tx.partner.update({
    where: { id },
    data: {
      ...(input.name !== undefined ? { name: input.name.trim() } : {}),
      ...(input.businessNo !== undefined
        ? { businessNo: input.businessNo ? normalizeBusinessNo(input.businessNo) : null }
        : {}),
      ...(input.ceoName !== undefined ? { ceoName: input.ceoName } : {}),
      ...(input.businessType !== undefined ? { businessType: input.businessType } : {}),
      ...(input.businessItem !== undefined ? { businessItem: input.businessItem } : {}),
      ...(input.address !== undefined ? { address: input.address } : {}),
      ...(input.phone !== undefined ? { phone: input.phone } : {}),
      ...(input.email !== undefined ? { email: input.email } : {}),
      ...(input.partnerType !== undefined ? { partnerType: input.partnerType } : {}),
      ...(input.paymentTerms !== undefined ? { paymentTerms: input.paymentTerms } : {}),
      ...(input.creditLimit !== undefined
        ? { creditLimit: input.creditLimit ? amount(input.creditLimit) : null }
        : {}),
      ...(input.note !== undefined ? { note: input.note } : {}),
      version: { increment: 1 },
    },
  });

  if (input.contacts) {
    await ctx.tx.partnerContact.deleteMany({ where: { partnerId: id } });
    if (input.contacts.length) {
      await ctx.tx.partnerContact.createMany({
        data: input.contacts.map((c, i) => ({
          partnerId: id,
          name: c.name,
          position: c.position ?? null,
          phone: c.phone ?? null,
          email: c.email ?? null,
          isPrimary: c.isPrimary ?? i === 0,
          note: c.note ?? null,
        })),
      });
    }
  }

  await audit.record(ctx, {
    action: 'partner.update',
    entityType: 'Partner',
    entityId: id,
    before: {
      name: before.name,
      businessNo: before.businessNo,
      partnerType: before.partnerType,
      paymentTerms: before.paymentTerms,
      creditLimit: before.creditLimit?.toString() ?? null,
    },
    after: {
      name: after.name,
      businessNo: after.businessNo,
      partnerType: after.partnerType,
      paymentTerms: after.paymentTerms,
      creditLimit: after.creditLimit?.toString() ?? null,
    },
  });
  return after;
}

export async function usageCount(ctx: TransactionContext, partnerId: string): Promise<number> {
  const asDefaultSupplier = await ctx.tx.item.count({ where: { defaultSupplierId: partnerId } });
  return asDefaultSupplier;
}

export async function setActive(ctx: TransactionContext, id: string, isActive: boolean) {
  requirePermission(ctx.actor, 'master.write');
  const before = await ctx.tx.partner.findUniqueOrThrow({ where: { id } });
  await ctx.tx.partner.update({ where: { id }, data: { isActive, version: { increment: 1 } } });
  await audit.record(ctx, {
    action: isActive ? 'partner.activate' : 'partner.deactivate',
    entityType: 'Partner',
    entityId: id,
    before: { isActive: before.isActive },
    after: { isActive },
  });
}

export async function remove(ctx: TransactionContext, id: string) {
  requirePermission(ctx.actor, 'master.write');
  const used = await usageCount(ctx, id);
  if (used > 0) {
    throw new AppError(
      'MASTER_IN_USE',
      `이미 사용된 거래처는 삭제할 수 없습니다(관련 자료 ${used}건). 사용중지로 처리하세요.`,
    );
  }
  const partner = await ctx.tx.partner.findUniqueOrThrow({ where: { id } });
  await ctx.tx.partner.delete({ where: { id } });
  await audit.record(ctx, {
    action: 'partner.delete',
    entityType: 'Partner',
    entityId: id,
    before: { code: partner.code, name: partner.name },
  });
}

export async function list(
  ctx: TransactionContext,
  input: { q?: string; partnerType?: string; activeOnly?: boolean; skip: number; take: number },
) {
  requirePermission(ctx.actor, 'master.read');
  const where = {
    ...(input.activeOnly ? { isActive: true } : {}),
    ...(input.partnerType && input.partnerType !== 'BOTH'
      ? { partnerType: { in: [input.partnerType, 'BOTH'] } }
      : input.partnerType
        ? { partnerType: input.partnerType }
        : {}),
    ...(input.q
      ? {
          OR: [
            { code: { contains: input.q, mode: 'insensitive' as const } },
            { name: { contains: input.q, mode: 'insensitive' as const } },
            { businessNo: { contains: normalizeBusinessNo(input.q) } },
          ],
        }
      : {}),
  };
  const [rows, total] = await Promise.all([
    ctx.tx.partner.findMany({
      where,
      include: { contacts: { where: { isPrimary: true }, take: 1 } },
      orderBy: { code: 'asc' },
      skip: input.skip,
      take: input.take,
    }),
    ctx.tx.partner.count({ where }),
  ]);
  return { rows, total };
}

const PARTNER_CSV_HEADERS = [
  '거래처코드',
  '거래처명',
  '사업자번호',
  '대표자',
  '거래유형',
  '결제조건',
  '여신한도',
  '담당자',
  '사용여부',
];

/** UIX-03: server-side export for the 거래처 grid — same permission and rows as `list`. */
export async function listCsv(
  ctx: TransactionContext,
  input: { q?: string; partnerType?: string; activeOnly?: boolean },
): Promise<CsvExport> {
  return buildCsvExport(
    (paging) => list(ctx, { ...input, ...paging }),
    PARTNER_CSV_HEADERS,
    (r) => [
      r.code,
      r.name,
      r.businessNo ? formatBusinessNo(r.businessNo) : '',
      r.ceoName ?? '',
      PARTNER_TYPE_LABEL[r.partnerType] ?? r.partnerType,
      r.paymentTerms ?? '',
      r.creditLimit?.toString() ?? '',
      r.contacts[0]?.name ?? '',
      r.isActive ? 'Y' : 'N',
    ],
  );
}

export async function detail(ctx: TransactionContext, id: string) {
  requirePermission(ctx.actor, 'master.read');
  const partner = await ctx.tx.partner.findUnique({
    where: { id },
    include: { contacts: { orderBy: { isPrimary: 'desc' } } },
  });
  if (!partner) throw new AppError('NOT_FOUND', '거래처를 찾을 수 없습니다.');
  return { ...partner, usageCount: await usageCount(ctx, id) };
}

export async function search(ctx: TransactionContext, q: string, partnerType?: string, take = 20) {
  requirePermission(ctx.actor, 'master.read');
  return ctx.tx.partner.findMany({
    where: {
      isActive: true,
      ...(partnerType ? { partnerType: { in: [partnerType, 'BOTH'] } } : {}),
      OR: [{ code: { contains: q, mode: 'insensitive' } }, { name: { contains: q, mode: 'insensitive' } }],
    },
    select: { id: true, code: true, name: true, partnerType: true, creditLimit: true, paymentTerms: true },
    orderBy: { code: 'asc' },
    take,
  });
}
