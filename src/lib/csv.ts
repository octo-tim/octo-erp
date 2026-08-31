/**
 * UIX-03: client-side CSV building for grids whose full filtered/sorted result set is
 * already resident in the browser (no server pagination) — for a server-paged grid a
 * client export can only ever contain the page on screen, which is the wrong answer for
 * a 10,000-row list, so those grids export through a server procedure instead
 * (see docs/engineering-rules.md NFR-PERF-01 and `src/components/ui/data-grid.tsx`).
 */

function escapeCsvCell(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** Money/quantity cells must be the exact decimal string — never a float. */
export function toCsv(headers: string[], rows: (string | number)[][]): string {
  return [headers, ...rows].map((row) => row.map((c) => escapeCsvCell(String(c))).join(',')).join('\r\n');
}

/** Triggers a browser download. Excel needs the UTF-8 BOM to read Korean text correctly. */
export function downloadCsv(csvBody: string, filename: string): void {
  const blob = new Blob([`﻿${csvBody}`], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/** Shape every `xxxCsv` tRPC query returns (src/server/core/list-export.ts). */
export interface ServerCsvExport {
  csv: string;
  total: number;
  rowCount: number;
  truncated: boolean;
}

/**
 * UIX-03: the one client-side mechanism every paginated grid's 엑셀 button shares. `refetch`
 * is a lazy (`enabled: false`) tRPC query's own `refetch`, so the request only happens on
 * click, with whatever filters the screen already applied. Downloads through `downloadCsv`
 * above (never a second Blob/anchor implementation). Returns a ready-to-show notice when the
 * server truncated the result (feed it to `<ExportNotice>`, src/components/ui/primitives.tsx)
 * so the screen warns the user instead of staying silent about a partial file, or `null` when
 * the export was complete.
 */
export async function runServerCsvExport(
  refetch: () => Promise<{ data?: ServerCsvExport | undefined }>,
  filename: string,
): Promise<string | null> {
  const result = await refetch();
  if (!result.data) return null;
  downloadCsv(result.data.csv, filename);
  if (!result.data.truncated) return null;
  return `전체 ${result.data.total.toLocaleString('ko-KR')}건 중 ${result.data.rowCount.toLocaleString('ko-KR')}건만 내려받았습니다. 조회조건을 좁혀 다시 시도하세요.`;
}
