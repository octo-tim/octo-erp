# API 명세 (tRPC Routers)

> 생성: `node tools/docs-api.mjs` — 원본은 `src/server/api/routers/*.ts`(정적 AST 분석, 실행하지 않음). 이 파일을 직접 편집하지 않는다.

생성 시각: 2026-08-31T07:06:24.532Z · 라우터 13개 · 프로시저 258개

## 전송 규약

- **프로토콜**: tRPC v11, HTTP 하나의 엔드포인트(`src/server/api/root.ts`의 `appRouter`). 라우터마다 하나의 네임스페이스(`trpc.<mountKey>.<procedure>`)로 노출된다.
- **직렬화 (INT-01)**: `src/server/api/transformer.ts`의 커스텀 transformer가 superjson 대신 쓰인다 — Prisma `Decimal`과 `Date`를 문자열로 직렬화하므로, 금액·수량·일시는 클라이언트에서 항상 정밀 문자열/ISO 문자열로 온다. 요청 입력도 동일한 이유로 `decimalString`류 zod 스키마가 문자열을 받는다.
- **에러 형태**: 업무 오류는 `src/server/core/errors.ts`의 `AppError(code, message, meta)`이고, `src/server/api/trpc.ts`의 tRPC `errorFormatter`가 이를 `error.data.appCode`와 `error.data.meta`로 노출한다(표준 tRPC `error.data.code`/`error.message`는 그대로 유지). 클라이언트는 `shape.data?.appCode`로 분기한다(예: `VERSION_CONFLICT`일 때 재조회 후 재시도 안내).

**`appCode` 값** (`src/server/core/errors.ts`의 `ErrorCodes`에서 자동 추출, 23개):

`UNAUTHENTICATED`, `FORBIDDEN`, `OUT_OF_SCOPE`, `NOT_FOUND`, `VALIDATION`, `CONFLICT`, `VERSION_CONFLICT`, `REQUEST_IN_PROGRESS`, `DUPLICATE_EFFECT`, `INVALID_TRANSITION`, `IMMUTABLE`, `PERIOD_CLOSED`, `INSUFFICIENT_STOCK`, `CREDIT_LIMIT_EXCEEDED`, `APPROVAL_REQUIRED`, `CANCEL_BLOCKED`, `OVER_ALLOCATION`, `MASTER_IN_USE`, `UNBALANCED_JOURNAL`, `POLICY_MISSING`, `ACCOUNT_LOCKED`, `RATE_LIMITED`, `INTERNAL`

**`appCode` → HTTP 상태** (`httpStatusFor`, 명시되지 않은 코드는 기본값 409):

| appCode                 | HTTP 상태 |
| ----------------------- | --------- |
| `UNAUTHENTICATED`       | 401       |
| `FORBIDDEN`             | 403       |
| `OUT_OF_SCOPE`          | 403       |
| `NOT_FOUND`             | 404       |
| `VALIDATION`            | 400       |
| `CONFLICT`              | 409       |
| `VERSION_CONFLICT`      | 409       |
| `REQUEST_IN_PROGRESS`   | 409       |
| `DUPLICATE_EFFECT`      | 409       |
| `INVALID_TRANSITION`    | 409       |
| `IMMUTABLE`             | 409       |
| `PERIOD_CLOSED`         | 409       |
| `INSUFFICIENT_STOCK`    | 409       |
| `CREDIT_LIMIT_EXCEEDED` | 409       |
| `APPROVAL_REQUIRED`     | 409       |
| `CANCEL_BLOCKED`        | 409       |
| `OVER_ALLOCATION`       | 409       |
| `MASTER_IN_USE`         | 409       |
| `UNBALANCED_JOURNAL`    | 409       |
| `POLICY_MISSING`        | 409       |
| `ACCOUNT_LOCKED`        | 409       |
| `RATE_LIMITED`          | 429       |
| `INTERNAL`              | 500       |

## 요약

| 라우터         | 프로시저                             | 종류     | 권한                              | 멱등(requestId)           |
| -------------- | ------------------------------------ | -------- | --------------------------------- | ------------------------- |
| `accounting`   | `accounts`                           | query    | `accounting.read`                 | —                         |
| `accounting`   | `postableAccounts`                   | query    | `accounting.read`                 | —                         |
| `accounting`   | `createAccount`                      | mutation | `accounting.rules`                | 예 (input.requestId)      |
| `accounting`   | `updateAccount`                      | mutation | `accounting.rules`                | 예 (input.requestId)      |
| `accounting`   | `deleteAccount`                      | mutation | `accounting.rules`                | 예 (input.requestId)      |
| `accounting`   | `accountMappings`                    | query    | `accounting.read`                 | —                         |
| `accounting`   | `setAccountMapping`                  | mutation | `accounting.rules`                | 예 (input.requestId)      |
| `accounting`   | `postingRules`                       | query    | `accounting.read`                 | —                         |
| `accounting`   | `publishPostingRule`                 | mutation | `accounting.rules`                | 예 (input.requestId)      |
| `accounting`   | `previewPostingRule`                 | query    | `accounting.read`                 | —                         |
| `accounting`   | `entries`                            | query    | `accounting.read`                 | —                         |
| `accounting`   | `entriesCsv`                         | query    | `accounting.read`                 | —                         |
| `accounting`   | `entry`                              | query    | `accounting.read`                 | —                         |
| `accounting`   | `createEntry`                        | mutation | `accounting.write`                | 예 (input.requestId)      |
| `accounting`   | `updateEntry`                        | mutation | `accounting.write`                | 예 (input.requestId)      |
| `accounting`   | `confirmEntry`                       | mutation | `accounting.confirm`              | 예 (input.requestId)      |
| `accounting`   | `cancelEntry`                        | mutation | `accounting.cancel`               | 예 (input.requestId)      |
| `accounting`   | `submitEntryForApproval`             | mutation | `accounting.write`                | 예 (input.requestId)      |
| `accounting`   | `submitEntryCancellation`            | mutation | `accounting.cancel`               | 예 (input.requestId)      |
| `accounting`   | `accountLedger`                      | query    | `accounting.read`                 | —                         |
| `accounting`   | `trialBalance`                       | query    | `accounting.read`                 | —                         |
| `accounting`   | `incomeStatement`                    | query    | `accounting.read`                 | —                         |
| `accounting`   | `incomeByDivision`                   | query    | `accounting.read`                 | —                         |
| `accounting`   | `balanceSheet`                       | query    | `accounting.read`                 | —                         |
| `accounting`   | `trialBalanceCsv`                    | query    | `accounting.export`               | —                         |
| `accounting`   | `accountLedgerCsv`                   | query    | `accounting.export`               | —                         |
| `accounting`   | `periods`                            | query    | `accounting.read`                 | —                         |
| `accounting`   | `closeMonth`                         | mutation | `accounting.close`                | 예 (input.requestId)      |
| `accounting`   | `reopenPeriod`                       | mutation | `period.reopen`                   | 예 (input.requestId)      |
| `accounting`   | `yearClosePreview`                   | query    | `accounting.read`                 | —                         |
| `accounting`   | `closeYear`                          | mutation | `accounting.close`                | 예 (input.requestId)      |
| `accounting`   | `closingRuns`                        | query    | `accounting.read`                 | —                         |
| `accounting`   | `openingBalances`                    | query    | `accounting.read`                 | —                         |
| `admin`        | `listUsers`                          | query    | `admin.users`                     | —                         |
| `admin`        | `createUser`                         | mutation | `admin.users`                     | 예 (input.requestId)      |
| `admin`        | `updateUserAccess`                   | mutation | `admin.users`                     | 예 (input.requestId)      |
| `admin`        | `listRoles`                          | query    | `admin.roles`                     | —                         |
| `admin`        | `listPermissions`                    | query    | `admin.roles`                     | —                         |
| `admin`        | `setRolePermissions`                 | mutation | `admin.roles`                     | 예 (input.requestId)      |
| `admin`        | `auditLog`                           | query    | `admin.audit`                     | —                         |
| `admin`        | `securityEvents`                     | query    | `admin.audit`                     | —                         |
| `admin`        | `outboxEvents`                       | query    | `admin.jobs`                      | —                         |
| `admin`        | `retryOutbox`                        | mutation | `admin.jobs`                      | 예 (input.requestId)      |
| `admin`        | `listPolicies`                       | query    | `admin.settings`                  | —                         |
| `admin`        | `publishPolicy`                      | mutation | `admin.settings`                  | 예 (input.requestId)      |
| `admin`        | `systemHealth`                       | query    | `admin.jobs`                      | —                         |
| `admin`        | `retentionRuns`                      | query    | `admin.settings`                  | —                         |
| `admin`        | `planRetention`                      | mutation | `admin.settings`                  | 예 (input.requestId)      |
| `admin`        | `approveRetention`                   | mutation | `admin.settings`                  | 예 (input.requestId)      |
| `admin`        | `executeRetention`                   | mutation | `admin.settings`                  | 예 (input.requestId)      |
| `approval`     | `inbox`                              | query    | `approval.use`                    | —                         |
| `approval`     | `inboxCsv`                           | query    | `approval.use`                    | —                         |
| `approval`     | `pendingCount`                       | query    | `approval.use`                    | —                         |
| `approval`     | `detail`                             | query    | `approval.use`                    | —                         |
| `approval`     | `forms`                              | query    | `approval.use`                    | —                         |
| `approval`     | `draft`                              | mutation | `approval.use`                    | 예 (input.requestId)      |
| `approval`     | `submit`                             | mutation | `approval.use`                    | 예 (input.requestId)      |
| `approval`     | `previewLine`                        | query    | `approval.use`                    | —                         |
| `approval`     | `listApprovers`                      | query    | `approval.use`                    | —                         |
| `approval`     | `approve`                            | mutation | `approval.use`                    | 예 (input.requestId)      |
| `approval`     | `reject`                             | mutation | `approval.use`                    | 예 (input.requestId)      |
| `approval`     | `hold`                               | mutation | `approval.use`                    | 예 (input.requestId)      |
| `approval`     | `releaseHold`                        | mutation | `approval.use`                    | 예 (input.requestId)      |
| `approval`     | `withdraw`                           | mutation | `approval.use`                    | 예 (input.requestId)      |
| `approval`     | `resubmit`                           | mutation | `approval.use`                    | 예 (input.requestId)      |
| `approval`     | `requestCancel`                      | mutation | `approval.use`                    | 예 (input.requestId)      |
| `approval`     | `listFormVersions`                   | query    | `approval.admin`                  | —                         |
| `approval`     | `publishFormVersion`                 | mutation | `approval.admin`                  | 예 (input.requestId)      |
| `approval`     | `lineTemplates`                      | query    | `approval.use`                    | —                         |
| `approval`     | `rules`                              | query    | `approval.admin`                  | —                         |
| `approval`     | `listDelegations`                    | query    | `approval.use`                    | —                         |
| `approval`     | `setDelegation`                      | mutation | `approval.use`                    | 예 (input.requestId)      |
| `approval`     | `endDelegation`                      | mutation | `approval.use`                    | 예 (input.requestId)      |
| `approval`     | `targetTypes`                        | query    | `approval.admin`                  | —                         |
| `attachment`   | `list`                               | query    | (인증 필요 — 별도 업무 권한 없음) | —                         |
| `attachment`   | `upload`                             | mutation | (인증 필요 — 별도 업무 권한 없음) | 예 (input.requestId)      |
| `attachment`   | `downloadUrl`                        | mutation | (인증 필요 — 별도 업무 권한 없음) | 아니오                    |
| `attachment`   | `remove`                             | mutation | (인증 필요 — 별도 업무 권한 없음) | 예 (input.requestId)      |
| `auth`         | `me`                                 | query    | (공개 — 인증 불필요)              | —                         |
| `auth`         | `changePassword`                     | mutation | (인증 필요 — 별도 업무 권한 없음) | 아니오                    |
| `auth`         | `unlockUser`                         | mutation | `admin.users`                     | 예 (input.requestId)      |
| `auth`         | `resetPassword`                      | mutation | `admin.users`                     | 예 (input.requestId)      |
| `auth`         | `revokeSessions`                     | mutation | `admin.users`                     | 아니오                    |
| `auth`         | `revokeMySessions`                   | mutation | (인증 필요 — 별도 업무 권한 없음) | 아니오                    |
| `auth`         | `sessions`                           | query    | (인증 필요 — 별도 업무 권한 없음) | —                         |
| `hrm`          | `list`                               | query    | `hr.self`                         | —                         |
| `hrm`          | `listCsv`                            | query    | `hr.self`                         | —                         |
| `hrm`          | `detail`                             | query    | `hr.self`                         | —                         |
| `hrm`          | `me`                                 | query    | (인증 필요 — 별도 업무 권한 없음) | —                         |
| `hrm`          | `create`                             | mutation | `hr.write`                        | 예 (input.requestId)      |
| `hrm`          | `update`                             | mutation | `hr.write`                        | 예 (input.requestId)      |
| `hrm`          | `resign`                             | mutation | `hr.write`                        | 예 (input.requestId)      |
| `hrm`          | `overview`                           | query    | `hr.read`                         | —                         |
| `hrm`          | `setSensitive`                       | mutation | `hr.sensitive.read`               | 예 (input.requestId)      |
| `hrm`          | `revealSensitive`                    | mutation | `hr.sensitive.read`               | 아니오                    |
| `hrm`          | `sensitiveAccessLog`                 | query    | `hr.sensitive.read`               | —                         |
| `hrm`          | `requestChange`                      | mutation | (인증 필요 — 별도 업무 권한 없음) | 예 (input.requestId)      |
| `hrm`          | `reviewChange`                       | mutation | `hr.write`                        | 예 (input.idempotencyKey) |
| `hrm`          | `orgChart`                           | query    | `hr.self`                         | —                         |
| `hrm`          | `createDepartment`                   | mutation | `hr.write`                        | 예 (input.requestId)      |
| `hrm`          | `reorganize`                         | mutation | `hr.write`                        | 예 (input.requestId)      |
| `hrm`          | `departmentHistory`                  | query    | `hr.read`                         | —                         |
| `hrm`          | `assign`                             | mutation | `hr.write`                        | 예 (input.requestId)      |
| `hrm`          | `assignmentHistory`                  | query    | `hr.self`                         | —                         |
| `hrm`          | `positionAt`                         | query    | `hr.self`                         | —                         |
| `hrm`          | `checkIn`                            | mutation | (인증 필요 — 별도 업무 권한 없음) | 예 (input.requestId)      |
| `hrm`          | `checkOut`                           | mutation | (인증 필요 — 별도 업무 권한 없음) | 예 (input.requestId)      |
| `hrm`          | `attendanceMonthly`                  | query    | `hr.self`                         | —                         |
| `hrm`          | `attendanceUpload`                   | mutation | `hr.attendance`                   | 예 (input.requestId)      |
| `hrm`          | `requestCorrection`                  | mutation | (인증 필요 — 별도 업무 권한 없음) | 예 (input.requestId)      |
| `hrm`          | `listCorrections`                    | query    | `hr.self`                         | —                         |
| `hrm`          | `leaveBalance`                       | query    | `hr.self`                         | —                         |
| `hrm`          | `grantAnnual`                        | mutation | `hr.leave`                        | 예 (input.requestId)      |
| `hrm`          | `grantManual`                        | mutation | `hr.leave`                        | 예 (input.requestId)      |
| `hrm`          | `requestLeave`                       | mutation | (인증 필요 — 별도 업무 권한 없음) | 예 (input.requestId)      |
| `hrm`          | `listLeaveRequests`                  | query    | `hr.self`                         | —                         |
| `hrm`          | `cancelLeave`                        | mutation | `hr.leave`                        | 예 (input.requestId)      |
| `hrm`          | `expireGrants`                       | mutation | `hr.leave`                        | 예 (input.requestId)      |
| `hrm`          | `leaveUsageSummary`                  | query    | `hr.read`                         | —                         |
| `hrm`          | `issueCertificate`                   | mutation | `hr.self`                         | 예 (input.requestId)      |
| `hrm`          | `certificateHistory`                 | query    | `hr.self`                         | —                         |
| `hrm`          | `pendingChangeRequests`              | query    | `hr.write`                        | —                         |
| `inventory`    | `documents`                          | query    | `inventory.read`                  | —                         |
| `inventory`    | `document`                           | query    | `inventory.read`                  | —                         |
| `inventory`    | `createDocument`                     | mutation | `inventory.write`                 | 예 (input.requestId)      |
| `inventory`    | `updateDocument`                     | mutation | `inventory.write`                 | 예 (input.requestId)      |
| `inventory`    | `confirmDocument`                    | mutation | `inventory.confirm`               | 예 (input.requestId)      |
| `inventory`    | `cancelDocument`                     | mutation | `inventory.cancel`                | 예 (input.requestId)      |
| `inventory`    | `submitForApproval`                  | mutation | `inventory.write`                 | 예 (input.requestId)      |
| `inventory`    | `submitCancellation`                 | mutation | `inventory.cancel`                | 예 (input.requestId)      |
| `inventory`    | `shipTransfer`                       | mutation | `inventory.write`                 | 예 (input.requestId)      |
| `inventory`    | `onHand`                             | query    | `inventory.read`                  | —                         |
| `inventory`    | `book`                               | query    | `inventory.read`                  | —                         |
| `inventory`    | `bookCsv`                            | query    | `inventory.export`                | —                         |
| `inventory`    | `safetyStock`                        | query    | `inventory.read`                  | —                         |
| `inventory`    | `counts`                             | query    | `inventory.read`                  | —                         |
| `inventory`    | `countsCsv`                          | query    | `inventory.read`                  | —                         |
| `inventory`    | `count`                              | query    | `inventory.read`                  | —                         |
| `inventory`    | `createCount`                        | mutation | `inventory.count`                 | 예 (input.requestId)      |
| `inventory`    | `startCount`                         | mutation | `inventory.count`                 | 예 (input.requestId)      |
| `inventory`    | `recordCount`                        | mutation | `inventory.count`                 | 예 (input.requestId)      |
| `inventory`    | `approveCount`                       | mutation | `inventory.count`                 | 예 (input.requestId)      |
| `inventory`    | `cancelCount`                        | mutation | `inventory.count`                 | 예 (input.requestId)      |
| `inventory`    | `periods`                            | query    | `inventory.read`                  | —                         |
| `inventory`    | `closePreview`                       | query    | `inventory.read`                  | —                         |
| `inventory`    | `closePeriod`                        | mutation | `inventory.valuation`             | 예 (input.requestId)      |
| `inventory`    | `reopenPeriod`                       | mutation | `inventory.valuation`             | 예 (input.requestId)      |
| `inventory`    | `reconcile`                          | query    | `inventory.valuation`             | —                         |
| `inventory`    | `rebuildSnapshot`                    | mutation | `inventory.valuation`             | 예 (input.requestId)      |
| `master`       | `items`                              | query    | `master.read`                     | —                         |
| `master`       | `itemsCsv`                           | query    | `master.read`                     | —                         |
| `master`       | `item`                               | query    | `master.read`                     | —                         |
| `master`       | `searchItems`                        | query    | `master.read`                     | —                         |
| `master`       | `createItem`                         | mutation | `master.write`                    | 예 (input.requestId)      |
| `master`       | `updateItem`                         | mutation | `master.write`                    | 예 (input.requestId)      |
| `master`       | `setItemActive`                      | mutation | `master.write`                    | 예 (input.requestId)      |
| `master`       | `deleteItem`                         | mutation | `master.write`                    | 예 (input.requestId)      |
| `master`       | `itemCategories`                     | query    | `master.read`                     | —                         |
| `master`       | `createItemCategory`                 | mutation | `master.write`                    | 예 (input.requestId)      |
| `master`       | `partners`                           | query    | `master.read`                     | —                         |
| `master`       | `partnersCsv`                        | query    | `master.read`                     | —                         |
| `master`       | `partner`                            | query    | `master.read`                     | —                         |
| `master`       | `searchPartners`                     | query    | `master.read`                     | —                         |
| `master`       | `createPartner`                      | mutation | `master.write`                    | 예 (input.requestId)      |
| `master`       | `updatePartner`                      | mutation | `master.write`                    | 예 (input.requestId)      |
| `master`       | `setPartnerActive`                   | mutation | `master.write`                    | 예 (input.requestId)      |
| `master`       | `deletePartner`                      | mutation | `master.write`                    | 예 (input.requestId)      |
| `master`       | `warehouses`                         | query    | `master.read`                     | —                         |
| `master`       | `createWarehouse`                    | mutation | `master.write`                    | 예 (input.requestId)      |
| `master`       | `updateWarehouse`                    | mutation | `master.write`                    | 예 (input.requestId)      |
| `master`       | `divisions`                          | query    | `master.read`                     | —                         |
| `master`       | `createDivision`                     | mutation | `master.write`                    | 예 (input.requestId)      |
| `master`       | `updateDivision`                     | mutation | `master.write`                    | 예 (input.requestId)      |
| `master`       | `codeGroups`                         | query    | `master.read`                     | —                         |
| `master`       | `codes`                              | query    | `master.read`                     | —                         |
| `master`       | `upsertCode`                         | mutation | `master.write`                    | 예 (input.requestId)      |
| `master`       | `deactivateCode`                     | mutation | `master.write`                    | 예 (input.requestId)      |
| `master`       | `numberingRules`                     | query    | `master.read`                     | —                         |
| `master`       | `createNumberingRule`                | mutation | `admin.settings`                  | 예 (input.requestId)      |
| `master`       | `updateNumberingRule`                | mutation | `admin.settings`                  | 예 (input.requestId)      |
| `master`       | `changeHistory`                      | query    | `master.read`                     | —                         |
| `master`       | `importTemplate`                     | query    | `master.read`                     | —                         |
| `master`       | `validateImport`                     | mutation | `master.write`                    | 예 (input.requestId)      |
| `master`       | `applyImport`                        | mutation | `master.write`                    | 예 (input.requestId)      |
| `master`       | `importBatches`                      | query    | `master.read`                     | —                         |
| `migration`    | `template`                           | query    | `admin.migration`                 | —                         |
| `migration`    | `batches`                            | query    | `admin.migration`                 | —                         |
| `migration`    | `validate`                           | mutation | `admin.migration`                 | 예 (input.requestId)      |
| `migration`    | `applyBatch`                         | mutation | `admin.migration`                 | 예 (input.requestId)      |
| `migration`    | `reconcile`                          | query    | `admin.migration`                 | —                         |
| `notification` | `list`                               | query    | (인증 필요 — 별도 업무 권한 없음) | —                         |
| `notification` | `unreadCount`                        | query    | (인증 필요 — 별도 업무 권한 없음) | —                         |
| `notification` | `markRead`                           | mutation | (인증 필요 — 별도 업무 권한 없음) | 아니오                    |
| `notification` | `markAllRead`                        | mutation | (인증 필요 — 별도 업무 권한 없음) | 아니오                    |
| `preference`   | `get`                                | query    | (인증 필요 — 별도 업무 권한 없음) | —                         |
| `preference`   | `list`                               | query    | (인증 필요 — 별도 업무 권한 없음) | —                         |
| `preference`   | `set`                                | mutation | (인증 필요 — 별도 업무 권한 없음) | 아니오                    |
| `preference`   | `remove`                             | mutation | (인증 필요 — 별도 업무 권한 없음) | 아니오                    |
| `report`       | `salesTrend`                         | query    | `report.read`                     | —                         |
| `report`       | `itemRanking`                        | query    | `report.read`                     | —                         |
| `report`       | `partnerPerformance`                 | query    | `report.read`                     | —                         |
| `report`       | `stockStatus`                        | query    | `report.read`                     | —                         |
| `report`       | `openItems`                          | query    | `report.read`                     | —                         |
| `report`       | `approvalStats`                      | query    | `report.read`                     | —                         |
| `report`       | `workforce`                          | query    | `report.read`                     | —                         |
| `report`       | `dashboard`                          | query    | `report.read`                     | —                         |
| `report`       | `drillDown`                          | query    | `report.read`                     | —                         |
| `sales`        | `quotations`                         | query    | `sales.read`                      | —                         |
| `sales`        | `quotationsCsv`                      | query    | `sales.read`                      | —                         |
| `sales`        | `quotation`                          | query    | `sales.read`                      | —                         |
| `sales`        | `createQuotation`                    | mutation | `sales.write`                     | 예 (input.requestId)      |
| `sales`        | `updateQuotation`                    | mutation | `sales.write`                     | 예 (input.requestId)      |
| `sales`        | `copyQuotation`                      | mutation | `sales.write`                     | 예 (input.requestId)      |
| `sales`        | `setQuotationStatus`                 | mutation | `sales.write`                     | 예 (input.requestId)      |
| `sales`        | `convertQuotationToOrder`            | mutation | `sales.write`                     | 예 (input.requestId)      |
| `sales`        | `salesOrders`                        | query    | `sales.read`                      | —                         |
| `sales`        | `salesOrdersCsv`                     | query    | `sales.read`                      | —                         |
| `sales`        | `salesOrder`                         | query    | `sales.read`                      | —                         |
| `sales`        | `createSalesOrder`                   | mutation | `sales.write`                     | 예 (input.requestId)      |
| `sales`        | `cancelSalesOrder`                   | mutation | `sales.write`                     | 예 (input.requestId)      |
| `sales`        | `salesDocuments`                     | query    | `sales.read`                      | —                         |
| `sales`        | `salesDocumentsCsv`                  | query    | `sales.read`                      | —                         |
| `sales`        | `salesDocument`                      | query    | `sales.read`                      | —                         |
| `sales`        | `createSalesDocument`                | mutation | `sales.write`                     | 예 (input.requestId)      |
| `sales`        | `updateSalesDocument`                | mutation | `sales.write`                     | 예 (input.requestId)      |
| `sales`        | `confirmSalesDocument`               | mutation | `sales.confirm`                   | 예 (input.requestId)      |
| `sales`        | `cancelSalesDocument`                | mutation | `sales.cancel`                    | 예 (input.requestId)      |
| `sales`        | `submitSalesDocumentForApproval`     | mutation | `sales.write`                     | 예 (input.requestId)      |
| `sales`        | `submitSalesDocumentCancellation`    | mutation | `sales.cancel`                    | 예 (input.requestId)      |
| `sales`        | `submitPurchaseDocumentForApproval`  | mutation | `purchase.write`                  | 예 (input.requestId)      |
| `sales`        | `submitPurchaseDocumentCancellation` | mutation | `purchase.cancel`                 | 예 (input.requestId)      |
| `sales`        | `taxInvoice`                         | query    | `sales.read`                      | —                         |
| `sales`        | `issueTaxInvoice`                    | mutation | `sales.write`                     | 예 (input.requestId)      |
| `sales`        | `taxInvoiceHistory`                  | query    | `sales.read`                      | —                         |
| `sales`        | `purchaseRequests`                   | query    | `purchase.read`                   | —                         |
| `sales`        | `purchaseRequestsCsv`                | query    | `purchase.read`                   | —                         |
| `sales`        | `purchaseRequest`                    | query    | `purchase.read`                   | —                         |
| `sales`        | `createPurchaseRequest`              | mutation | `purchase.write`                  | 예 (input.requestId)      |
| `sales`        | `convertRequestToOrder`              | mutation | `purchase.write`                  | 예 (input.idempotencyKey) |
| `sales`        | `purchaseOrders`                     | query    | `purchase.read`                   | —                         |
| `sales`        | `purchaseOrdersCsv`                  | query    | `purchase.read`                   | —                         |
| `sales`        | `purchaseOrder`                      | query    | `purchase.read`                   | —                         |
| `sales`        | `purchaseDocuments`                  | query    | `purchase.read`                   | —                         |
| `sales`        | `purchaseDocumentsCsv`               | query    | `purchase.read`                   | —                         |
| `sales`        | `purchaseDocument`                   | query    | `purchase.read`                   | —                         |
| `sales`        | `createPurchaseDocument`             | mutation | `purchase.write`                  | 예 (input.requestId)      |
| `sales`        | `confirmPurchaseDocument`            | mutation | `purchase.confirm`                | 예 (input.requestId)      |
| `sales`        | `cancelPurchaseDocument`             | mutation | `purchase.cancel`                 | 예 (input.requestId)      |
| `sales`        | `aging`                              | query    | `settlement.read`                 | —                         |
| `sales`        | `payableSummary`                     | query    | `settlement.read`                 | —                         |
| `sales`        | `openItems`                          | query    | `settlement.read`                 | —                         |
| `sales`        | `settlements`                        | query    | `settlement.read`                 | —                         |
| `sales`        | `settlement`                         | query    | `settlement.read`                 | —                         |
| `sales`        | `createSettlement`                   | mutation | `settlement.write`                | 예 (input.requestId)      |
| `sales`        | `autoAllocate`                       | mutation | `settlement.write`                | 예 (input.requestId)      |
| `sales`        | `reallocate`                         | mutation | `settlement.write`                | 예 (input.requestId)      |
| `sales`        | `confirmSettlement`                  | mutation | `settlement.confirm`              | 예 (input.requestId)      |
| `sales`        | `cancelSettlement`                   | mutation | `settlement.confirm`              | 예 (input.requestId)      |

