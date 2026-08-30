/**
 * INT-01: no superjson. Prisma Decimal and Date are serialized explicitly so that
 * precise numbers stay strings across the wire.
 */
import type { DataTransformer } from '@trpc/server/unstable-core-do-not-import';

function serialize(value: unknown): unknown {
  if (value === null || value === undefined) return value ?? null;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(serialize);
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown> & {
      toFixed?: (n?: number) => string;
      s?: unknown;
      e?: unknown;
      d?: unknown;
    };
    // Prisma/decimal.js Decimal instances
    if (typeof obj.toFixed === 'function' && 's' in obj && 'e' in obj && 'd' in obj) return obj.toString();
    if (value instanceof Set) return [...value];
    if (value instanceof Map) return Object.fromEntries(value);
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) out[k] = serialize(v);
    return out;
  }
  if (typeof value === 'bigint') return value.toString();
  return value;
}

const transformer: DataTransformer = {
  serialize,
  deserialize: (v: unknown) => v,
};

export default transformer;
