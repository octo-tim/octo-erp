import 'dotenv/config';
import { prisma } from '../src/server/db';
import { hashPassword } from '../src/server/core/crypto';
import { moduleOf, PERMISSIONS, ROLE_PRESETS } from '../src/server/modules/rbac/permissions';
import { DOC_TYPES } from '../src/server/modules/numbering/service';
import { toDateOnly } from '../src/lib/dates';
import { DEFAULT_FORMS } from '../src/server/modules/approval/form';
import { DEFAULT_TEMPLATES, RULE_LABEL } from '../src/server/modules/accounting/posting-rule';

const ADMIN_USERNAME = process.env['SEED_ADMIN_USERNAME'] ?? 'admin';
const ADMIN_PASSWORD = process.env['SEED_ADMIN_PASSWORD'] ?? 'Admin!2345';

async function seedPermissionsAndRoles() {
  for (const [code, description] of PERMISSIONS) {
    await prisma.permission.upsert({
      where: { code },
      create: { code, module: moduleOf(code), description },
      update: { module: moduleOf(code), description },
    });
  }
  const all = await prisma.permission.findMany();
  const byCode = new Map(all.map((p) => [p.code, p.id]));

  for (const [code, preset] of Object.entries(ROLE_PRESETS)) {
    const role = await prisma.role.upsert({
      where: { code },
      create: { code, name: preset.name, isSystem: true },
      update: { name: preset.name },
    });
    const codes = preset.permissions === '*' ? all.map((p) => p.code) : preset.permissions;
    await prisma.rolePermission.deleteMany({ where: { roleId: role.id } });
    await prisma.rolePermission.createMany({
      data: codes.flatMap((c) => {
        const id = byCode.get(c);
        return id ? [{ roleId: role.id, permissionId: id }] : [];
      }),
    });
  }
}

async function seedOrganization() {
  const divisions = [
    ['D01', '건축자재유통', 1],
    ['D02', '필름수입', 2],
    ['D03', '공동구매대행', 3],
    ['D04', '자체브랜드', 4],
    ['D05', '해외사업대행', 5],
    ['D09', '공통관리', 9],
  ] as const;
  for (const [code, name, sortOrder] of divisions) {
    await prisma.division.upsert({
      where: { code },
      create: { code, name, sortOrder },
      update: { name, sortOrder },
    });
  }

  const warehouses = [
    ['W01', '본사창고', 'NORMAL'],
    ['W02', '제2창고', 'NORMAL'],
    ['W03', '불량창고', 'DEFECT'],
    ['W04', '위탁창고', 'CONSIGNED'],
  ] as const;
  for (const [code, name, type] of warehouses) {
    await prisma.warehouse.upsert({ where: { code }, create: { code, name, type }, update: { name, type } });
  }

  const validFrom = toDateOnly('2020-01-01');
  const root = await prisma.department.upsert({
    where: { code: 'HQ' },
    create: { code: 'HQ', name: '옥토웍스', validFrom, sortOrder: 0 },
    update: {},
  });
  const departments = [
    ['MGT', '경영지원팀', 1],
    ['SAL', '영업팀', 2],
    ['PUR', '구매물류팀', 3],
    ['ACC', '회계팀', 4],
  ] as const;
  for (const [code, name, sortOrder] of departments) {
    await prisma.department.upsert({
      where: { code },
      create: { code, name, parentId: root.id, validFrom, sortOrder },
      update: { name, parentId: root.id, sortOrder },
    });
  }
}

