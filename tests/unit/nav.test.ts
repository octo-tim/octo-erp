// covers: BAS-01, NFR-UX-01
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { NAV } from '@/components/nav';

/**
 * `/master/categories`(품목분류)는 화면이 멀쩡히 존재했는데도 메뉴에 없어서, 운영에서는
 * 주소를 직접 치지 않는 한 등록할 방법이 없었다. 코드로는 아무 문제가 없으니 형식검사도
 * 통합시험도 이 결함을 잡지 못한다 — 잡히는 자리는 여기뿐이다.
 *
 * 그래서 규칙을 시험으로 고정한다. `(app)` 아래의 고정 경로 화면은 전부 메뉴에서
 * 닿을 수 있어야 하고, 예외로 두려면 아래 목록에 사유와 함께 적어야 한다.
 */
const APP_DIR = 'src/app/(app)';

/** 메뉴에 두지 않는 화면. 사유 없이 추가하면 이 목록은 결함을 숨기는 도구가 된다. */
const NOT_IN_MENU: Record<string, string> = {
  '/dev/components': '개발용 컴포넌트 카탈로그. 운영 사용자에게 노출할 화면이 아니다.',
  '/reports/drilldown': '보고서 화면에서 항목을 눌러 들어가는 상세. 단독 진입점이 없다.',
};

function staticRoutes(dir: string, prefix = ''): string[] {
  const found: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    // 라우트 그룹 `(app)`은 주소에 나타나지 않고, `[id]`는 상세 화면이라 메뉴 대상이 아니다
    if (entry.name.startsWith('[')) continue;
    const segment = entry.name.startsWith('(') ? '' : `/${entry.name}`;
    const child = path.join(dir, entry.name);
    if (fs.existsSync(path.join(child, 'page.tsx'))) found.push(`${prefix}${segment}`);
    found.push(...staticRoutes(child, `${prefix}${segment}`));
  }
  return found;
}

describe('메뉴에서 닿을 수 없는 화면은 없다', () => {
  const linked = new Set(NAV.flatMap((g) => g.items.map((i) => i.href)));
  const routes = staticRoutes(APP_DIR).filter((r) => r !== '');

  it('화면을 실제로 찾아냈다', () => {
    // 탐색이 조용히 빈 배열을 돌려주면 아래 시험이 전부 공허하게 통과한다
    expect(routes.length).toBeGreaterThan(40);
    expect(routes).toContain('/master/categories');
  });

  for (const route of staticRoutes(APP_DIR).filter((r) => r !== '')) {
    it(`${route} 는 메뉴에서 닿을 수 있다`, () => {
      if (NOT_IN_MENU[route]) return;
      expect(
        linked,
        `${route} 화면이 메뉴에 없다. 메뉴에 추가하거나 사유와 함께 NOT_IN_MENU에 적어라.`,
      ).toContain(route);
    });
  }

  it('메뉴 링크는 모두 실제 화면을 가리킨다', () => {
    const all = new Set(routes);
    for (const href of linked) {
      expect(all, `${href} 메뉴가 없는 화면을 가리킨다.`).toContain(href);
    }
  });

  it('사라진 화면의 예외가 목록에 남아 있지 않다', () => {
    for (const route of Object.keys(NOT_IN_MENU)) {
      expect(routes, `${route} 예외는 더 이상 필요하지 않다.`).toContain(route);
    }
  });
});
