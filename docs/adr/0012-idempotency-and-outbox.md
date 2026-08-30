# ADR-0012 멱등성 키와 트랜잭셔널 아웃박스 (INT-05, INT-10, INT-11)

- 상태: Accepted (2026-08-30)

## 결정
클라이언트가 UUID requestId를 생성해 부작용 mutation에 전달. `IdempotencyRecord(scope, requestId)` UNIQUE + 응답 저장. 부작용 테이블은 `(sourceType, sourceId, sourceVersion)` UNIQUE. 외부 부작용은 OutboxEvent(같은 tx)와 워커(`FOR UPDATE SKIP LOCKED`). 자세한 계약은 docs/transaction-contract.md.
