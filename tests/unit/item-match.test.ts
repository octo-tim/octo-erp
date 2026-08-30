import { describe, expect, it, vi } from 'vitest';
import {
  itemLabel,
  matchErrorText,
  matchItem,
  resolveItemLabels,
  searchTermOf,
  type ItemCandidate,
} from '@/lib/item-match';

const item = (id: string, code: string, name: string): ItemCandidate => ({ id, code, name });

describe('CR-14 품목 입력 해석', () => {
  it('자동완성에서 고른 "이름 (코드)"는 코드로 조회한다', () => {
    expect(searchTermOf('볼트 M6 (IT-000012)')).toBe('IT-000012');
  });

  it('직접 입력한 이름은 입력한 그대로 조회한다', () => {
    expect(searchTermOf('  볼트 M6  ')).toBe('볼트 M6');
  });

  it('코드가 정확히 일치하면 그 품목이다', () => {
    const c = [item('a', 'IT-000012', '볼트 M6'), item('b', 'IT-000120', '볼트 M6 장축')];
    expect(matchItem(c, 'IT-000012')).toEqual({ kind: 'OK', id: 'a' });
  });

  it('이름이 정확히 일치하면 부분일치 후보가 더 있어도 그 품목이다', () => {
    const c = [item('a', 'IT-000012', '볼트'), item('b', 'IT-000120', '볼트 장축')];
    expect(matchItem(c, '볼트')).toEqual({ kind: 'OK', id: 'a' });
  });

  it('부분일치가 한 건뿐이면 그 품목으로 인식한다', () => {
    const c = [item('a', 'IT-000012', '볼트 M6')];
    expect(matchItem(c, 'M6')).toEqual({ kind: 'OK', id: 'a' });
  });

  it('부분일치가 여러 건이면 거부하고 후보를 알려준다', () => {
    const c = [item('a', 'IT-1', '볼트 M6'), item('b', 'IT-2', '볼트 M8')];
    const m = matchItem(c, '볼트');
    expect(m.kind).toBe('AMBIGUOUS');
    expect(matchErrorText(1, m)).toContain('볼트 M6 (IT-1)');
  });

  it('없으면 없다고 말한다: 여러 건 일치와 구분된다', () => {
    const m = matchItem([], '없는품목');
    expect(m).toEqual({ kind: 'NOT_FOUND', typed: '없는품목' });
    expect(matchErrorText(2, m)).toContain('일치하는 품목이 없습니다');
    expect(matchErrorText(2, m)).not.toContain('여러 건');
  });

  it('빈 칸은 조회하지 않는다', () => {
    expect(matchItem([], '   ')).toEqual({ kind: 'NOT_FOUND', typed: '' });
  });

  /**
   * The defect this module exists for: the item is beyond whatever slice the browser
   * preloaded, so only a server lookup can find it.
   */
  it('마스터가 클라이언트 목록 상한을 넘어도 서버 조회로 찾아낸다', async () => {
    const master = Array.from({ length: 207 }, (_, i) =>
      item(`id${i}`, `IT-${String(i).padStart(6, '0')}`, `품목${i}`),
    );
    const search = vi.fn(async (term: string) =>
      master.filter((m) => m.code.includes(term) || m.name.includes(term)),
    );

    const [match] = await resolveItemLabels(['품목206 (IT-000206)'], search);
    expect(match).toEqual({ kind: 'OK', id: 'id206' });
    expect(search).toHaveBeenCalledWith('IT-000206');
  });

  it('같은 품목을 여러 줄에 적어도 조회는 한 번만 한다', async () => {
    const search = vi.fn(async () => [item('a', 'IT-1', '볼트')]);
    const matches = await resolveItemLabels(['볼트', '볼트', '볼트'], search);
    expect(matches.every((m) => m.kind === 'OK')).toBe(true);
    expect(search).toHaveBeenCalledTimes(1);
  });

  it('일부 줄만 틀리면 그 줄만 오류로 표시한다', async () => {
    const search = vi.fn(async (term: string) => (term === '볼트' ? [item('a', 'IT-1', '볼트')] : []));
    const matches = await resolveItemLabels(['볼트', '없는것'], search);
    expect(matches[0]!.kind).toBe('OK');
    expect(matches[1]!.kind).toBe('NOT_FOUND');
  });

  it('표시 라벨은 이름과 코드를 함께 보여준다', () => {
    expect(itemLabel({ name: '볼트', code: 'IT-1' })).toBe('볼트 (IT-1)');
  });
});
