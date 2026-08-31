import { z } from 'zod';
import { permissionProcedure, readTx, router } from '@/server/api/trpc';
import * as salesReport from '@/server/modules/report/sales-report';
import * as operations from '@/server/modules/report/operations-report';
import * as drilldown from '@/server/modules/report/drilldown';
import { GRANULARITIES } from '@/server/modules/report/filter';
import { cuid, dateString } from '@/server/api/schemas/common';

/**
 * RPT-01 through RPT-10. Every procedure takes the same filter, so a screen can carry the
 * user's period and scope from one report to the next without translating it, and so the
 * drill-down asks the same question the aggregate asked.
 */
const filter = z.object({
  from: dateString,
  to: dateString,
  divisionId: cuid.optional(),
  warehouseId: cuid.optional(),
  partnerId: cuid.optional(),
  categoryId: cuid.optional(),
});

export const reportRouter = router({
  salesTrend: permissionProcedure('report.read')
    .input(z.object({ filter, granularity: z.enum(GRANULARITIES).default('MONTH') }))
    .query(({ ctx, input }) =>
      readTx(ctx, (t) => salesReport.salesTrend(t, input.filter, input.granularity)),
    ),

  itemRanking: permissionProcedure('report.read')
    .input(
      z.object({
        filter,
        top: z.number().int().min(1).max(200).default(20),
        by: z.enum(['AMOUNT', 'QUANTITY']).default('AMOUNT'),
      }),
    )
    .query(({ ctx, input }) =>
      readTx(ctx, (t) => salesReport.itemRanking(t, input.filter, { top: input.top, by: input.by })),
    ),

  partnerPerformance: permissionProcedure('report.read')
    .input(z.object({ filter }))
    .query(({ ctx, input }) => readTx(ctx, (t) => salesReport.partnerPerformance(t, input.filter))),

  stockStatus: permissionProcedure('report.read')
    .input(z.object({ filter }))
    .query(({ ctx, input }) => readTx(ctx, (t) => operations.stockStatus(t, input.filter))),

  openItems: permissionProcedure('report.read')
    .input(z.object({ filter, kind: z.enum(['RECEIVABLE', 'PAYABLE']).default('RECEIVABLE') }))
    .query(({ ctx, input }) => readTx(ctx, (t) => operations.openItems(t, input.filter, input.kind))),

  approvalStats: permissionProcedure('report.read')
    .input(z.object({ filter }))
    .query(({ ctx, input }) => readTx(ctx, (t) => operations.approvalStats(t, input.filter))),

  workforce: permissionProcedure('report.read')
    .input(z.object({ filter }))
    .query(({ ctx, input }) => readTx(ctx, (t) => operations.workforceStats(t, input.filter))),

  dashboard: permissionProcedure('report.read').query(({ ctx }) =>
    readTx(ctx, (t) => operations.dashboard(t)),
  ),

  drillDown: permissionProcedure('report.read')
    .input(
      z.object({
        filter,
        target: z.enum(['SALES', 'PURCHASE', 'RECEIVABLE', 'PAYABLE']),
        itemId: cuid.optional(),
        take: z.number().int().min(1).max(500).default(100),
      }),
    )
    .query(({ ctx, input }) =>
      readTx(ctx, (t) =>
        drilldown.drillDown(t, input.filter, {
          target: input.target,
          ...(input.itemId ? { itemId: input.itemId } : {}),
          take: input.take,
        }),
      ),
    ),
});
