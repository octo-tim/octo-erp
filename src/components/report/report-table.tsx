'use client';

import { Button } from '@/components/ui/primitives';
import { INTERNAL_NOTICE, fileNameFor, toCsv, type ExportColumn } from '@/lib/report-export';

/**
 * RPT-07 — the table every report renders, its spreadsheet, and its print view.
 *
 * The rows passed in are the rows exported and the rows printed. The export runs over the
 * same array the table just rendered rather than re-fetching, which is the only way the
 * three can be guaranteed to agree; a totals row is passed separately so the export carries
 * the same total the reader saw rather than one the spreadsheet recomputes.
 */

export interface ReportColumn<R> extends ExportColumn<R> {
  render?: (row: R) => React.ReactNode;
  /** highlights a row the reader is meant to act on, e.g. below safety stock */
  emphasise?: (row: R) => boolean;
}

export function ReportTable<R extends Record<string, unknown>>({
  reportKey,
  title,
  period,
  columns,
  rows,
  totals,
  emptyText = '조회 조건에 해당하는 자료가 없습니다.',
  onRowClick,
}: {
  reportKey: string;
  title: string;
  period: string;
  columns: ReportColumn<R>[];
  rows: R[];
  totals?: Partial<R> & { label?: string };
  emptyText?: string;
  onRowClick?: (row: R) => void;
}) {
  function exportCsv() {
    const body = totals ? [...rows, { ...(totals as R) }] : rows;
    const csv = toCsv(columns, body, { title, period, notice: INTERNAL_NOTICE });
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileNameFor(reportKey, period);
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <section className="flex min-w-0 flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2 print:hidden">
        <p className="text-sm text-slate-600">
          총 <strong className="tabular">{rows.length}</strong>건
        </p>
        <div className="flex items-center gap-1.5">
          <Button size="sm" onClick={exportCsv} disabled={rows.length === 0}>
            엑셀 내보내기
          </Button>
          <Button size="sm" onClick={() => window.print()}>
            인쇄
          </Button>
        </div>
      </div>

      {/* the print header carries what the screen shows in its chrome */}
      <div className="hidden print:block">
        <h2 className="text-base font-semibold">{title}</h2>
        <p className="text-xs text-slate-600">조회기간 {period}</p>
      </div>

      {rows.length === 0 ? (
        <p className="rounded-lg border border-dashed border-slate-300 px-4 py-8 text-center text-sm text-slate-500">
          {emptyText}
        </p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
          <table className="w-full min-w-max border-collapse text-sm">
            <caption className="sr-only">{title}</caption>
            <thead className="bg-slate-50">
              <tr>
                {columns.map((c) => (
                  <th
                    key={c.key}
                    scope="col"
                    className={`border-b border-slate-200 px-2 py-2 font-semibold text-slate-700 ${
                      c.numeric ? 'text-right' : 'text-left'
                    }`}
                  >
                    {c.header}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => (
                <tr
                  key={i}
                  className={`border-b border-slate-100 last:border-0 ${
                    onRowClick ? 'cursor-pointer hover:bg-slate-50' : ''
                  }`}
                  {...(onRowClick
                    ? {
                        onClick: () => onRowClick(row),
                        tabIndex: 0,
                        onKeyDown: (e: React.KeyboardEvent) => {
                          if (e.key === 'Enter') onRowClick(row);
                        },
                      }
                    : {})}
                >
                  {columns.map((c) => (
                    <td
                      key={c.key}
                      className={`px-2 py-1.5 ${c.numeric ? 'tabular text-right' : ''} ${
                        c.emphasise?.(row) ? 'font-semibold text-red-700' : ''
                      }`}
                    >
                      {c.render ? c.render(row) : String(row[c.key] ?? '')}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
            {totals ? (
              <tfoot className="bg-slate-50 font-medium">
                <tr>
                  {columns.map((c, i) => (
                    <td key={c.key} className={`px-2 py-2 ${c.numeric ? 'tabular text-right' : ''}`}>
                      {i === 0 ? (totals.label ?? '합계') : String(totals[c.key] ?? '')}
                    </td>
                  ))}
                </tr>
              </tfoot>
            ) : null}
          </table>
        </div>
      )}

      <p className="text-xs text-slate-500">{INTERNAL_NOTICE}</p>
    </section>
  );
}
