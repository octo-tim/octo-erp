# ADR-0010 알림 채널 (DEC-09)

- 상태: Provisionally Accepted (2026-08-30)

## 결정
앱 내 Notification + 이메일(SMTP). 메신저는 `MessengerAdapter` 인터페이스만 두고 `NONE`. 모든 발송은 OutboxEvent 경유, 지수 백오프 5회(1m,5m,30m,2h,12h) 후 FAILED, 실패작업 화면에서 수동 재시도. 장기미결 기준 3영업일.
