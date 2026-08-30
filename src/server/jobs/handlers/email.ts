import nodemailer, { type Transporter } from 'nodemailer';
import { getEnv } from '@/server/env';
import { logger } from '@/server/core/logger';

let transporter: Transporter | null = null;

function getTransport(): Transporter | null {
  const env = getEnv();
  if (!env.SMTP_HOST) return null;
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_PORT === 465,
      auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS ?? '' } : undefined,
    });
  }
  return transporter;
}

export interface EmailPayload {
  to: string;
  subject: string;
  text: string;
  html?: string;
  attachments?: { filename: string; contentBase64: string }[];
}

export async function sendEmail(payload: EmailPayload): Promise<void> {
  const transport = getTransport();
  if (!transport) {
    // Not configured (dev/test): log instead of failing forever so the outbox drains.
    logger.info({ to: payload.to, subject: payload.subject }, 'SMTP not configured; email logged only');
    return;
  }
  await transport.sendMail({
    from: getEnv().SMTP_FROM,
    to: payload.to,
    subject: payload.subject,
    text: payload.text,
    html: payload.html,
    attachments: payload.attachments?.map((a) => ({
      filename: a.filename,
      content: Buffer.from(a.contentBase64, 'base64'),
    })),
  });
}

/** Test hook so integration tests can force a delivery failure (B-09). */
export function __setTransportForTest(t: Transporter | null): void {
  transporter = t;
}