async function seedNumberingRules() {
  const rules: [string, string, 'NONE' | 'YEAR' | 'MONTH', number][] = [
    [DOC_TYPES.ITEM, 'IT', 'NONE', 6],
    [DOC_TYPES.PARTNER, 'PT', 'NONE', 5],
    [DOC_TYPES.QUOTATION, 'QT', 'MONTH', 4],
    [DOC_TYPES.SALES_ORDER, 'SO', 'MONTH', 4],
    [DOC_TYPES.SALES, 'SL', 'MONTH', 4],
    [DOC_TYPES.PURCHASE, 'PU', 'MONTH', 4],
    [DOC_TYPES.PURCHASE_REQUEST, 'PR', 'MONTH', 4],
    [DOC_TYPES.PURCHASE_ORDER, 'PO', 'MONTH', 4],
    [DOC_TYPES.RETURN_SALES, 'RS', 'MONTH', 4],
    [DOC_TYPES.RETURN_PURCHASE, 'RP', 'MONTH', 4],
    [DOC_TYPES.RECEIPT, 'RC', 'MONTH', 4],
    [DOC_TYPES.PAYMENT, 'PY', 'MONTH', 4],
    [DOC_TYPES.STOCK_IN, 'SI', 'MONTH', 4],
    [DOC_TYPES.STOCK_OUT, 'SO2', 'MONTH', 4],
    [DOC_TYPES.STOCK_MOVE, 'SM', 'MONTH', 4],
    [DOC_TYPES.STOCK_COUNT, 'SC', 'MONTH', 4],
    [DOC_TYPES.STOCK_ADJUST, 'SA', 'MONTH', 4],
    [DOC_TYPES.JOURNAL, 'JV', 'MONTH', 5],
    [DOC_TYPES.APPROVAL, 'AP', 'MONTH', 4],
    [DOC_TYPES.LEAVE_REQUEST, 'LV', 'MONTH', 4],
    [DOC_TYPES.ATTENDANCE_CORRECTION, 'AC', 'MONTH', 4],
    [DOC_TYPES.CERTIFICATE, 'CT', 'YEAR', 4],
  ];
  for (const [docType, prefix, periodKind, seqLength] of rules) {
    await prisma.numberingRule.upsert({
      where: { docType },
      create: { docType, prefix, periodKind, seqLength },
      update: { prefix, periodKind, seqLength },
    });
  }
}

