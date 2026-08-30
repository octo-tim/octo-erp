'use client';

import { createTRPCReact } from '@trpc/react-query';
import type { AppRouter } from '@/server/api/root';

export const api = createTRPCReact<AppRouter>();

/** INT-05: every mutation with side effects carries a client-generated requestId. */
export const newRequestId = (): string => crypto.randomUUID();
