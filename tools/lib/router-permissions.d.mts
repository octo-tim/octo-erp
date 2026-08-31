/** Type declarations for router-permissions.mjs — see that file for behavior. */

export type ProcedureKind = 'permission' | 'authed' | 'public' | 'unresolved';

export interface RouterProcedureInfo {
  name: string;
  path: string;
  opType: 'query' | 'mutation' | null;
  kind: ProcedureKind;
  permission: string | null;
  raw?: string;
}

export interface RouterInfo {
  mountKey: string;
  fileRel: string;
  procedures: RouterProcedureInfo[];
}

export interface CollectRouterPermissionsResult {
  routers: RouterInfo[];
  parseFailures: string[];
  totalProcedures: number;
}

export function collectRouterPermissions(opts: { root: string }): CollectRouterPermissionsResult;