/** DEC-01~09 provisional baselines (docs/decision-register.md, ADR-0003..0010). */
async function seedPolicies() {
  const from = toDateOnly('2020-01-01');
  const policies: { key: string; config: unknown; note: string }[] = [
    {
      key: 'money',
      note: 'DEC-02 / ADR-0004',
      config: {
        currency: 'KRW',
        amountScale: 0,
        quantityScale: 3,
        unitPriceScale: 4,
        vatRate: '0.1',
        rounding: 'FLOOR',
      },
    },
    {
      key: 'inventory.valuation',
      note: 'DEC-01 / ADR-0003',
      config: { method: 'MONTHLY_AVERAGE', provisionalWithinMonth: true, closeAdjusts: true },
    },
    {
      key: 'approval.matrix',
      note: 'DEC-03 / ADR-0005',
      config: {
        creditLimit: 'BLOCK',
        rules: [
          { docType: 'QUOTATION', mode: 'EXEMPT' },
          { docType: 'SALES_ORDER', mode: 'EXEMPT' },
          { docType: 'SALES', mode: 'EXEMPT' },
          { docType: 'PURCHASE', mode: 'REQUIRED', minAmount: '3000000' },
          { docType: 'PURCHASE_REQUEST', mode: 'REQUIRED' },
          { docType: 'PURCHASE_ORDER', mode: 'EXEMPT' },
          { docType: 'RETURN_SALES', mode: 'EXEMPT' },
          { docType: 'RETURN_PURCHASE', mode: 'EXEMPT' },
          { docType: 'RECEIPT', mode: 'EXEMPT' },
          { docType: 'PAYMENT', mode: 'EXEMPT' },
          { docType: 'STOCK_IN', mode: 'REQUIRED', minAmount: '1000000' },
          { docType: 'STOCK_OUT', mode: 'REQUIRED', minAmount: '1000000' },
          { docType: 'STOCK_ADJUST', mode: 'REQUIRED', minAmount: '1000000' },
          { docType: 'JOURNAL', mode: 'REQUIRED', minAmount: '5000000' },
        ],
      },
    },
    {
      key: 'accounting.period',
      note: 'DEC-04 / ADR-0006',
      config: { kind: 'CALENDAR_MONTH', reopenPermission: 'period.reopen', reversalUsesOpenPeriod: true },
    },
    {
      key: 'leave',
      note: 'DEC-05 / ADR-0007',
      config: {
        basis: 'HIRE_DATE',
        underOneYear: { perMonth: 1, max: 11 },
        baseDays: 15,
        bonus: { startYear: 3, everyYears: 2, days: 1, max: 25 },
        attendanceRateRequired: 0.8,
        deemedAttendance: ['PARENTAL_LEAVE', 'INDUSTRIAL_ACCIDENT', 'MATERNITY_LEAVE', 'ANNUAL_LEAVE'],
        validMonths: 12,
        halfDay: true,
        weeklyStandardMinutes: 2400,
        weeklyOvertimeLimitMinutes: 720,
        nightStartHour: 22,
        nightEndHour: 6,
      },
    },
    {
      key: 'retention',
      note: 'DEC-06 / ADR-0008',
      config: {
        items: [
          { key: 'employee.resigned', label: '퇴직자 인사기록', years: 3, action: 'ANONYMIZE' },
          { key: 'employee.contract', label: '근로계약·임금 관련 서류', years: 3, action: 'PURGE' },
          { key: 'employee.sensitive', label: '주민번호·계좌번호', years: 0, action: 'PURGE' },
          { key: 'audit', label: '감사로그', years: 5, action: 'KEEP' },
          { key: 'approval', label: '결재문서', years: null, action: 'KEEP' },
        ],
      },
    },
    {
      key: 'notification',
      note: 'DEC-09 / ADR-0010',
      config: {
        channels: { app: true, email: true, messenger: 'NONE' },
        backoffMs: [60000, 300000, 1800000, 7200000, 43200000],
        longPendingBusinessDays: 3,
      },
    },
  ];

  for (const p of policies) {
    const exists = await prisma.policyVersion.findFirst({ where: { policyKey: p.key } });
    if (exists) continue;
    await prisma.policyVersion.create({
      data: { policyKey: p.key, version: 1, effectiveFrom: from, config: p.config as never, note: p.note },
    });
  }
}

async function seedAdminUser() {
  const adminRole = await prisma.role.findUniqueOrThrow({ where: { code: 'admin' } });
  const existing = await prisma.user.findUnique({ where: { username: ADMIN_USERNAME } });
  if (existing) return;

  const divisions = await prisma.division.findMany({ select: { id: true } });
  const warehouses = await prisma.warehouse.findMany({ select: { id: true } });

  await prisma.user.create({
    data: {
      username: ADMIN_USERNAME,
      displayName: '시스템 관리자',
      passwordHash: await hashPassword(ADMIN_PASSWORD),
      mustChangePassword: true,
      roles: { create: [{ roleId: adminRole.id }] },
      divisionScopes: { create: divisions.map((d) => ({ divisionId: d.id })) },
      warehouseScopes: { create: warehouses.map((w) => ({ warehouseId: w.id })) },
    },
  });
}

async function seedSystemSettings() {
  const settings: [string, unknown][] = [
    ['company.name', { value: '(주)옥토웍스' }],
    ['company.timezone', { value: 'Asia/Seoul' }],
    ['inventory.allowNegative', { value: false }],
    ['partner.requireBusinessNo', { value: false }],
    ['accounting.internalUseNotice', { value: '내부 관리용이며 세무신고·외부공시용 확정 재무제표가 아님' }],
  ];
  for (const [key, value] of settings) {
    await prisma.systemSetting.upsert({ where: { key }, create: { key, value: value as never }, update: {} });
  }
}

