/**
 * Prepares the two accounts the e2e suite needs. Run by playwright's globalSetup through
 * tsx, because the generated Prisma client is ESM and playwright's own transpiler cannot
 * load it — the same reason prisma/seed.ts is run this way from the integration helpers.
 *
 * The seeded `admin` is created with `mustChangePassword` set, which is right: an account
 * whose password ships in the seed must not stay on it. Since STEP 13 the app enforces that
 * flag, so the specs' `login()` helpers — all of which expect to land on /home — would be
 * redirected to the password screen. An environment past its first-time setup is the state
 * those specs mean to test, so that is the state prepared here.
 *
 * The flag is not skipped: `e2e-firstlogin` exists to be redirected, and auth.spec.ts walks
 * the forced change with it. It is reset every run because that test changes its password.
 */
import 'dotenv/config';
import { prisma } from '@/server/db';
import { hashPassword } from '@/server/core/crypto';
import { FIRST_LOGIN_PASSWORD, FIRST_LOGIN_USERNAME } from '../tests/e2e/accounts';

async function main(): Promise<void> {
  const adminUsername = process.env['E2E_USERNAME'] ?? 'admin';
  await prisma.user.updateMany({
    where: { username: adminUsername },
    data: { mustChangePassword: false, failedLoginCount: 0, lockedUntil: null },
  });

  const viewerRole = await prisma.role.findUnique({ where: { code: 'viewer' } });
  if (!viewerRole) throw new Error('seed has not run: role "viewer" is missing');

  const passwordHash = await hashPassword(FIRST_LOGIN_PASSWORD);
  await prisma.user.upsert({
    where: { username: FIRST_LOGIN_USERNAME },
    create: {
      username: FIRST_LOGIN_USERNAME,
      displayName: '최초로그인 시험계정',
      passwordHash,
      mustChangePassword: true,
      roles: { create: [{ roleId: viewerRole.id }] },
    },
    update: { passwordHash, mustChangePassword: true, isActive: true, lockedUntil: null },
  });
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    await prisma.$disconnect();
    console.error(e);
    process.exit(1);
  });
