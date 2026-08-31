import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  APP_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
  APP_ORIGIN: z.string().url().default('http://localhost:3000'),
  DATABASE_URL: z.string().min(1),
  DATABASE_URL_TEST: z.string().optional(),
  SESSION_SECRET: z.string().min(32),
  DATA_ENCRYPTION_KEY: z.string().regex(/^[0-9a-fA-F]{64}$/, 'DATA_ENCRYPTION_KEY must be 32 bytes hex'),
  DATA_ENCRYPTION_KEY_VERSION: z.coerce.number().int().positive().default(1),
  STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
  STORAGE_LOCAL_DIR: z.string().default('./storage'),
  S3_ENDPOINT: z.string().optional(),
  S3_BUCKET: z.string().optional(),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  S3_REGION: z.string().default('auto'),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().default(587),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  SMTP_FROM: z.string().default('erp@example.com'),
  MESSENGER_CHANNEL: z.enum(['NONE', 'SLACK', 'KAKAOWORK', 'NAVERWORKS']).default('NONE'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
});

export type Env = z.infer<typeof schema>;

let cached: Env | null = null;

/**
 * NFR-SEC-03/06 — refuse to run production on the example values.
 *
 * The schema above checks shape, not substance: a key of 64 zeros is valid hex and the
 * literal `change-me-...` is longer than 32 characters, so `cp .env.example .env` on a
 * production host used to boot cleanly with an encryption key anyone who has read the
 * repository already knows, and a session secret that also signs attachment download links.
 * Shape checks cannot catch that; only naming the known-bad values can.
 *
 * This runs for staging and production only. Development and test keep the example values
 * on purpose, so the checks are aimed at deployment rather than at the developer's machine.
 */
export function assertDeploymentSecrets(env: Env): void {
  if (env.APP_ENV !== 'production' && env.APP_ENV !== 'staging') return;

  const problems: string[] = [];

  if (/^0+$/.test(env.DATA_ENCRYPTION_KEY) || /^(.)\1+$/.test(env.DATA_ENCRYPTION_KEY)) {
    problems.push('DATA_ENCRYPTION_KEY is the placeholder value from .env.example');
  }
  if (env.SESSION_SECRET.includes('change-me')) {
    problems.push('SESSION_SECRET is the placeholder value from .env.example');
  }
  if (new Set(env.SESSION_SECRET).size < 8) {
    problems.push('SESSION_SECRET has too little variety to be a real secret');
  }
  if (!env.APP_ORIGIN.startsWith('https://')) {
    problems.push('APP_ORIGIN must be https in staging and production');
  }
  if (env.STORAGE_DRIVER === 's3' && !env.S3_BUCKET) {
    problems.push('STORAGE_DRIVER=s3 requires S3_BUCKET');
  }

  if (problems.length > 0) {
    throw new Error(
      `Refusing to start ${env.APP_ENV} with unsafe configuration:\n` +
        problems.map((p) => `  - ${p}`).join('\n') +
        '\nGenerate real values before deploying. See docs/operations.md.',
    );
  }
}

export function getEnv(): Env {
  if (cached) return cached;
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  assertDeploymentSecrets(parsed.data);
  cached = parsed.data;
  return cached;
}

export const isProduction = () => getEnv().APP_ENV === 'production';
