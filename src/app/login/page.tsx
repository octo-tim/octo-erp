'use client';

import { useState } from 'react';

export default function LoginPage() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const data = (await res.json()) as {
      ok?: boolean;
      message?: string;
      mustChangePassword?: boolean;
    };
    setBusy(false);
    if (!res.ok) {
      setError(data.message ?? '로그인에 실패했습니다.');
      return;
    }
    /**
     * A temporary password must be replaced before the user goes anywhere else. The login
     * response has always carried this flag and nothing read it, so an admin reset left the
     * user on a password the admin knows, with no screen to change it.
     *
     * A full page load rather than router.push: the client query cache still holds the
     * previous identity, and a client-side navigation would carry it into the new session —
     * a user who had just replaced a temporary password was bounced straight back to the
     * password screen by their own stale `auth.me`. Who is signed in is not something to
     * serve from cache across a login.
     */
    window.location.assign(data.mustChangePassword ? '/account?force=1' : '/home');
  }

  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <form
        onSubmit={submit}
        className="w-full max-w-sm rounded-lg border bg-white p-8 shadow-sm"
        style={{ borderColor: 'var(--border)' }}
      >
        <h1 className="mb-1 text-lg font-semibold">옥토웍스 경영관리</h1>
        <p className="mb-6 text-sm" style={{ color: 'var(--text-muted)' }}>
          사내 계정으로 로그인하세요.
        </p>

        <label htmlFor="username" className="mb-1 block text-sm font-medium">
          아이디
        </label>
        <input
          id="username"
          name="username"
          autoComplete="username"
          required
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          className="mb-4 w-full rounded-md border px-3 py-2"
          style={{ borderColor: 'var(--border)' }}
        />

        <label htmlFor="password" className="mb-1 block text-sm font-medium">
          비밀번호
        </label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="mb-4 w-full rounded-md border px-3 py-2"
          style={{ borderColor: 'var(--border)' }}
        />

        {error ? (
          <p
            role="alert"
            data-testid="login-error"
            className="mb-4 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700"
          >
            {error}
          </p>
        ) : null}

        <button
          type="submit"
          disabled={busy}
          className="w-full rounded-md bg-blue-600 px-3 py-2 font-medium text-white disabled:opacity-60"
        >
          {busy ? '로그인 중…' : '로그인'}
        </button>
      </form>
    </main>
  );
}
