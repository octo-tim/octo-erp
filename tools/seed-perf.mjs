#!/usr/bin/env node
/**
 * A year of realistic data, for measuring NFR-PERF-01/02/03 against something that looks
 * like the company rather than against an empty table.
 *
 * The distribution matters more than the volume. Real sales are not uniform: a few partners
 * and a few items carry most of the value, most documents have two or three lines and a few
 * have twenty, and volume rises towards month end. A uniform dataset makes every index look
 * good and hides exactly the queries that will be slow in production, so this leans the data
 * the way the real thing leans.
 *
 * It writes with raw SQL rather than through the services on purpose: this is a fixture for
 * measuring queries, not a test of the write path, and going through confirmation for
 * 12,000 documents would take longer than the measurement it supports. The rows it writes
 * are shaped exactly as the services write them, including the journal lines, so the
 * reports and ledgers see the data they would really see.
 *
 * Usage: node tools/seed-perf.mjs [--months 12] [--per-day 40] [--url <postgres-url>]
 */
import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : fallback;
};

const MONTHS = Number(arg('months', 12));
const PER_DAY = Number(arg('per-day', 40));
const URL = arg('url', process.env.DATABASE_URL_TEST ?? process.env.DATABASE_URL);

if (!URL) {
  console.error('no database url: pass --url or set DATABASE_URL');
  process.exit(1);
}

/** Deterministic pseudo-random, so a slow query can be reproduced exactly. */
let seed = 20260830;
function rnd() {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
}
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];

/** Most weight on the first few entries: the Pareto shape real trade data has. */
function skewed(arr) {
  const r = rnd();
  const idx = Math.floor(arr.length * r * r * r);
  return arr[Math.min(idx, arr.length - 1)];
}

const cuid = () => `c${randomUUID().replace(/-/g, '').slice(0, 24)}`;

const client = new pg.Client({ connectionString: URL });
await client.connect();

async function one(sql, params = []) {
  const { rows } = await client.query(sql, params);
  return rows[0];
}
async function all(sql, params = []) {
  const { rows } = await client.query(sql, params);
  return rows;
}

console.log(`seeding ${MONTHS} months at ~${PER_DAY} documents/day`);
const started = Date.now();

/**
 * Re-running has to be safe, including after a run that died halfway. Everything this
 * script writes is prefixed, so it can be removed without touching anything real.
 *
 * The inventory ledger is append-only and a database trigger enforces that (INT-04), which
 * is exactly right and must stay that way. Removing fixture rows therefore means switching
 * the session to replica mode for the duration of one transaction, which is the documented
 * way to run maintenance that the row triggers would otherwise refuse. This is acceptable
 * HERE, in a throwaway measurement fixture against a test database, and nowhere else: no
 * application code may do this, which is why it lives in a tool and refuses to touch a
 * database that does not look like a test one.
 */
if (process.argv.includes('--reset')) {
  const isTestDb = /test/i.test(URL);
  if (!isTestDb && !process.argv.includes('--force')) {
    console.error(
      'refusing to reset a database that does not look like a test database; pass --force if you are sure',
    );
    process.exit(1);
  }
  await client.query('BEGIN');
  await client.query(`SET LOCAL session_replication_role = 'replica'`);
  await client.query(
    `DELETE FROM "JournalLine" WHERE "entryId" IN (SELECT id FROM "JournalEntry" WHERE "entryNo" LIKE 'PJV-%')`,
  );
  await client.query(`DELETE FROM "JournalEntry" WHERE "entryNo" LIKE 'PJV-%'`);
  await client.query(
    `DELETE FROM "InventoryLedger" WHERE "sourceId" IN (SELECT id FROM "SalesDocument" WHERE "docNo" LIKE 'PSA-%')`,
  );
  await client.query(
    `DELETE FROM "SalesDocumentLine" WHERE "documentId" IN (SELECT id FROM "SalesDocument" WHERE "docNo" LIKE 'PSA-%')`,
  );
  await client.query(`DELETE FROM "SalesDocument" WHERE "docNo" LIKE 'PSA-%'`);
  await client.query('COMMIT');
  console.log('  cleared previous performance data');
}

