// covers: NFR-SEC-01, INT-12, NFR-SEC-02 (STEP 13 — 역할·부문·창고·인사 권한 매트릭스 전수 호출시험)
//
// This file does NOT re-check what tests/integration/rbac.test.ts already covers directly
// against src/server/modules/rbac/service.ts (has/requirePermission/assertDivisionScope/
// assertWarehouseScope/assertHrScope/*ScopeFilter as plain functions, the FORBIDDEN error shape,
// admin bypass, and default-deny). What is missing there — and what this file adds — is
// end-to-end coverage through the actual tRPC procedures: every procedure the app exposes,
// called through appRouter.createCaller(), for a user who lacks the permission it requires.
//
// The procedure list is never hardcoded. It is enumerated twice, from two independent sources
// that must agree:
//   1. `appRouter._def.procedures` at runtime (tRPC v11's own record of every mounted procedure).
//   2. `collectRouterPermissions()` (tools/lib/router-permissions.mjs), which statically parses
//      src/server/api/routers/*.ts to say which permission (if any) sits at the base of each
//      procedure's builder chain. This is the SAME module tools/docs-permissions.mjs uses to
//      generate docs/permissions.md, so the doc and this test cannot silently drift apart.
// Whichever procedure a future PR adds, both enumerations pick it up automatically — no list to
// remember to update.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import path from 'node:path';
import { TRPCError } from '@trpc/server';
import { appRouter, type AppRouter } from '@/server/api/root';
import type { Context } from '@/server/api/trpc';
import type { Actor } from '@/server/core/context';
import { AppError } from '@/server/core/errors';
import { prepareDatabase, prisma, truncateBusinessData } from '../helpers/db';
import { buildActor } from '@/server/modules/auth/service';
import { hashPassword } from '@/server/core/crypto';
import { collectRouterPermissions } from '../../tools/lib/router-permissions.mjs';

const repoRoot = path.resolve(new URL('.', import.meta.url).pathname, '../..');

// ── fixtures ──

let noPermActor!: Actor; // authenticated, zero roles → zero permissions, zero scope
let divisionScopedActor!: Actor; // report.read, but division scope = [d1] only
let warehouseScopedActor!: Actor; // report.read, but warehouse scope = [w1] only
let hrScopedActor!: Actor; // hr.self (not hr.read), employeeId = empA
let d1 = '';
let d2 = '';
let w1 = '';
let w2 = '';
let empA = '';
let empB = '';

beforeAll(async () => {
  prepareDatabase();
  await truncateBusinessData();

  const divisions = await prisma.division.findMany({ orderBy: { code: 'asc' } });
  const warehouses = await prisma.warehouse.findMany({ orderBy: { code: 'asc' } });
  d1 = divisions[0]!.id;
  d2 = divisions[1]!.id;
  w1 = warehouses[0]!.id;
  w2 = warehouses[1]!.id;

  const empHash = await hashPassword('PermTest!12345678');

  const a = await prisma.employee.upsert({
    where: { employeeNo: 'PERM001' },
    create: { employeeNo: 'PERM001', name: '권한시험갑', hireDate: new Date('2024-01-02T00:00:00Z') },
    update: {},
  });
  const b = await prisma.employee.upsert({
    where: { employeeNo: 'PERM002' },
    create: { employeeNo: 'PERM002', name: '권한시험을', hireDate: new Date('2024-01-02T00:00:00Z') },
    update: {},
  });
  empA = a.id;
  empB = b.id;

  const viewerRole = await prisma.role.findUniqueOrThrow({ where: { code: 'viewer' } });

  // 1) no roles at all → Set() of permissions, isAdmin=false (auth/service.ts buildActor).
  const noPermUser = await prisma.user.upsert({
    where: { username: 'perm_noperm' },
    create: { username: 'perm_noperm', displayName: '권한없음', passwordHash: empHash },
    update: {},
  });

  // 2) report.read (via viewer role), but division scope narrowed to d1 only.
  const divUser = await prisma.user.upsert({
    where: { username: 'perm_division' },
    create: {
      username: 'perm_division',
      displayName: '사업부범위시험',
      passwordHash: empHash,
      roles: { create: [{ roleId: viewerRole.id }] },
      divisionScopes: { create: [{ divisionId: d1 }] },
    },
    update: {},
  });

  // 3) report.read (via viewer role), but warehouse scope narrowed to w1 only.
  const whUser = await prisma.user.upsert({
    where: { username: 'perm_warehouse' },
    create: {
      username: 'perm_warehouse',
      displayName: '창고범위시험',
      passwordHash: empHash,
      roles: { create: [{ roleId: viewerRole.id }] },
      warehouseScopes: { create: [{ warehouseId: w1 }] },
    },
    update: {},
  });

  // 4) hr.self (via viewer role — no hr.read), linked to empA. May read only empA's own record.
  const hrUser = await prisma.user.upsert({
    where: { username: 'perm_hr' },
    create: {
      username: 'perm_hr',
      displayName: '인사범위시험',
      passwordHash: empHash,
      employeeId: empA,
      roles: { create: [{ roleId: viewerRole.id }] },
    },
    update: {},
  });

  noPermActor = await buildActor(prisma, noPermUser.id);
  divisionScopedActor = await buildActor(prisma, divUser.id);
  warehouseScopedActor = await buildActor(prisma, whUser.id);
  hrScopedActor = await buildActor(prisma, hrUser.id);
});

