# 권한 매트릭스 (Permission Matrix)

> 생성: `node tools/docs-permissions.mjs` — 원본은 `src/server/modules/rbac/permissions.ts`(권한 카탈로그·역할 프리셋, 정적 AST 분석)와 `src/server/api/routers/*.ts`(프로시저별 필요 권한, `tools/lib/router-permissions.mjs`를 `tests/integration/permissions.test.ts`의 전수 호출시험과 공유). 이 파일을 직접 편집하지 않는다.

생성 시각: 2026-08-31T05:29:48.428Z · 권한 47개 · 역할 8개 · 라우터 13개 · 프로시저 244개

## 1. 권한 카탈로그

`Permission` 문자열은 `module.action` 형식이다(docs/security-model.md §3). 아래는 `PERMISSIONS`(`src/server/modules/rbac/permissions.ts`)에 선언된 전체 목록이다.

| 모듈       | 코드                  | 설명                          |
| ---------- | --------------------- | ----------------------------- |
| admin      | `admin.users`         | 사용자 관리                   |
| admin      | `admin.roles`         | 역할·권한 관리                |
| admin      | `admin.settings`      | 정책·시스템 설정              |
| admin      | `admin.audit`         | 감사로그 조회                 |
| admin      | `admin.jobs`          | 실패작업 조회·재시도          |
| admin      | `admin.migration`     | 데이터 이관 실행              |
| master     | `master.read`         | 기초정보 조회                 |
| master     | `master.write`        | 기초정보 등록·수정            |
| master     | `master.export`       | 기초정보 내보내기             |
| sales      | `sales.read`          | 매출·매입 조회                |
| sales      | `sales.write`         | 매출·매입 등록·수정           |
| sales      | `sales.confirm`       | 매출·매입 확정                |
| sales      | `sales.cancel`        | 매출·매입 취소                |
| sales      | `sales.export`        | 매출·매입 내보내기            |
| purchase   | `purchase.read`       | 구매요청·발주 조회            |
| purchase   | `purchase.write`      | 구매요청·발주 등록·수정       |
| purchase   | `purchase.confirm`    | 발주·매입 확정                |
| purchase   | `purchase.cancel`     | 발주·매입 취소                |
| settlement | `settlement.read`     | 채권채무·수금지급 조회        |
| settlement | `settlement.write`    | 수금·지급 등록                |
| settlement | `settlement.confirm`  | 수금·지급 확정                |
| inventory  | `inventory.read`      | 재고 조회                     |
| inventory  | `inventory.write`     | 입출고·이동 등록              |
| inventory  | `inventory.confirm`   | 입출고·이동 확정              |
| inventory  | `inventory.cancel`    | 입출고·이동 취소              |
| inventory  | `inventory.count`     | 재고 실사·조정                |
| inventory  | `inventory.valuation` | 재고 평가·월마감              |
| inventory  | `inventory.export`    | 재고 내보내기                 |
| accounting | `accounting.read`     | 회계 조회                     |
| accounting | `accounting.write`    | 회계전표 등록·수정            |
| accounting | `accounting.confirm`  | 회계전표 확정                 |
| accounting | `accounting.cancel`   | 회계전표 취소·역분개          |
| accounting | `accounting.rules`    | 분개규칙 관리                 |
| accounting | `accounting.close`    | 회계 마감                     |
| period     | `period.reopen`       | 마감 해제                     |
| accounting | `accounting.export`   | 회계 내보내기                 |
| approval   | `approval.use`        | 결재 기안·처리                |
| approval   | `approval.admin`      | 결재 양식·결재선 관리         |
| hr         | `hr.self`             | 본인 인사정보 조회            |
| hr         | `hr.read`             | 전 직원 인사정보 조회         |
| hr         | `hr.write`            | 인사정보 등록·수정·발령       |
| hr         | `hr.sensitive.read`   | 주민번호·계좌번호 복호화 조회 |
| hr         | `hr.attendance`       | 근태 관리                     |
| hr         | `hr.leave`            | 휴가·연차 관리                |
| hr         | `hr.export`           | 인사정보 내보내기             |
| report     | `report.read`         | 보고서 조회                   |
| report     | `report.export`       | 보고서 내보내기               |

## 2. 역할 × 권한 매트릭스

