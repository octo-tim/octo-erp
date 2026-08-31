// NFR-SEC-01: RBAC 관리 — 역할 선택, 모듈별 권한 그룹 조회·토글·저장.
'use client';

import { useState } from 'react';
import { api, newRequestId } from '@/lib/trpc';
import { Button, Card, EmptyState, Field, Select, Spinner } from '@/components/ui/primitives';

export default function RolesPage() {
  const roles = api.admin.listRoles.useQuery();
  const permissions = api.admin.listPermissions.useQuery();
  const setRolePermissions = api.admin.setRolePermissions.useMutation();

  const [roleId, setRoleId] = useState<string>('');
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  // Tracks which role+permission-set the checkbox state was last synced from, so we can
  // detect (during render, not in an effect) when the selection needs to reset.
  const [syncedKey, setSyncedKey] = useState<string | null>(null);

  const roleList = roles.data ?? [];
  const selectedRole = roleList.find((r) => r.id === roleId) ?? roleList[0];
  const selectedKey = selectedRole ? `${selectedRole.id}:${selectedRole.permissions.join(',')}` : null;

  // Default to the first role once the list arrives, and reset the checkbox set whenever
  // the selected role (or its saved permissions, e.g. after a save) changes — done during
  // render, guarded by syncedKey, so edits never leak between roles without an extra effect.
  if (selectedRole && selectedKey !== syncedKey) {
    setSyncedKey(selectedKey);
    setChecked(new Set(selectedRole.permissions));
    if (roleId !== selectedRole.id) setRoleId(selectedRole.id);
  }

  const groups = new Map<string, { id: string; code: string; description: string | null }[]>();
  for (const p of permissions.data ?? []) {
    const list = groups.get(p.module) ?? [];
    list.push({ id: p.id, code: p.code, description: p.description });
    groups.set(p.module, list);
  }
  const moduleNames = [...groups.keys()].sort();

  const isAdminRole = selectedRole?.code === 'admin';
  const dirty =
    !!selectedRole &&
    (checked.size !== selectedRole.permissions.length ||
      selectedRole.permissions.some((c) => !checked.has(c)));

  function toggle(code: string, on: boolean) {
    setChecked((prev) => {
      const next = new Set(prev);
      if (on) next.add(code);
      else next.delete(code);
      return next;
    });
  }

  function toggleModule(codes: string[], on: boolean) {
    setChecked((prev) => {
      const next = new Set(prev);
      for (const c of codes) {
        if (on) next.add(c);
        else next.delete(c);
      }
      return next;
    });
  }

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <header>
        <h1 className="text-lg font-semibold">권한</h1>
        <p className="mt-0.5 text-sm text-slate-500">
          역할을 선택하면 모듈별 권한이 표시됩니다. 체크박스로 권한을 조정한 뒤 저장하면 해당 역할의 권한이
          선택한 항목으로 전체 교체됩니다.
        </p>
      </header>

      <Card title="역할 선택">
        {roles.isLoading ? (
          <Spinner />
        ) : roleList.length === 0 ? (
          <EmptyState title="등록된 역할이 없습니다." />
        ) : (
          <Field label="역할" htmlFor="role-select" className="max-w-sm">
            <Select
              id="role-select"
              value={roleId || (roleList[0]?.id ?? '')}
              onChange={(e) => {
                setRoleId(e.target.value);
                setMessage(null);
                setError(null);
              }}
            >
              {roleList.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name} ({r.code}){r.isSystem ? ' · 시스템' : ''}
                </option>
              ))}
            </Select>
          </Field>
        )}
      </Card>

      {selectedRole ? (
        <Card
          title={`권한 — ${selectedRole.name} (${selectedRole.code})`}
          actions={
            <div className="flex items-center gap-2">
              {dirty ? <span className="text-xs text-amber-700">저장하지 않은 변경 사항</span> : null}
              <Button
                size="sm"
                variant="primary"
                disabled={isAdminRole || !dirty || setRolePermissions.isPending}
                onClick={async () => {
                  setError(null);
                  setMessage(null);
                  try {
                    await setRolePermissions.mutateAsync({
                      roleId: selectedRole.id,
                      permissionCodes: [...checked],
                      requestId: newRequestId(),
                    });
                    setMessage('권한을 저장했습니다.');
                    await roles.refetch();
                  } catch (err) {
                    setError((err as { message?: string }).message ?? '저장에 실패했습니다.');
                  }
                }}
              >
                {setRolePermissions.isPending ? '저장 중' : '저장'}
              </Button>
            </div>
          }
        >
          {isAdminRole ? (
            <p className="mb-3 rounded bg-slate-50 px-3 py-2 text-sm text-slate-600">
              admin 역할의 권한은 서버에서 변경이 차단되어 있습니다(항상 모든 권한을 가집니다).
            </p>
          ) : null}
          {message ? (
            <p role="status" className="mb-3 rounded bg-green-50 px-3 py-2 text-sm text-green-800">
              {message}
            </p>
          ) : null}
          {error ? (
            <p role="alert" className="mb-3 rounded bg-red-50 px-3 py-2 text-sm text-red-700">
              {error}
            </p>
          ) : null}

          {permissions.isLoading ? (
            <Spinner />
          ) : moduleNames.length === 0 ? (
            <EmptyState title="등록된 권한이 없습니다." />
          ) : (
            <div className="flex flex-col gap-4">
              {moduleNames.map((moduleName) => {
                const items = groups.get(moduleName) ?? [];
                const codes = items.map((p) => p.code);
                const allChecked = codes.length > 0 && codes.every((c) => checked.has(c));
                const someChecked = codes.some((c) => checked.has(c));
                return (
                  <fieldset key={moduleName} className="rounded-md border border-slate-200 p-3">
                    <legend className="flex items-center gap-2 px-1 text-sm font-semibold">
                      <input
                        type="checkbox"
                        aria-label={`${moduleName} 모듈 전체 선택`}
                        checked={allChecked}
                        ref={(el) => {
                          if (el) el.indeterminate = someChecked && !allChecked;
                        }}
                        disabled={isAdminRole}
                        onChange={(e) => toggleModule(codes, e.target.checked)}
                      />
                      {moduleName}
                    </legend>
                    <div className="grid grid-cols-1 gap-x-4 gap-y-1 pt-1 sm:grid-cols-2 lg:grid-cols-3">
                      {items.map((p) => {
                        const id = `perm-${p.id}`;
                        return (
                          <label key={p.code} htmlFor={id} className="flex items-start gap-1.5 text-sm">
                            <input
                              id={id}
                              type="checkbox"
                              className="mt-0.5"
                              checked={checked.has(p.code)}
                              disabled={isAdminRole}
                              onChange={(e) => toggle(p.code, e.target.checked)}
                            />
                            <span>
                              {p.code}
                              {p.description ? (
                                <span className="block text-xs text-slate-500">{p.description}</span>
                              ) : null}
                            </span>
                          </label>
                        );
                      })}
                    </div>
                  </fieldset>
                );
              })}
            </div>
          )}
        </Card>
      ) : null}
    </div>
  );
}
