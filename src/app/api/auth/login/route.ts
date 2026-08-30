import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/server/db';
import { login, SESSION_COOKIE } from '@/server/modules/auth/service';
import { AppError, httpStatusFor } from '@/server/core/errors';
import { getEnv } from '@/server/env';

const schema = z.object({ username: z.string().min(1), password: z.string().min(1) });

export async function POST(req: Request) {
  const env = getEnv();
  const origin = req.headers.get('origin');
  if (origin && origin !== env.APP_ORIGIN) {
    return NextResponse.json(
      { code: 'FORBIDDEN', message: '요청 출처를 확인할 수 없습니다.' },
      { status: 403 },
    );
  }

  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { code: 'VALIDATION', message: '아이디와 비밀번호를 입력하세요.' },
      { status: 400 },
    );
  }

  try {
    const result = await login(prisma, {
      username: parsed.data.username,
      password: parsed.data.password,
      ip: req.headers.get('x-forwarded-for')?.split(',')[0]?.trim(),
      userAgent: req.headers.get('user-agent') ?? undefined,
    });
    const res = NextResponse.json({
      ok: true,
      mustChangePassword: result.mustChangePassword,
      displayName: result.actor.displayName,
    });
    res.cookies.set(SESSION_COOKIE, result.token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: env.APP_ENV === 'production' || env.APP_ENV === 'staging',
      path: '/',
      expires: result.expiresAt,
    });
    return res;
  } catch (e) {
    if (e instanceof AppError) {
      return NextResponse.json({ code: e.code, message: e.message }, { status: httpStatusFor(e.code) });
    }
    throw e;
  }
}
