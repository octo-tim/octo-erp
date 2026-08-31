#!/usr/bin/env node
/**
 * GENERATED-FILE GENERATOR — do not hand-edit docs/data-model.md.
 *
 * Generates docs/data-model.md from prisma/schema.prisma:
 *  - one Mermaid erDiagram per domain (master, sales, inventory, accounting, hr, approval, system)
 *  - a column table per model (Prisma type, nullability, default, unique/index membership,
 *    and the schema's own /** *\/ and // comments carried through as the column description)
 *  - the model's relations (object-typed fields), separate from its scalar columns
 *  - a personal/sensitive-data flag, derived only from this file's own DOMAIN_MAP-adjacent
 *    SENSITIVE_FIELDS table below (sourced from schema comments and
 *    src/server/modules/migration/templates.ts — never invented)
 *
 * STEP 13. Usage: node tools/docs-schema.mjs [--check]
 */
import fs from 'node:fs';
import path from 'node:path';
import prettier from 'prettier';

const root = path.resolve(new URL('.', import.meta.url).pathname, '..');
const schemaPath = path.join(root, 'prisma/schema.prisma');
const outPath = path.join(root, 'docs/data-model.md');
const checkOnly = process.argv.includes('--check');

const src = fs.readFileSync(schemaPath, 'utf8');
const lines = src.split('\n');

// ───────────────────────── tiny prisma-schema parser ─────────────────────────

/** Splits an attribute string like `@id @default(cuid()) @db.Decimal(18, 4)` into
 *  [{name:'@id', args:null}, {name:'@default', args:'cuid()'}, {name:'@db.Decimal', args:'18, 4'}],
 *  respecting nested parens so `@default(now())` is not truncated at the inner `)`. */
function splitAttrs(rest) {
  const attrs = [];
  let i = 0;
  while (i < rest.length) {
    if (rest[i] === '@') {
      let j = i;
      while (rest[j] === '@') j++; // model-level attrs start with `@@`
      while (j < rest.length && /[A-Za-z0-9_.]/.test(rest[j])) j++;
      const name = rest.slice(i, j);
      let k = j;
      while (rest[k] === ' ') k++;
      let args = null;
      if (rest[k] === '(') {
        let depth = 0;
        let m = k;
        do {
          if (rest[m] === '(') depth++;
          else if (rest[m] === ')') depth--;
          m++;
        } while (depth > 0 && m < rest.length);
        args = rest.slice(k + 1, m - 1);
        j = m;
      } else {
        j = k;
      }
      attrs.push({ name, args });
      i = j;
    } else {
      i++;
    }
  }
  return attrs;
}

/** Strips comment markers (`/**`, `*`, `*​/`, `//`) off a block of raw comment lines. */
function cleanComment(rawLines) {
  return rawLines
    .map((l) =>
      l
        .trim()
        .replace(/^\/\*\*\s?/, '')
        .replace(/^\*\s?\/\s*$/, '')
        .replace(/\*\/\s*$/, '')
        .replace(/^\*\s?/, '')
        .replace(/^\/\/\/?\s?/, ''),
    )
    .filter((l, idx, arr) => !(l === '' && (idx === 0 || idx === arr.length - 1)))
    .join('\n')
    .trim();
}

/** Finds the end of a `//`-comment-free code segment on a line (a `//` inside a quoted
 *  string, e.g. a default value, is not treated as the start of a trailing comment). */
function splitTrailingComment(line) {
  let inQuote = null;
  for (let i = 0; i < line.length - 1; i++) {
    const c = line[i];
    if (inQuote) {
      if (c === inQuote && line[i - 1] !== '\\') inQuote = null;
      continue;
    }
    if (c === '"' || c === "'") inQuote = c;
    else if (c === '/' && line[i + 1] === '/')
      return { code: line.slice(0, i), comment: line.slice(i + 2).trim() };
  }
  return { code: line, comment: '' };
}

