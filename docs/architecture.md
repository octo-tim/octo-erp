# 아키텍처 (Architecture)

## 1. 기술 스택 (DEC-07 승인안)

| 계층 | 선택 | 비고 |
|---|---|---|
| 프런트·서버 | Next.js 15 App Router, TypeScript strict, React 19 | 단일 배포 단위 |
| API | tRPC v11 + zod, superjson 미사용(정밀 숫자는 문자열) | `/api/trpc` |
| DB | PostgreSQL 16 + Prisma 6 | Railway PostgreSQL |
| UI | Tailwind CSS 4, shadcn/ui 스타일 컴포넌트, TanStack Table/Query | PC 우선 반응형 |
| 인증 | 자체 DB 세션, scrypt 해시, `erp_session` 쿠키 | NextAuth 미사용 |
| 파일 | 비공개 객체 저장소 어댑터(S3 호환 / 로컬 FS) | 만료형 서명 URL |
| 알림 | 앱 내 Notification + 이메일(SMTP, nodemailer) via OutboxEvent | 메신저 어댑터 NONE |
| PDF | `@react-pdf/renderer` 서버 렌더 | 견적·세금계산서·결재·증명서 |
| 엑셀 | `exceljs` | 내보내기·일괄등록 |
| 시험 | Vitest(unit·integration, 실제 PostgreSQL), Playwright(E2E) | |
| 배포 | Docker 이미지 → Railway, GitHub Actions CI | |

## 2. 디렉터리

```
src/
  app/                     # 화면(App Router). (auth)/login, (app)/... 모듈별 페이지
  components/              # 공통 UI: app-shell, data-grid, standard-list-page, voucher-line-editor ...
  lib/                     # 순수 유틸: money.ts(decimal), dates.ts(KST), format.ts, trpc client
  server/
    core/                  # TransactionContext, withTransaction, errors, state-machine, idempotency, redact
    db.ts                  # Prisma client (원장 삭제 차단 확장 포함)
    env.ts                 # zod 환경변수 검증
    api/
      trpc.ts              # context, procedures(public/auth/permission/scope)
      root.ts              # appRouter
      routers/<module>.ts  # 모듈별 라우터: 인증·권한·검증·유스케이스 호출만
      schemas/             # zod 입력 스키마
    modules/<module>/      # service.ts(공개 함수), 내부 파일, policies
    usecases/              # 모듈 간 트랜잭션 유스케이스(confirm/cancel/approve)
    jobs/                  # outbox worker, scheduled jobs(안전재고, 계약만료, 장기미결, 파기)
prisma/                    # schema.prisma, migrations, seed.ts
tests/
  unit/  integration/  e2e/  fixtures/
tools/                     # traceability, api-spec 생성, 대사 커맨드
docs/
```

## 3. 모듈 경계와 의존 방향

```
auth ─ rbac ─ audit ─ outbox ─ storage ─ policy        (core/infra: 모든 모듈이 사용 가능)
        │
hrm ────┤            master(BAS)
        │               │
approval◄──handlers──┬──┼── sales(SLS: 견적·주문·매출·매입·구매요청·발주·반품)
                     │  ├── inventory(INV)
                     │  ├── settlement(수금·지급·채권채무)
                     │  └── accounting(ACC)
                     │
                 usecases (confirmBusinessDocument, cancelBusinessDocument, approvalCallbacks)
                     │
                 report(RPT) ── 원장·확정전표만 읽기
                 migration(MIG) ── 각 모듈 service의 import 함수 사용
```

- 하위 모듈(sales, inventory, settlement, accounting, hrm)은 서로를 직접 import 하지 않는다. 조합은 `usecases/`가 맡는다.
- `approval`은 `ApprovalTargetHandler`를 통해서만 업무 모듈을 호출한다(handlers 디렉터리가 어댑터).
- `report`는 쓰기를 하지 않는다.

## 4. 요청 흐름

```
Browser ─▶ Next.js Route Handler /api/trpc ─▶ createContext(세션 쿠키 → user, roles, scopes, requestId, ip)
   ─▶ procedure middlewares: requireAuth → requirePermission → CSRF(origin) → zod
   ─▶ router: usecase/service 호출
        ─▶ withTransaction(ctx): BEGIN
              ├ idempotency.check(scope, requestId) → 있으면 저장된 결과 반환
              ├ service A (tx) ... service B (tx)
              ├ audit.record(tx, ...)  ← redact
              ├ outbox.enqueue(tx, ...)
              └ idempotency.save(tx, result)
           COMMIT
   ─▶ 응답(정밀 숫자는 문자열)
Worker ─▶ outbox.claim(batch) ─▶ dispatcher(email/notification/job) ─▶ done/retry(backoff)/failed
```

## 5. 업무전표 공통 모델

모든 업무전표는 `status ∈ {DRAFT, PENDING_APPROVAL, CONFIRMED, CANCELED}`(INT-02) + 문서별 확장 상태(주문 진행/완료, 이동 IN_TRANSIT)를 가진다. 전이:

```
DRAFT ──submit(결재대상)──▶ PENDING_APPROVAL ──approved──▶ CONFIRMED ──cancel──▶ CANCELED
  │                              │ rejected/withdrawn ▲
  └──confirm(결재면제)──────────────────────────────────┘
DRAFT ──discard──▶ (삭제 허용: 원장 무영향)
```

확정 효과(재고원장·채권채무·회계분개·감사·아웃박스)는 `confirmBusinessDocument`가 한 트랜잭션에서 수행한다. 취소는 `cancelBusinessDocument`가 반대원장·원복·역분개를 같은 트랜잭션에서 만든다.

## 6. 배포 구조

```
GitHub (octo-tim/octo-erp) ─push─▶ GitHub Actions: lint/typecheck/unit/integration(PG service)/build/traceability --check
                                          │ main
                                          ▼
                              Railway 프로젝트
                              ├ web   (Next.js, Dockerfile, `prisma migrate deploy` on release)
                              ├ worker(동일 이미지, `npm run worker`)
                              ├ PostgreSQL (일 1회 백업 + pg_dump 외부 보관 잡)
                              └ 환경: dev / staging / production (환경변수·DB·버킷 분리)
                              객체 저장소: Cloudflare R2 (비공개 버킷)
```

## 7. 성능 전략

- 목록: 서버 페이징(커서 또는 offset+limit ≤ 200), 조회조건별 인덱스, 합계는 별도 집계 쿼리.
- 현재고: `StockSnapshot`(item, warehouse, qty, amount) — 원장 확정 시 같은 트랜잭션에서 upsert, `tools/reconcile-stock.mjs`로 원장 대비 검증·재생성.
- 보고서: SQL 집계(`report` 모듈의 raw query) + 1년 시드 데이터 기준 측정.
