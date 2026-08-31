import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { prisma } from '@/server/db';
import { getStorage, verifyLocalSignature } from '@/server/modules/storage/service';
import { resolveSession, SESSION_COOKIE } from '@/server/modules/auth/service';
import { getEnv } from '@/server/env';

/**
 * Local storage driver only (dev/test). With STORAGE_DRIVER=s3 the presigned URL points at
 * the bucket and this route is unused.
 *
 * The signature alone is not enough to serve a file. It used to be, which made every
 * download URL a bearer token: anyone holding it — from browser history, a proxy log, a
 * pasted message — could fetch the file with no account at all, and employment contracts
 * are among the things behind these links. Now the URL names the user it was issued to,
 * that name is signed, and the request must arrive with that user's live session. A leaked
 * link is useless to anyone else, and it stops working the moment the session ends.
 */
export async function GET(req: Request, context: { params: Promise<{ key: string }> }) {
  if (getEnv().STORAGE_DRIVER !== 'local') {
    return NextResponse.json({ code: 'NOT_FOUND' }, { status: 404 });
  }
  const { key } = await context.params;
  const url = new URL(req.url);
  const exp = url.searchParams.get('exp');
  const sig = url.searchParams.get('sig');
  const sub = url.searchParams.get('sub');
  const decoded = decodeURIComponent(key);

  const forbidden = NextResponse.json(
    { code: 'FORBIDDEN', message: '다운로드 링크가 만료되었거나 올바르지 않습니다.' },
    { status: 403 },
  );

  if (!exp || !sig || !sub || !verifyLocalSignature(decoded, exp, sig, sub)) return forbidden;

  // the link belongs to a session, not to whoever is holding it
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return forbidden;
  const session = await resolveSession(prisma, token).catch(() => null);
  if (!session || session.actor.userId !== sub) return forbidden;

  // and it stops working as soon as the attachment is deleted, rather than at expiry
  const attachment = await prisma.attachment.findFirst({
    where: { storageKey: decoded, deletedAt: null },
    select: { id: true, mimeType: true },
  });
  if (!attachment) return NextResponse.json({ code: 'NOT_FOUND' }, { status: 404 });

  try {
    const body = await getStorage().get(decoded);
    return new NextResponse(new Uint8Array(body), {
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': 'attachment',
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'private, no-store',
      },
    });
  } catch {
    return NextResponse.json({ code: 'NOT_FOUND' }, { status: 404 });
  }
}
