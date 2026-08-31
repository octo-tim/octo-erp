import type { TransactionContext } from '@/server/core/context';
import { requirePermission, warehouseScopeFilter } from '@/server/modules/rbac/service';
import { add, D, amount, quantity } from '@/lib/money';
import { agingBucket } from '@/server/modules/sales/pricing';
import { resolveFilter, type ReportFilter } from './filter';

/**
 * RPT-04, RPT-05, RPT-09, RPT-10 — inventory, receivables and payables, approval
 * throughput, and attendance and headcount.
 *
 * These read the same ledgers the operational screens read. Nothing is recomputed from a
 * different rule here: the aging buckets come from the pricing module the settlement
 * screen uses, and the stock figures come from the inventory ledger rather than from the
 * snapshot cache, so a drifted cache shows up as a difference rather than as a report
 * quietly agreeing with itself (INT-04).
 */

export interface StockRow {
  itemId: string;
  code: string;
  name: string;
  warehouseId: string;
  warehouseName: string;
  categoryName: string;
  quantity: string;
  amount: string;
  safetyStock: string | null;
  belowSafety: boolean;
}

/** RPT-04: what is on hand, by warehouse, with what it is worth. */
export async function stockStatus(
  ctx: TransactionContext,
  filter: ReportFilter,
): Promise<{ rows: StockRow[]; totals: { quantity: string; amount: string; belowSafety: number } }> {
  requirePermission(ctx.actor, 'report.read');
  const f = resolveFilter(ctx, filter);

  const warehouses = f.warehouseId ? [f.warehouseId] : ctx.actor.isAdmin ? null : ctx.actor.warehouseIds;
  if (warehouses && warehouses.length === 0) {
    return { rows: [], totals: { quantity: '0', amount: '0', belowSafety: 0 } };
  }

  const params: unknown[] = [f.toExclusive];
  const parts = [`l."occurredAt" < $1`];
  let n = 2;
  if (warehouses) {
    parts.push(`l."warehouseId" = ANY($${n}::text[])`);
    params.push(warehouses);
    n += 1;
  }
  if (f.categoryId) {
    parts.push(`i."categoryId" = $${n}`);
    params.push(f.categoryId);
    n += 1;
  }

  // as of the end of the window, which is what "재고현황" means on a dated report
  const sql = `
    SELECT
      i."id" AS "itemId", i."code" AS code, i."name" AS name,
      w."id" AS "warehouseId", w."name" AS "warehouseName",
      COALESCE(c."name", '') AS "categoryName",
      SUM(l."quantity")::text AS quantity,
      SUM(l."amount")::text   AS amount,
      i."safetyStock"::text   AS "safetyStock"
    FROM "InventoryLedger" l
    JOIN "Item" i ON i."id" = l."itemId"
    JOIN "Warehouse" w ON w."id" = l."warehouseId"
    LEFT JOIN "ItemCategory" c ON c."id" = i."categoryId"
    WHERE ${parts.join(' AND ')}
    GROUP BY i."id", i."code", i."name", w."id", w."name", c."name", i."safetyStock"
    HAVING SUM(l."quantity") <> 0
    ORDER BY i."code", w."name"`;

  const raw = await ctx.tx.$queryRawUnsafe<
    {
      itemId: string;
      code: string;
      name: string;
      warehouseId: string;
      warehouseName: string;
      categoryName: string;
      quantity: string;
      amount: string;
      safetyStock: string | null;
    }[]
  >(sql, ...params);

  const rows = raw.map((r) => {
    const qty = D(r.quantity ?? 0);
    const safety = r.safetyStock === null ? null : D(r.safetyStock);
    return {
      ...r,
      quantity: quantity(qty),
      amount: amount(D(r.amount ?? 0)),
      safetyStock: safety ? quantity(safety) : null,
      // INV-07: a safety stock of zero is a real setting, not "unset", so it is compared
      belowSafety: safety !== null && qty.lt(safety),
    };
  });

  return {
    rows,
    totals: {
      quantity: quantity(rows.reduce((acc, r) => add(acc, r.quantity), D(0))),
      amount: amount(rows.reduce((acc, r) => add(acc, r.amount), D(0))),
      belowSafety: rows.filter((r) => r.belowSafety).length,
    },
  };
}

export interface OpenItemRow {
  partnerId: string;
  partnerName: string;
  current: string;
  d30: string;
  d60: string;
  d90: string;
  over90: string;
  total: string;
}

const EMPTY_BUCKETS = { CURRENT: '0', D30: '0', D60: '0', D90: '0', OVER90: '0' };

