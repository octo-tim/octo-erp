# 시험계획서 및 결과서

대상: (주)옥토웍스 자체 ERP `octo-erp` · 기준 요구사항 `docs/source/ERP_RFP_v0.3.md` (143건) · 작성 2026-08-31

## 1. 시험 전략

시험은 네 층으로 나누어 두었고, 각 층이 무엇을 증명하고 무엇은 증명하지 못하는지를 분명히 해 두었다. 어떤 층도 다른 층을 대신하지 않는다.

**단위시험**은 순수 계산과 규칙을 다룬다. 금액·수량의 정밀 연산, 부가세 반올림, 재고 이동평균 산식, 휴가 부여 규칙, 상태 전이표, 마스킹, 환경변수 검증이 여기에 속한다. 데이터베이스를 쓰지 않으므로 빠르고, 대신 여러 모듈이 함께 움직일 때 생기는 문제는 잡지 못한다.

**통합시험**은 실제 PostgreSQL을 상대로 수행한다. 모킹을 금지한 것이 이 층의 핵심이다. 트랜잭션 경계, 동시성, 유니크 제약, 트리거, 잠금 순서 같은 것들은 데이터베이스가 실제로 있어야만 드러나고, 모킹된 데이터베이스는 정확히 그 문제들을 숨긴다. 서비스는 라우터가 여는 트랜잭션 하나 안에서 호출되므로, 시험도 같은 방식으로 `runTx`를 통해 호출한다.

**E2E 시험**은 빌드된 애플리케이션을 브라우저로 조작한다. 화면에서 실제로 도달할 수 있는지를 확인하는 유일한 층이다. STEP 13 감사에서 드러났듯이, 서버 기능이 있고 통합시험이 통과해도 화면에서 부를 수 없으면 요구사항은 충족되지 않는다. 데스크톱 1440, 태블릿 1024, 모바일 390의 세 화면폭에서 같은 시험을 수행한다.

**성능시험**은 1년치 분포의 실데이터를 채운 뒤 측정한다. 빈 데이터베이스에서 잰 응답시간은 아무것도 말해주지 않기 때문이다.

## 2. 시험 환경

| 항목 | 값 |
|---|---|
| 런타임 | Node.js 22, Next.js 15.5.24, React 19 |
| 데이터베이스 | PostgreSQL 16 (통합시험은 `DATABASE_URL_TEST` 전용 DB) |
| 단위·통합 러너 | Vitest 4 (프로젝트 분리, 통합은 파일 병렬 비활성) |
| E2E 러너 | Playwright, Chromium, 3개 화면폭 |
| CI | GitHub Actions — 형식·린트·타입·단위·통합·빌드·E2E·추적표·문서·의존성 취약점 |

통합시험은 실행 시작 시 마이그레이션과 시드를 적용하고, 각 시험 앞에서 업무 데이터를 절단한다. 시드 참조 데이터(역할·권한·정책·채번규칙)는 유지한다.

## 3. 시험 범위와 요구사항 대응

전체 대응은 `docs/requirements-traceability.md`가 요구사항 143건마다 화면·API·서비스·테이블·자동시험·수동검수를 나열한다. 이 문서는 시험 파일 쪽에서 본 목록이다.

### 단위시험 (15개 파일, 145건)

| 파일 | 대응 요구사항 |
|---|---|
| `money.test.ts` | INT-01, DEC-02 — 정밀 금액, 부가세 반올림 |
| `sales-pricing.test.ts` | SLS 라인 금액 계산 |
| `inventory-valuation.test.ts` | INV 이동평균 |
| `accounting-journal.test.ts` | ACC 차대 균형 |
| `state-machine.test.ts` | INT-02, INT-03 — 상태 전이와 확정 후 수정 금지 |
| `leave-policy.test.ts` | HRM-05, HRM-07, DEC-05 |
| `master-validation.test.ts` | BAS-01, BAS-04 — 바코드, 사업자번호 체크섬 |
| `crypto.test.ts` | NFR-SEC-03, NFR-SEC-06 |
| `redact.test.ts` | INT-09, NFR-SEC-06 — 마스킹과 로그 비식별 |
| `dates.test.ts` | NFR-UX-01, DEC-04 |
| `env.test.ts` | NFR-OPS-01 — 운영 기본 비밀값 거부 |
| `docs.test.ts` | NFR-OPS-06 — 생성 문서와 소스의 일치 |
| `item-match.test.ts`, `report-filter.test.ts`, `report-export.test.ts` | 품목 해석, 보고서 필터·내보내기 |

