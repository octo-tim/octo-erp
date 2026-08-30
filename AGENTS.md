# AGENTS.md — 이 저장소에서 작업하는 모든 에이전트·개발자를 위한 규칙

## 반드시 먼저 읽을 것
1. `docs/engineering-rules.md` — 불변조건과 품질 게이트 (필독)
2. `docs/requirements-traceability.md` — 이번 작업 대상 요구사항 ID와 현재 상태
3. `docs/decision-register.md` — 승인된 정책(DEC-01~09)과 미확정 사항
4. `docs/architecture.md`, `docs/transaction-contract.md`, `docs/security-model.md`

## 작업 절차
- 시작 시 대상 요구사항 ID를 선언하고 구현 계획을 10줄 이내로 적는다.
- 미확정 DEC·파괴적 변경·범위 증가가 있으면 구현하지 말고 질문과 추천안을 제시한 뒤 멈춘다.
- 라우터는 인증·권한·검증·유스케이스 호출만. 규칙은 서비스에.
- 변경 후 `npm run check`(format, lint, typecheck, unit) + `npm run test:integration` + `npm run build`. UI면 E2E와 뷰포트 확인.
- 완료 ID마다 `docs/traceability-state.json`에 구현 파일·시험·수동확인을 연결하고 `node tools/traceability.mjs`를 실행한다.
- 실패를 숨기거나 시험을 삭제·완화하지 않는다.
- 새로 발견한 요구사항은 `__changeRequests`에 기록하고 구현하지 않는다.

## 절대 하지 말 것
- 금액·수량에 float 사용
- 하위 서비스에서 트랜잭션 새로 열기
- 원장(InventoryLedger, JournalLine, LeaveLedger, AuditLog 등) 행 삭제·수정
- 서비스 코드에서 SMTP/HTTP 직접 호출 (아웃박스 사용)
- 화면 권한만 믿고 서버 권한 생략
- 감사로그·애플리케이션 로그에 비밀번호·세션·주민번호·계좌번호 원문 기록

## 로컬 실행
```
cp .env.example .env            # DATABASE_URL 등 설정
npm install
npm run db:migrate && npm run db:seed
npm run dev                      # http://localhost:3000  (admin / Admin!2345)
npm run worker                   # 아웃박스 워커
```
