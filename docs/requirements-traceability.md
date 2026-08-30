# 요구사항 추적표 (Requirements Traceability Matrix)

> 생성: `node tools/traceability.mjs` — 원본은 `docs/requirements.json`(기준선)과 `docs/traceability-state.json`(증적). 이 파일을 직접 편집하지 않는다.

기준 문서: docs/source/ERP_RFP_v0.3.md · 생성 시각: 2026-08-30T16:30:25.848Z

## 집계

| 모듈 | M | O | 합계 | DONE | IN_PROGRESS | NOT_VERIFIED | BLOCKED | NOT_STARTED | OPTION_NOT_APPROVED |
|---|---|---|---|---|---|---|---|---|---|
| BAS 기초정보 | 8 | 1 | 9 | 0 | 1 | 0 | 0 | 7 | 1 |
| SLS 매출·매입·발주 | 13 | 0 | 13 | 0 | 0 | 0 | 0 | 13 | 0 |
| INV 재고 | 9 | 1 | 10 | 0 | 0 | 0 | 0 | 9 | 1 |
| ACC 회계 | 9 | 0 | 9 | 0 | 0 | 0 | 0 | 9 | 0 |
| APV 전자결재 | 15 | 1 | 16 | 0 | 0 | 0 | 0 | 15 | 1 |
| HRM 인사 | 13 | 1 | 14 | 0 | 0 | 0 | 0 | 13 | 1 |
| RPT 보고서 | 10 | 1 | 11 | 0 | 0 | 0 | 0 | 10 | 1 |
| UIX 공통 UI | 8 | 1 | 9 | 7 | 1 | 0 | 0 | 0 | 1 |
| INT 공통 데이터 정합성 | 12 | 0 | 12 | 5 | 4 | 0 | 0 | 3 | 0 |
| NFR 비기능 | 22 | 0 | 22 | 7 | 7 | 0 | 0 | 8 | 0 |
| MIG 데이터 이관 | 9 | 0 | 9 | 0 | 0 | 0 | 0 | 9 | 0 |
| DEC 착수 시 확정 정책 | 0 | 0 | 9 | 9 | 0 | 0 | 0 | 0 | 0 |
| **합계** | **128** | **6** | **143** | 28 | 13 | 0 | 0 | 96 | 6 |

기능 요구사항(BAS·SLS·INV·ACC·APV·HRM·RPT·UIX): M 85개, O 6개 (RFP 5장 선언: 필수 85 / 선택 6).

## BAS — 기초정보

| ID | 중요도 | 요구사항 | 구현 화면 | API/라우터 | 서비스 | 테이블 | 자동시험 | 수동검수 | 상태 | 비고 |
|---|---|---|---|---|---|---|---|---|---|---|
| BAS-01 | M | **품목 관리** — 코드 자동채번, 품목명, 규격, 단위, 3단 분류, 입·출고단가, 과세구분, 바코드, 사용여부 | — | — | — | — | — | — | NOT_STARTED | — |
| BAS-02 | M | **품목 부가정보** — 안전재고, 리드타임, 기본 매입처, 대표 이미지, 비고 | — | — | — | — | — | — | NOT_STARTED | — |
| BAS-03 | M | **품목 대량 처리** — 양식 다운로드, 일괄 등록·수정, 행별 오류 표시, 정상 행만 선택 반영 | — | — | — | — | — | — | NOT_STARTED | — |
| BAS-04 | M | **거래처 관리** — 사업자번호 검증, 대표자, 업태·종목, 주소, 담당자 다건, 거래유형, 결제조건, 여신한도 | — | — | — | — | — | — | NOT_STARTED | — |
| BAS-05 | O | **거래처별 단가** — 거래처-품목 단가표와 전표 입력 시 자동 적용 | — | — | — | — | — | — | OPTION_NOT_APPROVED | 선택 요구사항. PartnerItemPrice 확장 포인트만 예약 |
| BAS-06 | M | **창고 관리** — 정상·불량·위탁 유형, 담당자, 사용여부 | — | — | — | — | — | — | NOT_STARTED | — |
| BAS-07 | M | **공통코드** — 단위·품목분류·사업부·결제수단 등을 관리자가 유지 | — | — | — | — | — | — | NOT_STARTED | — |
| BAS-08 | M | **변경 이력** — 변경자·시각·변경 전후 값 조회, 민감정보 원문은 감사로그 미저장 | — | `src/server/api/routers/admin.ts (auditLog)` | `src/server/modules/audit/service.ts` | — | `tests/integration/transaction.test.ts` | — | IN_PROGRESS | 변경 전후 이력 조회 기반 완료. 마스터 화면 연결은 STEP 6 |
| BAS-09 | M | **삭제 정책** — 사용된 마스터 물리삭제 금지, 사용중지 처리 | — | — | — | — | — | — | NOT_STARTED | — |

## SLS — 매출·매입·발주

