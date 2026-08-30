#!/usr/bin/env node
/**
 * Generates docs/requirements-traceability.md from
 *  - docs/requirements.json       (requirement baseline, extracted from RFP v0.3)
 *  - docs/traceability-state.json (per-ID implementation evidence and status)
 * Also validates: no duplicate/missing IDs, every state entry maps to a known ID,
 * and every DONE entry has implementation + automated test evidence.
 *
 * Usage: node tools/traceability.mjs [--check]
 */
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(new URL('.', import.meta.url).pathname, '..');
const reqPath = path.join(root, 'docs/requirements.json');
const statePath = path.join(root, 'docs/traceability-state.json');
const outPath = path.join(root, 'docs/requirements-traceability.md');
const checkOnly = process.argv.includes('--check');

const req = JSON.parse(fs.readFileSync(reqPath, 'utf8'));
const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : {};

const errors = [];
const ids = req.requirements.map((r) => r.id);
const dup = ids.filter((id, i) => ids.indexOf(id) !== i);
if (dup.length) errors.push(`duplicate ids: ${dup.join(', ')}`);

// sequence check per module prefix
const byPrefix = {};
for (const id of ids) {
  const m = id.match(/^([A-Z]+(?:-[A-Z]+)?)-(\d+)$/);
  if (!m) {
    errors.push(`bad id format: ${id}`);
    continue;
  }
  (byPrefix[m[1]] ||= []).push(Number(m[2]));
}
for (const [p, nums] of Object.entries(byPrefix)) {
  nums.sort((a, b) => a - b);
  for (let i = 0; i < nums.length; i++)
    if (nums[i] !== i + 1) {
      errors.push(`gap in ${p}: expected ${p}-${String(i + 1).padStart(2, '0')}`);
      break;
    }
}
const entries = Object.entries(state).filter(([id]) => !id.startsWith('__'));
for (const [id] of entries) if (!ids.includes(id)) errors.push(`state has unknown id: ${id}`);
for (const [id, s] of entries) {
  if (!req.statuses.includes(s.status)) errors.push(`${id}: unknown status ${s.status}`);
  if (s.status === 'DONE') {
    if (!(s.services?.length || s.api?.length || s.screens?.length || s.docs?.length))
      errors.push(`${id}: DONE without implementation evidence`);
    if (!s.tests?.length) errors.push(`${id}: DONE without automated test evidence`);
  }
  if (s.status === 'BLOCKED' && !s.blocked) errors.push(`${id}: BLOCKED without reason/owner/targetDate`);
}

if (checkOnly) {
  if (errors.length) {
    console.error(errors.join('\n'));
    process.exit(1);
  }
  console.log('traceability ok');
  process.exit(0);
}

const modules = [...new Set(req.requirements.map((r) => r.module))];
const moduleNames = {
  BAS: '기초정보',
  SLS: '매출·매입·발주',
  INV: '재고',
  ACC: '회계',
  APV: '전자결재',
  HRM: '인사',
  RPT: '보고서',
  UIX: '공통 UI',
  INT: '공통 데이터 정합성',
  NFR: '비기능',
  MIG: '데이터 이관',
  DEC: '착수 시 확정 정책',
};
const j = (a) => (a && a.length ? a.map((x) => `\`${x}\``).join('<br>') : '—');

let md = `# 요구사항 추적표 (Requirements Traceability Matrix)\n\n`;
md += `> 생성: \`node tools/traceability.mjs\` — 원본은 \`docs/requirements.json\`(기준선)과 \`docs/traceability-state.json\`(증적). 이 파일을 직접 편집하지 않는다.\n\n`;
md += `기준 문서: ${req.source} · 생성 시각: ${new Date().toISOString()}\n\n`;

