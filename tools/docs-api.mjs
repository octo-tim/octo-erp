#!/usr/bin/env node
/**
 * GENERATED-FILE GENERATOR — do not hand-edit docs/api.md.
 *
 * Generates docs/api.md from src/server/api/routers/*.ts by statically parsing the
 * TypeScript AST (no ts-node/tsx execution, no DB, no network): for every tRPC procedure it
 * records its name, query/mutation kind, the permission it requires (permissionProcedure /
 * authedProcedure / publicProcedure), whether it is idempotent (a `tx(ctx, fn, requestId)`
 * 3-arg call — traced through the actual argument passed, not guessed from a field's name,
 * since some procedures (e.g. hrm.reviewChange, sales.convertRequestToOrder) use `requestId`
 * as an ordinary business field and carry the real idempotency token under a different name),
 * and its zod input shape resolved across files (identifiers, `.extend()`, `.partial()`,
 * `.omit()`/`.pick()`, spreads). Where a shape cannot be resolved statically (a custom helper
 * function, a dynamic expression), that spot is flagged in the output rather than guessed.
 *
 * STEP 13. Usage: node tools/docs-api.mjs [--check]
 */
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import prettier from 'prettier';

const root = path.resolve(new URL('.', import.meta.url).pathname, '..');
const routersDir = path.join(root, 'src/server/api/routers');
const rootRouterPath = path.join(root, 'src/server/api/root.ts');
const errorsPath = path.join(root, 'src/server/core/errors.ts');
const outPath = path.join(root, 'docs/api.md');
const checkOnly = process.argv.includes('--check');

// ───────────────────────── source-file cache & resolution ─────────────────────────

/** @type {Map<string, {absPath:string, sourceFile:ts.SourceFile, locals:Map<string,ts.Expression>, imports:Map<string,{modulePath:string|null, exportedName:string}>}>} */
const sfCache = new Map();

function resolveModulePath(spec, fromFile) {
  let p;
  if (spec.startsWith('.')) p = path.join(path.dirname(fromFile), spec);
  else if (spec.startsWith('@/')) p = path.join(root, 'src', spec.slice(2));
  else return null; // external package (zod, @trpc/server, ...) — nothing to resolve
  const candidates = [p, `${p}.ts`, `${p}.tsx`, path.join(p, 'index.ts')];
  return candidates.find((c) => fs.existsSync(c) && fs.statSync(c).isFile()) ?? null;
}

function loadFile(absPath) {
  if (sfCache.has(absPath)) return sfCache.get(absPath);
  const text = fs.readFileSync(absPath, 'utf8');
  const sourceFile = ts.createSourceFile(absPath, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const locals = new Map();
  const imports = new Map();
  for (const stmt of sourceFile.statements) {
    if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (ts.isIdentifier(decl.name) && decl.initializer) locals.set(decl.name.text, decl.initializer);
      }
    } else if (
      ts.isImportDeclaration(stmt) &&
      stmt.importClause &&
      ts.isStringLiteral(stmt.moduleSpecifier)
    ) {
      const spec = stmt.moduleSpecifier.text;
      const resolved = resolveModulePath(spec, absPath);
      const nb = stmt.importClause.namedBindings;
      if (nb && ts.isNamedImports(nb)) {
        for (const el of nb.elements) {
          const localName = el.name.text;
          const exportedName = el.propertyName ? el.propertyName.text : el.name.text;
          imports.set(localName, { modulePath: resolved, exportedName });
        }
      }
    }
  }
  const ctx = { absPath, sourceFile, locals, imports };
  sfCache.set(absPath, ctx);
  return ctx;
}

