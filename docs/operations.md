# 운영 런북 (Operations Runbook)

이 문서는 코드와 설정을 읽고 실제로 존재하는 것만 적는다. 문서에는 있지만 코드에는 없는 것(예: `docs/architecture.md`가 언급하는 `tools/reconcile-stock.mjs`, ADR-0002가 참조하는 `docs/ops/backup-restore.md`, 일 1회 백업 잡)은 "없다"고 명시하고 무엇이 있어야 하는지 적었다. 없는 절차를 있는 것처럼 적은 런북은 없느니만 못하다.

## 1. 환경 분리

환경은 `APP_ENV` 값(`development` / `test` / `staging` / `production`, `src/server/env.ts`)으로 구분되고, DB·버킷·비밀값은 환경마다 완전히 분리된다(`docs/security-model.md` §7). 세 환경이 같은 `SESSION_SECRET`이나 `DATA_ENCRYPTION_KEY`를 공유해서는 안 된다 — 세션 쿠키 위조 가능 범위와 민감정보 복호화 가능 범위가 그대로 겹치기 때문이다.

`getEnv()`는 zod 스키마로 값의 **형식**을 검증하고, `assertDeploymentSecrets()`는 그중 **`.env.example`의 기본값을 그대로 쓴 경우**를 별도로 잡아낸다. 이 구분이 필요한 이유는 코드 주석에 그대로 나온다: 64자리 0으로 채운 문자열도 유효한 hex이고, `change-me-...` 문자열도 32자 이상이라 zod 형식 검사는 통과한다. 그래서 `cp .env.example .env`를 운영에서 그대로 실행해도 부팅은 됐었다 — 그 값은 이 저장소를 읽은 사람이면 누구나 아는 값인데도. `assertDeploymentSecrets`는 `APP_ENV`가 `staging`/`production`일 때만 동작하며 다음을 거부한다.

- `DATA_ENCRYPTION_KEY`가 전부 같은 문자 반복(0 반복 포함)인 경우
- `SESSION_SECRET`에 `change-me`가 포함되거나, 서로 다른 문자가 8종 미만인 경우
- `APP_ORIGIN`이 `https://`로 시작하지 않는 경우
- `STORAGE_DRIVER=s3`인데 `S3_BUCKET`이 없는 경우

문제가 있으면 부팅 자체를 예외로 중단시킨다. `development`/`test`에서는 이 검사를 하지 않는다 — 로컬 개발자가 `.env.example` 그대로 켜는 것은 의도된 사용법이기 때문이다.

### 환경변수

| 변수 | 필수 | 설명 |
|---|---|---|
| `APP_ENV` | 아니오 (기본 `development`) | 배포 시크릿 검사·로그 바인딩의 기준 |
| `APP_ORIGIN` | 아니오 | CSRF Origin 허용값. staging/production은 `https://` 강제 |
| `DATABASE_URL` | 예 | 운영 DB 연결 문자열 |
| `DATABASE_URL_TEST` | 아니오 | 통합시험 전용 DB. 프로덕션 값과 절대 같으면 안 된다 |
| `SESSION_SECRET` | 예 (32자 이상) | 세션 서명, 로컬 첨부 서명 URL(HMAC)의 키 겸용 |
| `DATA_ENCRYPTION_KEY` | 예 (32바이트 hex) | 주민번호·계좌번호 AES-256-GCM 키. 분실 시 해당 데이터 전부 영구 복호화 불가 |
| `DATA_ENCRYPTION_KEY_VERSION` | 아니오 | 키 회전용 버전 번호 |
| `STORAGE_DRIVER` | 아니오 (`local`/`s3`) | production은 `s3` 사용 (ADR-0002) |
| `S3_ENDPOINT`/`S3_BUCKET`/`S3_ACCESS_KEY_ID`/`S3_SECRET_ACCESS_KEY`/`S3_REGION` | `s3`일 때 필수 | Cloudflare R2 등 S3 호환 버킷 |
| `SMTP_HOST`/`PORT`/`USER`/`PASS`/`FROM` | 아니오 | 미설정 시 이메일 발송은 outbox에서 실패로 쌓인다(아래 §5) |
| `MESSENGER_CHANNEL` | 아니오 (기본 `NONE`) | 코드에 실제 발송 어댑터는 없다. `messenger.send` 토픽은 워커에서 로그만 남기고 스킵된다(§5) |
| `LOG_LEVEL` | 아니오 | pino 레벨 |

