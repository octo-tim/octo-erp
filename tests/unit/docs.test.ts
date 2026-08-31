// covers: NFR-OPS-06
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

/**
 * The schema, API and permission documents are generated from the source they describe, so
 * the only way they can be wrong is by being stale. That is exactly what `--check` detects,
 * and running it here rather than only in CI means a developer finds out from `npm run test`
 * instead of from a red build after pushing.
 *
 * A hand-written version of any of these would be wrong within a week and no test could tell.
 */
const GENERATORS = [
  { tool: 'tools/docs-api.mjs', doc: 'docs/api.md', label: 'API 명세' },
  { tool: 'tools/docs-schema.mjs', doc: 'docs/data-model.md', label: 'ERD·데이터사전' },
  { tool: 'tools/docs-permissions.mjs', doc: 'docs/permissions.md', label: '권한 매트릭스' },
];

describe('NFR-OPS-06: 생성 문서는 소스와 어긋날 수 없다', () => {
  for (const { tool, doc, label } of GENERATORS) {
    it(`${label}(${doc})가 현재 소스와 일치한다`, () => {
      expect(fs.existsSync(doc)).toBe(true);
      // --check exits non-zero when regenerating would change the file
      expect(() => execFileSync('node', [tool, '--check'], { stdio: 'pipe' })).not.toThrow();
    });
  }

  it('API 명세가 라우터를 실제로 담고 있다', () => {
    const api = fs.readFileSync('docs/api.md', 'utf8');
    // a generator that silently produced an empty document would pass --check against its
    // own empty output, so assert the content is really there
    for (const router of ['sales', 'accounting', 'hrm', 'approval', 'inventory', 'admin']) {
      expect(api).toContain(router);
    }
    expect(api.length).toBeGreaterThan(10_000);
  });
});