const models = []; // { name, doc, fields: [...], modelAttrs: [...], startLine }
let pendingDoc = [];
let inBlockComment = false;
let current = null; // active model being parsed
let braceDepth = 0;

for (let ln = 0; ln < lines.length; ln++) {
  const raw = lines[ln];
  const trimmed = raw.trim();

  if (inBlockComment) {
    pendingDoc.push(raw);
    if (trimmed.includes('*/')) inBlockComment = false;
    continue;
  }

  if (!current) {
    if (trimmed === '') {
      pendingDoc = [];
      continue;
    }
    if (trimmed.startsWith('/**')) {
      pendingDoc = [raw];
      if (!trimmed.includes('*/')) inBlockComment = true;
      continue;
    }
    if (trimmed.startsWith('///')) {
      pendingDoc.push(raw);
      continue;
    }
    if (trimmed.startsWith('//')) {
      // a section-header or standalone comment; not a doc comment for a field, reset
      pendingDoc = [];
      continue;
    }
    const m = trimmed.match(/^model\s+(\w+)\s*\{/);
    if (m) {
      current = { name: m[1], doc: cleanComment(pendingDoc), fields: [], modelAttrs: [], startLine: ln + 1 };
      pendingDoc = [];
      braceDepth = 1;
    }
    continue;
  }

  // inside a model body
  if (trimmed === '') {
    pendingDoc = [];
    continue;
  }
  if (trimmed === '}') {
    braceDepth--;
    if (braceDepth === 0) {
      models.push(current);
      current = null;
    }
    continue;
  }
  if (trimmed.startsWith('/**')) {
    pendingDoc = [raw];
    if (!trimmed.includes('*/')) inBlockComment = true;
    continue;
  }
  if (trimmed.startsWith('///')) {
    pendingDoc.push(raw);
    continue;
  }
  if (trimmed.startsWith('@@')) {
    const { code, comment } = splitTrailingComment(trimmed);
    const attrs = splitAttrs(code);
    for (const a of attrs) current.modelAttrs.push({ ...a, comment, doc: cleanComment(pendingDoc) });
    pendingDoc = [];
    continue;
  }
  if (trimmed.startsWith('//')) {
    pendingDoc.push(raw);
    continue;
  }

  // a field line: `name Type... attrs... // trailing comment`
  const { code, comment } = splitTrailingComment(raw);
  const fm = code.trim().match(/^(\w+)\s+(\S+)\s*(.*)$/);
  if (!fm) continue; // defensive: skip anything we don't recognize rather than guess
  const [, fname, rawType, rest] = fm;
  const isList = rawType.endsWith('[]');
  const isOptional = rawType.endsWith('?');
  const baseType = rawType.replace(/[?[\]]/g, '');
  const attrs = splitAttrs(rest);
  current.fields.push({
    name: fname,
    rawType,
    baseType,
    isList,
    isOptional,
    attrs,
    doc: cleanComment(pendingDoc),
    trailingComment: comment,
  });
  pendingDoc = [];
}

if (current) throw new Error(`unterminated model block starting at line ${current.startLine}`);

const modelNames = new Set(models.map((m) => m.name));

// ───────────────────────── domain grouping ─────────────────────────
// Curated from the schema's own section banners (`// ───── ... STEP n ─────`), split further
// where a banner mixes concerns the task's fixed 7 domains don't (e.g. the "Organization /
// Identity" banner holds both HR data and login/RBAC plumbing).
const DOMAIN_MODELS = {
  master: [
    'Department',
    'Division',
    'Warehouse',
    'ItemCategory',
    'Item',
    'Partner',
    'PartnerContact',
    'CommonCode',
    'ImportBatch',
  ],
  sales: [
    'DocumentConversion',
    'Quotation',
    'QuotationLine',
    'SalesOrder',
    'SalesOrderLine',
    'SalesDocument',
    'SalesDocumentLine',
    'PurchaseRequest',
    'PurchaseRequestLine',
    'PurchaseOrder',
    'PurchaseOrderLine',
    'PurchaseDocument',
    'PurchaseDocumentLine',
    'Receivable',
    'Payable',
    'Settlement',
    'SettlementMatch',
    'TaxDocumentOutput',
  ],
  inventory: [
    'StockDocument',
    'StockDocumentLine',
    'InventoryLedger',
    'StockSnapshot',
    'StockCount',
    'StockCountLine',
    'InventoryValuationPeriod',
    'InventoryPeriodCost',
  ],
  accounting: [
    'Account',
    'AccountMapping',
    'AccountingPeriod',
    'JournalEntry',
    'JournalLine',
    'PostingRule',
    'PostingRuleVersion',
    'OpeningBalance',
    'ClosingRun',
  ],
  hr: [
    'Employee',
    'EmployeeSensitive',
    'SensitiveAccessLog',
    'DepartmentHistory',
    'Assignment',
    'Attendance',
    'AttendanceCorrectionRequest',
    'LeaveGrant',
    'LeaveUsage',
    'LeaveRequest',
    'EmployeeDocument',
    'CertificateIssue',
    'EmployeeChangeRequest',
    'RetentionRun',
  ],
  approval: [
    'ApprovalForm',
    'ApprovalFormVersion',
    'ApprovalLineTemplate',
    'ApprovalLineTemplateStep',
    'ApprovalRule',
    'Delegation',
    'ApprovalDocument',
    'ApprovalStep',
    'ApprovalParticipant',
    'ApprovalActionLog',
    'ApprovalLink',
  ],
  system: [
    'User',
    'Role',
    'Permission',
    'RolePermission',
    'UserRole',
    'UserDivisionScope',
    'UserWarehouseScope',
    'Session',
    'LoginAttempt',
    'SecurityEvent',
    'AuditLog',
    'IdempotencyRecord',
    'OutboxEvent',
    'Notification',
    'NotificationDelivery',
    'Attachment',
    'SystemSetting',
    'PolicyVersion',
    'UserPreference',
    'NumberingRule',
    'NumberingCounter',
    'MigrationBatch',
    'MigrationRow',
  ],
};
const DOMAIN_LABEL = {
  master: '마스터데이터 (Master)',
  sales: '영업/구매 (Sales)',
  inventory: '재고 (Inventory)',
  accounting: '회계 (Accounting)',
  hr: '인사 (HR)',
  approval: '전자결재 (Approval)',
  system: '시스템/보안 (System)',
};

const domainErrors = [];
const modelToDomain = new Map();
for (const [domain, names] of Object.entries(DOMAIN_MODELS)) {
  for (const n of names) {
    if (!modelNames.has(n)) domainErrors.push(`DOMAIN_MODELS.${domain} references unknown model ${n}`);
    if (modelToDomain.has(n)) domainErrors.push(`model ${n} is listed in two domains`);
    modelToDomain.set(n, domain);
  }
}
for (const m of models) {
  if (!modelToDomain.has(m.name))
    domainErrors.push(
      `model ${m.name} is not assigned to a domain — add it to DOMAIN_MODELS in tools/docs-schema.mjs`,
    );
}
if (domainErrors.length) {
  console.error(
    'docs-schema: domain map is out of sync with prisma/schema.prisma:\n' + domainErrors.join('\n'),
  );
  process.exit(1);
}

// ───────────────────────── sensitive-field table ─────────────────────────
// Sourced from src/server/modules/migration/templates.ts (columns marked `sensitive: true`
// for the EMPLOYEE migration target) and from the schema's own NFR-SEC-06 comment on
// EmployeeSensitive.residentNoMaskDigit. src/server/modules/migration/targets.ts's employee
// handler is what ties the template's logical keys to these physical columns: `phone` is
// written straight to Employee.phone, and `residentNo`/`bankAccount` both go through
// employee.setSensitive(), which is what fills EmployeeSensitive's residentNo*/bankName/
// bankAccount* columns. Nothing here is inferred beyond that trail — see docs-schema.mjs
// SENSITIVE_FIELDS for the one-line reason attached to each entry.
const SENSITIVE_FIELDS = {
  'Employee.phone':
    'templates.ts EMPLOYEE.phone → sensitive: true (targets.ts writes it straight to Employee.phone)',
  'EmployeeSensitive.residentNoEnc':
    'templates.ts EMPLOYEE.residentNo → sensitive: true; encrypted at rest (targets.ts → employee.setSensitive)',
  'EmployeeSensitive.residentNoMaskDigit':
    'schema comment NFR-SEC-06: the one digit of the resident-registration number any screen may show',
  'EmployeeSensitive.bankName':
    'templates.ts EMPLOYEE.bankAccount → sensitive: true; same bank-detail group as bankAccountEnc/Last4',
  'EmployeeSensitive.bankAccountEnc':
    'templates.ts EMPLOYEE.bankAccount → sensitive: true; encrypted at rest (targets.ts → employee.setSensitive)',
  'EmployeeSensitive.bankAccountLast4': 'templates.ts EMPLOYEE.bankAccount → sensitive: true',
};

// ───────────────────────── relation matching ─────────────────────────
// Every object-typed field is one end of a relation. Fields carrying `@relation(fields: ...)`
// own the foreign key (the "many"/child side); Prisma requires the matching field on the
// other model to be declared too, so it is always resolvable — either as `Other[]` (one-to-
// many) or a plain `Other`/`Other?` back-reference (one-to-one, paired with a `@unique` FK).
const relationFieldsByModel = new Map();
for (const m of models) {
  const relFields = m.fields.filter((f) => modelNames.has(f.baseType));
  relationFieldsByModel.set(m.name, relFields);
}

function relationAttr(field) {
  const rel = field.attrs.find((a) => a.name === '@relation');
  if (!rel || !rel.args) return { name: null, fkFields: null, references: null };
  const nameMatch = rel.args.match(/^"([^"]+)"/);
  const fieldsMatch = rel.args.match(/fields:\s*\[([^\]]*)\]/);
  const refMatch = rel.args.match(/references:\s*\[([^\]]*)\]/);
  return {
    name: nameMatch ? nameMatch[1] : null,
    fkFields: fieldsMatch ? fieldsMatch[1].split(',').map((s) => s.trim()) : null,
    references: refMatch ? refMatch[1].split(',').map((s) => s.trim()) : null,
  };
}