### 통합시험 (16개 파일, 661건)

| 파일 | 대응 요구사항 |
|---|---|
| `master.test.ts` | BAS-01~09, INT-11, INT-12, B-10 |
| `sales.test.ts` | SLS-01~13, INT-05~07, INT-12, E2E-01·02·04, B-01 |
| `inventory.test.ts` | INV-01~09, INT-04~08, INT-12, B-11 |
| `accounting.test.ts` | ACC-01~09, INT-05, INT-07, INT-12, DEC-04, B-01 |
| `approval.test.ts` | APV-01~15, INT-05, INT-06, B-07, B-08, E2E-03 |
| `hrm.test.ts` | HRM-01~13, NFR-SEC-02, NFR-SEC-06, B-15 |
| `report.test.ts` | RPT-01~10, INT-04, INT-12 |
| `migration.test.ts` | MIG-01~09, NFR-SEC-05, NFR-SEC-06 |
| `integration.test.ts` | STEP 10 결합 — APV-08·09·12, SLS·INV·ACC 연결 |
| `transaction.test.ts` | INT-05, INT-06, INT-09~11, B-03, B-08, B-09 |
| `permissions.test.ts` | NFR-SEC-01, NFR-SEC-02, INT-12 — 권한 매트릭스 전수 호출 |
| `rbac.test.ts` | NFR-SEC-01, NFR-SEC-02, INT-12, B-02 |
| `storage.test.ts` | NFR-SEC-07, UIX-07 |
| `auth.test.ts` | NFR-SEC-03, NFR-SEC-04, INT-09, B-13, B-14 |
| `regression.test.ts` | STEP 13 감사에서 드러난 결함 — NFR-SEC-08, HRM-08·09·13, APV-07·11, INT-10, SLS-04 |
| `performance.test.ts` | NFR-PERF-01~03 |

### E2E (11개 파일 × 3 화면폭)

RFP 8장 인수 시나리오 E2E-01~04와 경계 시나리오 B-01~B-15는 통합시험과 E2E에 나누어 배치했다. 상태 조작이 필요한 경계 시나리오는 통합시험에서, 화면 도달 가능성이 요점인 것은 E2E에서 확인한다.

## 4. 권한 매트릭스 전수 호출시험

STEP 13이 요구한 전수 시험은 `tests/integration/permissions.test.ts`가 수행한다. 프로시저 목록을 하드코딩하지 않고 실행 시점에 라우터에서 열거하는 것이 요점이다. 목록을 적어 두면 나중에 추가된 프로시저가 조용히 시험 밖으로 빠지고, 그것이 바로 이 요구사항이 막으려는 상황이기 때문이다.

| 항목 | 결과 |
|---|---|
| 열거된 프로시저 | 244건 (라우터 정적 파싱 결과와 1:1 대조) |
| 권한 게이트가 걸린 프로시저 | 222건 — 각각 권한 없는 사용자가 거부되는지 개별 확인 |
| 인증만 필요 / 공개 | 21건 / 1건 — 권한 오류가 나지 *않는* 것을 확인 |
| 데이터 범위 | 사업부·창고·인사 각각 대표 프로시저에서 `OUT_OF_SCOPE` 확인 |

권한 검사가 입력 파싱보다 먼저 수행된다는 전제는 `src/server/api/trpc.ts`의 미들웨어 순서를 실제로 확인한 뒤 시험에 반영했다.

## 5. 시험 결과

2026-08-31 기준, 마지막 전체 수행 결과다.

| 층 | 파일 | 건수 | 결과 |
|---|---|---|---|
| 단위 | 15 | 145 | 전건 통과 |
| 통합 | 16 | 661 | 전건 통과 |
| E2E | 11 × 3 화면폭 | 495 중 469 수행, 26건은 화면폭 조건부 제외 | 전건 통과 |
| 성능 | 1 | 14 | 전건 통과 |

### 성능 측정값 (NFR-PERF-01~03)

