# 보안 모델 (Security Model)

관련: NFR-SEC-01~08, INT-09, INT-12, HRM-12, UIX-07, DEC-06, DEC-07.

## 1. 인증

- 비밀번호: Node `crypto.scrypt`(N=2^15, r=8, p=1, 32B salt, 64B key), 상수시간 비교. 정책: 10자 이상, 영문·숫자·특수 중 2종.
- 세션: `Session(id(불투명 256bit), userId, expiresAt, lastSeenAt, ip, userAgent, revokedAt)`. 쿠키 `erp_session` = `Secure; HttpOnly; SameSite=Lax; Path=/`. 절대만료 12시간, 유휴만료 2시간(슬라이딩). 로그인·비밀번호 변경 시 세션 ID 회전(기존 폐기). 로그아웃·관리자 강제 종료·계정 비활성 시 폐기.
- 로그인 실패: `LoginAttempt`로 사용자별 연속 실패 5회 → `User.lockedUntil` 설정(잠금). 관리자 `auth.unlock`으로 해제. 실패·잠금·해제·초기화는 `SecurityEvent`에 기록.
- 비밀번호 초기화: 관리자가 임시 비밀번호 발급(`mustChangePassword=true`), 다음 로그인 시 변경 강제.
- HTTPS: Railway 종단 TLS. 앱은 `x-forwarded-proto`로 HTTP를 거부(운영).

## 2. CSRF·XSS·삽입

- 모든 mutation(tRPC mutation, Route Handler POST)은 `Origin`/`Sec-Fetch-Site` 헤더가 허용 목록(`APP_ORIGIN`)과 일치해야 한다. 불일치 시 403. `SameSite=Lax` 쿠키가 2차 방어.
- XSS: React 기본 이스케이프, `dangerouslySetInnerHTML` 금지(lint), CSP 헤더(`default-src 'self'`; 인라인 스크립트 nonce), 첨부 미리보기는 별도 서명 URL·`Content-Disposition`·`X-Content-Type-Options: nosniff`.
- SQL: Prisma 파라미터 바인딩. raw query는 `Prisma.sql` 태그드 템플릿만 허용(문자열 결합 금지, lint).
- 의존성: CI에서 `npm audit --audit-level=high` 실패 시 차단.

## 3. 권한 (RBAC + 데이터 범위)

- `Permission` 문자열 `module.action` (예: `sales.read`, `sales.write`, `sales.confirm`, `sales.cancel`, `sales.export`, `hr.sensitive.read`, `period.reopen`, `admin.users`).
- `Role`(admin, manager, sales, purchasing, inventory, accounting, hr, viewer 시드) ↔ `RolePermission`, `User` ↔ `UserRole`. admin은 모든 권한 + 데이터 범위 전체.
- 데이터 범위: `UserDivisionScope(userId, divisionId)`, `UserWarehouseScope(userId, warehouseId)`. 범위가 비어 있으면 아무것도 볼 수 없다(기본 거부). 인사 범위: `hr.read`(전 직원), `hr.self`(본인만, 모든 사용자 기본), `hr.sensitive.read`(주민번호·계좌 복호화, 사유 필수).
- 적용 지점: tRPC 미들웨어 `requirePermission` → 서비스 조회 함수가 `scopeFilter(actor)`를 where에 결합 → 상세/수정/삭제/내보내기/다운로드는 대상 행의 divisionId·warehouseId·employeeId를 검사. 첨부 다운로드는 소유 엔티티의 권한을 재검사.
- 화면 메뉴는 `permissions` 클레임으로 숨기지만, 서버는 항상 재검사한다.

## 4. 민감정보 (HRM-12, NFR-SEC-06)

- `EmployeeSensitive(employeeId, residentNoEnc, bankAccountEnc, bankName, keyVersion)` 별도 테이블. 값은 AES-256-GCM(`DATA_ENCRYPTION_KEY`, 환경변수/시크릿 매니저, DB에 없음), `keyVersion`으로 키 회전 지원.
- 조회 기본은 마스킹(`900101-1******`, `110-***-**1234`). 복호화는 `hr.sensitive.read` + `reason` 필수 + `SensitiveAccessLog(actor, employeeId, field, reason, ip, at)` 기록 후 반환. 감사로그·앱 로그·오류·엑셀·PDF에는 원문이 흐르지 않는다(redact 및 내보내기 마스킹).
- 검색은 암호문에 대해 불가하므로 사번·성명으로만 검색한다.
- 파기(DEC-06, NFR-SEC-08): `RetentionPolicy` 항목별 보유기간, `jobs/retention.ts`가 도래 항목을 식별→승인 요청→실행(암호문 null 처리·익명화)→`RetentionRun` 결과 기록.

## 5. 첨부파일 (NFR-SEC-07, UIX-07)

- 업로드: 크기 ≤ 20MB, MIME 허용목록(pdf, png, jpg, xlsx, docx, hwp, zip 등) + 매직바이트 검사, 원본명은 DB에만, 저장키는 `{ownerType}/{yyyy}/{mm}/{uuid}`.
- 저장: 비공개 버킷(S3 호환) 또는 로컬 `storage/`(dev/test). 공개 URL 없음.
- 다운로드: 소유 엔티티 권한 검사 후 만료 5분 서명 URL(S3 presign / 로컬은 HMAC 서명 토큰 엔드포인트).
- 삭제: 소유 엔티티 취소·파기 정책에 따름. 고아 파일 정리 잡.

## 6. 감사·로그

- `AuditLog`: actor, action, entityType, entityId, before, after(redacted JSON), ip, requestId, createdAt. 업무 변경과 같은 tx. 삭제 불가.
- 앱 로그: pino JSON, `redact` 경로 설정(`req.headers.cookie`, `*.password`, `*.residentNo` ...). 요청ID를 모든 로그에 전파.
- `SecurityEvent`: 로그인 실패·잠금·해제·권한 거부(403)·민감정보 접근.

## 7. 운영 비밀값

- `.env`는 커밋하지 않는다. `src/server/env.ts`가 zod로 필수 키를 검증하며 누락 시 부팅 실패.
- 환경별(dev/staging/prod) DB·버킷·키 분리. 운영 DB 접근은 Railway 콘솔 권한자만.