`ROLE_PRESETS`(`src/server/modules/rbac/permissions.ts`)에서 시드되는 역할별 권한이다. `admin`은 `permissions: '*'`로 선언되어 모든 권한과 전체 데이터 범위를 갖는다(표에서도 전 행 ✅로 나타난다).

| 코드                  | 설명                          | 시스템 관리자 | 경영진 | 영업 | 구매 | 물류·재고 | 회계 | 인사 | 조회전용 |
| --------------------- | ----------------------------- | ------------- | ------ | ---- | ---- | --------- | ---- | ---- | -------- |
| `admin.users`         | 사용자 관리                   | ✅            | —      | —    | —    | —         | —    | ✅   | —        |
| `admin.roles`         | 역할·권한 관리                | ✅            | —      | —    | —    | —         | —    | —    | —        |
| `admin.settings`      | 정책·시스템 설정              | ✅            | —      | —    | —    | —         | —    | —    | —        |
| `admin.audit`         | 감사로그 조회                 | ✅            | ✅     | —    | —    | —         | —    | —    | —        |
| `admin.jobs`          | 실패작업 조회·재시도          | ✅            | —      | —    | —    | —         | —    | —    | —        |
| `admin.migration`     | 데이터 이관 실행              | ✅            | —      | —    | —    | —         | —    | —    | —        |
| `master.read`         | 기초정보 조회                 | ✅            | ✅     | ✅   | ✅   | ✅        | ✅   | —    | ✅       |
| `master.write`        | 기초정보 등록·수정            | ✅            | —      | —    | ✅   | —         | —    | —    | —        |
| `master.export`       | 기초정보 내보내기             | ✅            | —      | —    | —    | —         | —    | —    | —        |
| `sales.read`          | 매출·매입 조회                | ✅            | ✅     | ✅   | ✅   | ✅        | ✅   | —    | ✅       |
| `sales.write`         | 매출·매입 등록·수정           | ✅            | —      | ✅   | —    | —         | —    | —    | —        |
| `sales.confirm`       | 매출·매입 확정                | ✅            | —      | ✅   | —    | —         | —    | —    | —        |
| `sales.cancel`        | 매출·매입 취소                | ✅            | —      | ✅   | —    | —         | —    | —    | —        |
| `sales.export`        | 매출·매입 내보내기            | ✅            | ✅     | ✅   | —    | —         | —    | —    | —        |
| `purchase.read`       | 구매요청·발주 조회            | ✅            | ✅     | —    | ✅   | —         | ✅   | —    | ✅       |
| `purchase.write`      | 구매요청·발주 등록·수정       | ✅            | —      | —    | ✅   | —         | —    | —    | —        |
| `purchase.confirm`    | 발주·매입 확정                | ✅            | —      | —    | ✅   | —         | —    | —    | —        |
| `purchase.cancel`     | 발주·매입 취소                | ✅            | —      | —    | ✅   | —         | —    | —    | —        |
| `settlement.read`     | 채권채무·수금지급 조회        | ✅            | ✅     | ✅   | ✅   | —         | ✅   | —    | ✅       |
| `settlement.write`    | 수금·지급 등록                | ✅            | —      | ✅   | —    | —         | ✅   | —    | —        |
| `settlement.confirm`  | 수금·지급 확정                | ✅            | —      | —    | —    | —         | ✅   | —    | —        |
| `inventory.read`      | 재고 조회                     | ✅            | ✅     | ✅   | ✅   | ✅        | ✅   | —    | ✅       |
| `inventory.write`     | 입출고·이동 등록              | ✅            | —      | —    | —    | ✅        | —    | —    | —        |
| `inventory.confirm`   | 입출고·이동 확정              | ✅            | —      | —    | —    | ✅        | —    | —    | —        |
| `inventory.cancel`    | 입출고·이동 취소              | ✅            | —      | —    | —    | ✅        | —    | —    | —        |
| `inventory.count`     | 재고 실사·조정                | ✅            | —      | —    | —    | ✅        | —    | —    | —        |
| `inventory.valuation` | 재고 평가·월마감              | ✅            | —      | —    | —    | —         | ✅   | —    | —        |
| `inventory.export`    | 재고 내보내기                 | ✅            | ✅     | —    | —    | ✅        | —    | —    | —        |
| `accounting.read`     | 회계 조회                     | ✅            | ✅     | —    | —    | —         | ✅   | —    | ✅       |
| `accounting.write`    | 회계전표 등록·수정            | ✅            | —      | —    | —    | —         | ✅   | —    | —        |
| `accounting.confirm`  | 회계전표 확정                 | ✅            | —      | —    | —    | —         | ✅   | —    | —        |
| `accounting.cancel`   | 회계전표 취소·역분개          | ✅            | —      | —    | —    | —         | ✅   | —    | —        |
| `accounting.rules`    | 분개규칙 관리                 | ✅            | —      | —    | —    | —         | ✅   | —    | —        |
| `accounting.close`    | 회계 마감                     | ✅            | —      | —    | —    | —         | ✅   | —    | —        |
| `period.reopen`       | 마감 해제                     | ✅            | —      | —    | —    | —         | —    | —    | —        |
| `accounting.export`   | 회계 내보내기                 | ✅            | ✅     | —    | —    | —         | ✅   | —    | —        |
| `approval.use`        | 결재 기안·처리                | ✅            | ✅     | ✅   | ✅   | ✅        | ✅   | ✅   | ✅       |
| `approval.admin`      | 결재 양식·결재선 관리         | ✅            | —      | —    | —    | —         | —    | ✅   | —        |
| `hr.self`             | 본인 인사정보 조회            | ✅            | ✅     | ✅   | ✅   | ✅        | ✅   | ✅   | ✅       |
| `hr.read`             | 전 직원 인사정보 조회         | ✅            | ✅     | —    | —    | —         | —    | ✅   | —        |
| `hr.write`            | 인사정보 등록·수정·발령       | ✅            | —      | —    | —    | —         | —    | ✅   | —        |
| `hr.sensitive.read`   | 주민번호·계좌번호 복호화 조회 | ✅            | —      | —    | —    | —         | —    | ✅   | —        |
| `hr.attendance`       | 근태 관리                     | ✅            | —      | —    | —    | —         | —    | ✅   | —        |
| `hr.leave`            | 휴가·연차 관리                | ✅            | —      | —    | —    | —         | —    | ✅   | —        |
| `hr.export`           | 인사정보 내보내기             | ✅            | —      | —    | —    | —         | —    | ✅   | —        |
| `report.read`         | 보고서 조회                   | ✅            | ✅     | ✅   | ✅   | ✅        | ✅   | ✅   | ✅       |
| `report.export`       | 보고서 내보내기               | ✅            | ✅     | ✅   | —    | —         | ✅   | —    | —        |