// ── reference data ──
const warehouses = await all(`SELECT id FROM "Warehouse" WHERE "isActive" = true ORDER BY code`);
const division = await one(`SELECT id FROM "Division" ORDER BY code LIMIT 1`);
if (warehouses.length === 0) {
  console.error('no warehouses: run the seed first');
  process.exit(1);
}

const ITEM_COUNT = 500;
const CUSTOMER_COUNT = 120;
const SUPPLIER_COUNT = 40;

async function ensureItems() {
  const existing = await all(`SELECT id FROM "Item" WHERE code LIKE 'PERF-%' ORDER BY code`);
  if (existing.length >= ITEM_COUNT) return existing.map((r) => r.id);

  const values = [];
  const params = [];
  for (let i = existing.length; i < ITEM_COUNT; i++) {
    const id = cuid();
    const base = 1000 + Math.floor(rnd() * 90000);
    const p = params.length;
    params.push(id, `PERF-${String(i).padStart(5, '0')}`, `성능시험품목${i}`, String(base));
    values.push(`($${p + 1}, $${p + 2}, $${p + 3}, 'EA', $${p + 4}::decimal, NOW(), NOW())`);
  }
  await client.query(
    `INSERT INTO "Item" ("id","code","name","unitCode","salesPrice","createdAt","updatedAt")
     VALUES ${values.join(',')}`,
    params,
  );
  return (await all(`SELECT id FROM "Item" WHERE code LIKE 'PERF-%' ORDER BY code`)).map((r) => r.id);
}

async function ensurePartners(prefix, type, count) {
  const existing = await all(`SELECT id FROM "Partner" WHERE code LIKE $1 ORDER BY code`, [`${prefix}-%`]);
  if (existing.length >= count) return existing.map((r) => r.id);

  const values = [];
  const params = [];
  for (let i = existing.length; i < count; i++) {
    const p = params.length;
    params.push(
      cuid(),
      `${prefix}-${String(i).padStart(4, '0')}`,
      `${type === 'CUSTOMER' ? '성능고객' : '성능공급'}${i}`,
      type,
    );
    values.push(`($${p + 1}, $${p + 2}, $${p + 3}, $${p + 4}, NOW(), NOW())`);
  }
  await client.query(
    `INSERT INTO "Partner" ("id","code","name","partnerType","createdAt","updatedAt")
     VALUES ${values.join(',')}`,
    params,
  );
  return (await all(`SELECT id FROM "Partner" WHERE code LIKE $1 ORDER BY code`, [`${prefix}-%`])).map(
    (r) => r.id,
  );
}

const itemIds = await ensureItems();
const customerIds = await ensurePartners('PERFC', 'CUSTOMER', CUSTOMER_COUNT);
const supplierIds = await ensurePartners('PERFS', 'SUPPLIER', SUPPLIER_COUNT);
console.log(`  ${itemIds.length} items, ${customerIds.length} customers, ${supplierIds.length} suppliers`);

// accounts for the journal rows, so reports that read the journal see real lines
const accounts = Object.fromEntries(
  (await all(`SELECT code, id FROM "Account" WHERE code IN ('110','401','220','501','150','210','120')`)).map(
    (r) => [r.code, r.id],
  ),
);

const end = new Date();
const start = new Date(end.getTime());
start.setUTCMonth(start.getUTCMonth() - MONTHS);

/**
 * A journal entry belongs to an accounting period, so the months being seeded have to
 * exist and stay open. They are left OPEN: this fixture is for measuring queries, and a
 * closed month would refuse the very rows the measurement needs.
 */
