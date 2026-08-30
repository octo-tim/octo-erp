// covers: INT-09, NFR-SEC-06
import { describe, expect, it } from 'vitest';
import { maskBankAccount, maskResidentNo, redact, REDACTED } from '@/server/core/redact';

describe('redaction (INT-09)', () => {
  it('removes sensitive keys at any depth', () => {
    const out = redact({
      username: 'tim',
      password: 'secret123',
      nested: {
        passwordHash: 'scrypt$...',
        residentNo: '900101-1234567',
        deep: { bankAccount: '110-123-456789' },
      },
      list: [{ token: 'abc' }],
    }) as unknown as Record<string, string>;

    expect(JSON.stringify(out)).not.toContain('secret123');
    expect(JSON.stringify(out)).not.toContain('900101-1234567');
    expect(JSON.stringify(out)).not.toContain('110-123-456789');
    expect(JSON.stringify(out)).not.toContain('abc');
    expect(out.username).toBe('tim');
  });

  it('partially masks contact fields', () => {
    const out = redact({ email: 'timyun816@example.com', phone: '01012345678' }) as {
      email: string;
      phone: string;
    };
    expect(out.email).toBe('ti***@example.com');
    expect(out.phone).toBe('*******5678');
  });

  it('keeps dates and primitives intact', () => {
    const d = new Date('2026-01-01T00:00:00Z');
    const out = redact({ at: d, count: 3, ok: true }) as { at: Date; count: number; ok: boolean };
    expect(out.at).toBe(d);
    expect(out.count).toBe(3);
    expect(out.ok).toBe(true);
  });

  it('produces display masks', () => {
    expect(maskResidentNo('4567')).toBe('******-4******');
    expect(maskBankAccount('6789')).toBe('****-****-6789');
    expect(redact({ password: 'x' })).toEqual({ password: REDACTED });
  });
});
