# 트랜잭션·멱등성·취소·아웃박스 계약 (Transaction Contract)

관련 요구사항: INT-02, INT-03, INT-05, INT-06, INT-07, INT-08, INT-09, INT-10, INT-11.

## 1. TransactionContext

```ts
interface TransactionContext {
  tx: Prisma.TransactionClient;  // 반드시 이 클라이언트로만 쓴다
  actor: { userId: string; employeeId?: string; roles: string[]; divisionIds: string[]; warehouseIds: string[]; isAdmin: boolean };
  requestId: string;             // 클라이언트 생성 UUID 또는 서버 생성
  ip?: string;
  now: Date;                     // 시험에서 고정 가능
}
```

- 라우터/유스케이스만 `withTransaction(baseCtx, fn)`을 호출한다. `withTransaction`은 `prisma.$transaction(async tx => fn({...baseCtx, tx}), { isolationLevel: 'ReadCommitted', timeout })`로 한 번 연다.
- 서비스 함수는 `ctx.tx`만 사용한다. 서비스 안에서 `prisma.$transaction`이나 `prisma.<model>`(전역 클라이언트)을 참조하면 lint 규칙(`no-restricted-imports`: `@/server/db` in modules)로 실패한다.
- 트랜잭션 안에서 외부 I/O(SMTP, HTTP, 파일 서명 URL 생성 외의 스토리지 쓰기)는 금지. 첨부 업로드는 트랜잭션 밖에서 저장소에 먼저 쓰고, 트랜잭션 안에서 `Attachment` 행을 만든다(고아 파일은 정리 잡이 삭제).

## 2. 멱등성

- 부작용 쓰기 프로시저의 입력은 `requestId: z.string().uuid()`를 필수로 받는다.
- `IdempotencyRecord(scope, requestId) UNIQUE`, `scope = '<module>.<action>'`. 흐름:
  1. 트랜잭션 시작 직후 `INSERT ... ON CONFLICT DO NOTHING` 시도. 삽입 실패(이미 존재)면 저장된 `responseJson`을 반환(상태 `DONE`) 하거나 `IN_PROGRESS`면 `CONFLICT(REQUEST_IN_PROGRESS)` 오류.
  2. 성공 시 결과를 같은 트랜잭션에서 `responseJson`, `status=DONE`으로 갱신.
  3. 트랜잭션 롤백 시 레코드도 함께 사라지므로 재시도가 가능하다.
- 2차 방어: 원장·분개·채권 등 부작용 테이블에 `(sourceType, sourceId, sourceVersion[, effect])` UNIQUE. 유일성 위반은 `DUPLICATE_EFFECT`로 변환한다.

## 3. 확정 (confirmBusinessDocument)

```
withTransaction:
  idempotency.begin('doc.confirm', requestId)
  doc = lock(SELECT ... FOR UPDATE by id)            // 문서 행 잠금
  assert doc.version == input.version                // 낙관적 동시성
  assert transition(doc.status → CONFIRMED) 허용     // 결재대상이면 PENDING_APPROVAL에서 직접 확정 불가(승인 콜백 경유만)
  period.assertOpen(doc.docDate)                     // 마감 검사(DEC-04)
  effects = effectPlanner(doc)                       // 문서유형별 재고·채권·분개 계획
  inventory.post(ctx, effects.stock)                 // 품목·창고 정렬 순서로 StockSnapshot 행 FOR UPDATE → 마이너스 검사 → 원장 insert → snapshot 갱신
  settlement.post(ctx, effects.receivablePayable)
  accounting.postFromSource(ctx, doc, policy)        // 차대 균형 검사, (sourceType, sourceId, sourceVersion) UNIQUE
  doc.status=CONFIRMED, version+1, confirmedAt
  audit.record(ctx, ...)
  outbox.enqueue(ctx, notifications...)
  idempotency.complete(result)
```

- 실패 시 어떤 단계든 전체 롤백된다. 부분 성공 상태는 존재하지 않는다.
- `PENDING_APPROVAL` 문서의 확정은 오직 `approval` 모듈의 `onApproved` 핸들러가 같은 `ctx`로 `confirmBusinessDocument`를 호출할 때만 허용된다(`ctx.viaApproval = true`).

## 4. 취소 (cancelBusinessDocument)

```
withTransaction:
  idempotency.begin('doc.cancel', requestId)
  doc = lock; assert status == CONFIRMED; period.assertOpen(cancelDate)
  settlement.assertCancelable(doc)                   // 배분된 수금·지급이 있으면 거부(CANCEL_BLOCKED_BY_SETTLEMENT) — 먼저 배분 취소
  inventory.reverse(ctx, doc)                        // 원장 반대행 (reversalOfId 연결), 마이너스 검사 동일 적용
  settlement.reverse(ctx, doc)                       // 채권채무 원복 행
  accounting.reverseFromSource(ctx, doc)             // 역분개 JournalEntry(reversalOfId), 전표일 = 원전표일이 열려있으면 원일, 아니면 취소일
  doc.status=CANCELED, canceledAt, cancelReason, version+1
  audit, outbox, idempotency.complete
```

