'use client';

import { useCallback, useRef } from 'react';
import { cn } from '@/lib/cn';
import { fmt } from '@/lib/format';
import { add } from '@/lib/money';
import { Button } from './primitives';

/**
 * UIX-04: keyboard-first voucher line editor.
 * - Tab / Shift+Tab move across cells, Enter moves down the same column
 * - Enter on the last row appends a new line, so entry never needs the mouse
 * - Ctrl+D copies the current line, Ctrl+Delete removes it
 * Values are strings throughout (INT-01): no float ever touches an amount.
 */
export interface LineColumn<L> {
  key: keyof L & string;
  header: string;
  kind: 'text' | 'qty' | 'money' | 'unitPrice' | 'select' | 'readonly';
  width?: number;
  required?: boolean;
  options?: { value: string; label: string }[];
  /** Autocomplete source for master lookups (item, partner, account). */
  suggestions?: { value: string; label: string }[];
  total?: boolean;
}

export interface VoucherLineEditorProps<L extends Record<string, string>> {
  columns: LineColumn<L>[];
  lines: L[];
  onChange: (lines: L[]) => void;
  newLine: () => L;
  /** Server-authoritative recompute is still required; this is display only. */
  recompute?: (line: L) => L;
  errors?: Record<number, Partial<Record<keyof L & string, string>>>;
  disabled?: boolean;
  minLines?: number;
}

