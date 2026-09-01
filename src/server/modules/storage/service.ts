import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { AppError } from '@/server/core/errors';
import { getEnv } from '@/server/env';
import { hmac } from '@/server/core/crypto';

/** NFR-SEC-07: private object storage with expiring access URLs. */
export const MAX_FILE_BYTES = 20 * 1024 * 1024;

export const ALLOWED_MIME: Record<string, string[]> = {
  'application/pdf': ['pdf'],
  'image/png': ['png'],
  'image/jpeg': ['jpg', 'jpeg'],
  'image/gif': ['gif'],
  'image/webp': ['webp'],
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['xlsx'],
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['docx'],
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': ['pptx'],
  'application/haansofthwp': ['hwp'],
  'application/x-hwp': ['hwp'],
  'application/zip': ['zip'],
  'text/csv': ['csv'],
  'text/plain': ['txt'],
};

const MAGIC: { mime: string; bytes: number[] }[] = [
  { mime: 'application/pdf', bytes: [0x25, 0x50, 0x44, 0x46] },
  { mime: 'image/png', bytes: [0x89, 0x50, 0x4e, 0x47] },
  { mime: 'image/jpeg', bytes: [0xff, 0xd8, 0xff] },
  { mime: 'image/gif', bytes: [0x47, 0x49, 0x46, 0x38] },
];

export interface StorageAdapter {
  put(key: string, body: Buffer, mimeType: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  remove(key: string): Promise<void>;
  /**
   * `subject` is the user the link is issued to. It is signed into the URL, so a link that
   * leaks — into browser history, a proxy log, a pasted message — is useless to anyone else.
   * Without it the signature is a bearer token for the file, valid for whoever holds it.
   */
  signedUrl(key: string, expiresInSeconds: number, subject: string): Promise<string>;
}

class LocalAdapter implements StorageAdapter {
  constructor(private readonly dir: string) {}
  private full(key: string) {
    const p = path.resolve(this.dir, key);
    if (!p.startsWith(path.resolve(this.dir))) throw new AppError('VALIDATION', '잘못된 저장 경로입니다.');
    return p;
  }
  async put(key: string, body: Buffer) {
    const p = this.full(key);
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, body);
  }
  async get(key: string) {
    return fs.readFile(this.full(key));
  }
  async remove(key: string) {
    await fs.rm(this.full(key), { force: true });
  }
  async signedUrl(key: string, expiresInSeconds: number, subject: string) {
    const exp = Math.floor(Date.now() / 1000) + expiresInSeconds;
    const sig = hmac(`${key}:${exp}:${subject}`, getEnv().SESSION_SECRET);
    return `/api/files/${encodeURIComponent(key)}?exp=${exp}&sub=${encodeURIComponent(subject)}&sig=${sig}`;
  }
}

class S3Adapter implements StorageAdapter {
  // Kept thin on purpose: the S3-compatible client is wired at deploy time (DEC-07/ADR-0002).
  constructor(private readonly cfg: { endpoint: string; bucket: string; accessKeyId: string; secretAccessKey: string; region: string }) {}
  private async client() {
    const mod = await import('@aws-sdk/client-s3').catch(() => {
      throw new AppError('INTERNAL', 'S3 저장소 드라이버가 설치되지 않았습니다. STORAGE_DRIVER=local 로 실행하거나 @aws-sdk/client-s3 를 설치하세요.');
    });
    return new mod.S3Client({
      endpoint: this.cfg.endpoint,
      region: this.cfg.region,
      credentials: { accessKeyId: this.cfg.accessKeyId, secretAccessKey: this.cfg.secretAccessKey },
      forcePathStyle: true,
    });
  }
  async put(key: string, body: Buffer, mimeType: string) {
    const mod = await import('@aws-sdk/client-s3');
    const c = await this.client();
    await c.send(new mod.PutObjectCommand({ Bucket: this.cfg.bucket, Key: key, Body: body, ContentType: mimeType }));
  }
  async get(key: string) {
    const mod = await import('@aws-sdk/client-s3');
    const c = await this.client();
    const res = await c.send(new mod.GetObjectCommand({ Bucket: this.cfg.bucket, Key: key }));
    return Buffer.from(await (res.Body as { transformToByteArray(): Promise<Uint8Array> }).transformToByteArray());
  }
  async remove(key: string) {
    const mod = await import('@aws-sdk/client-s3');
    const c = await this.client();
    await c.send(new mod.DeleteObjectCommand({ Bucket: this.cfg.bucket, Key: key }));
  }
  async signedUrl(key: string, expiresInSeconds: number, _subject: string) {
    const mod = await import('@aws-sdk/client-s3');
    const presign = await import('@aws-sdk/s3-request-presigner');
    const c = await this.client();
    /**
     * A presigned S3 URL cannot carry the subject, so on this driver the link IS a bearer
     * token for its lifetime — that is inherent to presigning, not something this code can
     * fix. The expiry is therefore what limits the exposure, and it is deliberately short.
     * If a deployment needs the link bound to a user, it has to proxy downloads through
     * this application rather than hand out bucket URLs.
     */
    return presign.getSignedUrl(c, new mod.GetObjectCommand({ Bucket: this.cfg.bucket, Key: key }), {
      expiresIn: expiresInSeconds,
    });
  }
}