// group all relation-field ends by explicit @relation name, else by unordered model pair
const relationGroups = new Map();
for (const m of models) {
  for (const f of relationFieldsByModel.get(m.name)) {
    const info = relationAttr(f);
    const pairKey = [m.name, f.baseType].sort().join('~');
    const key = info.name ?? pairKey;
    if (!relationGroups.has(key)) relationGroups.set(key, []);
    relationGroups.get(key).push({ model: m.name, field: f, info });
  }
}

const edges = []; // { from, to, ownerField, childIsList, label }
const unresolvedRelationEnds = [];
// per-field cardinality, from that field's own model's point of view: '1:1' | 'N:1' | '1:N'
const fieldCardinality = new Map();
for (const [key, ends] of relationGroups) {
  const owner = ends.find((e) => e.info.fkFields);
  if (!owner) {
    for (const e of ends) unresolvedRelationEnds.push(`${e.model}.${e.field.name} (group ${key})`);
    continue;
  }
  const backRef = ends.find((e) => e !== owner && e.model === owner.field.baseType);
  const childIsList = backRef ? backRef.field.isList : true; // default to one-to-many if no back-ref found
  edges.push({
    from: owner.field.baseType, // the "one" side (referenced model)
    to: owner.model, // the "many"/child side (owns the FK)
    ownerField: owner.field.name,
    childIsList,
    label: backRef ? backRef.field.name : owner.field.name,
  });
  fieldCardinality.set(`${owner.model}.${owner.field.name}`, childIsList ? 'N:1' : '1:1');
  if (backRef) fieldCardinality.set(`${backRef.model}.${backRef.field.name}`, childIsList ? '1:N' : '1:1');
}

