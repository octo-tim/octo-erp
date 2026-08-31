#!/usr/bin/env node
/**
 * GENERATED-FILE GENERATOR — do not hand-edit docs/permissions.md.
 *
 * Generates docs/permissions.md (NFR-SEC-01, INT-12, NFR-SEC-02) from three sources, all read
 * statically (no ts-node/tsx execution, no DB, no network):
 *
 *  - src/server/modules/rbac/permissions.ts — the `PERMISSIONS` catalogue (code + Korean
 *    label) and the `ROLE_PRESETS` role → permission-list map, parsed as TypeScript AST
 *    literals (not imported/executed, matching tools/docs-api.mjs and tools/docs-schema.mjs).
 *  - src/server/api/routers/*.ts — every tRPC procedure's required permission, via
 *    tools/lib/router-permissions.mjs (the exact same parser tests/integration/permissions.test.ts
 *    imports for its exhaustive call test, so the doc and the test cannot silently disagree
 *    about which procedure needs which permission).
 *
 * The three data-scope sections (division/warehouse/HR) are prose, not parsed — they cite the
 * scope functions in src/server/modules/rbac/service.ts by name so a reader can jump to the
 * actual enforcement code.
 *
 * STEP 13. Usage: node tools/docs-permissions.mjs [--check]
 */
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import prettier from 'prettier';
import { collectRouterPermissions } from './lib/router-permissions.mjs';

const root = path.resolve(new URL('.', import.meta.url).pathname, '..');
const permissionsPath = path.join(root, 'src/server/modules/rbac/permissions.ts');
const outPath = path.join(root, 'docs/permissions.md');
const checkOnly = process.argv.includes('--check');

// ───────────────────────── permissions.ts (PERMISSIONS + ROLE_PRESETS) ─────────────────────────

function unwrap(expr) {
  let n = expr;
  while (ts.isAsExpression(n) || ts.isSatisfiesExpression(n) || ts.isParenthesizedExpression(n)) {
    n = n.expression;
  }
  return n;
}