let adapter: StorageAdapter | null = null;

export function getStorage(): StorageAdapter {
  if (adapter) return adapter;
  const env = getEnv();
  adapter =
    env.STORAGE_DRIVER === 's3'
      ? new S3Adapter({
          endpoint: env.S3_ENDPOINT ?? '',
          bucket: env.S3_BUCKET ?? '',
          accessKeyId: env.S3_ACCESS_KEY_ID ?? '',
          secretAccessKey: env.S3_SECRET_ACCESS_KEY ?? '',
          region: env.S3_REGION,
        })
      : new LocalAdapter(env.STORAGE_LOCAL_DIR);
  return adapter;
}

export function verifyLocalSignature(key: string, exp: string, sig: string, subject: string): boolean {
  if (!/^\d+$/.test(exp) || Number(exp) * 1000 < Date.now()) return false;
  const expected = hmac(`${key}:${exp}:${subject}`, getEnv().SESSION_SECRET);

  /**
   * Both sides are compared as bytes of equal length. The previous version padded the
   * supplied signature by character count and then measured it in bytes, so any multi-byte
   * character made the two buffers different lengths and timingSafeEqual threw — turning a
   * malformed query string into an unhandled 500 rather than a refusal.
   */
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(sig, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export function assertUploadAllowed(input: { size: number; mimeType: string; originalName: string; head: Buffer }): void {
  if (input.size <= 0 || input.size > MAX_FILE_BYTES) {
    throw new AppError('VALIDATION', `첨부파일은 1바이트 이상 ${MAX_FILE_BYTES / 1024 / 1024}MB 이하만 업로드할 수 있습니다.`);
  }
  const allowedExts = ALLOWED_MIME[input.mimeType];
  if (!allowedExts) throw new AppError('VALIDATION', `허용되지 않는 파일 형식입니다: ${input.mimeType}`);

  const ext = input.originalName.split('.').pop()?.toLowerCase() ?? '';
  if (!allowedExts.includes(ext)) {
    throw new AppError('VALIDATION', `파일 확장자(.${ext})가 형식(${input.mimeType})과 일치하지 않습니다.`);
  }
  const magic = MAGIC.find((m) => m.mime === input.mimeType);
  if (magic && !magic.bytes.every((b, i) => input.head[i] === b)) {
    throw new AppError('VALIDATION', '파일 내용이 선언된 형식과 일치하지 않습니다.');
  }
}

/** Storage keys never contain the user-supplied filename (NFR-SEC-07). */
export function buildStorageKey(ownerType: string, mimeType: string, now: Date): string {
  const ext = ALLOWED_MIME[mimeType]?.[0] ?? 'bin';
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  return `${ownerType.toLowerCase()}/${y}/${m}/${crypto.randomUUID()}.${ext}`;
}

export function sha256(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}
