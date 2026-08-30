// covers: NFR-SEC-01, NFR-SEC-02, INT-12, B-02
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { actorFor, prepareDatabase, prisma, truncateBusinessData } from '../helpers/db';
import {
  assertDivisionScope,
  assertHrScope,
  assertWarehouseScope,
  divisionScopeFilter,
  has,
  requirePermission,
  warehouseScopeFilter,
} from '@/server/modules/rbac/service';
import { buildActor } from '@/server/modules/auth/service';
import { hashPassword } from '@/server/core/crypto';
import { AppError } from '@/server/core/errors';

let d1 = '';
let d2 = '';
let w1 = '';
let w2 = '';

beforeAll(async () => {
  prepareDatabase();
  await truncateBusinessData();

  const divisions = await prisma.division.findMany({ orderBy: { code: 'asc' } });
  const warehouses = await prisma.warehouse.findMany({ orderBy: { code: 'asc' } });
  d1 = divisions[0]!.id;
  d2 = divisions[1]!.id;
  w1 = warehouses[0]!.id;
  w2 = warehouses[1]!.id;

  const salesRole = await prisma.role.findUniqueOrThrow({ where: { code: 'sales' } });
  const hrRole = await prisma.role.findUniqueOrThrow({ where: { code: 'hr' } });
  const viewerRole = await prisma.role.findUniqueOrThrow({ where: { code: 'viewer' } });

  const emp = await prisma.employee.upsert({
    where: { employeeNo: 'E0001' },
    create: { employeeNo: 'E0001', name: '홍길동', hireDate: new Date('2024-01-02T00:00:00Z') },
    update: {},
  });
  const other = await prisma.employee.upsert({
    where: { employeeNo: 'E0002' },
    create: { employeeNo: 'E0002', name: '김철수', hireDate: new Date('2024-02-01T00:00:00Z') },
    update: {},
  });

  const hash = await hashPassword('Scope!12345678');
  for (const [username, roleId, divisionIds, warehouseIds, employeeId] of [
    ['sales1', salesRole.id, [d1], [w1], emp.id],
    ['hr1', hrRole.id, [], [], other.id],
    ['viewer1', viewerRole.id, [d1, d2], [w1, w2], null],
  ] as const) {
    await prisma.user.upsert({
      where: { username },
      create: {
        username,
        displayName: username,
        passwordHash: hash,
        employeeId,
        roles: { create: [{ roleId }] },
        divisionScopes: { create: divisionIds.map((divisionId) => ({ divisionId })) },
        warehouseScopes: { create: warehouseIds.map((warehouseId) => ({ warehouseId })) },
      },
      update: {},
    });
  }
});

afterAll(() => prisma.$disconnect());

describe('permission matrix (NFR-SEC-01)', () => {
  it('grants exactly the seeded permissions per role', async () => {
    const sales = await actorFor('sales1');
    expect(has(sales, 'sales.confirm')).toBe(true);
    expect(has(sales, 'sales.write')).toBe(true);
    expect(has(sales, 'accounting.confirm')).toBe(false);
    expect(has(sales, 'hr.read')).toBe(false);
    expect(has(sales, 'admin.users')).toBe(false);

    const viewer = await actorFor('viewer1');
    expect(has(viewer, 'sales.read')).toBe(true);
    expect(has(viewer, 'sales.write')).toBe(false);
    expect(has(viewer, 'inventory.confirm')).toBe(false);

    const hr = await actorFor('hr1');
    expect(has(hr, 'hr.sensitive.read')).toBe(true);
    expect(has(hr, 'sales.write')).toBe(false);
  });

  it('admin passes every permission check', async () => {
    const admin = await actorFor('admin');
    expect(has(admin, 'anything.at.all')).toBe(true);
    expect(() => requirePermission(admin, 'period.reopen')).not.toThrow();
  });

  it('throws FORBIDDEN with the requested permission in meta', async () => {
    const viewer = await actorFor('viewer1');
    try {
      requirePermission(viewer, 'sales.confirm');
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as AppError).code).toBe('FORBIDDEN');
      expect((e as AppError).meta).toEqual({ permission: 'sales.confirm' });
    }
  });
});

describe('B-02: data scope is enforced on the server (INT-12)', () => {
  it('blocks direct access to another division or warehouse', async () => {
    const sales = await actorFor('sales1');
    expect(() => assertDivisionScope(sales, d1)).not.toThrow();
    expect(() => assertDivisionScope(sales, d2)).toThrow(/사업부/);
    expect(() => assertWarehouseScope(sales, w1)).not.toThrow();
    expect(() => assertWarehouseScope(sales, w2)).toThrow(/창고/);
  });

  it('produces where-clause filters so lists never leak out-of-scope rows', async () => {
    const sales = await actorFor('sales1');
    expect(divisionScopeFilter(sales)).toEqual({ divisionId: { in: [d1] } });
    expect(warehouseScopeFilter(sales)).toEqual({ warehouseId: { in: [w1] } });

    const admin = await actorFor('admin');
    expect(divisionScopeFilter(admin)).toEqual({});
  });

  it('a user with no scope sees nothing (default deny)', async () => {
    const hr = await actorFor('hr1');
    expect(divisionScopeFilter(hr)).toEqual({ divisionId: { in: [] } });
    expect(() => assertDivisionScope(hr, d1)).toThrow(AppError);
  });

  it('NFR-SEC-02: hr data is limited to self unless hr.read is granted', async () => {
    const sales = await actorFor('sales1');
    const hr = await actorFor('hr1');
    const self = sales.employeeId!;
    const other = hr.employeeId!;

    expect(() => assertHrScope(sales, self)).not.toThrow();
    expect(() => assertHrScope(sales, other)).toThrow(/본인 외/);
    expect(() => assertHrScope(hr, self)).not.toThrow(); // hr.read covers everyone
  });

  it('deactivating a user makes buildActor fail closed', async () => {
    const user = await prisma.user.findUniqueOrThrow({ where: { username: 'viewer1' } });
    await prisma.user.update({ where: { id: user.id }, data: { isActive: false } });
    await expect(buildActor(prisma, user.id)).rejects.toThrow(/사용 중지/);
    await prisma.user.update({ where: { id: user.id }, data: { isActive: true } });
  });
});