/** APV-02/03/05: default forms, a standard approval line and the amount-branching rules. */
async function seedApproval() {
  const effectiveFrom = toDateOnly('2020-01-01');

  for (const [index, def] of DEFAULT_FORMS.entries()) {
    const form = await prisma.approvalForm.upsert({
      where: { code: def.code },
      create: {
        code: def.code,
        name: def.name,
        category: def.category,
        targetType: def.targetType ?? null,
        sortOrder: index,
      },
      update: {
        name: def.name,
        category: def.category,
        targetType: def.targetType ?? null,
        sortOrder: index,
      },
    });
    const existing = await prisma.approvalFormVersion.findFirst({ where: { formId: form.id } });
    if (!existing) {
      await prisma.approvalFormVersion.create({
        data: { formId: form.id, version: 1, fieldSchema: def.fields as never, effectiveFrom },
      });
    }
  }

  // Standard line: department head approves; over 3,000,000 KRW the CEO is added.
  const standard = await prisma.approvalLineTemplate.upsert({
    where: { code: 'STANDARD' },
    create: { code: 'STANDARD', name: '기본 결재선 (부서장 → 대표)', editable: true },
    update: { name: '기본 결재선 (부서장 → 대표)' },
  });
  const steps = [
    {
      stepNo: 1,
      role: 'APPROVE',
      resolveBy: 'DRAFTER_MANAGER',
      canFinalize: true,
      minAmount: null as string | null,
    },
    {
      stepNo: 2,
      role: 'APPROVE',
      resolveBy: 'POSITION',
      positionCode: 'CEO',
      canFinalize: false,
      minAmount: '3000000',
    },
  ];
  for (const step of steps) {
    await prisma.approvalLineTemplateStep.upsert({
      where: { templateId_stepNo: { templateId: standard.id, stepNo: step.stepNo } },
      create: {
        templateId: standard.id,
        stepNo: step.stepNo,
        role: step.role,
        resolveBy: step.resolveBy,
        positionCode: 'positionCode' in step ? step.positionCode : null,
        canFinalize: step.canFinalize,
        minAmount: step.minAmount,
      },
      update: { canFinalize: step.canFinalize, minAmount: step.minAmount },
    });
  }

  await prisma.approvalRule.upsert({
    where: { code: 'DEFAULT' },
    create: {
      code: 'DEFAULT',
      name: '기본 규칙 (모든 양식)',
      lineTemplateId: standard.id,
      priority: 0,
    },
    update: { lineTemplateId: standard.id },
  });
}

/** BAS-07: common codes the business screens depend on from day one. */
async function seedCommonCodes() {
  const codes: [string, string, string, number][] = [
    ['UNIT', 'EA', '개', 1],
    ['UNIT', 'BOX', '박스', 2],
    ['UNIT', 'SET', '세트', 3],
    ['UNIT', 'M', 'm', 4],
    ['UNIT', 'M2', '㎡', 5],
    ['UNIT', 'KG', 'kg', 6],
    ['UNIT', 'ROLL', '롤', 7],
    ['PAYMENT_METHOD', 'TRANSFER', '계좌이체', 1],
    ['PAYMENT_METHOD', 'CARD', '카드', 2],
    ['PAYMENT_METHOD', 'CASH', '현금', 3],
    ['PAYMENT_METHOD', 'NOTE', '어음', 4],
    ['PAYMENT_TERMS', 'NET_30', '월말 30일', 1],
    ['PAYMENT_TERMS', 'NET_60', '월말 60일', 2],
    ['PAYMENT_TERMS', 'PREPAID', '선결제', 3],
    ['PAYMENT_TERMS', 'COD', '인도결제', 4],
    ['POSITION', 'CEO', '대표이사', 1],
    ['POSITION', 'EVP', '전무이사', 2],
    ['POSITION', 'DIRECTOR', '이사', 3],
    ['POSITION', 'MANAGER', '팀장', 4],
    ['POSITION', 'DEPUTY', '대리', 5],
    ['POSITION', 'STAFF', '사원', 6],
    ['STOCK_REASON_IN', 'PURCHASE', '매입입고', 1],
    ['STOCK_REASON_IN', 'RETURN_IN', '반품입고', 2],
    ['STOCK_REASON_IN', 'ADJUST_IN', '실사증가', 3],
    ['STOCK_REASON_IN', 'ETC_IN', '기타입고', 9],
    ['STOCK_REASON_OUT', 'SALES', '매출출고', 1],
    ['STOCK_REASON_OUT', 'SAMPLE', '샘플출고', 2],
    ['STOCK_REASON_OUT', 'DISPOSAL', '폐기', 3],
    ['STOCK_REASON_OUT', 'ADJUST_OUT', '실사감소', 4],
    ['STOCK_REASON_OUT', 'ETC_OUT', '기타출고', 9],
    ['LEAVE_TYPE', 'ANNUAL', '연차', 1],
    ['LEAVE_TYPE', 'SICK', '병가', 2],
    ['LEAVE_TYPE', 'SPECIAL', '경조사', 3],
  ];
  for (const [groupCode, code, name, sortOrder] of codes) {
    await prisma.commonCode.upsert({
      where: { groupCode_code: { groupCode, code } },
      create: { groupCode, code, name, sortOrder },
      update: { name, sortOrder },
    });
  }
}

