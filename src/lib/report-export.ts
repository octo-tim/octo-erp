/**
 * RPT-07 — one dataset behind the screen, the spreadsheet and the print view.
 *
 * The rows a report service returns are the rows that get exported. Nothing here queries
 * anything: it formats what the caller already has. That is the point — a second query for
 * the export is how a spreadsheet ends up disagreeing with the screen it was taken from,
 * usually by a row or two that changed in between.
 *
 * The output is CSV with a BOM rather than a real .xlsx, because Excel opens it directly,
 * it costs no dependency, and every value in this system is already a string of exact
 * digits. A number written as text is a number Excel will not silently reformat.
 */

export interface ExportColumn<R> {
  key: keyof R & string;
  header: string;
  /** right-aligned in the print view; also stops Excel treating a code as a number */
  numeric?: boolean;
}

const BOM = '﻿';

function cell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const s = String(value);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function toCsv<R extends Record<string, unknown>>(
  columns: ExportColumn<R>[],
  rows: R[],
  meta?: { title: string; period: string; notice: string },
): string {
  const lines: string[] = [];
  if (meta) {
    lines.push(cell(meta.title));
    lines.push(cell(`조회기간 ${meta.period}`));
    lines.push(cell(meta.notice));
    lines.push('');
  }
  lines.push(columns.map((c) => cell(c.header)).join(','));
  for (const row of rows) lines.push(columns.map((c) => cell(row[c.key])).join(','));
  return BOM + lines.join('\r\n');
}

/**
 * Every report and printout says so. A figure taken out of this system and shown to
 * someone else should carry its own provenance — it is management information, not a
 * filed statutory return.
 */
export const INTERNAL_NOTICE = '본 보고서는 사내 관리용이며 법정 신고자료가 아닙니다.';

export function fileNameFor(reportKey: string, period: string): string {
  const safe = reportKey.replace(/[^A-Za-z0-9_-]/g, '');
  return `${safe}_${period.replace(/[^0-9-]/g, '')}.csv`;
}