// ───────────────────────── column / constraint rendering ─────────────────────────

function fieldConstraints(model, field) {
  const parts = [];
  if (field.attrs.some((a) => a.name === '@id')) parts.push('PK');
  if (field.attrs.some((a) => a.name === '@unique')) parts.push('UNIQUE');
  if (field.attrs.some((a) => a.name === '@updatedAt')) parts.push('auto: updatedAt');
  for (const ma of model.modelAttrs) {
    if (!ma.args) continue;
    // @@id/@@unique/@@index all take a `[colA, colB]` column list
    const colNames = ma.args.match(/\[([^\]]*)\]/);
    if (!colNames) continue;
    const names = colNames[1].split(',').map((s) => s.trim());
    if (!names.includes(field.name)) continue;
    if (ma.name === '@@id') parts.push(`PK(${names.join('+')})`);
    if (ma.name === '@@unique') parts.push(`UNIQUE(${names.join('+')})`);
    if (ma.name === '@@index') parts.push(`INDEX(${names.join('+')})`);
  }
  return [...new Set(parts)].join(', ') || '—';
}

function fieldDefault(field) {
  const def = field.attrs.find((a) => a.name === '@default');
  return def ? `\`${def.args}\`` : '—';
}

function fieldTypeLabel(field) {
  const db = field.attrs.find((a) => a.name.startsWith('@db.'));
  let label = field.baseType;
  if (db) {
    const dbType = db.name.slice(4);
    label = db.args ? `${dbType}(${db.args})` : dbType;
  }
  if (field.isList) label += '[]';
  return label;
}

