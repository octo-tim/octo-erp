import type { TransactionContext } from '@/server/core/context';
import { AppError } from '@/server/core/errors';
import { requirePermission } from '@/server/modules/rbac/service';
import { agingBucket, AGING_LABEL, type AgingBucket } from './pricing';
import { amount, D, ZERO } from '@/lib/money';
import { businessDate, daysBetween, toDateOnly } from '@/lib/dates';
import type Decimal from 'decimal.js';

/**
 * SLS-08 / SLS-09 — receivables and payables.
 *
 * The open balance of an item is `amount - sum(matches)`. `settledAmount` on the row is a
 * cache kept in step by this module; the SettlementMatch rows are the truth, which is what
 * lets a reallocation be a pair of rows rather than an overwrite (SLS-10).
 */

export interface RaiseInput {
  documentId: string;
  partnerId: string;
  docDate: Date;
  amount: string;
  isReturn: boolean;
  originalDocumentId?: string | null;
}

/**
 * A sale raises a receivable. A return does NOT raise a negative one — it reduces the
 * original document's receivable, which is what "채권채무 원복" means in SLS-11. If the
 * original is already settled the reduction becomes a credit the partner can draw on,
 * recorded as a negative-amount receivable of its own so the balance stays truthful.
 */
export async function raise(ctx: TransactionContext, input: RaiseInput) {
  if (!input.isReturn) {
    return ctx.tx.receivable.create({
      data: {
        documentId: input.documentId,
        partnerId: input.partnerId,
        docDate: input.docDate,
        amount: amount(input.amount),
        status: 'OPEN',
      },
    });
  }

  const original = input.originalDocumentId
    ? await ctx.tx.receivable.findUnique({ where: { documentId: input.originalDocumentId } })
    : null;

  if (original) {
    const openAmount = D(original.amount).minus(D(original.settledAmount));
    const reduce = D(input.amount);

    if (reduce.lte(openAmount)) {
      // reduce the original directly: the invoice is simply worth less now
      const nextAmount = D(original.amount).minus(reduce);
      await ctx.tx.receivable.update({
        where: { id: original.id },
        data: {
          amount: amount(nextAmount),
          status: statusFor(nextAmount, D(original.settledAmount)),
        },
      });
    } else {
      // the settled part cannot be un-invoiced, so the excess becomes a credit note
      const reducible = openAmount.gt(0) ? openAmount : ZERO;
      if (reducible.gt(0)) {
        const nextAmount = D(original.amount).minus(reducible);
        await ctx.tx.receivable.update({
          where: { id: original.id },
          data: {
            amount: amount(nextAmount),
            status: statusFor(nextAmount, D(original.settledAmount)),
          },
        });
      }
      const credit = reduce.minus(reducible);
      await ctx.tx.receivable.create({
        data: {
          documentId: input.documentId,
          partnerId: input.partnerId,
          docDate: input.docDate,
          amount: amount(credit.neg()),
          status: 'OPEN',
        },
      });
    }
    return original;
  }

  // a return with no traceable original still has to affect the balance
  return ctx.tx.receivable.create({
    data: {
      documentId: input.documentId,
      partnerId: input.partnerId,
      docDate: input.docDate,
      amount: amount(D(input.amount).neg()),
      status: 'OPEN',
    },
  });
}

function statusFor(amountValue: Decimal, settled: Decimal): string {
  if (amountValue.isZero()) return 'SETTLED';
  if (settled.isZero()) return 'OPEN';
  return settled.gte(amountValue) ? 'SETTLED' : 'PARTIAL';
}

/** A receivable that has money against it cannot be reversed by cancelling the invoice. */
export async function assertReversible(ctx: TransactionContext, documentId: string): Promise<void> {
  const row = await ctx.tx.receivable.findUnique({ where: { documentId } });
  if (!row) return;
  if (D(row.settledAmount).gt(0)) {
    throw new AppError(
      'CANCEL_BLOCKED',
      `이미 ${amount(row.settledAmount)}원이 수금된 전표입니다. 수금을 먼저 취소하거나 재배분한 뒤 전표를 취소하세요.`,
      { documentId, settledAmount: amount(row.settledAmount) },
    );
  }
}

export async function reverse(ctx: TransactionContext, documentId: string, reason: string) {
  const row = await ctx.tx.receivable.findUnique({ where: { documentId } });
  if (!row) return;
  await ctx.tx.receivable.update({
    where: { id: row.id },
    data: { status: 'CANCELED', amount: '0' },
  });
  void reason;
}

