import type { TransactionContext } from '@/server/core/context';
import { AppError } from '@/server/core/errors';
import { requirePermission } from '@/server/modules/rbac/service';
import * as audit from '@/server/modules/audit/service';
import * as conversion from './conversion';
import { priceLines } from './pricing';
import { nextDocNo, DOC_TYPES } from '@/server/modules/numbering/service';
import { assertVersion } from '@/server/core/state-machine';
import { D, quantity } from '@/lib/money';
import { businessDate, toDateOnly } from '@/lib/dates';
import type { LineInput } from './quotation';

/** SLS-03 / SLS-04 — sales orders and their delivery progress. */

export interface OrderInput {
  docDate?: string;
  deliveryDate?: string;
  partnerId: string;
  divisionId?: string;
  note?: string;
  lines: LineInput[];
}

export async function create(ctx: TransactionContext, input: OrderInput) {
  requirePermission(ctx.actor, 'sales.write');
  if (input.lines.length === 0) throw new AppError('VALIDATION', '품목을 한 건 이상 입력하세요.');

  const docDate = input.docDate ?? businessDate(ctx.now);
  const { lines, totals } = priceLines(input.lines);
  const docNo = await nextDocNo(ctx, DOC_TYPES.SALES_ORDER, docDate);

  const order = await ctx.tx.salesOrder.create({
    data: {
      docNo,
      docDate: toDateOnly(docDate),
      deliveryDate: input.deliveryDate ? toDateOnly(input.deliveryDate) : null,
      partnerId: input.partnerId,
      divisionId: input.divisionId ?? null,
      status: 'ACCEPTED',
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
    action: 'salesOrder.create',
    entityType: 'SalesOrder',
    entityId: order.id,
    after: { docNo, docDate, totalAmount: totals.totalAmount },
  });
  return order;
}

export async function cancel(ctx: TransactionContext, id: string, reason: string, version: number) {
  requirePermission(ctx.actor, 'sales.write');
  const order = await ctx.tx.salesOrder.findUniqueOrThrow({
    where: { id },
    include: { lines: true },
  });
  assertVersion('주문서', order.version, version);
  if (order.status === 'CANCELED') throw new AppError('INVALID_TRANSITION', '이미 취소된 주문입니다.');

  // an order that has already been delivered against cannot simply be cancelled
  const progress = await conversion.progressOf(ctx, order.lines);
  if (conversion.progressStatus(progress) !== 'NONE') {
    throw new AppError(
      'CANCEL_BLOCKED',
      '이미 출고된 주문은 취소할 수 없습니다. 매출전표를 먼저 취소하세요.',
    );
  }

  const updated = await ctx.tx.salesOrder.update({
    where: { id },
    data: { status: 'CANCELED', version: { increment: 1 } },
  });

  // release the quotation quantity this order was holding
  await conversion.release(ctx, 'SALES_ORDER', id);

  await audit.record(ctx, {
    action: 'salesOrder.cancel',
    entityType: 'SalesOrder',
    entityId: id,
    before: { status: order.status },
    after: { status: 'CANCELED', reason },
  });
  return updated;
}

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
            { partner: { name: { contains: input.q, mode: 'insensitive' as const } } },
          ],
        }
      : {}),
  };
  const [rows, total] = await Promise.all([
    ctx.tx.salesOrder.findMany({
      where,
      include: { partner: { select: { id: true, name: true } }, _count: { select: { lines: true } } },
      orderBy: [{ docDate: 'desc' }, { docNo: 'desc' }],
      skip: input.skip,
      take: input.take,
    }),
    ctx.tx.salesOrder.count({ where }),
  ]);
  return { rows, total };
}

export async function detail(ctx: TransactionContext, id: string) {
  requirePermission(ctx.actor, 'sales.read');
  const order = await ctx.tx.salesOrder.findUnique({
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
  if (!order) throw new AppError('NOT_FOUND', '주문서를 찾을 수 없습니다.');

  const progress = await conversion.progressOf(ctx, order.lines);
  const byLine = new Map(progress.map((p) => [p.sourceLineId, p]));

  // SLS-04: which sales documents this order has produced
  const conversions = await ctx.tx.documentConversion.findMany({
    where: { sourceType: 'SALES_ORDER', sourceId: id, canceledAt: null },
    select: { targetId: true },
    distinct: ['targetId'],
  });
  const deliveries = await ctx.tx.salesDocument.findMany({
    where: { id: { in: conversions.map((c) => c.targetId) } },
    select: { id: true, docNo: true, docDate: true, status: true, totalAmount: true },
    orderBy: { docDate: 'asc' },
  });

  return {
    ...order,
    lines: order.lines.map((l) => ({
      ...l,
      delivered: byLine.get(l.id)?.convertedQuantity ?? '0.000',
      remaining: byLine.get(l.id)?.remainingQuantity ?? quantity(D(l.quantity)),
    })),
    deliveries,
  };
}