| ID | 중요도 | 요구사항 | 구현 화면 | API/라우터 | 서비스 | 테이블 | 자동시험 | 수동검수 | 상태 | 비고 |
|---|---|---|---|---|---|---|---|---|---|---|
| SLS-01 | M | **견적서** — 등록·수정·복사, 유효기간, 다건 라인, 금액 자동계산, PDF 출력 | — | — | — | — | — | — | NOT_STARTED | — |
| SLS-02 | M | **견적→주문** — 부분 전환·수량 조정·원 견적 연결·잔여수량 관리 | — | — | — | — | — | — | NOT_STARTED | — |
| SLS-03 | M | **주문서** — 납기일, 접수·진행·완료·취소 상태, 잔여수량 | — | — | — | — | — | — | NOT_STARTED | — |
| SLS-04 | M | **주문→매출전표** — 분할 출고에 따른 복수 전표, 원 주문 연결 | — | — | — | — | — | — | NOT_STARTED | — |
| SLS-05 | M | **매출전표** — 거래처·창고·품목·수량·단가·공급가·세액·과세구분·사업부 | — | — | — | — | — | — | NOT_STARTED | — |
| SLS-06 | M | **매입전표** — 매입처·입고창고·품목라인·금액·과세구분·사업부 | — | — | — | — | — | — | NOT_STARTED | — |
| SLS-07 | M | **세금계산서 양식** — 국세청 표준 서식에 준하는 사내용 PDF 생성 및 이메일 발송 | — | — | — | — | — | — | NOT_STARTED | — |
| SLS-08 | M | **미수금** — 거래처별 잔액, 30/60/90일 연령분석, 여신한도 경고·차단 설정 | — | — | — | — | — | — | NOT_STARTED | — |
| SLS-09 | M | **미지급금** — 매입처별 잔액과 결제예정일 조회 | — | — | — | — | — | — | NOT_STARTED | — |
| SLS-10 | M | **수금·지급** — 입출금 등록, 오래된 미결부터 자동 소진, 수동 재배분, 부분 소진 | — | — | — | — | — | — | NOT_STARTED | — |
| SLS-11 | M | **반품·에누리** — 음수 수량 대신 별도 문서유형, 재고·채권채무·회계 원복 | — | — | — | — | — | — | NOT_STARTED | — |
| SLS-12 | M | **전표 마감** — 마감기간 생성·수정·삭제·확정 차단, 권한자만 해제 | — | — | — | — | — | — | NOT_STARTED | — |
| SLS-13 | M | **구매요청→발주** — 승인된 구매요청에서 발주서 생성, 부분 발주·잔여수량·매입전표 연결 | — | — | — | — | — | — | NOT_STARTED | — |

## INV — 재고

| ID | 중요도 | 요구사항 | 구현 화면 | API/라우터 | 서비스 | 테이블 | 자동시험 | 수동검수 | 상태 | 비고 |
|---|---|---|---|---|---|---|---|---|---|---|
| INV-01 | M | **입고** — 매입 연동 및 사유가 있는 수동 입고 | — | — | — | — | — | — | NOT_STARTED | — |
| INV-02 | M | **출고** — 매출 연동 및 샘플·폐기 등 사유가 있는 수동 출고 | — | — | — | — | — | — | NOT_STARTED | — |
| INV-03 | M | **창고 이동** — 출발·도착 창고, 요청·이동중·완료·취소 상태 | — | — | — | — | — | — | NOT_STARTED | — |
| INV-04 | M | **현재고** — 확정 시 원장 반영, 취소 시 반대 원장, 원장 합계가 진실 | — | — | — | — | — | — | NOT_STARTED | — |
| INV-05 | M | **수불부** — 기간별 기초·입고·출고·기말과 원천전표, 엑셀 출력 | — | — | — | — | — | — | NOT_STARTED | — |
| INV-06 | M | **마이너스 재고** — 설정에 따라 경고 또는 확정 차단, 동시 출고에서도 보장 | — | — | — | — | — | — | NOT_STARTED | — |
| INV-07 | M | **안전재고** — 앱·이메일·확정 메신저 채널 알림과 재시도 이력 | — | — | — | — | — | — | NOT_STARTED | — |
| INV-08 | M | **재고 실사** — 실사·차이·승인·조정전표 생성 | — | — | — | — | — | — | NOT_STARTED | — |
| INV-09 | M | **재고 평가** — DEC-01 월 총평균가 산출, 당월 잠정평가·마감확정·차이조정 | — | — | — | — | — | — | NOT_STARTED | — |
| INV-10 | O | **로트·유통기한** — 로트번호·유통기한·선입선출 권고 | — | — | — | — | — | — | OPTION_NOT_APPROVED | 선택 요구사항 |

## ACC — 회계

| ID | 중요도 | 요구사항 | 구현 화면 | API/라우터 | 서비스 | 테이블 | 자동시험 | 수동검수 | 상태 | 비고 |
|---|---|---|---|---|---|---|---|---|---|---|
| ACC-01 | M | **계정과목** — 표준 체계, 계층, 사용자 추가·수정·사용중지 | — | — | — | — | — | — | NOT_STARTED | — |
| ACC-02 | M | **회계전표** — 대체·입금·출금, 차대변 균형, 적요, 부문 태그 | — | — | — | — | — | — | NOT_STARTED | — |
| ACC-03 | M | **자동분개** — 매출·매입·수금·지급·반품·취소와 재고평가 마감조정을 설정 가능한 규칙으로 분개 | — | — | — | — | — | — | NOT_STARTED | — |
| ACC-04 | M | **원장** — 총계정원장·계정별원장, 원천전표 드릴다운 | — | — | — | — | — | — | NOT_STARTED | — |
| ACC-05 | M | **손익계산서** — 기간별 내부관리용 손익과 전기·전월 비교 | — | — | — | — | — | — | NOT_STARTED | — |
| ACC-06 | M | **재무상태표** — 기준일 내부관리용 재무상태표 | — | — | — | — | — | — | NOT_STARTED | — |
| ACC-07 | M | **부문별 손익** — 전표 라인의 사업부 기준 분리 | — | — | — | — | — | — | NOT_STARTED | — |
| ACC-08 | M | **결산** — 기간 마감·해제, 손익 마감과 잔액 이월, 전표 잠금 | — | — | — | — | — | — | NOT_STARTED | — |
| ACC-09 | M | **내보내기** — 세무대리인 제출용 전표·원장 엑셀 | — | — | — | — | — | — | NOT_STARTED | — |

