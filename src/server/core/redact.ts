// INT-09 / NFR-SEC-06: sensitive values never reach AuditLog, app logs, or error payloads.
const DENY_KEYS = [
  'password',
  'passwordhash',
  'newpassword',
  'currentpassword',
  'temporarypassword',
  'token',
  'sessionid',
  'session',
  'cookie',
  'authorization',
  'secret',
  'apikey',
  'residentno',
  'residentnoenc',
  'residentnumber',
  'ssn',
  'bankaccount',
  'bankaccountenc',
  'accountnumber',
  'dataencryptionkey',
  'privatekey',
  'signature',
  'storagekey',
  'signedurl',
];

const PARTIAL_KEYS = ['email', 'phone', 'mobile', 'address'];

export const REDACTED = '[REDACTED]';

function maskPartial(key: string, value: string): string {
  if (key === 'email') {
    const [local, domain] = value.split('@');
    if (!domain || !local) return REDACTED;
    return `${local.slice(0, 2)}***@${domain}`;
  }
  if (key === 'phone' || key === 'mobile') {
    return value.replace(/\d(?=\d{4})/g, '*');
  }
  if (key === 'address') {
    return value.length > 10 ? `${value.slice(0, 10)}...` : value;
  }
  return value;
}

export function redact<T>(input: T, depth = 0): T {
  if (depth > 12 || input === null || input === undefined) return input;
  if (input instanceof Date) return input;
  if (Array.isArray(input)) return input.map((v) => redact(v, depth + 1)) as unknown as T;
  if (typeof input === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
      const key = k.toLowerCase();
      if (DENY_KEYS.includes(key)) {
        out[k] = REDACTED;
      } else if (PARTIAL_KEYS.includes(key) && typeof v === 'string') {
        out[k] = maskPartial(key, v);
      } else {
        out[k] = redact(v, depth + 1);
      }
    }
    return out as unknown as T;
  }
  return input;
}

/** Display masks (screens, exports) — HRM-12 / NFR-SEC-06. */
/**
 * The conventional Korean masking: the birth-date half hidden, then the gender/century
 * digit, then the rest hidden. The digit shown is the seventh — the one that position in
 * the mask actually means. It previously showed the tenth digit there, which reads as a
 * gender marker to anyone who knows the format and is not one.
 */
export function maskResidentNo(maskDigit?: string | null): string {
  // Only ever one character reaches the screen. The stored column holds a single digit, but a
  // mask that interpolates whatever it is handed turns one bad caller into a disclosure, and
  // this function exists precisely so that cannot happen.
  const digit = maskDigit?.trim().slice(0, 1);
  return digit ? `******-${digit}******` : '******-*******';
}

export function maskBankAccount(last4?: string | null): string {
  const tail = last4?.trim().slice(-4);
  return tail ? `****-****-${tail}` : '****-****-****';
}
