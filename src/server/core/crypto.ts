import crypto from 'node:crypto';
import { getEnv } from '@/server/env';

// NFR-SEC-03: scrypt password hashing with per-password salt.
const SCRYPT = { N: 32768, r: 8, p: 1, keylen: 64 };

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(32);
  const key = await new Promise<Buffer>((resolve, reject) => {
    crypto.scrypt(
      password,
      salt,
      SCRYPT.keylen,
      { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: 128 * SCRYPT.N * SCRYPT.r * 2 },
      (err, dk) => (err ? reject(err) : resolve(dk as Buffer)),
    );
  });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, nRaw, rRaw, pRaw, saltB64, keyB64] = parts;
  const N = Number(nRaw),
    r = Number(rRaw),
    p = Number(pRaw);
  const salt = Buffer.from(saltB64 ?? '', 'base64');
  const expected = Buffer.from(keyB64 ?? '', 'base64');
  const key = await new Promise<Buffer>((resolve, reject) => {
    crypto.scrypt(password, salt, expected.length, { N, r, p, maxmem: 128 * N * r * 2 }, (err, dk) =>
      err ? reject(err) : resolve(dk as Buffer),
    );
  });
  return key.length === expected.length && crypto.timingSafeEqual(key, expected);
}

export function validatePasswordPolicy(password: string): string | null {
  if (password.length < 10) return '비밀번호는 10자 이상이어야 합니다.';
  const classes = [/[a-zA-Z]/, /[0-9]/, /[^a-zA-Z0-9]/].filter((re) => re.test(password)).length;
  if (classes < 2) return '비밀번호는 영문·숫자·특수문자 중 2종류 이상을 포함해야 합니다.';
  return null;
}

// Session tokens: the raw token goes to the cookie, only its hash is stored (docs/security-model.md §1).
export function newSessionToken(): { token: string; id: string } {
  const token = crypto.randomBytes(32).toString('base64url');
  return { token, id: hashToken(token) };
}

export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

// NFR-SEC-06: AES-256-GCM application-level encryption with key/data separation.
export interface EncryptedValue {
  ciphertext: string;
  keyVersion: number;
}

function key(): Buffer {
  return Buffer.from(getEnv().DATA_ENCRYPTION_KEY, 'hex');
}

export function encryptSensitive(plain: string): EncryptedValue {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    ciphertext: `v1.${iv.toString('base64')}.${enc.toString('base64')}.${tag.toString('base64')}`,
    keyVersion: getEnv().DATA_ENCRYPTION_KEY_VERSION,
  };
}

export function decryptSensitive(ciphertext: string): string {
  const [version, ivB64, dataB64, tagB64] = ciphertext.split('.');
  if (version !== 'v1' || !ivB64 || !dataB64 || !tagB64) throw new Error('invalid ciphertext');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8');
}

export const last4 = (v: string): string => v.replace(/\D/g, '').slice(-4);

export function randomId(bytes = 16): string {
  return crypto.randomBytes(bytes).toString('hex');
}

export function hmac(value: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(value).digest('hex');
}