## 라우터별 상세

### accounting (`src/server/api/routers/accounting.ts`)

#### `accounting.accounts` — query

- 권한: `accounting.read`
- 멱등(requestId): 해당 없음 (query)
- 입력:
  - `q`: 문자열 (trim, max 200) — 선택
  - `activeOnly`: 불리언 — 선택, 기본값=false

#### `accounting.postableAccounts` — query

- 권한: `accounting.read`
- 멱등(requestId): 해당 없음 (query)
- 입력:
  (입력 없음)

#### `accounting.createAccount` — mutation

- 권한: `accounting.rules`
- 멱등(requestId): 예 — 3번째 인자로 `tx()`에 전달됨 (`input.requestId`)
- 입력:
  - `code`: 문자열 (min 3, max 8) — 필수
  - `name`: 문자열 (min 1, max 60) — 필수
  - `accountType`: enum(ASSET | LIABILITY | EQUITY | REVENUE | EXPENSE) — 필수
  - `parentId`: 문자열 (min 1) — 선택
  - `note`: 문자열 (max 300) — 선택
  - `requestId`: 문자열 (uuid) — 필수, 멱등성 키

#### `accounting.updateAccount` — mutation

- 권한: `accounting.rules`
- 멱등(requestId): 예 — 3번째 인자로 `tx()`에 전달됨 (`input.requestId`)
- 입력:
  - `id`: 문자열 (min 1) — 필수
  - `version`: 숫자 (int) — 필수
  - `name`: 문자열 (min 1, max 60) — 선택
  - `note`: 문자열 (max 300) — 선택
  - `isActive`: 불리언 — 선택
  - `sortOrder`: 숫자 (int) — 선택
  - `requestId`: 문자열 (uuid) — 필수, 멱등성 키

#### `accounting.deleteAccount` — mutation

- 권한: `accounting.rules`
- 멱등(requestId): 예 — 3번째 인자로 `tx()`에 전달됨 (`input.requestId`)
- 입력:
  - `id`: 문자열 (min 1) — 필수
  - `requestId`: 문자열 (uuid) — 필수, 멱등성 키

#### `accounting.accountMappings` — query

- 권한: `accounting.read`
- 멱등(requestId): 해당 없음 (query)
- 입력:
  (입력 없음)

#### `accounting.setAccountMapping` — mutation

- 권한: `accounting.rules`
- 멱등(requestId): 예 — 3번째 인자로 `tx()`에 전달됨 (`input.requestId`)
- 입력:
  - `slot`: 문자열 (min 1, max 40) — 필수
  - `accountId`: 문자열 (min 1) — 필수
  - `requestId`: 문자열 (uuid) — 필수, 멱등성 키

#### `accounting.postingRules` — query

- 권한: `accounting.read`
- 멱등(requestId): 해당 없음 (query)
- 입력:
  (입력 없음)

#### `accounting.publishPostingRule` — mutation

- 권한: `accounting.rules`
- 멱등(requestId): 예 — 3번째 인자로 `tx()`에 전달됨 (`input.requestId`)
- 입력:
  - `code`: 문자열 (min 1, max 40) — 필수
  - `effectiveFrom`: 문자열 (regex /^\d{4}-\d{2}-\d{2}$/) — 필수
  - `template`: 배열 (min 2, max 20) — 필수
    배열 원소:
    - `slot`: 문자열 (min 1, max 40) — 필수
    - `side`: enum(DEBIT | CREDIT) — 필수
    - `amountKey`: 문자열 (min 1, max 40) — 필수
    - `description`: 문자열 (max 100) — 선택
  - `note`: 문자열 (max 300) — 선택
  - `requestId`: 문자열 (uuid) — 필수, 멱등성 키

#### `accounting.previewPostingRule` — query

- 권한: `accounting.read`
- 멱등(requestId): 해당 없음 (query)
- 입력:
  - `code`: 문자열 (min 1, max 40) — 필수
  - `onDate`: 문자열 (regex /^\d{4}-\d{2}-\d{2}$/) — 필수
  - `amounts`: record<문자열, 정밀 소수 문자열 (scale=0, 비음수)> — 필수

#### `accounting.entries` — query

- 권한: `accounting.read`
- 멱등(requestId): 해당 없음 (query)
- 입력:
  - `page`: 숫자 (int, min 1) — 선택, 기본값=1
  - `pageSize`: 숫자 (int, min 1, max 200) — 선택, 기본값=50
  - `sortBy`: 문자열 — 선택
  - `sortDir`: enum(asc | desc) — 선택, 기본값='desc'
  - `from`: 문자열 (regex /^\d{4}-\d{2}-\d{2}$/) — 선택
  - `to`: 문자열 (regex /^\d{4}-\d{2}-\d{2}$/) — 선택
  - `status`: 문자열 — 선택
  - `entryType`: enum(TRANSFER | RECEIPT | PAYMENT) — 선택
  - `accountId`: 문자열 (min 1) — 선택
  - `divisionId`: 문자열 (min 1) — 선택
  - `q`: 문자열 (trim, max 200) — 선택

#### `accounting.entriesCsv` — query

- 권한: `accounting.read`
- 멱등(requestId): 해당 없음 (query)
- 입력:
  - `from`: 문자열 (regex /^\d{4}-\d{2}-\d{2}$/) — 선택
  - `to`: 문자열 (regex /^\d{4}-\d{2}-\d{2}$/) — 선택
  - `status`: 문자열 — 선택
  - `entryType`: enum(TRANSFER | RECEIPT | PAYMENT) — 선택
  - `accountId`: 문자열 (min 1) — 선택
  - `divisionId`: 문자열 (min 1) — 선택
  - `q`: 문자열 (trim, max 200) — 선택

#### `accounting.entry` — query

- 권한: `accounting.read`
- 멱등(requestId): 해당 없음 (query)
- 입력:
  - `id`: 문자열 (min 1) — 필수

#### `accounting.createEntry` — mutation

- 권한: `accounting.write`
- 멱등(requestId): 예 — 3번째 인자로 `tx()`에 전달됨 (`input.requestId`)
- 입력:
  - `entryType`: enum(TRANSFER | RECEIPT | PAYMENT) — 선택
  - `entryDate`: 문자열 (regex /^\d{4}-\d{2}-\d{2}$/) — 선택
  - `description`: 문자열 (max 500) — 선택
  - `lines`: 배열 (min 2, max 200) — 필수
    배열 원소:
    - `accountId`: 문자열 (min 1) — 필수
    - `debit`: 정밀 소수 문자열 (scale=0, 비음수) — 선택
    - `credit`: 정밀 소수 문자열 (scale=0, 비음수) — 선택
    - `description`: 문자열 (max 200) — 선택
    - `divisionId`: 문자열 (min 1) — 선택
    - `partnerId`: 문자열 (min 1) — 선택
  - `requestId`: 문자열 (uuid) — 필수, 멱등성 키

#### `accounting.updateEntry` — mutation

- 권한: `accounting.write`
- 멱등(requestId): 예 — 3번째 인자로 `tx()`에 전달됨 (`input.requestId`)
- 입력:
  - `entryType`: enum(TRANSFER | RECEIPT | PAYMENT) — 선택
  - `entryDate`: 문자열 (regex /^\d{4}-\d{2}-\d{2}$/) — 선택
  - `description`: 문자열 (max 500) — 선택
  - `lines`: 배열 (min 2, max 200) — 필수
    배열 원소:
    - `accountId`: 문자열 (min 1) — 필수
    - `debit`: 정밀 소수 문자열 (scale=0, 비음수) — 선택
    - `credit`: 정밀 소수 문자열 (scale=0, 비음수) — 선택
    - `description`: 문자열 (max 200) — 선택
    - `divisionId`: 문자열 (min 1) — 선택
    - `partnerId`: 문자열 (min 1) — 선택
  - `id`: 문자열 (min 1) — 필수
  - `version`: 숫자 (int) — 필수
  - `requestId`: 문자열 (uuid) — 필수, 멱등성 키

#### `accounting.confirmEntry` — mutation

- 권한: `accounting.confirm`
- 멱등(requestId): 예 — 3번째 인자로 `tx()`에 전달됨 (`input.requestId`)
- 입력:
  - `id`: 문자열 (min 1) — 필수
  - `version`: 숫자 (int) — 필수
  - `requestId`: 문자열 (uuid) — 필수, 멱등성 키

#### `accounting.cancelEntry` — mutation

- 권한: `accounting.cancel`
- 멱등(requestId): 예 — 3번째 인자로 `tx()`에 전달됨 (`input.requestId`)
- 입력:
  - `id`: 문자열 (min 1) — 필수
  - `reason`: 문자열 (min 2, max 200) — 필수
  - `version`: 숫자 (int) — 필수
  - `requestId`: 문자열 (uuid) — 필수, 멱등성 키

#### `accounting.submitEntryForApproval` — mutation

- 권한: `accounting.write`
- 멱등(requestId): 예 — 3번째 인자로 `tx()`에 전달됨 (`input.requestId`)
- 입력:
  - `id`: 문자열 (min 1) — 필수
  - `version`: 숫자 (int) — 필수
  - `note`: 문자열 (max 500) — 선택
  - `lineTemplateId`: 문자열 (min 1) — 선택
  - `requestId`: 문자열 (uuid) — 필수, 멱등성 키

