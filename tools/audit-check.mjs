#!/usr/bin/env node
/**
 * NFR-SEC-05 의존성 취약점 게이트.
 *
 * CI는 예전에 `npm audit --audit-level=high`를 continue-on-error로 돌렸다. 검사는 하지만
 * 결과로 아무 일도 일어나지 않으니, 새 취약점이 들어와도 로그 한 줄로 지나간다 — 이
 * 저장소가 STEP 13에서 여러 번 고친 것과 같은 모양의 결함이다.
 *
 * 그래서 기준선을 둔다. docs/security-advisories.json에 사유·영향·해소 조건·재검토일을
 * 적어 받아들인 항목만 통과하고, 목록에 없는 새 취약점이 나오면 실패한다. 재검토일이
 * 지난 항목도 실패한다. 위험을 영구히 숨기는 목록이 되지 않게 하기 위해서다.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const LEVELS = ['info', 'low', 'moderate', 'high', 'critical'];
const FAIL_AT = LEVELS.indexOf('high');

function auditJson() {
  try {
    // npm audit exits non-zero when it finds anything; the JSON is still on stdout.
    return JSON.parse(execFileSync('npm', ['audit', '--json'], { encoding: 'utf8', maxBuffer: 32e6 }));
  } catch (e) {
    if (e.stdout) return JSON.parse(e.stdout);
    throw e;
  }
}

const baseline = JSON.parse(readFileSync('docs/security-advisories.json', 'utf8'));
// one advisory can surface on every package in the chain that pulls it in, so an
// exception names all of them rather than being repeated per package.
const accepted = new Map(baseline.accepted.flatMap((a) => a.packages.map((p) => [p, a])));
const report = auditJson();
const found = Object.entries(report.vulnerabilities ?? {});

const today = new Date().toISOString().slice(0, 10);
const problems = [];

for (const [name, v] of found) {
  if (LEVELS.indexOf(v.severity) < FAIL_AT) continue;
  const entry = accepted.get(name);
  if (!entry) {
    problems.push(
      `새 취약점: ${name} (${v.severity}). 해소하거나, 사유·영향·해소 조건·재검토일과 함께 docs/security-advisories.json에 기록하라.`,
    );
    continue;
  }
  if (entry.reviewBy < today) {
    problems.push(
      `재검토일이 지난 예외: ${name} (재검토일 ${entry.reviewBy}). 다시 판단해 해소하거나 기한을 갱신하라.`,
    );
  }
}

const stale = baseline.accepted.filter((a) => !a.packages.some((p) => found.some(([name]) => name === p)));
for (const a of stale) {
  console.log(`알림: ${a.packages.join(', ')} 예외는 더 이상 필요하지 않다. 목록에서 지워도 된다.`);
}

if (problems.length > 0) {
  console.error('의존성 취약점 점검 실패\n');
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}

const acceptedCount = found.filter(
  ([n, v]) => LEVELS.indexOf(v.severity) >= FAIL_AT && accepted.has(n),
).length;
console.log(`의존성 취약점 점검 통과 — 기록된 예외 ${acceptedCount}건, 새 취약점 없음`);
