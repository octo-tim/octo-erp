import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@/generated/prisma/client';

// Ledger tables are append-only. DB triggers are the hard guarantee (migration
// 20260830_ledger_guards); this extension gives a clear application-level error first.
const APPEND_ONLY = new Set([
  'InventoryLedger',
  'LeaveUsage',
  'LeaveGrant',
  'AuditLog',
  'ApprovalActionLog',
  'SensitiveAccessLog',
  'SettlementMatch',
]);

// JournalEntry and JournalLine are deliberately NOT in the set above: a DRAFT entry is a
// working document that may still be edited, and confirming or cancelling one is an update.
// What must never change is a CONFIRMED entry, which is a status-dependent rule the flat
// model check here cannot express — the erp_journal_entry_guard / erp_journal_line_guard
// triggers (migration 20260830192500_journal_guard) enforce it in the database instead.

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

function create(connectionString?: string) {
  const adapter = new PrismaPg({ connectionString: connectionString ?? process.env['DATABASE_URL'] });
  return new PrismaClient({ adapter }).$extends({
    query: {
      $allModels: {
        async delete({ model, args, query }) {
          if (APPEND_ONLY.has(model))
            throw new Error(`${model} is append-only: delete is forbidden (INT-04/INT-07)`);
          return query(args);
        },
        async deleteMany({ model, args, query }) {
          if (APPEND_ONLY.has(model))
            throw new Error(`${model} is append-only: delete is forbidden (INT-04/INT-07)`);
          return query(args);
        },
        async update({ model, args, query }) {
          if (APPEND_ONLY.has(model))
            throw new Error(`${model} is append-only: update is forbidden (INT-04/INT-07)`);
          return query(args);
        },
        async updateMany({ model, args, query }) {
          if (APPEND_ONLY.has(model))
            throw new Error(`${model} is append-only: update is forbidden (INT-04/INT-07)`);
          return query(args);
        },
      },
    },
  }) as unknown as PrismaClient;
}

export const prisma: PrismaClient = globalForPrisma.prisma ?? create();
if (process.env['NODE_ENV'] !== 'production') globalForPrisma.prisma = prisma;

export function createPrismaClient(connectionString: string): PrismaClient {
  return create(connectionString);
}
