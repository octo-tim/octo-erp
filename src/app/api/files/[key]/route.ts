import { NextResponse } from 'next/server';
import { getStorage, verifyLocalSignature } from '@/server/modules/storage/service';
import { getEnv } from '@/server/env';

/**
 * Local storage driver only (dev/test). Access is granted by the expiring HMAC signature
 * issued by attachment.downloadUrl, which already checked the caller's permission.
 * With STORAGE_DRIVER=s3 the presigned URL points at the bucket and this route is unused.
 */
export async function GET(req: Request, context: { params: Promise<{ key: string }> }) {
  if (getEnv().STORAGE_DRIVER !== 'local') {
    return NextResponse.json({ code: 'NOT_FOUND' }, { status: 404 });
  }
  const { key } = await context.params;
  const url = new URL(req.url);
  const exp = url.searchParams.get('exp');
  const sig = url.searchParams.get('sig');
  const decoded = decodeURIComponent(key);

  if (!exp || !sig || !verifyLocalSignature(decoded, exp, sig)) {
    return NextResponse.json(
      { code: 'FORBIDDEN', message: '다운로드 링크가 만료되었거나 올바르지 않습니다.' },
      { status: 403 },
    );
  }

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