const periodIds = new Map();
// walk from the first of the month: stepping a month from the 31st skips the months that
// have no 31st, and the days in those months would then have no period to belong to
const monthCursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
const lastMonth = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), 1));
for (let d = monthCursor; d <= lastMonth; d.setUTCMonth(d.getUTCMonth() + 1)) {
  const key = d.toISOString().slice(0, 7);
  const existing = await one(`SELECT id FROM "AccountingPeriod" WHERE "periodKey" = $1`, [key]);
  if (existing) {
    periodIds.set(key, existing.id);
    continue;
  }
  const id = cuid();
  await client.query(
    `INSERT INTO "AccountingPeriod" ("id","periodKey","status","createdAt") VALUES ($1,$2,'OPEN',NOW())`,
    [id, key],
  );
  periodIds.set(key, id);
}

/** Volume rises towards month end, the way invoicing really does. */
function documentsFor(date) {
  const dow = date.getUTCDay();
  if (dow === 0 || dow === 6) return Math.round(PER_DAY * 0.2);
  const dom = date.getUTCDate();
  const monthEndLift = dom >= 25 ? 1.6 : 1;
  return Math.round(PER_DAY * monthEndLift * (0.7 + rnd() * 0.6));
}

let docs = 0;
let lines = 0;
let ledgerRows = 0;
let journals = 0;