#### `accounting.submitEntryCancellation` — mutation

- 권한: `accounting.cancel`
- 멱등(requestId): 예 — 3번째 인자로 `tx()`에 전달됨 (`input.requestId`)
- 입력:
  - `id`: 문자열 (min 1) — 필수
  - `reason`: 문자열 (min 2, max 200) — 필수
  - `requestId`: 문자열 (uuid) — 필수, 멱등성 키

#### `accounting.accountLedger` — query

- 권한: `accounting.read`
- 멱등(requestId): 해당 없음 (query)
- 입력:
  - `accountId`: 문자열 (min 1) — 필수
  - `from`: 문자열 (regex /^\d{4}-\d{2}-\d{2}$/) — 필수
  - `to`: 문자열 (regex /^\d{4}-\d{2}-\d{2}$/) — 필수
  - `divisionId`: 문자열 (min 1) — 선택

#### `accounting.trialBalance` — query

- 권한: `accounting.read`
- 멱등(requestId): 해당 없음 (query)
- 입력:
  - `from`: 문자열 (regex /^\d{4}-\d{2}-\d{2}$/) — 필수
  - `to`: 문자열 (regex /^\d{4}-\d{2}-\d{2}$/) — 필수
  - `divisionId`: 문자열 (min 1) — 선택
  - `hideZero`: 불리언 — 선택, 기본값=true

#### `accounting.incomeStatement` — query

- 권한: `accounting.read`
- 멱등(requestId): 해당 없음 (query)
- 입력:
  - `period`: 문자열 (regex /^\d{4}-\d{2}$/) — 필수
  - `comparePeriod`: 문자열 (regex /^\d{4}-\d{2}$/) — 선택
  - `divisionId`: 문자열 (min 1) — 선택

#### `accounting.incomeByDivision` — query

- 권한: `accounting.read`
- 멱등(requestId): 해당 없음 (query)
- 입력:
  - `period`: 문자열 (regex /^\d{4}-\d{2}$/) — 필수

#### `accounting.balanceSheet` — query

- 권한: `accounting.read`
- 멱등(requestId): 해당 없음 (query)
- 입력:
  - `asOf`: 문자열 (regex /^\d{4}-\d{2}-\d{2}$/) — 필수
  - `divisionId`: 문자열 (min 1) — 선택

#### `accounting.trialBalanceCsv` — query

- 권한: `accounting.export`
- 멱등(requestId): 해당 없음 (query)
- 입력:
  - `from`: 문자열 (regex /^\d{4}-\d{2}-\d{2}$/) — 필수
  - `to`: 문자열 (regex /^\d{4}-\d{2}-\d{2}$/) — 필수
  - `divisionId`: 문자열 (min 1) — 선택

#### `accounting.accountLedgerCsv` — query

- 권한: `accounting.export`
- 멱등(requestId): 해당 없음 (query)
- 입력:
  - `accountId`: 문자열 (min 1) — 필수
  - `from`: 문자열 (regex /^\d{4}-\d{2}-\d{2}$/) — 필수
  - `to`: 문자열 (regex /^\d{4}-\d{2}-\d{2}$/) — 필수
  - `divisionId`: 문자열 (min 1) — 선택

#### `accounting.periods` — query

- 권한: `accounting.read`
- 멱등(requestId): 해당 없음 (query)
- 입력:
  (입력 없음)

#### `accounting.closeMonth` — mutation

- 권한: `accounting.close`
- 멱등(requestId): 예 — 3번째 인자로 `tx()`에 전달됨 (`input.requestId`)
- 입력:
  - `periodKey`: 문자열 (regex /^\d{4}-\d{2}$/) — 필수
  - `requestId`: 문자열 (uuid) — 필수, 멱등성 키

#### `accounting.reopenPeriod` — mutation

- 권한: `period.reopen`
- 멱등(requestId): 예 — 3번째 인자로 `tx()`에 전달됨 (`input.requestId`)
- 입력:
  - `periodKey`: 문자열 (regex /^\d{4}-\d{2}$/) — 필수
  - `reason`: 문자열 (min 5, max 200) — 필수
  - `requestId`: 문자열 (uuid) — 필수, 멱등성 키

#### `accounting.yearClosePreview` — query

- 권한: `accounting.read`
- 멱등(requestId): 해당 없음 (query)
- 입력:
  - `year`: 문자열 (regex /^\d{4}$/) — 필수

#### `accounting.closeYear` — mutation

- 권한: `accounting.close`
- 멱등(requestId): 예 — 3번째 인자로 `tx()`에 전달됨 (`input.requestId`)
- 입력:
  - `year`: 문자열 (regex /^\d{4}$/) — 필수
  - `requestId`: 문자열 (uuid) — 필수, 멱등성 키

#### `accounting.closingRuns` — query

- 권한: `accounting.read`
- 멱등(requestId): 해당 없음 (query)
- 입력:
  (입력 없음)

#### `accounting.openingBalances` — query

- 권한: `accounting.read`
- 멱등(requestId): 해당 없음 (query)
- 입력:
  - `periodKey`: 문자열 (regex /^\d{4}-\d{2}$/) — 필수

### admin (`src/server/api/routers/admin.ts`)

#### `admin.listUsers` — query

- 권한: `admin.users`
- 멱등(requestId): 해당 없음 (query)
- 입력:
  - `page`: 숫자 (int, min 1) — 선택, 기본값=1
  - `pageSize`: 숫자 (int, min 1, max 200) — 선택, 기본값=50
  - `sortBy`: 문자열 — 선택
  - `sortDir`: enum(asc | desc) — 선택, 기본값='desc'
  - `q`: 문자열 (trim) — 선택
  - `activeOnly`: 불리언 — 선택, 기본값=false

#### `admin.createUser` — mutation

- 권한: `admin.users`
- 멱등(requestId): 예 — 3번째 인자로 `tx()`에 전달됨 (`input.requestId`)
- 입력:
  - `username`: 문자열 (min 3, max 50, regex /^[a-z0-9._-]+$/) — 필수
  - `displayName`: 문자열 (min 1, max 50) — 필수
  - `email`: 문자열 (email) — 선택
  - `password`: 문자열 (min 10) — 필수
  - `employeeId`: 문자열 (min 1) — 선택
  - `roleCodes`: 배열 (min 1) — 필수
    → 원소 타입: 문자열
  - `divisionIds`: 배열 — 선택, 기본값=[]
    → 원소 타입: 문자열 (min 1)
  - `warehouseIds`: 배열 — 선택, 기본값=[]
    → 원소 타입: 문자열 (min 1)
  - `requestId`: 문자열 (uuid) — 필수, 멱등성 키

#### `admin.updateUserAccess` — mutation

- 권한: `admin.users`
- 멱등(requestId): 예 — 3번째 인자로 `tx()`에 전달됨 (`input.requestId`)
- 입력:
  - `userId`: 문자열 (min 1) — 필수
  - `roleCodes`: 배열 (min 1) — 필수
    → 원소 타입: 문자열
  - `divisionIds`: 배열 — 필수
    → 원소 타입: 문자열 (min 1)
  - `warehouseIds`: 배열 — 필수
    → 원소 타입: 문자열 (min 1)
  - `isActive`: 불리언 — 필수
  - `requestId`: 문자열 (uuid) — 필수, 멱등성 키

#### `admin.listRoles` — query

- 권한: `admin.roles`
- 멱등(requestId): 해당 없음 (query)
- 입력:
  (입력 없음)

#### `admin.listPermissions` — query

- 권한: `admin.roles`
- 멱등(requestId): 해당 없음 (query)
- 입력:
  (입력 없음)

#### `admin.setRolePermissions` — mutation

- 권한: `admin.roles`
- 멱등(requestId): 예 — 3번째 인자로 `tx()`에 전달됨 (`input.requestId`)
- 입력:
  - `roleId`: 문자열 (min 1) — 필수
  - `permissionCodes`: 배열 — 필수
    → 원소 타입: 문자열
  - `requestId`: 문자열 (uuid) — 필수, 멱등성 키

#### `admin.auditLog` — query

- 권한: `admin.audit`
- 멱등(requestId): 해당 없음 (query)
- 입력:
  - `page`: 숫자 (int, min 1) — 선택, 기본값=1
  - `pageSize`: 숫자 (int, min 1, max 200) — 선택, 기본값=50
  - `sortBy`: 문자열 — 선택
  - `sortDir`: enum(asc | desc) — 선택, 기본값='desc'
  - `entityType`: 문자열 — 선택
  - `entityId`: 문자열 — 선택
  - `actorId`: 문자열 (min 1) — 선택
  - `action`: 문자열 — 선택
  - `from`: 문자열 (regex /^\d{4}-\d{2}-\d{2}$/) — 선택
  - `to`: 문자열 (regex /^\d{4}-\d{2}-\d{2}$/) — 선택

#### `admin.securityEvents` — query

- 권한: `admin.audit`
- 멱등(requestId): 해당 없음 (query)
- 입력:
  - `page`: 숫자 (int, min 1) — 선택, 기본값=1
  - `pageSize`: 숫자 (int, min 1, max 200) — 선택, 기본값=50
  - `sortBy`: 문자열 — 선택
  - `sortDir`: enum(asc | desc) — 선택, 기본값='desc'
  - `type`: 문자열 — 선택

#### `admin.outboxEvents` — query

- 권한: `admin.jobs`
- 멱등(requestId): 해당 없음 (query)
- 입력:
  - `page`: 숫자 (int, min 1) — 선택, 기본값=1
  - `pageSize`: 숫자 (int, min 1, max 200) — 선택, 기본값=50
  - `sortBy`: 문자열 — 선택
  - `sortDir`: enum(asc | desc) — 선택, 기본값='desc'
  - `status`: enum(PENDING | PROCESSING | DONE | FAILED) — 선택

#### `admin.retryOutbox` — mutation

- 권한: `admin.jobs`
- 멱등(requestId): 예 — 3번째 인자로 `tx()`에 전달됨 (`input.requestId`)
- 입력:
  - `ids`: 배열 (min 1, max 100) — 필수
    → 원소 타입: 문자열 (min 1)
  - `requestId`: 문자열 (uuid) — 필수, 멱등성 키

#### `admin.listPolicies` — query

- 권한: `admin.settings`
- 멱등(requestId): 해당 없음 (query)
- 입력:
  - `key`: 문자열 — 선택

#### `admin.publishPolicy` — mutation

- 권한: `admin.settings`
- 멱등(requestId): 예 — 3번째 인자로 `tx()`에 전달됨 (`input.requestId`)
- 입력:
  - `key`: enum(inventory.valuation | money | approval.matrix | accounting.period | leave | retention | notification) — 필수
  - `effectiveFrom`: 문자열 (regex /^\d{4}-\d{2}-\d{2}$/) — 필수
  - `config`: record<문자열, 임의 값(unknown)> — 필수
  - `note`: 문자열 (max 500) — 선택
  - `requestId`: 문자열 (uuid) — 필수, 멱등성 키

#### `admin.systemHealth` — query

- 권한: `admin.jobs`
- 멱등(requestId): 해당 없음 (query)
- 입력:
  (입력 없음)

#### `admin.retentionRuns` — query

- 권한: `admin.settings`
- 멱등(requestId): 해당 없음 (query)
- 입력:
  - `take`: 숫자 (int, min 1, max 100) — 선택, 기본값=20

#### `admin.planRetention` — mutation

- 권한: `admin.settings`
- 멱등(requestId): 예 — 3번째 인자로 `tx()`에 전달됨 (`input.requestId`)
- 입력:
  - `requestId`: 문자열 (uuid) — 필수, 멱등성 키

#### `admin.approveRetention` — mutation

- 권한: `admin.settings`
- 멱등(requestId): 예 — 3번째 인자로 `tx()`에 전달됨 (`input.requestId`)
- 입력:
  - `runId`: 문자열 (min 1) — 필수
  - `requestId`: 문자열 (uuid) — 필수, 멱등성 키

#### `admin.executeRetention` — mutation

- 권한: `admin.settings`
- 멱등(requestId): 예 — 3번째 인자로 `tx()`에 전달됨 (`input.requestId`)
- 입력:
  - `runId`: 문자열 (min 1) — 필수
  - `requestId`: 문자열 (uuid) — 필수, 멱등성 키

### approval (`src/server/api/routers/approval.ts`)

#### `approval.inbox` — query

- 권한: `approval.use`
- 멱등(requestId): 해당 없음 (query)
- 입력:
  - `page`: 숫자 (int, min 1) — 선택, 기본값=1
  - `pageSize`: 숫자 (int, min 1, max 200) — 선택, 기본값=50
  - `sortBy`: 문자열 — 선택
  - `sortDir`: enum(asc | desc) — 선택, 기본값='desc'
  - `inbox`: enum(DRAFTED | PENDING | IN_PROGRESS | COMPLETED | REJECTED | REFERENCE) — 필수
  - `q`: 문자열 (trim, max 100) — 선택
  - `from`: 문자열 (regex /^\d{4}-\d{2}-\d{2}$/) — 선택
  - `to`: 문자열 (regex /^\d{4}-\d{2}-\d{2}$/) — 선택

#### `approval.inboxCsv` — query

- 권한: `approval.use`
- 멱등(requestId): 해당 없음 (query)
- 입력:
  - `inbox`: enum(DRAFTED | PENDING | IN_PROGRESS | COMPLETED | REJECTED | REFERENCE) — 필수
  - `q`: 문자열 (trim, max 100) — 선택
  - `from`: 문자열 (regex /^\d{4}-\d{2}-\d{2}$/) — 선택
  - `to`: 문자열 (regex /^\d{4}-\d{2}-\d{2}$/) — 선택

#### `approval.pendingCount` — query

- 권한: `approval.use`
- 멱등(requestId): 해당 없음 (query)
- 입력:
  (입력 없음)

#### `approval.detail` — query

- 권한: `approval.use`
- 멱등(requestId): 해당 없음 (query)
- 입력:
  - `documentId`: 문자열 (min 1) — 필수

#### `approval.forms` — query

- 권한: `approval.use`
- 멱등(requestId): 해당 없음 (query)
- 입력:
  (입력 없음)

#### `approval.draft` — mutation

- 권한: `approval.use`
- 멱등(requestId): 예 — 3번째 인자로 `tx()`에 전달됨 (`input.requestId`)
- 입력:
  - `formCode`: 문자열 (min 1, max 50) — 필수
  - `title`: 문자열 (min 1, max 200) — 필수
  - `content`: record<문자열, 임의 값(unknown)> — 필수
  - `amount`: 정밀 소수 문자열 (scale=0, 비음수) — 선택
  - `divisionId`: 문자열 (min 1) — 선택
  - `departmentId`: 문자열 (min 1) — 선택
  - `target`: object — 선택
    - `targetType`: 문자열 (min 1, max 50) — 필수
    - `targetId`: 문자열 (min 1) — 필수
    - `targetVersion`: 숫자 (int, min 1) — 필수
  - `requestId`: 문자열 (uuid) — 필수, 멱등성 키

#### `approval.submit` — mutation

- 권한: `approval.use`
- 멱등(requestId): 예 — 3번째 인자로 `tx()`에 전달됨 (`input.requestId`)
- 입력:
  - `documentId`: 문자열 (min 1) — 필수
  - `version`: 숫자 (int) — 필수
  - `lineTemplateId`: 문자열 (min 1) — 선택
  - `lineOverride`: 배열 (min 1, max 20) — 선택
    배열 원소:
    - `approverId`: 문자열 (min 1) — 필수
    - `role`: enum(APPROVE | AGREE | REFERENCE) — 필수
  - `requestId`: 문자열 (uuid) — 필수, 멱등성 키

#### `approval.previewLine` — query

- 권한: `approval.use`
- 멱등(requestId): 해당 없음 (query)
- 입력:
  - `documentId`: 문자열 (min 1) — 필수

#### `approval.listApprovers` — query

- 권한: `approval.use`
- 멱등(requestId): 해당 없음 (query)
- 입력:
  (입력 없음)

#### `approval.approve` — mutation

- 권한: `approval.use`
- 멱등(requestId): 예 — 3번째 인자로 `tx()`에 전달됨 (`input.requestId`)
- 입력:
  - `documentId`: 문자열 (min 1) — 필수
  - `version`: 숫자 (int) — 필수
  - `comment`: 문자열 (max 500) — 선택
  - `requestId`: 문자열 (uuid) — 필수, 멱등성 키

#### `approval.reject` — mutation

- 권한: `approval.use`
- 멱등(requestId): 예 — 3번째 인자로 `tx()`에 전달됨 (`input.requestId`)
- 입력:
  - `documentId`: 문자열 (min 1) — 필수
  - `version`: 숫자 (int) — 필수
  - `comment`: 문자열 (min 2, max 500) — 필수
  - `requestId`: 문자열 (uuid) — 필수, 멱등성 키

#### `approval.hold` — mutation

- 권한: `approval.use`
- 멱등(requestId): 예 — 3번째 인자로 `tx()`에 전달됨 (`input.requestId`)
- 입력:
  - `documentId`: 문자열 (min 1) — 필수
  - `version`: 숫자 (int) — 필수
  - `comment`: 문자열 (min 2, max 500) — 필수
  - `requestId`: 문자열 (uuid) — 필수, 멱등성 키

#### `approval.releaseHold` — mutation

- 권한: `approval.use`
- 멱등(requestId): 예 — 3번째 인자로 `tx()`에 전달됨 (`input.requestId`)
- 입력:
  - `documentId`: 문자열 (min 1) — 필수
  - `version`: 숫자 (int) — 필수
  - `requestId`: 문자열 (uuid) — 필수, 멱등성 키

#### `approval.withdraw` — mutation

- 권한: `approval.use`
- 멱등(requestId): 예 — 3번째 인자로 `tx()`에 전달됨 (`input.requestId`)
- 입력:
  - `documentId`: 문자열 (min 1) — 필수
  - `version`: 숫자 (int) — 필수
  - `reason`: 문자열 (max 200) — 선택
  - `requestId`: 문자열 (uuid) — 필수, 멱등성 키

#### `approval.resubmit` — mutation

- 권한: `approval.use`
- 멱등(requestId): 예 — 3번째 인자로 `tx()`에 전달됨 (`input.requestId`)
- 입력:
  - `documentId`: 문자열 (min 1) — 필수
  - `version`: 숫자 (int) — 필수
  - `title`: 문자열 (max 200) — 선택
  - `content`: record<문자열, 임의 값(unknown)> — 선택
  - `amount`: 정밀 소수 문자열 (scale=0, 비음수) — 선택
  - `requestId`: 문자열 (uuid) — 필수, 멱등성 키

#### `approval.requestCancel` — mutation

- 권한: `approval.use`
- 멱등(requestId): 예 — 3번째 인자로 `tx()`에 전달됨 (`input.requestId`)
- 입력:
  - `documentId`: 문자열 (min 1) — 필수
  - `reason`: 문자열 (min 2, max 200) — 필수
  - `requestId`: 문자열 (uuid) — 필수, 멱등성 키

#### `approval.listFormVersions` — query