## APV — 전자결재

| ID | 중요도 | 요구사항 | 구현 화면 | API/라우터 | 서비스 | 테이블 | 자동시험 | 수동검수 | 상태 | 비고 |
|---|---|---|---|---|---|---|---|---|---|---|
| APV-01 | M | **양식 관리** — 동적 필드, 기본 결재선, 버전 관리, 이전 버전 문서 재현 | — | — | — | — | — | — | NOT_STARTED | — |
| APV-02 | M | **기본 양식** — 지출결의·구매요청·품의·계약검토·휴가·근태정정 | — | — | — | — | — | — | NOT_STARTED | — |
| APV-03 | M | **결재선** — 순차, 병렬합의, 참조·열람, 기안 시 변경 허용 설정 | — | — | — | — | — | — | NOT_STARTED | — |
| APV-04 | M | **전결·대결** — 직위·금액 전결, 유효기간이 있는 부재·대결 | — | — | — | — | — | — | NOT_STARTED | — |
| APV-05 | M | **금액 분기** — 금액 구간에 따른 결재자 자동 추가 | — | — | — | — | — | — | NOT_STARTED | — |
| APV-06 | M | **기안** — 임시저장, 첨부 다건, 복사 재기안, 관련 문서 | — | — | — | — | — | — | NOT_STARTED | — |
| APV-07 | M | **처리** — 승인·반려·보류·회수, 의견, 수정 후 재상신 | — | — | — | — | — | — | NOT_STARTED | — |
| APV-08 | M | **전표 연동** — 정책상 결재 대상인 전표는 승인 콜백에서만 확정 | — | — | — | — | — | — | NOT_STARTED | — |
| APV-09 | M | **재고·인사 연동** — 구매요청 승인 시 발주서, 휴가 승인 시 연차·근태 반영 | — | — | — | — | — | — | NOT_STARTED | — |
| APV-10 | M | **결재함** — 기안·대기·진행·완료·반려·참조함과 미결 배지 | — | — | — | — | — | — | NOT_STARTED | — |
| APV-11 | M | **알림** — 요청·승인·반려·장기미결 알림, 재시도와 실패이력 | — | — | — | — | — | — | NOT_STARTED | — |
| APV-12 | M | **감사** — 완료 문서 불변, 이력 영구 보관, 취소문서로만 취소 | — | — | — | — | — | — | NOT_STARTED | — |
| APV-13 | M | **번호·검색** — 양식별 채번과 다조건 검색 | — | — | — | — | — | — | NOT_STARTED | — |
| APV-14 | M | **모바일 결재** — 모바일 조회·승인·반려 | — | — | — | — | — | — | NOT_STARTED | — |
| APV-15 | M | **출력** — 결재선·결재일시가 표시된 PDF | — | — | — | — | — | — | NOT_STARTED | — |
| APV-16 | O | **서명 이미지** — 결재자별 서명·도장 이미지 | — | — | — | — | — | — | OPTION_NOT_APPROVED | 선택 요구사항 |

## HRM — 인사

| ID | 중요도 | 요구사항 | 구현 화면 | API/라우터 | 서비스 | 테이블 | 자동시험 | 수동검수 | 상태 | 비고 |
|---|---|---|---|---|---|---|---|---|---|---|
| HRM-01 | M | **사원정보** — 사번·성명·생년월일·연락처·주소·입사일·조직·고용형태·재직상태 | — | — | — | — | — | — | NOT_STARTED | — |
| HRM-02 | M | **조직** — 계층·부서장·조직도·개편이력·시점조회 | — | — | — | — | — | — | NOT_STARTED | — |
| HRM-03 | M | **발령** — 입사·승진·이동·휴직·복직·퇴사 이력과 시점조회 | — | — | — | — | — | — | NOT_STARTED | — |
| HRM-04 | M | **근태** — 웹·모바일 체크인 또는 엑셀 업로드, 지각·조퇴·결근, 정정결재 | — | — | — | — | — | — | NOT_STARTED | — |
| HRM-05 | M | **휴가** — 확정된 취업규칙에 따른 부여·소멸, 휴가유형, 잔여일수 | — | — | — | — | — | — | NOT_STARTED | — |
| HRM-06 | M | **휴가신청** — 신청·결재·승인 시 사용원장과 근태 반영 | — | — | — | — | — | — | NOT_STARTED | — |
| HRM-07 | M | **근로시간** — 주·월 집계, 연장·야간·휴일 구분, 설정된 한도 경고 | — | — | — | — | — | — | NOT_STARTED | — |
| HRM-08 | M | **인사서류** — 첨부, 계약 만료·갱신 알림, 접근통제 | — | — | — | — | — | — | NOT_STARTED | — |
| HRM-09 | M | **증명서** — 재직·경력증명서 PDF와 발급이력 | — | — | — | — | — | — | NOT_STARTED | — |
| HRM-10 | M | **인사현황** — 부서·고용형태·입퇴사·근속 분포 | — | — | — | — | — | — | NOT_STARTED | — |
| HRM-11 | M | **계정연동** — 사원-계정 1:1, 조직변경 반영, 퇴사 즉시 비활성 | — | — | — | — | — | — | NOT_STARTED | — |
| HRM-12 | M | **개인정보** — 민감정보 분리·암호화·마스킹·복호화 접근이력 | — | — | — | — | — | — | NOT_STARTED | — |
| HRM-13 | M | **본인조회** — 본인 정보·근태·연차 조회와 변경신청 | — | — | — | — | — | — | NOT_STARTED | — |
| HRM-14 | O | **급여대장** — 외부 결과 업로드와 개인별 명세서 배포, 계산 제외 | — | — | — | — | — | — | OPTION_NOT_APPROVED | 선택 요구사항 |

