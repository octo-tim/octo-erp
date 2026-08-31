import type { TransactionContext } from '@/server/core/context';
import { requirePermission } from '@/server/modules/rbac/service';
import { add, D, amount } from '@/lib/money';
import {
  bucketLabel,
  divisionIdsFor,
  isEmptyScope,
  resolveFilter,
  truncUnit,
  warehouseIdsFor,
  type Granularity,
  type ReportFilter,
} from './filter';

/**
 * RPT-01, RPT-02, RPT-03 — sales trend, item ranking, partner performance.
 *
 * Every figure comes from confirmed documents only, and "confirmed" means the same thing
 * here as it does in the ledgers: a document that has been confirmed at least once, with
 * its cancellation represented by the return or reversal beside it rather than by its
 * disappearance (the CR-10 rule). Aggregation happens in SQL because these tables get
 * large and because the totals on the screen, in the export and in the print view must all
 * come from one dataset (RPT-07) rather than from three passes over different rows.
 */

const CONFIRMED = `d."confirmedAt" IS NOT NULL`;

/** A return is a positive-quantity document, so its sign comes from the document type. */
const SIGN = `CASE WHEN d."docType" = 'RETURN_SALES' THEN -1 ELSE 1 END`;

interface ScopeSql {
  clause: string;
  params: unknown[];
  empty: boolean;
}

/**
 * Builds the shared WHERE fragment with positional parameters. Values are always bound,
 * never interpolated: a report filter is user input.
 */
function scopeOf(f: ReturnType<typeof resolveFilter>, start = 1): ScopeSql {
  const params: unknown[] = [f.fromDate, f.toExclusive];
  const parts = [`d."docDate" >= $${start} AND d."docDate" < $${start + 1}`];
  let n = start + 2;

  const divisions = divisionIdsFor(f);
  const warehouses = warehouseIdsFor(f);
  if (isEmptyScope(divisions) || isEmptyScope(warehouses)) {
    return { clause: 'FALSE', params: [], empty: true };
  }
  if (divisions) {
    // rows with no division are company-wide and stay visible
    parts.push(`(d."divisionId" IS NULL OR d."divisionId" = ANY($${n}::text[]))`);
    params.push(divisions);
    n += 1;
  }
  if (warehouses) {
    parts.push(`d."warehouseId" = ANY($${n}::text[])`);
    params.push(warehouses);
    n += 1;
  }
  if (f.partnerId) {
    parts.push(`d."partnerId" = $${n}`);
    params.push(f.partnerId);
    n += 1;
  }
  return { clause: parts.join(' AND '), params, empty: false };
}

export interface SalesTrendRow {
  bucket: string;
  supplyAmount: string;
  vatAmount: string;
  totalAmount: string;
  costAmount: string;
  profitAmount: string;
  marginRate: string;
  documentCount: number;
}

/** RPT-01: sales, cost and profit over time. Cost comes from the journal, not from a guess. */
export async function salesTrend(
  ctx: TransactionContext,
  filter: ReportFilter,
  granularity: Granularity = 'MONTH',
): Promise<{ rows: SalesTrendRow[]; totals: Omit<SalesTrendRow, 'bucket'> }> {
  requirePermission(ctx.actor, 'report.read');
  const f = resolveFilter(ctx, filter);
  const scope = scopeOf(f);
  if (scope.empty) return { rows: [], totals: emptyTotals() };

  /**
   * The cost of a sale is whatever the confirmation posted to 매출원가, so it is read from
   * the journal rather than recomputed from the item master. Recomputing would drift from
   * the books the moment DEC-01's month-end adjustment moved a unit cost.
   */
  const sql = `
    WITH sales AS (
      SELECT
        date_trunc('${truncUnit(granularity)}', d."docDate") AS bucket,
        SUM(${SIGN} * d."supplyAmount") AS supply,
        SUM(${SIGN} * d."vatAmount") AS vat,
        SUM(${SIGN} * d."totalAmount") AS total,
        COUNT(*) AS docs
      FROM "SalesDocument" d
      WHERE ${CONFIRMED} AND ${scope.clause}
      GROUP BY 1
    ),
    cost AS (
      SELECT
        date_trunc('${truncUnit(granularity)}', d."docDate") AS bucket,
        SUM(${SIGN} * COALESCE(jl."debit", 0) - ${SIGN} * COALESCE(jl."credit", 0)) AS cost
      FROM "SalesDocument" d
      JOIN "JournalEntry" je
        ON je."sourceType" = d."docType" AND je."sourceId" = d."id" AND je."sourceVersion" = 1
      JOIN "JournalLine" jl ON jl."entryId" = je."id"
      JOIN "Account" a ON a."id" = jl."accountId"
      WHERE ${CONFIRMED} AND ${scope.clause} AND a."code" = '501'
      GROUP BY 1
    )
    SELECT
      s.bucket,
      s.supply::text  AS supply,
      s.vat::text     AS vat,
      s.total::text   AS total,
      COALESCE(c.cost, 0)::text AS cost,
      s.docs::int     AS docs
    FROM sales s
    LEFT JOIN cost c ON c.bucket = s.bucket
    ORDER BY s.bucket`;

  // both CTEs use the same placeholder numbers, so the values are bound once, not twice
  const raw = await ctx.tx.$queryRawUnsafe<
    { bucket: Date; supply: string; vat: string; total: string; cost: string; docs: number }[]
  >(sql, ...scope.params);

  const rows = raw.map((r) => {
    const supply = D(r.supply ?? 0);
    const cost = D(r.cost ?? 0);
    const profit = supply.minus(cost);
    return {
      bucket: bucketLabel(granularity, r.bucket),
      supplyAmount: amount(supply),
      vatAmount: amount(D(r.vat ?? 0)),
      totalAmount: amount(D(r.total ?? 0)),
      costAmount: amount(cost),
      profitAmount: amount(profit),
      marginRate: rate(profit, supply),
      documentCount: r.docs,
    };
  });

  return { rows, totals: sumRows(rows) };
}

