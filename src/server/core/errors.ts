export const ErrorCodes = {
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  FORBIDDEN: 'FORBIDDEN',
  OUT_OF_SCOPE: 'OUT_OF_SCOPE',
  NOT_FOUND: 'NOT_FOUND',
  VALIDATION: 'VALIDATION',
  CONFLICT: 'CONFLICT',
  VERSION_CONFLICT: 'VERSION_CONFLICT',
  REQUEST_IN_PROGRESS: 'REQUEST_IN_PROGRESS',
  DUPLICATE_EFFECT: 'DUPLICATE_EFFECT',
  INVALID_TRANSITION: 'INVALID_TRANSITION',
  IMMUTABLE: 'IMMUTABLE',
  PERIOD_CLOSED: 'PERIOD_CLOSED',
  INSUFFICIENT_STOCK: 'INSUFFICIENT_STOCK',
  CREDIT_LIMIT_EXCEEDED: 'CREDIT_LIMIT_EXCEEDED',
  APPROVAL_REQUIRED: 'APPROVAL_REQUIRED',
  CANCEL_BLOCKED: 'CANCEL_BLOCKED',
  OVER_ALLOCATION: 'OVER_ALLOCATION',
  MASTER_IN_USE: 'MASTER_IN_USE',
  UNBALANCED_JOURNAL: 'UNBALANCED_JOURNAL',
  POLICY_MISSING: 'POLICY_MISSING',
  ACCOUNT_LOCKED: 'ACCOUNT_LOCKED',
  RATE_LIMITED: 'RATE_LIMITED',
  INTERNAL: 'INTERNAL',
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly meta?: Record<string, unknown>;

  constructor(code: ErrorCode, message: string, meta?: Record<string, unknown>) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.meta = meta;
  }
}

export const appError = (code: ErrorCode, message: string, meta?: Record<string, unknown>) =>
  new AppError(code, message, meta);

export function isAppError(e: unknown): e is AppError {
  return e instanceof AppError;
}

/** Map an AppError code to an HTTP status (used by the tRPC error formatter and route handlers). */
export function httpStatusFor(code: ErrorCode): number {
  switch (code) {
    case 'UNAUTHENTICATED':
      return 401;
    case 'FORBIDDEN':
    case 'OUT_OF_SCOPE':
      return 403;
    case 'NOT_FOUND':
      return 404;
    case 'VALIDATION':
      return 400;
    case 'RATE_LIMITED':
      return 429;
    case 'INTERNAL':
      return 500;
    default:
      return 409;
  }
}