## RPT — 보고서

| ID | 중요도 | 요구사항 | 구현 화면 | API/라우터 | 서비스 | 테이블 | 자동시험 | 수동검수 | 상태 | 비고 |
|---|---|---|---|---|---|---|---|---|---|---|
| RPT-01 | M | **매출현황** — 일·주·월·분기 매출·원가·이익 추이 | — | — | — | — | — | — | NOT_STARTED | — |
| RPT-02 | M | **품목순위** — 수량·금액 상위 N개와 기여도 | — | — | — | — | — | — | NOT_STARTED | — |
| RPT-03 | M | **거래처실적** — 매출·매입과 전년동기 비교 | — | — | — | — | — | — | NOT_STARTED | — |
| RPT-04 | M | **재고현황** — 창고·분류별 수량·금액, 안전재고 강조 | — | — | — | — | — | — | NOT_STARTED | — |
| RPT-05 | M | **채권채무** — 미수·미지급과 연령분석 | — | — | — | — | — | — | NOT_STARTED | — |
| RPT-06 | M | **대시보드** — 매출·이익률·미수·재고금액·안전재고·내 결재 | — | — | — | — | — | — | NOT_STARTED | — |
| RPT-07 | M | **공통기능** — 조회조건 저장, 엑셀·PDF, 인쇄 최적화 | — | — | — | — | — | — | NOT_STARTED | — |
| RPT-08 | M | **드릴다운** — 집계에서 권한 범위 내 원천전표로 이동 | — | — | — | — | — | — | NOT_STARTED | — |
| RPT-09 | M | **결재현황** — 처리건수·평균시간·장기미결 | — | — | — | — | — | — | NOT_STARTED | — |
| RPT-10 | M | **근태·인원** — 근태·연장근로·연차사용률·인원증감 | — | — | — | — | — | — | NOT_STARTED | — |
| RPT-11 | O | **예약발송** — 주기·수신자별 이메일 자동발송 | — | — | — | — | — | — | OPTION_NOT_APPROVED | 선택 요구사항 |

## UIX — 공통 UI

| ID | 중요도 | 요구사항 | 구현 화면 | API/라우터 | 서비스 | 테이블 | 자동시험 | 수동검수 | 상태 | 비고 |
|---|---|---|---|---|---|---|---|---|---|---|
| UIX-01 | M | **홈** — 위젯 배치·표시 저장과 주요 기능 진입 | `src/app/(app)/home/page.tsx`<br>`src/components/ui/dashboard-grid.tsx` | `src/server/api/routers/preference.ts` | — | `UserPreference` | `tests/e2e/components.spec.ts` | 위젯 숨김·순서 변경 후 새로고침 유지 확인 | DONE | 레이아웃·저장 완료. 업무 위젯 데이터 연결은 STEP 11 |
| UIX-02 | M | **표준 조회** — 조건·그리드 구조, 컬럼 표시·순서·너비 저장 | `src/components/ui/standard-list-page.tsx` | `src/server/api/routers/preference.ts` | — | — | `tests/e2e/components.spec.ts` | 조회조건·컬럼 표시 저장 후 새로고침 복원 확인 | DONE | 모든 목록 화면이 StandardListPage + useSavedFilters 사용 |
| UIX-03 | M | **그리드** — 정렬·필터·페이징/가상스크롤·다중선택·합계·엑셀 | `src/components/ui/data-grid.tsx` | — | — | — | `tests/e2e/components.spec.ts` | 정렬·다중선택·합계·페이징·컬럼설정·엑셀 버튼 확인 | DONE | 서버 페이징 전제(페이지당 최대 200). 1만건 전체 전송 없음 |
| UIX-04 | M | **전표 입력** — 라인 추가·복사·삭제, Tab/Enter, 자동완성 | `src/components/ui/voucher-line-editor.tsx` | — | — | — | `tests/e2e/components.spec.ts` | Tab/Enter 이동, Ctrl+D 복사, Ctrl+Delete 삭제, 자동완성 확인 | DONE | 표시용 재계산만 클라이언트에서 수행하고 서버가 최종 검증(DEC-02) |
| UIX-05 | M | **입력검증** — 오류 위치 표시, 저장 실패 시 입력값 보존 | `src/components/ui/form-error-summary.tsx` | — | — | — | `tests/e2e/components.spec.ts` | 저장 실패 시 오류 요약·필드 포커스·입력값 보존 확인 | DONE | — |
| UIX-06 | M | **반응형** — PC 우선, 태블릿·모바일 조회·대시보드·결재 | `src/components/app-shell.tsx`<br>`src/app/globals.css` | — | — | — | `tests/e2e/components.spec.ts`<br>`tests/e2e/auth.spec.ts` | 1440·1024·390px 확인, 모바일 메뉴 토글 | IN_PROGRESS | 앱 셸 반응형 완료. 업무 화면 전수 확인은 STEP 11 |
| UIX-07 | M | **첨부파일** — 전표·거래처·결재·인사파일의 권한 기반 업로드·미리보기 | `src/components/ui/attachment-panel.tsx` | `src/server/api/routers/attachment.ts` | `src/server/modules/storage/attachment.ts` | `Attachment` | `tests/integration/storage.test.ts`<br>`tests/e2e/components.spec.ts` | 권한 없는 첨부 접근 차단, 만료 URL 거부 확인 | DONE | — |
| UIX-08 | M | **알림센터** — 재고·여신·결재·인사 알림 통합 | `src/components/ui/notification-center.tsx` | `src/server/api/routers/notification.ts` | `src/server/modules/notification/service.ts` | `Notification`<br>`NotificationDelivery` | `tests/integration/transaction.test.ts`<br>`tests/e2e/components.spec.ts` | 알림 목록·읽음·모두 읽음 확인 | DONE | 재고·여신·결재·인사 알림이 같은 센터로 모임 |
| UIX-09 | O | **즐겨찾기** — 즐겨찾기와 최근메뉴 | — | — | — | — | — | — | OPTION_NOT_APPROVED | 선택 요구사항. 승인 시 구현 |