function fieldDescription(field) {
  const bits = [];
  if (field.doc) bits.push(field.doc.replace(/\n+/g, ' '));
  if (field.trailingComment) bits.push(field.trailingComment);
  return bits.join(' — ') || '—';
}

// ───────────────────────── markdown rendering ─────────────────────────

let md = `# 데이터 모델 (Data Model)\n\n`;
md += `> 생성: \`node tools/docs-schema.mjs\` — 원본은 \`prisma/schema.prisma\`. 이 파일을 직접 편집하지 않는다.\n`;
md += `> 민감정보 표시는 \`src/server/modules/migration/templates.ts\`의 \`sensitive: true\` 컬럼과 스키마 자체 주석(NFR-SEC-06)에서만 가져온다 — 추정하지 않는다.\n\n`;
md += `모델 수: ${models.length} · 생성 시각: ${new Date().toISOString()}\n\n`;

md += `## 도메인\n\n`;
md += `| 도메인 | 모델 수 | 모델 |\n|---|---|---|\n`;
for (const [domain, names] of Object.entries(DOMAIN_MODELS)) {
  md += `| ${DOMAIN_LABEL[domain]} | ${names.length} | ${names.map((n) => `\`${n}\``).join(', ')} |\n`;
}
md += `\n`;

md += `## 도메인별 ERD\n\n`;
md += `전체 ${models.length}개 모델을 한 다이어그램에 그리면 읽을 수 없어, 요구사항대로 도메인별로 나눈다. `;
md += `도메인 간 관계는 다이어그램에 넣지 않고 각 모델의 "관계" 목록에서 대상 모델명으로 알아볼 수 있게 남긴다.\n\n`;

