# octo-erp — (주)옥토웍스 경영관리 시스템

RFP `docs/source/ERP_RFP_v0.3.md`를 구현한 자체 ERP. 기초정보·매출/매입·발주·재고·회계·전자결재·인사·보고서 8개 모듈.

## 문서

| 문서 | 내용 |
|---|---|
| `AGENTS.md` | 저장소 작업 규칙 (개발 시작 전 필독) |
| `docs/engineering-rules.md` | 불변조건과 품질 게이트 |
| `docs/requirements-traceability.md` | 요구사항 ID별 구현·시험 증적 (생성물) |
| `docs/decision-register.md` | DEC-01~09 정책 결정 |
| `docs/architecture.md` | 모듈 경계·요청 흐름·배포 |
| `docs/transaction-contract.md` | 트랜잭션·멱등성·취소·아웃박스 계약 |
| `docs/security-model.md` | 인증·RBAC·민감정보·첨부 보안 |
| `docs/acceptance-scenarios.md` | 핵심 E2E와 경계시험 |
| `docs/adr/` | 아키텍처 결정 기록 |

## 실행

```bash
cp .env.example .env          # DATABASE_URL, SESSION_SECRET, DATA_ENCRYPTION_KEY 설정
npm install
npm run db:migrate            # 개발 DB 마이그레이션
npm run db:seed               # 권한·역할·정책·채번규칙·관리자 계정
npm run dev                   # http://localhost:3000  (admin / Admin!2345 — 최초 로그인 시 변경 필요)
npm run worker                # 별도 터미널: 아웃박스 워커
```

`DATA_ENCRYPTION_KEY`는 32바이트 hex: `openssl rand -hex 32`
`SESSION_SECRET`은 32자 이상: `openssl rand -base64 32`

## 검증

```bash
npm run check                 # format:check + lint + typecheck + unit
npm run test:integration      # 실제 PostgreSQL (DATABASE_URL_TEST) — 모킹 없음
npm run test:e2e              # Playwright (1440 / 1024 / 390px)
npm run build
npm run traceability          # 추적표 재생성
```

## 배포

Railway 컨테이너 배포. `Dockerfile` 하나로 web과 worker를 띄우고, 릴리스 시 `prisma migrate deploy`를 실행한다. 상태점검은 `/api/health`.

## 진행 상태

STEP 0~2 완료 (요구사항 기준선, 아키텍처 헌장, 기반 인프라·인증·권한·감사·멱등성·아웃박스·첨부). 이후 단계는 `docs/source/ERP_prompt_pack_v1.0.md` 순서를 따른다.