## INT — 공통 데이터 정합성

| ID | 중요도 | 요구사항 | 구현 화면 | API/라우터 | 서비스 | 테이블 | 자동시험 | 수동검수 | 상태 | 비고 |
|---|---|---|---|---|---|---|---|---|---|---|
| INT-01 | M | **정밀 숫자** — 금액·수량에 부동소수점 미사용, DB 정밀 숫자와 문자열 API 계약 | — | `src/server/api/schemas/common.ts`<br>`src/server/api/transformer.ts` | `src/lib/money.ts` | `Decimal(18,0) 금액 / (18,3) 수량 / (18,4) 단가` | `tests/unit/money.test.ts` | eslint no-restricted-syntax 로 parseFloat 차단 확인 | DONE | ADR-0011. API는 정밀 문자열 직렬화(superjson 미사용) |
| INT-02 | M | **전표 상태머신** — DRAFT·PENDING_APPROVAL·CONFIRMED·CANCELED 상태와 허용 전이 | — | — | `src/server/core/state-machine.ts` | — | `tests/unit/state-machine.test.ts` | — | IN_PROGRESS | 공통 상태머신·전이표 구현. 각 전표 적용은 STEP 7~10 |
| INT-03 | M | **확정 후 수정 금지** — 확정 전표는 취소와 재작성으로 정정 | — | — | `src/server/core/state-machine.ts (assertMutable)` | — | `tests/unit/state-machine.test.ts` | — | IN_PROGRESS | 규칙 구현 완료, 전표별 적용은 STEP 7~10 |
| INT-04 | M | **원장이 진실** — 재고는 원장 합계, 회계는 분개 원장, 캐시는 재생성 가능 | — | — | — | — | — | — | NOT_STARTED | — |
| INT-05 | M | **멱등성** — 승인·확정·취소·수금배분 재실행 시 중복 결과 없음 | — | — | `src/server/core/idempotency.ts` | `IdempotencyRecord(scope,requestId) UNIQUE` | `tests/integration/transaction.test.ts` | 동일 requestId 재호출·동시호출 시 부작용 1건 확인 | DONE | ADR-0012. B-03 통과 |
| INT-06 | M | **단일 트랜잭션 확정** — 재고·채권채무·회계·감사기록이 하나의 DB 트랜잭션 공유 | — | — | `src/server/core/context.ts (withTransaction)` | — | `tests/integration/transaction.test.ts` | — | IN_PROGRESS | 단일 트랜잭션 헬퍼와 롤백 원자성 검증 완료. 업무 확정 결합은 STEP 10 |
| INT-07 | M | **취소 원복** — 재고 반대원장·채권채무 원복·회계 역분개를 동일 트랜잭션, 원장행 미삭제 | — | — | — | — | — | — | NOT_STARTED | — |
| INT-08 | M | **동시 출고 잠금** — 품목·창고별 일관된 잠금 순서로 마이너스 재고 방지 | — | — | — | — | — | — | NOT_STARTED | — |
| INT-09 | M | **감사 기록** — actor·action·entity·before·after·시각·IP·요청ID, 민감정보 제거 | — | `src/server/api/routers/admin.ts (auditLog)` | `src/server/modules/audit/service.ts`<br>`src/server/core/redact.ts` | `AuditLog`<br>`SecurityEvent` | `tests/unit/redact.test.ts`<br>`tests/integration/transaction.test.ts`<br>`tests/integration/auth.test.ts` | 감사로그·보안이벤트에 비밀번호·주민번호·계좌 원문 없음 확인 | DONE | 업무 변경과 같은 트랜잭션 기록, 롤백 시 함께 사라짐 |
| INT-10 | M | **아웃박스** — 외부 이메일·메신저 부작용은 트랜잭셔널 아웃박스 | — | `src/server/api/routers/admin.ts (outboxEvents, retryOutbox)` | `src/server/modules/outbox/service.ts`<br>`src/server/jobs/worker.ts`<br>`src/server/jobs/handlers/email.ts` | `OutboxEvent`<br>`NotificationDelivery` | `tests/integration/transaction.test.ts` | SMTP 미설정 시 로그만 남고 아웃박스가 비워지는지 확인 | DONE | ADR-0010/0012. FOR UPDATE SKIP LOCKED, 백오프 5회 후 FAILED + 관리자 알림 |
| INT-11 | M | **유일성 제약** — 문서번호·원천문서 연결·외부 요청ID에 DB 유일성 제약 | — | — | `src/server/modules/numbering/service.ts`<br>`src/server/modules/outbox/service.ts` | `NumberingCounter(ruleId,periodKey)`<br>`OutboxEvent(topic,dedupKey)`<br>`IdempotencyRecord(scope,requestId)` | `tests/integration/transaction.test.ts` | 동시 채번 30건 중복·결번 없음 확인 | DONE | B-10 통과. 원천전표 연결 유일성 제약은 STEP 7~10에서 추가 |
| INT-12 | M | **서버 데이터 권한** — 사업부·창고·인사 권한을 모든 서버 조회·쓰기·내보내기에 적용 | — | `src/server/api/trpc.ts (permissionProcedure)` | `src/server/modules/rbac/service.ts` | `UserDivisionScope`<br>`UserWarehouseScope` | `tests/integration/rbac.test.ts` | — | IN_PROGRESS | 범위 검사·필터 구현과 시험 완료. 각 업무 조회·내보내기 적용은 해당 모듈 단계 |

