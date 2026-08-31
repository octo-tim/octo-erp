import type { TransactionContext } from '@/server/core/context';
import { AppError } from '@/server/core/errors';
import { requirePermission } from '@/server/modules/rbac/service';
import * as audit from '@/server/modules/audit/service';
import * as conversion from './conversion';
import { priceLines, type PricedLineInput } from './pricing';
import { nextDocNo, DOC_TYPES } from '@/server/modules/numbering/service';
import { assertVersion } from '@/server/core/state-machine';
import { D, quantity } from '@/lib/money';
import { businessDate, toDateOnly } from '@/lib/dates';

/**
 * SLS-01 / SLS-02 / SLS-03 — quotations and sales orders.
 *
 * Both are "upstream" documents whose job is to be converted, partially and repeatedly,
 * into the document below them. Neither touches stock or the books; that only happens when
 * a sales document is confirmed. Remaining quantities live in DocumentConversion.
 */

export interface LineInput extends PricedLineInput {
  itemId: string;
  description?: string;
  /** conversion source line, when this document is created from one above it */
  sourceLineId?: string;
}

export interface QuotationInput {
  docDate?: string;
  validUntil?: string;
  partnerId: string;
  divisionId?: string;
  title?: string;
  note?: string;
  lines: LineInput[];
}

async function validateItems(ctx: TransactionContext, lines: LineInput[]): Promise<void> {
  if (lines.length === 0) throw new AppError('VALIDATION', '품목을 한 건 이상 입력하세요.');
  const items = await ctx.tx.item.findMany({
    where: { id: { in: [...new Set(lines.map((l) => l.itemId))] } },
    select: { id: true, name: true, isActive: true },
  });
  const byId = new Map(items.map((i) => [i.id, i]));
  const errors: string[] = [];
  for (const [i, l] of lines.entries()) {
    const item = byId.get(l.itemId);
    if (!item) errors.push(`${i + 1}행: 존재하지 않는 품목입니다.`);
    else if (!item.isActive) errors.push(`${i + 1}행: 사용중지된 품목입니다(${item.name}).`);
  }
  if (errors.length) throw new AppError('VALIDATION', errors.join('\n'), { errors });
}

// ── SLS-01 quotations ──

export async function create(ctx: TransactionContext, input: QuotationInput) {
  requirePermission(ctx.actor, 'sales.write');
  await validateItems(ctx, input.lines);

  const docDate = input.docDate ?? businessDate(ctx.now);
  const { lines, totals } = priceLines(input.lines);
  const docNo = await nextDocNo(ctx, DOC_TYPES.QUOTATION, docDate);

  const quotation = await ctx.tx.quotation.create({
    data: {
      docNo,
      docDate: toDateOnly(docDate),
      validUntil: input.validUntil ? toDateOnly(input.validUntil) : null,
      partnerId: input.partnerId,
      divisionId: input.divisionId ?? null,
      status: 'DRAFT',
      title: input.title ?? null,
      note: input.note ?? null,
      supplyAmount: totals.supplyAmount,
      vatAmount: totals.vatAmount,
      totalAmount: totals.totalAmount,
      createdById: ctx.actor.userId,
      lines: {
        create: lines.map((l, i) => ({
          lineNo: i + 1,
          itemId: input.lines[i]!.itemId,
          description: input.lines[i]!.description ?? null,
          quantity: l.quantity,
          unitPrice: l.unitPrice,
          taxType: l.taxType,
          supplyAmount: l.supplyAmount,
          vatAmount: l.vatAmount,
        })),
      },
    },
    include: { lines: { orderBy: { lineNo: 'asc' } } },
  });

  await audit.record(ctx, {
    action: 'quotation.create',
    entityType: 'Quotation',
    entityId: quotation.id,
    after: { docNo, docDate, totalAmount: totals.totalAmount },
  });
  return quotation;
}

