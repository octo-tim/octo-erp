import type { PrismaClient } from '@/generated/prisma/client';
import { AppError } from '@/server/core/errors';
import type { Actor, TransactionContext } from '@/server/core/context';
import {
  hashPassword,
  hashToken,
  newSessionToken,
  validatePasswordPolicy,
  verifyPassword,
} from '@/server/core/crypto';

export const SESSION_COOKIE = 'erp_session';
export const ABSOLUTE_TTL_MS = 12 * 60 * 60 * 1000;
export const IDLE_TTL_MS = 2 * 60 * 60 * 1000;
export const MAX_FAILED_LOGINS = 5;
export const LOCK_DURATION_MS = 30 * 60 * 1000;

export interface LoginResult {
  token: string;
  expiresAt: Date;
  mustChangePassword: boolean;
  actor: Actor;
}

export async function securityEvent(
  prisma: PrismaClient,
  type: string,
  data: {
    userId?: string | null;
    actorId?: string | null;
    ip?: string | undefined;
    meta?: Record<string, unknown>;
  },
) {
  // Recorded outside the business transaction: a failed login has no transaction to join.
  await prisma.securityEvent.create({
    data: {
      type,
      userId: data.userId ?? null,
      actorId: data.actorId ?? null,
      ip: data.ip ?? null,
      meta: (data.meta ?? {}) as never,
    },
  });
}

export async function buildActor(prisma: PrismaClient, userId: string): Promise<Actor> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: {
      roles: { include: { role: { include: { permissions: { include: { permission: true } } } } } },
      divisionScopes: true,
      warehouseScopes: true,
    },
  });
  if (!user || !user.isActive) throw new AppError('UNAUTHENTICATED', '사용 중지된 계정입니다.');

  const roles = user.roles.map((r) => r.role.code);
  const permissions = new Set<string>();
  for (const ur of user.roles) for (const rp of ur.role.permissions) permissions.add(rp.permission.code);

  return {
    userId: user.id,
    username: user.username,
    displayName: user.displayName,
    employeeId: user.employeeId,
    roles,
    permissions,
    divisionIds: user.divisionScopes.map((s) => s.divisionId),
    warehouseIds: user.warehouseScopes.map((s) => s.warehouseId),
    isAdmin: roles.includes('admin'),
  };
}

export async function login(
  prisma: PrismaClient,
  input: {
    username: string;
    password: string;
    ip?: string | undefined;
    userAgent?: string | undefined;
    now?: Date;
  },
): Promise<LoginResult> {
  const now = input.now ?? new Date();
  const user = await prisma.user.findUnique({ where: { username: input.username } });

  const genericFailure = new AppError('UNAUTHENTICATED', '아이디 또는 비밀번호가 올바르지 않습니다.');

  if (!user) {
    await prisma.loginAttempt.create({
      data: { username: input.username, success: false, ip: input.ip ?? null },
    });
    await securityEvent(prisma, 'LOGIN_FAILED', {
      ip: input.ip,
      meta: { username: input.username, reason: 'NO_USER' },
    });
    throw genericFailure;
  }

  if (!user.isActive) {
    await securityEvent(prisma, 'LOGIN_FAILED', {
      userId: user.id,
      ip: input.ip,
      meta: { reason: 'INACTIVE' },
    });
    throw new AppError('UNAUTHENTICATED', '사용 중지된 계정입니다. 관리자에게 문의하세요.');
  }

  if (user.lockedUntil && user.lockedUntil > now) {
    await securityEvent(prisma, 'LOGIN_FAILED', {
      userId: user.id,
      ip: input.ip,
      meta: { reason: 'LOCKED' },
    });
    throw new AppError(
      'ACCOUNT_LOCKED',
      '로그인 실패가 반복되어 계정이 잠겼습니다. 관리자에게 잠금 해제를 요청하세요.',
    );
  }

  const ok = await verifyPassword(input.password, user.passwordHash);
  await prisma.loginAttempt.create({
    data: { username: input.username, userId: user.id, success: ok, ip: input.ip ?? null },
  });

  if (!ok) {
    /**
     * The count is incremented by the database, not computed here from a value read
     * earlier. Reading and writing it in the application lets N simultaneous attempts all
     * read the same number and all write the same number, so a parallel attacker walks
     * past the lockout while the counter reads 1.
     */
    const updated = await prisma.user.update({
      where: { id: user.id },
      data: { failedLoginCount: { increment: 1 } },
      select: { failedLoginCount: true },
    });
    const failed = updated.failedLoginCount;
    const lock = failed >= MAX_FAILED_LOGINS;
    if (lock) {
      await prisma.user.update({
        where: { id: user.id },
        data: { lockedUntil: new Date(now.getTime() + LOCK_DURATION_MS) },
      });
    }
    await securityEvent(prisma, lock ? 'ACCOUNT_LOCKED' : 'LOGIN_FAILED', {
      userId: user.id,
      ip: input.ip,
      meta: { failedLoginCount: failed },
    });
    throw lock
      ? new AppError(
          'ACCOUNT_LOCKED',
          `로그인 ${MAX_FAILED_LOGINS}회 실패로 계정이 잠겼습니다. 관리자에게 문의하세요.`,
        )
      : genericFailure;
  }

  // NFR-SEC-03: rotate — every login issues a new session id and drops the caller's previous ones.
  /**
   * The predicate used to be `expiresAt: { lt: now }`, which matches only sessions that
   * had already expired — sessions `resolveSession` rejects anyway. So rotation revoked
   * nothing, and a user who logged in again because they suspected a compromise did not
   * evict the attacker. Live sessions are what has to go.
   */
  await prisma.session.updateMany({
    where: { userId: user.id, revokedAt: null },
    data: { revokedAt: now },
  });

  const { token, id } = newSessionToken();
  const expiresAt = new Date(now.getTime() + ABSOLUTE_TTL_MS);
  await prisma.session.create({
    data: {
      id,
      userId: user.id,
      expiresAt,
      ip: input.ip ?? null,
      userAgent: input.userAgent ?? null,
      lastSeenAt: now,
    },
  });
  await prisma.user.update({
    where: { id: user.id },
    data: { failedLoginCount: 0, lockedUntil: null, lastLoginAt: now },
  });

  return {
    token,
    expiresAt,
    mustChangePassword: user.mustChangePassword,
    actor: await buildActor(prisma, user.id),
  };
}

