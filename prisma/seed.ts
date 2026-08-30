import 'dotenv/config';
import { prisma } from '../src/server/db';
import { hashPassword } from '../src/server/core/crypto';
import { moduleOf, PERMISSIONS, ROLE_PRESETS } from '../src/server/modules/rbac/permissions';
import { DOC_TYPES } from '../src/server/modules/numbering/service';
import { toDateOnly } from '../src/lib/dates';
import { DEFAULT_FORMS } from '../src/server/modules/approval/form';

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

async function main() {
  await seedPermissionsAndRoles();
  await seedOrganization();
  await seedNumberingRules();
  await seedPolicies();
  await seedSystemSettings();
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
