import type { TransactionContext } from '@/server/core/context';
import { AppError } from '@/server/core/errors';
import { requirePermission } from '@/server/modules/rbac/service';
import * as audit from '@/server/modules/audit/service';
import * as accountingPeriod from '@/server/modules/accounting/period';
import * as postingRule from '@/server/modules/accounting/posting-rule';
import * as journal from '@/server/modules/accounting/journal';
import { nextDocNo, DOC_TYPES } from '@/server/modules/numbering/service';
import { openItemDocNo } from './receivable';
import { idempotent } from '@/server/core/idempotency';
import { assertVersion } from '@/server/core/state-machine';
import { amount, D, ZERO } from '@/lib/money';
import { businessDate, toDateOnly } from '@/lib/dates';
import type Decimal from 'decimal.js';

/**
 * SLS-10 — receipts and payments, and how they are applied to open items.
 *
 * Allocation is append-only: a reallocation writes a negative REVERSAL row and then the
 * new MANUAL rows, so the screen can show what was applied, undone, and re-applied rather
 * than a single number that changed for reasons nobody can reconstruct.
 *
 * Over-allocation is impossible in two directions at once: the settlement cannot allocate
 * more than it received, and an open item cannot receive more than it is owed. Both are
 * checked after locking the rows involved.
 */

export type SettlementType = 'RECEIPT' | 'PAYMENT';

export interface CreateInput {
  docType: SettlementType;
  docDate?: string;
  partnerId: string;
  amount: string;
  method?: string;
  bankAccount?: string;
  note?: string;
}

export interface AllocationInput {
  /** the receivable or payable id, depending on the settlement type */
  targetId: string;
  amount: string;
  note?: string;
}

export async function create(ctx: TransactionContext, input: CreateInput) {
  requirePermission(ctx.actor, 'settlement.write');
  const docDate = input.docDate ?? businessDate(ctx.now);
  await accountingPeriod.assertOpen(ctx, docDate);

  if (D(input.amount).lte(0)) {
    throw new AppError('VALIDATION', '금액은 0보다 커야 합니다.');
  }

  const docNo = await nextDocNo(
    ctx,
    input.docType === 'RECEIPT' ? DOC_TYPES.RECEIPT : DOC_TYPES.PAYMENT,
    docDate,
  );

  const settlement = await ctx.tx.settlement.create({
    data: {
      docNo,
      docType: input.docType,
      docDate: toDateOnly(docDate),
      partnerId: input.partnerId,
      method: input.method ?? null,
      bankAccount: input.bankAccount ?? null,
      amount: amount(input.amount),
      status: 'DRAFT',
      note: input.note ?? null,
      createdById: ctx.actor.userId,
    },
  });

  await audit.record(ctx, {
    action: 'settlement.create',
    entityType: 'Settlement',
    entityId: settlement.id,
    after: { docNo, docType: input.docType, amount: amount(input.amount), partnerId: input.partnerId },
  });
  return settlement;
}

/**
 * SLS-10: allocate oldest first. Returns the allocations made, so the caller can show
 * exactly what the automatic run decided rather than only the resulting balances.
 */
export async function autoAllocate(ctx: TransactionContext, settlementId: string) {
  requirePermission(ctx.actor, 'settlement.write');

  const settlement = await lockSettlement(ctx, settlementId);
  assertAllocatable(settlement);
  const remaining = D(settlement.amount).minus(D(settlement.allocatedAmount));
  if (remaining.lte(0)) {
    throw new AppError('VALIDATION', '미배분 잔액이 없습니다.');
  }

  const isReceipt = settlement.docType === 'RECEIPT';
  const open = await openItemsFor(ctx, settlement.partnerId, isReceipt);

  let left = remaining;
  const allocations: AllocationInput[] = [];
  for (const item of open) {
    if (left.lte(0)) break;
    const take = item.balance.lte(left) ? item.balance : left;
    if (take.lte(0)) continue;
    allocations.push({ targetId: item.id, amount: amount(take) });
    left = left.minus(take);
  }

  if (allocations.length === 0) {
    throw new AppError('VALIDATION', '배분할 미결 항목이 없습니다.');
  }

  return applyAllocations(ctx, settlement, allocations, 'AUTO');
}

/**
 * SLS-10: manual reallocation. Every existing allocation is reversed with a negative row
 * and the new set applied, so the history reads as a sequence rather than an edit.
 */