export interface ItemRankRow {
  itemId: string;
  code: string;
  name: string;
  quantity: string;
  supplyAmount: string;
  share: string;
  rank: number;
}

/** RPT-02: the top items by amount, with each one's share of the period. */
export async function itemRanking(
  ctx: TransactionContext,
  filter: ReportFilter,
  input: { top?: number; by?: 'AMOUNT' | 'QUANTITY' } = {},
): Promise<{ rows: ItemRankRow[]; totalAmount: string }> {
  requirePermission(ctx.actor, 'report.read');
  const f = resolveFilter(ctx, filter);
  const scope = scopeOf(f);
  if (scope.empty) return { rows: [], totalAmount: '0' };

  const top = Math.min(Math.max(input.top ?? 20, 1), 200);
  const orderBy = input.by === 'QUANTITY' ? 'quantity' : 'supply';
  const categoryParam = scope.params.length + 1;

  const sql = `
    SELECT
      i."id"   AS "itemId",
      i."code" AS code,
      i."name" AS name,
      SUM(${SIGN} * l."quantity")::text     AS quantity,
      SUM(${SIGN} * l."supplyAmount")::text AS supply
    FROM "SalesDocumentLine" l
    JOIN "SalesDocument" d ON d."id" = l."documentId"
    JOIN "Item" i ON i."id" = l."itemId"
    WHERE ${CONFIRMED} AND ${scope.clause}
      ${f.categoryId ? `AND i."categoryId" = $${categoryParam}` : ''}
    GROUP BY i."id", i."code", i."name"
    HAVING SUM(${SIGN} * l."supplyAmount") <> 0
    ORDER BY ABS(SUM(${SIGN} * l."${orderBy === 'quantity' ? 'quantity' : 'supplyAmount'}")) DESC
    LIMIT ${top}`;

  const params = f.categoryId ? [...scope.params, f.categoryId] : scope.params;
  const raw = await ctx.tx.$queryRawUnsafe<
    { itemId: string; code: string; name: string; quantity: string; supply: string }[]
  >(sql, ...params);

  // the share is of the ranked total, and the screen says so rather than implying it is
  // a share of all sales
  const total = raw.reduce((acc, r) => add(acc, r.supply ?? '0'), D(0));
  const rows = raw.map((r, i) => ({
    itemId: r.itemId,
    code: r.code,
    name: r.name,
    quantity: D(r.quantity ?? 0).toString(),
    supplyAmount: amount(D(r.supply ?? 0)),
    share: rate(D(r.supply ?? 0), total),
    rank: i + 1,
  }));
  return { rows, totalAmount: amount(total) };
}

export interface PartnerPerformanceRow {
  partnerId: string;
  name: string;
  salesAmount: string;
  purchaseAmount: string;
  priorSalesAmount: string;
  changeRate: string;
  outstanding: string;
}

