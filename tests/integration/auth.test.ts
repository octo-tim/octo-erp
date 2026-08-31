// covers: NFR-SEC-03, NFR-SEC-04, INT-09, B-13, B-14
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { actorFor, prepareDatabase, prisma, runTx, truncateBusinessData } from '../helpers/db';
import {
  changePassword,
  login,
  logout,
  MAX_FAILED_LOGINS,
  resolveSession,
  resetPasswordByAdmin,
  revokeAllSessions,
  unlockUser,
} from '@/server/modules/auth/service';
import { hashPassword } from '@/server/core/crypto';
import { AppError } from '@/server/core/errors';
import * as audit from '@/server/modules/audit/service';

const PASSWORD = 'Test!12345678';

beforeAll(async () => {
  prepareDatabase();
  await truncateBusinessData();
  await prisma.user.updateMany({
    where: { username: 'admin' },
    data: {
      passwordHash: await hashPassword(PASSWORD),
      failedLoginCount: 0,
      lockedUntil: null,
      isActive: true,
    },
  });
});

beforeEach(async () => {
  await prisma.session.deleteMany({});
  await prisma.loginAttempt.deleteMany({});
  await prisma.securityEvent.deleteMany({});
  await prisma.user.updateMany({
    where: { username: 'admin' },
    data: { passwordHash: await hashPassword(PASSWORD), failedLoginCount: 0, lockedUntil: null },
  });
});

afterAll(() => prisma.$disconnect());