export async function resolveSession(
  prisma: PrismaClient,
  token: string,
  now: Date = new Date(),
): Promise<{ actor: Actor; sessionId: string } | null> {
  const id = hashToken(token);
  const session = await prisma.session.findUnique({ where: { id } });
  if (!session || session.revokedAt) return null;
  if (session.expiresAt <= now) return null;
  if (now.getTime() - session.lastSeenAt.getTime() > IDLE_TTL_MS) {
    await prisma.session.update({ where: { id }, data: { revokedAt: now } });
    return null;
  }
  // slide the idle window at most once a minute to avoid a write per request
  if (now.getTime() - session.lastSeenAt.getTime() > 60_000) {
    await prisma.session.update({ where: { id }, data: { lastSeenAt: now } });
  }
  try {
    return { actor: await buildActor(prisma, session.userId), sessionId: id };
  } catch {
    return null;
  }
}

export async function logout(prisma: PrismaClient, token: string, now: Date = new Date()): Promise<void> {
  const id = hashToken(token);
  await prisma.session.updateMany({ where: { id, revokedAt: null }, data: { revokedAt: now } });
}

export async function revokeAllSessions(
  prisma: PrismaClient,
  userId: string,
  now: Date = new Date(),
): Promise<number> {
  const res = await prisma.session.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: now },
  });
  await securityEvent(prisma, 'SESSION_REVOKED', { userId, meta: { count: res.count } });
  return res.count;
}

export async function changePassword(
  prisma: PrismaClient,
  input: { userId: string; currentPassword: string; newPassword: string; now?: Date },
): Promise<void> {
  const now = input.now ?? new Date();
  const user = await prisma.user.findUniqueOrThrow({ where: { id: input.userId } });
  if (!(await verifyPassword(input.currentPassword, user.passwordHash))) {
    throw new AppError('VALIDATION', '현재 비밀번호가 올바르지 않습니다.');
  }
  const policyError = validatePasswordPolicy(input.newPassword);
  if (policyError) throw new AppError('VALIDATION', policyError);

  /**
   * All three writes in one transaction. They used to be three independent statements, so
   * a crash or a dropped connection after the first one left the password changed and
   * every stolen session still live, with nothing in the security log to say the password
   * had moved. The whole point of revoking on a password change is that the two happen
   * together.
   *
   * The hash is computed before the transaction opens: scrypt at N=32768 takes long enough
   * that hashing inside would hold a database connection for no reason.
   */
  const passwordHash = await hashPassword(input.newPassword);

  await prisma.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: user.id },
      data: { passwordHash, mustChangePassword: false },
    });
    const revoked = await tx.session.updateMany({
      where: { userId: user.id, revokedAt: null },
      data: { revokedAt: now },
    });
    await tx.securityEvent.createMany({
      data: [
        { type: 'SESSION_REVOKED', userId: user.id, meta: { count: revoked.count } as never },
        {
          type: 'PASSWORD_RESET',
          userId: user.id,
          actorId: user.id,
          meta: { self: true } as never,
        },
      ],
    });
  });
}

/** Admin unlock (NFR-SEC-04) — runs inside a business transaction so it is audited. */
export async function unlockUser(ctx: TransactionContext, userId: string): Promise<void> {
  await ctx.tx.user.update({ where: { id: userId }, data: { failedLoginCount: 0, lockedUntil: null } });
  await ctx.tx.securityEvent.create({
    data: { type: 'ACCOUNT_UNLOCKED', userId, actorId: ctx.actor.userId, ip: ctx.ip ?? null },
  });
}

export async function resetPasswordByAdmin(
  ctx: TransactionContext,
  input: { userId: string; temporaryPassword: string },
): Promise<void> {
  const policyError = validatePasswordPolicy(input.temporaryPassword);
  if (policyError) throw new AppError('VALIDATION', policyError);
  await ctx.tx.user.update({
    where: { id: input.userId },
    data: {
      passwordHash: await hashPassword(input.temporaryPassword),
      mustChangePassword: true,
      failedLoginCount: 0,
      lockedUntil: null,
    },
  });
  await ctx.tx.session.updateMany({
    where: { userId: input.userId, revokedAt: null },
    data: { revokedAt: ctx.now },
  });
  await ctx.tx.securityEvent.create({
    data: { type: 'PASSWORD_RESET', userId: input.userId, actorId: ctx.actor.userId, ip: ctx.ip ?? null },
  });
}

/** HRM-11: called in the same transaction as a resignation assignment. */
export async function deactivateUserForEmployee(ctx: TransactionContext, employeeId: string): Promise<void> {
  const user = await ctx.tx.user.findUnique({ where: { employeeId } });
  if (!user) return;
  await ctx.tx.user.update({ where: { id: user.id }, data: { isActive: false } });
  await ctx.tx.session.updateMany({
    where: { userId: user.id, revokedAt: null },
    data: { revokedAt: ctx.now },
  });
}