## NFR — 비기능

| ID | 중요도 | 요구사항 | 구현 화면 | API/라우터 | 서비스 | 테이블 | 자동시험 | 수동검수 | 상태 | 비고 |
|---|---|---|---|---|---|---|---|---|---|---|
| NFR-PERF-01 | M | **목록 성능** — 1만 건 목록 일반 조회 서버 2초 이내 | — | — | — | — | — | — | NOT_STARTED | — |
| NFR-PERF-02 | M | **저장 성능** — 일반 전표 저장 1초 이내(외부 알림 제외) | — | — | — | — | — | — | NOT_STARTED | — |
| NFR-PERF-03 | M | **보고서 성능** — 1년 보고서 집계 5초 이내 | — | — | — | — | — | — | NOT_STARTED | — |
| NFR-PERF-04 | M | **동시 사용자** — 확정된 동시 사용자 수에서 오류율·응답시간 충족 | — | — | — | — | — | — | NOT_STARTED | — |
| NFR-SEC-01 | M | **RBAC·데이터 범위** — 조회·등록·수정·삭제·승인 권한과 부문·창고 범위를 서버에서 강제 | — | `src/server/api/trpc.ts`<br>`src/server/api/routers/admin.ts` | `src/server/modules/rbac/permissions.ts`<br>`src/server/modules/rbac/service.ts` | `Role`<br>`Permission`<br>`RolePermission`<br>`UserRole` | `tests/integration/rbac.test.ts` | 역할별 허용·차단 라우터 호출 확인 | DONE | 8개 역할 시드, 권한 문자열 module.action |
| NFR-SEC-02 | M | **인사 권한 분리** — 인사 권한 분리, 본인 외 조회는 인사담당·경영진 | — | — | `src/server/modules/rbac/service.ts (assertHrScope)`<br>`src/server/modules/storage/attachment.ts` | — | `tests/integration/rbac.test.ts`<br>`tests/integration/storage.test.ts` | hr.self 사용자가 타인 인사서류 접근 시 403 확인 | DONE | hr.read 없으면 본인만. 첨부도 SELF_OWNED_TYPES로 동일 규칙 적용 |
| NFR-SEC-03 | M | **인증·세션** — HTTPS, 안전한 해시, Secure·HttpOnly·SameSite 쿠키, 세션 만료·회전·폐기 | — | `src/app/api/auth/login/route.ts`<br>`src/app/api/auth/logout/route.ts` | `src/server/core/crypto.ts`<br>`src/server/modules/auth/service.ts` | `Session`<br>`User` | `tests/unit/crypto.test.ts`<br>`tests/integration/auth.test.ts`<br>`tests/e2e/auth.spec.ts` | 쿠키 HttpOnly·SameSite=Lax, document.cookie 미노출 E2E 확인 | DONE | scrypt, 세션 토큰 해시 저장, 절대 12h·유휴 2h, 로그인 시 회전 |
| NFR-SEC-04 | M | **로그인 보호** — 실패 제한, 잠금·해제, 비밀번호 초기화, 보안이벤트 감사 | — | `src/server/api/routers/auth.ts (unlockUser, resetPassword)` | `src/server/modules/auth/service.ts` | `LoginAttempt`<br>`SecurityEvent`<br>`User.lockedUntil` | `tests/integration/auth.test.ts` | 5회 실패 잠금 → 관리자 해제 → 정상 로그인 확인 | DONE | B-14 통과 |
| NFR-SEC-05 | M | **웹 취약점 방어** — CSRF·XSS·SQLi·권한우회 방어, 의존성 취약점 점검 | — | `src/app/api/auth/login/route.ts` | `src/server/api/trpc.ts (csrfGuard)`<br>`next.config.ts (보안 헤더)` | — | `tests/integration/rbac.test.ts` | — | IN_PROGRESS | Origin 기반 CSRF·보안헤더·Prisma 파라미터 바인딩 적용. 의존성 취약점 점검과 XSS 전수는 STEP 13 |
| NFR-SEC-06 | M | **민감정보 암호화** — 키·데이터 분리 암호화, 화면·로그·내보내기 마스킹 | — | — | `src/server/core/crypto.ts (AES-256-GCM)`<br>`src/server/core/redact.ts` | `EmployeeSensitive`<br>`SensitiveAccessLog` | `tests/unit/crypto.test.ts`<br>`tests/unit/redact.test.ts` | — | IN_PROGRESS | 암호화·마스킹 기반 구현. 실제 인사 민감정보 적용은 STEP 4 |
| NFR-SEC-07 | M | **첨부 보안** — 크기·형식·권한 검증, 안전한 파일명, 비공개 저장, 만료형 URL | — | `src/server/api/routers/attachment.ts`<br>`src/app/api/files/[key]/route.ts` | `src/server/modules/storage/service.ts`<br>`src/server/modules/storage/attachment.ts` | `Attachment` | `tests/integration/storage.test.ts` | 만료된 서명 URL 거부, 확장자·매직바이트 불일치 거부 확인 | DONE | 20MB 제한, MIME 허용목록+매직바이트, 비공개 저장, 5분 만료 URL |
| NFR-SEC-08 | M | **개인정보 파기** — 보유기간 도래 시 승인된 파기·익명화와 결과 기록 | — | — | — | — | — | — | NOT_STARTED | — |
| NFR-OPS-01 | M | **환경 분리** — 개발·스테이징·운영 환경과 데이터·비밀값 분리 | — | — | `src/server/env.ts`<br>`.env.example` | — | `tests/unit/crypto.test.ts` | 환경변수 누락 시 부팅 실패 확인 | DONE | APP_ENV로 development/test/staging/production 분리, zod 검증 |
| NFR-OPS-02 | M | **CI/CD** — 컨테이너 배포, 빌드·테스트·마이그레이션 포함 CI/CD | — | — | — | — | `.github/workflows/ci.yml (verify, e2e job)` | CI에서 lint/typecheck/unit/integration/build/traceability 실행 | DONE | 웹·워커 동일 이미지, 배포 시 prisma migrate deploy |
| NFR-OPS-03 | M | **백업** — 일 1회 자동 백업, 보존주기, 암호화, 실패알림 | — | — | — | — | — | — | NOT_STARTED | — |
| NFR-OPS-04 | M | **복구** — 복구 절차 문서화, 스테이징 복구시험 1회, RPO·RTO 기록 | — | — | — | — | — | — | NOT_STARTED | — |
| NFR-OPS-05 | M | **모니터링** — 구조화 로그·오류 추적·상태점검·용량·실패작업 모니터링 | — | `src/server/api/routers/admin.ts (systemHealth, outboxEvents)` | `src/server/core/logger.ts`<br>`src/app/api/health/route.ts` | — | `tests/e2e/auth.spec.ts` | — | IN_PROGRESS | 구조화 로그·상태점검·아웃박스 모니터링 구현. 오류추적 연동과 용량 모니터링은 STEP 13 |
| NFR-OPS-06 | M | **API 문서** — 내부 API를 OpenAPI 또는 동등 수준으로 문서화 | — | `src/server/api/root.ts` | — | — | — | — | IN_PROGRESS | tRPC 라우터 구조 확립. OpenAPI 수준 명세 생성기는 STEP 13 |
| NFR-OPS-07 | M | **브라우저 지원** — 최신 Chrome·Edge·Safari 지원 매트릭스와 핵심 흐름 검증 | — | — | — | — | — | — | NOT_STARTED | — |
| NFR-UX-01 | M | **현지화** — 한국어 UI, KRW 천단위, Asia/Seoul | `src/app/layout.tsx`<br>`src/components/app-shell.tsx` | — | `src/lib/dates.ts`<br>`src/lib/money.ts`<br>`src/lib/format.ts` | — | `tests/unit/dates.test.ts`<br>`tests/unit/money.test.ts` | — | IN_PROGRESS | 한국어 UI, KRW 천단위, Asia/Seoul 공통 포맷터. 전 화면 적용은 STEP 11 |
| NFR-UX-02 | M | **학습 용이성** — 용어·오류·빈 상태 설계로 신규 사용자 입력 가능 | `src/components/ui/primitives.tsx (EmptyState, ErrorState, Field)` | — | — | — | `tests/e2e/components.spec.ts` | — | IN_PROGRESS | 빈 상태·오류에 다음 행동 안내. 업무 용어 전수 점검은 STEP 11 |
| NFR-UX-03 | M | **접근성** — 키보드·포커스·레이블·색상 외 상태표시 | `src/app/globals.css`<br>`src/components/ui/primitives.tsx` | — | — | — | `tests/e2e/components.spec.ts`<br>`tests/e2e/auth.spec.ts` | 키보드 전용 조작, 포커스 표시, 상태 라벨 병기 확인 | IN_PROGRESS | StatusBadge는 색상 외 라벨 병기. 전수 점검은 STEP 11 |