`.env`는 커밋하지 않는다. 세 환경의 값은 서로 다른 시크릿 저장 위치(Railway 프로젝트별 변수)에 둔다.

## 2. 배포 절차

배포 단위는 `Dockerfile` 하나다. 멀티스테이지로 빌드하고(`prisma generate && next build`), 실행 이미지에는 `.next/standalone`, `prisma/`, `tools/`가 포함된다. `web`과 `worker`는 같은 이미지를 쓰고 시작 커맨드만 다르다(`docs/architecture.md` §6).

- `web` 서비스: `railway.json`의 `deploy.startCommand`가 `npx prisma migrate deploy && node server.js`다. **마이그레이션은 앱 프로세스가 요청을 받기 시작하기 전에, 매 배포마다 자동으로 실행된다.** 별도의 "release phase"가 있는 게 아니라 시작 커맨드 자체가 그 순서를 강제한다.
- `worker` 서비스: `npm run worker`로 시작한다(`docs/architecture.md`). 이 커맨드는 `prisma migrate deploy`를 실행하지 않는다 — 마이그레이션은 `web`이 책임진다. 따라서 **`worker`만 단독으로 먼저 재배포되는 순서는 피한다.** `web`이 새 마이그레이션을 아직 적용하지 않은 상태에서 새 스키마를 기대하는 `worker` 코드가 먼저 뜨면, 워커가 없는 컬럼/테이블을 참조해 실패한다.
- `healthcheckPath: /api/health`, `healthcheckTimeout: 120`, `restartPolicyType: ON_FAILURE`(최대 5회 재시도)가 설정되어 있다. Railway는 이 헬스체크가 통과할 때까지 이전 배포로 트래픽을 유지한다.

CI(`.github/workflows/ci.yml`)는 `push`·`pull_request`에서 `verify`(포맷·린트·타입체크·단위/통합시험·빌드·`traceability:check`·`npm audit`)와, `verify` 성공 후 `e2e`(Playwright, PostgreSQL 서비스 컨테이너 사용) 두 잡을 순서대로 돌린다. CI는 배포를 트리거하지 않는다 — Railway 쪽에서 별도로 이 저장소를 연결해 브랜치 푸시 시 빌드하도록 구성되어 있어야 한다(그 연결 설정 자체는 저장소 밖, Railway 프로젝트 설정에 있다).

배포 순서 요약:

1. `main`에 머지 → GitHub Actions `verify`+`e2e` 통과 확인.
2. Railway가 새 이미지를 빌드하고 `web` 서비스를 배포 — 이 시점에 `prisma migrate deploy`가 자동 실행된다.
3. `/api/health`가 `200`을 반환하면 트래픽 전환.
4. `worker` 서비스를 같은 이미지로 재배포한다(마이그레이션 재실행 없이 `npm run worker`만 재시작).
5. 배포 직후 `/system/jobs`에서 outbox 실패 건수가 0인지, `/api/health`의 `outbox.pending`이 튀지 않는지 확인한다.

## 3. 롤백 절차

가장 먼저 확인할 것: **이번 배포에 스키마 마이그레이션이 포함되어 있었는가.** 포함되지 않았다면 롤백은 단순하다 — Railway에서 이전 배포를 재실행(redeploy)하면 된다. 포함되어 있었다면 마이그레이션의 성격에 따라 절차가 완전히 달라진다.

**되돌릴 수 있는 마이그레이션 (additive)** — 컬럼 추가, 테이블 추가, nullable 컬럼, 인덱스 추가처럼 기존 코드가 몰라도 무시할 수 있는 변경. 이 경우 이전 이미지로 롤백해도 안전하다: 새 컬럼·테이블은 DB에 남아 있지만 이전 코드는 그것을 참조하지 않으므로 데이터 손실 없이 앱만 되돌아간다. `prisma migrate deploy`는 내려가는(down) 마이그레이션 개념이 없으므로, "롤백"은 스키마를 되돌리는 것이 아니라 **앱만 이전 버전으로 되돌리고 새 스키마는 그대로 둔다**는 뜻이다.

