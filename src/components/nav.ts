/**
 * UIX-06 / NFR-SEC-01: the menu is filtered by permission, and the server re-checks anyway.
 *
 * 메뉴는 화면과 떨어져 있는 별도 모듈이다. app-shell.tsx 안에 있을 때는 화면 파일이 늘어도
 * 메뉴가 그대로인 것을 아무도 알아채지 못했고, 실제로 품목분류 화면이 메뉴 없이 방치됐다.
 * 여기로 빼두면 tests/unit/nav.test.ts가 화면 목록과 대조할 수 있다.
 */
export interface NavItem {
  href: string;
  label: string;
  permission?: string;
  /** shown on mobile — the RFP requires approval and dashboards on phones (UIX-06) */
  mobile?: boolean;
}

export interface NavGroup {
  label: string;
  items: NavItem[];
}

export const NAV: NavGroup[] = [
  {
    label: '홈',
    items: [
      { href: '/home', label: '대시보드', mobile: true },
      { href: '/approval/inbox', label: '결재함', permission: 'approval.use', mobile: true },
    ],
  },
  {
    label: '기초정보',
    items: [
      { href: '/master/items', label: '품목', permission: 'master.read' },
      { href: '/master/categories', label: '품목분류', permission: 'master.read' },
      { href: '/master/items/bulk', label: '품목 일괄등록', permission: 'master.write' },
      { href: '/master/partners', label: '거래처', permission: 'master.read' },
      { href: '/master/warehouses', label: '창고', permission: 'master.read' },
      { href: '/master/divisions', label: '사업부', permission: 'master.read' },
      { href: '/master/codes', label: '공통코드', permission: 'master.read' },
      { href: '/master/numbering', label: '채번규칙', permission: 'admin.settings' },
    ],
  },
  {
    label: '매출·매입·발주',
    items: [
      { href: '/sales/quotations', label: '견적', permission: 'sales.read' },
      { href: '/sales/orders', label: '주문', permission: 'sales.read' },
      { href: '/sales/sales-documents', label: '매출전표', permission: 'sales.read' },
      { href: '/sales/purchase-documents', label: '매입전표', permission: 'purchase.read' },
      { href: '/sales/purchase-requests', label: '구매요청', permission: 'purchase.read' },
      { href: '/sales/purchase-orders', label: '발주', permission: 'purchase.read' },
      { href: '/sales/returns', label: '반품', permission: 'sales.read' },
      { href: '/settlement/receipts', label: '수금', permission: 'settlement.read' },
      { href: '/settlement/payments', label: '지급', permission: 'settlement.read' },
      { href: '/settlement/receivables', label: '미수', permission: 'settlement.read' },
      { href: '/settlement/payables', label: '미지급', permission: 'settlement.read' },
    ],
  },
  {
    label: '재고',
    items: [
      { href: '/inventory/stock-in', label: '입고', permission: 'inventory.read' },
      { href: '/inventory/stock-out', label: '출고', permission: 'inventory.read' },
      { href: '/inventory/moves', label: '이동', permission: 'inventory.read' },
      { href: '/inventory/status', label: '재고현황', permission: 'inventory.read', mobile: true },
      { href: '/inventory/ledger', label: '수불부', permission: 'inventory.read' },
      { href: '/inventory/counts', label: '실사', permission: 'inventory.count' },
      { href: '/inventory/valuation', label: '재고평가·마감', permission: 'inventory.valuation' },
    ],
  },
  {
    label: '회계',
    items: [
      { href: '/accounting/accounts', label: '계정과목', permission: 'accounting.read' },
      { href: '/accounting/journals', label: '전표', permission: 'accounting.read' },
      { href: '/accounting/rules', label: '분개규칙', permission: 'accounting.rules' },
      { href: '/accounting/ledger', label: '원장', permission: 'accounting.read' },
      { href: '/accounting/income-statement', label: '손익', permission: 'accounting.read' },
      { href: '/accounting/balance-sheet', label: '재무상태', permission: 'accounting.read' },
      { href: '/accounting/close', label: '마감', permission: 'accounting.close' },
    ],
  },
  {
    label: '전자결재',
    items: [
      { href: '/approval/draft', label: '기안', permission: 'approval.use', mobile: true },
      { href: '/approval/forms', label: '양식', permission: 'approval.admin' },
      { href: '/approval/lines', label: '결재선·전결', permission: 'approval.admin' },
      { href: '/approval/search', label: '문서검색', permission: 'approval.use' },
    ],
  },
  {
    label: '인사',
    items: [
      { href: '/hr/employees', label: '사원', permission: 'hr.read' },
      { href: '/hr/org', label: '조직도', permission: 'hr.read' },
      { href: '/hr/assignments', label: '발령', permission: 'hr.write' },
      { href: '/hr/attendance', label: '근태', permission: 'hr.attendance', mobile: true },
      { href: '/hr/leave', label: '휴가·연차', permission: 'hr.self', mobile: true },
      { href: '/hr/documents', label: '인사서류', permission: 'hr.read' },
      { href: '/hr/certificates', label: '증명서', permission: 'hr.self' },
      { href: '/hr/overview', label: '인사현황', permission: 'hr.read' },
      { href: '/hr/me', label: '내 정보', permission: 'hr.self', mobile: true },
    ],
  },
  {
    label: '보고서',
    items: [
      // UIX-06: reports are 조회 screens, which is exactly what phones are scoped to
      { href: '/reports/sales', label: '매출', permission: 'report.read', mobile: true },
      { href: '/reports/items', label: '품목', permission: 'report.read', mobile: true },
      { href: '/reports/partners', label: '거래처', permission: 'report.read', mobile: true },
      { href: '/reports/inventory', label: '재고', permission: 'report.read', mobile: true },
      { href: '/reports/receivables', label: '채권채무', permission: 'report.read', mobile: true },
      { href: '/reports/approval', label: '결재', permission: 'report.read', mobile: true },
      { href: '/reports/hr', label: '근태·인원', permission: 'report.read', mobile: true },
    ],
  },
  {
    label: '시스템',
    items: [
      { href: '/system/users', label: '사용자', permission: 'admin.users' },
      { href: '/system/roles', label: '권한', permission: 'admin.roles' },
      { href: '/system/policies', label: '정책설정', permission: 'admin.settings' },
      { href: '/system/jobs', label: '실패작업', permission: 'admin.jobs' },
      { href: '/system/audit', label: '감사로그', permission: 'admin.audit' },
      { href: '/system/migration', label: '데이터 이관', permission: 'admin.migration' },
      { href: '/system/retention', label: '개인정보 파기', permission: 'admin.settings' },
    ],
  },
  {
    label: '내 설정',
    items: [
      { href: '/account', label: '내 계정' },
      { href: '/master/preferences', label: '저장한 조회조건' },
    ],
  },
];