1년치 분포로 생성한 데이터에서 측정한 실제 소요 시간이다. 목표 대비 여유가 크다.

| 요구사항 | 목표 | 측정 | 내용 |
|---|---|---|---|
| NFR-PERF-01 | 2초 | 152ms | 1만 건 이상 목록 조회 |
| NFR-PERF-01 | 2초 | 130ms | 조건을 건 목록 조회 |
| NFR-PERF-01 | 2초 | 108ms | 마지막 페이지로 건너뛰기 |
| NFR-PERF-02 | 1초 | 75ms | 전표 저장 |
| NFR-PERF-02 | 1초 | 529ms | 전표 확정 — 재고·채권·분개를 한 트랜잭션에서 |
| NFR-PERF-03 | 5초 | 235ms | 1년 매출현황 집계 |
| NFR-PERF-03 | 5초 | 582ms | 일 단위 1년 집계 |
| NFR-PERF-03 | 5초 | 144ms | 품목순위 1년 집계 |
| NFR-PERF-03 | 5초 | 88ms | 거래처실적 (전년동기 비교 포함) |
| NFR-PERF-03 | 5초 | 844ms | 재고현황 집계 |
| NFR-PERF-03 | 5초 | 160ms | 대시보드 |

NFR-PERF-04(동시 사용자)는 목표 동시 사용자 수가 확정되지 않아 측정하지 못했다. BLOCKED로 기록했다.

### 의존성 취약점 점검 (NFR-SEC-05)

`npm run audit:check`가 `npm audit` 결과를 `docs/security-advisories.json` 기준선과 대조한다. 기준선에 없는 high 이상 취약점이 나오면 CI가 실패한다. 예전에는 `continue-on-error`가 붙어 있어 결과로 아무 일도 일어나지 않았다 — 검사는 하지만 아무도 막지 않는 상태였다.

현재 상태: 새 취약점 0건. 기록된 예외 2건(postcss, deepmerge-ts)은 모두 빌드 시점에만 실행되고 신뢰할 수 없는 입력이 닿지 않는 경로이며, 사유·해소 조건·재검토일(2026-11-30)과 함께 기록했다. 사용하지 않으면서 취약점만 안고 있던 `exceljs`는 제거했다.

## 6. 알려진 제한

| ID | 항목 | 상태 | 사유 |
|---|---|---|---|
| NFR-OPS-03 | 백업 | BLOCKED | 자동 백업 작업 미구현. 절차는 문서화했으나 스케줄러·보존주기·암호화·실패알림은 배포 환경 설정 필요. **운영 전환 차단** |
| NFR-OPS-04 | 복구 | BLOCKED | 스테이징 복구시험 미수행. RPO·RTO는 목표값일 뿐 측정값이 아님. **운영 전환 차단** |
| NFR-OPS-07 | 브라우저 지원 | BLOCKED | Chromium 3개 화면폭은 수행. Edge·Safari 실브라우저 검증은 단말 미확보 |
| NFR-PERF-04 | 동시 사용자 | BLOCKED | 목표 동시 사용자 수 미확정 |

선택 요구사항 6건(BAS-05, INV-10, APV-16, HRM-14, RPT-11, UIX-09)은 승인되지 않아 구현하지 않았다. 승인 여부와 구현 상태를 분리해 `OPTION_NOT_APPROVED`로 표시했다.

## 7. 자동시험 없이 수동 확인만 한 항목

STEP 13 판정 규칙이 별도 표시를 요구한다. 추적표에서 `⚠ 수동확인만`으로 표시된다: DEC-01, DEC-05, DEC-06, DEC-08(정책 기본안 채택 — 시드 데이터로 확인), NFR-OPS-02(CI/CD — 워크플로 자체가 증거), 그리고 위 BLOCKED 4건.

## 8. 시험 수행 방법

```
npm run check            # 형식·린트·타입·단위
npm run test:integration # 통합 (PostgreSQL 필요)
npm run build && npm run serve && npm run test:e2e
npm run traceability:check && npm run docs:check && npm run audit:check
```

E2E는 반드시 빌드 후 `npm run serve`로 서버를 새로 띄운 뒤 수행한다. 예전 서버가 살아 있으면 삭제된 청크를 계속 내려보내 화면이 통째로 깨지고, 그 실패는 원인을 오해하기 쉽다.
