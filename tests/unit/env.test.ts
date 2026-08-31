// covers: NFR-OPS-01
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { assertDeploymentSecrets, type Env } from '@/server/env';

/**
 * NFR-OPS-01 — 환경 분리(dev/staging/production, 데이터·비밀값 분리)의 안전망은
 * `assertDeploymentSecrets`가 운영/스테이징에서 .env.example 자리표시값을 거부하는 것과,
 * `getEnv`가 필수 변수 누락·타입 오류를 zod로 걷러내는 것 두 가지다. 이 파일 이전에는
 * `src/server/env.ts`에 대한 시험이 전혀 없었다(감사: docs/audit-step13.md).
 *
 * 주의(캐시): getEnv()는 모듈 스코프의 `cached` 변수에 첫 파싱 결과를 저장해 두 번째
 * 호출부터는 process.env를 다시 읽지 않는다. 같은 모듈 인스턴스에서 여러 케이스를
 * 돌리면 첫 케이스의 결과가 이후 케이스에 새어 들어가 시험이 실행 순서에 의존하게
 * 된다. 이를 피하려고 소스는 건드리지 않고, getEnv()를 쓰는 케이스마다
 * `vi.resetModules()`로 모듈 레지스트리를 비운 뒤 `import('@/server/env')`로
 * 그 케이스만의 새 모듈 인스턴스(= 새 `cached`)를 얻는다. assertDeploymentSecrets는
 * 인자로 받은 Env 객체만 검사하고 캐시를 건드리지 않으므로, 그 시험들은 이 문제와
 * 무관하게 직접 값을 만들어 호출한다.
 */

// 실제 비밀값이 아님 — 오직 "형태만" 맞춘 시험용 가짜 값.
const FAKE_ENCRYPTION_KEY = 'ab'.repeat(32); // 64 hex chars, all-zero도 아니고 단일문자 반복도 아님
const FAKE_SESSION_SECRET = 'Fx7!qLp2*Vt9#Zk4_Nb8@Rw3$Yc6-Hm1'; // 32자 이상, 서로 다른 문자 8종 이상

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    NODE_ENV: 'production',
    APP_ENV: 'production',
    APP_ORIGIN: 'https://erp.octoworks.co.kr',
    DATABASE_URL: 'postgresql://erp:erp@db.internal:5432/octo_erp',
    DATABASE_URL_TEST: undefined,
    SESSION_SECRET: FAKE_SESSION_SECRET,
    DATA_ENCRYPTION_KEY: FAKE_ENCRYPTION_KEY,
    DATA_ENCRYPTION_KEY_VERSION: 1,
    STORAGE_DRIVER: 'local',
    STORAGE_LOCAL_DIR: './storage',
    S3_ENDPOINT: undefined,
    S3_BUCKET: undefined,
    S3_ACCESS_KEY_ID: undefined,
    S3_SECRET_ACCESS_KEY: undefined,
    S3_REGION: 'auto',
    SMTP_HOST: undefined,
    SMTP_PORT: 587,
    SMTP_USER: undefined,
    SMTP_PASS: undefined,
    SMTP_FROM: 'erp@example.com',
    MESSENGER_CHANNEL: 'NONE',
    LOG_LEVEL: 'info',
    ...overrides,
  };
}

