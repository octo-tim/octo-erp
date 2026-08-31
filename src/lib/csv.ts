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