**되돌릴 수 없는 마이그레이션 (destructive)** — `DROP TABLE`/`DROP COLUMN`처럼 데이터를 지우는 변경, 또는 기존 데이터를 변환해 넣는 마이그레이션. `tools/migrate.mjs dev`는 새 마이그레이션을 생성할 때 이런 구문을 감지하면 `--accept-data-loss` 없이는 막는다 — 이것이 "이 마이그레이션은 파괴적이다"라는 신호다. 다만 이 검사는 **마이그레이션을 새로 만들 때만** 동작하고, `deploy`(운영 반영) 경로에는 그 검사가 없다 — 이미 만들어진 마이그레이션은 운영에서 그대로 적용된다. 파괴적 마이그레이션이 이미 운영에 적용된 뒤에는 이전 코드로 되돌려도 지워진 컬럼·테이블은 돌아오지 않는다. 이 경우 유일한 되돌리기 방법은 **마이그레이션 적용 전 시점의 DB 백업으로 복구**하는 것이고, 그 백업 이후에 쓰인 데이터는 잃는다. `docs/cutover-plan.md` §3의 롤백 판단·시한 원칙(자정을 넘겨 실거래가 쌓이면 되돌리는 비용이 급격히 오른다)은 이관 당일만이 아니라 파괴적 마이그레이션을 포함한 배포 전반에 그대로 적용되는 사고방식이다 — **그래서 파괴적 마이그레이션을 포함한 배포 직전에는 반드시 수동으로 전체 백업을 뜨고 나서 배포한다.** (자동 백업 잡의 현재 상태는 §4 참조.)

절차:

1. 이번 배포의 마이그레이션 폴더(`prisma/migrations/<timestamp>_*/migration.sql`)를 열어 `DROP`/데이터 변환 구문이 있는지 확인한다.
2. 없다면: Railway에서 이전 배포로 redeploy. 완료.
3. 있다면: 배포 직전에 뜬 백업이 있는지 확인 → 없으면 복구 가능한 지점이 없다는 뜻이므로, 먼저 현재 DB에서 가능한 한 최신 백업을 뜬 뒤 데이터 손실 범위를 팀에 알리고 진행 여부를 결정한다. 있다면 §5의 절차로 그 백업 시점까지 복구하고, 이후 앱도 그 마이그레이션 이전 버전으로 redeploy한다.
4. 어느 경우든 롤백 후 `/api/health`와 `/system/jobs`를 확인하고, 감사로그(`/system/audit`)에 롤백 사유를 남긴다.

## 4. 백업

**있어야 하는 것과 실제로 있는 것을 구분한다.**

- `docs/architecture.md` §6과 ADR-0002(`docs/adr/0002-deployment-auth-storage.md`)는 "PostgreSQL 일 1회 백업 + pg_dump 외부 보관 잡"을 전제로 적고 있고, ADR-0002는 복구 절차를 `docs/ops/backup-restore.md`에 있다고 적는다. **이 저장소에는 그 잡도, 그 문서도 존재하지 않는다.** `tools/`에는 `migrate.mjs`, `traceability.mjs`, `serve.mjs`, `seed-perf.mjs`, `e2e-prepare.ts`만 있고 백업 스크립트가 없으며, `.github/workflows/ci.yml`에도 백업을 수행하는 스텝이 없다.
- Railway가 PostgreSQL 플랜에 따라 자동 볼륨 스냅샷을 제공할 수 있으나, 이는 **이 저장소가 만든 것이 아니라 Railway 프로젝트 설정에 달린 것**이므로, 실제로 켜져 있는지·보관 기간이 며칠인지는 Railway 콘솔에서 직접 확인해야 한다. 이 문서만으로는 보장할 수 없다.

**당장 해야 할 것(실제로 백업해야 하는 대상):**

