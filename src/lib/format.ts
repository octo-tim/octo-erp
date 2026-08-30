import { formatKrw, formatQty, type Numeric } from './money';
import { formatKst } from './dates';

/** NFR-UX-01: shared display formatting for all screens and exports. */
/** Blank inputs are common (optional money fields), so every formatter tolerates them. */
const isBlank = (v: unknown): boolean =>
  v === null || v === undefined || (typeof v === 'string' && v.trim() === '');

export const fmt = {
  krw: (v: Numeric | null | undefined): string => (isBlank(v) ? '' : formatKrw(v as Numeric)),
  qty: (v: Numeric | null | undefined): string => (isBlank(v) ? '' : formatQty(v as Numeric)),
  date: (v: Date | string | null | undefined): string => {
    if (!v) return '';
    return typeof v === 'string' ? v.slice(0, 10) : formatKst(v, false);
  },
  dateTime: (v: Date | string | null | undefined): string => {
    if (!v) return '';
    return formatKst(typeof v === 'string' ? new Date(v) : v, true);
  },
  percent: (v: number | null | undefined, digits = 1): string =>
    v === null || v === undefined ? '' : `${(v * 100).toFixed(digits)}%`,
  count: (v: number | null | undefined): string =>
    v === null || v === undefined ? '' : v.toLocaleString('ko-KR'),
};

export const DOC_STATUS_LABEL: Record<string, string> = {
  DRAFT: '작성중',
  PENDING_APPROVAL: '결재중',
  CONFIRMED: '확정',
  CANCELED: '취소',
  APPROVED: '승인',
  REJECTED: '반려',
  WITHDRAWN: '회수',
  ON_HOLD: '보류',
  IN_PROGRESS: '진행중',
  REQUESTED: '요청',
  IN_TRANSIT: '이동중',
  COMPLETED: '완료',
};

/** NFR-UX-03: status is never conveyed by colour alone — a label always accompanies it. */
export const DOC_STATUS_TONE: Record<string, 'neutral' | 'info' | 'success' | 'warning' | 'danger'> = {
  DRAFT: 'neutral',
  PENDING_APPROVAL: 'warning',
  CONFIRMED: 'success',
  CANCELED: 'danger',
  APPROVED: 'success',
  REJECTED: 'danger',
  WITHDRAWN: 'neutral',
  ON_HOLD: 'warning',
  IN_PROGRESS: 'info',
  REQUESTED: 'info',
  IN_TRANSIT: 'info',
  COMPLETED: 'success',
};