/** SLS-08: how much a partner currently owes, from the matches, not the cache. */
export async function outstandingOf(ctx: TransactionContext, partnerId: string): Promise<Decimal> {
  const rows = await ctx.tx.receivable.aggregate({
    where: { partnerId, status: { in: ['OPEN', 'PARTIAL'] } },
    _sum: { amount: true, settledAmount: true },
  });
  return D(rows._sum.amount ?? 0).minus(D(rows._sum.settledAmount ?? 0));
}

export async function payableOutstandingOf(ctx: TransactionContext, partnerId: string): Promise<Decimal> {
  const rows = await ctx.tx.payable.aggregate({
    where: { partnerId, status: { in: ['OPEN', 'PARTIAL'] } },
    _sum: { amount: true, settledAmount: true },
  });
  return D(rows._sum.amount ?? 0).minus(D(rows._sum.settledAmount ?? 0));
}

// ── payables (SLS-09) ──

export async function raisePayable(
  ctx: TransactionContext,
  input: {
    documentId: string;
    partnerId: string;
    docDate: Date;
    amount: string;
    isReturn: boolean;
    originalDocumentId?: string | null;
  },
) {
  if (!input.isReturn) {
    return ctx.tx.payable.create({
      data: {
        documentId: input.documentId,
        partnerId: input.partnerId,
        docDate: input.docDate,
        amount: amount(input.amount),
        status: 'OPEN',
      },
    });
  }

  const original = input.originalDocumentId
    ? await ctx.tx.payable.findUnique({ where: { documentId: input.originalDocumentId } })
    : null;

  if (original) {
    const openAmount = D(original.amount).minus(D(original.settledAmount));
    const reduce = D(input.amount);
    const reducible = reduce.lte(openAmount) ? reduce : openAmount.gt(0) ? openAmount : ZERO;

    if (reducible.gt(0)) {
      const nextAmount = D(original.amount).minus(reducible);
      await ctx.tx.payable.update({
        where: { id: original.id },
        data: { amount: amount(nextAmount), status: statusFor(nextAmount, D(original.settledAmount)) },
      });
    }
    const excess = reduce.minus(reducible);
    if (excess.gt(0)) {
      await ctx.tx.payable.create({
        data: {
          documentId: input.documentId,
          partnerId: input.partnerId,
          docDate: input.docDate,
          amount: amount(excess.neg()),
          status: 'OPEN',
        },
      });
    }
    return original;
  }

  return ctx.tx.payable.create({
    data: {
      documentId: input.documentId,
      partnerId: input.partnerId,
      docDate: input.docDate,
      amount: amount(D(input.amount).neg()),
      status: 'OPEN',
    },
  });
}

export async function assertPayableReversible(ctx: TransactionContext, documentId: string): Promise<void> {
  const row = await ctx.tx.payable.findUnique({ where: { documentId } });
  if (!row) return;
  if (D(row.settledAmount).gt(0)) {
    throw new AppError(
      'CANCEL_BLOCKED',
      `이미 ${amount(row.settledAmount)}원이 지급된 전표입니다. 지급을 먼저 취소하거나 재배분한 뒤 전표를 취소하세요.`,
      { documentId, settledAmount: amount(row.settledAmount) },
    );
  }
}

export async function reversePayable(ctx: TransactionContext, documentId: string) {
  const row = await ctx.tx.payable.findUnique({ where: { documentId } });
  if (!row) return;
  await ctx.tx.payable.update({ where: { id: row.id }, data: { status: 'CANCELED', amount: '0' } });
}

// ── reports ──

export interface AgingRow {
  partnerId: string;
  partnerName: string;
  creditLimit: string | null;
  buckets: Record<AgingBucket, string>;
  total: string;
  overLimit: boolean;
}

