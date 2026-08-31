# STEP 13 감사 결과 — 요구사항 근거 재검증

`node tools/traceability.mjs --check`는 추적표의 **형식**만 본다. 인용된 파일이 존재하는지는 보지만, 그 파일이 해당 요구사항을 실제로 구현·검증하는지는 보지 않는다. 이 문서는 그 차이를 기록한다.

기준일 2026-08-31. 감사 시점 DONE 125건.

## 감사 방법

세 가지를 기계적으로 대조했다.

첫째, 추적표가 근거로 든 파일이 실제로 존재하는가. 둘째, 근거로 든 시험 파일이 해당 요구사항 ID를 실제로 다루는가 — 다른 ID의 시험을 근거로 재사용한 항목을 찾기 위해서다. 셋째, 근거로 든 tRPC 프로시저를 화면에서 호출하는 곳이 있는가. 세 번째가 가장 많은 것을 드러냈다. 서버에 기능이 있고 시험도 통과하지만 화면에서 부를 수 없다면, 사용자 관점에서 그 요구사항은 충족되지 않았다.

## 교차 결함

**끊어진 내비게이션 링크 8건.** `src/components/app-shell.tsx`의 링크 60건 중 8건이 `page.tsx`가 없는 경로를 가리킨다: `/hr/assignments`, `/hr/documents`, `/hr/certificates`, `/system/users`, `/system/roles`, `/system/policies`, `/system/jobs`, `/system/audit`. 메뉴에는 보이고 누르면 404다.

**화면에서 도달할 수 없는 tRPC 프로시저 54건.** 라우터에 선언된 236건 중 54건을 `src/app`·`src/components`의 어느 곳도 호출하지 않는다. 이 중 다수가 DONE 행의 근거로 인용되어 있어, 행이 주장하는 사용자 기능이 실제로는 열려 있지 않다.

**잘못된 테이블명.** SLS-05·06·08·09가 `OpenItem`을, SLS-10이 `SettlementAllocation`을 근거 테이블로 적었다. 스키마에 그런 모델은 없다. 실제 모델은 `Receivable`/`Payable`과 `SettlementMatch`다. 이름이 틀린 추적표는 대사 근거로 쓸 수 없다.

## NOT_VERIFIED로 되돌리는 항목