- 권한: `approval.admin`
- 멱등(requestId): 해당 없음 (query)
- 입력:
  - `formCode`: 문자열 — 선택

#### `approval.publishFormVersion` — mutation

- 권한: `approval.admin`
- 멱등(requestId): 예 — 3번째 인자로 `tx()`에 전달됨 (`input.requestId`)
- 입력:
  - `formCode`: 문자열 (min 1, max 50) — 필수
  - `fieldSchema`: 배열 — 필수
    배열 원소:
    - `key`: 문자열 (min 1, max 50) — 필수
    - `label`: 문자열 (min 1, max 50) — 필수
    - `type`: enum(text | textarea | number | money | date | select | checkbox) — 필수
    - `required`: 불리언 — 선택
    - `options`: 배열 — 선택
      배열 원소:
      - `value`: 문자열 — 필수
      - `label`: 문자열 — 필수
    - `max`: 숫자 (int) — 선택
  - `effectiveFrom`: 문자열 (regex /^\d{4}-\d{2}-\d{2}$/) — 필수
  - `requestId`: 문자열 (uuid) — 필수, 멱등성 키

#### `approval.lineTemplates` — query

- 권한: `approval.use`
- 멱등(requestId): 해당 없음 (query)
- 입력:
  (입력 없음)

#### `approval.rules` — query

- 권한: `approval.admin`
- 멱등(requestId): 해당 없음 (query)
- 입력:
  (입력 없음)

#### `approval.listDelegations` — query

- 권한: `approval.use`
- 멱등(requestId): 해당 없음 (query)
- 입력:
  (입력 없음)

#### `approval.setDelegation` — mutation

- 권한: `approval.use`
- 멱등(requestId): 예 — 3번째 인자로 `tx()`에 전달됨 (`input.requestId`)
- 입력:
  - `toUserId`: 문자열 (min 1) — 필수
  - `validFrom`: 문자열 (regex /^\d{4}-\d{2}-\d{2}$/) — 필수
  - `validTo`: 문자열 (regex /^\d{4}-\d{2}-\d{2}$/) — 필수
  - `reason`: 문자열 (max 200) — 선택
  - `requestId`: 문자열 (uuid) — 필수, 멱등성 키

#### `approval.endDelegation` — mutation

- 권한: `approval.use`
- 멱등(requestId): 예 — 3번째 인자로 `tx()`에 전달됨 (`input.requestId`)
- 입력:
  - `delegationId`: 문자열 (min 1) — 필수
  - `requestId`: 문자열 (uuid) — 필수, 멱등성 키

#### `approval.targetTypes` — query

- 권한: `approval.admin`
- 멱등(requestId): 해당 없음 (query)
- 입력:
  (입력 없음)

### attachment (`src/server/api/routers/attachment.ts`)

#### `attachment.list` — query

- 권한: (인증 필요 — 별도 업무 권한 없음)
- 멱등(requestId): 해당 없음 (query)
- 입력:
  - `ownerType`: enum(ITEM | PARTNER | SALES_DOC | PURCHASE_DOC | STOCK_DOC | JOURNAL | APPROVAL_DOC | EMPLOYEE_DOC | MIGRATION) — 필수
  - `ownerId`: 문자열 (min 1) — 필수

#### `attachment.upload` — mutation

- 권한: (인증 필요 — 별도 업무 권한 없음)
- 멱등(requestId): 예 — 3번째 인자로 `tx()`에 전달됨 (`input.requestId`)
- 입력:
  - `ownerType`: enum(ITEM | PARTNER | SALES_DOC | PURCHASE_DOC | STOCK_DOC | JOURNAL | APPROVAL_DOC | EMPLOYEE_DOC | MIGRATION) — 필수
  - `ownerId`: 문자열 (min 1) — 필수
  - `originalName`: 문자열 (min 1, max 255) — 필수
  - `mimeType`: 문자열 (min 1, max 150) — 필수
  - `contentBase64`: 문자열 (min 1) — 필수
  - `requestId`: 문자열 (uuid) — 필수, 멱등성 키

#### `attachment.downloadUrl` — mutation

- 권한: (인증 필요 — 별도 업무 권한 없음)
- 멱등(requestId): 아니오 (tx() 호출은 있으나 requestId 인자 없음)
- 입력:
  - `attachmentId`: 문자열 (min 1) — 필수

#### `attachment.remove` — mutation

- 권한: (인증 필요 — 별도 업무 권한 없음)
- 멱등(requestId): 예 — 3번째 인자로 `tx()`에 전달됨 (`input.requestId`)
- 입력:
  - `attachmentId`: 문자열 (min 1) — 필수
  - `requestId`: 문자열 (uuid) — 필수, 멱등성 키

### auth (`src/server/api/routers/auth.ts`)

#### `auth.me` — query

- 권한: (공개 — 인증 불필요)
- 멱등(requestId): 해당 없음 (query)
- 입력:
  (입력 없음)

#### `auth.changePassword` — mutation

- 권한: (인증 필요 — 별도 업무 권한 없음)
- 멱등(requestId): 아니오 (tx/readTx 미호출 — 직접 처리, 원본 확인)
- 입력:
  - `currentPassword`: 문자열 (min 1) — 필수
  - `newPassword`: 문자열 (min 10) — 필수

#### `auth.unlockUser` — mutation

- 권한: `admin.users`
- 멱등(requestId): 예 — 3번째 인자로 `tx()`에 전달됨 (`input.requestId`)
- 입력:
  - `userId`: 문자열 (min 1) — 필수
  - `requestId`: 문자열 (uuid) — 필수, 멱등성 키

#### `auth.resetPassword` — mutation

- 권한: `admin.users`
- 멱등(requestId): 예 — 3번째 인자로 `tx()`에 전달됨 (`input.requestId`)
- 입력:
  - `userId`: 문자열 (min 1) — 필수
  - `temporaryPassword`: 문자열 (min 10) — 필수
  - `requestId`: 문자열 (uuid) — 필수, 멱등성 키

#### `auth.revokeSessions` — mutation

- 권한: `admin.users`
- 멱등(requestId): 아니오 (tx/readTx 미호출 — 직접 처리, 원본 확인)
- 입력:
  - `userId`: 문자열 (min 1) — 필수

#### `auth.revokeMySessions` — mutation

- 권한: (인증 필요 — 별도 업무 권한 없음)
- 멱등(requestId): 아니오 (tx/readTx 미호출 — 직접 처리, 원본 확인)
- 입력:
  (입력 없음)

#### `auth.sessions` — query

- 권한: (인증 필요 — 별도 업무 권한 없음)
- 멱등(requestId): 해당 없음 (query)
- 입력:
  (입력 없음)

### hrm (`src/server/api/routers/hrm.ts`)

#### `hrm.list` — query

- 권한: `hr.self`
- 멱등(requestId): 해당 없음 (query)
- 입력:
  - `page`: 숫자 (int, min 1) — 선택, 기본값=1
  - `pageSize`: 숫자 (int, min 1, max 200) — 선택, 기본값=50
  - `sortBy`: 문자열 — 선택
  - `sortDir`: enum(asc | desc) — 선택, 기본값='desc'
  - `q`: 문자열 (trim) — 선택
  - `departmentId`: 문자열 (min 1) — 선택
  - `status`: 문자열 — 선택

#### `hrm.listCsv` — query

- 권한: `hr.self`
- 멱등(requestId): 해당 없음 (query)
- 입력:
  - `q`: 문자열 (trim) — 선택
  - `departmentId`: 문자열 (min 1) — 선택
  - `status`: 문자열 — 선택

#### `hrm.detail` — query

- 권한: `hr.self`
- 멱등(requestId): 해당 없음 (query)
- 입력:
  - `id`: 문자열 (min 1) — 필수

#### `hrm.me` — query

- 권한: (인증 필요 — 별도 업무 권한 없음)
- 멱등(requestId): 해당 없음 (query)
- 입력:
  (입력 없음)

#### `hrm.create` — mutation

- 권한: `hr.write`
- 멱등(requestId): 예 — 3번째 인자로 `tx()`에 전달됨 (`input.requestId`)
- 입력:
  - `employeeNo`: 문자열 (max 20) — 선택
  - `name`: 문자열 (min 1, max 50) — 필수
  - `birthDate`: 문자열 (regex /^\d{4}-\d{2}-\d{2}$/) — 선택
  - `phone`: 문자열 (max 30) — 선택
  - `email`: 문자열 (email, max 100) — 선택
  - `address`: 문자열 (max 200) — 선택
  - `hireDate`: 문자열 (regex /^\d{4}-\d{2}-\d{2}$/) — 필수
  - `departmentId`: 문자열 (min 1) — 선택
  - `positionCode`: 문자열 (max 30) — 선택
  - `jobTitle`: 문자열 (max 50) — 선택
  - `employmentType`: enum(REGULAR | CONTRACT | PARTTIME | INTERN) — 선택
  - `contractEndDate`: 문자열 (regex /^\d{4}-\d{2}-\d{2}$/) — 선택
  - `requestId`: 문자열 (uuid) — 필수, 멱등성 키

#### `hrm.update` — mutation

- 권한: `hr.write`
- 멱등(requestId): 예 — 3번째 인자로 `tx()`에 전달됨 (`input.requestId`)
- 입력:
  - `employeeNo`: 문자열 (max 20) — 선택
  - `name`: 문자열 (min 1, max 50) — 선택
  - `birthDate`: 문자열 (regex /^\d{4}-\d{2}-\d{2}$/) — 선택
  - `phone`: 문자열 (max 30) — 선택
  - `email`: 문자열 (email, max 100) — 선택
  - `address`: 문자열 (max 200) — 선택
  - `hireDate`: 문자열 (regex /^\d{4}-\d{2}-\d{2}$/) — 선택
  - `departmentId`: 문자열 (min 1) — 선택
  - `positionCode`: 문자열 (max 30) — 선택
  - `jobTitle`: 문자열 (max 50) — 선택
  - `employmentType`: enum(REGULAR | CONTRACT | PARTTIME | INTERN) — 선택
  - `contractEndDate`: 문자열 (regex /^\d{4}-\d{2}-\d{2}$/) — 선택
  - `id`: 문자열 (min 1) — 필수
  - `version`: 숫자 (int) — 필수
  - `requestId`: 문자열 (uuid) — 필수, 멱등성 키

#### `hrm.resign` — mutation

- 권한: `hr.write`
- 멱등(requestId): 예 — 3번째 인자로 `tx()`에 전달됨 (`input.requestId`)
- 입력:
  - `employeeId`: 문자열 (min 1) — 필수
  - `leaveDate`: 문자열 (regex /^\d{4}-\d{2}-\d{2}$/) — 필수
  - `reason`: 문자열 (max 200) — 선택
  - `requestId`: 문자열 (uuid) — 필수, 멱등성 키

#### `hrm.overview` — query

- 권한: `hr.read`
- 멱등(requestId): 해당 없음 (query)
- 입력:
  - `asOf`: 문자열 (regex /^\d{4}-\d{2}-\d{2}$/) — 선택

#### `hrm.setSensitive` — mutation

- 권한: `hr.sensitive.read`
- 멱등(requestId): 예 — 3번째 인자로 `tx()`에 전달됨 (`input.requestId`)
- 입력:
  - `employeeId`: 문자열 (min 1) — 필수
  - `residentNo`: 문자열 (max 20) — 선택
  - `bankName`: 문자열 (max 50) — 선택
  - `bankAccount`: 문자열 (max 40) — 선택
  - `requestId`: 문자열 (uuid) — 필수, 멱등성 키

#### `hrm.revealSensitive` — mutation

- 권한: `hr.sensitive.read`
- 멱등(requestId): 아니오 (tx() 호출은 있으나 requestId 인자 없음)
- 입력:
  - `employeeId`: 문자열 (min 1) — 필수
  - `field`: enum(residentNo | bankAccount) — 필수
  - `reason`: 문자열 (min 5, max 200) — 필수

#### `hrm.sensitiveAccessLog` — query

- 권한: `hr.sensitive.read`
- 멱등(requestId): 해당 없음 (query)
- 입력:
  - `employeeId`: 문자열 (min 1) — 필수

#### `hrm.requestChange` — mutation

- 권한: (인증 필요 — 별도 업무 권한 없음)
- 멱등(requestId): 예 — 3번째 인자로 `tx()`에 전달됨 (`input.requestId`)
- 입력:
  - `changes`: record<문자열, object> — 필수
  - `requestId`: 문자열 (uuid) — 필수, 멱등성 키

#### `hrm.reviewChange` — mutation

- 권한: `hr.write`
- 멱등(requestId): 예 — 3번째 인자로 `tx()`에 전달됨 (`input.idempotencyKey`)
- 입력:
  - `requestId`: 문자열 (min 1) — 필수
  - `approve`: 불리언 — 필수
  - `note`: 문자열 (max 200) — 선택
  - `idempotencyKey`: 문자열 (uuid) — 필수, 멱등성 키

#### `hrm.orgChart` — query

- 권한: `hr.self`
- 멱등(requestId): 해당 없음 (query)
- 입력:
  - `asOf`: 문자열 (regex /^\d{4}-\d{2}-\d{2}$/) — 선택

#### `hrm.createDepartment` — mutation

- 권한: `hr.write`
- 멱등(requestId): 예 — 3번째 인자로 `tx()`에 전달됨 (`input.requestId`)
- 입력:
  - `code`: 문자열 (min 1, max 20) — 필수
  - `name`: 문자열 (min 1, max 50) — 필수
  - `parentId`: 문자열 (min 1) — 선택
  - `headEmployeeId`: 문자열 (min 1) — 선택
  - `validFrom`: 문자열 (regex /^\d{4}-\d{2}-\d{2}$/) — 필수
  - `sortOrder`: 숫자 (int) — 선택
  - `requestId`: 문자열 (uuid) — 필수, 멱등성 키

#### `hrm.reorganize` — mutation

- 권한: `hr.write`
- 멱등(requestId): 예 — 3번째 인자로 `tx()`에 전달됨 (`input.requestId`)
- 입력:
  - `departmentId`: 문자열 (min 1) — 필수
  - `effectiveDate`: 문자열 (regex /^\d{4}-\d{2}-\d{2}$/) — 필수
  - `name`: 문자열 (max 50) — 선택
  - `parentId`: 문자열 (min 1) — nullable 허용, 선택
  - `headEmployeeId`: 문자열 (min 1) — nullable 허용, 선택
  - `close`: 불리언 — 선택
  - `requestId`: 문자열 (uuid) — 필수, 멱등성 키

#### `hrm.departmentHistory` — query

- 권한: `hr.read`
- 멱등(requestId): 해당 없음 (query)
- 입력:
  - `departmentId`: 문자열 (min 1) — 선택

#### `hrm.assign` — mutation

- 권한: `hr.write`
- 멱등(requestId): 예 — 3번째 인자로 `tx()`에 전달됨 (`input.requestId`)
- 입력:
  - `employeeId`: 문자열 (min 1) — 필수
  - `type`: enum(HIRE | PROMOTION | TRANSFER | LEAVE_OF_ABSENCE | RETURN | RESIGN) — 필수
  - `effectiveFrom`: 문자열 (regex /^\d{4}-\d{2}-\d{2}$/) — 필수
  - `departmentId`: 문자열 (min 1) — 선택
  - `positionCode`: 문자열 (max 30) — 선택
  - `jobTitle`: 문자열 (max 50) — 선택
  - `employmentType`: 문자열 (max 20) — 선택
  - `note`: 문자열 (max 200) — 선택
  - `requestId`: 문자열 (uuid) — 필수, 멱등성 키

#### `hrm.assignmentHistory` — query

- 권한: `hr.self`
- 멱등(requestId): 해당 없음 (query)
- 입력:
  - `employeeId`: 문자열 (min 1) — 필수

#### `hrm.positionAt` — query

- 권한: `hr.self`
- 멱등(requestId): 해당 없음 (query)
- 입력:
  - `employeeId`: 문자열 (min 1) — 필수
  - `asOf`: 문자열 (regex /^\d{4}-\d{2}-\d{2}$/) — 필수

#### `hrm.checkIn` — mutation

- 권한: (인증 필요 — 별도 업무 권한 없음)
- 멱등(requestId): 예 — 3번째 인자로 `tx()`에 전달됨 (`input.requestId`)
- 입력:
  - `requestId`: 문자열 (uuid) — 필수, 멱등성 키

#### `hrm.checkOut` — mutation

- 권한: (인증 필요 — 별도 업무 권한 없음)
- 멱등(requestId): 예 — 3번째 인자로 `tx()`에 전달됨 (`input.requestId`)
- 입력:
  - `breakMinutes`: 숫자 (int, min 0, max 480) — 선택
  - `requestId`: 문자열 (uuid) — 필수, 멱등성 키

#### `hrm.attendanceMonthly` — query

- 권한: `hr.self`
- 멱등(requestId): 해당 없음 (query)
- 입력:
  - `employeeId`: 문자열 (min 1) — 필수
  - `from`: 문자열 (regex /^\d{4}-\d{2}-\d{2}$/) — 필수
  - `to`: 문자열 (regex /^\d{4}-\d{2}-\d{2}$/) — 필수

#### `hrm.attendanceUpload` — mutation

- 권한: `hr.attendance`
- 멱등(requestId): 예 — 3번째 인자로 `tx()`에 전달됨 (`input.requestId`)
- 입력:
  - `rows`: 배열 (min 1, max 2000) — 필수
    배열 원소:
    - `employeeNo`: 문자열 — 필수
    - `workDate`: 문자열 — 필수
    - `checkIn`: 문자열 — 선택
    - `checkOut`: 문자열 — 선택
    - `status`: enum(NORMAL | LATE | EARLY_LEAVE | ABSENT | LEAVE | HALF_LEAVE | HOLIDAY | BUSINESS_TRIP) — 선택
    - `note`: 문자열 — 선택
  - `requestId`: 문자열 (uuid) — 필수, 멱등성 키

#### `hrm.requestCorrection` — mutation

- 권한: (인증 필요 — 별도 업무 권한 없음)
- 멱등(requestId): 예 — 3번째 인자로 `tx()`에 전달됨 (`input.requestId`)
- 입력:
  - `workDate`: 문자열 (regex /^\d{4}-\d{2}-\d{2}$/) — 필수
  - `requestedCheckIn`: 문자열 (regex /^\d{2}:\d{2}$/) — 선택
  - `requestedCheckOut`: 문자열 (regex /^\d{2}:\d{2}$/) — 선택
  - `requestedStatus`: enum(NORMAL | LATE | EARLY_LEAVE | ABSENT | LEAVE | HALF_LEAVE | HOLIDAY | BUSINESS_TRIP) — 선택
  - `reason`: 문자열 (min 5, max 200) — 필수
  - `requestId`: 문자열 (uuid) — 필수, 멱등성 키

#### `hrm.listCorrections` — query

- 권한: `hr.self`
- 멱등(requestId): 해당 없음 (query)
- 입력:
  - `page`: 숫자 (int, min 1) — 선택, 기본값=1
  - `pageSize`: 숫자 (int, min 1, max 200) — 선택, 기본값=50
  - `sortBy`: 문자열 — 선택
  - `sortDir`: enum(asc | desc) — 선택, 기본값='desc'
  - `employeeId`: 문자열 (min 1) — 선택
  - `status`: 문자열 — 선택