/** BAS-01: a starter three-level item classification matching the six business lines. */
async function seedItemCategories() {
  const tree: {
    code: string;
    name: string;
    children: { code: string; name: string; children: { code: string; name: string }[] }[];
  }[] = [
    {
      code: 'C10',
      name: '건축자재',
      children: [
        {
          code: 'C1010',
          name: '환기·설비',
          children: [
            { code: 'C101010', name: '환기유닛' },
            { code: 'C101020', name: '덕트·부속' },
          ],
        },
        {
          code: 'C1020',
          name: '차양·창호',
          children: [
            { code: 'C102010', name: '전동차양' },
            { code: 'C102020', name: '창호부속' },
          ],
        },
      ],
    },
    {
      code: 'C20',
      name: '필름',
      children: [
        {
          code: 'C2010',
          name: '매트필름',
          children: [
            { code: 'C201010', name: '방염필름' },
            { code: 'C201020', name: '일반필름' },
          ],
        },
      ],
    },
    {
      code: 'C30',
      name: '자체브랜드',
      children: [{ code: 'C3010', name: '화장품', children: [{ code: 'C301010', name: '스킨케어' }] }],
    },
  ];

  for (const [i, level1] of tree.entries()) {
    const l1 = await prisma.itemCategory.upsert({
      where: { code: level1.code },
      create: { code: level1.code, name: level1.name, level: 1, sortOrder: i },
      update: { name: level1.name },
    });
    for (const [j, level2] of level1.children.entries()) {
      const l2 = await prisma.itemCategory.upsert({
        where: { code: level2.code },
        create: { code: level2.code, name: level2.name, level: 2, parentId: l1.id, sortOrder: j },
        update: { name: level2.name, parentId: l1.id },
      });
      for (const [k, level3] of level2.children.entries()) {
        await prisma.itemCategory.upsert({
          where: { code: level3.code },
          create: { code: level3.code, name: level3.name, level: 3, parentId: l2.id, sortOrder: k },
          update: { name: level3.name, parentId: l2.id },
        });
      }
    }
  }
}

/**
 * ACC-01/ACC-03: a small standard chart of accounts, the slot mappings the posting rules
 * resolve through, and the DEFAULT_TEMPLATES as version 1 of each rule. Standard accounts
 * can be deactivated by the user but not renamed or deleted.
 */
