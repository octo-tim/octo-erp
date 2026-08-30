import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { prisma } from '@/server/db';
import { logout, SESSION_COOKIE } from '@/server/modules/auth/service';

export async function POST() {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (token) await logout(prisma, token);
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, '', { httpOnly: true, path: '/', maxAge: 0 });
  return res;
}
