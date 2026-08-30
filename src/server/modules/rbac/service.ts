import { AppError } from '@/server/core/errors';
import type { Actor } from '@/server/core/context';

export function has(actor: Actor, permission: string): boolean {
  return actor.isAdmin || actor.permissions.has('*') || actor.permissions.has(permission);
}

export function requirePermission(actor: Actor, permission: string): void {
  if (!has(actor, permission)) {
    throw new AppError('FORBIDDEN', '이 기능을 사용할 권한이 없습니다.', { permission });
  }
}

export function requireAnyPermission(actor: Actor, permissions: string[]): void {
  if (!permissions.some((p) => has(actor, p))) {
    throw new AppError('FORBIDDEN', '이 기능을 사용할 권한이 없습니다.', { permissions });
  }
}

/** INT-12: division scope. Empty scope = deny (default-deny), admin = all. */
export function assertDivisionScope(actor: Actor, divisionId: string | null | undefined): void {
  if (actor.isAdmin) return;
  if (!divisionId) return; // rows without a division are company-wide
  if (!actor.divisionIds.includes(divisionId)) {
    throw new AppError('OUT_OF_SCOPE', '해당 사업부의 자료에 접근할 수 없습니다.', { divisionId });
  }
}

export function assertWarehouseScope(actor: Actor, warehouseId: string | null | undefined): void {
  if (actor.isAdmin) return;
  if (!warehouseId) return;
  if (!actor.warehouseIds.includes(warehouseId)) {
    throw new AppError('OUT_OF_SCOPE', '해당 창고의 자료에 접근할 수 없습니다.', { warehouseId });
  }
}

/** NFR-SEC-02: hr.read sees everyone, otherwise only the actor's own employee record. */
export function assertHrScope(actor: Actor, employeeId: string): void {
  if (actor.isAdmin || has(actor, 'hr.read')) return;
  if (actor.employeeId && actor.employeeId === employeeId) return;
  throw new AppError('OUT_OF_SCOPE', '본인 외 인사정보를 조회할 수 없습니다.', { employeeId });
}

/** where-clause fragments so list queries filter in SQL, not in memory. */
export function divisionScopeFilter(actor: Actor): { divisionId?: { in: string[] } } {
  if (actor.isAdmin) return {};
  return { divisionId: { in: actor.divisionIds } };
}

export function warehouseScopeFilter(actor: Actor): { warehouseId?: { in: string[] } } {
  if (actor.isAdmin) return {};
  return { warehouseId: { in: actor.warehouseIds } };
}

export function hrScopeFilter(actor: Actor): { id?: string } {
  if (actor.isAdmin || has(actor, 'hr.read')) return {};
  return { id: actor.employeeId ?? '__none__' };
}