async function seedAccounting() {
  const accounts: [string, string, string, string | null][] = [
    // code, name, type, parent code
    ['100', '유동자산', 'ASSET', null],
    ['101', '현금', 'ASSET', '100'],
    ['102', '보통예금', 'ASSET', '100'],
    ['110', '외상매출금', 'ASSET', '100'],
    ['120', '부가세대급금', 'ASSET', '100'],
    ['150', '재고자산', 'ASSET', '100'],
    ['200', '유동부채', 'LIABILITY', null],
    ['210', '외상매입금', 'LIABILITY', '200'],
    ['220', '부가세예수금', 'LIABILITY', '200'],
    ['300', '자본', 'EQUITY', null],
    ['310', '자본금', 'EQUITY', '300'],
    ['330', '이익잉여금', 'EQUITY', '300'],
    ['400', '매출', 'REVENUE', null],
    ['401', '상품매출', 'REVENUE', '400'],
    ['402', '매출에누리', 'REVENUE', '400'],
    ['500', '매출원가', 'EXPENSE', null],
    ['501', '상품매출원가', 'EXPENSE', '500'],
    ['600', '판매비와관리비', 'EXPENSE', null],
    ['601', '급여', 'EXPENSE', '600'],
    ['602', '복리후생비', 'EXPENSE', '600'],
    ['603', '지급수수료', 'EXPENSE', '600'],
    ['604', '운반비', 'EXPENSE', '600'],
    ['605', '소모품비', 'EXPENSE', '600'],
  ];

  const idByCode = new Map<string, string>();
  const hasChildren = new Set(accounts.map(([, , , parent]) => parent).filter(Boolean) as string[]);

  for (const [code, name, accountType, parentCode] of accounts) {
    const parentId = parentCode ? (idByCode.get(parentCode) ?? null) : null;
    const normalSide = accountType === 'ASSET' || accountType === 'EXPENSE' ? 'DEBIT' : 'CREDIT';
    const row = await prisma.account.upsert({
      where: { code },
      create: {
        code,
        name,
        accountType,
        normalSide,
        parentId,
        level: parentCode ? 2 : 1,
        // only a leaf may be posted to
        isPostable: !hasChildren.has(code),
        isStandard: true,
      },
      update: { accountType, normalSide, parentId, isPostable: !hasChildren.has(code), isStandard: true },
    });
    idByCode.set(code, row.id);
  }

  const mappings: [string, string, string][] = [
    ['SALES', '매출', '401'],
    ['SALES_DISCOUNT', '매출에누리', '402'],
    ['ACCOUNTS_RECEIVABLE', '외상매출금', '110'],
    ['VAT_PAYABLE', '부가세예수금', '220'],
    ['PURCHASE', '매입', '150'],
    ['ACCOUNTS_PAYABLE', '외상매입금', '210'],
    ['VAT_RECEIVABLE', '부가세대급금', '120'],
    ['INVENTORY', '재고자산', '150'],
    ['COGS', '매출원가', '501'],
    ['CASH', '현금', '101'],
    ['BANK', '보통예금', '102'],
    ['RETAINED_EARNINGS', '이익잉여금', '330'],
  ];
  for (const [slot, label, code] of mappings) {
    const accountId = idByCode.get(code)!;
    await prisma.accountMapping.upsert({
      where: { slot },
      create: { slot, label, accountId },
      update: { label, accountId },
    });
  }

  const from = toDateOnly('2020-01-01');
  for (const [code, template] of Object.entries(DEFAULT_TEMPLATES)) {
    const rule = await prisma.postingRule.upsert({
      where: { code },
      create: { code, label: RULE_LABEL[code as keyof typeof RULE_LABEL] ?? code },
      update: {},
    });
    const existing = await prisma.postingRuleVersion.findFirst({ where: { ruleId: rule.id, version: 1 } });
    if (!existing) {
      await prisma.postingRuleVersion.create({
        data: { ruleId: rule.id, version: 1, effectiveFrom: from, template: template as never },
      });
    }
  }
}

async function main() {
  await seedPermissionsAndRoles();
  await seedOrganization();
  await seedNumberingRules();
  await seedPolicies();
  await seedSystemSettings();
  await seedCommonCodes();
  await seedItemCategories();
  await seedAccounting();
  await seedApproval();
  await seedAdminUser();
  console.log(`seed complete (admin user: ${ADMIN_USERNAME})`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