#### `hrm.leaveBalance` — query

- 권한: `hr.self`
- 멱등(requestId): 해당 없음 (query)
- 입력:
  - `employeeId`: 문자열 (min 1) — 필수
  - `asOf`: 문자열 (regex /^\d{4}-\d{2}-\d{2}$/) — 선택
  - `leaveType`: 문자열 — 선택, 기본값='ANNUAL'

#### `hrm.grantAnnual` — mutation

- 권한: `hr.leave`
- 멱등(requestId): 예 — 3번째 인자로 `tx()`에 전달됨 (`input.requestId`)
- 입력:
  - `employeeId`: 문자열 (min 1) — 필수
  - `asOf`: 문자열 (regex /^\d{4}-\d{2}-\d{2}$/) — 선택
  - `requestId`: 문자열 (uuid) — 필수, 멱등성 키

#### `hrm.grantManual` — mutation

- 권한: `hr.leave`
- 멱등(requestId): 예 — 3번째 인자로 `tx()`에 전달됨 (`input.requestId`)
- 입력:
  - `employeeId`: 문자열 (min 1) — 필수
  - `leaveType`: 문자열 (max 20) — 선택
  - `days`: 문자열 (regex /^\d+(\.\d)?$/) — 필수
  - `grantDate`: 문자열 (regex /^\d{4}-\d{2}-\d{2}$/) — 필수
  - `expiresAt`: 문자열 (regex /^\d{4}-\d{2}-\d{2}$/) — 필수
  - `reason`: 문자열 (min 2, max 200) — 필수
  - `requestId`: 문자열 (uuid) — 필수, 멱등성 키

#### `hrm.requestLeave` — mutation

- 권한: (인증 필요 — 별도 업무 권한 없음)
- 멱등(requestId): 예 — 3번째 인자로 `tx()`에 전달됨 (`input.requestId`)
- 입력:
  - `leaveType`: 문자열 (max 20) — 선택
  - `startDate`: 문자열 (regex /^\d{4}-\d{2}-\d{2}$/) — 필수
  - `endDate`: 문자열 (regex /^\d{4}-\d{2}-\d{2}$/) — 필수
  - `halfDay`: enum(AM | PM) — 선택
  - `reason`: 문자열 (max 200) — 선택
  - `requestId`: 문자열 (uuid) — 필수, 멱등성 키

#### `hrm.listLeaveRequests` — query

- 권한: `hr.self`
- 멱등(requestId): 해당 없음 (query)
- 입력:
  - `page`: 숫자 (int, min 1) — 선택, 기본값=1
  - `pageSize`: 숫자 (int, min 1, max 200) — 선택, 기본값=50
  - `sortBy`: 문자열 — 선택
  - `sortDir`: enum(asc | desc) — 선택, 기본값='desc'
  - `employeeId`: 문자열 (min 1) — 선택
  - `status`: 문자열 — 선택
  - `from`: 문자열 (regex /^\d{4}-\d{2}-\d{2}$/) — 선택
  - `to`: 문자열 (regex /^\d{4}-\d{2}-\d{2}$/) — 선택

#### `hrm.cancelLeave` — mutation

- 권한: `hr.leave`
- 멱등(requestId): 예 — 3번째 인자로 `tx()`에 전달됨 (`input.requestId`)
- 입력:
  - `leaveRequestId`: 문자열 (min 1) — 필수
  - `reason`: 문자열 (min 2, max 200) — 필수
  - `requestId`: 문자열 (uuid) — 필수, 멱등성 키

#### `hrm.expireGrants` — mutation

- 권한: `hr.leave`
- 멱등(requestId): 예 — 3번째 인자로 `tx()`에 전달됨 (`input.requestId`)
- 입력:
  - `asOf`: 문자열 (regex /^\d{4}-\d{2}-\d{2}$/) — 선택
  - `requestId`: 문자열 (uuid) — 필수, 멱등성 키

#### `hrm.leaveUsageSummary` — query

- 권한: `hr.read`
- 멱등(requestId): 해당 없음 (query)
- 입력:
  - `from`: 문자열 (regex /^\d{4}-\d{2}-\d{2}$/) — 필수
  - `to`: 문자열 (regex /^\d{4}-\d{2}-\d{2}$/) — 필수

#### `hrm.issueCertificate` — mutation

- 권한: `hr.self`
- 멱등(requestId): 예 — 3번째 인자로 `tx()`에 전달됨 (`input.requestId`)
- 입력:
  - `employeeId`: 문자열 (min 1) — 필수
  - `certType`: enum(EMPLOYMENT | CAREER) — 필수
  - `purpose`: 문자열 (max 100) — 선택
  - `requestId`: 문자열 (uuid) — 필수, 멱등성 키

#### `hrm.certificateHistory` — query

- 권한: `hr.self`
- 멱등(requestId): 해당 없음 (query)
- 입력:
  - `employeeId`: 문자열 (min 1) — 선택
  - `take`: 숫자 (int, min 1, max 200) — 선택

#### `hrm.pendingChangeRequests` — query

- 권한: `hr.write`
- 멱등(requestId): 해당 없음 (query)
- 입력:
  - `status`: enum(PENDING | APPROVED | REJECTED) — 선택, 기본값='PENDING'

### inventory (`src/server/api/routers/inventory.ts`)

#### `inventory.documents` — query

- 권한: `inventory.read`
- 멱등(requestId): 해당 없음 (query)
- 입력:
  - `page`: 숫자 (int, min 1) — 선택, 기본값=1
  - `pageSize`: 숫자 (int, min 1, max 200) — 선택, 기본값=50
  - `sortBy`: 문자열 — 선택
  - `sortDir`: enum(asc | desc) — 선택, 기본값='desc'
  - `docType`: enum(RECEIPT | ISSUE | TRANSFER | ADJUST) — 선택
  - `status`: 문자열 — 선택
  - `warehouseId`: 문자열 (min 1) — 선택
  - `itemId`: 문자열 (min 1) — 선택
  - `from`: 문자열 (regex /^\d{4}-\d{2}-\d{2}$/) — 선택
  - `to`: 문자열 (regex /^\d{4}-\d{2}-\d{2}$/) — 선택
  - `q`: 문자열 (trim, max 200) — 선택

#### `inventory.document` — query

- 권한: `inventory.read`
- 멱등(requestId): 해당 없음 (query)
- 입력:
  - `id`: 문자열 (min 1) — 필수

#### `inventory.createDocument` — mutation

- 권한: `inventory.write`
- 멱등(requestId): 예 — 3번째 인자로 `tx()`에 전달됨 (`input.requestId`)
- 입력:
  - `docType`: enum(RECEIPT | ISSUE | TRANSFER | ADJUST) — 필수
  - `docDate`: 문자열 (regex /^\d{4}-\d{2}-\d{2}$/) — 선택
  - `fromWarehouseId`: 문자열 (min 1) — 선택
  - `toWarehouseId`: 문자열 (min 1) — 선택
  - `partnerId`: 문자열 (min 1) — 선택
  - `reasonCode`: 문자열 (max 30) — 선택
  - `divisionId`: 문자열 (min 1) — 선택
  - `note`: 문자열 (max 500) — 선택
  - `lines`: 배열 (min 1, max 500) — 필수
    배열 원소:
    - `itemId`: 문자열 (min 1) — 필수
    - `quantity`: 문자열 (trim, regex /^-?\d+(\.\d{1,3})?$/) — 필수
    - `unitCost`: 정밀 소수 문자열 (scale=4, 비음수) — 선택
    - `note`: 문자열 (max 200) — 선택
  - `requestId`: 문자열 (uuid) — 필수, 멱등성 키

#### `inventory.updateDocument` — mutation

- 권한: `inventory.write`
- 멱등(requestId): 예 — 3번째 인자로 `tx()`에 전달됨 (`input.requestId`)
- 입력:
  - `docType`: enum(RECEIPT | ISSUE | TRANSFER | ADJUST) — 필수
  - `docDate`: 문자열 (regex /^\d{4}-\d{2}-\d{2}$/) — 선택
  - `fromWarehouseId`: 문자열 (min 1) — 선택
  - `toWarehouseId`: 문자열 (min 1) — 선택
  - `partnerId`: 문자열 (min 1) — 선택
  - `reasonCode`: 문자열 (max 30) — 선택
  - `divisionId`: 문자열 (min 1) — 선택
  - `note`: 문자열 (max 500) — 선택
  - `lines`: 배열 (min 1, max 500) — 필수
    배열 원소:
    - `itemId`: 문자열 (min 1) — 필수
    - `quantity`: 문자열 (trim, regex /^-?\d+(\.\d{1,3})?$/) — 필수
    - `unitCost`: 정밀 소수 문자열 (scale=4, 비음수) — 선택
    - `note`: 문자열 (max 200) — 선택
  - `id`: 문자열 (min 1) — 필수
  - `version`: 숫자 (int) — 필수
  - `requestId`: 문자열 (uuid) — 필수, 멱등성 키

#### `inventory.confirmDocument` — mutation

- 권한: `inventory.confirm`
- 멱등(requestId): 예 — 3번째 인자로 `tx()`에 전달됨 (`input.requestId`)
- 입력:
  - `id`: 문자열 (min 1) — 필수
  - `version`: 숫자 (int) — 필수
  - `requestId`: 문자열 (uuid) — 필수, 멱등성 키

#### `inventory.cancelDocument` — mutation

- 권한: `inventory.cancel`
- 멱등(requestId): 예 — 3번째 인자로 `tx()`에 전달됨 (`input.requestId`)
- 입력:
  - `id`: 문자열 (min 1) — 필수
  - `reason`: 문자열 (min 2, max 200) — 필수
  - `version`: 숫자 (int) — 필수
  - `requestId`: 문자열 (uuid) — 필수, 멱등성 키

#### `inventory.submitForApproval` — mutation

- 권한: `inventory.write`
- 멱등(requestId): 예 — 3번째 인자로 `tx()`에 전달됨 (`input.requestId`)
- 입력:
  - `id`: 문자열 (min 1) — 필수
  - `version`: 숫자 (int) — 필수
  - `note`: 문자열 (max 500) — 선택
  - `lineTemplateId`: 문자열 (min 1) — 선택
  - `requestId`: 문자열 (uuid) — 필수, 멱등성 키

#### `inventory.submitCancellation` — mutation

- 권한: `inventory.cancel`
- 멱등(requestId): 예 — 3번째 인자로 `tx()`에 전달됨 (`input.requestId`)
- 입력:
  - `id`: 문자열 (min 1) — 필수
  - `reason`: 문자열 (min 2, max 200) — 필수
  - `requestId`: 문자열 (uuid) — 필수, 멱등성 키

#### `inventory.shipTransfer` — mutation

- 권한: `inventory.write`
- 멱등(requestId): 예 — 3번째 인자로 `tx()`에 전달됨 (`input.requestId`)
- 입력:
  - `id`: 문자열 (min 1) — 필수
  - `version`: 숫자 (int) — 필수
  - `requestId`: 문자열 (uuid) — 필수, 멱등성 키

#### `inventory.onHand` — query

- 권한: `inventory.read`
- 멱등(requestId): 해당 없음 (query)
- 입력:
  - `warehouseId`: 문자열 (min 1) — 선택
  - `categoryId`: 문자열 (min 1) — 선택
  - `q`: 문자열 (trim, max 200) — 선택
  - `hideZero`: 불리언 — 선택, 기본값=false
  - `belowSafetyOnly`: 불리언 — 선택, 기본값=false

#### `inventory.book` — query

- 권한: `inventory.read`
- 멱등(requestId): 해당 없음 (query)
- 입력:
  - `itemId`: 문자열 (min 1) — 필수
  - `from`: 문자열 (regex /^\d{4}-\d{2}-\d{2}$/) — 필수
  - `to`: 문자열 (regex /^\d{4}-\d{2}-\d{2}$/) — 필수
  - `warehouseId`: 문자열 (min 1) — 선택

#### `inventory.bookCsv` — query

- 권한: `inventory.export`
- 멱등(requestId): 해당 없음 (query)
- 입력:
  - `itemId`: 문자열 (min 1) — 필수
  - `from`: 문자열 (regex /^\d{4}-\d{2}-\d{2}$/) — 필수
  - `to`: 문자열 (regex /^\d{4}-\d{2}-\d{2}$/) — 필수
  - `warehouseId`: 문자열 (min 1) — 선택

#### `inventory.safetyStock` — query

- 권한: `inventory.read`
- 멱등(requestId): 해당 없음 (query)
- 입력:
  (입력 없음)

#### `inventory.counts` — query

- 권한: `inventory.read`
- 멱등(requestId): 해당 없음 (query)
- 입력:
  - `page`: 숫자 (int, min 1) — 선택, 기본값=1
  - `pageSize`: 숫자 (int, min 1, max 200) — 선택, 기본값=50
  - `sortBy`: 문자열 — 선택
  - `sortDir`: enum(asc | desc) — 선택, 기본값='desc'
  - `warehouseId`: 문자열 (min 1) — 선택
  - `status`: 문자열 — 선택

#### `inventory.countsCsv` — query

- 권한: `inventory.read`
- 멱등(requestId): 해당 없음 (query)
- 입력:
  - `warehouseId`: 문자열 (min 1) — 선택
  - `status`: 문자열 — 선택

#### `inventory.count` — query

- 권한: `inventory.read`
- 멱등(requestId): 해당 없음 (query)
- 입력:
  - `id`: 문자열 (min 1) — 필수

#### `inventory.createCount` — mutation

- 권한: `inventory.count`
- 멱등(requestId): 예 — 3번째 인자로 `tx()`에 전달됨 (`input.requestId`)
- 입력:
  - `warehouseId`: 문자열 (min 1) — 필수
  - `countDate`: 문자열 (regex /^\d{4}-\d{2}-\d{2}$/) — 선택
  - `note`: 문자열 (max 500) — 선택
  - `requestId`: 문자열 (uuid) — 필수, 멱등성 키

#### `inventory.startCount` — mutation

- 권한: `inventory.count`
- 멱등(requestId): 예 — 3번째 인자로 `tx()`에 전달됨 (`input.requestId`)
- 입력:
  - `id`: 문자열 (min 1) — 필수
  - `version`: 숫자 (int) — 필수
  - `itemIds`: 배열 — 선택
    → 원소 타입: 문자열 (min 1)
  - `categoryId`: 문자열 (min 1) — 선택
  - `requestId`: 문자열 (uuid) — 필수, 멱등성 키

#### `inventory.recordCount` — mutation

- 권한: `inventory.count`
- 멱등(requestId): 예 — 3번째 인자로 `tx()`에 전달됨 (`input.requestId`)
- 입력:
  - `id`: 문자열 (min 1) — 필수
  - `lines`: 배열 (min 1, max 500) — 필수
    배열 원소:
    - `itemId`: 문자열 (min 1) — 필수
    - `countedQty`: 정밀 소수 문자열 (scale=3, 비음수) — 필수
    - `reason`: 문자열 (max 200) — 선택
  - `requestId`: 문자열 (uuid) — 필수, 멱등성 키

#### `inventory.approveCount` — mutation

- 권한: `inventory.count`
- 멱등(requestId): 예 — 3번째 인자로 `tx()`에 전달됨 (`input.requestId`)
- 입력:
  - `id`: 문자열 (min 1) — 필수
  - `version`: 숫자 (int) — 필수
  - `requestId`: 문자열 (uuid) — 필수, 멱등성 키

#### `inventory.cancelCount` — mutation

- 권한: `inventory.count`
- 멱등(requestId): 예 — 3번째 인자로 `tx()`에 전달됨 (`input.requestId`)
- 입력:
  - `id`: 문자열 (min 1) — 필수
  - `reason`: 문자열 (min 2, max 200) — 필수
  - `version`: 숫자 (int) — 필수
  - `requestId`: 문자열 (uuid) — 필수, 멱등성 키

#### `inventory.periods` — query

- 권한: `inventory.read`
- 멱등(requestId): 해당 없음 (query)
- 입력:
  (입력 없음)

#### `inventory.closePreview` — query

- 권한: `inventory.read`
- 멱등(requestId): 해당 없음 (query)
- 입력:
  - `period`: 문자열 (regex /^\d{4}-\d{2}$/) — 필수

#### `inventory.closePeriod` — mutation

- 권한: `inventory.valuation`
- 멱등(requestId): 예 — 3번째 인자로 `tx()`에 전달됨 (`input.requestId`)
- 입력:
  - `period`: 문자열 (regex /^\d{4}-\d{2}$/) — 필수
  - `requestId`: 문자열 (uuid) — 필수, 멱등성 키

#### `inventory.reopenPeriod` — mutation

- 권한: `inventory.valuation`
- 멱등(requestId): 예 — 3번째 인자로 `tx()`에 전달됨 (`input.requestId`)
- 입력:
  - `period`: 문자열 (regex /^\d{4}-\d{2}$/) — 필수
  - `reason`: 문자열 (min 5, max 200) — 필수
  - `requestId`: 문자열 (uuid) — 필수, 멱등성 키

#### `inventory.reconcile` — query

- 권한: `inventory.valuation`
- 멱등(requestId): 해당 없음 (query)
- 입력:
  (입력 없음)

#### `inventory.rebuildSnapshot` — mutation

- 권한: `inventory.valuation`
- 멱등(requestId): 예 — 3번째 인자로 `tx()`에 전달됨 (`input.requestId`)
- 입력:
  - `requestId`: 문자열 (uuid) — 필수, 멱등성 키

### master (`src/server/api/routers/master.ts`)

#### `master.items` — query

- 권한: `master.read`
- 멱등(requestId): 해당 없음 (query)
- 입력:
  - `page`: 숫자 (int, min 1) — 선택, 기본값=1
  - `pageSize`: 숫자 (int, min 1, max 200) — 선택, 기본값=50
  - `sortBy`: 문자열 — 선택
  - `sortDir`: enum(asc | desc) — 선택, 기본값='desc'
  - `q`: 문자열 (trim, max 100) — 선택
  - `categoryId`: 문자열 (min 1) — 선택
  - `taxType`: enum(TAXABLE | ZERO | EXEMPT) — 선택
  - `activeOnly`: 불리언 — 선택, 기본값=true

#### `master.itemsCsv` — query

- 권한: `master.read`
- 멱등(requestId): 해당 없음 (query)
- 입력:
  - `q`: 문자열 (trim, max 100) — 선택
  - `categoryId`: 문자열 (min 1) — 선택
  - `taxType`: enum(TAXABLE | ZERO | EXEMPT) — 선택
  - `activeOnly`: 불리언 — 선택, 기본값=true

#### `master.item` — query

- 권한: `master.read`
- 멱등(requestId): 해당 없음 (query)
- 입력:
  - `id`: 문자열 (min 1) — 필수

#### `master.searchItems` — query

- 권한: `master.read`
- 멱등(requestId): 해당 없음 (query)
- 입력:
  - `q`: 문자열 (max 50) — 선택, 기본값=''
  - `take`: 숫자 (int, min 1, max 500) — 선택, 기본값=20

#### `master.createItem` — mutation