export async function update(ctx: TransactionContext, id: string, input: QuotationInput, version: number) {
  requirePermission(ctx.actor, 'sales.write');
  const before = await ctx.tx.quotation.findUniqueOrThrow({ where: { id } });
  assertVersion('견적서', before.version, version);
  /**
   * INT-03: only a draft is editable.
   *
   * This used to name CONVERTED and CANCELED and stop there, which let a CONFIRMED quotation
   * — one already sent to the customer — have its lines and totals rewritten in place, with
   * no trace on the document that the figures the customer holds are no longer the figures
   * on file. EXPIRED had the same hole. Listing what may not be edited leaves every status
   * added later editable by default; listing what may be is the safer direction.
   */
  if (before.status !== 'DRAFT') {
    const label: Record<string, string> = {
      CONVERTED: '전환된',
      CANCELED: '취소된',
      CONFIRMED: '확정된',
      EXPIRED: '만료된',
    };
    throw new AppError(
      'IMMUTABLE',
      `${label[before.status] ?? `${before.status} 상태의`} 견적서는 수정할 수 없습니다. 복사해서 새로 작성하세요.`,
      { status: before.status },
    );
  }

  const converted = await ctx.tx.documentConversion.count({
    where: { sourceType: 'QUOTATION', sourceId: id, canceledAt: null },
  });
  if (converted > 0) {
    throw new AppError(
      'IMMUTABLE',
      '이미 주문으로 전환된 견적서는 수정할 수 없습니다. 새 견적을 작성하세요.',
    );
  }

  await validateItems(ctx, input.lines);
  const docDate = input.docDate ?? before.docDate.toISOString().slice(0, 10);
  const { lines, totals } = priceLines(input.lines);

  await ctx.tx.quotationLine.deleteMany({ where: { quotationId: id } });
  const after = await ctx.tx.quotation.update({
    where: { id },
    data: {
      docDate: toDateOnly(docDate),
      validUntil: input.validUntil ? toDateOnly(input.validUntil) : null,
      partnerId: input.partnerId,
      divisionId: input.divisionId ?? null,
      title: input.title ?? null,
      note: input.note ?? null,
      supplyAmount: totals.supplyAmount,
      vatAmount: totals.vatAmount,
      totalAmount: totals.totalAmount,
      version: { increment: 1 },
      lines: {
        create: lines.map((l, i) => ({
          lineNo: i + 1,
          itemId: input.lines[i]!.itemId,
          description: input.lines[i]!.description ?? null,
          quantity: l.quantity,
          unitPrice: l.unitPrice,
          taxType: l.taxType,
          supplyAmount: l.supplyAmount,
          vatAmount: l.vatAmount,
        })),
      },
    },
    include: { lines: { orderBy: { lineNo: 'asc' } } },
  });

  await audit.record(ctx, {
    action: 'quotation.update',
    entityType: 'Quotation',
    entityId: id,
    before: { totalAmount: before.totalAmount.toString() },
    after: { totalAmount: totals.totalAmount },
  });
  return after;
}

/** SLS-01: copying a quotation is how a repeat quote is made, with today's date. */
export async function copy(ctx: TransactionContext, id: string) {
  requirePermission(ctx.actor, 'sales.write');
  const source = await ctx.tx.quotation.findUniqueOrThrow({
    where: { id },
    include: { lines: { orderBy: { lineNo: 'asc' } } },
  });

  return create(ctx, {
    partnerId: source.partnerId,
    ...(source.divisionId ? { divisionId: source.divisionId } : {}),
    ...(source.title ? { title: `${source.title} (복사)` } : {}),
    ...(source.note ? { note: source.note } : {}),
    lines: source.lines.map((l) => ({
      itemId: l.itemId,
      ...(l.description ? { description: l.description } : {}),
      quantity: l.quantity.toString(),
      unitPrice: l.unitPrice.toString(),
      taxType: l.taxType,
    })),
  });
}

export async function setStatus(ctx: TransactionContext, id: string, status: string, version: number) {
  requirePermission(ctx.actor, 'sales.write');
  const before = await ctx.tx.quotation.findUniqueOrThrow({ where: { id } });
  assertVersion('견적서', before.version, version);

  const allowed: Record<string, string[]> = {
    DRAFT: ['CONFIRMED', 'CANCELED'],
    CONFIRMED: ['CANCELED', 'EXPIRED'],
    CONVERTED: [],
    CANCELED: [],
    EXPIRED: ['CONFIRMED'],
  };
  if (!allowed[before.status]?.includes(status)) {
    throw new AppError(
      'INVALID_TRANSITION',
      `견적서 상태를 ${before.status}에서 ${status}(으)로 바꿀 수 없습니다.`,
    );
  }

  const after = await ctx.tx.quotation.update({
    where: { id },
    data: { status, version: { increment: 1 } },
  });
  await audit.record(ctx, {
    action: 'quotation.setStatus',
    entityType: 'Quotation',
    entityId: id,
    before: { status: before.status },
    after: { status },
  });
  return after;
}

// ── SLS-02 quotation → order ──

export interface ConvertLine {
  sourceLineId: string;
  quantity: string;
  /** the price may be renegotiated on conversion */
  unitPrice?: string;
}

