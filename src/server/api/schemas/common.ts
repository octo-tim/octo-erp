import { z } from 'zod';

/** INT-01: money and quantity cross the API as precise strings, never numbers. */
export const decimalString = (opts?: { scale?: number; min?: string; allowNegative?: boolean }) =>
  z
    .string()
    .trim()
    .regex(/^-?\d+(\.\d+)?$/, '숫자 형식이 올바르지 않습니다.')
    .refine((v) => opts?.allowNegative !== false || !v.startsWith('-'), '음수는 입력할 수 없습니다.')
    .refine(
      (v) => {
        const scale = opts?.scale ?? 0;
        const frac = v.split('.')[1] ?? '';
        return frac.length <= scale;
      },
      `소수점 이하 ${opts?.scale ?? 0}자리까지 입력할 수 있습니다.`,
    );

export const amountString = decimalString({ scale: 0, allowNegative: false });
export const signedAmountString = decimalString({ scale: 0, allowNegative: true });
export const quantityString = decimalString({ scale: 3, allowNegative: false });
export const unitPriceString = decimalString({ scale: 4, allowNegative: false });

export const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '날짜는 YYYY-MM-DD 형식이어야 합니다.');
export const periodString = z.string().regex(/^\d{4}-\d{2}$/, '기간은 YYYY-MM 형식이어야 합니다.');

export const requestId = z.string().uuid('requestId는 UUID여야 합니다.');

export const idempotent = z.object({ requestId });

export const paging = z.object({
  page: z.number().int().min(1).default(1),
  pageSize: z.number().int().min(1).max(200).default(50),
  sortBy: z.string().optional(),
  sortDir: z.enum(['asc', 'desc']).default('desc'),
});
export type Paging = z.infer<typeof paging>;

export const listResult = <T extends z.ZodTypeAny>(row: T) =>
  z.object({ rows: z.array(row), total: z.number(), page: z.number(), pageSize: z.number() });

export const cuid = z.string().min(1);

export const searchText = z.string().trim().max(200).optional();

export function skipTake(p: Paging) {
  return { skip: (p.page - 1) * p.pageSize, take: p.pageSize };
}
