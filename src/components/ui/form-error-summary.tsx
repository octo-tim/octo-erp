'use client';

import { useEffect, useRef } from 'react';

/**
 * UIX-05: on a failed save, list every error at the top, link each to its field,
 * and move focus to the first one. Input values are never cleared by the caller.
 */
export interface FieldError {
  field: string;
  label: string;
  message: string;
}

export function FormErrorSummary({
  errors,
  title = '입력값을 확인하세요',
}: {
  errors: FieldError[];
  title?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (errors.length === 0) return;
    ref.current?.focus();
    ref.current?.scrollIntoView({ block: 'nearest' });
  }, [errors]);

  if (errors.length === 0) return null;

  return (
    <div
      ref={ref}
      tabIndex={-1}
      role="alert"
      aria-live="assertive"
      className="rounded-md border border-red-300 bg-red-50 p-3 outline-none"
    >
      <p className="text-sm font-semibold text-red-800">
        {title} ({errors.length}건)
      </p>
      <ul className="mt-1.5 list-disc space-y-0.5 pl-5 text-sm text-red-700">
        {errors.map((e) => (
          <li key={e.field}>
            <button
              type="button"
              className="underline"
              onClick={() => {
                const el =
                  document.getElementById(e.field) ??
                  document.querySelector<HTMLElement>(`[name="${e.field}"]`);
                el?.focus();
                el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
              }}
            >
              {e.label}: {e.message}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Maps a tRPC/zod error payload onto field errors without discarding the user's input. */
export function toFieldErrors(
  error: unknown,
  labels: Record<string, string>,
): { fieldErrors: FieldError[]; formMessage: string | null } {
  const shape = error as {
    message?: string;
    data?: { zodError?: { fieldErrors?: Record<string, string[]> }; appCode?: string };
  };
  const zod = shape?.data?.zodError?.fieldErrors;
  if (zod) {
    return {
      fieldErrors: Object.entries(zod).flatMap(([field, messages]) =>
        messages?.[0] ? [{ field, label: labels[field] ?? field, message: messages[0] }] : [],
      ),
      formMessage: null,
    };
  }
  return { fieldErrors: [], formMessage: shape?.message ?? '저장 중 오류가 발생했습니다.' };
}