/** RPT-05: receivables and payables by age, on one screen. */
export async function openItems(
  ctx: TransactionContext,
  filter: ReportFilter,
  kind: 'RECEIVABLE' | 'PAYABLE',
): Promise<{ rows: OpenItemRow[]; totals: OpenItemRow }> {
  requirePermission(ctx.actor, 'report.read');
  const f = resolveFilter(ctx, filter);
  const asOf = new Date(f.toExclusive.getTime() - 24 * 60 * 60 * 1000);

  const where = {
    status: { in: ['OPEN', 'PARTIAL'] },
    docDate: { lt: f.toExclusive },
    ...(f.partnerId ? { partnerId: f.partnerId } : {}),
  };
  const rows =
    kind === 'RECEIVABLE'
      ? await ctx.tx.receivable.findMany({ where, include: { partner: { select: { name: true } } } })
      : await ctx.tx.payable.findMany({ where, include: { partner: { select: { name: true } } } });

  const byPartner = new Map<string, { name: string; buckets: Record<string, string> }>();
  for (const r of rows) {
    const outstanding = D(r.amount).minus(D(r.settledAmount));
    if (outstanding.isZero()) continue;

    // aged from the due date when there is one, otherwise from the document date, which is
    // the same rule the settlement screen uses
    const basis = r.dueDate ?? r.docDate;
    const days = Math.floor((asOf.getTime() - basis.getTime()) / (24 * 60 * 60 * 1000));
    const bucket = agingBucket(Math.max(days, 0));

    const entry = byPartner.get(r.partnerId) ?? {
      name: r.partner.name,
      buckets: { ...EMPTY_BUCKETS },
    };
    entry.buckets[bucket] = add(entry.buckets[bucket] ?? '0', outstanding).toString();
    byPartner.set(r.partnerId, entry);
  }

  const result: OpenItemRow[] = [...byPartner.entries()].map(([partnerId, e]) => {
    const total = Object.values(e.buckets).reduce((acc, v) => add(acc, v), D(0));
    return {
      partnerId,
      partnerName: e.name,
      current: amount(D(e.buckets['CURRENT'] ?? 0)),
      d30: amount(D(e.buckets['D30'] ?? 0)),
      d60: amount(D(e.buckets['D60'] ?? 0)),
      d90: amount(D(e.buckets['D90'] ?? 0)),
      over90: amount(D(e.buckets['OVER90'] ?? 0)),
      total: amount(total),
    };
  });
  result.sort((a, b) => Number(b.total) - Number(a.total));

  const sum = (key: keyof OpenItemRow) => amount(result.reduce((acc, r) => add(acc, r[key] as string), D(0)));

  return {
    rows: result,
    totals: {
      partnerId: '',
      partnerName: '합계',
      current: sum('current'),
      d30: sum('d30'),
      d60: sum('d60'),
      d90: sum('d90'),
      over90: sum('over90'),
      total: sum('total'),
    },
  };
}

export interface ApprovalStatRow {
  formName: string;
  submitted: number;
  approved: number;
  rejected: number;
  pending: number;
  averageHours: string;
}

/** RPT-09: how much approval work went through, and how long it took. */
export async function approvalStats(ctx: TransactionContext, filter: ReportFilter) {
  requirePermission(ctx.actor, 'report.read');
  const f = resolveFilter(ctx, filter);

  const documents = await ctx.tx.approvalDocument.findMany({
    where: { submittedAt: { gte: f.fromDate, lt: f.toExclusive } },
    select: {
      status: true,
      submittedAt: true,
      completedAt: true,
      formVersion: { select: { form: { select: { name: true } } } },
    },
  });

  const byForm = new Map<
    string,
    { submitted: number; approved: number; rejected: number; pending: number; hours: number[] }
  >();
  for (const d of documents) {
    const name = d.formVersion.form.name;
    const e = byForm.get(name) ?? { submitted: 0, approved: 0, rejected: 0, pending: 0, hours: [] };
    e.submitted += 1;
    if (d.status === 'APPROVED') e.approved += 1;
    else if (d.status === 'REJECTED') e.rejected += 1;
    else if (['IN_PROGRESS', 'ON_HOLD'].includes(d.status)) e.pending += 1;
    if (d.submittedAt && d.completedAt) {
      e.hours.push((d.completedAt.getTime() - d.submittedAt.getTime()) / 3_600_000);
    }
    byForm.set(name, e);
  }

  const rows: ApprovalStatRow[] = [...byForm.entries()].map(([formName, e]) => ({
    formName,
    submitted: e.submitted,
    approved: e.approved,
    rejected: e.rejected,
    pending: e.pending,
    averageHours: e.hours.length ? (e.hours.reduce((a, b) => a + b, 0) / e.hours.length).toFixed(1) : '-',
  }));
  rows.sort((a, b) => b.submitted - a.submitted);

  // APV-11: what is still sitting on someone's desk, oldest first
  const stale = await ctx.tx.approvalDocument.findMany({
    where: { status: { in: ['IN_PROGRESS', 'ON_HOLD'] } },
    select: { id: true, docNo: true, title: true, submittedAt: true, currentStepNo: true },
    orderBy: { submittedAt: 'asc' },
    take: 20,
  });

  return {
    rows,
    stale: stale.map((s) => ({
      ...s,
      waitingDays: s.submittedAt
        ? Math.floor((ctx.now.getTime() - s.submittedAt.getTime()) / (24 * 60 * 60 * 1000))
        : 0,
    })),
  };
}