describe('login and sessions', () => {
  it('issues a session and resolves it back to an actor', async () => {
    const result = await login(prisma, { username: 'admin', password: PASSWORD, ip: '10.0.0.1' });
    expect(result.token).toBeTruthy();
    const resolved = await resolveSession(prisma, result.token);
    expect(resolved?.actor.username).toBe('admin');
    expect(resolved?.actor.isAdmin).toBe(true);
  });

  it('stores only the hashed token, never the cookie value', async () => {
    const { token } = await login(prisma, { username: 'admin', password: PASSWORD });
    const sessions = await prisma.session.findMany();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.id).not.toBe(token);
  });

  it('rejects a wrong password with the same message as an unknown user', async () => {
    await expect(login(prisma, { username: 'admin', password: 'wrong-password-1' })).rejects.toThrow(
      /올바르지 않습니다/,
    );
    await expect(login(prisma, { username: 'nobody', password: 'wrong-password-1' })).rejects.toThrow(
      /올바르지 않습니다/,
    );
  });

  it('B-14: locks the account after 5 consecutive failures and an admin can unlock it', async () => {
    for (let i = 0; i < MAX_FAILED_LOGINS - 1; i++) {
      await expect(login(prisma, { username: 'admin', password: 'bad-password-x' })).rejects.toThrow(
        AppError,
      );
    }
    await expect(login(prisma, { username: 'admin', password: 'bad-password-x' })).rejects.toThrow(
      /잠겼습니다/,
    );
    // even the correct password is refused while locked
    await expect(login(prisma, { username: 'admin', password: PASSWORD })).rejects.toThrow(/잠겼습니다/);

    const locked = await prisma.securityEvent.findFirst({ where: { type: 'ACCOUNT_LOCKED' } });
    expect(locked).toBeTruthy();

    const actor = await actorFor('admin');
    const user = await prisma.user.findUniqueOrThrow({ where: { username: 'admin' } });
    await runTx(actor, (t) => unlockUser(t, user.id));

    const ok = await login(prisma, { username: 'admin', password: PASSWORD });
    expect(ok.token).toBeTruthy();
  });

  it('revokes sessions on logout and on password change', async () => {
    const a = await login(prisma, { username: 'admin', password: PASSWORD });
    await logout(prisma, a.token);
    expect(await resolveSession(prisma, a.token)).toBeNull();

    const b = await login(prisma, { username: 'admin', password: PASSWORD });
    const user = await prisma.user.findUniqueOrThrow({ where: { username: 'admin' } });
    await changePassword(prisma, {
      userId: user.id,
      currentPassword: PASSWORD,
      newPassword: 'Rotated!987654',
    });
    expect(await resolveSession(prisma, b.token)).toBeNull();
    await prisma.user.update({
      where: { id: user.id },
      data: { passwordHash: await hashPassword(PASSWORD) },
    });
  });

  it('expires idle sessions', async () => {
    const { token } = await login(prisma, { username: 'admin', password: PASSWORD });
    const threeHoursLater = new Date(Date.now() + 3 * 60 * 60 * 1000);
    expect(await resolveSession(prisma, token, threeHoursLater)).toBeNull();
  });

  it('admin password reset forces a change and drops sessions', async () => {
    const user = await prisma.user.findUniqueOrThrow({ where: { username: 'admin' } });
    const session = await login(prisma, { username: 'admin', password: PASSWORD });
    const actor = await actorFor('admin');
    await runTx(actor, (t) =>
      resetPasswordByAdmin(t, { userId: user.id, temporaryPassword: 'Temp!12345678' }),
    );
    expect(await resolveSession(prisma, session.token)).toBeNull();
    const after = await login(prisma, { username: 'admin', password: 'Temp!12345678' });
    expect(after.mustChangePassword).toBe(true);
    await prisma.user.update({
      where: { id: user.id },
      data: { passwordHash: await hashPassword(PASSWORD) },
    });
  });

  it('revokeAllSessions kills every live session', async () => {
    const user = await prisma.user.findUniqueOrThrow({ where: { username: 'admin' } });
    const session = await login(prisma, { username: 'admin', password: PASSWORD });
    expect(await revokeAllSessions(prisma, user.id)).toBeGreaterThanOrEqual(1);
    expect(await resolveSession(prisma, session.token)).toBeNull();
  });

  /**
   * NFR-SEC-03. The rotation used to revoke only already-expired sessions, so it revoked
   * nothing: a user who logged in again because they suspected a compromise did not evict
   * whoever was holding their old cookie. Deleting the rotation code broke no test, which
   * is why this one exists.
   */
  it('로그인하면 기존 세션이 끊긴다: 재로그인이 탈취된 세션을 밀어낸다', async () => {
    const first = await login(prisma, { username: 'admin', password: PASSWORD });
    expect(await resolveSession(prisma, first.token)).not.toBeNull();

    const second = await login(prisma, { username: 'admin', password: PASSWORD });

    expect(await resolveSession(prisma, first.token)).toBeNull();
    expect(await resolveSession(prisma, second.token)).not.toBeNull();
  });
});

describe('B-13: sensitive values never reach the logs', () => {
  it('login attempts and security events contain no password material', async () => {
    await expect(login(prisma, { username: 'admin', password: 'sup3r-s3cret-value' })).rejects.toThrow();
    const attempts = await prisma.loginAttempt.findMany();
    const events = await prisma.securityEvent.findMany();
    const dump = JSON.stringify({ attempts, events });
    expect(dump).not.toContain('sup3r-s3cret-value');
  });

  it('audit.record strips password and resident numbers before storing', async () => {
    const user = await prisma.user.findUniqueOrThrow({ where: { username: 'admin' } });
    const actor = await actorFor('admin');
    await runTx(actor, (t) =>
      audit.record(t, {
        action: 'test.redaction',
        entityType: 'User',
        entityId: user.id,
        before: { password: 'plaintext-secret', residentNo: '900101-1234567' },
        after: { password: 'another-secret', bankAccount: '110-123-456789', displayName: '관리자' },
      }),
    );
    const rows = await prisma.auditLog.findMany({ where: { action: 'test.redaction' } });
    const dump = JSON.stringify(rows);
    expect(rows).toHaveLength(1);
    expect(dump).not.toContain('plaintext-secret');
    expect(dump).not.toContain('another-secret');
    expect(dump).not.toContain('900101-1234567');
    expect(dump).not.toContain('110-123-456789');
    expect(dump).toContain('관리자');
  });
});
