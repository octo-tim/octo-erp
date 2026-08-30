# 엔지니어링 규칙 (Engineering Rules)

도구(사람·AI 에이전트·CI)에 중립적인 저장소 전체 규칙. `AGENTS.md`와 `CLAUDE.md`는 이 문서를 참조한다. 충돌 시 이 문서 > 모듈 README > 코드 주석 순으로 우선한다. 요구사항의 원본은 `docs/source/ERP_RFP_v0.3.md`, 구현 순서는 `docs/source/ERP_prompt_pack_v1.0.md`다.

## 1. 불변조건 (Invariants) — 위반하는 코드는 머지하지 않는다

1. **정밀 숫자**: 금액·수량·단가에 `number`/`float`를 쓰지 않는다. DB는 `Decimal`, API 입출력은 정밀 문자열(`"1234.5"`), 애플리케이션은 `decimal.js`(`src/lib/money.ts`)로 계산한다. `parseFloat`·`Number()`로 금액을 다루는 코드는 lint 규칙으로 차단한다.
2. **상태머신과 version**: 모든 업무전표(견적·주문·매출·매입·구매요청·발주·수금·지급·반품·입출고·이동·실사·회계전표·결재문서)는 명시적 상태 enum, 허용 전이표, `version`(낙관적 잠금) 컬럼을 가진다. 상태 전이는 `src/server/core/state-machine.ts`의 `transition()`을 통해서만 수행한다.
3. **확정 전 원장 무영향, 확정 후 직접 수정 금지**: DRAFT/PENDING_APPROVAL은 원장에 아무 영향이 없다. CONFIRMED 문서의 본문·라인은 `update`할 수 없고, 취소 후 재작성(복사)만 허용한다.
4. **원장은 삭제하지 않는다**: `InventoryLedger`, `JournalLine`, `LeaveLedger`, `SettlementMatch`, `AuditLog`, `ApprovalActionLog`에는 `DELETE`가 없다(Prisma 미들웨어와 DB 트리거로 차단). 취소는 원행과 연결된 반대행·역분개로 표현한다.
5. **서비스 쓰기 계약**: 모든 서비스 쓰기 함수 시그니처는 `(ctx: TransactionContext, input)`이며 `ctx = { tx, actor, requestId, now }`. 하위 서비스는 절대 `prisma.$transaction`을 새로 열지 않는다. 트랜잭션은 라우터 바로 아래 유스케이스 계층(`withTransaction`)에서 한 번만 연다.
6. **멱등성**: 승인·확정·취소·수금배분·아웃박스 처리 등 부작용이 있는 쓰기는 `requestId`를 받아 `IdempotencyRecord`(scope+requestId 유일)로 결과를 재사용하고, 원천 연결에는 DB 유일성 제약(`sourceType, sourceId, sourceVersion`)을 둔다.
7. **감사로그**: 업무 변경과 같은 트랜잭션에서 `AuditLog`를 기록한다. `redact()`가 denylist(password, passwordHash, token, session, residentNo, bankAccount, ssn, secret 등)를 제거·마스킹한 뒤 저장한다.
8. **아웃박스**: 이메일·메신저·예약작업 등 DB 밖 부작용은 같은 트랜잭션에서 `OutboxEvent`를 삽입하고, 커밋 후 워커가 처리한다. 서비스 코드에서 SMTP·HTTP를 직접 호출하지 않는다.
9. **서버 권한**: 모든 tRPC 프로시저는 `requireAuth` 이상을 거치고, 업무 프로시저는 `requirePermission('module.action')`과 데이터 범위(`requireDivisionScope`, `requireWarehouseScope`, `requireHrScope`)를 거친다. 목록·상세·내보내기·다운로드 모두 동일 범위 필터를 서버에서 적용한다. 화면의 메뉴 숨김은 보안 수단이 아니다.
10. **정책 버전**: DEC-01~09에 해당하는 계산·판정 로직은 `PolicyVersion`(policyKey, version, effectiveFrom, config)을 읽어 동작하며, 전표는 계산 당시 정책 버전을 기록한다. 과거 전표를 새 정책으로 재계산하지 않는다.

## 2. 아키텍처 규칙