1. **PostgreSQL** — 업무전표·원장·감사로그·정책버전 전부가 여기 있다. `pg_dump`로 논리 백업을 뜨거나 Railway의 볼륨 스냅샷을 확인한다.
2. **첨부파일 객체 저장소** — `src/server/modules/storage/service.ts`가 정의하는 저장소. `STORAGE_DRIVER=s3`인 production/staging은 Cloudflare R2 등 S3 호환 버킷(`S3_BUCKET`)에 실 파일이 있다 — 이 버킷은 DB 백업에 포함되지 않으므로 별도로 백업(버전관리·리전 복제 등 R2 자체 기능)해야 한다. `STORAGE_DRIVER=local`은 dev/test 전용이며 `STORAGE_LOCAL_DIR` 아래 로컬 디스크에만 있어 컨테이너가 재생성되면 사라진다 — production에서 쓸 것이 아니다.
3. **`DATA_ENCRYPTION_KEY`** — DB 백업과 **같은 곳에 두지 않는다.** 이 키가 없으면 `EmployeeSensitive`의 주민번호·계좌번호 암호문은 DB가 멀쩡해도 영구히 복호화할 수 없다. 별도의 시크릿 보관(비밀번호 관리자·오프라인 보관 등)이 필요하다.

**없는 것 — 만들어야 하는 것:** 위 1의 자동화(스케줄·외부 보관·보관주기)와 그 절차를 적은 `docs/ops/backup-restore.md`. 최소 형태로는 Railway Cron 서비스 또는 GitHub Actions 스케줄에서 `pg_dump`를 실행해 S3/R2 등 DB와 별개인 저장소에 두는 것이 필요하다.

## 5. 복구 절차와 RPO/RTO

복구 절차:

1. 새 PostgreSQL 인스턴스(또는 기존 인스턴스 초기화)를 준비한다.
2. 확보한 백업(pg_dump 파일 또는 Railway 스냅샷)으로 복원한다.
3. 첨부 객체 저장소를 백업 시점으로 복원한다(버킷 복제본 전환 또는 백업본 복사).
4. `DATABASE_URL`을 복원된 DB로 맞추고 `web`을 재배포한다 — 시작 커맨드가 `prisma migrate deploy`를 실행하므로, 백업 시점 스키마가 그 사이 추가된 마이그레이션만큼 뒤처져 있어도 자동으로 최신까지 올라간다(단, §3의 파괴적 마이그레이션 논리는 여기도 그대로 적용된다).
5. `/api/health`로 DB 연결과 outbox 상태를 확인하고, `worker`를 재배포해 밀린 outbox 이벤트를 처리시킨다.
6. 표본 전표 몇 건과 최근 감사로그를 확인해 데이터가 기대한 시점의 것인지 검증한다.

**RPO/RTO는 목표로만 적고, 측정된 값이 아님을 분명히 한다.** 이 저장소에는 실제 복구 리허설(테스트 복원)을 수행한 기록이 없다 — §4에서 밝힌 대로 자동 백업 잡 자체가 아직 없으므로 RPO를 측정할 대상도 없다. 목표를 정하려면:

- **RPO(목표 복구 시점)**: 백업 주기가 그대로 상한이 된다. 일 1회 백업이면 RPO는 최대 24시간이지만, 이는 자동 백업이 실제로 구축된 뒤에나 의미가 있다.
- **RTO(목표 복구 시간)**: 복원 스크립트를 실제로 한 번 돌려서 걸리는 시간을 재기 전에는 추정치일 뿐이다.

다음에 해야 할 일은 §4의 백업 자동화를 구축한 뒤, 실제로 한 번 복구 리허설을 수행해 이 두 수치를 측정값으로 바꾸는 것이다.

## 6. 장애대응

### 로그 읽는 법

