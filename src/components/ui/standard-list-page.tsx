'use client';

import { useCallback, useState } from 'react';
import { api } from '@/lib/trpc';
import { Button } from './primitives';

/**
 * UIX-02: the shared list screen shape — search conditions above, grid below,
 * with per-user saved filters. Every module list uses this instead of a bespoke layout.
 */
export function StandardListPage({
  title,
  description,
  filterKey,
  filters,
  onSearch,
  onReset,
  actions,
  children,
}: {
  title: string;
  description?: string;
  /** Stable key used to persist the last-used search conditions per user. */
  filterKey: string;
  filters: React.ReactNode;
  onSearch: () => void;
  onReset?: () => void;
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h1 className="text-lg font-semibold">{title}</h1>
          {description ? <p className="mt-0.5 text-sm text-slate-500">{description}</p> : null}
        </div>
        <div className="flex items-center gap-1.5">{actions}</div>
      </header>

      <form
        className="rounded-lg border border-slate-200 bg-white p-4"
        onSubmit={(e) => {
          e.preventDefault();
          onSearch();
        }}
        aria-label={`${title} 조회조건`}
        data-filter-key={filterKey}
      >
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">{filters}</div>
        <div className="mt-3 flex items-center justify-end gap-1.5">
          {onReset ? (
            <Button type="button" size="sm" onClick={onReset}>
              초기화
            </Button>
          ) : null}
          <Button type="submit" size="sm" variant="primary">
            조회
          </Button>
        </div>
      </form>

      {children}
    </div>
  );
}

/**
 * Persists and restores a list screen's search conditions for the current user (UIX-02).
 * The saved preference is used until the user edits the form in this session, so no
 * effect is needed to copy server state into local state.
 */
export function useSavedFilters<T extends Record<string, unknown>>(filterKey: string, initial: T) {
  const [draft, setDraft] = useState<T | null>(null);
  const pref = api.preference.get.useQuery({ kind: 'SEARCH_FILTER', key: filterKey });
  const setPref = api.preference.set.useMutation();

  const filters = draft ?? { ...initial, ...((pref.data as T | null) ?? {}) };

  const save = useCallback(
    (next: T) => {
      setDraft(next);
      setPref.mutate({ kind: 'SEARCH_FILTER', key: filterKey, value: next });
    },
    [filterKey, setPref],
  );

  const reset = useCallback(() => save(initial), [save, initial]);

  return { filters, setFilters: setDraft, save, reset, restored: pref.data !== undefined };
}