function safeText(node, fileCtx, max = 160) {
  const t = node.getText(fileCtx.sourceFile).replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function propKeyName(nameNode) {
  if (ts.isIdentifier(nameNode)) return nameNode.text;
  if (ts.isStringLiteral(nameNode)) return nameNode.text;
  return nameNode.getText();
}

function resolveIdentifier(name, fileCtx) {
  if (fileCtx.locals.has(name)) return { node: fileCtx.locals.get(name), ctx: fileCtx };
  if (fileCtx.imports.has(name)) {
    const imp = fileCtx.imports.get(name);
    if (!imp.modulePath) return null;
    const targetCtx = loadFile(imp.modulePath);
    const init = targetCtx.locals.get(imp.exportedName);
    if (!init) return null;
    return { node: init, ctx: targetCtx };
  }
  return null;
}

function resolveToObjectLiteral(expr, fileCtx, guard) {
  if (ts.isObjectLiteralExpression(expr)) return { node: expr, ctx: fileCtx };
  if (ts.isIdentifier(expr)) {
    const key = `${fileCtx.absPath}#${expr.text}`;
    if (guard.has(key)) return null;
    const r = resolveIdentifier(expr.text, fileCtx);
    if (!r) return null;
    guard.add(key);
    const out = resolveToObjectLiteral(r.node, r.ctx, guard);
    guard.delete(key);
    return out;
  }
  return null;
}

function resolveArrayLiteral(node, fileCtx, guard) {
  let n = node;
  if (ts.isAsExpression(n)) n = n.expression;
  if (ts.isArrayLiteralExpression(n)) return n.elements.filter(ts.isStringLiteralLike).map((e) => e.text);
  if (ts.isIdentifier(n)) {
    const key = `${fileCtx.absPath}#${n.text}`;
    if (guard.has(key)) return null;
    const r = resolveIdentifier(n.text, fileCtx);
    if (!r) return null;
    guard.add(key);
    const out = resolveArrayLiteral(r.node, r.ctx, guard);
    guard.delete(key);
    return out;
  }
  return null;
}

// ───────────────────────── zod expression → type descriptor ─────────────────────────

const unresolved = (raw) => ({ kind: 'unresolved', raw });

function renderDecimalStringCall(argNode) {
  let scale = 0;
  let allowNegative = true;
  if (argNode && ts.isObjectLiteralExpression(argNode)) {
    for (const prop of argNode.properties) {
      if (!ts.isPropertyAssignment(prop)) continue;
      const key = propKeyName(prop.name);
      if (key === 'scale' && ts.isNumericLiteral(prop.initializer)) scale = Number(prop.initializer.text);
      if (key === 'allowNegative') {
        if (prop.initializer.kind === ts.SyntaxKind.FalseKeyword) allowNegative = false;
        if (prop.initializer.kind === ts.SyntaxKind.TrueKeyword) allowNegative = true;
      }
    }
  }
  return { kind: 'scalar', base: 'decimal-string', scale, allowNegative, constraints: [] };
}

function mergeFields(base, extra) {
  const order = base.map((f) => f.name);
  const map = new Map(base.map((f) => [f.name, f]));
  for (const f of extra) {
    if (!map.has(f.name)) order.push(f.name);
    map.set(f.name, f);
  }
  return order.map((n) => map.get(n));
}

function objLitTrueKeys(objLit) {
  return objLit.properties
    .filter((p) => ts.isPropertyAssignment(p) && p.initializer.kind === ts.SyntaxKind.TrueKeyword)
    .map((p) => propKeyName(p.name));
}

function renderObjectFields(objLit, fileCtx, guard) {
  let fields = [];
  for (const prop of objLit.properties) {
    if (ts.isPropertyAssignment(prop)) {
      fields = mergeFields(fields, [
        { name: propKeyName(prop.name), desc: render(prop.initializer, fileCtx, guard) },
      ]);
    } else if (ts.isShorthandPropertyAssignment(prop)) {
      fields = mergeFields(fields, [{ name: prop.name.text, desc: render(prop.name, fileCtx, guard) }]);
    } else if (ts.isSpreadAssignment(prop)) {
      const spread = resolveToObjectLiteral(prop.expression, fileCtx, guard);
      if (spread) fields = mergeFields(fields, renderObjectFields(spread.node, spread.ctx, guard));
      else
        fields = mergeFields(fields, [
          {
            name: `…${safeText(prop.expression, fileCtx, 40)}`,
            desc: unresolved('spread를 정적으로 풀 수 없음'),
          },
        ]);
    }
  }
  return fields;
}

function renderZBuiltin(method, args, fileCtx, guard) {
  switch (method) {
    case 'object':
      return args[0] && ts.isObjectLiteralExpression(args[0])
        ? { kind: 'object', fields: renderObjectFields(args[0], fileCtx, guard) }
        : unresolved('z.object(<non-literal>)');
    case 'array':
      return {
        kind: 'array',
        of: args[0] ? render(args[0], fileCtx, guard) : unresolved('z.array()'),
        constraints: [],
      };
    case 'string':
    case 'number':
    case 'boolean':
      return { kind: 'scalar', base: method, constraints: [] };
    case 'unknown':
    case 'any':
      return { kind: 'scalar', base: 'unknown', constraints: [] };
    case 'enum': {
      const arg0 = args[0];
      if (arg0 && ts.isArrayLiteralExpression(arg0))
        return { kind: 'enum', values: arg0.elements.filter(ts.isStringLiteralLike).map((e) => e.text) };
      const arr = arg0 ? resolveArrayLiteral(arg0, fileCtx, guard) : null;
      return arr
        ? { kind: 'enum', values: arr }
        : unresolved(`z.enum(${arg0 ? safeText(arg0, fileCtx, 60) : ''})`);
    }
    case 'record': {
      const keyDesc = args[0] ? render(args[0], fileCtx, guard) : unresolved('key');
      const valDesc = args[1] ? render(args[1], fileCtx, guard) : unresolved('value');
      return { kind: 'record', keyDesc, valDesc };
    }
    default:
      return unresolved(`z.${method}(...)`);
  }
}

function applyModifier(base, method, args, fileCtx, guard) {
  const b = { ...base, constraints: [...(base.constraints ?? [])] };
  switch (method) {
    case 'optional':
      b.optional = true;
      return b;
    case 'nullable':
      b.nullable = true;
      return b;
    case 'nullish':
      b.optional = true;
      b.nullable = true;
      return b;
    case 'default':
      b.hasDefault = true;
      b.defaultText = args[0] ? safeText(args[0], fileCtx, 60) : '';
      return b;
    case 'catch':
      return b;
    case 'min':
    case 'max':
    case 'length': {
      const n = args[0] ? safeText(args[0], fileCtx, 40) : '?';
      b.constraints.push(`${method} ${n}`);
      return b;
    }
    case 'int':
    case 'email':
    case 'uuid':
    case 'trim':
    case 'positive':
    case 'nonnegative':
      b.constraints.push(method);
      return b;
    case 'regex':
      b.constraints.push(`regex ${args[0] ? safeText(args[0], fileCtx, 60) : '?'}`);
      return b;
    case 'refine':
    case 'superRefine':
      b.constraints.push('custom refine');
      return b;
    case 'transform':
    case 'describe':
    case 'brand':
      return b;
    case 'extend': {
      if (b.kind !== 'object') return { ...unresolved(`.extend() on non-object (${b.kind})`) };
      const arg0 = args[0];
      const extra =
        arg0 && ts.isObjectLiteralExpression(arg0) ? renderObjectFields(arg0, fileCtx, guard) : [];
      return { ...b, fields: mergeFields(b.fields, extra) };
    }
    case 'merge': {
      if (b.kind !== 'object') return { ...unresolved('.merge() on non-object') };
      const other = args[0] ? render(args[0], fileCtx, guard) : null;
      if (!other || other.kind !== 'object') return unresolved('.merge(<unresolved>)');
      return { ...b, fields: mergeFields(b.fields, other.fields) };
    }
    case 'partial':
      if (b.kind !== 'object') return b;
      return { ...b, fields: b.fields.map((f) => ({ name: f.name, desc: { ...f.desc, optional: true } })) };
    case 'omit': {
      if (b.kind !== 'object') return b;
      const arg0 = args[0];
      const drop = arg0 && ts.isObjectLiteralExpression(arg0) ? objLitTrueKeys(arg0) : [];
      return { ...b, fields: b.fields.filter((f) => !drop.includes(f.name)) };
    }
    case 'pick': {
      if (b.kind !== 'object') return b;
      const arg0 = args[0];
      const keep = arg0 && ts.isObjectLiteralExpression(arg0) ? objLitTrueKeys(arg0) : null;
      return keep ? { ...b, fields: b.fields.filter((f) => keep.includes(f.name)) } : b;
    }
    default:
      return { ...b, note: `.${method}(...) — 정적 분석 미지원, 무시됨` };
  }
}

function render(node, fileCtx, guard = new Set()) {
  if (ts.isParenthesizedExpression(node)) return render(node.expression, fileCtx, guard);
  if (ts.isAsExpression(node)) return render(node.expression, fileCtx, guard);
  if (ts.isIdentifier(node)) {
    const key = `${fileCtx.absPath}#${node.text}`;
    if (guard.has(key)) return unresolved(`circular:${node.text}`);
    const resolved = resolveIdentifier(node.text, fileCtx);
    if (!resolved) return unresolved(node.text);
    guard.add(key);
    const result = render(resolved.node, resolved.ctx, guard);
    guard.delete(key);
    return result;
  }
  if (ts.isCallExpression(node)) {
    const callee = node.expression;
    if (ts.isPropertyAccessExpression(callee)) {
      const method = callee.name.text;
      if (ts.isIdentifier(callee.expression) && callee.expression.text === 'z')
        return renderZBuiltin(method, node.arguments, fileCtx, guard);
      const base = render(callee.expression, fileCtx, guard);
      return applyModifier(base, method, node.arguments, fileCtx, guard);
    }
    if (ts.isIdentifier(callee) && callee.text === 'decimalString')
      return renderDecimalStringCall(node.arguments[0]);
    return unresolved(safeText(node, fileCtx, 120));
  }
  if (ts.isObjectLiteralExpression(node))
    return { kind: 'object', fields: renderObjectFields(node, fileCtx, guard) };
  return unresolved(safeText(node, fileCtx, 80));
}

// ───────────────────────── descriptor → markdown ─────────────────────────

const SCALAR_LABEL = { string: '문자열', number: '숫자', boolean: '불리언', unknown: '임의 값(unknown)' };

function scalarLabel(desc) {
  if (desc.base === 'decimal-string')
    return `정밀 소수 문자열 (scale=${desc.scale}, ${desc.allowNegative ? '음수 허용' : '비음수'})`;
  const label = SCALAR_LABEL[desc.base] ?? desc.base;
  return desc.constraints?.length ? `${label} (${desc.constraints.join(', ')})` : label;
}

function describeInline(desc) {
  if (desc.kind === 'scalar') return scalarLabel(desc);
  if (desc.kind === 'enum') return `enum(${desc.values.join(' | ')})`;
  if (desc.kind === 'unresolved') return `⚠ 정적 분석 불가(${desc.raw})`;
  if (desc.kind === 'object') return 'object';
  if (desc.kind === 'array') return `배열 of ${describeInline(desc.of)}`;
  if (desc.kind === 'record')
    return `record<${describeInline(desc.keyDesc)}, ${describeInline(desc.valDesc)}>`;
  return desc.kind;
}

function flagsSuffix(desc, extraTag) {
  const bits = [];
  if (desc.nullable) bits.push('nullable 허용');
  const isOptional = Boolean(desc.optional || desc.hasDefault);
  bits.push(isOptional ? '선택' : '필수');
  if (desc.hasDefault) bits.push(`기본값=${desc.defaultText}`);
  if (extraTag) bits.push(extraTag);
  return bits.join(', ');
}

function renderField(name, desc, indent, lines, unresolvedAcc, pathPrefix, tagField) {
  const p = pathPrefix ? `${pathPrefix}.${name}` : name;
  const pad = '  '.repeat(indent);
  const tag = tagField && tagField === p ? '멱등성 키' : null;
  if (desc.kind === 'scalar') {
    lines.push(`${pad}- \`${name}\`: ${scalarLabel(desc)} — ${flagsSuffix(desc, tag)}`);
  } else if (desc.kind === 'enum') {
    lines.push(`${pad}- \`${name}\`: enum(${desc.values.join(' | ')}) — ${flagsSuffix(desc, tag)}`);
  } else if (desc.kind === 'record') {
    lines.push(
      `${pad}- \`${name}\`: record<${describeInline(desc.keyDesc)}, ${describeInline(desc.valDesc)}> — ${flagsSuffix(desc, tag)}`,
    );
  } else if (desc.kind === 'array') {
    const cons = desc.constraints?.length ? ` (${desc.constraints.join(', ')})` : '';
    lines.push(`${pad}- \`${name}\`: 배열${cons} — ${flagsSuffix(desc, tag)}`);
    if (desc.of.kind === 'object') {
      lines.push(`${pad}  배열 원소:`);
      for (const f of desc.of.fields)
        renderField(f.name, f.desc, indent + 2, lines, unresolvedAcc, `${p}[]`, tagField);
    } else if (desc.of.kind === 'unresolved') {
      lines.push(`${pad}  → ⚠ 원소 타입 정적 분석 불가: \`${desc.of.raw}\``);
      unresolvedAcc.push(`${p}[]`);
    } else {
      lines.push(`${pad}  → 원소 타입: ${describeInline(desc.of)}`);
    }
  } else if (desc.kind === 'object') {
    lines.push(`${pad}- \`${name}\`: object — ${flagsSuffix(desc, tag)}`);
    for (const f of desc.fields) renderField(f.name, f.desc, indent + 1, lines, unresolvedAcc, p, tagField);
  } else {
    lines.push(`${pad}- \`${name}\`: ⚠ 정적 분석 불가 — 원본 확인 필요 (\`${desc.raw}\`)`);
    unresolvedAcc.push(p);
  }
}

function renderInputShape(desc, unresolvedAcc, tagField) {
  if (!desc) return ['(입력 없음)'];
  const lines = [];
  if (desc.kind === 'object') {
    if (!desc.fields.length) return ['(입력 없음 — 빈 객체)'];
    for (const f of desc.fields) renderField(f.name, f.desc, 0, lines, unresolvedAcc, '', tagField);
  } else {
    renderField('(root)', desc, 0, lines, unresolvedAcc, '', tagField);
  }
  return lines;
}

// ───────────────────────── procedure-chain analysis ─────────────────────────

function findTxCalls(node, acc) {
  if (!node || typeof node !== 'object') return;
  if (
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    (node.expression.text === 'tx' || node.expression.text === 'readTx')
  )
    acc.push(node);
  ts.forEachChild(node, (c) => findTxCalls(c, acc));
}

function analyzeProcedureChain(expr, fileCtx) {
  let node = expr;
  let opType = null;
  let handlerNode = null;
  let inputArg = null;
  for (;;) {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const method = node.expression.name.text;
      if (method === 'query' || method === 'mutation') {
        opType = method;
        handlerNode = node.arguments[0] ?? null;
        node = node.expression.expression;
        continue;
      }
      if (method === 'input') {
        inputArg = node.arguments[0] ?? null;
        node = node.expression.expression;
        continue;
      }
      if (method === 'use') {
        node = node.expression.expression;
        continue;
      }
    }
    break;
  }

  let permission;
  if (
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === 'permissionProcedure'
  ) {
    const arg0 = node.arguments[0];
    permission =
      arg0 && ts.isStringLiteralLike(arg0) ? `\`${arg0.text}\`` : `동적 (${safeText(arg0, fileCtx)})`;
  } else if (ts.isIdentifier(node) && node.text === 'authedProcedure') {
    permission = '(인증 필요 — 별도 업무 권한 없음)';
  } else if (ts.isIdentifier(node) && node.text === 'publicProcedure') {
    permission = '(공개 — 인증 불필요)';
  } else {
    permission = `⚠ 확인 필요 (${safeText(node, fileCtx)})`;
  }

  let idempotent = false;
  let requestIdExpr = null;
  let calledTxHelper = false;
  if (handlerNode) {
    const txCalls = [];
    findTxCalls(handlerNode, txCalls);
    calledTxHelper = txCalls.length > 0;
    for (const call of txCalls) {
      if (call.expression.text === 'tx' && call.arguments.length >= 3) {
        idempotent = true;
        requestIdExpr = safeText(call.arguments[2], fileCtx, 60);
        break;
      }
    }
  }

  return { opType, handlerNode, inputArg, permission, idempotent, requestIdExpr, calledTxHelper, base: node };
}

