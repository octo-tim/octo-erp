/**
 * Shared static-AST helper — NOT a generator on its own.
 *
 * Walks src/server/api/routers/*.ts and, for every tRPC procedure, resolves which of
 * `permissionProcedure('x.y')` / `authedProcedure` / `publicProcedure` sits at the base of its
 * builder chain (mirroring tools/docs-api.mjs's analyzeProcedureChain, trimmed to just the
 * permission question). Both `tools/docs-permissions.mjs` (docs/permissions.md) and
 * `tests/integration/permissions.test.ts` (the exhaustive call test) import this so the
 * generated doc and the test can never disagree about which procedure needs which permission —
 * there is exactly one place that answers that question, by parsing the routers, not by
 * hand-maintained lists.
 *
 * STEP 13.
 */
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

function resolveModulePath(spec, fromFile, root) {
  let p;
  if (spec.startsWith('.')) p = path.join(path.dirname(fromFile), spec);
  else if (spec.startsWith('@/')) p = path.join(root, 'src', spec.slice(2));
  else return null; // external package
  const candidates = [p, `${p}.ts`, `${p}.tsx`, path.join(p, 'index.ts')];
  return candidates.find((c) => fs.existsSync(c) && fs.statSync(c).isFile()) ?? null;
}

function loadFile(absPath, cache) {
  if (cache.has(absPath)) return cache.get(absPath);
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
      const resolved = resolveModulePath(spec, absPath, cache.root);
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
  cache.set(absPath, ctx);
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

/** Resolves the base of a procedure builder chain to a permission descriptor. */
function analyzeBase(expr, fileCtx) {
  let node = expr;
  // walk back through `.use()`, `.input()`, `.output()`, `.query()/.mutation()` etc.
  for (;;) {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      node = node.expression.expression;
      continue;
    }
    break;
  }
  if (
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === 'permissionProcedure'
  ) {
    const arg0 = node.arguments[0];
    if (arg0 && ts.isStringLiteralLike(arg0)) return { kind: 'permission', permission: arg0.text };
    return { kind: 'unresolved', raw: arg0 ? safeText(arg0, fileCtx) : '(no arg)' };
  }
  if (ts.isIdentifier(node) && node.text === 'authedProcedure') return { kind: 'authed' };
  if (ts.isIdentifier(node) && node.text === 'publicProcedure') return { kind: 'public' };
  return { kind: 'unresolved', raw: safeText(node, fileCtx) };
}

function opTypeOf(expr) {
  // find the outermost `.query(...)` / `.mutation(...)` call
  let node = expr;
  while (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
    const method = node.expression.name.text;
    if (method === 'query' || method === 'mutation') return method;
    node = node.expression.expression;
  }
  return null;
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

function parseMountMap(absPath, cache, root) {
  const ctx = loadFile(absPath, cache);
  const importFileByLocal = new Map();
  for (const stmt of ctx.sourceFile.statements) {
    if (
      ts.isImportDeclaration(stmt) &&
      stmt.importClause?.namedBindings &&
      ts.isStringLiteral(stmt.moduleSpecifier)
    ) {
      const nb = stmt.importClause.namedBindings;
      if (!ts.isNamedImports(nb)) continue;
      const resolved = resolveModulePath(stmt.moduleSpecifier.text, absPath, root);
      for (const el of nb.elements) importFileByLocal.set(el.name.text, resolved);
    }
  }
  const mount = new Map();
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

/**
 * @param {{root: string}} opts absolute repo root
 * @returns {{
 *   routers: Array<{ mountKey: string, fileRel: string, procedures: Array<{
 *     name: string, path: string, opType: 'query'|'mutation'|null,
 *     kind: 'permission'|'authed'|'public'|'unresolved', permission: string|null, raw?: string
 *   }> }>,
 *   parseFailures: string[],
 *   totalProcedures: number,
 * }}
 */
export function collectRouterPermissions({ root }) {
  const routersDir = path.join(root, 'src/server/api/routers');
  const rootRouterPath = path.join(root, 'src/server/api/root.ts');
  const cache = new Map();
  cache.root = root;

  const routerFiles = fs
    .readdirSync(routersDir)
    .filter((f) => f.endsWith('.ts'))
    .sort()
    .map((f) => path.join(routersDir, f));

  const mountMap = fs.existsSync(rootRouterPath) ? parseMountMap(rootRouterPath, cache, root) : new Map();

  const routers = [];
  const parseFailures = [];
  let totalProcedures = 0;

  for (const filePath of routerFiles) {
    const ctx = loadFile(filePath, cache);
    const found = findRouterObjectLiteral(ctx.sourceFile);
    const fileRel = path.relative(root, filePath);
    if (!found) {
      parseFailures.push(fileRel);
      continue;
    }
    const mountKey = mountMap.get(filePath) ?? found.varName.replace(/Router$/, '');
    const procedures = [];
    for (const prop of found.obj.properties) {
      if (!ts.isPropertyAssignment(prop)) continue;
      const name = propKeyName(prop.name);
      const base = analyzeBase(prop.initializer, ctx);
      const opType = opTypeOf(prop.initializer);
      procedures.push({
        name,
        path: `${mountKey}.${name}`,
        opType,
        kind: base.kind,
        permission: base.kind === 'permission' ? base.permission : null,
        ...(base.kind === 'unresolved' ? { raw: base.raw } : {}),
      });
    }
    totalProcedures += procedures.length;
    routers.push({ mountKey, fileRel, procedures });
  }

  routers.sort((a, b) => a.mountKey.localeCompare(b.mountKey));
  return { routers, parseFailures, totalProcedures };
}