역할 코드: `admin` (시스템 관리자), `manager` (경영진), `sales` (영업), `purchasing` (구매), `inventory` (물류·재고), `accounting` (회계), `hr` (인사), `viewer` (조회전용).

## 3. 데이터 범위 (Division / Warehouse / HR Scope)

권한이 있어도 데이터 범위가 좁히는 것을 막지 못하면 다른 사업부·창고·직원의 자료가 새어 나간다(INT-12, NFR-SEC-02). 세 범위 모두 **기본 거부**(scope가 비어 있으면 아무것도 보이지 않음)이며, 관리자(`actor.isAdmin`)만 전체를 본다. 세 범위 모두 `src/server/modules/rbac/service.ts`에 있다.

### 3.1 사업부 범위 (Division Scope)

- 단일 레코드 접근은 `assertDivisionScope(actor, divisionId)`가 검사한다. `divisionId`가 없는 행(회사 전체 공용)은 통과시키고, 있으면 `actor.divisionIds`에 포함되어야 하며 아니면 `AppError('OUT_OF_SCOPE', ...)`를 던진다.
- 목록 조회는 `divisionScopeFilter(actor)`가 만드는 `{ divisionId: { in: actor.divisionIds } }` where절을 SQL에 결합해 범위 밖 행이 애초에 나오지 않게 한다(관리자는 `{}`, 즉 무제한).
- 좁히는 대상: `docs/data-model.md`의 `divisionId` 컬럼을 가진 모든 업무전표(견적·주문·매출·매입·구매요청·발주·수금·지급·회계전표 등)와 보고서 필터(`src/server/modules/report/filter.ts`의 `resolveFilter`가 `assertDivisionScope`를 호출).