export function VoucherLineEditor<L extends Record<string, string>>({
  columns,
  lines,
  onChange,
  newLine,
  recompute,
  errors = {},
  disabled,
  minLines = 1,
}: VoucherLineEditorProps<L>) {
  const gridRef = useRef<HTMLTableSectionElement>(null);

  const focusCell = useCallback((row: number, colIndex: number) => {
    const el = gridRef.current?.querySelector<HTMLElement>(`[data-row="${row}"][data-col="${colIndex}"]`);
    el?.focus();
    if (el instanceof HTMLInputElement) el.select();
  }, []);

  const update = useCallback(
    (rowIndex: number, key: keyof L & string, value: string) => {
      const next = lines.map((l, i) => (i === rowIndex ? { ...l, [key]: value } : l));
      const line = next[rowIndex];
      if (recompute && line) next[rowIndex] = recompute(line);
      onChange(next);
    },
    [lines, onChange, recompute],
  );

  const addLine = useCallback(
    (afterIndex?: number) => {
      const line = newLine();
      const next = [...lines];
      next.splice(afterIndex === undefined ? next.length : afterIndex + 1, 0, line);
      onChange(next);
      return afterIndex === undefined ? next.length - 1 : afterIndex + 1;
    },
    [lines, newLine, onChange],
  );

  const copyLine = useCallback(
    (index: number) => {
      const source = lines[index];
      if (!source) return;
      const next = [...lines];
      next.splice(index + 1, 0, { ...source });
      onChange(next);
    },
    [lines, onChange],
  );

  const removeLine = useCallback(
    (index: number) => {
      if (lines.length <= minLines) {
        onChange(lines.map((l, i) => (i === index ? newLine() : l)));
        return;
      }
      onChange(lines.filter((_, i) => i !== index));
    },
    [lines, minLines, newLine, onChange],
  );

  function onKeyDown(e: React.KeyboardEvent, rowIndex: number, colIndex: number) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (rowIndex === lines.length - 1) {
        const created = addLine();
        requestAnimationFrame(() => focusCell(created, colIndex));
      } else {
        focusCell(rowIndex + 1, colIndex);
      }
      return;
    }
    if (e.key === 'Enter' && e.shiftKey) {
      e.preventDefault();
      focusCell(Math.max(0, rowIndex - 1), colIndex);
      return;
    }
    if (e.key === 'd' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      copyLine(rowIndex);
      return;
    }
    if (e.key === 'Delete' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      removeLine(rowIndex);
    }
  }

  const totals: Record<string, string> = {};
  for (const col of columns) {
    if (col.total) totals[col.key] = add(...lines.map((l) => l[col.key] || '0')).toString();
  }

  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
        <table className="w-full min-w-max border-collapse text-sm">
          <caption className="sr-only">
            전표 라인 편집기. Tab으로 좌우, Enter로 아래 이동, 마지막 행에서 Enter로 행 추가, Ctrl+D 행 복사,
            Ctrl+Delete 행 삭제.
          </caption>
          <thead className="bg-slate-50">
            <tr>
              <th scope="col" className="w-10 border-b border-slate-200 px-2 py-2 text-slate-500">
                #
              </th>
              {columns.map((col) => (
                <th
                  key={col.key}
                  scope="col"
                  style={col.width ? { width: col.width } : undefined}
                  className={cn(
                    'border-b border-slate-200 px-2 py-2 text-left font-semibold text-slate-700',
                    (col.kind === 'money' || col.kind === 'qty' || col.kind === 'unitPrice') && 'text-right',
                  )}
                >
                  {col.header}
                  {col.required ? <span className="ml-0.5 text-red-600">*</span> : null}
                </th>
              ))}
              <th scope="col" className="w-24 border-b border-slate-200 px-2 py-2">
                <span className="sr-only">행 작업</span>
              </th>
            </tr>
          </thead>
          <tbody ref={gridRef}>
            {lines.map((line, rowIndex) => (
              <tr key={rowIndex} className="border-b border-slate-100 last:border-0">
                <td className="px-2 py-1 text-center text-slate-400 tabular">{rowIndex + 1}</td>
                {columns.map((col, colIndex) => {
                  const error = errors[rowIndex]?.[col.key];
                  const listId = col.suggestions ? `dl-${col.key}-${rowIndex}` : undefined;
                  return (
                    <td key={col.key} className="px-1 py-1">
                      {col.kind === 'readonly' ? (
                        <span className="block px-1 text-right tabular">{fmt.krw(line[col.key] ?? '')}</span>
                      ) : col.kind === 'select' ? (
                        <select
                          data-row={rowIndex}
                          data-col={colIndex}
                          disabled={disabled}
                          value={line[col.key] ?? ''}
                          aria-label={`${rowIndex + 1}행 ${col.header}`}
                          aria-invalid={!!error}
                          onKeyDown={(e) => onKeyDown(e, rowIndex, colIndex)}
                          onChange={(e) => update(rowIndex, col.key, e.target.value)}
                          className={cn(
                            'h-8 w-full rounded border px-1 text-sm',
                            error ? 'border-red-500' : 'border-slate-300',
                          )}
                        >
                          <option value="">선택</option>
                          {col.options?.map((o) => (
                            <option key={o.value} value={o.value}>
                              {o.label}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <>
                          <input
                            data-row={rowIndex}
                            data-col={colIndex}
                            disabled={disabled}
                            list={listId}
                            inputMode={col.kind === 'text' ? 'text' : 'decimal'}
                            value={line[col.key] ?? ''}
                            aria-label={`${rowIndex + 1}행 ${col.header}`}
                            aria-invalid={!!error}
                            title={error}
                            onKeyDown={(e) => onKeyDown(e, rowIndex, colIndex)}
                            onChange={(e) => update(rowIndex, col.key, e.target.value)}
                            className={cn(
                              'h-8 w-full rounded border px-1.5 text-sm',
                              error ? 'border-red-500' : 'border-slate-300',
                              col.kind !== 'text' && 'tabular text-right',
                            )}
                          />
                          {/* The label is the option's value: picking a suggestion must
                              leave a readable name in the cell, never an internal id. The
                              caller maps the chosen label back to its id on submit, so
                              labels handed to `suggestions` have to be unique. */}
                          {col.suggestions ? (
                            <datalist id={listId}>
                              {col.suggestions.map((s) => (
                                <option key={s.value} value={s.label} />
                              ))}
                            </datalist>
                          ) : null}
                        </>
                      )}
                    </td>
                  );
                })}
                <td className="px-1 py-1">
                  <div className="flex gap-1">
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      disabled={disabled}
                      onClick={() => copyLine(rowIndex)}
                      title="행 복사 (Ctrl+D)"
                    >
                      복사
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      disabled={disabled}
                      onClick={() => removeLine(rowIndex)}
                      title="행 삭제 (Ctrl+Delete)"
                    >
                      삭제
                    </Button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
          {Object.keys(totals).length > 0 ? (
            <tfoot className="bg-slate-50 font-medium">
              <tr>
                <td className="px-2 py-2" />
                {columns.map((col, i) => (
                  <td
                    key={col.key}
                    className={cn(
                      'px-2 py-2',
                      (col.kind === 'money' || col.kind === 'qty' || col.kind === 'unitPrice') &&
                        'tabular text-right',
                    )}
                  >
                    {i === 0
                      ? '합계'
                      : totals[col.key]
                        ? col.kind === 'qty'
                          ? fmt.qty(totals[col.key]!)
                          : fmt.krw(totals[col.key]!)
                        : ''}
                  </td>
                ))}
                <td />
              </tr>
            </tfoot>
          ) : null}
        </table>
      </div>

      <div className="flex items-center justify-between">
        <p className="text-xs text-slate-500">
          Tab 좌우 이동 · Enter 아래 이동(마지막 행에서 행 추가) · Ctrl+D 행 복사 · Ctrl+Delete 행 삭제
        </p>
        <Button type="button" size="sm" disabled={disabled} onClick={() => addLine()}>
          행 추가
        </Button>
      </div>
    </div>
  );
}
