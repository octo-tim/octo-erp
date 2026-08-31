// NFR-SEC-01 / NFR-SEC-04: 사용자 계정 관리 — 등록, 역할·부문·창고 범위 부여, 잠금 표시·해제, 임시 비밀번호 발급, 세션 강제 종료.
'use client';

import { Fragment, useState } from 'react';
import { api, newRequestId } from '@/lib/trpc';
import { Button, Card, EmptyState, Field, Input, Spinner, StatusBadge } from '@/components/ui/primitives';
import { fmt } from '@/lib/format';

const PAGE_SIZE = 50;

/** A password that satisfies validatePasswordPolicy (10자 이상, 2종류 이상 조합) without the admin having to think one up. */
function generateTempPassword(): string {
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const lower = 'abcdefghijkmnopqrstuvwxyz';
  const digit = '23456789';
  const special = '!@#$%';
  const all = upper + lower + digit + special;
  const pick = (s: string) => s.charAt(Math.floor(Math.random() * s.length)) || s.charAt(0);
  const bodyChars = [pick(upper), pick(lower), pick(digit), pick(special)];
  for (let i = 0; i < 8; i++) bodyChars.push(pick(all));
  for (let i = bodyChars.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const a = bodyChars[i]!;
    const b = bodyChars[j]!;
    bodyChars[i] = b;
    bodyChars[j] = a;
  }
  return bodyChars.join('');
}

function isLocked(lockedUntil: Date | string | null): boolean {
  if (!lockedUntil) return false;
  return new Date(lockedUntil).getTime() > Date.now();
}

function CheckboxGroup({
  legend,
  hint,
  options,
  selected,
  onChange,
  idPrefix,
}: {
  legend: string;
  hint?: string;
  options: { value: string; label: string }[];
  selected: string[];
  onChange: (next: string[]) => void;
  idPrefix: string;
}) {
  return (
    <fieldset className="flex flex-col gap-1">
      <legend className="text-sm font-medium text-slate-700">{legend}</legend>
      {hint ? <p className="text-xs text-slate-500">{hint}</p> : null}
      {options.length === 0 ? (
        <p className="text-xs text-slate-400">선택할 항목이 없습니다.</p>
      ) : (
        <div className="flex max-h-40 flex-wrap gap-x-4 gap-y-1 overflow-y-auto rounded-md border border-slate-200 p-2">
          {options.map((o) => {
            const id = `${idPrefix}-${o.value}`;
            const checked = selected.includes(o.value);
            return (
              <label key={o.value} htmlFor={id} className="flex items-center gap-1.5 text-sm">
                <input
                  id={id}
                  type="checkbox"
                  checked={checked}
                  onChange={(e) =>
                    onChange(
                      e.target.checked ? [...selected, o.value] : selected.filter((v) => v !== o.value),
                    )
                  }
                />
                {o.label}
              </label>
            );
          })}
        </div>
      )}
    </fieldset>
  );
}

type RoleOpt = { id: string; code: string; name: string; isSystem: boolean };
type ScopeOpt = { id: string; code: string; name: string };