### 3.2 창고 범위 (Warehouse Scope)

- 단일 레코드 접근은 `assertWarehouseScope(actor, warehouseId)`, 목록은 `warehouseScopeFilter(actor)`가 같은 방식으로 적용한다.
- 좁히는 대상: 입출고·이동전표(`StockDocument`, `src/server/modules/inventory/stock-document.ts`가 출발·도착 창고 둘 다 검사), 재고 조회·실사(`StockCount`, `StockSnapshot`), 보고서 필터의 `warehouseId`.

### 3.3 인사 범위 (HR Scope)

- `assertHrScope(actor, employeeId)`: `hr.read`를 가진 사용자(또는 관리자)는 전 직원을 보고, 그렇지 않으면 `actor.employeeId`와 같은 직원 레코드만 통과한다 — `hr.self`는 "본인만"의 하한선이다.
- 목록 조회는 `hrScopeFilter(actor)`가 `hr.read`가 없으면 `{ id: actor.employeeId ?? '__none__' }`로 좁힌다(직원이 아닌 사용자는 아무 것도 보지 못한다).
- 좁히는 대상: `Employee`, `EmployeeSensitive`, 근태(`Attendance`), 휴가(`LeaveRequest`, `LeaveGrant`), 인사발령(`Assignment`, `DepartmentHistory`), 증명서 발급 이력 — `src/server/modules/hrm/employee.ts`의 `detail`·`certificateHistory`·`assignmentHistory` 등이 `assertHrScope`를 직접 호출한다.

## 4. 프로시저별 필요 권한

`src/server/api/routers/*.ts`를 정적으로 파싱해, 각 tRPC 프로시저 빌더 체인의 밑바탕이 `permissionProcedure('code')`·`authedProcedure`(인증만, 업무 권한 없음)·`publicProcedure`(인증 불필요) 중 무엇인지 판정한 결과다. `tests/integration/permissions.test.ts`가 같은 판정을 그대로 재사용해 권한 없는 사용자가 실제로 거부되는지 전수 호출한다.

### accounting (`src/server/api/routers/accounting.ts`)

| 프로시저                             | 종류     | 필요 권한            |
| ------------------------------------ | -------- | -------------------- |
| `accounting.accounts`                | query    | `accounting.read`    |
| `accounting.postableAccounts`        | query    | `accounting.read`    |
| `accounting.createAccount`           | mutation | `accounting.rules`   |
| `accounting.updateAccount`           | mutation | `accounting.rules`   |
| `accounting.deleteAccount`           | mutation | `accounting.rules`   |
| `accounting.accountMappings`         | query    | `accounting.read`    |
| `accounting.setAccountMapping`       | mutation | `accounting.rules`   |
| `accounting.postingRules`            | query    | `accounting.read`    |
| `accounting.publishPostingRule`      | mutation | `accounting.rules`   |
| `accounting.previewPostingRule`      | query    | `accounting.read`    |
| `accounting.entries`                 | query    | `accounting.read`    |
| `accounting.entry`                   | query    | `accounting.read`    |
| `accounting.createEntry`             | mutation | `accounting.write`   |
| `accounting.updateEntry`             | mutation | `accounting.write`   |
| `accounting.confirmEntry`            | mutation | `accounting.confirm` |
| `accounting.cancelEntry`             | mutation | `accounting.cancel`  |
| `accounting.submitEntryForApproval`  | mutation | `accounting.write`   |
| `accounting.submitEntryCancellation` | mutation | `accounting.cancel`  |
| `accounting.accountLedger`           | query    | `accounting.read`    |
| `accounting.trialBalance`            | query    | `accounting.read`    |
| `accounting.incomeStatement`         | query    | `accounting.read`    |
| `accounting.incomeByDivision`        | query    | `accounting.read`    |
| `accounting.balanceSheet`            | query    | `accounting.read`    |
| `accounting.trialBalanceCsv`         | query    | `accounting.export`  |
| `accounting.accountLedgerCsv`        | query    | `accounting.export`  |
| `accounting.periods`                 | query    | `accounting.read`    |
| `accounting.closeMonth`              | mutation | `accounting.close`   |
| `accounting.reopenPeriod`            | mutation | `period.reopen`      |
| `accounting.yearClosePreview`        | query    | `accounting.read`    |
| `accounting.closeYear`               | mutation | `accounting.close`   |
| `accounting.closingRuns`             | query    | `accounting.read`    |
| `accounting.openingBalances`         | query    | `accounting.read`    |

