import type { Prisma, PrismaClient } from '@/generated/prisma/client';

/** docs/transaction-contract.md §1 — every service write takes this. */
export interface Actor {
  userId: string;
  username: string;
  displayName: string;
  employeeId: string | null;
  roles: string[];
  permissions: Set<string>;
  divisionIds: string[];
  warehouseIds: string[];
  isAdmin: boolean;
}

export interface TransactionContext {
  tx: Prisma.TransactionClient;
  actor: Actor;
  requestId: string;
  ip?: string | undefined;
  now: Date;
  /** true only when the caller is the approval module's onApproved handler (APV-08). */
  viaApproval?: boolean;
}

export type BaseContext = Omit<TransactionContext, 'tx'>;

export const SYSTEM_ACTOR: Actor = {
  userId: 'system',
  username: 'system',
  displayName: '시스템',
  employeeId: null,
  roles: ['system'],
  permissions: new Set(['*']),
  divisionIds: [],
  warehouseIds: [],
  isAdmin: true,
};

export function systemContext(requestId: string, now: Date = new Date()): BaseContext {
  return { actor: SYSTEM_ACTOR, requestId, now };
}

const DEADLOCK_CODES = new Set(['40P01', '40001']);

function isRetryable(e: unknown): boolean {
  const code = (e as { code?: string })?.code;
  const meta = (e as { meta?: { code?: string } })?.meta?.code;
  return DEADLOCK_CODES.has(String(code)) || DEADLOCK_CODES.has(String(meta));
}

/**
 * The ONLY place a transaction is opened (docs/engineering-rules.md §1.5).
 * Retries on deadlock/serialization failures, which the inventory locking order makes rare.
 */
export async function withTransaction<T>(
  prisma: PrismaClient,
  base: BaseContext,
  fn: (ctx: TransactionContext) => Promise<T>,
  options?: { maxWait?: number; timeout?: number; retries?: number },
): Promise<T> {
  const retries = options?.retries ?? 3;
  let lastError: unknown;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      return await prisma.$transaction(async (tx) => fn({ ...base, tx }), {
        maxWait: options?.maxWait ?? 5000,
        timeout: options?.timeout ?? 20000,
      });
    } catch (e) {
      lastError = e;
      if (!isRetryable(e) || attempt === retries - 1) throw e;
      await new Promise((r) => setTimeout(r, 25 * (attempt + 1)));
    }
  }
  throw lastError;
}
