/**
 * MIG-01..08 — the source file layouts.
 *
 * Each target has one template and the template is versioned, so a file written against an
 * older layout is refused with an explanation rather than silently read into the wrong
 * columns. The version is on the batch, so a migration that ran last month can still be
 * read back with the layout it actually used.
 */

export const TEMPLATE_VERSION = 1;

export interface TemplateColumn {
  key: string;
  label: string;
  required?: boolean;
  note?: string;
  /** NFR-SEC-05: never echoed into an error file or a log line */
  sensitive?: boolean;
}

export const MIGRATION_TARGETS = [
  'ITEM',
  'PARTNER',
  'OPENING_STOCK',
  'OPEN_ITEM',
  'ACCOUNT',
  'OPENING_BALANCE',
  'DEPARTMENT',
  'EMPLOYEE',
  'LEAVE',
  'HISTORICAL_SALES',
] as const;

export type MigrationTarget = (typeof MIGRATION_TARGETS)[number];

export const TARGET_LABEL: Record<MigrationTarget, string> = {
  ITEM: '품목',
  PARTNER: '거래처',
  OPENING_STOCK: '기초재고',
  OPEN_ITEM: '미수·미지급',
  ACCOUNT: '계정과목',
  OPENING_BALANCE: '기초잔액',
  DEPARTMENT: '부서·조직',
  EMPLOYEE: '사원',
  LEAVE: '연차',
  HISTORICAL_SALES: '과거 매출전표',
};

/**
 * Whether applying a row twice would double something.
 *
 * Master data is idempotent by nature: applying the same item row again just writes the
 * same values. Ledger-shaped targets are not, and those are the ones the row register
 * protects. Saying which is which here, rather than in each target's code, is what makes
 * the partial-application policy explicit (MIG-09).
 */
export const ACCUMULATES: Record<MigrationTarget, boolean> = {
  ITEM: false,
  PARTNER: false,
  OPENING_STOCK: true,
  OPEN_ITEM: true,
  ACCOUNT: false,
  OPENING_BALANCE: true,
  DEPARTMENT: false,
  EMPLOYEE: false,
  LEAVE: true,
  HISTORICAL_SALES: true,
};

export const TEMPLATES: Record<MigrationTarget, TemplateColumn[]> = {
  ITEM: [
    { key: 'code', label: '품목코드', note: '비우면 자동채번' },
    { key: 'name', label: '품목명', required: true },
    { key: 'spec', label: '규격' },
    { key: 'unitCode', label: '단위', note: '기본 EA' },
    { key: 'categoryCode', label: '품목분류코드', note: '최하위 분류' },
    { key: 'purchasePrice', label: '입고단가' },
    { key: 'salesPrice', label: '출고단가' },
    { key: 'taxType', label: '과세구분', note: 'TAXABLE|ZERO|EXEMPT' },
    { key: 'barcode', label: '바코드' },
    { key: 'safetyStock', label: '안전재고' },
    { key: 'leadTimeDays', label: '리드타임(일)' },
    { key: 'supplierCode', label: '기본매입처코드' },
  ],
  PARTNER: [
    { key: 'code', label: '거래처코드', note: '비우면 자동채번' },
    { key: 'name', label: '거래처명', required: true },
    { key: 'businessNo', label: '사업자등록번호' },
    { key: 'ceoName', label: '대표자' },
    { key: 'businessType', label: '업태' },
    { key: 'businessItem', label: '종목' },
    { key: 'address', label: '주소' },
    { key: 'phone', label: '전화번호' },
    { key: 'email', label: '이메일' },
    { key: 'partnerType', label: '거래유형', note: 'CUSTOMER|SUPPLIER|BOTH' },
    { key: 'paymentTerms', label: '결제조건' },
    { key: 'creditLimit', label: '여신한도' },
  ],
  OPENING_STOCK: [
    { key: 'warehouseCode', label: '창고코드', required: true },
    { key: 'itemCode', label: '품목코드', required: true },
    { key: 'quantity', label: '수량', required: true },
    { key: 'unitCost', label: '단가', required: true, note: '기준일 평가단가' },
  ],
  OPEN_ITEM: [
    { key: 'kind', label: '구분', required: true, note: 'RECEIVABLE|PAYABLE' },
    { key: 'partnerCode', label: '거래처코드', required: true },
    { key: 'docNo', label: '원천 전표번호', required: true, note: '기존 시스템의 번호' },
    { key: 'docDate', label: '발생일', required: true },
    { key: 'dueDate', label: '지급기일' },
    { key: 'amount', label: '금액', required: true },
    { key: 'settledAmount', label: '기수금·기지급액' },
  ],
  ACCOUNT: [
    { key: 'code', label: '계정코드', required: true },
    { key: 'name', label: '계정명', required: true },
    { key: 'accountType', label: '계정유형', required: true, note: 'ASSET|LIABILITY|EQUITY|REVENUE|EXPENSE' },
    { key: 'parentCode', label: '상위 계정코드' },
  ],
  OPENING_BALANCE: [
    { key: 'periodKey', label: '기준월', required: true, note: 'YYYY-MM' },
    { key: 'accountCode', label: '계정코드', required: true },
    { key: 'divisionCode', label: '사업부코드' },
    { key: 'debit', label: '차변', note: '차변 또는 대변 한쪽만' },
    { key: 'credit', label: '대변' },
  ],
  DEPARTMENT: [
    { key: 'code', label: '부서코드', required: true },
    { key: 'name', label: '부서명', required: true },
    { key: 'parentCode', label: '상위 부서코드' },
    { key: 'validFrom', label: '적용시작일', required: true },
  ],
  EMPLOYEE: [
    { key: 'employeeNo', label: '사번', required: true },
    { key: 'name', label: '성명', required: true },
    { key: 'departmentCode', label: '부서코드' },
    { key: 'jobTitle', label: '직위' },
    { key: 'hireDate', label: '입사일', required: true },
    { key: 'leaveDate', label: '퇴사일', note: '재직자는 비움' },
    { key: 'email', label: '이메일' },
    { key: 'phone', label: '연락처', sensitive: true },
    { key: 'residentNo', label: '주민등록번호', sensitive: true },
    { key: 'bankAccount', label: '계좌번호', sensitive: true },
  ],
  LEAVE: [
    { key: 'employeeNo', label: '사번', required: true },
    { key: 'leaveType', label: '휴가유형', note: '기본 ANNUAL' },
    { key: 'grantDate', label: '부여일', required: true },
    { key: 'expiresAt', label: '소멸일', required: true },
    { key: 'grantedDays', label: '부여일수', required: true },
    { key: 'usedDays', label: '사용일수', note: '기준일까지 사용한 일수' },
  ],
  HISTORICAL_SALES: [
    { key: 'docNo', label: '원천 전표번호', required: true },
    { key: 'docDate', label: '전표일자', required: true },
    { key: 'partnerCode', label: '거래처코드', required: true },
    { key: 'warehouseCode', label: '창고코드', required: true },
    { key: 'itemCode', label: '품목코드', required: true },
    { key: 'quantity', label: '수량', required: true },
    { key: 'unitPrice', label: '단가', required: true },
    { key: 'taxType', label: '과세구분', note: 'TAXABLE|ZERO|EXEMPT' },
  ],
};

/** The columns whose values must never leave the row they came from. */
export function sensitiveKeys(target: MigrationTarget): Set<string> {
  return new Set(TEMPLATES[target].filter((c) => c.sensitive).map((c) => c.key));
}