| ID | 제목 | 사유 |
|---|---|---|
| SLS-01 | 견적서 | `sales.updateQuotation` 미도달. 견적 화면은 등록·복사·상태변경만 연결되어 있어 요구된 **수정**이 불가능하다 |
| SLS-05 | 매출전표 | `sales.updateSalesDocument` 미도달. 작성 후 정정 경로가 없다 |
| SLS-07 | 세금계산서 양식 | `sales.taxInvoice`·`sales.taxInvoiceHistory` 모두 미도달. PDF 생성과 발송 이력을 여는 화면이 없다 |
| SLS-12 | 전표 마감 | 근거 화면 `accounting/periods/page.tsx`가 존재하지 않는다. 인용된 E2E에 해당 시험이 없고, 통합시험은 생성 차단만 덮는다 |
| ACC-03 | 자동분개 | `accounting.publishPostingRule` 미도달. 규칙 화면은 조회·미리보기·계정매핑까지이고, 규칙 버전을 **확정**할 수 없다 |
| ACC-09 | 내보내기 | `accounting.accountLedgerCsv` 미도달. 원장 엑셀이 요구사항의 절반인데 화면에 없다 |
| INV-05 | 수불부 | `inventory.bookCsv` 미도달. 엑셀 출력이 명시 요구사항이다 |
| INV-07 | 안전재고 | `inventory.safetyStock` 미도달. 근거 API 전부가 화면에서 열리지 않는다 |
| HRM-01 | 사원정보 | `hrm.update` 미도달. 등록·조회만 되고 수정이 안 된다 |
| HRM-02 | 조직 | `hrm.createDepartment`·`hrm.reorganize` 미도달. 조직을 만들거나 개편할 수 없다 |
| HRM-03 | 발령 | `hrm.assign`·`hrm.positionAt` 미도달. 발령 이력은 읽기 전용이고 `/hr/assignments`는 404 |
| HRM-04 | 근태 | `hrm.attendanceUpload` 미도달. 엑셀 업로드 경로가 명시 요구사항이다 |
| HRM-05 | 휴가 | `hrm.grantAnnual`·`grantManual`·`expireGrants` 미도달. 부여·소멸이 전부 닫혀 있다 |
| HRM-08 | 인사서류 | `/hr/documents` 404. 인용 시험 두 건 모두 HRM-08을 다루지 않는다 |
| HRM-09 | 증명서 | 화면 없음, `/hr/certificates` 404, `hrm.issueCertificate` 미도달. PDF 렌더러도 없다 |
| HRM-11 | 계정연동 | `hrm.resign` 미도달. 퇴사 처리 경로가 없으므로 즉시 비활성도 발생하지 않는다 |
| HRM-13 | 본인조회 | `hrm.reviewChange` 미도달. 변경신청을 처리할 사람이 없어 요구된 왕복이 닫히지 않는다 |
| APV-01 | 양식 관리 | `approval.publishFormVersion` 미도달. 버전 관리가 요구사항인데 확정할 수 없다 |
| APV-03 | 결재선 | `ApprovalLineTemplate.editable`을 읽는 코드가 없고, 병렬합의·참조에 시험이 없다. 인용 통합시험은 APV-05의 금액 분기 시험이다 |
| APV-07 | 처리 | `approval.releaseHold`·`approval.resubmit` 미도달. 보류 해제와 재상신이 열려 있지 않다 |
| APV-11 | 알림 | 장기미결 알림 경로는 이번 STEP 13에서 붙였으나 시험이 없다. 기존 근거 시험은 조회 쿼리가 행을 돌려주는 것만 확인한다 |
| APV-13 | 번호·검색 | 요구는 **양식별** 채번인데 `nextDocNo(t, 'APPROVAL')` 하나로 통합 채번한다. 다조건 검색 시험도 없다 |
| APV-14 | 모바일 결재 | 유일 근거 E2E가 목록을 열고 제목이 보이는지만 본다. 승인·반려를 하지 않는다 |
| UIX-03 | 그리드 | 엑셀 버튼은 `onExport`를 넘길 때만 렌더되는데, 넘기는 곳이 개발용 갤러리 한 곳뿐이고 그마저 `alert`다. 가상스크롤 없음 |
| UIX-07 | 첨부파일 | 요구가 첫머리에 든 **전표** 화면에 첨부 패널이 없다. 미리보기도 `window.open`이 전부다 |
| NFR-OPS-01 | 환경 분리 | 인용 시험은 암호화 시험이고 `src/server/env.ts`에는 시험이 하나도 없다 |
| NFR-OPS-02 | CI/CD | 근거 시험이 없다. 수동 확인만으로 DONE이었다 |

## DONE은 유지하되 결함을 기록하는 항목

ACC-01은 `deleteAccount`가 미도달이지만, 요구는 사용중지이고 그 경로는 열려 있다. ACC-02는 `updateEntry`가 미도달이라 작성한 전표를 화면에서 고칠 수 없다 — 요구사항 문장이 수정을 명시하지 않아 유지하되 결함으로 남긴다. ACC-08은 `openingBalances`가 미도달이지만 이는 기초잔액 입력으로 MIG 쪽 관심사이고, 마감·이월·잠금은 모두 열려 있다. BAS-02의 `createItemCategory`, BAS-09의 `deletePartner`, HRM-06의 `cancelLeave`, SLS-03의 `createSalesOrder`도 같은 성격이다. MIG-01~09는 `migration.reconcile`이 미도달이어서 이관 대사를 화면에서 실행할 수 없다 — 검증·반영은 열려 있으므로 유지하되, STEP 13이 요구하는 이관 대사 결과서를 내려면 이 경로가 필요하다.

BAS-08은 `admin.auditLog`가 미도달이지만 `master.changeHistory`가 화면에 연결되어 있어 요구된 변경 이력 조회는 성립한다. `/system/audit` 404는 별개의 결함으로 위에 기록했다.

## 자동시험 없이 수동 확인만 한 항목

STEP 13 최종 판정 규칙이 별도 표시를 요구한다. 추적표의 `manual` 필드만 있고 `tests`가 비어 있는 항목이 여기 해당한다: DEC-01, DEC-05, DEC-06, DEC-08, NFR-OPS-02. DEC-07과 DEC-09는 시험을 인용하지만 그 파일이 해당 ID를 다루지 않는다.

## 다음

되돌린 항목은 근거를 만들어 다시 DONE으로 올린다. 화면이 없어서 막힌 것이 대부분이므로 순서는 화면 신설, 기존 화면 연결, 시험 추가다. 끝까지 올리지 못한 항목은 BLOCKED로 사유·영향·책임자·목표일을 적는다.