for (const [domain, names] of Object.entries(DOMAIN_MODELS)) {
  const nameSet = new Set(names);
  md += `### ${DOMAIN_LABEL[domain]}\n\n`;
  md += '```mermaid\nerDiagram\n';
  for (const n of names) md += `    ${n}\n`;
  for (const e of edges) {
    if (!nameSet.has(e.from) || !nameSet.has(e.to)) continue;
    const rel = e.childIsList ? '||--o{' : '||--o|';
    md += `    ${e.from} ${rel} ${e.to} : "${e.label}"\n`;
  }
  md += '```\n\n';
}

md += `## 모델별 테이블 정의\n\n`;
for (const [domain, names] of Object.entries(DOMAIN_MODELS)) {
  md += `### ${DOMAIN_LABEL[domain]}\n\n`;
  for (const modelName of names) {
    const model = models.find((m) => m.name === modelName);
    md += `#### ${model.name}\n\n`;
    if (model.doc) md += `${model.doc}\n\n`;

    const scalarFields = model.fields.filter((f) => !modelNames.has(f.baseType));
    md += `| 컬럼 | 타입 | Null허용 | 기본값 | 제약/인덱스 | 민감정보 | 설명 |\n|---|---|---|---|---|---|---|\n`;
    for (const f of scalarFields) {
      const sensitiveKey = `${model.name}.${f.name}`;
      const sensitive = SENSITIVE_FIELDS[sensitiveKey] ? `⚠ ${SENSITIVE_FIELDS[sensitiveKey]}` : '—';
      md += `| \`${f.name}\` | ${fieldTypeLabel(f)} | ${f.isOptional ? 'Y' : 'N'} | ${fieldDefault(f)} | ${fieldConstraints(model, f)} | ${sensitive} | ${fieldDescription(f).replace(/\|/g, '\\|')} |\n`;
    }
    md += `\n`;

    const relFields = relationFieldsByModel.get(model.name);
    if (relFields.length) {
      md += `관계:\n\n`;
      for (const f of relFields) {
        const info = relationAttr(f);
        const owns = info.fkFields
          ? ` (FK: \`${info.fkFields.join(', ')}\` → \`${f.baseType}.${(info.references ?? ['id']).join(', ')}\`)`
          : ' (역참조, FK 없음)';
        const card = fieldCardinality.get(`${model.name}.${f.name}`) ?? (f.isList ? '1:N' : 'N:1');
        md += `- \`${f.name}\` → **${f.baseType}** [${card}]${owns}${f.doc ? ` — ${f.doc.replace(/\n+/g, ' ')}` : ''}\n`;
      }
      md += `\n`;
    }
  }
}

if (unresolvedRelationEnds.length) {
  md += `## 정적 분석 한계\n\n`;
  md += `다음 관계 필드는 짝이 되는 반대편 필드를 찾지 못해 카디널리티를 확정할 수 없었다 — 원본 스키마를 확인할 것:\n\n`;
  for (const u of unresolvedRelationEnds) md += `- ${u}\n`;
  md += `\n`;
}

// Prettier is run on the generated markdown itself (not just excluded via .prettierignore)
// so the checked-in file is already the shape `npx prettier --write` would leave it in.
const prettierConfig = (await prettier.resolveConfig(outPath)) ?? {};
md = await prettier.format(md, { ...prettierConfig, parser: 'markdown', filepath: outPath });

fs.mkdirSync(path.dirname(outPath), { recursive: true });

if (checkOnly) {
  const current = fs.existsSync(outPath) ? fs.readFileSync(outPath, 'utf8') : null;
  // the generation timestamp always differs; compare everything else
  const strip = (s) => (s ?? '').replace(/생성 시각: [^\n]+/, '생성 시각: <ts>');
  if (strip(current) !== strip(md)) {
    console.error(`docs/data-model.md is stale — run \`node tools/docs-schema.mjs\` and commit the result.`);
    process.exit(1);
  }
  console.log('docs/data-model.md is up to date');
  process.exit(0);
}

fs.writeFileSync(outPath, md);
console.log(`wrote ${path.relative(root, outPath)} (${models.length} models)`);