function findRouterObjectLiteral(sourceFile) {
  let result = null;
  function visit(node) {
    if (result) return;
    if (
      ts.isVariableDeclaration(node) &&
      node.initializer &&
      ts.isCallExpression(node.initializer) &&
      ts.isIdentifier(node.initializer.expression) &&
      node.initializer.expression.text === 'router' &&
      node.initializer.arguments[0] &&
      ts.isObjectLiteralExpression(node.initializer.arguments[0])
    ) {
      result = {
        varName: ts.isIdentifier(node.name) ? node.name.text : node.name.getText(),
        obj: node.initializer.arguments[0],
      };
      return;
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return result;
}

function parseMountMap(absPath) {
  const ctx = loadFile(absPath);
  const importFileByLocal = new Map();
  for (const stmt of ctx.sourceFile.statements) {
    if (
      ts.isImportDeclaration(stmt) &&
      stmt.importClause?.namedBindings &&
      ts.isStringLiteral(stmt.moduleSpecifier)
    ) {
      const nb = stmt.importClause.namedBindings;
      if (!ts.isNamedImports(nb)) continue;
      const resolved = resolveModulePath(stmt.moduleSpecifier.text, absPath);
      for (const el of nb.elements) importFileByLocal.set(el.name.text, resolved);
    }
  }
  const mount = new Map(); // resolved router file path -> mount key
  function visit(node) {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'router' &&
      node.arguments[0] &&
      ts.isObjectLiteralExpression(node.arguments[0])
    ) {
      for (const p of node.arguments[0].properties) {
        if (ts.isPropertyAssignment(p) && ts.isIdentifier(p.initializer)) {
          const filePath = importFileByLocal.get(p.initializer.text);
          if (filePath) mount.set(filePath, propKeyName(p.name));
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(ctx.sourceFile);
  return mount;
}

// ───────────────────────── errors.ts (appCode / http status) ─────────────────────────

function parseErrorCodes(absPath) {
  const ctx = loadFile(absPath);
  const codes = [];
  const statusMap = new Map();
  let defaultStatus = null;
  function visit(node) {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === 'ErrorCodes' &&
      node.initializer
    ) {
      let init = node.initializer;
      if (ts.isAsExpression(init)) init = init.expression;
      if (ts.isObjectLiteralExpression(init)) {
        for (const p of init.properties)
          if (ts.isPropertyAssignment(p) && ts.isStringLiteralLike(p.initializer))
            codes.push(p.initializer.text);
      }
    }
    if (ts.isFunctionDeclaration(node) && node.name?.text === 'httpStatusFor' && node.body) {
      const switchStmt = node.body.statements.find(ts.isSwitchStatement);
      if (switchStmt) {
        let pending = [];
        for (const clause of switchStmt.caseBlock.clauses) {
          if (ts.isCaseClause(clause)) {
            pending.push(clause.expression.getText(ctx.sourceFile).replace(/['"]/g, ''));
            if (clause.statements.length > 0) {
              const ret = clause.statements.find(ts.isReturnStatement);
              const val = ret?.expression && ts.isNumericLiteral(ret.expression) ? ret.expression.text : '?';
              for (const label of pending) statusMap.set(label, val);
              pending = [];
            }
          } else if (ts.isDefaultClause(clause)) {
            const ret = clause.statements.find(ts.isReturnStatement);
            defaultStatus =
              ret?.expression && ts.isNumericLiteral(ret.expression) ? ret.expression.text : '?';
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(ctx.sourceFile);
  return { codes, statusMap, defaultStatus };
}

// ───────────────────────── main ─────────────────────────

const routerFiles = fs
  .readdirSync(routersDir)
  .filter((f) => f.endsWith('.ts'))
  .sort()
  .map((f) => path.join(routersDir, f));

const mountMap = fs.existsSync(rootRouterPath) ? parseMountMap(rootRouterPath) : new Map();
const { codes: appCodes, statusMap, defaultStatus } = parseErrorCodes(errorsPath);

const routers = []; // { mountKey, fileRel, procedures: [...] }
const globalUnresolved = []; // `${mountKey}.${proc} → path`
const globalParseFailures = []; // files where no router({...}) was found at all

for (const filePath of routerFiles) {
  const ctx = loadFile(filePath);
  const found = findRouterObjectLiteral(ctx.sourceFile);
  const fileRel = path.relative(root, filePath);
  if (!found) {
    globalParseFailures.push(fileRel);
    continue;
  }
  const mountKey = mountMap.get(filePath) ?? found.varName.replace(/Router$/, '');
  const procedures = [];
  for (const prop of found.obj.properties) {
    if (!ts.isPropertyAssignment(prop)) continue;
    const name = propKeyName(prop.name);
    const info = analyzeProcedureChain(prop.initializer, ctx);
    const inputDesc = info.inputArg ? render(info.inputArg, ctx) : null;
    const unresolvedPaths = [];
    let tagField = null;
    if (info.requestIdExpr) {
      const m = info.requestIdExpr.match(/^input\.(\w+)$/);
      if (m) tagField = m[1];
    }
    const shapeLines = renderInputShape(inputDesc, unresolvedPaths, tagField);
    for (const up of unresolvedPaths) globalUnresolved.push(`${mountKey}.${name} → \`${up}\``);
    procedures.push({ name, info, shapeLines, hasUnresolved: unresolvedPaths.length > 0 });
  }
  routers.push({ mountKey, fileRel, procedures });
}

routers.sort((a, b) => a.mountKey.localeCompare(b.mountKey));

// ───────────────────────── markdown assembly ─────────────────────────

let md = `# API 명세 (tRPC Routers)\n\n`;
md += `> 생성: \`node tools/docs-api.mjs\` — 원본은 \`src/server/api/routers/*.ts\`(정적 AST 분석, 실행하지 않음). 이 파일을 직접 편집하지 않는다.\n\n`;
md += `생성 시각: ${new Date().toISOString()} · 라우터 ${routers.length}개 · 프로시저 ${routers.reduce((n, r) => n + r.procedures.length, 0)}개\n\n`;

md += `## 전송 규약\n\n`;
md += `- **프로토콜**: tRPC v11, HTTP 하나의 엔드포인트(\`src/server/api/root.ts\`의 \`appRouter\`). 라우터마다 하나의 네임스페이스(\`trpc.<mountKey>.<procedure>\`)로 노출된다.\n`;
md += `- **직렬화 (INT-01)**: \`src/server/api/transformer.ts\`의 커스텀 transformer가 superjson 대신 쓰인다 — Prisma \`Decimal\`과 \`Date\`를 문자열로 직렬화하므로, 금액·수량·일시는 클라이언트에서 항상 정밀 문자열/ISO 문자열로 온다. 요청 입력도 동일한 이유로 \`decimalString\`류 zod 스키마가 문자열을 받는다.\n`;
md += `- **에러 형태**: 업무 오류는 \`src/server/core/errors.ts\`의 \`AppError(code, message, meta)\`이고, \`src/server/api/trpc.ts\`의 tRPC \`errorFormatter\`가 이를 \`error.data.appCode\`와 \`error.data.meta\`로 노출한다(표준 tRPC \`error.data.code\`/\`error.message\`는 그대로 유지). 클라이언트는 \`shape.data?.appCode\`로 분기한다(예: \`VERSION_CONFLICT\`일 때 재조회 후 재시도 안내).\n\n`;

md += `**\`appCode\` 값** (\`src/server/core/errors.ts\`의 \`ErrorCodes\`에서 자동 추출, ${appCodes.length}개):\n\n`;
md += appCodes.map((c) => `\`${c}\``).join(', ') + '\n\n';

md += `**\`appCode\` → HTTP 상태** (\`httpStatusFor\`, 명시되지 않은 코드는 기본값 ${defaultStatus ?? '?'}):\n\n`;
md += `| appCode | HTTP 상태 |\n|---|---|\n`;
for (const code of appCodes) md += `| \`${code}\` | ${statusMap.get(code) ?? defaultStatus ?? '?'} |\n`;
md += `\n`;

md += `## 요약\n\n`;
md += `| 라우터 | 프로시저 | 종류 | 권한 | 멱등(requestId) |\n|---|---|---|---|---|\n`;
for (const r of routers) {
  for (const p of r.procedures) {
    const idem = p.info.idempotent
      ? `예 (${p.info.requestIdExpr})`
      : p.info.opType === 'mutation'
        ? '아니오'
        : '—';
    md += `| \`${r.mountKey}\` | \`${p.name}\` | ${p.info.opType ?? '?'} | ${p.info.permission} | ${idem} |\n`;
  }
}
md += `\n`;

md += `## 라우터별 상세\n\n`;
for (const r of routers) {
  md += `### ${r.mountKey} (\`${r.fileRel}\`)\n\n`;
  for (const p of r.procedures) {
    const idem = p.info.idempotent
      ? `예 — 3번째 인자로 \`tx()\`에 전달됨 (\`${p.info.requestIdExpr}\`)`
      : p.info.opType === 'query'
        ? '해당 없음 (query)'
        : p.info.calledTxHelper
          ? '아니오 (tx() 호출은 있으나 requestId 인자 없음)'
          : '아니오 (tx/readTx 미호출 — 직접 처리, 원본 확인)';
    md += `#### \`${r.mountKey}.${p.name}\` — ${p.info.opType ?? '?'}\n\n`;
    md += `- 권한: ${p.info.permission}\n`;
    md += `- 멱등(requestId): ${idem}\n`;
    md += `- 입력:\n`;
    for (const line of p.shapeLines) md += `  ${line}\n`;
    if (p.hasUnresolved)
      md += `- ⚠ 이 프로시저는 입력 일부를 정적으로 분석하지 못했다 — 위 표시(⚠)와 원본 파일을 함께 확인할 것.\n`;
    md += `\n`;
  }
}

if (globalParseFailures.length) {
  md += `## 파싱 실패\n\n다음 파일에서 \`router({...})\` 호출을 찾지 못했다 — 라우터 파일 구조가 바뀌었는지 확인할 것:\n\n`;
  for (const f of globalParseFailures) md += `- \`${f}\`\n`;
  md += `\n`;
}

md += `## 정적 분석 한계\n\n`;
if (globalUnresolved.length) {
  md += `다음 입력 필드는 이 스크립트가 정적으로 타입을 확정하지 못했다 (커스텀 헬퍼 호출, 동적 표현식 등) — 짐작해서 채우지 않고 원본을 참조하도록 남긴다:\n\n`;
  for (const u of globalUnresolved) md += `- ${u}\n`;
} else {
  md += `모든 프로시저의 입력 shape를 정적으로 해석했다 — 이 절이 채워지면 (위 목록) 원본 라우터 파일을 함께 확인할 것.\n`;
}
md += `\n`;

// Prettier is run on the generated markdown itself (not just excluded via .prettierignore)
// so the checked-in file is already the shape `npx prettier --write` would leave it in.
const prettierConfig = (await prettier.resolveConfig(outPath)) ?? {};
md = await prettier.format(md, { ...prettierConfig, parser: 'markdown', filepath: outPath });

fs.mkdirSync(path.dirname(outPath), { recursive: true });

if (checkOnly) {
  const current = fs.existsSync(outPath) ? fs.readFileSync(outPath, 'utf8') : null;
  const strip = (s) => (s ?? '').replace(/생성 시각: [^ ]+/, '생성 시각: <ts>');
  if (strip(current) !== strip(md)) {
    console.error(`docs/api.md is stale — run \`node tools/docs-api.mjs\` and commit the result.`);
    process.exit(1);
  }
  console.log('docs/api.md is up to date');
  process.exit(0);
}

fs.writeFileSync(outPath, md);
console.log(
  `wrote ${path.relative(root, outPath)} (${routers.length} routers, ${routers.reduce((n, r) => n + r.procedures.length, 0)} procedures)`,
);
