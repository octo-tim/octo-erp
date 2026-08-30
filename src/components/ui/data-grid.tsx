'use client';

import { useCallback, useMemo, useState } from 'react';
import { cn } from '@/lib/cn';
import { fmt } from '@/lib/format';
import { add } from '@/lib/money';
import { api } from '@/lib/trpc';
import { Button, EmptyState, ErrorState, Spinner } from './primitives';

/**
 * UIX-03: server-paged grid with sorting, multi-select, totals and Excel export.
 * NFR-PERF-01: rows are never sent whole — the caller supplies one page at a time.
 */
export interface Column<T> {
  key: string;
  header: string;
  /** money/qty right-align and use tabular numerals; money columns can be summed. */
  type?: 'text' | 'money' | 'qty' | 'date' | 'dateTime' | 'count' | 'node';
  width?: number;
  sortable?: boolean;
  total?: boolean;
  render?: (row: T) => React.ReactNode;
  value?: (row: T) => string | number | null | undefined;
}

export interface DataGridProps<T> {
  /** Stable id used to persist column layout per user (UIX-02). */
  gridKey: string;
  columns: Column<T>[];
  rows: T[];
  total: number;
  page: number;
  pageSize: number;
  loading?: boolean;
  error?: string | null;
  rowId: (row: T) => string;
  onPageChange: (page: number) => void;
  onPageSizeChange?: (size: number) => void;
  onSortChange?: (sortBy: string, sortDir: 'asc' | 'desc') => void;
  sortBy?: string;
  sortDir?: 'asc' | 'desc';
  selectable?: boolean;
  selected?: string[];
  onSelectedChange?: (ids: string[]) => void;
  onRowOpen?: (row: T) => void;
  emptyTitle?: string;
  emptyDescription?: string;
  onExport?: () => void;
  onRetry?: () => void;
}

const PAGE_SIZES = [25, 50, 100, 200];

function cellValue<T>(col: Column<T>, row: T): string | number | null | undefined {
  if (col.value) return col.value(row);
  return (row as Record<string, unknown>)[col.key] as string | number | null | undefined;
}

function renderCell<T>(col: Column<T>, row: T): React.ReactNode {
  if (col.render) return col.render(row);
  const v = cellValue(col, row);
  switch (col.type) {
    case 'money':
      return fmt.krw(v as string);
    case 'qty':
      return fmt.qty(v as string);
    case 'date':
      return fmt.date(v as string);
    case 'dateTime':
      return fmt.dateTime(v as string);
    case 'count':
      return fmt.count(v as number);
    default:
      return v ?? '';
  }
}

const alignRight = (t?: Column<unknown>['type']) => t === 'money' || t === 'qty' || t === 'count';

