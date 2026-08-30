import 'dotenv/config';
import { beforeAll } from 'vitest';

/**
 * Integration tests run against a real PostgreSQL database (docs/engineering-rules.md §5).
 * Nothing is mocked: locking, constraints and triggers are what we are testing.
 */
const testUrl = process.env['DATABASE_URL_TEST'];
if (!testUrl) throw new Error('DATABASE_URL_TEST must be set for integration tests');
process.env['DATABASE_URL'] = testUrl;

beforeAll(() => {
  if (!process.env['SESSION_SECRET'])
    process.env['SESSION_SECRET'] = 'test-secret-value-least-32-bytes-long!!';
  if (!process.env['DATA_ENCRYPTION_KEY']) process.env['DATA_ENCRYPTION_KEY'] = '0'.repeat(64);
});