// summary
md += `## 집계\n\n| 모듈 | M | O | 합계 | DONE | IN_PROGRESS | NOT_VERIFIED | BLOCKED | NOT_STARTED | OPTION_NOT_APPROVED |\n|---|---|---|---|---|---|---|---|---|---|\n`;
let tot = { M: 0, O: 0, total: 0 };
const cnt = (list, st) => list.filter((r) => (state[r.id]?.status ?? 'NOT_STARTED') === st).length;
for (const m of modules) {
  const list = req.requirements.filter((r) => r.module === m);
  const M = list.filter((r) => r.priority === 'M').length;
  const O = list.filter((r) => r.priority === 'O').length;
  tot.M += M;
  tot.O += O;
  tot.total += list.length;
  md += `| ${m} ${moduleNames[m] ?? ''} | ${M} | ${O} | ${list.length} | ${cnt(list, 'DONE')} | ${cnt(list, 'IN_PROGRESS')} | ${cnt(list, 'NOT_VERIFIED')} | ${cnt(list, 'BLOCKED')} | ${cnt(list, 'NOT_STARTED')} | ${cnt(list, 'OPTION_NOT_APPROVED')} |\n`;
}
md += `| **합계** | **${tot.M}** | **${tot.O}** | **${tot.total}** | ${cnt(req.requirements, 'DONE')} | ${cnt(req.requirements, 'IN_PROGRESS')} | ${cnt(req.requirements, 'NOT_VERIFIED')} | ${cnt(req.requirements, 'BLOCKED')} | ${cnt(req.requirements, 'NOT_STARTED')} | ${cnt(req.requirements, 'OPTION_NOT_APPROVED')} |\n\n`;
md += `기능 요구사항(BAS·SLS·INV·ACC·APV·HRM·RPT·UIX): M ${req.requirements.filter((r) => r.priority === 'M' && !['INT', 'NFR', 'MIG', 'DEC'].includes(r.module)).length}개, O ${req.requirements.filter((r) => r.priority === 'O').length}개 (RFP 5장 선언: 필수 85 / 선택 6).\n\n`;

for (const m of modules) {
  md += `## ${m} — ${moduleNames[m] ?? ''}\n\n`;
  md += `| ID | 중요도 | 요구사항 | 구현 화면 | API/라우터 | 서비스 | 테이블 | 자동시험 | 수동검수 | 상태 | 비고 |\n|---|---|---|---|---|---|---|---|---|---|---|\n`;
  for (const r of req.requirements.filter((x) => x.module === m)) {
    const s = state[r.id] ?? {};
    const status = s.status ?? 'NOT_STARTED';
    const note = [
      s.notes,
      s.blocked
        ? `BLOCKED: ${s.blocked.reason} / 영향: ${s.blocked.impact} / 책임: ${s.blocked.owner} / 목표: ${s.blocked.targetDate}`
        : null,
      s.manualOnly ? '⚠ 수동확인만' : null,
    ]
      .filter(Boolean)
      .join('<br>');
    md += `| ${r.id} | ${r.priority} | **${r.title}** — ${r.summary} | ${j(s.screens)} | ${j(s.api)} | ${j(s.services)} | ${j(s.tables)} | ${j(s.tests)} | ${s.manual ?? '—'} | ${status} | ${note || '—'} |\n`;
  }
  md += `\n`;
}

const cr = state.__changeRequests ?? [];
md += `## CHANGE_REQUEST\n\n`;
md += cr.length
  ? `| ID | 발견 단계 | 내용 | 관련 ID | 상태 |\n|---|---|---|---|---|\n` +
    cr
      .map((c) => `| ${c.id} | ${c.step} | ${c.text} | ${c.related?.join(', ') ?? ''} | ${c.status} |\n`)
      .join('')
  : `(없음)\n`;

if (errors.length) md += `\n## 검증 경고\n\n${errors.map((e) => `- ${e}`).join('\n')}\n`;
fs.writeFileSync(outPath, md);
console.log(`wrote ${path.relative(root, outPath)}; ${errors.length} warning(s)`);
if (errors.length) {
  console.error(errors.join('\n'));
  process.exit(1);
}