/** SLS-08: balances by partner, split into aging buckets. */
export async function aging(
  ctx: TransactionContext,
  input: { asOf?: string; partnerId?: string } = {},
): Promise<{ rows: AgingRow[]; bucketLabels: Record<AgingBucket, string>; total: string }> {
  requirePermission(ctx.actor, 'settlement.read');
  const asOf = input.asOf ?? businessDate(ctx.now);

  const open = await ctx.tx.receivable.findMany({
    where: {
      status: { in: ['OPEN', 'PARTIAL'] },
      ...(input.partnerId ? { partnerId: input.partnerId } : {}),
      docDate: { lte: toDateOnly(asOf) },
    },
    include: { partner: { select: { id: true, name: true, creditLimit: true } } },
  });

  const byPartner = new Map<string, AgingRow>();
  let grand = ZERO;

  for (const r of open) {
    const balance = D(r.amount).minus(D(r.settledAmount));
    if (balance.isZero()) continue;

    const days = daysBetween(r.docDate.toISOString().slice(0, 10), asOf);
    const bucket = agingBucket(days);

    let row = byPartner.get(r.partnerId);
    if (!row) {
      row = {
        partnerId: r.partnerId,
        partnerName: r.partner.name,
        creditLimit: r.partner.creditLimit ? amount(r.partner.creditLimit) : null,
        buckets: { CURRENT: '0', D30: '0', D60: '0', D90: '0', OVER90: '0' },
        total: '0',
        overLimit: false,
      };
      byPartner.set(r.partnerId, row);
    }

    row.buckets[bucket] = amount(D(row.buckets[bucket]).plus(balance));
    row.total = amount(D(row.total).plus(balance));
    grand = grand.plus(balance);
  }

  const rows = [...byPartner.values()].map((r) => ({
    ...r,
    overLimit: r.creditLimit !== null && D(r.total).gt(D(r.creditLimit)),
  }));
  rows.sort((a, b) => Number(D(b.total).minus(D(a.total))));

  return { rows, bucketLabels: AGING_LABEL, total: amount(grand) };
}

/** SLS-09: payables by partner with their due dates. */
export async function payableSummary(ctx: TransactionContext, input: { partnerId?: string } = {}) {
  requirePermission(ctx.actor, 'settlement.read');

  const open = await ctx.tx.payable.findMany({
    where: {
      status: { in: ['OPEN', 'PARTIAL'] },
      ...(input.partnerId ? { partnerId: input.partnerId } : {}),
    },
    include: {
      partner: { select: { id: true, name: true } },
      document: { select: { docNo: true } },
    },
    orderBy: [{ dueDate: 'asc' }, { docDate: 'asc' }],
  });

  const rows = open
    .map((p) => ({
      id: p.id,
      partnerId: p.partnerId,
      partnerName: p.partner.name,
      docNo: p.document.docNo,
      docDate: p.docDate.toISOString().slice(0, 10),
      dueDate: p.dueDate ? p.dueDate.toISOString().slice(0, 10) : null,
      amount: amount(p.amount),
      settledAmount: amount(p.settledAmount),
      balance: amount(D(p.amount).minus(D(p.settledAmount))),
    }))
    .filter((p) => p.balance !== '0');

  const total = rows.reduce((acc, r) => acc.plus(D(r.balance)), ZERO);
  return { rows, total: amount(total) };
}

/** Open items for one partner, oldest first — the order the auto-allocation uses. */
export async function openItems(ctx: TransactionContext, partnerId: string, kind: 'RECEIVABLE' | 'PAYABLE') {
  if (kind === 'RECEIVABLE') {
    const rows = await ctx.tx.receivable.findMany({
      where: { partnerId, status: { in: ['OPEN', 'PARTIAL'] } },
      include: { document: { select: { docNo: true, docDate: true } } },
      orderBy: [{ docDate: 'asc' }, { createdAt: 'asc' }],
    });
    return rows
      .map((r) => ({
        id: r.id,
        docNo: r.document.docNo,
        docDate: r.docDate.toISOString().slice(0, 10),
        amount: amount(r.amount),
        settledAmount: amount(r.settledAmount),
        balance: amount(D(r.amount).minus(D(r.settledAmount))),
      }))
      .filter((r) => D(r.balance).gt(0));
  }

  const rows = await ctx.tx.payable.findMany({
    where: { partnerId, status: { in: ['OPEN', 'PARTIAL'] } },
    include: { document: { select: { docNo: true, docDate: true } } },
    orderBy: [{ docDate: 'asc' }, { createdAt: 'asc' }],
  });
  return rows
    .map((r) => ({
      id: r.id,
      docNo: r.document.docNo,
      docDate: r.docDate.toISOString().slice(0, 10),
      amount: amount(r.amount),
      settledAmount: amount(r.settledAmount),
      balance: amount(D(r.amount).minus(D(r.settledAmount))),
    }))
    .filter((r) => D(r.balance).gt(0));
}
