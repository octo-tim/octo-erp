# ADR-0011 정밀 숫자 계약 (INT-01)

- 상태: Accepted (2026-08-30)

## 결정
DB `Decimal(18,3)` 수량, `Decimal(18,0)` 금액(KRW), `Decimal(18,4)` 단가. API는 문자열. 앱은 decimal.js. zod `decimalString` 스키마로 형식·자릿수 검증. lint 규칙으로 `parseFloat`/`Number(` 금액 사용 차단(`no-restricted-syntax`).