export default function UsersPage() {
  const [page, setPage] = useState(1);
  const [qInput, setQInput] = useState('');
  const [appliedQ, setAppliedQ] = useState('');
  const [activeOnly, setActiveOnly] = useState(false);

  const list = api.admin.listUsers.useQuery({
    page,
    pageSize: PAGE_SIZE,
    sortDir: 'asc',
    activeOnly,
    ...(appliedQ ? { q: appliedQ } : {}),
  });
  const roles = api.admin.listRoles.useQuery();
  const divisions = api.master.divisions.useQuery({ activeOnly: true });
  const warehouses = api.master.warehouses.useQuery({ activeOnly: true });
  const me = api.auth.me.useQuery();
  const mySessions = api.auth.sessions.useQuery();

  const createUser = api.admin.createUser.useMutation();
  const updateAccess = api.admin.updateUserAccess.useMutation();
  const unlockUser = api.auth.unlockUser.useMutation();
  const resetPassword = api.auth.resetPassword.useMutation();
  const revokeSessions = api.auth.revokeSessions.useMutation();

  const roleOptions: RoleOpt[] = (roles.data ?? []).map((r) => ({
    id: r.id,
    code: r.code,
    name: r.name,
    isSystem: r.isSystem,
  }));
  const divisionOptions: ScopeOpt[] = (divisions.data ?? []).map((d) => ({
    id: d.id,
    code: d.code,
    name: d.name,
  }));
  const warehouseOptions: ScopeOpt[] = (warehouses.data ?? []).map((w) => ({
    id: w.id,
    code: w.code,
    name: w.name,
  }));

  const [createForm, setCreateForm] = useState({
    username: '',
    displayName: '',
    email: '',
    password: '',
    roleCodes: [] as string[],
    divisionIds: [] as string[],
    warehouseIds: [] as string[],
  });
  const [createError, setCreateError] = useState<string | null>(null);
  const [createMessage, setCreateMessage] = useState<string | null>(null);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState({
    roleCodes: [] as string[],
    divisionIds: [] as string[],
    warehouseIds: [] as string[],
    isActive: true,
  });
  const [editError, setEditError] = useState<string | null>(null);

  const [confirmAction, setConfirmAction] = useState<
    | { userId: string; kind: 'resetPassword'; tempPassword: string }
    | { userId: string; kind: 'revokeSessions' }
    | null
  >(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);

  const totalPages = Math.max(1, Math.ceil((list.data?.total ?? 0) / PAGE_SIZE));

  function startEdit(u: {
    id: string;
    roles: string[];
    divisionIds: string[];
    warehouseIds: string[];
    isActive: boolean;
  }) {
    setEditingId(u.id);
    setEditError(null);
    setEditForm({
      roleCodes: [...u.roles],
      // Prefilled from the row, because saving replaces both scope sets wholesale: an empty
      // start would strip a user's access whenever an admin edited anything else.
      divisionIds: [...u.divisionIds],
      warehouseIds: [...u.warehouseIds],
      isActive: u.isActive,
    });
  }

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <header>
        <h1 className="text-lg font-semibold">사용자</h1>
        <p className="mt-0.5 text-sm text-slate-500">
          계정을 등록하고 역할·부문·창고 범위를 부여합니다. 잠긴 계정은 해제할 수 있고, 임시 비밀번호 발급과
          세션 강제 종료로 즉시 접근을 차단할 수 있습니다.
        </p>
      </header>

      <Card title="사용자 등록">
        <form
          className="flex flex-col gap-3"
          onSubmit={async (e) => {
            e.preventDefault();
            setCreateError(null);
            setCreateMessage(null);
            if (createForm.roleCodes.length === 0) {
              setCreateError('최소 하나의 역할을 선택하세요.');
              return;
            }
            try {
              await createUser.mutateAsync({
                username: createForm.username.trim(),
                displayName: createForm.displayName.trim(),
                ...(createForm.email ? { email: createForm.email.trim() } : {}),
                password: createForm.password,
                roleCodes: createForm.roleCodes,
                divisionIds: createForm.divisionIds,
                warehouseIds: createForm.warehouseIds,
                requestId: newRequestId(),
              });
              setCreateMessage(
                `계정을 등록했습니다. 임시 비밀번호는 "${createForm.password}"이며 최초 로그인 시 변경해야 합니다.`,
              );
              setCreateForm({
                username: '',
                displayName: '',
                email: '',
                password: '',
                roleCodes: [],
                divisionIds: [],
                warehouseIds: [],
              });
              await list.refetch();
            } catch (err) {
              setCreateError((err as { message?: string }).message ?? '등록에 실패했습니다.');
            }
          }}
        >
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="아이디" htmlFor="u-username" required hint="영문 소문자·숫자·. _ -">
              <Input
                id="u-username"
                value={createForm.username}
                onChange={(e) => setCreateForm({ ...createForm, username: e.target.value })}
              />
            </Field>
            <Field label="이름" htmlFor="u-displayname" required>
              <Input
                id="u-displayname"
                value={createForm.displayName}
                onChange={(e) => setCreateForm({ ...createForm, displayName: e.target.value })}
              />
            </Field>
            <Field label="이메일" htmlFor="u-email">
              <Input
                id="u-email"
                type="email"
                value={createForm.email}
                onChange={(e) => setCreateForm({ ...createForm, email: e.target.value })}
              />
            </Field>
            <Field label="임시 비밀번호" htmlFor="u-password" required hint="10자 이상, 2종류 이상 조합">
              <div className="flex gap-1.5">
                <Input
                  id="u-password"
                  value={createForm.password}
                  onChange={(e) => setCreateForm({ ...createForm, password: e.target.value })}
                />
                <Button
                  type="button"
                  size="sm"
                  onClick={() => setCreateForm({ ...createForm, password: generateTempPassword() })}
                >
                  자동생성
                </Button>
              </div>
            </Field>
          </div>

          <CheckboxGroup
            legend="역할"
            idPrefix="u-role"
            options={roleOptions.map((r) => ({ value: r.code, label: `${r.name} (${r.code})` }))}
            selected={createForm.roleCodes}
            onChange={(roleCodes) => setCreateForm({ ...createForm, roleCodes })}
          />
          <CheckboxGroup
            legend="부문 범위"
            hint="비워두면 어느 부문 데이터도 조회할 수 없습니다."
            idPrefix="u-div"
            options={divisionOptions.map((d) => ({ value: d.id, label: `${d.code} · ${d.name}` }))}
            selected={createForm.divisionIds}
            onChange={(divisionIds) => setCreateForm({ ...createForm, divisionIds })}
          />
          <CheckboxGroup
            legend="창고 범위"
            hint="비워두면 어느 창고도 조회·입출고할 수 없습니다."
            idPrefix="u-wh"
            options={warehouseOptions.map((w) => ({ value: w.id, label: `${w.code} · ${w.name}` }))}
            selected={createForm.warehouseIds}
            onChange={(warehouseIds) => setCreateForm({ ...createForm, warehouseIds })}
          />

          {createMessage ? (
            <p role="status" className="rounded bg-green-50 px-3 py-2 text-sm text-green-800">
              {createMessage}
            </p>
          ) : null}
          {createError ? (
            <p role="alert" className="rounded bg-red-50 px-3 py-2 text-sm text-red-700">
              {createError}
            </p>
          ) : null}

          <div className="flex justify-end">
            <Button
              type="submit"
              size="sm"
              variant="primary"
              disabled={
                !createForm.username ||
                !createForm.displayName ||
                !createForm.password ||
                createUser.isPending
              }
            >
              {createUser.isPending ? '등록 중' : '등록'}
            </Button>
          </div>
        </form>
      </Card>

      <Card title="내 로그인 세션">
        <p className="mb-2 text-xs text-slate-500">
          auth.sessions는 현재 로그인한 관리자 본인의 세션만 반환합니다. 다른 사용자의 세션 목록을 조회하는
          프로시저는 없어, 아래 목록의 각 사용자 행에서는 세션 전체 종료만 가능합니다.
        </p>
        {mySessions.isLoading ? (
          <Spinner />
        ) : (mySessions.data ?? []).length === 0 ? (
          <EmptyState title="활성 세션이 없습니다." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-max text-sm">
              <thead className="bg-slate-50">
                <tr>
                  <th scope="col" className="px-3 py-2 text-left font-semibold">
                    생성
                  </th>
                  <th scope="col" className="px-3 py-2 text-left font-semibold">
                    최근 사용
                  </th>
                  <th scope="col" className="px-3 py-2 text-left font-semibold">
                    만료
                  </th>
                  <th scope="col" className="px-3 py-2 text-left font-semibold">
                    IP
                  </th>
                  <th scope="col" className="px-3 py-2 text-left font-semibold">
                    사용자 에이전트
                  </th>
                </tr>
              </thead>
              <tbody>
                {(mySessions.data ?? []).map((s) => (
                  <tr key={s.id} className="border-b border-slate-100 last:border-0">
                    <td className="px-3 py-1.5">{fmt.dateTime(s.createdAt)}</td>
                    <td className="px-3 py-1.5">{fmt.dateTime(s.lastSeenAt)}</td>
                    <td className="px-3 py-1.5">{fmt.dateTime(s.expiresAt)}</td>
                    <td className="px-3 py-1.5">{s.ip ?? '-'}</td>
                    <td className="max-w-xs truncate px-3 py-1.5" title={s.userAgent ?? ''}>
                      {s.userAgent ?? '-'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card
        title={`사용자 목록 (${list.data?.total ?? 0}명)`}
        actions={
          <div className="flex items-center gap-1.5">
            <Input
              aria-label="검색어"
              placeholder="아이디·이름 검색"
              value={qInput}
              onChange={(e) => setQInput(e.target.value)}
              className="w-40"
            />
            <Button
              size="sm"
              onClick={() => {
                setAppliedQ(qInput.trim());
                setPage(1);
              }}
            >
              검색
            </Button>
            <label className="flex items-center gap-1 text-xs text-slate-600">
              <input
                type="checkbox"
                checked={activeOnly}
                onChange={(e) => {
                  setActiveOnly(e.target.checked);
                  setPage(1);
                }}
              />
              사용중만
            </label>
          </div>
        }
      >
        {actionMessage ? (
          <p role="status" className="mb-2 rounded bg-green-50 px-3 py-2 text-sm text-green-800">
            {actionMessage}
          </p>
        ) : null}
        {actionError ? (
          <p role="alert" className="mb-2 rounded bg-red-50 px-3 py-2 text-sm text-red-700">
            {actionError}
          </p>
        ) : null}

        {list.isLoading ? (
          <Spinner />
        ) : (list.data?.rows ?? []).length === 0 ? (
          <EmptyState
            title="조회 가능한 사용자가 없습니다."
            description="검색어를 지우거나 위에서 사용자를 등록하세요."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-max text-sm">
              <thead className="bg-slate-50">
                <tr>
                  <th scope="col" className="px-3 py-2 text-left font-semibold">
                    아이디
                  </th>
                  <th scope="col" className="px-3 py-2 text-left font-semibold">
                    이름
                  </th>
                  <th scope="col" className="px-3 py-2 text-left font-semibold">
                    역할
                  </th>
                  <th scope="col" className="px-3 py-2 text-left font-semibold">
                    상태
                  </th>
                  <th scope="col" className="px-3 py-2 text-left font-semibold">
                    최근 로그인
                  </th>
                  <th scope="col" className="px-3 py-2 text-left font-semibold">
                    작업
                  </th>
                </tr>
              </thead>
              <tbody>
                {(list.data?.rows ?? []).map((u) => {
                  const locked = isLocked(u.lockedUntil);
                  const editing = editingId === u.id;
                  return (
                    <Fragment key={u.id}>
                      <tr className="border-b border-slate-100 last:border-0">
                        <td className="px-3 py-1.5">{u.username}</td>
                        <td className="px-3 py-1.5">
                          {u.displayName}
                          {u.employee ? (
                            <span className="ml-1 text-xs text-slate-400">
                              ({u.employee.employeeNo} · {u.employee.name})
                            </span>
                          ) : null}
                        </td>
                        <td className="px-3 py-1.5">{u.roles.join(', ') || '-'}</td>
                        <td className="px-3 py-1.5">
                          <div className="flex flex-wrap items-center gap-1">
                            <StatusBadge
                              status={u.isActive ? 'CONFIRMED' : 'WITHDRAWN'}
                              label={u.isActive ? '활성' : '비활성'}
                            />
                            {locked ? <StatusBadge status="REJECTED" label="잠김" /> : null}
                          </div>
                        </td>
                        <td className="px-3 py-1.5">{fmt.dateTime(u.lastLoginAt) || '-'}</td>
                        <td className="px-3 py-1.5">
                          <div className="flex flex-wrap gap-1">
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => (editing ? setEditingId(null) : startEdit(u))}
                            >
                              {editing ? '닫기' : '편집'}
                            </Button>
                            {locked ? (
                              <Button
                                size="sm"
                                onClick={async () => {
                                  setActionError(null);
                                  setActionMessage(null);
                                  try {
                                    await unlockUser.mutateAsync({
                                      userId: u.id,
                                      requestId: newRequestId(),
                                    });
                                    setActionMessage(`${u.username} 계정의 잠금을 해제했습니다.`);
                                    await list.refetch();
                                  } catch (err) {
                                    setActionError(
                                      (err as { message?: string }).message ?? '잠금 해제에 실패했습니다.',
                                    );
                                  }
                                }}
                              >
                                잠금 해제
                              </Button>
                            ) : null}
                            <Button
                              size="sm"
                              onClick={() =>
                                setConfirmAction({
                                  userId: u.id,
                                  kind: 'resetPassword',
                                  tempPassword: generateTempPassword(),
                                })
                              }
                            >
                              비밀번호 초기화
                            </Button>
                            <Button
                              size="sm"
                              variant="danger"
                              onClick={() => setConfirmAction({ userId: u.id, kind: 'revokeSessions' })}
                            >
                              세션 종료
                            </Button>
                          </div>
                        </td>
                      </tr>

                      {editing ? (
                        <tr className="border-b border-slate-100 bg-slate-50">
                          <td colSpan={6} className="px-3 py-3">
                            <div className="flex flex-col gap-3">
                              <p className="rounded bg-amber-50 px-3 py-2 text-xs text-amber-900">
                                저장하면 아래에서 선택한 역할·부문·창고로 전체 교체됩니다. 현재 값이 채워져
                                있으니, 체크를 해제한 항목은 권한에서 제거됩니다.
                              </p>
                              <CheckboxGroup
                                legend="역할"
                                idPrefix={`e-role-${u.id}`}
                                options={roleOptions.map((r) => ({
                                  value: r.code,
                                  label: `${r.name} (${r.code})`,
                                }))}
                                selected={editForm.roleCodes}
                                onChange={(roleCodes) => setEditForm({ ...editForm, roleCodes })}
                              />
                              <CheckboxGroup
                                legend="부문 범위"
                                idPrefix={`e-div-${u.id}`}
                                options={divisionOptions.map((d) => ({
                                  value: d.id,
                                  label: `${d.code} · ${d.name}`,
                                }))}
                                selected={editForm.divisionIds}
                                onChange={(divisionIds) => setEditForm({ ...editForm, divisionIds })}
                              />
                              <CheckboxGroup
                                legend="창고 범위"
                                idPrefix={`e-wh-${u.id}`}
                                options={warehouseOptions.map((w) => ({
                                  value: w.id,
                                  label: `${w.code} · ${w.name}`,
                                }))}
                                selected={editForm.warehouseIds}
                                onChange={(warehouseIds) => setEditForm({ ...editForm, warehouseIds })}
                              />
                              <label className="flex items-center gap-1.5 text-sm">
                                <input
                                  type="checkbox"
                                  checked={editForm.isActive}
                                  onChange={(e) => setEditForm({ ...editForm, isActive: e.target.checked })}
                                />
                                계정 사용
                              </label>

                              {editError ? (
                                <p role="alert" className="rounded bg-red-50 px-3 py-2 text-sm text-red-700">
                                  {editError}
                                </p>
                              ) : null}

                              <div className="flex justify-end gap-1.5">
                                <Button size="sm" onClick={() => setEditingId(null)}>
                                  취소
                                </Button>
                                <Button
                                  size="sm"
                                  variant="primary"
                                  disabled={updateAccess.isPending}
                                  onClick={async () => {
                                    setEditError(null);
                                    if (editForm.roleCodes.length === 0) {
                                      setEditError('최소 하나의 역할을 선택하세요.');
                                      return;
                                    }
                                    try {
                                      await updateAccess.mutateAsync({
                                        userId: u.id,
                                        roleCodes: editForm.roleCodes,
                                        divisionIds: editForm.divisionIds,
                                        warehouseIds: editForm.warehouseIds,
                                        isActive: editForm.isActive,
                                        requestId: newRequestId(),
                                      });
                                      setEditingId(null);
                                      await list.refetch();
                                    } catch (err) {
                                      setEditError(
                                        (err as { message?: string }).message ?? '저장에 실패했습니다.',
                                      );
                                    }
                                  }}
                                >
                                  {updateAccess.isPending ? '저장 중' : '저장'}
                                </Button>
                              </div>
                            </div>
                          </td>
                        </tr>
                      ) : null}

                      {confirmAction && confirmAction.userId === u.id ? (
                        <tr className="border-b border-slate-100 bg-red-50/40">
                          <td colSpan={6} className="px-3 py-3">
                            {confirmAction.kind === 'resetPassword' ? (
                              <div className="flex flex-col gap-2">
                                <p className="text-sm text-red-800">
                                  {u.username} 계정의 비밀번호를 아래 임시 비밀번호로 즉시 교체합니다. 계정은
                                  다음 로그인 시 비밀번호 변경이 강제됩니다. 계속하시겠습니까?
                                </p>
                                <div className="flex max-w-sm gap-1.5">
                                  <Input
                                    aria-label="임시 비밀번호"
                                    value={confirmAction.tempPassword}
                                    onChange={(e) =>
                                      setConfirmAction({ ...confirmAction, tempPassword: e.target.value })
                                    }
                                  />
                                  <Button
                                    size="sm"
                                    type="button"
                                    onClick={() =>
                                      setConfirmAction({
                                        ...confirmAction,
                                        tempPassword: generateTempPassword(),
                                      })
                                    }
                                  >
                                    재생성
                                  </Button>
                                </div>
                                <div className="flex gap-1.5">
                                  <Button size="sm" onClick={() => setConfirmAction(null)}>
                                    취소
                                  </Button>
                                  <Button
                                    size="sm"
                                    variant="danger"
                                    disabled={
                                      resetPassword.isPending || confirmAction.tempPassword.length < 10
                                    }
                                    onClick={async () => {
                                      setActionError(null);
                                      setActionMessage(null);
                                      try {
                                        await resetPassword.mutateAsync({
                                          userId: u.id,
                                          temporaryPassword: confirmAction.tempPassword,
                                          requestId: newRequestId(),
                                        });
                                        setActionMessage(
                                          `${u.username} 계정의 임시 비밀번호를 "${confirmAction.tempPassword}"로 발급했습니다.`,
                                        );
                                        setConfirmAction(null);
                                      } catch (err) {
                                        setActionError(
                                          (err as { message?: string }).message ??
                                            '비밀번호 초기화에 실패했습니다.',
                                        );
                                      }
                                    }}
                                  >
                                    {resetPassword.isPending ? '처리 중' : '초기화 확정'}
                                  </Button>
                                </div>
                              </div>
                            ) : (
                              <div className="flex flex-col gap-2">
                                <p className="text-sm text-red-800">
                                  {u.username} 계정의 모든 활성 세션을 즉시 종료합니다. 로그인된 모든 기기에서
                                  강제 로그아웃되며 되돌릴 수 없습니다. 계속하시겠습니까?
                                </p>
                                <div className="flex gap-1.5">
                                  <Button size="sm" onClick={() => setConfirmAction(null)}>
                                    취소
                                  </Button>
                                  <Button
                                    size="sm"
                                    variant="danger"
                                    disabled={revokeSessions.isPending}
                                    onClick={async () => {
                                      setActionError(null);
                                      setActionMessage(null);
                                      try {
                                        const res = await revokeSessions.mutateAsync({ userId: u.id });
                                        setActionMessage(
                                          `${u.username} 계정의 세션 ${res.revoked}건을 종료했습니다.`,
                                        );
                                        setConfirmAction(null);
                                        if (me.data?.userId === u.id) await mySessions.refetch();
                                      } catch (err) {
                                        setActionError(
                                          (err as { message?: string }).message ??
                                            '세션 종료에 실패했습니다.',
                                        );
                                      }
                                    }}
                                  >
                                    {revokeSessions.isPending ? '처리 중' : '종료 확정'}
                                  </Button>
                                </div>
                              </div>
                            )}
                          </td>
                        </tr>
                      ) : null}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        <div className="mt-3 flex items-center justify-end gap-2 text-sm text-slate-500">
          <Button size="sm" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>
            이전
          </Button>
          <span>
            {page} / {totalPages}
          </span>
          <Button
            size="sm"
            disabled={page >= totalPages}
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
          >
            다음
          </Button>
        </div>
      </Card>
    </div>
  );
}