### admin (`src/server/api/routers/admin.ts`)

| 프로시저                   | 종류     | 필요 권한        |
| -------------------------- | -------- | ---------------- |
| `admin.listUsers`          | query    | `admin.users`    |
| `admin.createUser`         | mutation | `admin.users`    |
| `admin.updateUserAccess`   | mutation | `admin.users`    |
| `admin.listRoles`          | query    | `admin.roles`    |
| `admin.listPermissions`    | query    | `admin.roles`    |
| `admin.setRolePermissions` | mutation | `admin.roles`    |
| `admin.auditLog`           | query    | `admin.audit`    |
| `admin.securityEvents`     | query    | `admin.audit`    |
| `admin.outboxEvents`       | query    | `admin.jobs`     |
| `admin.retryOutbox`        | mutation | `admin.jobs`     |
| `admin.listPolicies`       | query    | `admin.settings` |
| `admin.publishPolicy`      | mutation | `admin.settings` |
| `admin.systemHealth`       | query    | `admin.jobs`     |
| `admin.retentionRuns`      | query    | `admin.settings` |
| `admin.planRetention`      | mutation | `admin.settings` |
| `admin.approveRetention`   | mutation | `admin.settings` |
| `admin.executeRetention`   | mutation | `admin.settings` |

### approval (`src/server/api/routers/approval.ts`)

| 프로시저                      | 종류     | 필요 권한        |
| ----------------------------- | -------- | ---------------- |
| `approval.inbox`              | query    | `approval.use`   |
| `approval.pendingCount`       | query    | `approval.use`   |
| `approval.detail`             | query    | `approval.use`   |
| `approval.forms`              | query    | `approval.use`   |
| `approval.draft`              | mutation | `approval.use`   |
| `approval.submit`             | mutation | `approval.use`   |
| `approval.approve`            | mutation | `approval.use`   |
| `approval.reject`             | mutation | `approval.use`   |
| `approval.hold`               | mutation | `approval.use`   |
| `approval.releaseHold`        | mutation | `approval.use`   |
| `approval.withdraw`           | mutation | `approval.use`   |
| `approval.resubmit`           | mutation | `approval.use`   |
| `approval.requestCancel`      | mutation | `approval.use`   |
| `approval.listFormVersions`   | query    | `approval.admin` |
| `approval.publishFormVersion` | mutation | `approval.admin` |
| `approval.lineTemplates`      | query    | `approval.use`   |
| `approval.rules`              | query    | `approval.admin` |
| `approval.listDelegations`    | query    | `approval.use`   |
| `approval.setDelegation`      | mutation | `approval.use`   |
| `approval.endDelegation`      | mutation | `approval.use`   |
| `approval.targetTypes`        | query    | `approval.admin` |

### attachment (`src/server/api/routers/attachment.ts`)

| 프로시저                 | 종류     | 필요 권한                         |
| ------------------------ | -------- | --------------------------------- |
| `attachment.list`        | query    | (인증 필요 — 별도 업무 권한 없음) |
| `attachment.upload`      | mutation | (인증 필요 — 별도 업무 권한 없음) |
| `attachment.downloadUrl` | mutation | (인증 필요 — 별도 업무 권한 없음) |
| `attachment.remove`      | mutation | (인증 필요 — 별도 업무 권한 없음) |

### auth (`src/server/api/routers/auth.ts`)

| 프로시저                | 종류     | 필요 권한                         |
| ----------------------- | -------- | --------------------------------- |
| `auth.me`               | query    | (공개 — 인증 불필요)              |
| `auth.changePassword`   | mutation | (인증 필요 — 별도 업무 권한 없음) |
| `auth.unlockUser`       | mutation | `admin.users`                     |
| `auth.resetPassword`    | mutation | `admin.users`                     |
| `auth.revokeSessions`   | mutation | `admin.users`                     |
| `auth.revokeMySessions` | mutation | (인증 필요 — 별도 업무 권한 없음) |
| `auth.sessions`         | query    | (인증 필요 — 별도 업무 권한 없음) |

