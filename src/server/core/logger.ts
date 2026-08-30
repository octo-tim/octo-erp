import pino from 'pino';

/** NFR-OPS-05: structured logs with sensitive paths redacted (docs/security-model.md §6). */
export const logger = pino({
  level: process.env['LOG_LEVEL'] ?? 'info',
  redact: {
    paths: [
      'req.headers.cookie',
      'req.headers.authorization',
      'headers.cookie',
      '*.password',
      '*.passwordHash',
      '*.token',
      '*.sessionId',
      '*.residentNo',
      '*.residentNoEnc',
      '*.bankAccount',
      '*.bankAccountEnc',
      'password',
      'passwordHash',
      'token',
      'residentNo',
      'bankAccount',
    ],
    censor: '[REDACTED]',
  },
  base: { app: 'octo-erp', env: process.env['APP_ENV'] ?? 'development' },
});

export const childLogger = (bindings: Record<string, unknown>) => logger.child(bindings);