export async function convertToOrder(
  ctx: TransactionContext,
  quotationId: string,
  input: { lines: ConvertLine[]; deliveryDate?: string; note?: string },
) {
  requirePermission(ctx.actor, 'sales.write');

  const quotation = await ctx.tx.quotation.findUniqueOrThrow({
    where: { id: quotationId },
    include: { lines: true },
  });
  if (quotation.status === 'CANCELED') {
    throw new AppError('VALIDATION', '취소된 견적서는 전환할 수 없습니다.');
  }
  if (input.lines.length === 0) {
    throw new AppError('VALIDATION', '전환할 라인을 선택하세요.');
  }

  const byId = new Map(quotation.lines.map((l) => [l.id, l]));
  const docDate = businessDate(ctx.now);

  const orderLines = input.lines.map((l, i) => {
    const source = byId.get(l.sourceLineId);
    if (!source) throw new AppError('VALIDATION', `${i + 1}행: 견적서에 없는 라인입니다.`);
    return {
      source,
      itemId: source.itemId,
      description: source.description,
      quantity: l.quantity,
      unitPrice: l.unitPrice ?? source.unitPrice.toString(),
      taxType: source.taxType,
    };
  });

  const { lines, totals } = priceLines(orderLines);
  const docNo = await nextDocNo(ctx, DOC_TYPES.SALES_ORDER, docDate);

  const order = await ctx.tx.salesOrder.create({
    data: {
      docNo,
      docDate: toDateOnly(docDate),
      deliveryDate: input.deliveryDate ? toDateOnly(input.deliveryDate) : null,
      partnerId: quotation.partnerId,
      divisionId: quotation.divisionId,
      status: 'ACCEPTED',
      note: input.note ?? null,
      supplyAmount: totals.supplyAmount,
      vatAmount: totals.vatAmount,
      totalAmount: totals.totalAmount,
      createdById: ctx.actor.userId,
      lines: {
        create: lines.map((l, i) => ({
          lineNo: i + 1,
          itemId: orderLines[i]!.itemId,
          description: orderLines[i]!.description,
          quantity: l.quantity,
          unitPrice: l.unitPrice,
          taxType: l.taxType,
          supplyAmount: l.supplyAmount,
          vatAmount: l.vatAmount,
        })),
      },
    },
    include: { lines: { orderBy: { lineNo: 'asc' } } },
  });

  // the reservation is what makes the quotation's remaining quantity move, under a lock
  for (const [i, l] of input.lines.entries()) {
    const source = byId.get(l.sourceLineId)!;
    await conversion.reserve(
      ctx,
      {
        sourceType: 'QUOTATION',
        sourceId: quotationId,
        sourceLineId: l.sourceLineId,
        targetType: 'SALES_ORDER',
        targetId: order.id,
        targetLineId: order.lines[i]!.id,
        quantity: l.quantity,
        label: `${i + 1}행`,
      },
      source.quantity.toString(),
    );
  }

  // the quotation is CONVERTED only when nothing is left to convert
  const progress = await conversion.progressOf(ctx, quotation.lines);
  if (conversion.progressStatus(progress) === 'COMPLETE') {
    await ctx.tx.quotation.update({ where: { id: quotationId }, data: { status: 'CONVERTED' } });
  }

  await audit.record(ctx, {
    action: 'quotation.convert',
    entityType: 'Quotation',
    entityId: quotationId,
    after: { orderId: order.id, orderNo: order.docNo, lines: input.lines.length },
  });
  return order;
}

// ── read ──

export async function list(
  ctx: TransactionContext,
  input: {
    status?: string;
    partnerId?: string;
    from?: string;
    to?: string;
    q?: string;
    skip: number;
    take: number;
  },
) {
  requirePermission(ctx.actor, 'sales.read');
  const where = {
    ...(input.status ? { status: input.status } : {}),
    ...(input.partnerId ? { partnerId: input.partnerId } : {}),
    ...(input.from || input.to
      ? {
          docDate: {
            ...(input.from ? { gte: toDateOnly(input.from) } : {}),
            ...(input.to ? { lte: toDateOnly(input.to) } : {}),
          },
        }
      : {}),
    ...(input.q
      ? {
          OR: [
            { docNo: { contains: input.q, mode: 'insensitive' as const } },
            { title: { contains: input.q, mode: 'insensitive' as const } },
            { partner: { name: { contains: input.q, mode: 'insensitive' as const } } },
          ],
        }
      : {}),
  };
  const [rows, total] = await Promise.all([
    ctx.tx.quotation.findMany({
      where,
      include: { partner: { select: { id: true, name: true } }, _count: { select: { lines: true } } },
      orderBy: [{ docDate: 'desc' }, { docNo: 'desc' }],
      skip: input.skip,
      take: input.take,
    }),
    ctx.tx.quotation.count({ where }),
  ]);
  return { rows, total };
}

export async function detail(ctx: TransactionContext, id: string) {
  requirePermission(ctx.actor, 'sales.read');
  const quotation = await ctx.tx.quotation.findUnique({
    where: { id },
    include: {
      partner: { select: { id: true, name: true } },
      division: { select: { id: true, name: true } },
      lines: {
        orderBy: { lineNo: 'asc' },
        include: { item: { select: { id: true, code: true, name: true, spec: true, unitCode: true } } },
      },
    },
  });
  if (!quotation) throw new AppError('NOT_FOUND', '견적서를 찾을 수 없습니다.');

  const progress = await conversion.progressOf(ctx, quotation.lines);
  const byLine = new Map(progress.map((p) => [p.sourceLineId, p]));

  return {
    ...quotation,
    lines: quotation.lines.map((l) => ({
      ...l,
      converted: byLine.get(l.id)?.convertedQuantity ?? '0.000',
      remaining: byLine.get(l.id)?.remainingQuantity ?? quantity(D(l.quantity)),
    })),
  };
}