앱 로그는 `src/server/core/logger.ts`의 pino 인스턴스가 JSON으로 찍는다. `base: { app: 'octo-erp', env }`가 모든 라인에 붙고, `redact.paths`가 쿠키·비밀번호·토큰·세션ID·주민번호·계좌번호를 `[REDACTED]`로 가린다 — 로그에서 이 값들의 원문을 볼 수 없는 것은 설정 누락이 아니라 의도다. `LOG_LEVEL`(기본 `info`)로 상세도를 조절한다. 감사로그(`AuditLog`, DB 테이블, `/system/audit` 화면)와 앱 로그(pino, 콘솔/Railway 로그)는 별개다 — 업무 데이터 변경 이력을 찾을 땐 감사로그를, 처리 과정의 에러·경고를 찾을 땐 앱 로그를 본다.

### 헬스체크

`GET /api/health`는 `SELECT 1`로 DB 연결을 확인하고, `OutboxEvent`의 `PENDING`/`FAILED` 건수를 함께 반환한다. 실패하면 503과 에러 메시지를, 성공하면 `{ status: 'ok', db: 'ok', outbox: { pending, failed }, at }`를 준다. Railway는 이 경로로 배포 성공 여부를 판단하지만(§2), **이 엔드포인트를 배포 시점 이외에 상시로 폴링해 알림을 보내는 외부 모니터링(uptime robot, PagerDuty 등)은 이 저장소에 설정되어 있지 않다.** `worker` 프로세스는 HTTP 서버가 아니므로 이 헬스체크 대상도 아니다 — 워커가 죽었는지는 `/system/jobs`의 대기 건수 증가로만 알 수 있다.

### outbox가 밀릴 때

`npm run worker`(`src/server/jobs/worker.ts`)가 `OutboxEvent`를 `FOR UPDATE SKIP LOCKED`로 배치(기본 20건, `OUTBOX_BATCH`)씩 claim해 처리한다. 실패하면 지수 백오프(1분→5분→30분→2시간→12시간, `BACKOFF_MS`)로 재시도하고, 5회(`MAX_ATTEMPTS`) 모두 실패하면 `FAILED`로 확정한다. 이때 활성 admin 전원에게 **앱 내 알림만** 생성된다(`notifyAdminsOfFailure` — `notify()` 헬퍼를 거치지 않는 직접 삽입이라 이메일 채널을 타지 않는다). 즉 로그인해서 알림함을 보지 않으면 아무도 실패를 모른다.

대응 순서:

1. `/system/jobs`(`admin.jobs` 권한)에서 상태를 `실패`로 필터한다. `마지막 오류` 열에 실패 사유가 그대로 보인다.
2. 원인이 일시적(SMTP 일시 장애 등)이면 해당 건 또는 "실패건 전체 선택" 후 재시도한다 — `admin.retryOutbox`가 `attempt`를 0으로 되돌리고 `nextAttemptAt`을 즉시로 당겨 워커가 바로 다시 시도하게 한다.
3. 원인이 구조적(예: `SMTP_HOST` 미설정, 존재하지 않는 topic)이면 재시도해도 같은 이유로 다시 실패한다 — 환경변수나 배포를 고친 뒤에 재시도한다.
4. `/api/health`의 `outbox.pending`이 계속 증가하기만 하면(처리는 되는데 유입이 더 빠르거나, 워커 자체가 죽었으면) `worker` 서비스가 살아 있는지 Railway에서 확인한다. 워커 프로세스가 죽어도 `web`은 정상 응답하므로 헬스체크만으로는 드러나지 않는다.
5. `unknown outbox topic` 류의 에러가 보이면 배포 불일치다 — `worker.ts`의 `dispatch()`가 아는 topic(`email.send`, `messenger.send`, `job.*`)과 실제 큐에 쌓인 topic이 다른 버전의 코드다. `job.*`인데 핸들러가 없으면 `runScheduledJob`이 예외를 던지도록 되어 있다(§7) — 이 역시 배포 실수를 조용히 삼키지 않기 위한 설계다.

메신저 채널(`messenger.send`)은 `MESSENGER_CHANNEL=NONE`이 기본값이고 실제 발송 어댑터가 구현되어 있지 않다 — 이 topic은 워커가 로그만 남기고 성공 처리한다(DEC-09/ADR-0010, 채널 미정 상태). 메신저 알림이 실제로 안 온다고 해서 장애가 아니다.

