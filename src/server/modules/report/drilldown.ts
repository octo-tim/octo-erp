import type { TransactionContext } from '@/server/core/context';
import { requirePermission } from '@/server/modules/rbac/service';
import { amount, D } from '@/lib/money';
import { divisionIdsFor, isEmptyScope, resolveFilter, type ReportFilter } from './filter';

/**
 * RPT-08 — from an aggregate figure to the documents behind it.
 *
 * The drill-down runs the same scope the aggregate ran. That is the whole point of doing it
 * here rather than letting the screen call the sales list with a filter it assembled
 * itself: a total the user is allowed to see must not become a list of documents they are
 * not, and the reverse — a drill-down that quietly shows fewer rows than the total counts —
 * is just as wrong, because it makes the report look incorrect.
 */

export type DrillTarget = 'SALES' | 'PURCHASE' | 'RECEIVABLE' | 'PAYABLE';

export interface DrillRow {
  id: string;
  docNo: string;
  docDate: string;
  partnerName: string;
  amount: string;
  status: string;
  href: string;
}

export async function drillDown(
  ctx: TransactionContext,
  filter: ReportFilter,
  input: { target: DrillTarget; itemId?: string; take?: number },
): Promise<{ rows: DrillRow[]; total: number }> {
  requirePermission(ctx.actor, 'report.read');
  const f = resolveFilter(ctx, filter);
  const take = Math.min(Math.max(input.take ?? 100, 1), 500);

  const divisions = divisionIdsFor(f);
  const warehouses = f.warehouseId ? [f.warehouseId] : ctx.actor.isAdmin ? null : ctx.actor.warehouseIds;
  if (isEmptyScope(divisions) || isEmptyScope(warehouses)) return { rows: [], total: 0 };

  const dateWindow = { gte: f.fromDate, lt: f.toExclusive };
  const scopeWhere = {
    ...(divisions ? { OR: [{ divisionId: null }, { divisionId: { in: divisions } }] } : {}),
    ...(warehouses ? { warehouseId: { in: warehouses } } : {}),
    ...(f.partnerId ? { partnerId: f.partnerId } : {}),
  };

  if (input.target === 'SALES' || input.target === 'PURCHASE') {
    const where = {
      confirmedAt: { not: null },
      docDate: dateWindow,
      ...scopeWhere,
      ...(input.itemId ? { lines: { some: { itemId: input.itemId } } } : {}),
    };
    const select = {
      id: true,
      docNo: true,
      docDate: true,
      status: true,
      totalAmount: true,
      partner: { select: { name: true } },
    };
    const orderBy = [{ docDate: 'desc' as const }, { docNo: 'desc' as const }];

    if (input.target === 'SALES') {
      const [rows, total] = await Promise.all([
        ctx.tx.salesDocument.findMany({ where, select, orderBy, take }),
        ctx.tx.salesDocument.count({ where }),
      ]);
      return { rows: rows.map((r) => toRow(r, '/sales/sales-documents')), total };
    }
    const [rows, total] = await Promise.all([
      ctx.tx.purchaseDocument.findMany({ where, select, orderBy, take }),
      ctx.tx.purchaseDocument.count({ where }),
    ]);
    return { rows: rows.map((r) => toRow(r, '/sales/purchase-documents')), total };
  }

  // open items carry no division or warehouse of their own; their scope is the document's,
  // so the filter is applied through the document relation rather than dropped
  const documentScope =
    divisions || warehouses
      ? {
          document: {
            ...(divisions ? { OR: [{ divisionId: null }, { divisionId: { in: divisions } }] } : {}),
            ...(warehouses ? { warehouseId: { in: warehouses } } : {}),
          },
        }
      : {};
  const where = {
    status: { in: ['OPEN', 'PARTIAL'] },
    docDate: { lt: f.toExclusive },
    ...(f.partnerId ? { partnerId: f.partnerId } : {}),
    ...documentScope,
  };
  const include = {
    partner: { select: { name: true } },
    document: { select: { id: true, docNo: true } },
  };

  if (input.target === 'RECEIVABLE') {
    const [rows, total] = await Promise.all([
      ctx.tx.receivable.findMany({ where, include, orderBy: { docDate: 'asc' }, take }),
      ctx.tx.receivable.count({ where }),
    ]);
    return { rows: rows.map((r) => openItemRow(r, '/sales/sales-documents')), total };
  }
  const [rows, total] = await Promise.all([
    ctx.tx.payable.findMany({ where, include, orderBy: { docDate: 'asc' }, take }),
    ctx.tx.payable.count({ where }),
  ]);
  return { rows: rows.map((r) => openItemRow(r, '/sales/purchase-documents')), total };
}

function toRow(
  r: {
    id: string;
    docNo: string;
    docDate: Date;
    status: string;
    totalAmount: unknown;
    partner: { name: string };
  },
  base: string,
): DrillRow {
  return {
    id: r.id,
    docNo: r.docNo,
    docDate: r.docDate.toISOString().slice(0, 10),
    partnerName: r.partner.name,
    amount: amount(D(String(r.totalAmount))),
    status: r.status,
    href: `${base}/${r.id}`,
  };
}

function openItemRow(
  r: {
    id: string;
    docDate: Date;
    status: string;
    amount: unknown;
    settledAmount: unknown;
    partner: { name: string };
    document: { id: string; docNo: string };
  },
  base: string,
): DrillRow {
  return {
    id: r.id,
    docNo: r.document.docNo,
    docDate: r.docDate.toISOString().slice(0, 10),
    partnerName: r.partner.name,
    // what is still owed, which is the figure the aging report added up
    amount: amount(D(String(r.amount)).minus(D(String(r.settledAmount)))),
    status: r.status,
    href: `${base}/${r.document.id}`,
  };
}