afterAll(() => prisma.$disconnect());

// ── tRPC caller plumbing ──

/** Builds a tRPC caller for `actor`, bypassing HTTP (createContext) entirely — the CSRF guard
 *  is satisfied unconditionally (originOk: true) so every rejection we assert on is the
 *  permission/scope check, never the unrelated Origin check that runs earlier in the chain. */
function callerFor(actor: Actor) {
  const ctx: Context = {
    actor,
    requestId: `perm-test-${Math.random().toString(36).slice(2)}`,
    ip: undefined,
    now: new Date(),
    isMutation: true,
    originOk: true,
  };
  return appRouter.createCaller(ctx);
}

/** Invokes `mount.name` on `caller` by string path (no per-procedure typing needed — the whole
 *  point is that this walks whatever the router actually contains). */
async function invoke(caller: ReturnType<typeof callerFor>, procPath: string, input?: unknown) {
  const [mountKey, name] = procPath.split('.') as [string, string];
  const fn = (caller as any)[mountKey]?.[name];
  if (typeof fn !== 'function') throw new Error(`no such procedure on caller: ${procPath}`);
  return fn(input);
}

function isForbiddenByPermission(err: unknown, permission?: string): boolean {
  if (!(err instanceof TRPCError)) return false;
  if (err.code !== 'FORBIDDEN') return false;
  const cause = err.cause;
  if (!(cause instanceof AppError) || cause.code !== 'FORBIDDEN') return false;
  if (permission === undefined) return true;
  return (cause.meta as Record<string, unknown> | undefined)?.['permission'] === permission;
}

function outOfScopeCode(err: unknown): string | undefined {
  // OUT_OF_SCOPE is thrown as a plain AppError deep in a service, not as a TRPCError — tRPC's
  // procedure caller (initTRPC-*.mjs: getTRPCErrorFromUnknown) wraps any non-TRPCError thrown
  // by a resolver into `TRPCError({ code: 'INTERNAL_SERVER_ERROR', cause })`, so the appCode
  // lives one level down at `err.cause.code`, not at `err.code` (verified against the installed
  // @trpc/server package: callRecursive's catch always runs getTRPCErrorFromUnknown, and
  // AppError is never itself a TRPCError instance).
  if (!(err instanceof TRPCError)) return undefined;
  const cause = err.cause;
  return cause instanceof AppError ? cause.code : undefined;
}

// ── enumeration: both sources must agree on the router's real size ──

const runtimeProcedurePaths = Object.keys(appRouter._def.procedures).sort();
const { routers, parseFailures, totalProcedures } = collectRouterPermissions({ root: repoRoot });
const parsedProcedures = routers.flatMap((r) => r.procedures);
const parsedProcedurePaths = parsedProcedures.map((p) => p.path).sort();

describe('프로시저 전수 열거 (STEP 13 — 하드코딩 없이 라우터에서 직접 파생)', () => {
  it('appRouter._def.procedures가 비어 있지 않고, 정적 파싱 결과와 정확히 일치한다', () => {
    expect(runtimeProcedurePaths.length).toBeGreaterThan(0);
    expect(parseFailures).toEqual([]);
    expect(totalProcedures).toBe(runtimeProcedurePaths.length);
    expect(parsedProcedurePaths).toEqual(runtimeProcedurePaths);
  });

  it('모든 프로시저의 권한 판정을 정적으로 확정했다(⚠ 확인 필요 항목 없음)', () => {
    const unresolved = parsedProcedures.filter((p) => p.kind === 'unresolved');
    expect(unresolved.map((p) => p.path)).toEqual([]);
  });
});

const permissionGated = parsedProcedures.filter((p) => p.kind === 'permission');
const notGated = parsedProcedures.filter((p) => p.kind === 'authed' || p.kind === 'public');