export async function reallocate(
  ctx: TransactionContext,
  settlementId: string,
  allocations: AllocationInput[],
  reason: string,
) {
  requirePermission(ctx.actor, 'settlement.write');
  if (reason.trim().length < 2) throw new AppError('VALIDATION', '재배분 사유를 입력하세요.');

  const settlement = await lockSettlement(ctx, settlementId);
  assertAllocatable(settlement);
  const existing = await ctx.tx.settlementMatch.findMany({ where: { settlementId } });

  // reverse what is there now
  const net = new Map<string, Decimal>();
  for (const m of existing) {
    const key = (m.receivableId ?? m.payableId)!;
    net.set(key, (net.get(key) ?? ZERO).plus(D(m.amount)));
  }

  /**
   * Sorted, like the allocation phase below it. The reversal used to walk the map in
   * insertion order, so two reallocations touching the same pair of open items could take
   * the row locks in opposite orders and deadlock — the exact thing `applyAllocations`
   * already sorts to avoid.
   */
  for (const [targetId, total] of [...net.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (total.isZero()) continue;
    await ctx.tx.settlementMatch.create({
      data: {
        settlementId,
        ...(settlement.docType === 'RECEIPT' ? { receivableId: targetId } : { payableId: targetId }),
        amount: amount(total.neg()),
        origin: 'REVERSAL',
        note: reason,
        createdById: ctx.actor.userId,
      },
    });
    await refreshTarget(ctx, targetId, settlement.docType === 'RECEIPT');
  }

  await ctx.tx.settlement.update({ where: { id: settlementId }, data: { allocatedAmount: '0' } });
  const reloaded = await lockSettlement(ctx, settlementId);

  const result = await applyAllocations(ctx, reloaded, allocations, 'MANUAL');

  await audit.record(ctx, {
    action: 'settlement.reallocate',
    entityType: 'Settlement',
    entityId: settlementId,
    before: { allocations: existing.length },
    after: { allocations: allocations.length, reason },
  });
  return result;
}

/** The shared allocation path. Locks each target, checks both caps, writes the matches. */
async function applyAllocations(
  ctx: TransactionContext,
  settlement: { id: string; docType: string; amount: unknown; allocatedAmount: unknown },
  allocations: AllocationInput[],
  origin: 'AUTO' | 'MANUAL',
) {
  const isReceipt = settlement.docType === 'RECEIPT';
  const table = isReceipt ? 'Receivable' : 'Payable';

  let allocated = D(settlement.allocatedAmount as never);
  const capacity = D(settlement.amount as never);
  const applied: { targetId: string; amount: string; docNo: string }[] = [];

  // deterministic lock order across targets keeps concurrent allocations from deadlocking
  const sorted = [...allocations].sort((a, b) => a.targetId.localeCompare(b.targetId));

  for (const a of sorted) {
    const value = D(a.amount);
    if (value.lte(0)) throw new AppError('VALIDATION', '배분 금액은 0보다 커야 합니다.');

    await ctx.tx.$queryRawUnsafe(`SELECT id FROM "${table}" WHERE id = $1 FOR UPDATE`, a.targetId);

    const target = isReceipt
      ? await ctx.tx.receivable.findUnique({
          where: { id: a.targetId },
          include: { document: { select: { docNo: true } } },
        })
      : await ctx.tx.payable.findUnique({
          where: { id: a.targetId },
          include: { document: { select: { docNo: true } } },
        });
    if (!target) throw new AppError('NOT_FOUND', '미결 항목을 찾을 수 없습니다.', { id: a.targetId });

    const balance = D(target.amount).minus(D(target.settledAmount));
    if (value.gt(balance)) {
      throw new AppError(
        'OVER_ALLOCATION',
        `${openItemDocNo(target)}: 잔액 ${amount(balance)}원을 초과해 배분할 수 없습니다. 요청 ${amount(value)}원.`,
        { targetId: a.targetId, balance: amount(balance), requested: amount(value) },
      );
    }

    allocated = allocated.plus(value);
    if (allocated.gt(capacity)) {
      throw new AppError('OVER_ALLOCATION', `배분 합계가 수납액 ${amount(capacity)}원을 초과했습니다.`, {
        capacity: amount(capacity),
        allocated: amount(allocated),
      });
    }

    await ctx.tx.settlementMatch.create({
      data: {
        settlementId: settlement.id,
        ...(isReceipt ? { receivableId: a.targetId } : { payableId: a.targetId }),
        amount: amount(value),
        origin,
        note: a.note ?? null,
        createdById: ctx.actor.userId,
      },
    });
    await refreshTarget(ctx, a.targetId, isReceipt);
    applied.push({ targetId: a.targetId, amount: amount(value), docNo: openItemDocNo(target) });
  }

  await ctx.tx.settlement.update({
    where: { id: settlement.id },
    data: { allocatedAmount: amount(allocated) },
  });

  return {
    settlementId: settlement.id,
    allocated: amount(allocated),
    unapplied: amount(capacity.minus(allocated)),
    applied,
  };
}

/** Recomputes the cache on one open item from its matches. */
async function refreshTarget(ctx: TransactionContext, targetId: string, isReceipt: boolean) {
  const sum = await ctx.tx.settlementMatch.aggregate({
    where: isReceipt ? { receivableId: targetId } : { payableId: targetId },
    _sum: { amount: true },
  });
  const settled = D(sum._sum.amount ?? 0);

  const row = isReceipt
    ? await ctx.tx.receivable.findUniqueOrThrow({ where: { id: targetId } })
    : await ctx.tx.payable.findUniqueOrThrow({ where: { id: targetId } });

  const total = D(row.amount);
  const status = total.isZero()
    ? 'SETTLED'
    : settled.isZero()
      ? 'OPEN'
      : settled.gte(total)
        ? 'SETTLED'
        : 'PARTIAL';

  if (isReceipt) {
    await ctx.tx.receivable.update({
      where: { id: targetId },
      data: { settledAmount: amount(settled), status },
    });
  } else {
    await ctx.tx.payable.update({
      where: { id: targetId },
      data: { settledAmount: amount(settled), status },
    });
  }
}

/** Confirming posts the receipt/payment journal entry (ACC-03). */
export async function confirm(ctx: TransactionContext, id: string, version: number) {
  requirePermission(ctx.actor, 'settlement.confirm');

  return idempotent(ctx, `settlement.confirm:${id}`, async () => {
    const settlement = await lockSettlement(ctx, id);
    assertVersion('수금·지급', settlement.version, version);
    if (settlement.status !== 'DRAFT') {
      throw new AppError('INVALID_TRANSITION', `현재 상태(${settlement.status})는 확정할 수 없습니다.`);
    }
    if (D(settlement.allocatedAmount).isZero()) {
      throw new AppError('VALIDATION', '배분되지 않은 수금·지급은 확정할 수 없습니다.');
    }

    const docDate = settlement.docDate.toISOString().slice(0, 10);
    await accountingPeriod.assertOpen(ctx, docDate);

    const partner = await ctx.tx.partner.findUniqueOrThrow({ where: { id: settlement.partnerId } });
    await postingRule.post(ctx, settlement.docType, {
      source: { sourceType: settlement.docType, sourceId: settlement.id },
      entryDate: docDate,
      entryType: settlement.docType === 'RECEIPT' ? 'RECEIPT' : 'PAYMENT',
      amounts: { total: amount(settlement.allocatedAmount) },
      description: `${settlement.docType === 'RECEIPT' ? '수금' : '지급'} ${settlement.docNo} ${partner.name}`,
      partnerId: settlement.partnerId,
    });

    const updated = await ctx.tx.settlement.update({
      where: { id },
      data: { status: 'CONFIRMED', confirmedAt: ctx.now, version: { increment: 1 } },
    });

    await audit.record(ctx, {
      action: 'settlement.confirm',
      entityType: 'Settlement',
      entityId: id,
      before: { status: 'DRAFT' },
      after: { status: 'CONFIRMED', allocated: amount(settlement.allocatedAmount) },
    });
    return { id: updated.id, docNo: updated.docNo, status: updated.status };
  });
}

export async function cancel(ctx: TransactionContext, id: string, reason: string, version: number) {
  requirePermission(ctx.actor, 'settlement.confirm');
  if (reason.trim().length < 2) throw new AppError('VALIDATION', '취소 사유를 입력하세요.');

  return idempotent(ctx, `settlement.cancel:${id}`, async () => {
    const settlement = await lockSettlement(ctx, id);
    assertVersion('수금·지급', settlement.version, version);
    if (settlement.status === 'CANCELED') {
      throw new AppError('INVALID_TRANSITION', '이미 취소된 전표입니다.');
    }

    const isReceipt = settlement.docType === 'RECEIPT';
    const matches = await ctx.tx.settlementMatch.findMany({ where: { settlementId: id } });

    // release every allocation with a reversal row, so the open items go back to what they were
    const net = new Map<string, Decimal>();
    for (const m of matches) {
      const key = (m.receivableId ?? m.payableId)!;
      net.set(key, (net.get(key) ?? ZERO).plus(D(m.amount)));
    }
    // same deterministic order as everywhere else that locks open items
    for (const [targetId, total] of [...net.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      if (total.isZero()) continue;
      await ctx.tx.settlementMatch.create({
        data: {
          settlementId: id,
          ...(isReceipt ? { receivableId: targetId } : { payableId: targetId }),
          amount: amount(total.neg()),
          origin: 'REVERSAL',
          note: `취소: ${reason}`,
          createdById: ctx.actor.userId,
        },
      });
      await refreshTarget(ctx, targetId, isReceipt);
    }

    if (settlement.status === 'CONFIRMED') {
      await journal.reverseFromSource(ctx, { sourceType: settlement.docType, sourceId: id }, reason);
    }

    const updated = await ctx.tx.settlement.update({
      where: { id },
      data: {
        status: 'CANCELED',
        canceledAt: ctx.now,
        cancelReason: reason,
        allocatedAmount: '0',
        version: { increment: 1 },
      },
    });

    await audit.record(ctx, {
      action: 'settlement.cancel',
      entityType: 'Settlement',
      entityId: id,
      before: { status: settlement.status },
      after: { status: 'CANCELED', reason },
    });
    return { id: updated.id, docNo: updated.docNo, status: updated.status };
  });
}

// ── helpers ──

async function lockSettlement(ctx: TransactionContext, id: string) {
  await ctx.tx.$queryRawUnsafe('SELECT id FROM "Settlement" WHERE id = $1 FOR UPDATE', id);
  return ctx.tx.settlement.findUniqueOrThrow({ where: { id } });
}

/**
 * SLS-10 / INT-02: allocation only makes sense while the settlement is still a draft.
 *
 * Neither allocation path checked the status. Allocating a CANCELED receipt marked invoices
 * as settled against money that had been cancelled — the cancellation's reversing journal
 * entry still stood, so the receivables sub-ledger and the general ledger disagreed with
 * nothing to show why. Allocating a CONFIRMED one changed which invoices the receipt paid
 * after its journal entry had already been posted from the earlier allocation.
 */
function assertAllocatable(settlement: { status: string; docNo: string }): void {
  if (settlement.status === 'DRAFT') return;
  if (settlement.status === 'CANCELED') {
    throw new AppError(
      'INVALID_TRANSITION',
      `취소된 ${settlement.docNo}에는 배분할 수 없습니다. 새 수금·지급을 등록하세요.`,
      { status: settlement.status },
    );
  }
  throw new AppError(
    'INVALID_TRANSITION',
    `확정된 ${settlement.docNo}의 배분은 바꿀 수 없습니다. 취소한 뒤 다시 등록하세요.`,
    { status: settlement.status },
  );
}

async function openItemsFor(ctx: TransactionContext, partnerId: string, isReceipt: boolean) {
  const rows = isReceipt
    ? await ctx.tx.receivable.findMany({
        where: { partnerId, status: { in: ['OPEN', 'PARTIAL'] } },
        orderBy: [{ docDate: 'asc' }, { createdAt: 'asc' }],
      })
    : await ctx.tx.payable.findMany({
        where: { partnerId, status: { in: ['OPEN', 'PARTIAL'] } },
        orderBy: [{ docDate: 'asc' }, { createdAt: 'asc' }],
      });

  return rows
    .map((r) => ({ id: r.id, balance: D(r.amount).minus(D(r.settledAmount)) }))
    .filter((r) => r.balance.gt(0));
}

// ── read ──

export async function list(
  ctx: TransactionContext,
  input: {
    docType?: SettlementType;
    status?: string;
    partnerId?: string;
    from?: string;
    to?: string;
    skip: number;
    take: number;
  },
) {
  requirePermission(ctx.actor, 'settlement.read');
  const where = {
    ...(input.docType ? { docType: input.docType } : {}),
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
  };

  const [rows, total] = await Promise.all([
    ctx.tx.settlement.findMany({
      where,
      include: { partner: { select: { id: true, name: true } } },
      orderBy: [{ docDate: 'desc' }, { docNo: 'desc' }],
      skip: input.skip,
      take: input.take,
    }),
    ctx.tx.settlement.count({ where }),
  ]);
  return { rows, total };
}

export async function detail(ctx: TransactionContext, id: string) {
  requirePermission(ctx.actor, 'settlement.read');
  const settlement = await ctx.tx.settlement.findUnique({
    where: { id },
    include: {
      partner: { select: { id: true, name: true } },
      matches: {
        orderBy: { createdAt: 'asc' },
        include: {
          receivable: { include: { document: { select: { docNo: true, docDate: true } } } },
          payable: { include: { document: { select: { docNo: true, docDate: true } } } },
        },
      },
    },
  });
  if (!settlement) throw new AppError('NOT_FOUND', '수금·지급 전표를 찾을 수 없습니다.');

  const entry = await ctx.tx.journalEntry.findFirst({
    where: { sourceType: settlement.docType, sourceId: id, sourceVersion: 1 },
    select: { id: true, entryNo: true, status: true },
  });

  return {
    ...settlement,
    unapplied: amount(D(settlement.amount).minus(D(settlement.allocatedAmount))),
    journalEntry: entry,
  };
}