// one big batch per day keeps this to a few thousand statements rather than a million
for (let d = new Date(start); d < end; d.setUTCDate(d.getUTCDate() + 1)) {
  const date = new Date(d.getTime());
  const iso = date.toISOString().slice(0, 10);
  const count = documentsFor(date);

  const docRows = [];
  const lineRows = [];
  const ledgerBatch = [];
  const entryRows = [];
  const entryLineRows = [];

  for (let i = 0; i < count; i++) {
    const id = cuid();
    const warehouseId = pick(warehouses).id;
    const partnerId = skewed(customerIds);
    // most documents are small, a few are large
    const lineCount = rnd() < 0.8 ? 1 + Math.floor(rnd() * 3) : 5 + Math.floor(rnd() * 15);

    let supply = 0;
    const docLines = [];
    for (let n = 0; n < lineCount; n++) {
      const itemId = skewed(itemIds);
      const qty = 1 + Math.floor(rnd() * 20);
      const price = 1000 + Math.floor(rnd() * 50000);
      const lineSupply = qty * price;
      supply += lineSupply;
      docLines.push({ id: cuid(), itemId, qty, price, supply: lineSupply });
    }
    const vat = Math.floor(supply * 0.1);

    docRows.push({ id, warehouseId, partnerId, supply, vat, iso, seq: docs + i });
    for (const [n, l] of docLines.entries()) {
      lineRows.push({ ...l, documentId: id, lineNo: n + 1, vat: Math.floor(l.supply * 0.1) });
      ledgerBatch.push({
        id: cuid(),
        itemId: l.itemId,
        warehouseId,
        qty: -l.qty,
        amount: -Math.floor(l.supply * 0.6),
        sourceId: id,
        iso,
      });
    }

    const entryId = cuid();
    const periodId = periodIds.get(iso.slice(0, 7));
    if (!periodId) throw new Error(`no accounting period for ${iso.slice(0, 7)}`);
    entryRows.push({ id: entryId, sourceId: id, iso, seq: docs + i, periodId });
    const cost = Math.floor(supply * 0.6);
    entryLineRows.push(
      { entryId, accountId: accounts['110'], debit: supply + vat, credit: 0, lineNo: 1 },
      { entryId, accountId: accounts['401'], debit: 0, credit: supply, lineNo: 2 },
      { entryId, accountId: accounts['220'], debit: 0, credit: vat, lineNo: 3 },
      { entryId, accountId: accounts['501'], debit: cost, credit: 0, lineNo: 4 },
      { entryId, accountId: accounts['150'], debit: 0, credit: cost, lineNo: 5 },
    );
  }

  await insertBatch(
    `INSERT INTO "SalesDocument" ("id","docNo","docType","docDate","partnerId","warehouseId","divisionId","status","supplyAmount","vatAmount","totalAmount","confirmedAt","createdAt","updatedAt")`,
    docRows,
    (r, p) => [
      `($${p + 1},$${p + 2},'SALES',$${p + 3}::date,$${p + 4},$${p + 5},$${p + 6},'CONFIRMED',$${p + 7}::decimal,$${p + 8}::decimal,$${p + 9}::decimal,$${p + 3}::date,NOW(),NOW())`,
      [
        r.id,
        `PSA-${r.iso.replace(/-/g, '')}-${r.id.slice(-8)}`,
        r.iso,
        r.partnerId,
        r.warehouseId,
        division?.id ?? null,
        String(r.supply),
        String(r.vat),
        String(r.supply + r.vat),
      ],
    ],
  );

  await insertBatch(
    `INSERT INTO "SalesDocumentLine" ("id","documentId","lineNo","itemId","quantity","unitPrice","taxType","supplyAmount","vatAmount")`,
    lineRows,
    (r, p) => [
      `($${p + 1},$${p + 2},$${p + 3},$${p + 4},$${p + 5}::decimal,$${p + 6}::decimal,'TAXABLE',$${p + 7}::decimal,$${p + 8}::decimal)`,
      [
        r.id,
        r.documentId,
        r.lineNo,
        r.itemId,
        String(r.qty),
        String(r.price),
        String(r.supply),
        String(r.vat),
      ],
    ],
  );

  await insertBatch(
    `INSERT INTO "InventoryLedger" ("id","itemId","warehouseId","occurredAt","quantity","amount","sourceType","sourceId","sourceVersion","createdAt")`,
    ledgerBatch,
    (r, p) => [
      `($${p + 1},$${p + 2},$${p + 3},$${p + 4}::date,$${p + 5}::decimal,$${p + 6}::decimal,'SALES',$${p + 7},1,NOW())`,
      [r.id, r.itemId, r.warehouseId, r.iso, String(r.qty), String(r.amount), r.sourceId],
    ],
  );

  await insertBatch(
    `INSERT INTO "JournalEntry" ("id","entryNo","entryType","entryDate","periodId","description","status","sourceType","sourceId","sourceVersion","confirmedAt","createdAt","updatedAt")`,
    entryRows,
    (r, p) => [
      `($${p + 1},$${p + 2},'SALES',$${p + 3}::date,$${p + 5},'성능시험 매출','CONFIRMED','SALES',$${p + 4},1,$${p + 3}::date,NOW(),NOW())`,
      [r.id, `PJV-${r.iso.replace(/-/g, '')}-${r.id.slice(-8)}`, r.iso, r.sourceId, r.periodId],
    ],
  );

  await insertBatch(
    `INSERT INTO "JournalLine" ("id","entryId","lineNo","accountId","debit","credit")`,
    entryLineRows,
    (r, p) => [
      `($${p + 1},$${p + 2},$${p + 3},$${p + 4},$${p + 5}::decimal,$${p + 6}::decimal)`,
      [cuid(), r.entryId, r.lineNo, r.accountId, String(r.debit), String(r.credit)],
    ],
  );

  docs += docRows.length;
  lines += lineRows.length;
  ledgerRows += ledgerBatch.length;
  journals += entryRows.length;
}

/** Postgres caps a statement at 65535 parameters, so batches are chunked well below it. */
async function insertBatch(head, rows, build) {
  if (rows.length === 0) return;
  const CHUNK = 400;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const slice = rows.slice(i, i + CHUNK);
    const values = [];
    const params = [];
    for (const r of slice) {
      const [frag, vals] = build(r, params.length);
      values.push(frag);
      params.push(...vals);
    }
    await client.query(`${head} VALUES ${values.join(',')}`, params);
  }
}

await client.query(`ANALYZE "SalesDocument"`);
await client.query(`ANALYZE "SalesDocumentLine"`);
await client.query(`ANALYZE "InventoryLedger"`);
await client.query(`ANALYZE "JournalEntry"`);
await client.query(`ANALYZE "JournalLine"`);

console.log(
  `done in ${((Date.now() - started) / 1000).toFixed(1)}s: ${docs} documents, ${lines} lines, ${ledgerRows} ledger rows, ${journals} journal entries`,
);
await client.end();