describe('권한 없는 사용자는 모든 업무 프로시저에서 전수 거부된다 (NFR-SEC-01)', () => {
  it(`권한이 필요한 프로시저 ${permissionGated.length}개, 인증만 필요한 프로시저 ${notGated.length}개로 분류했다 (합계 ${parsedProcedures.length} = 전체 ${runtimeProcedurePaths.length})`, () => {
    expect(permissionGated.length + notGated.length).toBe(parsedProcedures.length);
    expect(parsedProcedures.length).toBe(runtimeProcedurePaths.length);
    // sanity: every business module has at least one gated procedure, so this isn't vacuous
    expect(permissionGated.length).toBeGreaterThan(200);
  });

  it.each(permissionGated.map((p) => [p.path, p.permission] as const))(
    '%s는 %s 권한이 없으면 FORBIDDEN으로 거부된다 (입력 파싱 전에 차단)',
    async (procPath, permission) => {
      const caller = callerFor(noPermActor);
      let threw = false;
      try {
        // Empty/undefined input on purpose: the permission middleware runs before `.input()`
        // parsing in the builder chain (permissionProcedure(...).input(...).query/mutation(...)),
        // so an unpermitted caller must be refused before zod ever sees the input — confirmed
        // against src/server/api/trpc.ts and the @trpc/server internals (mergeWithoutOverrides
        // appends middlewares in call order; callRecursive runs them in that same order).
        await invoke(caller, procPath, undefined);
      } catch (err) {
        threw = true;
        expect(
          isForbiddenByPermission(err, permission ?? undefined),
          `expected ${procPath} to reject with FORBIDDEN/${permission}, got: ${String(err)}`,
        ).toBe(true);
      }
      expect(threw, `${procPath} did not throw at all for a user without ${permission}`).toBe(true);
    },
  );
});

describe('인증만으로 호출 가능한 프로시저는 권한 부재로 거부되지 않는다', () => {
  it.each(notGated.map((p) => [p.path] as const))(
    '%s는 permissionProcedure 게이트를 통과하지 않으므로, 실패하더라도 FORBIDDEN/permission 사유는 아니다',
    async (procPath) => {
      const caller = callerFor(noPermActor);
      try {
        await invoke(caller, procPath, undefined);
      } catch (err) {
        expect(
          isForbiddenByPermission(err),
          `${procPath} unexpectedly rejected as if it were permission-gated: ${String(err)}`,
        ).toBe(false);
      }
    },
  );
});

// ── data scope: permission alone is not enough (INT-12, NFR-SEC-02) ──

describe('데이터 범위: 권한이 있어도 범위 밖 자료는 거부된다', () => {
  it('사업부 범위 — report.salesTrend에 범위 밖 divisionId를 넘기면 OUT_OF_SCOPE', async () => {
    const caller = callerFor(divisionScopedActor);
    expect(divisionScopedActor.divisionIds).toEqual([d1]);

    // in-scope division succeeds (sanity: the actor really does have report.read)
    await expect(
      invoke(caller, 'report.salesTrend', {
        filter: { from: '2026-01-01', to: '2026-01-31', divisionId: d1 },
      }),
    ).resolves.toBeDefined();

    await expect(
      invoke(caller, 'report.salesTrend', {
        filter: { from: '2026-01-01', to: '2026-01-31', divisionId: d2 },
      }),
    ).rejects.toSatisfy((err: unknown) => outOfScopeCode(err) === 'OUT_OF_SCOPE');
  });

  it('창고 범위 — report.stockStatus에 범위 밖 warehouseId를 넘기면 OUT_OF_SCOPE', async () => {
    const caller = callerFor(warehouseScopedActor);
    expect(warehouseScopedActor.warehouseIds).toEqual([w1]);

    await expect(
      invoke(caller, 'report.stockStatus', {
        filter: { from: '2026-01-01', to: '2026-01-31', warehouseId: w1 },
      }),
    ).resolves.toBeDefined();

    await expect(
      invoke(caller, 'report.stockStatus', {
        filter: { from: '2026-01-01', to: '2026-01-31', warehouseId: w2 },
      }),
    ).rejects.toSatisfy((err: unknown) => outOfScopeCode(err) === 'OUT_OF_SCOPE');
  });

  it('인사 범위 — hrm.detail로 본인 외 직원을 조회하면 OUT_OF_SCOPE (hr.read 없음)', async () => {
    const caller = callerFor(hrScopedActor);
    expect(hrScopedActor.employeeId).toBe(empA);
    expect(hrScopedActor.permissions.has('hr.read')).toBe(false);

    await expect(invoke(caller, 'hrm.detail', { id: empA })).resolves.toBeDefined();

    await expect(invoke(caller, 'hrm.detail', { id: empB })).rejects.toSatisfy(
      (err: unknown) => outOfScopeCode(err) === 'OUT_OF_SCOPE',
    );
  });
});

// keep the AppRouter type import used (path-based invoke() intentionally bypasses static typing)
type _AssertAppRouterImported = AppRouter;
