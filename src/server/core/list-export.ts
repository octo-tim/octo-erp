import { toCsv } from '@/lib/csv';

/**
 * UIX-03 — server-side CSV export for the standard grid.
 *
 * A client-side export can only ever hold the page the browser already fetched, which is
 * why the paginated list screens never got a client export (src/lib/csv.ts). This module is
 * the server-side counterpart: it calls the SAME `list` function the paginated grid calls,
 * with paging replaced by a hard cap, so the permission check and the division / warehouse /
 * HR scope filter baked into `list` apply to the export exactly as they do to the screen —
 * there is no second, hand-written query that could forget one.
 *
 * `EXPORT_ROW_LIMIT` is the one number every export shares. NFR-PERF-01 requires an ordinary
 * list query over 10,000 rows to finish within 2 seconds on the server, and an export runs
 * that identical query unpaginated, so it inherits that same, already-measured cost profile.
 * Doubling that proven-safe size gives comfortable headroom for a full year of ordinary
 * operational volume (the seeded performance run in docs/requirements-traceability.md sees
 * roughly 12,000 rows/year) while still turning an unfiltered, multi-year request into a
 * bounded, predictable amount of memory/CPU/response size instead of an unbounded one. When
 * the true row count exceeds the cap, `truncated` says so — the caller must surface that to
 * the user instead of handing out a silently incomplete file.
 */
export const EXPORT_ROW_LIMIT = 20_000;

export interface CsvExport {
  csv: string;
  /** how many rows the filters actually matched, independent of the cap */
  total: number;
  /** rows included in `csv` — equal to `total` unless `truncated` */
  rowCount: number;
  /** true when `total` exceeded EXPORT_ROW_LIMIT, so the screen can warn the user */
  truncated: boolean;
}

/**
 * Fetches up to EXPORT_ROW_LIMIT rows through `list` (skip 0, take the cap — never a second
 * query) and renders exactly those rows into CSV text via `toCsv` (src/lib/csv.ts), the same
 * builder the client-resident exports already use. `headers`/`toCells` are the only
 * per-screen part; the cap, the truncation flag and the CSV escaping are decided once, here.
 */
export async function buildCsvExport<Row>(
  list: (paging: { skip: number; take: number }) => Promise<{ rows: Row[]; total: number }>,
  headers: string[],
  toCells: (row: Row) => (string | number)[],
): Promise<CsvExport> {
  const { rows, total } = await list({ skip: 0, take: EXPORT_ROW_LIMIT });
  return {
    csv: toCsv(headers, rows.map(toCells)),
    total,
    rowCount: rows.length,
    truncated: total > EXPORT_ROW_LIMIT,
  };
}
