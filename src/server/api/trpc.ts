import { initTRPC, TRPCError } from '@trpc/server';
import crypto from 'node:crypto';
import superjsonless from './transformer';
import { prisma } from '@/server/db';
import { AppError } from '@/server/core/errors';
import type { Actor, BaseContext } from '@/server/core/context';
import { withTransaction } from '@/server/core/context';
import { has } from '@/server/modules/rbac/service';
import { resolveSession, SESSION_COOKIE } from '@/server/modules/auth/service';
import { getEnv } from '@/server/env';

export interface Context {
  actor: Actor | null;
  requestId: string;
  ip?: string | undefined;
  now: Date;
  isMutation: boolean;
  originOk: boolean;
}

export async function createContext(req: Request): Promise<Context> {
  const cookie = req.headers.get('cookie') ?? '';
  const token = cookie
    .split(';')
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${SESSION_COOKIE}=`))
    ?.slice(SESSION_COOKIE.length + 1);

  const now = new Date();
  const session = token ? await resolveSession(prisma, decodeURIComponent(token), now) : null;

  // NFR-SEC-05: Origin check is the primary CSRF defence; SameSite=Lax is the second.
  const origin = req.headers.get('origin');
  const site = req.headers.get('sec-fetch-site');
  const originOk = !origin
    ? site === null || site === 'same-origin' || site === 'none'
    : origin === getEnv().APP_ORIGIN;

  return {
    actor: session?.actor ?? null,
    requestId: req.headers.get('x-request-id') ?? crypto.randomUUID(),
    ip: req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? undefined,
    now,
    isMutation: req.method !== 'GET',
    originOk,
  };
}

const t = initTRPC.context<Context>().create({
  transformer: superjsonless,
  errorFormatter({ shape, error }) {
    const cause = error.cause;
    if (cause instanceof AppError) {
      return {
        ...shape,
        message: cause.message,
        data: { ...shape.data, appCode: cause.code, meta: cause.meta },
      };
    }
    return shape;
  },
});

export const router = t.router;
export const middleware = t.middleware;

const csrfGuard = middleware(({ ctx, type, next }) => {
  if (type === 'mutation' && !ctx.originOk) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      cause: new AppError('FORBIDDEN', '요청 출처를 확인할 수 없습니다.'),
    });
  }
  return next();
});

export const publicProcedure = t.procedure.use(csrfGuard);

const authGuard = middleware(({ ctx, next }) => {
  if (!ctx.actor) {
    throw new TRPCError({
      code: 'UNAUTHORIZED',
      cause: new AppError('UNAUTHENTICATED', '로그인이 필요합니다.'),
    });
  }
  return next({ ctx: { ...ctx, actor: ctx.actor } });
});

export const authedProcedure = publicProcedure.use(authGuard);

/** Every business procedure declares the permission it needs (NFR-SEC-01). */
export const permissionProcedure = (permission: string) =>
  authedProcedure.use(
    middleware(async ({ ctx, next }) => {
      const actor = ctx.actor as Actor;
      if (!has(actor, permission)) {
        // record the denial for the security audit trail
        await prisma.securityEvent.create({
          data: {
            type: 'FORBIDDEN',
            userId: actor.userId,
            ip: ctx.ip ?? null,
            meta: { permission } as never,
          },
        });
        throw new TRPCError({
          code: 'FORBIDDEN',
          cause: new AppError('FORBIDDEN', '이 기능을 사용할 권한이 없습니다.', { permission }),
        });
      }
      return next();
    }),
  );

export function baseContext(ctx: Context): BaseContext {
  if (!ctx.actor) throw new AppError('UNAUTHENTICATED', '로그인이 필요합니다.');
  return { actor: ctx.actor, requestId: ctx.requestId, ip: ctx.ip, now: ctx.now };
}

/** Opens the single transaction for a mutation (docs/transaction-contract.md §1). */
export async function tx<T>(
  ctx: Context,
  fn: Parameters<typeof withTransaction<T>>[2],
  requestId?: string,
): Promise<T> {
  const base = baseContext(ctx);
  return withTransaction(prisma, requestId ? { ...base, requestId } : base, fn);
}

/** Read-only helper: still a transaction, so scope filters and reads see one snapshot. */
export async function readTx<T>(ctx: Context, fn: Parameters<typeof withTransaction<T>>[2]): Promise<T> {
  return withTransaction(prisma, baseContext(ctx), fn, { timeout: 30000, retries: 1 });
}