### hrm (`src/server/api/routers/hrm.ts`)

| 프로시저                    | 종류     | 필요 권한                         |
| --------------------------- | -------- | --------------------------------- |
| `hrm.list`                  | query    | `hr.self`                         |
| `hrm.detail`                | query    | `hr.self`                         |
| `hrm.me`                    | query    | (인증 필요 — 별도 업무 권한 없음) |
| `hrm.create`                | mutation | `hr.write`                        |
| `hrm.update`                | mutation | `hr.write`                        |
| `hrm.resign`                | mutation | `hr.write`                        |
| `hrm.overview`              | query    | `hr.read`                         |
| `hrm.setSensitive`          | mutation | `hr.sensitive.read`               |
| `hrm.revealSensitive`       | mutation | `hr.sensitive.read`               |
| `hrm.sensitiveAccessLog`    | query    | `hr.sensitive.read`               |
| `hrm.requestChange`         | mutation | (인증 필요 — 별도 업무 권한 없음) |
| `hrm.reviewChange`          | mutation | `hr.write`                        |
| `hrm.orgChart`              | query    | `hr.self`                         |
| `hrm.createDepartment`      | mutation | `hr.write`                        |
| `hrm.reorganize`            | mutation | `hr.write`                        |
| `hrm.departmentHistory`     | query    | `hr.read`                         |
| `hrm.assign`                | mutation | `hr.write`                        |
| `hrm.assignmentHistory`     | query    | `hr.self`                         |
| `hrm.positionAt`            | query    | `hr.self`                         |
| `hrm.checkIn`               | mutation | (인증 필요 — 별도 업무 권한 없음) |
| `hrm.checkOut`              | mutation | (인증 필요 — 별도 업무 권한 없음) |
| `hrm.attendanceMonthly`     | query    | `hr.self`                         |
| `hrm.attendanceUpload`      | mutation | `hr.attendance`                   |
| `hrm.requestCorrection`     | mutation | (인증 필요 — 별도 업무 권한 없음) |
| `hrm.listCorrections`       | query    | `hr.self`                         |
| `hrm.leaveBalance`          | query    | `hr.self`                         |
| `hrm.grantAnnual`           | mutation | `hr.leave`                        |
| `hrm.grantManual`           | mutation | `hr.leave`                        |
| `hrm.requestLeave`          | mutation | (인증 필요 — 별도 업무 권한 없음) |
| `hrm.listLeaveRequests`     | query    | `hr.self`                         |
| `hrm.cancelLeave`           | mutation | `hr.leave`                        |
| `hrm.expireGrants`          | mutation | `hr.leave`                        |
| `hrm.leaveUsageSummary`     | query    | `hr.read`                         |
| `hrm.issueCertificate`      | mutation | `hr.self`                         |
| `hrm.certificateHistory`    | query    | `hr.self`                         |
| `hrm.pendingChangeRequests` | query    | `hr.write`                        |

### inventory (`src/server/api/routers/inventory.ts`)

| 프로시저                       | 종류     | 필요 권한             |
| ------------------------------ | -------- | --------------------- |
| `inventory.documents`          | query    | `inventory.read`      |
| `inventory.document`           | query    | `inventory.read`      |
| `inventory.createDocument`     | mutation | `inventory.write`     |
| `inventory.updateDocument`     | mutation | `inventory.write`     |
| `inventory.confirmDocument`    | mutation | `inventory.confirm`   |
| `inventory.cancelDocument`     | mutation | `inventory.cancel`    |
| `inventory.submitForApproval`  | mutation | `inventory.write`     |
| `inventory.submitCancellation` | mutation | `inventory.cancel`    |
| `inventory.shipTransfer`       | mutation | `inventory.write`     |
| `inventory.onHand`             | query    | `inventory.read`      |
| `inventory.book`               | query    | `inventory.read`      |
| `inventory.bookCsv`            | query    | `inventory.export`    |
| `inventory.safetyStock`        | query    | `inventory.read`      |
| `inventory.counts`             | query    | `inventory.read`      |
| `inventory.count`              | query    | `inventory.read`      |
| `inventory.createCount`        | mutation | `inventory.count`     |
| `inventory.startCount`         | mutation | `inventory.count`     |
| `inventory.recordCount`        | mutation | `inventory.count`     |
| `inventory.approveCount`       | mutation | `inventory.count`     |
| `inventory.cancelCount`        | mutation | `inventory.count`     |
| `inventory.periods`            | query    | `inventory.read`      |
| `inventory.closePreview`       | query    | `inventory.read`      |
| `inventory.closePeriod`        | mutation | `inventory.valuation` |
| `inventory.reopenPeriod`       | mutation | `inventory.valuation` |
| `inventory.reconcile`          | query    | `inventory.valuation` |
| `inventory.rebuildSnapshot`    | mutation | `inventory.valuation` |