function parsePermissionsSource(absPath) {
  const text = fs.readFileSync(absPath, 'utf8');
  const sf = ts.createSourceFile(absPath, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

  /** @type {Array<{code:string,label:string}>} */
  const catalogue = [];
  /** @type {Record<string,{name:string,permissions:string[]|'*'}>} */
  const rolePresets = {};
  const errors = [];

  for (const stmt of sf.statements) {
    if (!ts.isVariableStatement(stmt)) continue;
    for (const decl of stmt.declarationList.declarations) {
      if (!ts.isIdentifier(decl.name) || !decl.initializer) continue;

      if (decl.name.text === 'PERMISSIONS') {
        const init = unwrap(decl.initializer);
        if (!ts.isArrayLiteralExpression(init)) {
          errors.push('PERMISSIONS is not an array literal — cannot parse statically');
          continue;
        }
        for (const el of init.elements) {
          const tuple = unwrap(el);
          if (
            ts.isArrayLiteralExpression(tuple) &&
            tuple.elements.length === 2 &&
            ts.isStringLiteralLike(tuple.elements[0]) &&
            ts.isStringLiteralLike(tuple.elements[1])
          ) {
            catalogue.push({ code: tuple.elements[0].text, label: tuple.elements[1].text });
          } else {
            errors.push(`PERMISSIONS entry not a [code, label] literal tuple: ${tuple.getText(sf)}`);
          }
        }
      }

      if (decl.name.text === 'ROLE_PRESETS') {
        const init = unwrap(decl.initializer);
        if (!ts.isObjectLiteralExpression(init)) {
          errors.push('ROLE_PRESETS is not an object literal — cannot parse statically');
          continue;
        }
        for (const prop of init.properties) {
          if (!ts.isPropertyAssignment(prop)) continue;
          const roleCode = prop.name.getText(sf).replace(/^['"]|['"]$/g, '');
          const val = unwrap(prop.initializer);
          if (!ts.isObjectLiteralExpression(val)) {
            errors.push(`ROLE_PRESETS.${roleCode} is not an object literal`);
            continue;
          }
          let name = null;
          let permissions = null;
          for (const p of val.properties) {
            if (!ts.isPropertyAssignment(p)) continue;
            const key = p.name.getText(sf);
            if (key === 'name' && ts.isStringLiteralLike(p.initializer)) name = p.initializer.text;
            if (key === 'permissions') {
              const permInit = unwrap(p.initializer);
              if (ts.isStringLiteralLike(permInit) && permInit.text === '*') permissions = '*';
              else if (ts.isArrayLiteralExpression(permInit)) {
                permissions = permInit.elements.filter(ts.isStringLiteralLike).map((e) => e.text);
                if (permissions.length !== permInit.elements.length) {
                  errors.push(`ROLE_PRESETS.${roleCode}.permissions has a non-literal entry`);
                }
              } else {
                errors.push(`ROLE_PRESETS.${roleCode}.permissions is not '*' or a string array literal`);
              }
            }
          }
          if (name === null || permissions === null) {
            errors.push(`ROLE_PRESETS.${roleCode} is missing name/permissions`);
            continue;
          }
          rolePresets[roleCode] = { name, permissions };
        }
      }
    }
  }

  if (catalogue.length === 0) errors.push('PERMISSIONS catalogue parsed empty — check the source shape');
  if (Object.keys(rolePresets).length === 0)
    errors.push('ROLE_PRESETS parsed empty — check the source shape');

  return { catalogue, rolePresets, errors };
}

const { catalogue, rolePresets, errors: sourceErrors } = parsePermissionsSource(permissionsPath);
if (sourceErrors.length) {
  console.error('docs-permissions: failed to parse permissions.ts statically:\n' + sourceErrors.join('\n'));
  process.exit(1);
}

const moduleOf = (code) => code.split('.')[0] ?? 'system';
const roleCodes = Object.keys(rolePresets); // insertion order === source order
const hasPerm = (roleCode, code) => {
  const p = rolePresets[roleCode].permissions;
  return p === '*' || p.includes(code);
};

// ───────────────────────── router permission map (shared with the integration test) ─────────────────────────

const { routers, parseFailures, totalProcedures } = collectRouterPermissions({ root });
const unresolvedProcedures = routers.flatMap((r) =>
  r.procedures.filter((p) => p.kind === 'unresolved').map((p) => `${p.path} → ${p.raw ?? '?'}`),
);
// every literal permission a router actually asks for, whether or not it is in the catalogue
const catalogueCodes = new Set(catalogue.map((c) => c.code));
const permissionsUsedByRouters = new Set(
  routers.flatMap((r) => r.procedures.filter((p) => p.kind === 'permission').map((p) => p.permission)),
);
const unknownPermissionsInRouters = [...permissionsUsedByRouters].filter((p) => !catalogueCodes.has(p));

// ───────────────────────── markdown assembly ─────────────────────────

let md = `# 권한 매트릭스 (Permission Matrix)\n\n`;
md += `> 생성: \`node tools/docs-permissions.mjs\` — 원본은 \`src/server/modules/rbac/permissions.ts\`(권한 카탈로그·역할 프리셋, 정적 AST 분석)와 \`src/server/api/routers/*.ts\`(프로시저별 필요 권한, \`tools/lib/router-permissions.mjs\`를 \`tests/integration/permissions.test.ts\`의 전수 호출시험과 공유). 이 파일을 직접 편집하지 않는다.\n\n`;
md += `생성 시각: ${new Date().toISOString()} · 권한 ${catalogue.length}개 · 역할 ${roleCodes.length}개 · 라우터 ${routers.length}개 · 프로시저 ${totalProcedures}개\n\n`;

md += `## 1. 권한 카탈로그\n\n`;
md += `\`Permission\` 문자열은 \`module.action\` 형식이다(docs/security-model.md §3). 아래는 \`PERMISSIONS\`(\`src/server/modules/rbac/permissions.ts\`)에 선언된 전체 목록이다.\n\n`;
md += `| 모듈 | 코드 | 설명 |\n|---|---|---|\n`;
for (const { code, label } of catalogue) md += `| ${moduleOf(code)} | \`${code}\` | ${label} |\n`;
md += `\n`;

md += `## 2. 역할 × 권한 매트릭스\n\n`;
md += `\`ROLE_PRESETS\`(\`src/server/modules/rbac/permissions.ts\`)에서 시드되는 역할별 권한이다. \`admin\`은 \`permissions: '*'\`로 선언되어 모든 권한과 전체 데이터 범위를 갖는다(표에서도 전 행 ✅로 나타난다).\n\n`;
md += `| 코드 | 설명 | ${roleCodes.map((r) => rolePresets[r].name).join(' | ')} |\n`;
md += `|---|---|${roleCodes.map(() => '---').join('|')}|\n`;
for (const { code, label } of catalogue) {
  const cells = roleCodes.map((r) => (hasPerm(r, code) ? '✅' : '—'));
  md += `| \`${code}\` | ${label} | ${cells.join(' | ')} |\n`;
}
md += `\n`;
md += `역할 코드: ${roleCodes.map((r) => `\`${r}\` (${rolePresets[r].name})`).join(', ')}.\n\n`;

md += `## 3. 데이터 범위 (Division / Warehouse / HR Scope)\n\n`;
md += `권한이 있어도 데이터 범위가 좁히는 것을 막지 못하면 다른 사업부·창고·직원의 자료가 새어 나간다(INT-12, NFR-SEC-02). 세 범위 모두 **기본 거부**(scope가 비어 있으면 아무것도 보이지 않음)이며, 관리자(\`actor.isAdmin\`)만 전체를 본다. 세 범위 모두 \`src/server/modules/rbac/service.ts\`에 있다.\n\n`;
md += `### 3.1 사업부 범위 (Division Scope)\n\n`;
md += `- 단일 레코드 접근은 \`assertDivisionScope(actor, divisionId)\`가 검사한다. \`divisionId\`가 없는 행(회사 전체 공용)은 통과시키고, 있으면 \`actor.divisionIds\`에 포함되어야 하며 아니면 \`AppError('OUT_OF_SCOPE', ...)\`를 던진다.\n`;
md += `- 목록 조회는 \`divisionScopeFilter(actor)\`가 만드는 \`{ divisionId: { in: actor.divisionIds } }\` where절을 SQL에 결합해 범위 밖 행이 애초에 나오지 않게 한다(관리자는 \`{}\`, 즉 무제한).\n`;
md += `- 좁히는 대상: \`docs/data-model.md\`의 \`divisionId\` 컬럼을 가진 모든 업무전표(견적·주문·매출·매입·구매요청·발주·수금·지급·회계전표 등)와 보고서 필터(\`src/server/modules/report/filter.ts\`의 \`resolveFilter\`가 \`assertDivisionScope\`를 호출).\n\n`;
md += `### 3.2 창고 범위 (Warehouse Scope)\n\n`;
md += `- 단일 레코드 접근은 \`assertWarehouseScope(actor, warehouseId)\`, 목록은 \`warehouseScopeFilter(actor)\`가 같은 방식으로 적용한다.\n`;
md += `- 좁히는 대상: 입출고·이동전표(\`StockDocument\`, \`src/server/modules/inventory/stock-document.ts\`가 출발·도착 창고 둘 다 검사), 재고 조회·실사(\`StockCount\`, \`StockSnapshot\`), 보고서 필터의 \`warehouseId\`.\n\n`;
md += `### 3.3 인사 범위 (HR Scope)\n\n`;
md += `- \`assertHrScope(actor, employeeId)\`: \`hr.read\`를 가진 사용자(또는 관리자)는 전 직원을 보고, 그렇지 않으면 \`actor.employeeId\`와 같은 직원 레코드만 통과한다 — \`hr.self\`는 "본인만"의 하한선이다.\n`;
md += `- 목록 조회는 \`hrScopeFilter(actor)\`가 \`hr.read\`가 없으면 \`{ id: actor.employeeId ?? '__none__' }\`로 좁힌다(직원이 아닌 사용자는 아무 것도 보지 못한다).\n`;
md += `- 좁히는 대상: \`Employee\`, \`EmployeeSensitive\`, 근태(\`Attendance\`), 휴가(\`LeaveRequest\`, \`LeaveGrant\`), 인사발령(\`Assignment\`, \`DepartmentHistory\`), 증명서 발급 이력 — \`src/server/modules/hrm/employee.ts\`의 \`detail\`·\`certificateHistory\`·\`assignmentHistory\` 등이 \`assertHrScope\`를 직접 호출한다.\n\n`;

md += `## 4. 프로시저별 필요 권한\n\n`;
md += `\`src/server/api/routers/*.ts\`를 정적으로 파싱해, 각 tRPC 프로시저 빌더 체인의 밑바탕이 \`permissionProcedure('code')\`·\`authedProcedure\`(인증만, 업무 권한 없음)·\`publicProcedure\`(인증 불필요) 중 무엇인지 판정한 결과다. \`tests/integration/permissions.test.ts\`가 같은 판정을 그대로 재사용해 권한 없는 사용자가 실제로 거부되는지 전수 호출한다.\n\n`;
for (const r of routers) {
  md += `### ${r.mountKey} (\`${r.fileRel}\`)\n\n`;
  md += `| 프로시저 | 종류 | 필요 권한 |\n|---|---|---|\n`;
  for (const p of r.procedures) {
    const need =
      p.kind === 'permission'
        ? `\`${p.permission}\``
        : p.kind === 'authed'
          ? '(인증 필요 — 별도 업무 권한 없음)'
          : p.kind === 'public'
            ? '(공개 — 인증 불필요)'
            : `⚠ 확인 필요 (${p.raw ?? '?'})`;
    md += `| \`${r.mountKey}.${p.name}\` | ${p.opType ?? '?'} | ${need} |\n`;
  }
  md += `\n`;
}

if (parseFailures.length) {
  md += `## 파싱 실패\n\n다음 파일에서 \`router({...})\` 호출을 찾지 못했다 — 라우터 파일 구조가 바뀌었는지 확인할 것:\n\n`;
  for (const f of parseFailures) md += `- \`${f}\`\n`;
  md += `\n`;
}

md += `## 정적 분석 한계\n\n`;
const limits = [];
if (unresolvedProcedures.length) {
  limits.push(
    `다음 프로시저는 권한 판정을 정적으로 확정하지 못했다(동적 표현식 등) — 원본을 확인할 것:\n\n${unresolvedProcedures
      .map((u) => `- ${u}`)
      .join('\n')}`,
  );
}
if (unknownPermissionsInRouters.length) {
  limits.push(
    `다음 권한 코드는 라우터가 요구하지만 \`PERMISSIONS\` 카탈로그에 없다 — 오타이거나 카탈로그 갱신 누락일 수 있다:\n\n${unknownPermissionsInRouters
      .map((c) => `- \`${c}\``)
      .join('\n')}`,
  );
}
md += limits.length
  ? limits.join('\n\n') + '\n'
  : `모든 프로시저의 권한을 정적으로 해석했고, 라우터가 요구하는 모든 권한 코드가 카탈로그에 존재한다.\n`;
md += `\n`;

// Prettier is run on the generated markdown itself (not just excluded via .prettierignore)
// so the checked-in file is already the shape `npx prettier --write` would leave it in.
const prettierConfig = (await prettier.resolveConfig(outPath)) ?? {};
md = await prettier.format(md, { ...prettierConfig, parser: 'markdown', filepath: outPath });

fs.mkdirSync(path.dirname(outPath), { recursive: true });

if (checkOnly) {
  const current = fs.existsSync(outPath) ? fs.readFileSync(outPath, 'utf8') : null;
  const strip = (s) => (s ?? '').replace(/생성 시각: [^·]+·/, '생성 시각: <ts> ·');
  if (strip(current) !== strip(md)) {
    console.error(
      `docs/permissions.md is stale — run \`node tools/docs-permissions.mjs\` and commit the result.`,
    );
    process.exit(1);
  }
  console.log('docs/permissions.md is up to date');
  process.exit(0);
}

fs.writeFileSync(outPath, md);
console.log(
  `wrote ${path.relative(root, outPath)} (${catalogue.length} permissions, ${roleCodes.length} roles, ${routers.length} routers, ${totalProcedures} procedures)`,
);