- 권한: `master.write`
- 멱등(requestId): 예 — 3번째 인자로 `tx()`에 전달됨 (`input.requestId`)
- 입력:
  - `code`: 문자열 (max 30) — 선택
  - `name`: 문자열 (min 1, max 100) — 필수
  - `spec`: 문자열 (max 100) — 선택
  - `unitCode`: 문자열 (max 20) — 선택
  - `categoryId`: 문자열 (min 1) — 선택
  - `purchasePrice`: 정밀 소수 문자열 (scale=4, 비음수) — 선택
  - `salesPrice`: 정밀 소수 문자열 (scale=4, 비음수) — 선택
  - `taxType`: enum(TAXABLE | ZERO | EXEMPT) — 선택
  - `barcode`: 문자열 (max 20) — 선택
  - `safetyStock`: 정밀 소수 문자열 (scale=3, 비음수) — 선택
  - `leadTimeDays`: 숫자 (int, min 0, max 999) — 선택
  - `defaultSupplierId`: 문자열 (min 1) — 선택
  - `note`: 문자열 (max 500) — 선택
  - `requestId`: 문자열 (uuid) — 필수, 멱등성 키

#### `master.updateItem` — mutation

- 권한: `master.write`
- 멱등(requestId): 예 — 3번째 인자로 `tx()`에 전달됨 (`input.requestId`)
- 입력:
  - `code`: 문자열 (max 30) — 선택
  - `name`: 문자열 (min 1, max 100) — 선택
  - `spec`: 문자열 (max 100) — 선택
  - `unitCode`: 문자열 (max 20) — 선택
  - `categoryId`: 문자열 (min 1) — 선택
  - `purchasePrice`: 정밀 소수 문자열 (scale=4, 비음수) — 선택
  - `salesPrice`: 정밀 소수 문자열 (scale=4, 비음수) — 선택
  - `taxType`: enum(TAXABLE | ZERO | EXEMPT) — 선택
  - `barcode`: 문자열 (max 20) — 선택
  - `safetyStock`: 정밀 소수 문자열 (scale=3, 비음수) — 선택
  - `leadTimeDays`: 숫자 (int, min 0, max 999) — 선택
  - `defaultSupplierId`: 문자열 (min 1) — 선택
  - `note`: 문자열 (max 500) — 선택
  - `id`: 문자열 (min 1) — 필수
  - `version`: 숫자 (int) — 필수
  - `requestId`: 문자열 (uuid) — 필수, 멱등성 키

#### `master.setItemActive` — mutation

- 권한: `master.write`
- 멱등(requestId): 예 — 3번째 인자로 `tx()`에 전달됨 (`input.requestId`)
- 입력:
  - `id`: 문자열 (min 1) — 필수
  - `isActive`: 불리언 — 필수
  - `requestId`: 문자열 (uuid) — 필수, 멱등성 키

#### `master.deleteItem` — mutation

- 권한: `master.write`
- 멱등(requestId): 예 — 3번째 인자로 `tx()`에 전달됨 (`input.requestId`)
- 입력:
  - `id`: 문자열 (min 1) — 필수
  - `requestId`: 문자열 (uuid) — 필수, 멱등성 키

#### `master.itemCategories` — query

- 권한: `master.read`
- 멱등(requestId): 해당 없음 (query)
- 입력:
  (입력 없음)

#### `master.createItemCategory` — mutation

- 권한: `master.write`
- 멱등(requestId): 예 — 3번째 인자로 `tx()`에 전달됨 (`input.requestId`)
- 입력:
  - `code`: 문자열 (min 1, max 30) — 필수
  - `name`: 문자열 (min 1, max 50) — 필수
  - `parentId`: 문자열 (min 1) — 선택
  - `sortOrder`: 숫자 (int) — 선택
  - `requestId`: 문자열 (uuid) — 필수, 멱등성 키

#### `master.partners` — query

- 권한: `master.read`
- 멱등(requestId): 해당 없음 (query)
- 입력:
  - `page`: 숫자 (int, min 1) — 선택, 기본값=1
  - `pageSize`: 숫자 (int, min 1, max 200) — 선택, 기본값=50
  - `sortBy`: 문자열 — 선택
  - `sortDir`: enum(asc | desc) — 선택, 기본값='desc'
  - `q`: 문자열 (trim, max 100) — 선택
  - `partnerType`: enum(CUSTOMER | SUPPLIER | BOTH) — 선택
  - `activeOnly`: 불리언 — 선택, 기본값=true

#### `master.partnersCsv` — query

- 권한: `master.read`
- 멱등(requestId): 해당 없음 (query)
- 입력:
  - `q`: 문자열 (trim, max 100) — 선택
  - `partnerType`: enum(CUSTOMER | SUPPLIER | BOTH) — 선택
  - `activeOnly`: 불리언 — 선택, 기본값=true

#### `master.partner` — query

- 권한: `master.read`
- 멱등(requestId): 해당 없음 (query)
- 입력:
  - `id`: 문자열 (min 1) — 필수

#### `master.searchPartners` — query

- 권한: `master.read`
- 멱등(requestId): 해당 없음 (query)
- 입력:
  - `q`: 문자열 (max 50) — 선택, 기본값=''
  - `partnerType`: enum(CUSTOMER | SUPPLIER | BOTH) — 선택
  - `take`: 숫자 (int, min 1, max 500) — 선택, 기본값=20

#### `master.createPartner` — mutation

- 권한: `master.write`
- 멱등(requestId): 예 — 3번째 인자로 `tx()`에 전달됨 (`input.requestId`)
- 입력:
  - `code`: 문자열 (max 30) — 선택
  - `name`: 문자열 (min 1, max 100) — 필수
  - `businessNo`: 문자열 (max 20) — 선택
  - `ceoName`: 문자열 (max 50) — 선택
  - `businessType`: 문자열 (max 50) — 선택
  - `businessItem`: 문자열 (max 50) — 선택
  - `address`: 문자열 (max 200) — 선택
  - `phone`: 문자열 (max 30) — 선택
  - `email`: 문자열 (email, max 100) — 선택
  - `partnerType`: enum(CUSTOMER | SUPPLIER | BOTH) — 선택
  - `paymentTerms`: 문자열 (max 50) — 선택
  - `creditLimit`: 정밀 소수 문자열 (scale=0, 비음수) — 선택
  - `note`: 문자열 (max 500) — 선택
  - `contacts`: 배열 (max 20) — 선택
    배열 원소:
    - `name`: 문자열 (min 1, max 50) — 필수
    - `position`: 문자열 (max 50) — 선택
    - `phone`: 문자열 (max 30) — 선택
    - `email`: 문자열 (email, max 100) — 선택
    - `isPrimary`: 불리언 — 선택
    - `note`: 문자열 (max 200) — 선택
  - `requestId`: 문자열 (uuid) — 필수, 멱등성 키

#### `master.updatePartner` — mutation

- 권한: `master.write`
- 멱등(requestId): 예 — 3번째 인자로 `tx()`에 전달됨 (`input.requestId`)
- 입력:
  - `code`: 문자열 (max 30) — 선택
  - `name`: 문자열 (min 1, max 100) — 선택
  - `businessNo`: 문자열 (max 20) — 선택
  - `ceoName`: 문자열 (max 50) — 선택
  - `businessType`: 문자열 (max 50) — 선택
  - `businessItem`: 문자열 (max 50) — 선택
  - `address`: 문자열 (max 200) — 선택
  - `phone`: 문자열 (max 30) — 선택
  - `email`: 문자열 (email, max 100) — 선택
  - `partnerType`: enum(CUSTOMER | SUPPLIER | BOTH) — 선택
  - `paymentTerms`: 문자열 (max 50) — 선택
  - `creditLimit`: 정밀 소수 문자열 (scale=0, 비음수) — 선택
  - `note`: 문자열 (max 500) — 선택
  - `contacts`: 배열 (max 20) — 선택
    배열 원소:
    - `name`: 문자열 (min 1, max 50) — 필수
    - `position`: 문자열 (max 50) — 선택
    - `phone`: 문자열 (max 30) — 선택
    - `email`: 문자열 (email, max 100) — 선택
    - `isPrimary`: 불리언 — 선택
    - `note`: 문자열 (max 200) — 선택
  - `id`: 문자열 (min 1) — 필수
  - `version`: 숫자 (int) — 필수
  - `requestId`: 문자열 (uuid) — 필수, 멱등성 키

#### `master.setPartnerActive` — mutation

- 권한: `master.write`
- 멱등(requestId): 예 — 3번째 인자로 `tx()`에 전달됨 (`input.requestId`)
- 입력:
  - `id`: 문자열 (min 1) — 필수
  - `isActive`: 불리언 — 필수
  - `requestId`: 문자열 (uuid) — 필수, 멱등성 키

#### `master.deletePartner` — mutation

- 권한: `master.write`
- 멱등(requestId): 예 — 3번째 인자로 `tx()`에 전달됨 (`input.requestId`)
- 입력:
  - `id`: 문자열 (min 1) — 필수
  - `requestId`: 문자열 (uuid) — 필수, 멱등성 키

#### `master.warehouses` — query

- 권한: `master.read`
- 멱등(requestId): 해당 없음 (query)
- 입력:
  - `activeOnly`: 불리언 — 선택, 기본값=false

#### `master.createWarehouse` — mutation

- 권한: `master.write`
- 멱등(requestId): 예 — 3번째 인자로 `tx()`에 전달됨 (`input.requestId`)
- 입력:
  - `code`: 문자열 (min 1, max 20) — 필수
  - `name`: 문자열 (min 1, max 50) — 필수
  - `type`: enum(NORMAL | DEFECT | CONSIGNED) — 선택
  - `managerEmployeeId`: 문자열 (min 1) — 선택
  - `address`: 문자열 (max 200) — 선택
  - `sortOrder`: 숫자 (int) — 선택
  - `requestId`: 문자열 (uuid) — 필수, 멱등성 키

#### `master.updateWarehouse` — mutation

- 권한: `master.write`
- 멱등(requestId): 예 — 3번째 인자로 `tx()`에 전달됨 (`input.requestId`)
- 입력:
  - `id`: 문자열 (min 1) — 필수
  - `name`: 문자열 (max 50) — 선택
  - `type`: enum(NORMAL | DEFECT | CONSIGNED) — 선택
  - `managerEmployeeId`: 문자열 (min 1) — nullable 허용, 선택
  - `address`: 문자열 (max 200) — 선택
  - `isActive`: 불리언 — 선택
  - `sortOrder`: 숫자 (int) — 선택
  - `requestId`: 문자열 (uuid) — 필수, 멱등성 키

#### `master.divisions` — query

- 권한: `master.read`
- 멱등(requestId): 해당 없음 (query)
- 입력:
  - `activeOnly`: 불리언 — 선택, 기본값=false

#### `master.createDivision` — mutation

- 권한: `master.write`
- 멱등(requestId): 예 — 3번째 인자로 `tx()`에 전달됨 (`input.requestId`)
- 입력:
  - `code`: 문자열 (min 1, max 20) — 필수
  - `name`: 문자열 (min 1, max 50) — 필수
  - `sortOrder`: 숫자 (int) — 선택
  - `requestId`: 문자열 (uuid) — 필수, 멱등성 키

#### `master.updateDivision` — mutation

- 권한: `master.write`
- 멱등(requestId): 예 — 3번째 인자로 `tx()`에 전달됨 (`input.requestId`)
- 입력:
  - `id`: 문자열 (min 1) — 필수
  - `name`: 문자열 (max 50) — 선택
  - `isActive`: 불리언 — 선택
  - `sortOrder`: 숫자 (int) — 선택
  - `requestId`: 문자열 (uuid) — 필수, 멱등성 키

#### `master.codeGroups` — query

- 권한: `master.read`
- 멱등(requestId): 해당 없음 (query)
- 입력:
  (입력 없음)

#### `master.codes` — query

- 권한: `master.read`
- 멱등(requestId): 해당 없음 (query)
- 입력:
  - `groupCode`: 문자열 — 선택
  - `activeOnly`: 불리언 — 선택, 기본값=false

#### `master.upsertCode` — mutation

- 권한: `master.write`
- 멱등(requestId): 예 — 3번째 인자로 `tx()`에 전달됨 (`input.requestId`)
- 입력:
  - `groupCode`: 문자열 (min 1, max 30) — 필수
  - `code`: 문자열 (min 1, max 30) — 필수
  - `name`: 문자열 (min 1, max 50) — 필수
  - `value1`: 문자열 (max 100) — 선택
  - `value2`: 문자열 (max 100) — 선택
  - `sortOrder`: 숫자 (int) — 선택
  - `isActive`: 불리언 — 선택
  - `requestId`: 문자열 (uuid) — 필수, 멱등성 키

#### `master.deactivateCode` — mutation

- 권한: `master.write`
- 멱등(requestId): 예 — 3번째 인자로 `tx()`에 전달됨 (`input.requestId`)
- 입력:
  - `groupCode`: 문자열 — 필수
  - `code`: 문자열 — 필수
  - `requestId`: 문자열 (uuid) — 필수, 멱등성 키

#### `master.numberingRules` — query

- 권한: `master.read`
- 멱등(requestId): 해당 없음 (query)
- 입력:
  (입력 없음)

#### `master.createNumberingRule` — mutation

- 권한: `admin.settings`
- 멱등(requestId): 예 — 3번째 인자로 `tx()`에 전달됨 (`input.requestId`)
- 입력:
  - `docType`: 문자열 (min 1, max 40) — 필수
  - `prefix`: 문자열 (min 1, max 5) — 필수
  - `periodKind`: enum(NONE | YEAR | MONTH) — 필수
  - `seqLength`: 숫자 (int, min 3, max 10) — 필수
  - `requestId`: 문자열 (uuid) — 필수, 멱등성 키

#### `master.updateNumberingRule` — mutation

- 권한: `admin.settings`
- 멱등(requestId): 예 — 3번째 인자로 `tx()`에 전달됨 (`input.requestId`)
- 입력:
  - `docType`: 문자열 (min 1, max 40) — 필수
  - `prefix`: 문자열 (min 1, max 5) — 필수
  - `periodKind`: enum(NONE | YEAR | MONTH) — 필수
  - `seqLength`: 숫자 (int, min 3, max 10) — 필수
  - `requestId`: 문자열 (uuid) — 필수, 멱등성 키

#### `master.changeHistory` — query

- 권한: `master.read`
- 멱등(requestId): 해당 없음 (query)
- 입력:
  - `entityType`: enum(Item | Partner | Warehouse | Division | CommonCode | StockDocument | StockCount) — 필수
  - `entityId`: 문자열 (min 1) — 필수

#### `master.importTemplate` — query

- 권한: `master.read`
- 멱등(requestId): 해당 없음 (query)
- 입력:
  - `targetType`: enum(ITEM | PARTNER) — 필수

#### `master.validateImport` — mutation

- 권한: `master.write`
- 멱등(requestId): 예 — 3번째 인자로 `tx()`에 전달됨 (`input.requestId`)
- 입력:
  - `targetType`: enum(ITEM | PARTNER) — 필수
  - `rows`: 배열 (min 1, max 5000) — 필수
    → 원소 타입: record<문자열, 문자열>
  - `fileName`: 문자열 (max 200) — 선택
  - `templateVersion`: 숫자 (int) — 선택
  - `requestId`: 문자열 (uuid) — 필수, 멱등성 키

#### `master.applyImport` — mutation

- 권한: `master.write`
- 멱등(requestId): 예 — 3번째 인자로 `tx()`에 전달됨 (`input.requestId`)
- 입력:
  - `batchId`: 문자열 (min 1) — 필수
  - `targetType`: enum(ITEM | PARTNER) — 필수
  - `rows`: 배열 (min 1, max 5000) — 필수
    → 원소 타입: record<문자열, 문자열>
  - `selectedRows`: 배열 (min 1) — 필수
    → 원소 타입: 숫자 (int, min 1)
  - `requestId`: 문자열 (uuid) — 필수, 멱등성 키

#### `master.importBatches` — query

- 권한: `master.read`
- 멱등(requestId): 해당 없음 (query)
- 입력:
  - `targetType`: enum(ITEM | PARTNER) — 선택

### migration (`src/server/api/routers/migration.ts`)

#### `migration.template` — query

- 권한: `admin.migration`
- 멱등(requestId): 해당 없음 (query)
- 입력:
  - `target`: enum(ITEM | PARTNER | OPENING_STOCK | OPEN_ITEM | ACCOUNT | OPENING_BALANCE | DEPARTMENT | EMPLOYEE | LEAVE | HISTORICAL_SALES) — 필수

#### `migration.batches` — query

- 권한: `admin.migration`
- 멱등(requestId): 해당 없음 (query)
- 입력:
  - `target`: enum(ITEM | PARTNER | OPENING_STOCK | OPEN_ITEM | ACCOUNT | OPENING_BALANCE | DEPARTMENT | EMPLOYEE | LEAVE | HISTORICAL_SALES) — 선택
  - `take`: 숫자 (int, min 1, max 200) — 선택, 기본값=50

#### `migration.validate` — mutation

- 권한: `admin.migration`
- 멱등(requestId): 예 — 3번째 인자로 `tx()`에 전달됨 (`input.requestId`)
- 입력:
  - `target`: enum(ITEM | PARTNER | OPENING_STOCK | OPEN_ITEM | ACCOUNT | OPENING_BALANCE | DEPARTMENT | EMPLOYEE | LEAVE | HISTORICAL_SALES) — 필수
  - `rows`: 배열 (max 20_000) — 필수
    → 원소 타입: record<문자열, 문자열>
  - `fileName`: 문자열 (max 200) — 선택
  - `baselineDate`: 문자열 (regex /^\d{4}-\d{2}-\d{2}$/) — 선택
  - `templateVersion`: 숫자 (int) — 선택
  - `note`: 문자열 (max 500) — 선택
  - `requestId`: 문자열 (uuid) — 필수, 멱등성 키

#### `migration.applyBatch` — mutation

- 권한: `admin.migration`
- 멱등(requestId): 예 — 3번째 인자로 `tx()`에 전달됨 (`input.requestId`)
- 입력:
  - `batchId`: 문자열 (min 1) — 필수
  - `rows`: 배열 (max 20_000) — 필수
    → 원소 타입: record<문자열, 문자열>
  - `selectedRows`: 배열 — 선택
    → 원소 타입: 숫자 (int, min 1)
  - `requestId`: 문자열 (uuid) — 필수, 멱등성 키

#### `migration.reconcile` — query

- 권한: `admin.migration`
- 멱등(requestId): 해당 없음 (query)
- 입력:
  - `batchId`: 문자열 (min 1) — 필수

### notification (`src/server/api/routers/notification.ts`)

#### `notification.list` — query

- 권한: (인증 필요 — 별도 업무 권한 없음)
- 멱등(requestId): 해당 없음 (query)
- 입력:
  - `page`: 숫자 (int, min 1) — 선택, 기본값=1
  - `pageSize`: 숫자 (int, min 1, max 200) — 선택, 기본값=50
  - `sortBy`: 문자열 — 선택
  - `sortDir`: enum(asc | desc) — 선택, 기본값='desc'
  - `unreadOnly`: 불리언 — 선택, 기본값=false

#### `notification.unreadCount` — query