### master (`src/server/api/routers/master.ts`)

| 프로시저                     | 종류     | 필요 권한        |
| ---------------------------- | -------- | ---------------- |
| `master.items`               | query    | `master.read`    |
| `master.item`                | query    | `master.read`    |
| `master.searchItems`         | query    | `master.read`    |
| `master.createItem`          | mutation | `master.write`   |
| `master.updateItem`          | mutation | `master.write`   |
| `master.setItemActive`       | mutation | `master.write`   |
| `master.deleteItem`          | mutation | `master.write`   |
| `master.itemCategories`      | query    | `master.read`    |
| `master.createItemCategory`  | mutation | `master.write`   |
| `master.partners`            | query    | `master.read`    |
| `master.partner`             | query    | `master.read`    |
| `master.searchPartners`      | query    | `master.read`    |
| `master.createPartner`       | mutation | `master.write`   |
| `master.updatePartner`       | mutation | `master.write`   |
| `master.setPartnerActive`    | mutation | `master.write`   |
| `master.deletePartner`       | mutation | `master.write`   |
| `master.warehouses`          | query    | `master.read`    |
| `master.createWarehouse`     | mutation | `master.write`   |
| `master.updateWarehouse`     | mutation | `master.write`   |
| `master.divisions`           | query    | `master.read`    |
| `master.createDivision`      | mutation | `master.write`   |
| `master.updateDivision`      | mutation | `master.write`   |
| `master.codeGroups`          | query    | `master.read`    |
| `master.codes`               | query    | `master.read`    |
| `master.upsertCode`          | mutation | `master.write`   |
| `master.deactivateCode`      | mutation | `master.write`   |
| `master.numberingRules`      | query    | `master.read`    |
| `master.createNumberingRule` | mutation | `admin.settings` |
| `master.updateNumberingRule` | mutation | `admin.settings` |
| `master.changeHistory`       | query    | `master.read`    |
| `master.importTemplate`      | query    | `master.read`    |
| `master.validateImport`      | mutation | `master.write`   |
| `master.applyImport`         | mutation | `master.write`   |
| `master.importBatches`       | query    | `master.read`    |

### migration (`src/server/api/routers/migration.ts`)

| 프로시저               | 종류     | 필요 권한         |
| ---------------------- | -------- | ----------------- |
| `migration.template`   | query    | `admin.migration` |
| `migration.batches`    | query    | `admin.migration` |
| `migration.validate`   | mutation | `admin.migration` |
| `migration.applyBatch` | mutation | `admin.migration` |
| `migration.reconcile`  | query    | `admin.migration` |

### notification (`src/server/api/routers/notification.ts`)

| 프로시저                   | 종류     | 필요 권한                         |
| -------------------------- | -------- | --------------------------------- |
| `notification.list`        | query    | (인증 필요 — 별도 업무 권한 없음) |
| `notification.unreadCount` | query    | (인증 필요 — 별도 업무 권한 없음) |
| `notification.markRead`    | mutation | (인증 필요 — 별도 업무 권한 없음) |
| `notification.markAllRead` | mutation | (인증 필요 — 별도 업무 권한 없음) |

### preference (`src/server/api/routers/preference.ts`)

| 프로시저            | 종류     | 필요 권한                         |
| ------------------- | -------- | --------------------------------- |
| `preference.get`    | query    | (인증 필요 — 별도 업무 권한 없음) |
| `preference.list`   | query    | (인증 필요 — 별도 업무 권한 없음) |
| `preference.set`    | mutation | (인증 필요 — 별도 업무 권한 없음) |
| `preference.remove` | mutation | (인증 필요 — 별도 업무 권한 없음) |