- **레이어**: `app/`(Next.js 화면) → `server/api/routers/*`(tRPC: 인증·권한·zod 검증·유스케이스 호출만) → `server/modules/<module>/service.ts`(비즈니스 규칙) → Prisma. 라우터에 `if`문으로 업무 규칙을 쓰지 않는다.
- **모듈 경계**: `server/modules/{auth,rbac,audit,outbox,storage,policy,hrm,approval,master,inventory,accounting,sales,settlement,report,migration}`. 모듈 간 호출은 상대 모듈의 `service.ts`(공개 함수)만 import 하고, Prisma 모델을 직접 다루지 않는다.
- **통합 유스케이스**: 여러 모듈을 묶는 확정·취소·승인은 `server/usecases/`(예: `confirmBusinessDocument.ts`, `cancelBusinessDocument.ts`)에 두고, 여기서만 `withTransaction`을 연다.
- **결재 연동**: `ApprovalTargetHandler` 인터페이스(`validateBeforeSubmit/onApproved/onRejected/onCanceled`)를 `targetType`별 명시적 resolver 맵(`server/modules/approval/handlers/index.ts`)에 등록한다. 런타임 동적 등록에 의존하지 않는다.
- **입력 검증**: 모든 서버 입력은 zod 스키마(`server/api/schemas/*`)로 검증한다. 금액·수량은 `decimalString` 스키마.
- **에러**: 업무 오류는 `AppError(code, message, meta)`를 던지고 tRPC 에러 포맷터가 `code`를 노출한다. 코드는 `server/core/errors.ts`에 열거.
- **시간**: DB는 UTC `timestamptz`, 업무일(전표일·근태일)은 `date` 컬럼, 화면 표시는 Asia/Seoul. `now`는 `ctx.now`에서 받아 시험 가능하게 한다.

## 3. 데이터베이스 규칙

- Prisma schema 단일 파일 `prisma/schema.prisma`, 마이그레이션은 `prisma migrate` 산출물을 커밋한다. 운영 반영은 `prisma migrate deploy`.
- 모든 테이블: `id`(cuid), `createdAt`, `updatedAt`. 업무전표: `docNo`(unique), `status`, `version`, `divisionId`, `docDate`, `confirmedAt`, `canceledAt`, `cancelReason`, `policyVersionId`.
- 유일성 제약 필수: 문서번호, `(sourceType, sourceId, sourceVersion)` 연결, `(scope, requestId)` 멱등키, `(topic, dedupKey)` 아웃박스, 채번 `(ruleId, period, seq)`.
- 삭제: 마스터는 `isActive=false`(사용중지). 물리삭제는 사용 이력이 없을 때만 서비스가 허용.
- 인덱스는 조회 패턴 근거로 추가하고 `docs/db/indexes.md`에 사유를 남긴다.

## 4. 보안 규칙

`docs/security-model.md` 참조. 요약: scrypt 비밀번호 해시, DB 세션 + 회전, `Secure; HttpOnly; SameSite=Lax` 쿠키, Origin 검사 기반 CSRF 방어(모든 mutation), 로그인 5회 실패 잠금, 민감정보 AES-256-GCM 애플리케이션 암호화(키 분리, 복호화 사유·접근로그), 첨부 비공개 저장 + 만료형 서명 URL, 감사로그 redaction.

## 5. 품질 게이트 (모든 변경)

```
npm run format:check && npm run lint && npm run typecheck && npm run test && npm run test:integration && npm run build
```
UI 변경 시 `npm run test:e2e`(핵심 흐름)와 1440/1024/390px 뷰포트 스크린샷 확인. 통합시험은 실제 PostgreSQL(`DATABASE_URL_TEST`)에서 실행하며 모킹하지 않는다. 실패한 시험을 삭제·skip·완화하지 않는다.

## 6. 추적성

- 요구사항 ID별 증적은 `docs/traceability-state.json`에 기록하고 `node tools/traceability.mjs`로 추적표를 재생성한다. `--check`는 CI에서 실행된다.
- 시험 파일 상단 주석에 대상 ID를 적는다: `// covers: INV-04, INV-06, INT-08`.
- 신규 요구사항은 구현하지 않고 `__changeRequests`에 기록한다.

## 7. 코드 스타일

- TypeScript `strict`, `noUncheckedIndexedAccess`. `any` 금지(불가피 시 `// reason:` 주석).
- 파일 길이·함수 길이에 기계적 제한을 두지 않는다. 모듈 응집도와 시험 가능성을 우선한다.
- 네이밍: DB/Prisma 모델 PascalCase, 컬럼 camelCase, 권한 문자열 `module.action`(예: `sales.confirm`), 상태 enum UPPER_SNAKE.
- UI 문구는 한국어. 사용자 오류 메시지는 원인과 다음 행동을 포함한다("저장할 수 없습니다: 2026-07은 마감된 기간입니다. 마감 해제 후 다시 시도하세요").
- 커밋 메시지는 ASCII, 괄호 없음, `STEP n:` 또는 모듈 접두사.
