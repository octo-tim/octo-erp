# ADR-0005 전표별 결재 정책 매트릭스 (DEC-03)

- 상태: Provisionally Accepted (2026-08-30)

## 결정
`PolicyVersion('approval.matrix')` config: `[{docType, mode: REQUIRED|OPTIONAL|EXEMPT, minAmount?}]`. 초기값 — SALES: EXEMPT, PURCHASE: REQUIRED ≥ 3,000,000, PURCHASE_REQUEST: REQUIRED, STOCK_MANUAL(수동 입출고·조정): REQUIRED ≥ 1,000,000, JOURNAL(수동 회계전표): REQUIRED ≥ 5,000,000, QUOTATION/ORDER/RETURN/RECEIPT/PAYMENT: EXEMPT. 여신한도 초과 매출: BLOCK(설정으로 WARN 전환).

## 결과
`approvalPolicy.resolve(doc)`가 REQUIRED이면 `submit`만 허용(PENDING_APPROVAL), 직접 confirm은 거부. OPTIONAL은 사용자가 선택. EXEMPT는 confirm 직접 허용.