## MIG — 데이터 이관

| ID | 중요도 | 요구사항 | 구현 화면 | API/라우터 | 서비스 | 테이블 | 자동시험 | 수동검수 | 상태 | 비고 |
|---|---|---|---|---|---|---|---|---|---|---|
| MIG-01 | M | **품목 이관** — 전건, 분류·단가·과세·안전재고 포함 | — | — | — | — | — | — | NOT_STARTED | — |
| MIG-02 | M | **거래처 이관** — 전건, 담당자·결제조건·여신한도 포함 | — | — | — | — | — | — | NOT_STARTED | — |
| MIG-03 | M | **기초재고 이관** — 기준일 창고·품목별 수량·금액, 개시 원장 반영 | — | — | — | — | — | — | NOT_STARTED | — |
| MIG-04 | M | **미수·미지급 이관** — 거래처별 잔액과 합의된 전표 상세 | — | — | — | — | — | — | NOT_STARTED | — |
| MIG-05 | M | **회계 이관** — 계정과목과 기준일 기초잔액 | — | — | — | — | — | — | NOT_STARTED | — |
| MIG-06 | M | **인사·조직 이관** — 재직자, 합의된 퇴사자, 부서·직위·입사일·조직도 | — | — | — | — | — | — | NOT_STARTED | — |
| MIG-07 | M | **연차 이관** — 산정 기준일과 부여·사용·잔여 합계 | — | — | — | — | — | — | NOT_STARTED | — |
| MIG-08 | M | **과거 전표 이관** — 최근 기간과 참조 방식 확정 후 이관 | — | — | — | — | — | — | NOT_STARTED | — |
| MIG-09 | M | **이관 검증** — 건수·수량·금액·차대변·재고 평가금액 대사 결과서 | — | — | — | — | — | — | NOT_STARTED | — |

