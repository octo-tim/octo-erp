/**
 * Turning what an operator typed in a voucher line into a master record id.
 *
 * This used to be done by scanning the autocomplete list the browser had already loaded.
 * That list is capped (it is a convenience, not the master), so once the item master grew
 * past the cap an item that plainly exists — and that the operator can see on the 품목
 * screen — could not be entered on a voucher at all: the form said "품목을 찾을 수 없거나
 * 여러 건이 일치합니다" and there was nothing the operator could do about it. Resolution
 * therefore has to ask the server, which searches the whole master, and the suggestion
 * list stays what it always was: a hint.
 *
 * The rule itself (CR-09) is unchanged: an exact code or name is the item; a partial that
 * matches exactly one item is that item; anything else is refused, and the refusal says
 * which of the two it was, because the operator's next move differs.
 */

export interface ItemCandidate {
  id: string;
  code: string;
  name: string;
}

export type ItemMatch =
  | { kind: 'OK'; id: string }
  | { kind: 'NOT_FOUND'; typed: string }
  | { kind: 'AMBIGUOUS'; typed: string; candidates: ItemCandidate[] };

/** What the suggestion list puts in the cell, and what a pick leaves behind. */
export function itemLabel(item: { name: string; code: string }): string {
  return `${item.name} (${item.code})`;
}

/**
 * A picked suggestion arrives as "품목명 (코드)". The code is the reliable half, so it is
 * what gets searched; free text is searched as typed.
 */
export function searchTermOf(typed: string): string {
  const m = typed.trim().match(/^(.*)\s\(([^()]+)\)$/);
  return (m?.[2] ?? typed).trim();
}

/** Applies the match rule to whatever the server returned for `searchTermOf(typed)`. */
export function matchItem(candidates: ItemCandidate[], typed: string): ItemMatch {
  const text = typed.trim();
  if (!text) return { kind: 'NOT_FOUND', typed: text };

  const term = searchTermOf(text);
  const lower = term.toLowerCase();

  const exact = candidates.filter(
    (c) => c.code.toLowerCase() === lower || c.name.toLowerCase() === lower || itemLabel(c) === text,
  );
  if (exact.length === 1) return { kind: 'OK', id: exact[0]!.id };
  if (exact.length > 1) return { kind: 'AMBIGUOUS', typed: text, candidates: exact };

  if (candidates.length === 0) return { kind: 'NOT_FOUND', typed: text };
  if (candidates.length === 1) return { kind: 'OK', id: candidates[0]!.id };
  return { kind: 'AMBIGUOUS', typed: text, candidates };
}

/**
 * Resolves several typed labels at once. `search` is the server lookup; identical labels
 * are looked up once. `take` on the caller's side only has to be big enough to prove
 * ambiguity, so a handful of rows costs a handful of small queries.
 */
export async function resolveItemLabels(
  labels: string[],
  search: (term: string) => Promise<ItemCandidate[]>,
): Promise<ItemMatch[]> {
  const terms = [...new Set(labels.map((l) => searchTermOf(l)).filter((t) => t.length > 0))];
  const found = new Map<string, ItemCandidate[]>();
  await Promise.all(
    terms.map(async (t) => {
      found.set(t, await search(t));
    }),
  );
  return labels.map((l) => matchItem(found.get(searchTermOf(l)) ?? [], l));
}

/** The message an operator can act on: it says which failure it was. */
export function matchErrorText(row: number, match: ItemMatch): string | null {
  if (match.kind === 'OK') return null;
  if (match.kind === 'NOT_FOUND') {
    return `${row}행: '${match.typed}'와 일치하는 품목이 없습니다. 품목을 먼저 등록하세요.`;
  }
  const names = match.candidates
    .slice(0, 3)
    .map((c) => itemLabel(c))
    .join(', ');
  const more = match.candidates.length > 3 ? ` 외 ${match.candidates.length - 3}건` : '';
  return `${row}행: '${match.typed}'에 여러 품목이 일치합니다: ${names}${more}. 목록에서 선택하세요.`;
}