/** RPT-10: attendance, overtime, leave usage and headcount movement. */
export async function workforceStats(ctx: TransactionContext, filter: ReportFilter) {
  requirePermission(ctx.actor, 'report.read');
  requirePermission(ctx.actor, 'hr.read'); // NFR-SEC-02: workforce figures are HR data
  const f = resolveFilter(ctx, filter);

  const [attendance, grants, usages, hired, left, headcount] = await Promise.all([
    ctx.tx.attendance.groupBy({
      by: ['status'],
      where: { workDate: { gte: f.fromDate, lt: f.toExclusive } },
      _count: { _all: true },
      _sum: { overtimeMinutes: true },
    }),
    // a grant counts toward the window when it was live at any point in it
    ctx.tx.leaveGrant.aggregate({
      where: { grantDate: { lt: f.toExclusive }, expiresAt: { gte: f.fromDate } },
      _sum: { days: true },
    }),
    ctx.tx.leaveUsage.aggregate({
      where: { usageDate: { gte: f.fromDate, lt: f.toExclusive } },
      _sum: { days: true },
    }),
    ctx.tx.employee.count({ where: { hireDate: { gte: f.fromDate, lt: f.toExclusive } } }),
    ctx.tx.employee.count({ where: { leaveDate: { gte: f.fromDate, lt: f.toExclusive } } }),
    ctx.tx.employee.count({ where: { status: 'ACTIVE' } }),
  ]);

  const granted = D(grants._sum?.days ?? 0);
  const used = D(usages._sum?.days ?? 0);

  return {
    attendance: attendance.map((a) => ({
      status: a.status,
      days: a._count._all,
      overtimeMinutes: a._sum.overtimeMinutes ?? 0,
    })),
    leave: {
      granted: granted.toString(),
      used: used.toString(),
      // the rate is of what was granted; with nothing granted there is no rate to show
      usageRate: granted.isZero() ? '-' : used.div(granted).times(100).toDecimalPlaces(1).toString(),
    },
    headcount: { current: headcount, hired, left, net: hired - left },
  };
}

/** RPT-06: the numbers behind the home dashboard widgets. */
export async function dashboard(ctx: TransactionContext) {
  requirePermission(ctx.actor, 'report.read');
  const now = ctx.now;
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const nextMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));

  const divisions = ctx.actor.isAdmin ? null : ctx.actor.divisionIds;
  const divisionWhere =
    divisions === null ? {} : { OR: [{ divisionId: null }, { divisionId: { in: divisions } }] };

  const [sales, cost, receivable, stock, below, pending] = await Promise.all([
    ctx.tx.salesDocument.aggregate({
      where: { confirmedAt: { not: null }, docDate: { gte: monthStart, lt: nextMonth }, ...divisionWhere },
      _sum: { supplyAmount: true },
    }),
    ctx.tx.journalLine.aggregate({
      where: {
        account: { code: '501' },
        entry: { confirmedAt: { not: null }, entryDate: { gte: monthStart, lt: nextMonth } },
      },
      _sum: { debit: true, credit: true },
    }),
    ctx.tx.receivable.aggregate({
      where: { status: { in: ['OPEN', 'PARTIAL'] } },
      _sum: { amount: true, settledAmount: true },
    }),
    ctx.tx.inventoryLedger.aggregate({
      where: warehouseScopeFilter(ctx.actor),
      _sum: { amount: true },
    }),
    belowSafetyCount(ctx),
    ctx.tx.approvalStep.count({
      where: { approverId: ctx.actor.userId, status: 'PENDING', document: { status: 'IN_PROGRESS' } },
    }),
  ]);

  const revenue = D(sales._sum.supplyAmount ?? 0);
  const cogs = D(cost._sum.debit ?? 0).minus(D(cost._sum.credit ?? 0));
  const profit = revenue.minus(cogs);

  return {
    monthlySales: amount(revenue),
    monthlyProfit: amount(profit),
    marginRate: revenue.isZero() ? '-' : profit.div(revenue).times(100).toDecimalPlaces(1).toString(),
    outstandingReceivable: amount(
      D(receivable._sum.amount ?? 0).minus(D(receivable._sum.settledAmount ?? 0)),
    ),
    inventoryValue: amount(D(stock._sum.amount ?? 0)),
    belowSafetyStock: below,
    myPendingApprovals: pending,
  };
}

async function belowSafetyCount(ctx: TransactionContext): Promise<number> {
  const scope = ctx.actor.isAdmin ? null : ctx.actor.warehouseIds;
  if (scope && scope.length === 0) return 0;
  const rows = await ctx.tx.$queryRawUnsafe<{ n: number }[]>(
    `SELECT COUNT(*)::int AS n FROM (
       SELECT l."itemId", SUM(l."quantity") AS qty, i."safetyStock"
       FROM "InventoryLedger" l JOIN "Item" i ON i."id" = l."itemId"
       WHERE i."safetyStock" IS NOT NULL ${scope ? 'AND l."warehouseId" = ANY($1::text[])' : ''}
       GROUP BY l."itemId", i."safetyStock"
       HAVING SUM(l."quantity") < i."safetyStock"
     ) t`,
    ...(scope ? [scope] : []),
  );
  return rows[0]?.n ?? 0;
}
