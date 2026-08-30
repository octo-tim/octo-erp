import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@/generated/prisma/client';

// Ledger tables are append-only. DB triggers are the hard guarantee (migration
// 20260830_ledger_guards); this extension gives a clear application-level error first.
const APPEND_ONLY = new Set([
  'InventoryLedger',
  'JournalLine',
  'JournalEntry',
  'LeaveUsage',
  'LeaveGrant',
  'AuditLog',
  'ApprovalActionLog',
  'SensitiveAccessLog',
  'SettlementMatch',
]);

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
