'use client';

import { useCallback, useMemo, useState } from 'react';
import { api } from '@/lib/trpc';
import { cn } from '@/lib/cn';
import { Button } from './primitives';

/** UIX-01: widget visibility and order are saved per user. */
export interface Widget {
  id: string;
  title: string;
  /** column span on a 4-column desktop grid */
  span?: 1 | 2 | 3 | 4;
  render: () => React.ReactNode;
}

interface Layout {
  order: string[];
  hidden: string[];
}

export function DashboardGrid({ dashboardKey, widgets }: { dashboardKey: string; widgets: Widget[] }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Layout | null>(null);

  const pref = api.preference.get.useQuery({ kind: 'DASHBOARD', key: dashboardKey });
  const setPref = api.preference.set.useMutation();

  // Derived, not synced: a widget added in a later release still appears for users
  // whose saved layout predates it.
  const layout = useMemo<Layout>(() => {
    if (draft) return draft;
    const stored = pref.data as Layout | null;
    const known = (stored?.order ?? []).filter((id) => widgets.some((w) => w.id === id));
    const missing = widgets.map((w) => w.id).filter((id) => !known.includes(id));
    return { order: [...known, ...missing], hidden: stored?.hidden ?? [] };
  }, [draft, pref.data, widgets]);

  const save = useCallback(
    (next: Layout) => {
      setDraft(next);
      setPref.mutate({ kind: 'DASHBOARD', key: dashboardKey, value: next });
    },
    [dashboardKey, setPref],
  );

  /**
   * Each change saves as it is made, which is what makes the arrangement feel immediate.
   * But the button that ends editing says 배치 저장 완료, and a button that says that has to
   * mean it: leaving edit mode therefore waits for the layout to be stored, so a reload or
   * a navigation straight afterwards cannot outrun the write and lose the arrangement.
   */
  async function finishEditing() {
    await setPref.mutateAsync({ kind: 'DASHBOARD', key: dashboardKey, value: layout });
    setEditing(false);
  }

  function move(id: string, delta: number) {
    const order = [...layout.order];
    const i = order.indexOf(id);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= order.length) return;
    [order[i], order[j]] = [order[j]!, order[i]!];
    save({ ...layout, order });
  }

  function toggle(id: string) {
    save({
      ...layout,
      hidden: layout.hidden.includes(id) ? layout.hidden.filter((h) => h !== id) : [...layout.hidden, id],
    });
  }

  const ordered = layout.order.flatMap((id) => widgets.filter((w) => w.id === id));

  return (
    <div className="flex flex-col gap-3">
      <div className="flex justify-end">
        <Button
          size="sm"
          onClick={() => (editing ? void finishEditing() : setEditing(true))}
          aria-pressed={editing}
          disabled={editing && setPref.isPending}
        >
          {editing ? (setPref.isPending ? '저장 중' : '배치 저장 완료') : '위젯 배치'}
        </Button>
      </div>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
        {ordered.map((w) => {
          const hidden = layout.hidden.includes(w.id);
          if (hidden && !editing) return null;
          return (
            <section
              key={w.id}
              className={cn(
                'rounded-lg border border-slate-200 bg-white',
                hidden && 'opacity-50',
                w.span === 2 && 'md:col-span-2',
                w.span === 3 && 'xl:col-span-3',
                w.span === 4 && 'md:col-span-2 xl:col-span-4',
              )}
            >
              <header className="flex items-center justify-between border-b border-slate-200 px-3 py-2">
                <h2 className="text-sm font-semibold">{w.title}</h2>
                {editing ? (
                  <div className="flex gap-0.5">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => move(w.id, -1)}
                      aria-label={`${w.title} 앞으로`}
                    >
                      ←
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => move(w.id, 1)}
                      aria-label={`${w.title} 뒤로`}
                    >
                      →
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => toggle(w.id)}>
                      {hidden ? '표시' : '숨김'}
                    </Button>
                  </div>
                ) : null}
              </header>
              <div className="p-3">{w.render()}</div>
            </section>
          );
        })}
      </div>
    </div>
  );
}