- 권한: (인증 필요 — 별도 업무 권한 없음)
- 멱등(requestId): 해당 없음 (query)
- 입력:
  (입력 없음)

#### `notification.markRead` — mutation

- 권한: (인증 필요 — 별도 업무 권한 없음)
- 멱등(requestId): 아니오 (tx() 호출은 있으나 requestId 인자 없음)
- 입력:
  - `ids`: 배열 (min 1, max 200) — 필수
    → 원소 타입: 문자열 (min 1)

#### `notification.markAllRead` — mutation

- 권한: (인증 필요 — 별도 업무 권한 없음)
- 멱등(requestId): 아니오 (tx() 호출은 있으나 requestId 인자 없음)
- 입력:
  (입력 없음)

### preference (`src/server/api/routers/preference.ts`)

#### `preference.get` — query

- 권한: (인증 필요 — 별도 업무 권한 없음)
- 멱등(requestId): 해당 없음 (query)
- 입력:
  - `kind`: enum(GRID_COLUMNS | SEARCH_FILTER | DASHBOARD | REPORT_FILTER) — 필수
  - `key`: 문자열 (min 1, max 100) — 필수

#### `preference.list` — query

- 권한: (인증 필요 — 별도 업무 권한 없음)
- 멱등(requestId): 해당 없음 (query)
- 입력:
  - `kind`: enum(GRID_COLUMNS | SEARCH_FILTER | DASHBOARD | REPORT_FILTER) — 필수

#### `preference.set` — mutation

- 권한: (인증 필요 — 별도 업무 권한 없음)
- 멱등(requestId): 아니오 (tx/readTx 미호출 — 직접 처리, 원본 확인)
- 입력:
  - `kind`: enum(GRID_COLUMNS | SEARCH_FILTER | DASHBOARD | REPORT_FILTER) — 필수
  - `key`: 문자열 (min 1, max 100) — 필수
  - `value`: 임의 값(unknown) — 필수

#### `preference.remove` — mutation

- 권한: (인증 필요 — 별도 업무 권한 없음)
- 멱등(requestId): 아니오 (tx/readTx 미호출 — 직접 처리, 원본 확인)
- 입력:
  - `kind`: enum(GRID_COLUMNS | SEARCH_FILTER | DASHBOARD | REPORT_FILTER) — 필수
  - `key`: 문자열 (min 1, max 100) — 필수

### report (`src/server/api/routers/report.ts`)

#### `report.salesTrend` — query

- 권한: `report.read`
- 멱등(requestId): 해당 없음 (query)
- 입력:
  - `filter`: object — 필수
    - `from`: 문자열 (regex /^\d{4}-\d{2}-\d{2}$/) — 필수
    - `to`: 문자열 (regex /^\d{4}-\d{2}-\d{2}$/) — 필수
    - `divisionId`: 문자열 (min 1) — 선택
    - `warehouseId`: 문자열 (min 1) — 선택
    - `partnerId`: 문자열 (min 1) — 선택
    - `categoryId`: 문자열 (min 1) — 선택
  - `granularity`: enum(DAY | WEEK | MONTH | QUARTER) — 선택, 기본값='MONTH'

#### `report.itemRanking` — query

- 권한: `report.read`
- 멱등(requestId): 해당 없음 (query)
- 입력:
  - `filter`: object — 필수
    - `from`: 문자열 (regex /^\d{4}-\d{2}-\d{2}$/) — 필수
    - `to`: 문자열 (regex /^\d{4}-\d{2}-\d{2}$/) — 필수
    - `divisionId`: 문자열 (min 1) — 선택
    - `warehouseId`: 문자열 (min 1) — 선택
    - `partnerId`: 문자열 (min 1) — 선택
    - `categoryId`: 문자열 (min 1) — 선택
  - `top`: 숫자 (int, min 1, max 200) — 선택, 기본값=20
  - `by`: enum(AMOUNT | QUANTITY) — 선택, 기본값='AMOUNT'

#### `report.partnerPerformance` — query

- 권한: `report.read`
- 멱등(requestId): 해당 없음 (query)
- 입력:
  - `filter`: object — 필수
    - `from`: 문자열 (regex /^\d{4}-\d{2}-\d{2}$/) — 필수
    - `to`: 문자열 (regex /^\d{4}-\d{2}-\d{2}$/) — 필수
    - `divisionId`: 문자열 (min 1) — 선택
    - `warehouseId`: 문자열 (min 1) — 선택
    - `partnerId`: 문자열 (min 1) — 선택
    - `categoryId`: 문자열 (min 1) — 선택

#### `report.stockStatus` — query

- 권한: `report.read`
- 멱등(requestId): 해당 없음 (query)
- 입력:
  - `filter`: object — 필수
    - `from`: 문자열 (regex /^\d{4}-\d{2}-\d{2}$/) — 필수
    - `to`: 문자열 (regex /^\d{4}-\d{2}-\d{2}$/) — 필수
    - `divisionId`: 문자열 (min 1) — 선택
    - `warehouseId`: 문자열 (min 1) — 선택
    - `partnerId`: 문자열 (min 1) — 선택
    - `categoryId`: 문자열 (min 1) — 선택

#### `report.openItems` — query

- 권한: `report.read`
- 멱등(requestId): 해당 없음 (query)
- 입력:
  - `filter`: object — 필수
    - `from`: 문자열 (regex /^\d{4}-\d{2}-\d{2}$/) — 필수
    - `to`: 문자열 (regex /^\d{4}-\d{2}-\d{2}$/) — 필수
    - `divisionId`: 문자열 (min 1) — 선택
    - `warehouseId`: 문자열 (min 1) — 선택
    - `partnerId`: 문자열 (min 1) — 선택
    - `categoryId`: 문자열 (min 1) — 선택
  - `kind`: enum(RECEIVABLE | PAYABLE) — 선택, 기본값='RECEIVABLE'

#### `report.approvalStats` — query

- 권한: `report.read`
- 멱등(requestId): 해당 없음 (query)
- 입력:
  - `filter`: object — 필수
    - `from`: 문자열 (regex /^\d{4}-\d{2}-\d{2}$/) — 필수
    - `to`: 문자열 (regex /^\d{4}-\d{2}-\d{2}$/) — 필수
    - `divisionId`: 문자열 (min 1) — 선택
    - `warehouseId`: 문자열 (min 1) — 선택
    - `partnerId`: 문자열 (min 1) — 선택
    - `categoryId`: 문자열 (min 1) — 선택

#### `report.workforce` — query

- 권한: `report.read`
- 멱등(requestId): 해당 없음 (query)
- 입력:
  - `filter`: object — 필수
    - `from`: 문자열 (regex /^\d{4}-\d{2}-\d{2}$/) — 필수
    - `to`: 문자열 (regex /^\d{4}-\d{2}-\d{2}$/) — 필수
    - `divisionId`: 문자열 (min 1) — 선택
    - `warehouseId`: 문자열 (min 1) — 선택
    - `partnerId`: 문자열 (min 1) — 선택
    - `categoryId`: 문자열 (min 1) — 선택

#### `report.dashboard` — query

- 권한: `report.read`
- 멱등(requestId): 해당 없음 (query)
- 입력:
  (입력 없음)

#### `report.drillDown` — query

- 권한: `report.read`
- 멱등(requestId): 해당 없음 (query)
- 입력:
  - `filter`: object — 필수
    - `from`: 문자열 (regex /^\d{4}-\d{2}-\d{2}$/) — 필수
    - `to`: 문자열 (regex /^\d{4}-\d{2}-\d{2}$/) — 필수
    - `divisionId`: 문자열 (min 1) — 선택
    - `warehouseId`: 문자열 (min 1) — 선택
    - `partnerId`: 문자열 (min 1) — 선택
    - `categoryId`: 문자열 (min 1) — 선택
  - `target`: enum(SALES | PURCHASE | RECEIVABLE | PAYABLE) — 필수
  - `itemId`: 문자열 (min 1) — 선택
  - `take`: 숫자 (int, min 1, max 500) — 선택, 기본값=100

### sales (`src/server/api/routers/sales.ts`)

#### `sales.quotations` — query

- 권한: `sales.read`
- 멱등(requestId): 해당 없음 (query)
- 입력:
  - `page`: 숫자 (int, min 1) — 선택, 기본값=1
  - `pageSize`: 숫자 (int, min 1, max 200) — 선택, 기본값=50
  - `sortBy`: 문자열 — 선택
  - `sortDir`: enum(asc | desc) — 선택, 기본값='desc'
  - `status`: 문자열 — 선택
  - `partnerId`: 문자열 (min 1) — 선택
  - `q`: 문자열 (trim, max 200) — 선택
  - `from`: 문자열 (regex /^\d{4}-\d{2}-\d{2}$/) — 선택
  - `to`: 문자열 (regex /^\d{4}-\d{2}-\d{2}$/) — 선택

#### `sales.quotationsCsv` — query

- 권한: `sales.read`
- 멱등(requestId): 해당 없음 (query)
- 입력:
  - `status`: 문자열 — 선택
  - `partnerId`: 문자열 (min 1) — 선택
  - `q`: 문자열 (trim, max 200) — 선택
  - `from`: 문자열 (regex /^\d{4}-\d{2}-\d{2}$/) — 선택
  - `to`: 문자열 (regex /^\d{4}-\d{2}-\d{2}$/) — 선택

#### `sales.quotation` — query

- 권한: `sales.read`
- 멱등(requestId): 해당 없음 (query)
- 입력:
  - `id`: 문자열 (min 1) — 필수

#### `sales.createQuotation` — mutation

- 권한: `sales.write`
- 멱등(requestId): 예 — 3번째 인자로 `tx()`에 전달됨 (`input.requestId`)
- 입력:
  - `docDate`: 문자열 (regex /^\d{4}-\d{2}-\d{2}$/) — 선택
  - `validUntil`: 문자열 (regex /^\d{4}-\d{2}-\d{2}$/) — 선택
  - `partnerId`: 문자열 (min 1) — 필수
  - `divisionId`: 문자열 (min 1) — 선택
  - `title`: 문자열 (max 200) — 선택
  - `note`: 문자열 (max 1000) — 선택
  - `lines`: 배열 (min 1, max 300) — 필수
    배열 원소:
    - `itemId`: 문자열 (min 1) — 필수
    - `description`: 문자열 (max 200) — 선택
    - `quantity`: 정밀 소수 문자열 (scale=3, 비음수) — 필수
    - `unitPrice`: 정밀 소수 문자열 (scale=4, 비음수) — 필수
    - `taxType`: enum(TAXABLE | ZERO | EXEMPT) — 선택
    - `sourceLineId`: 문자열 (min 1) — 선택
    - `originalLineId`: 문자열 (min 1) — 선택
    - `suggestedSupplierId`: 문자열 (min 1) — 선택
  - `requestId`: 문자열 (uuid) — 필수, 멱등성 키

#### `sales.updateQuotation` — mutation

- 권한: `sales.write`
- 멱등(requestId): 예 — 3번째 인자로 `tx()`에 전달됨 (`input.requestId`)
- 입력:
  - `id`: 문자열 (min 1) — 필수
  - `version`: 숫자 (int) — 필수
  - `docDate`: 문자열 (regex /^\d{4}-\d{2}-\d{2}$/) — 선택
  - `validUntil`: 문자열 (regex /^\d{4}-\d{2}-\d{2}$/) — 선택
  - `partnerId`: 문자열 (min 1) — 필수
  - `divisionId`: 문자열 (min 1) — 선택
  - `title`: 문자열 (max 200) — 선택
  - `note`: 문자열 (max 1000) — 선택
  - `lines`: 배열 (min 1, max 300) — 필수
    배열 원소:
    - `itemId`: 문자열 (min 1) — 필수
    - `description`: 문자열 (max 200) — 선택
    - `quantity`: 정밀 소수 문자열 (scale=3, 비음수) — 필수
    - `unitPrice`: 정밀 소수 문자열 (scale=4, 비음수) — 필수
    - `taxType`: enum(TAXABLE | ZERO | EXEMPT) — 선택
    - `sourceLineId`: 문자열 (min 1) — 선택
    - `originalLineId`: 문자열 (min 1) — 선택
    - `suggestedSupplierId`: 문자열 (min 1) — 선택
  - `requestId`: 문자열 (uuid) — 필수, 멱등성 키

#### `sales.copyQuotation` — mutation

- 권한: `sales.write`
- 멱등(requestId): 예 — 3번째 인자로 `tx()`에 전달됨 (`input.requestId`)
- 입력:
  - `id`: 문자열 (min 1) — 필수
  - `requestId`: 문자열 (uuid) — 필수, 멱등성 키

#### `sales.setQuotationStatus` — mutation

- 권한: `sales.write`
- 멱등(requestId): 예 — 3번째 인자로 `tx()`에 전달됨 (`input.requestId`)
- 입력:
  - `id`: 문자열 (min 1) — 필수
  - `status`: 문자열 (max 20) — 필수
  - `version`: 숫자 (int) — 필수
  - `requestId`: 문자열 (uuid) — 필수, 멱등성 키

#### `sales.convertQuotationToOrder` — mutation

- 권한: `sales.write`
- 멱등(requestId): 예 — 3번째 인자로 `tx()`에 전달됨 (`input.requestId`)
- 입력:
  - `quotationId`: 문자열 (min 1) — 필수
  - `lines`: 배열 (min 1, max 300) — 필수
    배열 원소:
    - `sourceLineId`: 문자열 (min 1) — 필수
    - `quantity`: 정밀 소수 문자열 (scale=3, 비음수) — 필수
    - `unitPrice`: 정밀 소수 문자열 (scale=4, 비음수) — 선택
  - `deliveryDate`: 문자열 (regex /^\d{4}-\d{2}-\d{2}$/) — 선택
  - `note`: 문자열 (max 1000) — 선택
  - `requestId`: 문자열 (uuid) — 필수, 멱등성 키

#### `sales.salesOrders` — query

- 권한: `sales.read`
- 멱등(requestId): 해당 없음 (query)
- 입력:
  - `page`: 숫자 (int, min 1) — 선택, 기본값=1
  - `pageSize`: 숫자 (int, min 1, max 200) — 선택, 기본값=50
  - `sortBy`: 문자열 — 선택
  - `sortDir`: enum(asc | desc) — 선택, 기본값='desc'
  - `status`: 문자열 — 선택
  - `partnerId`: 문자열 (min 1) — 선택
  - `q`: 문자열 (trim, max 200) — 선택
  - `from`: 문자열 (regex /^\d{4}-\d{2}-\d{2}$/) — 선택
  - `to`: 문자열 (regex /^\d{4}-\d{2}-\d{2}$/) — 선택

#### `sales.salesOrdersCsv` — query

- 권한: `sales.read`
- 멱등(requestId): 해당 없음 (query)
- 입력:
  - `status`: 문자열 — 선택
  - `partnerId`: 문자열 (min 1) — 선택
  - `q`: 문자열 (trim, max 200) — 선택
  - `from`: 문자열 (regex /^\d{4}-\d{2}-\d{2}$/) — 선택
  - `to`: 문자열 (regex /^\d{4}-\d{2}-\d{2}$/) — 선택

#### `sales.salesOrder` — query

- 권한: `sales.read`
- 멱등(requestId): 해당 없음 (query)
- 입력:
  - `id`: 문자열 (min 1) — 필수

#### `sales.createSalesOrder` — mutation

- 권한: `sales.write`
- 멱등(requestId): 예 — 3번째 인자로 `tx()`에 전달됨 (`input.requestId`)
- 입력:
  - `docDate`: 문자열 (regex /^\d{4}-\d{2}-\d{2}$/) — 선택
  - `deliveryDate`: 문자열 (regex /^\d{4}-\d{2}-\d{2}$/) — 선택
  - `partnerId`: 문자열 (min 1) — 필수
  - `divisionId`: 문자열 (min 1) — 선택
  - `note`: 문자열 (max 1000) — 선택
  - `lines`: 배열 (min 1, max 300) — 필수
    배열 원소:
    - `itemId`: 문자열 (min 1) — 필수
    - `description`: 문자열 (max 200) — 선택
    - `quantity`: 정밀 소수 문자열 (scale=3, 비음수) — 필수
    - `unitPrice`: 정밀 소수 문자열 (scale=4, 비음수) — 필수
    - `taxType`: enum(TAXABLE | ZERO | EXEMPT) — 선택
    - `sourceLineId`: 문자열 (min 1) — 선택
    - `originalLineId`: 문자열 (min 1) — 선택
    - `suggestedSupplierId`: 문자열 (min 1) — 선택
  - `requestId`: 문자열 (uuid) — 필수, 멱등성 키

#### `sales.cancelSalesOrder` — mutation

- 권한: `sales.write`
- 멱등(requestId): 예 — 3번째 인자로 `tx()`에 전달됨 (`input.requestId`)
- 입력:
  - `id`: 문자열 (min 1) — 필수
  - `reason`: 문자열 (min 2, max 200) — 필수
  - `version`: 숫자 (int) — 필수
  - `requestId`: 문자열 (uuid) — 필수, 멱등성 키

#### `sales.salesDocuments` — query

- 권한: `sales.read`
- 멱등(requestId): 해당 없음 (query)
- 입력:
  - `page`: 숫자 (int, min 1) — 선택, 기본값=1
  - `pageSize`: 숫자 (int, min 1, max 200) — 선택, 기본값=50
  - `sortBy`: 문자열 — 선택
  - `sortDir`: enum(asc | desc) — 선택, 기본값='desc'
  - `docType`: enum(SALES | RETURN_SALES) — 선택
  - `status`: 문자열 — 선택
  - `partnerId`: 문자열 (min 1) — 선택
  - `q`: 문자열 (trim, max 200) — 선택
  - `from`: 문자열 (regex /^\d{4}-\d{2}-\d{2}$/) — 선택
  - `to`: 문자열 (regex /^\d{4}-\d{2}-\d{2}$/) — 선택

#### `sales.salesDocumentsCsv` — query

- 권한: `sales.read`
- 멱등(requestId): 해당 없음 (query)
- 입력:
  - `docType`: enum(SALES | RETURN_SALES) — 선택
  - `status`: 문자열 — 선택
  - `partnerId`: 문자열 (min 1) — 선택
  - `q`: 문자열 (trim, max 200) — 선택
  - `from`: 문자열 (regex /^\d{4}-\d{2}-\d{2}$/) — 선택
  - `to`: 문자열 (regex /^\d{4}-\d{2}-\d{2}$/) — 선택

#### `sales.salesDocument` — query

- 권한: `sales.read`
- 멱등(requestId): 해당 없음 (query)
- 입력:
  - `id`: 문자열 (min 1) — 필수

#### `sales.createSalesDocument` — mutation