## DEC — 착수 시 확정 정책

| ID | 중요도 | 요구사항 | 구현 화면 | API/라우터 | 서비스 | 테이블 | 자동시험 | 수동검수 | 상태 | 비고 |
|---|---|---|---|---|---|---|---|---|---|---|
| DEC-01 | D | **재고 평가** — 월 총평균법, 당월 잠정평가, 월 마감 확정·차이조정 | — | — | — | — | `docs/acceptance-scenarios.md B-11` | — | DONE | 기본안 임시승인, PolicyVersion inventory.valuation v1 시드 |
| DEC-02 | D | **금액·부가세** — KRW 정수, 라인별 공급가·부가세 10% 원단위 절사 후 합산 | — | — | — | — | `tests/unit/money.test.ts` | — | DONE | 기본안 임시승인, PolicyVersion money v1 시드 |
| DEC-03 | D | **전표별 결재 정책** — 전표 유형·금액 구간별 결재 필수/선택/면제 | — | — | — | — | `prisma/seed.ts approval.matrix` | — | DONE | 기본안 임시승인, 착수회의에서 금액 구간 확정 필요 |
| DEC-04 | D | **회계기간·전표일** — 달력 월 기준 마감·해제·역분개 | — | — | — | — | `tests/unit/dates.test.ts` | — | DONE | 기본안 임시승인 |
| DEC-05 | D | **연차·근태** — 입사일 기준, 취업규칙·법령 반영 정책 버전 | — | — | — | — | `prisma/seed.ts leave v1` | — | DONE | 기본안 임시승인, 노무 검토 후 v2 예정 |
| DEC-06 | D | **개인정보 보유·파기** — 정보 항목별 보유기간표 | — | — | — | — | `prisma/seed.ts retention v1` | — | DONE | 기본안 임시승인 |
| DEC-07 | D | **배포·인증·파일 저장** — Railway, 자체 세션, 외부 객체 저장소 | — | — | — | — | `tests/integration/auth.test.ts`<br>`tests/integration/storage.test.ts` | — | DONE | Railway + 자체 세션 + S3 호환 저장소 구현 완료 |
| DEC-08 | D | **이관 범위** — 현행 데이터 전건 분석 후 원천별 매핑·기준일 | — | — | — | — | `docs/scope.md` | — | DONE | 기본안 임시승인, 원천 파일 수령 후 매핑 확정 |
| DEC-09 | D | **알림 채널** — 앱 내 알림·이메일 필수, 메신저 종류 확정 | — | — | — | — | `tests/integration/transaction.test.ts` | — | DONE | 앱+이메일 구현, 메신저 NONE |

## CHANGE_REQUEST

| ID | 발견 단계 | 내용 | 관련 ID | 상태 |
|---|---|---|---|---|
| CR-01 | STEP 2 | 샌드박스 환경에서 Prisma 네이티브 schema-engine 다운로드가 차단되어, 동일한 migrations 산출물을 생성하는 WASM 기반 마이그레이션 드라이버(tools/migrate.mjs)를 추가했다. 운영·CI에서는 표준 prisma migrate deploy를 사용한다. | NFR-OPS-02 | IMPLEMENTED_AS_TOOLING |
| CR-02 | STEP 2 | RFP에 명시되지 않았으나 hr.self 권한자의 본인 첨부파일 접근 규칙이 필요해 SELF_OWNED_TYPES 규칙을 정의했다. NFR-SEC-02 해석 확인 필요. | NFR-SEC-02, UIX-07, HRM-13 | OPEN |
| CR-03 | STEP 3 | 모바일 390px에서 스티키 헤더에 가려지는 문제를 scroll-padding-top으로, 넓은 그리드가 페이지 전체를 가로로 넘치게 하는 문제를 min-w-0으로 수정했다. RFP 미명시 개선사항. | UIX-06, NFR-UX-03 | IMPLEMENTED |