## 7. 정기 작업

`src/server/jobs/register.ts`가 등록하는 예약 작업(`job.*` topic)은 세 가지다. **이 표에서 가장 중요한 사실은, 워커 자체는 스케줄러가 아니라는 것이다.** `npm run worker`는 이미 `OutboxEvent`에 쌓인 이벤트를 꺼내 처리할 뿐, 스스로 시간이 되었다고 새 이벤트를 만들지 않는다. 아래 표의 "실행 트리거" 열이 비어 있는 두 작업은 그래서 **실제로는 주기적으로 돌지 않는다.**

| topic | 하는 일 | 실행 트리거 | 실행 확인 |
|---|---|---|---|
| `job.contract_expiry` | 계약만료 30일 이내 사원을 인사담당(`hr.write`)에게 알림 | `hrm.updateEmployee`가 `contractEndDate`를 저장할 때마다 즉시 큐잉(`src/server/modules/hrm/employee.ts`) — **정기 스케줄이 아니라 사원정보 수정 시점의 이벤트다.** 아무도 그 사원 레코드를 만지지 않으면 만료일이 다가와도 새 알림이 생기지 않는다 | `/system/jobs`에서 topic으로 필터, 또는 인사담당 알림함 |
| `job.long_pending_approval` | 결재 대기가 정책(`notification` 정책의 `longPendingBusinessDays`)보다 오래된 문서의 결재선 담당자에게 알림 | **없음.** `longPendingApprovalJob`은 등록되어 있지만 이 topic으로 `outbox.enqueue`를 호출하는 코드가 저장소 어디에도 없다 | 실행된 적이 없으므로 확인할 방법도 없다 |
| `job.retention` | 개인정보 보유기간 도과 대상을 집계해 `RetentionRun(PLANNED)`을 만들고 관리자에게 알림 | **없음.** 같은 이유로 아무것도 이 topic을 큐잉하지 않는다 | 실행된 적이 없다 |

`job.safety_stock`이라는 topic도 `OutboxTopic` 타입에 선언되어 있지만, 등록된 핸들러도 없고 이를 enqueue하는 코드도 없다 — 안전재고 미달 확인은 실제로는 이 outbox 경로를 쓰지 않고, 입출고 확정 트랜잭션 안에서 `checkSafetyStock()`이 동기로 실행되어 그 자리에서 알림을 만든다(`src/server/modules/inventory/safety-stock.ts`). 이 topic 값은 죽은 코드로 보면 된다.

**필요한 것:** `job.retention`과 `job.long_pending_approval`을 실제로 주기 실행하려면 (a) 매일 한 번 두 topic으로 `outbox.enqueue`를 호출하는 스케줄러(예: Railway Cron 서비스가 별도 스크립트를 실행하거나, `worker.ts`의 루프에 시각 기반 트리거를 추가)와 (b) `job.retention`이 만드는 `RetentionRun`을 사람이 승인·실행할 수 있는 화면 또는 tRPC 프로시저가 필요하다 — 현재 `retention.plan/approve/execute`(`src/server/jobs/retention.ts`)는 어떤 라우터에서도 호출되지 않아 앱에서 도달할 방법이 없고, `retentionJob()`이 `plan()`을 호출해 대상이 있으면 경고 로그와 `SecurityEvent('RETENTION_DUE')`를 남기는 데서 끝난다. 즉 **파기 대상을 찾아내는 것까지는 코드가 있지만, 그 계획을 승인해서 실제로 파기를 실행하는 경로는 이 애플리케이션에 없다.** 자세한 내용과 두 단계(계획/실행)로 나뉜 이유는 `docs/admin-manual.md` "개인정보 보유기간과 파기" 절 참조.

이 외에 `docs/architecture.md` §7이 언급하는 `tools/reconcile-stock.mjs`(현재고 스냅샷을 원장과 대조·재생성)도 저장소에 존재하지 않는다 — `StockSnapshot`이 원장과 어긋났다고 의심될 때 지금은 수동으로 원장을 합산해 대조하는 것 외에 도구가 없다.
