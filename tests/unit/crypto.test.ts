// covers: NFR-SEC-03, NFR-SEC-06
import { beforeAll, describe, expect, it } from 'vitest';
import {
  decryptSensitive,
  encryptSensitive,
  hashPassword,
  hashToken,
  last4,
  newSessionToken,
  validatePasswordPolicy,
  verifyPassword,
} from '@/server/core/crypto';

beforeAll(() => {
  process.env['SESSION_SECRET'] = 'test-secret-value-least-32-bytes-long!!';
  process.env['DATA_ENCRYPTION_KEY'] = 'a'.repeat(64);
  process.env['DATABASE_URL'] = process.env['DATABASE_URL'] ?? 'postgresql://erp:erp@localhost:5432/octo_erp';
});

describe('password hashing (NFR-SEC-03)', () => {
  it('verifies the right password and rejects others', async () => {
    const hash = await hashPassword('Correct!12345');
    expect(hash.startsWith('scrypt$')).toBe(true);
    expect(hash).not.toContain('Correct!12345');
    expect(await verifyPassword('Correct!12345', hash)).toBe(true);
    expect(await verifyPassword('correct!12345', hash)).toBe(false);
  });

  it('salts each hash', async () => {
    expect(await hashPassword('Same!12345678')).not.toBe(await hashPassword('Same!12345678'));
  });

  it('enforces the password policy', () => {
    expect(validatePasswordPolicy('short1!')).toMatch(/10자 이상/);
    expect(validatePasswordPolicy('aaaaaaaaaaaa')).toMatch(/2종류 이상/);
    expect(validatePasswordPolicy('Passw0rd!23')).toBeNull();
  });
});

describe('session tokens (NFR-SEC-03)', () => {
  it('stores only the hash of the cookie token', () => {
    const { token, id } = newSessionToken();
    expect(id).toBe(hashToken(token));
    expect(id).not.toBe(token);
    expect(id).toHaveLength(64);
  });
});

describe('sensitive encryption (NFR-SEC-06)', () => {
  it('round-trips and never stores plaintext', () => {
    const enc = encryptSensitive('900101-1234567');
    expect(enc.ciphertext).not.toContain('900101');
    expect(decryptSensitive(enc.ciphertext)).toBe('900101-1234567');
  });

  it('produces different ciphertext for the same plaintext', () => {
    expect(encryptSensitive('110-123-456789').ciphertext).not.toBe(
      encryptSensitive('110-123-456789').ciphertext,
    );
  });

  it('fails closed on tampering', () => {
    const enc = encryptSensitive('secret-value');
    const tampered = enc.ciphertext.slice(0, -4) + 'AAAA';
    expect(() => decryptSensitive(tampered)).toThrow();
  });

  it('extracts last 4 digits for masking', () => {
    expect(last4('900101-1234567')).toBe('4567');
    expect(last4('110-123-456789')).toBe('6789');
  });
});