/** RPT-03: what each partner bought and sold, against the same window a year earlier. */
export async function partnerPerformance(
  ctx: TransactionContext,
  filter: ReportFilter,
): Promise<{ rows: PartnerPerformanceRow[] }> {
  requirePermission(ctx.actor, 'report.read');
  const f = resolveFilter(ctx, filter);
  const scope = scopeOf(f);
  if (scope.empty) return { rows: [] };

  const priorFilter = resolveFilter(ctx, {
    ...filter,
    from: f.priorFromDate.toISOString().slice(0, 10),
    to: new Date(f.priorToExclusive.getTime() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
  });
  const priorScope = scopeOf(priorFilter);

  const salesSql = `
    SELECT d."partnerId" AS id, p."name" AS name, SUM(${SIGN} * d."supplyAmount")::text AS amount
    FROM "SalesDocument" d JOIN "Partner" p ON p."id" = d."partnerId"
    WHERE ${CONFIRMED} AND ${scope.clause}
    GROUP BY d."partnerId", p."name"`;

  const priorSql = `
    SELECT d."partnerId" AS id, SUM(${SIGN} * d."supplyAmount")::text AS amount
    FROM "SalesDocument" d
    WHERE ${CONFIRMED} AND ${priorScope.clause}
    GROUP BY d."partnerId"`;

  const purchaseSql = `
    SELECT d."partnerId" AS id, p."name" AS name,
           SUM(CASE WHEN d."docType" = 'RETURN_PURCHASE' THEN -1 ELSE 1 END * d."supplyAmount")::text AS amount
    FROM "PurchaseDocument" d JOIN "Partner" p ON p."id" = d."partnerId"
    WHERE ${CONFIRMED} AND ${scope.clause}
    GROUP BY d."partnerId", p."name"`;

  const [sales, prior, purchases, open] = await Promise.all([
    ctx.tx.$queryRawUnsafe<{ id: string; name: string; amount: string }[]>(salesSql, ...scope.params),
    ctx.tx.$queryRawUnsafe<{ id: string; amount: string }[]>(priorSql, ...priorScope.params),
    ctx.tx.$queryRawUnsafe<{ id: string; name: string; amount: string }[]>(purchaseSql, ...scope.params),
    ctx.tx.receivable.groupBy({
      by: ['partnerId'],
      where: { status: { in: ['OPEN', 'PARTIAL'] } },
      _sum: { amount: true, settledAmount: true },
    }),
  ]);

  const priorBy = new Map(prior.map((r) => [r.id, r.amount]));
  const purchaseBy = new Map(purchases.map((r) => [r.id, r]));
  const outstandingBy = new Map(
    open.map((r) => [
      r.partnerId,
      D(r._sum.amount ?? 0)
        .minus(D(r._sum.settledAmount ?? 0))
        .toString(),
    ]),
  );

  const names = new Map<string, string>();
  for (const r of sales) names.set(r.id, r.name);
  for (const r of purchases) names.set(r.id, r.name);

  const rows = [...names.entries()].map(([id, name]) => {
    const salesAmount = D(sales.find((s) => s.id === id)?.amount ?? 0);
    const priorAmount = D(priorBy.get(id) ?? 0);
    return {
      partnerId: id,
      name,
      salesAmount: amount(salesAmount),
      purchaseAmount: amount(D(purchaseBy.get(id)?.amount ?? 0)),
      priorSalesAmount: amount(priorAmount),
      changeRate: rate(salesAmount.minus(priorAmount), priorAmount.abs()),
      outstanding: amount(D(outstandingBy.get(id) ?? 0)),
    };
  });

  rows.sort((a, b) => Number(b.salesAmount) - Number(a.salesAmount));
  return { rows };
}

// ── helpers ──

/** A percentage to one decimal place, and '-' when the base is zero rather than 0.0%. */
function rate(part: ReturnType<typeof D>, base: ReturnType<typeof D>): string {
  if (base.isZero()) return '-';
  return part.div(base).times(100).toDecimalPlaces(1).toString();
}

function emptyTotals() {
  return {
    supplyAmount: '0',
    vatAmount: '0',
    totalAmount: '0',
    costAmount: '0',
    profitAmount: '0',
    marginRate: '-',
    documentCount: 0,
  };
}

function sumRows(rows: SalesTrendRow[]) {
  const supply = rows.reduce((acc, r) => add(acc, r.supplyAmount), D(0));
  const cost = rows.reduce((acc, r) => add(acc, r.costAmount), D(0));
  const profit = supply.minus(cost);
  return {
    supplyAmount: amount(supply),
    vatAmount: amount(rows.reduce((acc, r) => add(acc, r.vatAmount), D(0))),
    totalAmount: amount(rows.reduce((acc, r) => add(acc, r.totalAmount), D(0))),
    costAmount: amount(cost),
    profitAmount: amount(profit),
    marginRate: rate(profit, supply),
    documentCount: rows.reduce((acc, r) => acc + r.documentCount, 0),
  };
}
