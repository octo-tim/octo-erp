'use client';

import { cloneElement, isValidElement } from 'react';
import { cn } from '@/lib/cn';
import { DOC_STATUS_LABEL, DOC_STATUS_TONE } from '@/lib/format';

export function Button({
  variant = 'default',
  size = 'md',
  className,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'default' | 'primary' | 'danger' | 'ghost';
  size?: 'sm' | 'md';
}) {
  return (
    <button
      {...props}
      className={cn(
        'inline-flex items-center justify-center gap-1.5 rounded-md border font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50',
        size === 'sm' ? 'h-7 px-2 text-xs' : 'h-9 px-3 text-sm',
        variant === 'primary' && 'border-blue-600 bg-blue-600 text-white hover:bg-blue-700',
        variant === 'danger' && 'border-red-600 bg-red-600 text-white hover:bg-red-700',
        variant === 'ghost' && 'border-transparent bg-transparent hover:bg-slate-100',
        variant === 'default' && 'border-slate-300 bg-white hover:bg-slate-50',
        className,
      )}
    />
  );
}

export function Input({ className, ...props }: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className={cn(
        'h-9 w-full rounded-md border border-slate-300 bg-white px-2.5 text-sm',
        'placeholder:text-slate-400 disabled:bg-slate-50',
        props['aria-invalid'] && 'border-red-500',
        className,
      )}
    />
  );
}

export function Select({ className, ...props }: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      {...props}
      className={cn('h-9 w-full rounded-md border border-slate-300 bg-white px-2 text-sm', className)}
    />
  );
}

export function Field({
  label,
  htmlFor,
  required,
  error,
  hint,
  children,
  className,
}: {
  label: string;
  htmlFor?: string;
  required?: boolean;
  error?: string;
  hint?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-col gap-1', className)}>
      {/* The required marker is drawn by CSS (see globals.css), so the label's text is
          exactly the field name — screen readers and tests both read "제목", not "제목*".
          The control itself carries aria-required. */}
      <label
        htmlFor={htmlFor}
        data-required={required ? 'true' : undefined}
        className="text-sm font-medium text-slate-700"
      >
        {label}
      </label>
      {required && isValidElement(children)
        ? cloneElement(children as React.ReactElement<{ 'aria-required'?: boolean }>, {
            'aria-required': true,
          })
        : children}
      {error ? (
        <p className="text-xs text-red-600" role="alert">
          {error}
        </p>
      ) : hint ? (
        <p className="text-xs text-slate-500">{hint}</p>
      ) : null}
    </div>
  );
}

/** NFR-UX-03: a badge always carries a text label, never colour alone. */
export function StatusBadge({ status, label }: { status: string; label?: string }) {
  const tone = DOC_STATUS_TONE[status] ?? 'neutral';
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium',
        tone === 'success' && 'border-green-300 bg-green-50 text-green-800',
        tone === 'warning' && 'border-amber-300 bg-amber-50 text-amber-800',
        tone === 'danger' && 'border-red-300 bg-red-50 text-red-800',
        tone === 'info' && 'border-blue-300 bg-blue-50 text-blue-800',
        tone === 'neutral' && 'border-slate-300 bg-slate-50 text-slate-700',
      )}
    >
      {label ?? DOC_STATUS_LABEL[status] ?? status}
    </span>
  );
}

export function Card({
  title,
  actions,
  children,
  className,
}: {
  title?: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={cn('rounded-lg border border-slate-200 bg-white', className)}>
      {title || actions ? (
        <header className="flex items-center justify-between gap-2 border-b border-slate-200 px-4 py-2.5">
          {title ? <h2 className="text-sm font-semibold">{title}</h2> : <span />}
          {actions}
        </header>
      ) : null}
      <div className="p-4">{children}</div>
    </section>
  );
}

/** NFR-UX-02: empty states explain what to do next, not just "no data". */
export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-4 py-12 text-center">
      <p className="text-sm font-medium text-slate-700">{title}</p>
      {description ? <p className="max-w-md text-sm text-slate-500">{description}</p> : null}
      {action}
    </div>
  );
}

/**
 * UIX-03: the one banner every server-side grid export shares for the "capped" case — shown
 * when `src/lib/csv.ts`'s `runServerCsvExport` reports the server truncated the file, so the
 * user is told rather than handed a silently incomplete download.
 */
export function ExportNotice({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p
      role="status"
      className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800"
    >
      {message}
    </p>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div role="alert" className="flex flex-col items-center gap-3 px-4 py-10 text-center">
      <p className="text-sm text-red-700">{message}</p>
      {onRetry ? (
        <Button onClick={onRetry} size="sm">
          다시 시도
        </Button>
      ) : null}
    </div>
  );
}

export function Spinner({ label = '불러오는 중' }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 py-10 text-sm text-slate-500" role="status">
      <span
        className="size-4 animate-spin rounded-full border-2 border-slate-300 border-t-slate-600"
        aria-hidden
      />
      {label}
    </div>
  );
}
