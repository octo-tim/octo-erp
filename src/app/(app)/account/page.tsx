'use client';

/** NFR-SEC-03: the account's own password and live sessions, including the forced change after an admin reset. */
import { useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { api } from '@/lib/trpc';
import { Button, Card, EmptyState, Field, Input, Spinner } from '@/components/ui/primitives';

/**
 * The same rule the server enforces in validatePasswordPolicy. It is repeated here only to
 * tell the user before they submit; the server remains the authority and its message is what
 * gets displayed when the two ever disagree.
 */
function policyProblem(password: string): string | null {
  if (password.length < 10) return '비밀번호는 10자 이상이어야 합니다.';
  const classes = [/[a-zA-Z]/, /[0-9]/, /[^a-zA-Z0-9]/].filter((re) => re.test(password)).length;
  if (classes < 2) return '비밀번호는 영문·숫자·특수문자 중 2종류 이상을 포함해야 합니다.';
  return null;
}

export default function AccountPage() {
  const router = useRouter();
  const params = useSearchParams();
  const forced = params.get('force') === '1';

  const me = api.auth.me.useQuery();
  const sessions = api.auth.sessions.useQuery();
  const changePassword = api.auth.changePassword.useMutation();
  const revoke = api.auth.revokeMySessions.useMutation();

  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [revokeArmed, setRevokeArmed] = useState(false);

  const mustChange = forced || me.data?.mustChangePassword === true;
  const localProblem = next ? policyProblem(next) : null;
  const mismatch = next.length > 0 && confirm.length > 0 && next !== confirm;

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <header>
        <h1 className="text-lg font-semibold">내 계정</h1>
        <p className="mt-0.5 text-sm text-slate-500">
          {me.data ? `${me.data.displayName} (${me.data.username})` : '계정 정보를 불러오는 중입니다.'}
        </p>
      </header>

      {mustChange && !done ? (
        <p role="alert" className="rounded bg-amber-50 px-3 py-2 text-sm text-amber-800">
          관리자가 발급한 임시 비밀번호를 사용하고 있습니다. 비밀번호를 변경해야 다른 화면을 사용할 수
          있습니다.
        </p>
      ) : null}

      <Card title="비밀번호 변경">
        <form
          className="grid max-w-md grid-cols-1 gap-3"
          onSubmit={async (e) => {
            e.preventDefault();
            setError(null);
            if (next !== confirm) {
              setError('새 비밀번호와 확인이 일치하지 않습니다.');
              return;
            }
            const problem = policyProblem(next);
            if (problem) {
              setError(problem);
              return;
            }
            try {
              await changePassword.mutateAsync({ currentPassword: current, newPassword: next });
              /**
               * Changing the password revokes every session, including this one. Sending the
               * user back to the login screen is the honest outcome; leaving them on a page
               * whose next request will 401 is not.
               */
              setDone(true);
              setCurrent('');
              setNext('');
              setConfirm('');
              await fetch('/api/auth/logout', { method: 'POST' }).catch(() => undefined);
              router.push('/login');
              router.refresh();
            } catch (err) {
              setError((err as { message?: string }).message ?? '비밀번호를 변경하지 못했습니다.');
            }
          }}
        >
          <Field label="현재 비밀번호" htmlFor="pw-current" required>
            <Input
              id="pw-current"
              type="password"
              autoComplete="current-password"
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
            />
          </Field>
          <Field label="새 비밀번호" htmlFor="pw-next" required hint="10자 이상, 2종류 이상 조합">
            <Input
              id="pw-next"
              type="password"
              autoComplete="new-password"
              value={next}
              onChange={(e) => setNext(e.target.value)}
            />
          </Field>
          <Field label="새 비밀번호 확인" htmlFor="pw-confirm" required>
            <Input
              id="pw-confirm"
              type="password"
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
            />
          </Field>

          {localProblem ? <p className="text-sm text-amber-700">{localProblem}</p> : null}
          {mismatch ? <p className="text-sm text-amber-700">확인 값이 일치하지 않습니다.</p> : null}

          <div>
            <Button
              type="submit"
              size="sm"
              variant="primary"
              disabled={
                changePassword.isPending || !current || !next || !confirm || localProblem !== null || mismatch
              }
            >
              {changePassword.isPending ? '변경 중…' : '비밀번호 변경'}
            </Button>
          </div>

          <p className="text-xs text-slate-500">
            비밀번호를 변경하면 현재 기기를 포함한 모든 로그인 세션이 해지되고 다시 로그인해야 합니다.
          </p>

          {error ? (
            <p role="alert" className="rounded bg-red-50 px-3 py-2 text-sm text-red-700">
              {error}
            </p>
          ) : null}
        </form>
      </Card>

      <Card title="내 로그인 세션">
        {sessions.isLoading ? (
          <Spinner />
        ) : (sessions.data ?? []).length === 0 ? (
          <EmptyState title="표시할 세션이 없습니다." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-max text-sm">
              <thead className="bg-slate-50">
                <tr>
                  <th scope="col" className="px-3 py-2 text-left font-semibold">
                    접속 IP
                  </th>
                  <th scope="col" className="px-3 py-2 text-left font-semibold">
                    브라우저
                  </th>
                  <th scope="col" className="px-3 py-2 text-left font-semibold">
                    최근 활동
                  </th>
                  <th scope="col" className="px-3 py-2 text-left font-semibold">
                    만료
                  </th>
                </tr>
              </thead>
              <tbody>
                {(sessions.data ?? []).map((s) => (
                  <tr key={s.id} className="border-b border-slate-100 last:border-0">
                    <td className="px-3 py-1.5">{s.ip ?? '-'}</td>
                    <td className="max-w-md truncate px-3 py-1.5" title={s.userAgent ?? ''}>
                      {s.userAgent ?? '-'}
                    </td>
                    <td className="px-3 py-1.5">{new Date(s.lastSeenAt).toLocaleString('ko-KR')}</td>
                    <td className="px-3 py-1.5">{new Date(s.expiresAt).toLocaleString('ko-KR')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="mt-3 flex items-center gap-2">
          {revokeArmed ? (
            <>
              <span className="text-sm text-slate-700">모든 기기에서 로그아웃됩니다. 계속할까요?</span>
              <Button
                size="sm"
                variant="danger"
                onClick={async () => {
                  setRevokeArmed(false);
                  await revoke.mutateAsync();
                  await fetch('/api/auth/logout', { method: 'POST' }).catch(() => undefined);
                  router.push('/login');
                  router.refresh();
                }}
              >
                해지 확인
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setRevokeArmed(false)}>
                취소
              </Button>
            </>
          ) : (
            <Button size="sm" variant="ghost" onClick={() => setRevokeArmed(true)}>
              모든 세션 해지
            </Button>
          )}
        </div>
      </Card>
    </div>
  );
}
