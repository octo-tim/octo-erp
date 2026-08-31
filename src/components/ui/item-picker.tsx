'use client';

import { useEffect, useMemo, useState } from 'react';
import { api } from '@/lib/trpc';
import { Input } from './primitives';
import { itemLabel, searchTermOf } from '@/lib/item-match';

/**
 * Choosing one item on a filter bar, from a master of any size.
 *
 * CR-14 fixed this for voucher lines but a dropdown was left behind here, and it broke the
 * same way the moment the item master passed the list's cap: the item existed, the operator
 * could see it on the 품목 screen, and it simply was not in the dropdown. A select element
 * cannot be right for a master that grows — the list has to follow what is typed, and the
 * server has to be the one that knows what matches.
 */
export function ItemPicker({
  id,
  value,
  onChange,
  placeholder = '품목명 또는 코드',
}: {
  id: string;
  /** the selected item id, or '' for none */
  value: string;
  onChange: (itemId: string) => void;
  placeholder?: string;
}) {
  /**
   * `null` means the operator has not typed yet, so the box shows whatever item is
   * currently selected — which is how an id arriving from a link or a restored filter gets
   * a readable name without an effect that writes state during render.
   */
  const [typed, setTyped] = useState<string | null>(null);
  const selected = api.master.item.useQuery({ id: value }, { enabled: !!value });
  const text = typed ?? (selected.data ? itemLabel(selected.data) : '');

  const suggestions = api.master.searchItems.useQuery({ q: searchTermOf(text), take: 20 });
  const options = useMemo(() => suggestions.data ?? [], [suggestions.data]);
  const listId = `${id}-options`;

  /**
   * What the typed text currently resolves to. An exact code, an exact name, or the full
   * "이름 (코드)" label picks the item; anything else resolves to nothing rather than
   * guessing, and the screen's empty state still asks for an item.
   */
  const resolved = useMemo(() => {
    const trimmed = text.trim();
    const term = searchTermOf(trimmed).toLowerCase();
    if (!term) return '';
    const hit = options.find(
      (o) => o.code.toLowerCase() === term || itemLabel(o) === trimmed || o.name === trimmed,
    );
    return hit?.id ?? '';
  }, [options, text]);

  /**
   * Resolution has to wait for the server, so it cannot happen in the keystroke handler
   * alone: someone who types a full item name and hits 조회 straight away would otherwise
   * search with no item selected, because the matching suggestion had not arrived yet.
   */
  useEffect(() => {
    if (typed !== null && resolved !== value) onChange(resolved);
  }, [resolved, typed, value, onChange]);

  return (
    <>
      <Input
        id={id}
        list={listId}
        value={text}
        placeholder={placeholder}
        onChange={(e) => setTyped(e.target.value)}
      />
      <datalist id={listId}>
        {options.map((o) => (
          <option key={o.id} value={itemLabel(o)} />
        ))}
      </datalist>
    </>
  );
}