describe('assertDeploymentSecrets — 운영/스테이징 자리표시값 거부 (NFR-OPS-01)', () => {
  it.each(['production', 'staging'] as const)(
    '%s: 전부 0인 DATA_ENCRYPTION_KEY(.env.example 값)를 거부한다',
    (appEnv) => {
      const env = makeEnv({ APP_ENV: appEnv, DATA_ENCRYPTION_KEY: '0'.repeat(64) });
      expect(() => assertDeploymentSecrets(env)).toThrow(/DATA_ENCRYPTION_KEY is the placeholder value/);
    },
  );

  it('production: 같은 문자만 반복되는 DATA_ENCRYPTION_KEY도 자리표시값으로 거부한다', () => {
    const env = makeEnv({ DATA_ENCRYPTION_KEY: 'f'.repeat(64) });
    expect(() => assertDeploymentSecrets(env)).toThrow(/DATA_ENCRYPTION_KEY is the placeholder value/);
  });

  it('production: "change-me"가 포함된 SESSION_SECRET(.env.example 값)을 거부한다', () => {
    const env = makeEnv({
      SESSION_SECRET: 'change-me-32-bytes-minimum-secret-value-000',
    });
    expect(() => assertDeploymentSecrets(env)).toThrow(/SESSION_SECRET is the placeholder value/);
  });

  it('production: 문자 다양성이 낮은 SESSION_SECRET을 거부한다', () => {
    // 길이는 32자 이상이라 스키마는 통과하지만, 서로 다른 문자가 8종 미만이라 진짜 비밀값일 수 없다.
    const env = makeEnv({ SESSION_SECRET: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' });
    expect(() => assertDeploymentSecrets(env)).toThrow(/SESSION_SECRET has too little variety/);
  });

  it('production: https가 아닌 APP_ORIGIN을 거부한다', () => {
    const env = makeEnv({ APP_ORIGIN: 'http://erp.octoworks.co.kr' });
    expect(() => assertDeploymentSecrets(env)).toThrow(/APP_ORIGIN must be https in staging and production/);
  });

  it('production: STORAGE_DRIVER=s3인데 S3_BUCKET이 없으면 거부한다', () => {
    const env = makeEnv({ STORAGE_DRIVER: 's3', S3_BUCKET: undefined });
    expect(() => assertDeploymentSecrets(env)).toThrow(/STORAGE_DRIVER=s3 requires S3_BUCKET/);
  });

  it('production: STORAGE_DRIVER=s3이고 S3_BUCKET이 있으면 그 문제는 통과한다', () => {
    const env = makeEnv({ STORAGE_DRIVER: 's3', S3_BUCKET: 'octo-erp-prod-attachments' });
    expect(() => assertDeploymentSecrets(env)).not.toThrow();
  });

  it('production: 문제가 여러 개면 전부 나열한다', () => {
    const env = makeEnv({
      DATA_ENCRYPTION_KEY: '0'.repeat(64),
      APP_ORIGIN: 'http://erp.octoworks.co.kr',
    });
    try {
      assertDeploymentSecrets(env);
      throw new Error('expected assertDeploymentSecrets to throw');
    } catch (e) {
      const message = (e as Error).message;
      expect(message).toMatch(/DATA_ENCRYPTION_KEY is the placeholder value/);
      expect(message).toMatch(/APP_ORIGIN must be https/);
    }
  });

  it('정상적인 운영 설정은 그대로 허용한다', () => {
    expect(() => assertDeploymentSecrets(makeEnv())).not.toThrow();
  });

  it('개발 환경은 운영 규칙을 적용받지 않는다(코드가 실제로 그렇게 되어 있다: APP_ENV가 production/staging이 아니면 즉시 반환)', () => {
    // .env.example의 실제 자리표시값을 그대로 넣어도 development에서는 통과해야 한다 —
    // AGENTS.md의 로컬 실행 안내(`cp .env.example .env`)가 개발자 PC에서 깨지지 않게 하려는 의도.
    const env = makeEnv({
      APP_ENV: 'development',
      DATA_ENCRYPTION_KEY: '0'.repeat(64),
      SESSION_SECRET: 'change-me-32-bytes-minimum-secret-value-000',
      APP_ORIGIN: 'http://localhost:3000',
      STORAGE_DRIVER: 's3',
      S3_BUCKET: undefined,
    });
    expect(() => assertDeploymentSecrets(env)).not.toThrow();
  });
});

describe('getEnv — 파싱과 기본값 (NFR-OPS-01)', () => {
  const ORIGINAL_ENV = process.env;

  // 필수 변수만 채운, 그 자체로는 유효한 최소 환경. 각 케이스는 여기서 필요한 것만 지우거나 바꾼다.
  // NODE_ENV는 일부러 넣지 않는다 — 기본값 검증 시험이 실제 default('development')를 관찰하려면
  // process.env에 NODE_ENV가 아예 없어야 한다. (NodeJS.ProcessEnv는 Next.js 타입 보강으로
  // NODE_ENV를 필수 프로퍼티로 선언하므로, 여기서는 순수 Record로 만든 뒤 캐스팅한다.)
  function requiredOnlyEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
    const base: Record<string, string> = {
      DATABASE_URL: 'postgresql://erp:erp@localhost:5432/octo_erp',
      SESSION_SECRET: FAKE_SESSION_SECRET,
      DATA_ENCRYPTION_KEY: FAKE_ENCRYPTION_KEY,
    };
    const merged: Record<string, string | undefined> = { ...base, ...overrides };
    const result: Record<string, string> = {};
    for (const [k, v] of Object.entries(merged)) {
      if (v !== undefined) result[k] = v;
    }
    return result as NodeJS.ProcessEnv;
  }

  async function loadEnvModule() {
    vi.resetModules();
    return import('@/server/env');
  }

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
    vi.resetModules();
  });

  it('필수 변수(DATABASE_URL)가 없으면 부팅에 실패한다', async () => {
    process.env = requiredOnlyEnv({ DATABASE_URL: undefined });
    const { getEnv } = await loadEnvModule();
    expect(() => getEnv()).toThrow(/DATABASE_URL/);
  });

  it('필수 변수(SESSION_SECRET)가 32자 미만이면 부팅에 실패한다', async () => {
    process.env = requiredOnlyEnv({ SESSION_SECRET: 'too-short' });
    const { getEnv } = await loadEnvModule();
    expect(() => getEnv()).toThrow(/SESSION_SECRET/);
  });

  it('DATA_ENCRYPTION_KEY가 64자 hex가 아니면 부팅에 실패한다', async () => {
    process.env = requiredOnlyEnv({ DATA_ENCRYPTION_KEY: 'not-a-valid-hex-key' });
    const { getEnv } = await loadEnvModule();
    expect(() => getEnv()).toThrow(/DATA_ENCRYPTION_KEY must be 32 bytes hex/);
  });

  it('APP_ENV에 허용되지 않는 값이 들어오면 부팅에 실패한다', async () => {
    process.env = requiredOnlyEnv({ APP_ENV: 'sandbox' });
    const { getEnv } = await loadEnvModule();
    expect(() => getEnv()).toThrow(/APP_ENV/);
  });

  it('선택 변수를 비우면 문서화된 기본값을 채운다', async () => {
    process.env = requiredOnlyEnv();
    const { getEnv } = await loadEnvModule();
    const env = getEnv();
    expect(env.NODE_ENV).toBe('development');
    expect(env.APP_ENV).toBe('development');
    expect(env.APP_ORIGIN).toBe('http://localhost:3000');
    expect(env.DATA_ENCRYPTION_KEY_VERSION).toBe(1);
    expect(env.STORAGE_DRIVER).toBe('local');
    expect(env.STORAGE_LOCAL_DIR).toBe('./storage');
    expect(env.S3_REGION).toBe('auto');
    expect(env.SMTP_PORT).toBe(587);
    expect(env.SMTP_FROM).toBe('erp@example.com');
    expect(env.MESSENGER_CHANNEL).toBe('NONE');
    expect(env.LOG_LEVEL).toBe('info');
  });

  it('숫자로 들어와야 하는 변수를 문자열로 받아 coerce한다(SMTP_PORT, DATA_ENCRYPTION_KEY_VERSION)', async () => {
    process.env = requiredOnlyEnv({ SMTP_PORT: '2525', DATA_ENCRYPTION_KEY_VERSION: '3' });
    const { getEnv } = await loadEnvModule();
    const env = getEnv();
    expect(env.SMTP_PORT).toBe(2525);
    expect(typeof env.SMTP_PORT).toBe('number');
    expect(env.DATA_ENCRYPTION_KEY_VERSION).toBe(3);
  });

  it('DATA_ENCRYPTION_KEY_VERSION이 0 이하이면 부팅에 실패한다(양의 정수만 허용)', async () => {
    process.env = requiredOnlyEnv({ DATA_ENCRYPTION_KEY_VERSION: '0' });
    const { getEnv } = await loadEnvModule();
    expect(() => getEnv()).toThrow(/DATA_ENCRYPTION_KEY_VERSION/);
  });

  it('development 기본값에는 assertDeploymentSecrets의 운영 전용 검사가 적용되지 않는다', async () => {
    // APP_ENV를 지정하지 않으면 기본값 development가 되고, .env.example 그대로도 부팅되어야 한다.
    process.env = requiredOnlyEnv({
      SESSION_SECRET: 'change-me-32-bytes-minimum-secret-value-000',
      DATA_ENCRYPTION_KEY: '0'.repeat(64),
    });
    const { getEnv } = await loadEnvModule();
    expect(() => getEnv()).not.toThrow();
  });

  it('production이고 자리표시값이면 getEnv() 자체가 거부한다(파싱 성공 후 assertDeploymentSecrets가 호출됨)', async () => {
    process.env = requiredOnlyEnv({
      APP_ENV: 'production',
      APP_ORIGIN: 'https://erp.octoworks.co.kr',
      SESSION_SECRET: 'change-me-32-bytes-minimum-secret-value-000',
    });
    const { getEnv } = await loadEnvModule();
    expect(() => getEnv()).toThrow(/Refusing to start production with unsafe configuration/);
  });

  it('같은 모듈 인스턴스에서는 결과를 캐시해 두 번째 호출부터는 process.env 변경을 반영하지 않는다', async () => {
    process.env = requiredOnlyEnv({ LOG_LEVEL: 'info' });
    const { getEnv } = await loadEnvModule();
    const first = getEnv();
    process.env['LOG_LEVEL'] = 'debug';
    const second = getEnv();
    expect(second).toBe(first); // 캐시된 동일 객체
    expect(second.LOG_LEVEL).toBe('info'); // 변경된 process.env가 아니라 최초 파싱값 유지
  });
});