- 권한: `sales.write`
- 멱등(requestId): 예 — 3번째 인자로 `tx()`에 전달됨 (`input.requestId`)
- 입력:
  - `docType`: enum(SALES | RETURN_SALES) — 선택
  - `docDate`: 문자열 (regex /^\d{4}-\d{2}-\d{2}$/) — 선택
  - `partnerId`: 문자열 (min 1) — 필수
  - `warehouseId`: 문자열 (min 1) — 필수
  - `divisionId`: 문자열 (min 1) — 선택
  - `note`: 문자열 (max 1000) — 선택
  - `originalId`: 문자열 (min 1) — 선택
  - `lines`: 배열 (min 1, max 300) — 필수
    배열 원소:
    - `itemId`: 문자열 (min 1) — 필수
    - `description`: 문자열 (max 200) — 선택
    - `quantity`: 정밀 소수 문자열 (scale=3, 비음수) — 필수
    - `unitPrice`: 정밀 소수 문자열 (scale=4, 비음수) — 필수
    - `taxType`: enum(TAXABLE | ZERO | EXEMPT) — 선택
    - `sourceLineId`: 문자열 (min 1) — 선택
    - `originalLineId`: 문자열 (min 1) — 선택
    - `suggestedSupplierId`: 문자열 (min 1) — 선택
  - `requestId`: 문자열 (uuid) — 필수, 멱등성 키

#### `sales.updateSalesDocument` — mutation

- 권한: `sales.write`
- 멱등(requestId): 예 — 3번째 인자로 `tx()`에 전달됨 (`input.requestId`)
- 입력:
  - `id`: 문자열 (min 1) — 필수
  - `version`: 숫자 (int) — 필수
  - `docDate`: 문자열 (regex /^\d{4}-\d{2}-\d{2}$/) — 선택
  - `partnerId`: 문자열 (min 1) — 필수
  - `warehouseId`: 문자열 (min 1) — 필수
  - `divisionId`: 문자열 (min 1) — 선택
  - `note`: 문자열 (max 1000) — 선택
  - `lines`: 배열 (min 1, max 300) — 필수
    배열 원소:
    - `itemId`: 문자열 (min 1) — 필수
    - `description`: 문자열 (max 200) — 선택
    - `quantity`: 정밀 소수 문자열 (scale=3, 비음수) — 필수
    - `unitPrice`: 정밀 소수 문자열 (scale=4, 비음수) — 필수
    - `taxType`: enum(TAXABLE | ZERO | EXEMPT) — 선택
    - `sourceLineId`: 문자열 (min 1) — 선택
    - `originalLineId`: 문자열 (min 1) — 선택
    - `suggestedSupplierId`: 문자열 (min 1) — 선택
  - `requestId`: 문자열 (uuid) — 필수, 멱등성 키

#### `sales.confirmSalesDocument` — mutation

- 권한: `sales.confirm`
- 멱등(requestId): 예 — 3번째 인자로 `tx()`에 전달됨 (`input.requestId`)
- 입력:
  - `id`: 문자열 (min 1) — 필수
  - `version`: 숫자 (int) — 필수
  - `requestId`: 문자열 (uuid) — 필수, 멱등성 키

#### `sales.cancelSalesDocument` — mutation

- 권한: `sales.cancel`
- 멱등(requestId): 예 — 3번째 인자로 `tx()`에 전달됨 (`input.requestId`)
- 입력:
  - `id`: 문자열 (min 1) — 필수
  - `reason`: 문자열 (min 2, max 200) — 필수
  - `version`: 숫자 (int) — 필수
  - `requestId`: 문자열 (uuid) — 필수, 멱등성 키

#### `sales.submitSalesDocumentForApproval` — mutation

- 권한: `sales.write`
- 멱등(requestId): 예 — 3번째 인자로 `tx()`에 전달됨 (`input.requestId`)
- 입력:
  - `id`: 문자열 (min 1) — 필수
  - `version`: 숫자 (int) — 필수
  - `note`: 문자열 (max 500) — 선택
  - `lineTemplateId`: 문자열 (min 1) — 선택
  - `requestId`: 문자열 (uuid) — 필수, 멱등성 키

#### `sales.submitSalesDocumentCancellation` — mutation

- 권한: `sales.cancel`
- 멱등(requestId): 예 — 3번째 인자로 `tx()`에 전달됨 (`input.requestId`)
- 입력:
  - `id`: 문자열 (min 1) — 필수
  - `reason`: 문자열 (min 2, max 200) — 필수
  - `requestId`: 문자열 (uuid) — 필수, 멱등성 키

#### `sales.submitPurchaseDocumentForApproval` — mutation

- 권한: `purchase.write`
- 멱등(requestId): 예 — 3번째 인자로 `tx()`에 전달됨 (`input.requestId`)
- 입력:
  - `id`: 문자열 (min 1) — 필수
  - `version`: 숫자 (int) — 필수
  - `note`: 문자열 (max 500) — 선택
  - `lineTemplateId`: 문자열 (min 1) — 선택
  - `requestId`: 문자열 (uuid) — 필수, 멱등성 키

#### `sales.submitPurchaseDocumentCancellation` — mutation

- 권한: `purchase.cancel`
- 멱등(requestId): 예 — 3번째 인자로 `tx()`에 전달됨 (`input.requestId`)
- 입력:
  - `id`: 문자열 (min 1) — 필수
  - `reason`: 문자열 (min 2, max 200) — 필수
  - `requestId`: 문자열 (uuid) — 필수, 멱등성 키

#### `sales.taxInvoice` — query

- 권한: `sales.read`
- 멱등(requestId): 해당 없음 (query)
- 입력:
  - `documentId`: 문자열 (min 1) — 필수

#### `sales.issueTaxInvoice` — mutation

- 권한: `sales.write`
- 멱등(requestId): 예 — 3번째 인자로 `tx()`에 전달됨 (`input.requestId`)
- 입력:
  - `documentId`: 문자열 (min 1) — 필수
  - `email`: 문자열 (email) — 선택
  - `send`: 불리언 — 선택, 기본값=false
  - `requestId`: 문자열 (uuid) — 필수, 멱등성 키

#### `sales.taxInvoiceHistory` — query

- 권한: `sales.read`
- 멱등(requestId): 해당 없음 (query)
- 입력:
  - `documentId`: 문자열 (min 1) — 필수

#### `sales.purchaseRequests` — query

- 권한: `purchase.read`
- 멱등(requestId): 해당 없음 (query)
- 입력:
  - `page`: 숫자 (int, min 1) — 선택, 기본값=1
  - `pageSize`: 숫자 (int, min 1, max 200) — 선택, 기본값=50
  - `sortBy`: 문자열 — 선택
  - `sortDir`: enum(asc | desc) — 선택, 기본값='desc'
  - `status`: 문자열 — 선택
  - `q`: 문자열 (trim, max 200) — 선택
  - `from`: 문자열 (regex /^\d{4}-\d{2}-\d{2}$/) — 선택
  - `to`: 문자열 (regex /^\d{4}-\d{2}-\d{2}$/) — 선택

#### `sales.purchaseRequestsCsv` — query

- 권한: `purchase.read`
- 멱등(requestId): 해당 없음 (query)
- 입력:
  - `status`: 문자열 — 선택
  - `q`: 문자열 (trim, max 200) — 선택
  - `from`: 문자열 (regex /^\d{4}-\d{2}-\d{2}$/) — 선택
  - `to`: 문자열 (regex /^\d{4}-\d{2}-\d{2}$/) — 선택

#### `sales.purchaseRequest` — query

- 권한: `purchase.read`
- 멱등(requestId): 해당 없음 (query)
- 입력:
  - `id`: 문자열 (min 1) — 필수

#### `sales.createPurchaseRequest` — mutation

- 권한: `purchase.write`
- 멱등(requestId): 예 — 3번째 인자로 `tx()`에 전달됨 (`input.requestId`)
- 입력:
  - `docDate`: 문자열 (regex /^\d{4}-\d{2}-\d{2}$/) — 선택
  - `requiredDate`: 문자열 (regex /^\d{4}-\d{2}-\d{2}$/) — 선택
  - `divisionId`: 문자열 (min 1) — 선택
  - `purpose`: 문자열 (max 200) — 선택
  - `note`: 문자열 (max 1000) — 선택
  - `lines`: 배열 (min 1, max 300) — 필수
    배열 원소:
    - `itemId`: 문자열 (min 1) — 필수
    - `description`: 문자열 (max 200) — 선택
    - `quantity`: 정밀 소수 문자열 (scale=3, 비음수) — 필수
    - `unitPrice`: 정밀 소수 문자열 (scale=4, 비음수) — 필수
    - `taxType`: enum(TAXABLE | ZERO | EXEMPT) — 선택
    - `sourceLineId`: 문자열 (min 1) — 선택
    - `originalLineId`: 문자열 (min 1) — 선택
    - `suggestedSupplierId`: 문자열 (min 1) — 선택
  - `requestId`: 문자열 (uuid) — 필수, 멱등성 키

#### `sales.convertRequestToOrder` — mutation

- 권한: `purchase.write`
- 멱등(requestId): 예 — 3번째 인자로 `tx()`에 전달됨 (`input.idempotencyKey`)
- 입력:
  - `requestId`: 문자열 (min 1) — 필수
  - `partnerId`: 문자열 (min 1) — 필수
  - `lines`: 배열 (min 1, max 300) — 필수
    배열 원소:
    - `sourceLineId`: 문자열 (min 1) — 필수
    - `quantity`: 정밀 소수 문자열 (scale=3, 비음수) — 필수
    - `unitPrice`: 정밀 소수 문자열 (scale=4, 비음수) — 선택
  - `dueDate`: 문자열 (regex /^\d{4}-\d{2}-\d{2}$/) — 선택
  - `note`: 문자열 (max 1000) — 선택
  - `idempotencyKey`: 문자열 (uuid) — 필수, 멱등성 키

#### `sales.purchaseOrders` — query

- 권한: `purchase.read`
- 멱등(requestId): 해당 없음 (query)
- 입력:
  - `page`: 숫자 (int, min 1) — 선택, 기본값=1
  - `pageSize`: 숫자 (int, min 1, max 200) — 선택, 기본값=50
  - `sortBy`: 문자열 — 선택
  - `sortDir`: enum(asc | desc) — 선택, 기본값='desc'
  - `status`: 문자열 — 선택
  - `partnerId`: 문자열 (min 1) — 선택
  - `q`: 문자열 (trim, max 200) — 선택
  - `from`: 문자열 (regex /^\d{4}-\d{2}-\d{2}$/) — 선택
  - `to`: 문자열 (regex /^\d{4}-\d{2}-\d{2}$/) — 선택

#### `sales.purchaseOrdersCsv` — query

- 권한: `purchase.read`
- 멱등(requestId): 해당 없음 (query)
- 입력:
  - `status`: 문자열 — 선택
  - `partnerId`: 문자열 (min 1) — 선택
  - `q`: 문자열 (trim, max 200) — 선택
  - `from`: 문자열 (regex /^\d{4}-\d{2}-\d{2}$/) — 선택
  - `to`: 문자열 (regex /^\d{4}-\d{2}-\d{2}$/) — 선택

#### `sales.purchaseOrder` — query

- 권한: `purchase.read`
- 멱등(requestId): 해당 없음 (query)
- 입력:
  - `id`: 문자열 (min 1) — 필수

#### `sales.purchaseDocuments` — query

- 권한: `purchase.read`
- 멱등(requestId): 해당 없음 (query)
- 입력:
  - `page`: 숫자 (int, min 1) — 선택, 기본값=1
  - `pageSize`: 숫자 (int, min 1, max 200) — 선택, 기본값=50
  - `sortBy`: 문자열 — 선택
  - `sortDir`: enum(asc | desc) — 선택, 기본값='desc'
  - `docType`: enum(PURCHASE | RETURN_PURCHASE) — 선택
  - `status`: 문자열 — 선택
  - `partnerId`: 문자열 (min 1) — 선택
  - `q`: 문자열 (trim, max 200) — 선택
  - `from`: 문자열 (regex /^\d{4}-\d{2}-\d{2}$/) — 선택
  - `to`: 문자열 (regex /^\d{4}-\d{2}-\d{2}$/) — 선택

#### `sales.purchaseDocumentsCsv` — query

- 권한: `purchase.read`
- 멱등(requestId): 해당 없음 (query)
- 입력:
  - `docType`: enum(PURCHASE | RETURN_PURCHASE) — 선택
  - `status`: 문자열 — 선택
  - `partnerId`: 문자열 (min 1) — 선택
  - `q`: 문자열 (trim, max 200) — 선택
  - `from`: 문자열 (regex /^\d{4}-\d{2}-\d{2}$/) — 선택
  - `to`: 문자열 (regex /^\d{4}-\d{2}-\d{2}$/) — 선택

#### `sales.purchaseDocument` — query

- 권한: `purchase.read`
- 멱등(requestId): 해당 없음 (query)
- 입력:
  - `id`: 문자열 (min 1) — 필수

#### `sales.createPurchaseDocument` — mutation

- 권한: `purchase.write`
- 멱등(requestId): 예 — 3번째 인자로 `tx()`에 전달됨 (`input.requestId`)
- 입력:
  - `docType`: enum(PURCHASE | RETURN_PURCHASE) — 선택
  - `docDate`: 문자열 (regex /^\d{4}-\d{2}-\d{2}$/) — 선택
  - `partnerId`: 문자열 (min 1) — 필수
  - `warehouseId`: 문자열 (min 1) — 필수
  - `divisionId`: 문자열 (min 1) — 선택
  - `note`: 문자열 (max 1000) — 선택
  - `originalId`: 문자열 (min 1) — 선택
  - `lines`: 배열 (min 1, max 300) — 필수
    배열 원소:
    - `itemId`: 문자열 (min 1) — 필수
    - `description`: 문자열 (max 200) — 선택
    - `quantity`: 정밀 소수 문자열 (scale=3, 비음수) — 필수
    - `unitPrice`: 정밀 소수 문자열 (scale=4, 비음수) — 필수
    - `taxType`: enum(TAXABLE | ZERO | EXEMPT) — 선택
    - `sourceLineId`: 문자열 (min 1) — 선택
    - `originalLineId`: 문자열 (min 1) — 선택
    - `suggestedSupplierId`: 문자열 (min 1) — 선택
  - `requestId`: 문자열 (uuid) — 필수, 멱등성 키

#### `sales.confirmPurchaseDocument` — mutation

- 권한: `purchase.confirm`
- 멱등(requestId): 예 — 3번째 인자로 `tx()`에 전달됨 (`input.requestId`)
- 입력:
  - `id`: 문자열 (min 1) — 필수
  - `version`: 숫자 (int) — 필수
  - `requestId`: 문자열 (uuid) — 필수, 멱등성 키

#### `sales.cancelPurchaseDocument` — mutation

- 권한: `purchase.cancel`
- 멱등(requestId): 예 — 3번째 인자로 `tx()`에 전달됨 (`input.requestId`)
- 입력:
  - `id`: 문자열 (min 1) — 필수
  - `reason`: 문자열 (min 2, max 200) — 필수
  - `version`: 숫자 (int) — 필수
  - `requestId`: 문자열 (uuid) — 필수, 멱등성 키

#### `sales.aging` — query

- 권한: `settlement.read`
- 멱등(requestId): 해당 없음 (query)
- 입력:
  - `asOf`: 문자열 (regex /^\d{4}-\d{2}-\d{2}$/) — 선택
  - `partnerId`: 문자열 (min 1) — 선택

#### `sales.payableSummary` — query

- 권한: `settlement.read`
- 멱등(requestId): 해당 없음 (query)
- 입력:
  - `partnerId`: 문자열 (min 1) — 선택

#### `sales.openItems` — query

- 권한: `settlement.read`
- 멱등(requestId): 해당 없음 (query)
- 입력:
  - `partnerId`: 문자열 (min 1) — 필수
  - `kind`: enum(RECEIVABLE | PAYABLE) — 필수

#### `sales.settlements` — query

- 권한: `settlement.read`
- 멱등(requestId): 해당 없음 (query)
- 입력:
  - `page`: 숫자 (int, min 1) — 선택, 기본값=1
  - `pageSize`: 숫자 (int, min 1, max 200) — 선택, 기본값=50
  - `sortBy`: 문자열 — 선택
  - `sortDir`: enum(asc | desc) — 선택, 기본값='desc'
  - `docType`: enum(RECEIPT | PAYMENT) — 선택
  - `status`: 문자열 — 선택
  - `partnerId`: 문자열 (min 1) — 선택
  - `from`: 문자열 (regex /^\d{4}-\d{2}-\d{2}$/) — 선택
  - `to`: 문자열 (regex /^\d{4}-\d{2}-\d{2}$/) — 선택

#### `sales.settlement` — query

- 권한: `settlement.read`
- 멱등(requestId): 해당 없음 (query)
- 입력:
  - `id`: 문자열 (min 1) — 필수

#### `sales.createSettlement` — mutation

- 권한: `settlement.write`
- 멱등(requestId): 예 — 3번째 인자로 `tx()`에 전달됨 (`input.requestId`)
- 입력:
  - `docType`: enum(RECEIPT | PAYMENT) — 필수
  - `docDate`: 문자열 (regex /^\d{4}-\d{2}-\d{2}$/) — 선택
  - `partnerId`: 문자열 (min 1) — 필수
  - `amount`: 정밀 소수 문자열 (scale=0, 비음수) — 필수
  - `method`: 문자열 (max 30) — 선택
  - `bankAccount`: 문자열 (max 60) — 선택
  - `note`: 문자열 (max 500) — 선택
  - `requestId`: 문자열 (uuid) — 필수, 멱등성 키

#### `sales.autoAllocate` — mutation

- 권한: `settlement.write`
- 멱등(requestId): 예 — 3번째 인자로 `tx()`에 전달됨 (`input.requestId`)
- 입력:
  - `id`: 문자열 (min 1) — 필수
  - `requestId`: 문자열 (uuid) — 필수, 멱등성 키

#### `sales.reallocate` — mutation

- 권한: `settlement.write`
- 멱등(requestId): 예 — 3번째 인자로 `tx()`에 전달됨 (`input.requestId`)
- 입력:
  - `id`: 문자열 (min 1) — 필수
  - `reason`: 문자열 (min 2, max 200) — 필수
  - `allocations`: 배열 (min 1, max 200) — 필수
    배열 원소:
    - `targetId`: 문자열 (min 1) — 필수
    - `amount`: 정밀 소수 문자열 (scale=0, 비음수) — 필수
    - `note`: 문자열 (max 200) — 선택
  - `requestId`: 문자열 (uuid) — 필수, 멱등성 키

#### `sales.confirmSettlement` — mutation

- 권한: `settlement.confirm`
- 멱등(requestId): 예 — 3번째 인자로 `tx()`에 전달됨 (`input.requestId`)
- 입력:
  - `id`: 문자열 (min 1) — 필수
  - `version`: 숫자 (int) — 필수
  - `requestId`: 문자열 (uuid) — 필수, 멱등성 키

#### `sales.cancelSettlement` — mutation

- 권한: `settlement.confirm`
- 멱등(requestId): 예 — 3번째 인자로 `tx()`에 전달됨 (`input.requestId`)
- 입력:
  - `id`: 문자열 (min 1) — 필수
  - `reason`: 문자열 (min 2, max 200) — 필수
  - `version`: 숫자 (int) — 필수
  - `requestId`: 문자열 (uuid) — 필수, 멱등성 키

## 정적 분석 한계

모든 프로시저의 입력 shape를 정적으로 해석했다 — 이 절이 채워지면 (위 목록) 원본 라우터 파일을 함께 확인할 것.