### report (`src/server/api/routers/report.ts`)

| 프로시저                    | 종류  | 필요 권한     |
| --------------------------- | ----- | ------------- |
| `report.salesTrend`         | query | `report.read` |
| `report.itemRanking`        | query | `report.read` |
| `report.partnerPerformance` | query | `report.read` |
| `report.stockStatus`        | query | `report.read` |
| `report.openItems`          | query | `report.read` |
| `report.approvalStats`      | query | `report.read` |
| `report.workforce`          | query | `report.read` |
| `report.dashboard`          | query | `report.read` |
| `report.drillDown`          | query | `report.read` |

### sales (`src/server/api/routers/sales.ts`)

| 프로시저                                   | 종류     | 필요 권한            |
| ------------------------------------------ | -------- | -------------------- |
| `sales.quotations`                         | query    | `sales.read`         |
| `sales.quotation`                          | query    | `sales.read`         |
| `sales.createQuotation`                    | mutation | `sales.write`        |
| `sales.updateQuotation`                    | mutation | `sales.write`        |
| `sales.copyQuotation`                      | mutation | `sales.write`        |
| `sales.setQuotationStatus`                 | mutation | `sales.write`        |
| `sales.convertQuotationToOrder`            | mutation | `sales.write`        |
| `sales.salesOrders`                        | query    | `sales.read`         |
| `sales.salesOrder`                         | query    | `sales.read`         |
| `sales.createSalesOrder`                   | mutation | `sales.write`        |
| `sales.cancelSalesOrder`                   | mutation | `sales.write`        |
| `sales.salesDocuments`                     | query    | `sales.read`         |
| `sales.salesDocument`                      | query    | `sales.read`         |
| `sales.createSalesDocument`                | mutation | `sales.write`        |
| `sales.updateSalesDocument`                | mutation | `sales.write`        |
| `sales.confirmSalesDocument`               | mutation | `sales.confirm`      |
| `sales.cancelSalesDocument`                | mutation | `sales.cancel`       |
| `sales.submitSalesDocumentForApproval`     | mutation | `sales.write`        |
| `sales.submitSalesDocumentCancellation`    | mutation | `sales.cancel`       |
| `sales.submitPurchaseDocumentForApproval`  | mutation | `purchase.write`     |
| `sales.submitPurchaseDocumentCancellation` | mutation | `purchase.cancel`    |
| `sales.taxInvoice`                         | query    | `sales.read`         |
| `sales.issueTaxInvoice`                    | mutation | `sales.write`        |
| `sales.taxInvoiceHistory`                  | query    | `sales.read`         |
| `sales.purchaseRequests`                   | query    | `purchase.read`      |
| `sales.purchaseRequest`                    | query    | `purchase.read`      |
| `sales.createPurchaseRequest`              | mutation | `purchase.write`     |
| `sales.convertRequestToOrder`              | mutation | `purchase.write`     |
| `sales.purchaseOrders`                     | query    | `purchase.read`      |
| `sales.purchaseOrder`                      | query    | `purchase.read`      |
| `sales.purchaseDocuments`                  | query    | `purchase.read`      |
| `sales.purchaseDocument`                   | query    | `purchase.read`      |
| `sales.createPurchaseDocument`             | mutation | `purchase.write`     |
| `sales.confirmPurchaseDocument`            | mutation | `purchase.confirm`   |
| `sales.cancelPurchaseDocument`             | mutation | `purchase.cancel`    |
| `sales.aging`                              | query    | `settlement.read`    |
| `sales.payableSummary`                     | query    | `settlement.read`    |
| `sales.openItems`                          | query    | `settlement.read`    |
| `sales.settlements`                        | query    | `settlement.read`    |
| `sales.settlement`                         | query    | `settlement.read`    |
| `sales.createSettlement`                   | mutation | `settlement.write`   |
| `sales.autoAllocate`                       | mutation | `settlement.write`   |
| `sales.reallocate`                         | mutation | `settlement.write`   |
| `sales.confirmSettlement`                  | mutation | `settlement.confirm` |
| `sales.cancelSettlement`                   | mutation | `settlement.confirm` |

## 정적 분석 한계

모든 프로시저의 권한을 정적으로 해석했고, 라우터가 요구하는 모든 권한 코드가 카탈로그에 존재한다.