- 원장·분개·채권 행은 삭제·수정하지 않는다(DB 트리거가 DELETE/UPDATE 거부).
- 결재 완료 문서의 취소는 `ApprovalDocument`를 수정하지 않고 별도 취소 문서(`CANCEL` targetType)로 결재를 거친 뒤 콜백에서 위 유스케이스를 호출한다(APV-12).

## 5. 승인 콜백 (ApprovalTargetHandler)

```ts
interface ApprovalTargetHandler {
  targetType: string;
  validateBeforeSubmit(ctx, target): Promise<void>;   // 상신 시점 검증(잠금·상태·금액)
  onApproved(ctx, target, doc): Promise<void>;         // 같은 tx. 예: confirmBusinessDocument / leave.apply / purchaseRequest.markApproved
  onRejected(ctx, target, doc): Promise<void>;         // 예: 전표 PENDING_APPROVAL → DRAFT
  onCanceled(ctx, target, doc): Promise<void>;         // 취소문서 승인 시
}
```
- `ApprovalLink(targetType, targetId, targetVersion) UNIQUE` — 같은 버전의 문서는 한 번만 상신된다.
- 승인 처리: `ApprovalStep` 행을 `FOR UPDATE`로 잠그고 `(documentId, stepNo, action, requestId)` 유일성으로 중복 승인을 차단. 문서 `version`으로 동시 승인·반려 충돌을 감지.
- 마지막 단계 승인 시 같은 트랜잭션에서 `onApproved`. 핸들러 실패는 결재 승인도 롤백한다.

## 6. 동시성·잠금

- 재고: 영향받는 `(itemId, warehouseId)` 쌍을 정렬한 뒤 `StockSnapshot` 행을 순서대로 `SELECT ... FOR UPDATE`(없으면 `INSERT ... ON CONFLICT DO NOTHING` 후 재잠금). 이후 원장 삽입과 수량 검사. 이 순서를 지키면 교착이 줄고, 남는 교착(40P01)은 유스케이스 레벨에서 최대 3회 재시도.
- 문서 부분전환·수금배분: 원천 라인/채권 행 `FOR UPDATE` 후 잔여 검사.
- 채번: `NumberingRule` 행 `FOR UPDATE` + `(ruleId, periodKey, seq)` UNIQUE.
- 회계기간 마감: `AccountingPeriod` 행 잠금 후 상태 변경, 확정 유스케이스는 기간 행을 `FOR SHARE`로 읽어 마감과 확정이 교차하지 않게 한다.

## 7. 감사로그

- `audit.record(ctx, { action, entityType, entityId, before, after, meta })`를 업무 변경과 같은 tx에서 호출.
- `redact()`: 키 denylist(`password`, `passwordHash`, `token`, `sessionId`, `residentNo`, `residentNoEnc`, `bankAccount`, `bankAccountEnc`, `secret`, `apiKey`, `authorization`, `cookie`)는 값 제거, 이메일·전화는 부분 마스킹. 깊은 객체 재귀 적용.
- 실패한 트랜잭션의 감사로그는 남지 않는다(같은 tx). 보안 이벤트(로그인 실패·잠금)는 별도 `SecurityEvent`로 트랜잭션 밖에서 기록한다(실패 자체가 기록 대상이므로).

## 8. 아웃박스

- `OutboxEvent(topic, payload, status: PENDING|PROCESSING|DONE|FAILED, attempt, nextAttemptAt, lastError, dedupKey UNIQUE(topic, dedupKey), lockedBy, lockedAt)`.
- 워커: `UPDATE ... SET status=PROCESSING, lockedBy, lockedAt WHERE id IN (SELECT id ... WHERE status=PENDING AND nextAttemptAt<=now() FOR UPDATE SKIP LOCKED LIMIT n)`.
- 처리 성공 → DONE. 실패 → attempt+1, 백오프(1m,5m,30m,2h,12h), 5회 초과 → FAILED + 관리자 Notification. 잠금 10분 초과 항목은 회수.
- 핸들러 종류: `email.send`, `notification.push`(앱 내 알림 생성·이미 tx 내에서 생성된 경우 생략), `messenger.send`(NONE), `job.*`.
- 시험: DB 롤백 시 아웃박스도 없음, 커밋 후 SMTP 실패 시 재시도만 발생.