export function DataGrid<T>({
  gridKey,
  columns,
  rows,
  total,
  page,
  pageSize,
  loading,
  error,
  rowId,
  onPageChange,
  onPageSizeChange,
  onSortChange,
  sortBy,
  sortDir = 'desc',
  selectable,
  selected = [],
  onSelectedChange,
  onRowOpen,
  emptyTitle = '조회된 자료가 없습니다.',
  emptyDescription = '조회조건을 바꾸거나 기간을 넓혀 다시 조회하세요.',
  onExport,
  onRetry,
}: DataGridProps<T>) {
  const [showColumnPicker, setShowColumnPicker] = useState(false);
  // UIX-02: per-user column visibility. The saved preference is the source of truth until
  // the user changes it in this session; deriving avoids a setState-in-effect round trip.
  const [override, setOverride] = useState<string[] | null>(null);
  const pref = api.preference.get.useQuery({ kind: 'GRID_COLUMNS', key: gridKey });
  const setPref = api.preference.set.useMutation();
  const stored = (pref.data as { hidden?: string[] } | null)?.hidden;
  const hidden = useMemo(() => override ?? stored ?? [], [override, stored]);

  const toggleColumn = useCallback(
    (key: string) => {
      const next = hidden.includes(key) ? hidden.filter((k) => k !== key) : [...hidden, key];
      setOverride(next);
      setPref.mutate({ kind: 'GRID_COLUMNS', key: gridKey, value: { hidden: next } });
    },
    [gridKey, hidden, setPref],
  );

  const visible = useMemo(() => columns.filter((c) => !hidden.includes(c.key)), [columns, hidden]);
  const totals = useMemo(() => {
    const out: Record<string, string> = {};
    for (const col of visible) {
      if (!col.total) continue;
      out[col.key] = add(...rows.map((r) => String(cellValue(col, r) ?? '0'))).toString();
    }
    return out;
  }, [visible, rows]);

  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const allSelected = rows.length > 0 && rows.every((r) => selected.includes(rowId(r)));

  function toggleAll() {
    if (!onSelectedChange) return;
    const ids = rows.map(rowId);
    onSelectedChange(
      allSelected ? selected.filter((id) => !ids.includes(id)) : [...new Set([...selected, ...ids])],
    );
  }

  function toggleOne(id: string) {
    if (!onSelectedChange) return;
    onSelectedChange(selected.includes(id) ? selected.filter((s) => s !== id) : [...selected, id]);
  }

  function headerClick(col: Column<T>) {
    if (!col.sortable || !onSortChange) return;
    onSortChange(col.key, sortBy === col.key && sortDir === 'desc' ? 'asc' : 'desc');
  }

  if (error) return <ErrorState message={error} {...(onRetry ? { onRetry } : {})} />;

  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-slate-600">
          총 <strong className="tabular">{fmt.count(total)}</strong>건
          {selected.length > 0 ? (
            <span className="ml-2 text-blue-700">{fmt.count(selected.length)}건 선택</span>
          ) : null}
        </p>
        <div className="flex items-center gap-1.5">
          <Button size="sm" onClick={() => setShowColumnPicker((v) => !v)} aria-expanded={showColumnPicker}>
            컬럼 설정
          </Button>
          {onExport ? (
            <Button size="sm" onClick={onExport}>
              엑셀 내보내기
            </Button>
          ) : null}
        </div>
      </div>

      {showColumnPicker ? (
        <fieldset className="flex flex-wrap gap-3 rounded-md border border-slate-200 bg-slate-50 p-3">
          <legend className="px-1 text-xs font-medium text-slate-600">표시할 컬럼</legend>
          {columns.map((c) => (
            <label key={c.key} className="flex items-center gap-1.5 text-sm">
              <input type="checkbox" checked={!hidden.includes(c.key)} onChange={() => toggleColumn(c.key)} />
              {c.header}
            </label>
          ))}
        </fieldset>
      ) : null}

      <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
        <table className="w-full min-w-max border-collapse text-sm">
          <thead className="bg-slate-50">
            <tr>
              {selectable ? (
                <th scope="col" className="w-10 border-b border-slate-200 px-2 py-2">
                  <input type="checkbox" checked={allSelected} onChange={toggleAll} aria-label="전체 선택" />
                </th>
              ) : null}
              {visible.map((col) => (
                <th
                  key={col.key}
                  scope="col"
                  style={col.width ? { width: col.width } : undefined}
                  className={cn(
                    'border-b border-slate-200 px-3 py-2 text-left font-semibold text-slate-700',
                    alignRight(col.type) && 'text-right',
                  )}
                  aria-sort={
                    sortBy === col.key ? (sortDir === 'asc' ? 'ascending' : 'descending') : undefined
                  }
                >
                  {col.sortable && onSortChange ? (
                    <button
                      type="button"
                      onClick={() => headerClick(col)}
                      className="inline-flex items-center gap-1 hover:underline"
                    >
                      {col.header}
                      <span aria-hidden className="text-slate-400">
                        {sortBy === col.key ? (sortDir === 'asc' ? '▲' : '▼') : '↕'}
                      </span>
                    </button>
                  ) : (
                    col.header
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={visible.length + (selectable ? 1 : 0)}>
                  <Spinner />
                </td>
              </tr>
            ) : rows.length === 0 ? (
              <tr>
                <td colSpan={visible.length + (selectable ? 1 : 0)}>
                  <EmptyState title={emptyTitle} description={emptyDescription} />
                </td>
              </tr>
            ) : (
              rows.map((row) => {
                const id = rowId(row);
                return (
                  <tr
                    key={id}
                    className={cn(
                      'border-b border-slate-100 last:border-0 hover:bg-slate-50',
                      selected.includes(id) && 'bg-blue-50',
                    )}
                  >
                    {selectable ? (
                      <td className="px-2 py-1.5">
                        <input
                          type="checkbox"
                          checked={selected.includes(id)}
                          onChange={() => toggleOne(id)}
                          aria-label={`${id} 선택`}
                        />
                      </td>
                    ) : null}
                    {visible.map((col, idx) => (
                      <td
                        key={col.key}
                        className={cn('px-3 py-1.5', alignRight(col.type) && 'tabular text-right')}
                      >
                        {idx === 0 && onRowOpen ? (
                          <button
                            type="button"
                            onClick={() => onRowOpen(row)}
                            className="text-blue-700 hover:underline"
                          >
                            {renderCell(col, row)}
                          </button>
                        ) : (
                          renderCell(col, row)
                        )}
                      </td>
                    ))}
                  </tr>
                );
              })
            )}
          </tbody>
          {Object.keys(totals).length > 0 && rows.length > 0 ? (
            <tfoot className="bg-slate-50 font-medium">
              <tr>
                {selectable ? <td className="px-2 py-2" /> : null}
                {visible.map((col, i) => (
                  <td key={col.key} className={cn('px-3 py-2', alignRight(col.type) && 'tabular text-right')}>
                    {i === 0
                      ? '합계 (현재 페이지)'
                      : totals[col.key]
                        ? col.type === 'qty'
                          ? fmt.qty(totals[col.key]!)
                          : fmt.krw(totals[col.key]!)
                        : ''}
                  </td>
                ))}
              </tr>
            </tfoot>
          ) : null}
        </table>
      </div>

      <nav className="flex flex-wrap items-center justify-between gap-2" aria-label="페이지 이동">
        <div className="flex items-center gap-1.5">
          <Button size="sm" disabled={page <= 1} onClick={() => onPageChange(1)} aria-label="첫 페이지">
            «
          </Button>
          <Button
            size="sm"
            disabled={page <= 1}
            onClick={() => onPageChange(page - 1)}
            aria-label="이전 페이지"
          >
            이전
          </Button>
          <span className="px-2 text-sm tabular">
            {page} / {pageCount}
          </span>
          <Button
            size="sm"
            disabled={page >= pageCount}
            onClick={() => onPageChange(page + 1)}
            aria-label="다음 페이지"
          >
            다음
          </Button>
          <Button
            size="sm"
            disabled={page >= pageCount}
            onClick={() => onPageChange(pageCount)}
            aria-label="마지막 페이지"
          >
            »
          </Button>
        </div>
        {onPageSizeChange ? (
          <label className="flex items-center gap-1.5 text-sm">
            페이지당
            <select
              className="h-8 rounded-md border border-slate-300 px-1.5 text-sm"
              value={pageSize}
              onChange={(e) => onPageSizeChange(Number(e.target.value))}
            >
              {PAGE_SIZES.map((s) => (
                <option key={s} value={s}>
                  {s}건
                </option>
              ))}
            </select>
          </label>
        ) : null}
      </nav>
    </div>
  );
}
