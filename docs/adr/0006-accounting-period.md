# ADR-0006 회계기간·전표일·역분개 (DEC-04)

- 상태: Provisionally Accepted (2026-08-30)

## 결정
AccountingPeriod = 달력 월(`periodKey` 'YYYY-MM', status OPEN|CLOSED). 업무전표·회계전표의 생성·확정·취소는 전표일이 속한 기간이 OPEN이어야 한다. 마감 해제는 `period.reopen` 권한 + 사유, 감사로그. 역분개 전표일: 원전표일 기간이 OPEN이면 원전표일, CLOSED면 취소 시점 기준 최초 OPEN 기간의 첫날. 손익 마감은 연말(12월 마감 시) 손익계정 잔액을 이익잉여금으로 대체하는 마감분개를 생성하고, 재무상태 계정은 다음 기간 기초잔액으로 이월한다.
