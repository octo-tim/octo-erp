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

/**
 * APV-08. A confirmation reached through an approval is authorised by that approval, not by
 * the approver's own module permissions. Without this, approving a sales document would
 * require the approver to hold `sales.confirm` — so a department head or a finance approver,
 * who is exactly the person the approval line puts there, could not approve one. The
 * approval line already decided who may authorise this specific document; the audit log
 * still records the approver as the actor.
 *
 * `viaApproval` is set only by the approval module when it invokes a target handler. It is
 * never read from a request, so this cannot be asked for from outside.
 */
export function requirePermissionUnlessApproval(
  ctx: { actor: Actor; viaApproval?: boolean },
  permission: string,
): void {
  if (ctx.viaApproval) return;
  requirePermission(ctx.actor, permission);
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

export type DivisionScopeWhere =
  Record<string, never> | { OR: [{ divisionId: { in: string[] } }, { divisionId: null }] };

/**
 * INT-12 for documents that carry an optional division.
 *
 * A scoped user sees their own divisions and documents with no division set — the same rule
 * the sales-document and report queries already applied inline. It is a function now for two
 * reasons. Five list queries (quotations, sales orders, purchase requests, purchase orders,
 * purchase documents) never applied it at all, so a user scoped to one division could list
 * another division's documents. And the inline version was spread into a `where` object next
 * to the keyword search's own `OR`, where the later `OR` key simply replaced the earlier one:
 * for a scoped user the search term was silently dropped and the list came back unfiltered.
 *
 * Callers must compose this under `AND` rather than spreading it, so it cannot collide with
 * another `OR` again.
 */
export function divisionScopeWhere(actor: Actor): DivisionScopeWhere {
  if (actor.isAdmin) return {};
  return { OR: [{ divisionId: { in: actor.divisionIds } }, { divisionId: null }] };
}

export function warehouseScopeFilter(actor: Actor): { warehouseId?: { in: string[] } } {
  if (actor.isAdmin) return {};
  return { warehouseId: { in: actor.warehouseIds } };
}

export function hrScopeFilter(actor: Actor): { id?: string } {
  if (actor.isAdmin || has(actor, 'hr.read')) return {};
  return { id: actor.employeeId ?? '__none__' };
}
