#!/usr/bin/env node
/**
 * Rust-free Prisma migration driver built on @prisma/schema-engine-wasm + @prisma/adapter-pg.
 * Used because the sandbox cannot download the native schema-engine binary. Produces the same
 * prisma/migrations/<timestamp>_<name>/migration.sql layout and _prisma_migrations table as the CLI,
 * so `prisma migrate deploy` (with engines available) remains compatible in CI/production.
 *
 * Usage:
 *   node tools/migrate.mjs dev --name <name>   # create migration from schema diff and apply
 *   node tools/migrate.mjs deploy              # apply pending migrations
 *   node tools/migrate.mjs status
 *   node tools/migrate.mjs reset               # drop & re-apply (dev/test only)
 *   node tools/migrate.mjs diff                # print pending SQL without writing
 * Env: DATABASE_URL (or --url)
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { PrismaPg } from '@prisma/adapter-pg';
import { bindMigrationAwareSqlAdapterFactory } from '@prisma/driver-adapter-utils';

const root = path.resolve(new URL('.', import.meta.url).pathname, '..');
const schemaPath = path.join(root, 'prisma/schema.prisma');
const migrationsDir = path.join(root, 'prisma/migrations');
const snapshotPath = path.join(migrationsDir, 'schema.snapshot.prisma');

const args = process.argv.slice(2);
const cmd = args[0] ?? 'status';
const opt = (k) => {
  const i = args.indexOf(k);
  return i >= 0 ? args[i + 1] : undefined;
};
const url = opt('--url') ?? process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL required');
  process.exit(1);
}

async function loadEngine() {
  const pkgDir = path.join(root, 'node_modules/@prisma/schema-engine-wasm');
  const bg = await import(path.join(pkgDir, 'schema_engine_bg.js'));
  const bytes = fs.readFileSync(path.join(pkgDir, 'schema_engine_bg.wasm'));
  const { instance } = await WebAssembly.instantiate(bytes, { './schema_engine_bg.js': bg });
  bg.__wbg_set_wasm(instance.exports);
  instance.exports.__wbindgen_start();
  return bg;
}

function migrationList() {
  fs.mkdirSync(migrationsDir, { recursive: true });
  const lockPath = path.join(migrationsDir, 'migration_lock.toml');
  const dirs = fs
    .readdirSync(migrationsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
  return {
    baseDir: migrationsDir,
    lockfile: {
      path: 'migration_lock.toml',
      content: fs.existsSync(lockPath) ? fs.readFileSync(lockPath, 'utf8') : null,
    },
    shadowDbInitScript: '',
    migrationDirectories: dirs.map((d) => {
      const f = path.join(migrationsDir, d, 'migration.sql');
      return {
        path: d,
        migrationFile: {
          path: 'migration.sql',
          content: fs.existsSync(f)
            ? { tag: 'ok', value: fs.readFileSync(f, 'utf8') }
            : { tag: 'error', value: 'missing migration.sql' },
        },
      };
    }),
  };
}

const filters = { externalTables: [], externalEnums: [] };
const schema = () => ({ files: [{ path: schemaPath, content: fs.readFileSync(schemaPath, 'utf8') }] });

async function main() {
  const bg = await loadEngine();
  const factory = new PrismaPg({ connectionString: url });
  // The pg adapter's executeScript splits on ';', which breaks dollar-quoted plpgsql bodies.
  // Run the whole script through the simple query protocol instead (the native engine does the same).
  const patchScript = (a) => {
    const client = a.client;
    if (client)
      a.executeScript = async (script) => {
        await client.query(script);
      };
    return a;
  };
  const patchedFactory = {
    provider: factory.provider,
    adapterName: factory.adapterName,
    connect: async (...args) => patchScript(await factory.connect(...args)),
    connectToShadowDb: async (...args) => patchScript(await factory.connectToShadowDb(...args)),
  };
  const adapter = bindMigrationAwareSqlAdapterFactory(patchedFactory); // error-capturing wrapper expected by the wasm engine
  const logs = [];
  const engine = await bg.SchemaEngine.new(
    { datamodels: [[schemaPath, fs.readFileSync(schemaPath, 'utf8')]] },
    (e) => logs.push(e),
    adapter,
  );
  try {
    if (cmd === 'status') {
      const d = await engine.diagnoseMigrationHistory({
        migrationsList: migrationList(),
        optInToShadowDatabase: false,
        filters,
      });
      console.log(JSON.stringify(d, null, 2));
    } else if (cmd === 'diff') {
      const from = fs.existsSync(snapshotPath)
        ? {
            tag: 'schemaDatamodel',
            files: [{ path: schemaPath, content: fs.readFileSync(snapshotPath, 'utf8') }],
          }
        : { tag: 'empty' };
      const r = await engine.diff({
        from,
        to: { tag: 'schemaDatamodel', ...schema() },
        script: true,
        exitCode: null,
        filters,
      });
      console.log(r.stdout ?? '(no changes)');
    } else if (cmd === 'deploy') {
      const r = await engine.applyMigrations({ migrationsList: migrationList(), filters });
      console.log(
        `applied: ${r.appliedMigrationNames.length ? r.appliedMigrationNames.join(', ') : '(none)'}`,
      );
    } else if (cmd === 'reset') {
      await engine.reset({ filter: filters });
      // reset drops everything including our plpgsql helpers; migrations recreate them
      const r = await engine.applyMigrations({ migrationsList: migrationList(), filters });
      console.log(`reset; applied ${r.appliedMigrationNames.length} migration(s)`);
    } else if (cmd === 'dev') {
      const name = opt('--name') ?? 'migration';
      const list = migrationList();
      if (!list.lockfile.content)
        fs.writeFileSync(
          path.join(migrationsDir, 'migration_lock.toml'),
          '# Please do not edit this file manually\n# It should be added in your version-control system (e.g., Git)\nprovider = "postgresql"\n',
        );
      const diag = await engine.diagnoseMigrationHistory({
        migrationsList: list,
        optInToShadowDatabase: true,
        filters,
      });
      if (diag.history && diag.history.diagnostic !== 'databaseIsBehind') {
        console.error('migration history diverged:', JSON.stringify(diag.history));
        process.exit(1);
      }
      if (diag.failedMigrationNames.length) {
        console.error('failed migrations present:', diag.failedMigrationNames);
        process.exit(1);
      }
      await engine.applyMigrations({ migrationsList: list, filters });
      // The wasm engine has no shadow-DB / introspection support for PostgreSQL, so we diff the schema snapshot
      // taken at the previous migration (prisma/migrations/schema.snapshot.prisma) against the current schema.
      const from = fs.existsSync(snapshotPath)
        ? {
            tag: 'schemaDatamodel',
            files: [{ path: schemaPath, content: fs.readFileSync(snapshotPath, 'utf8') }],
          }
        : { tag: 'empty' };
      const diff = await engine.diff({
        from,
        to: { tag: 'schemaDatamodel', ...schema() },
        script: true,
        exitCode: null,
        filters,
      });
      const script = (diff.stdout ?? '').trim();
      if (!script || (/^-- This is an empty migration\.?$/m.test(script) && script.split('\n').length <= 1)) {
        console.log('no schema changes; nothing to migrate');
        return;
      }
      const destructive = script
        .split('\n')
        .filter((l) => /^(DROP TABLE|DROP COLUMN|ALTER TABLE .* DROP COLUMN)/i.test(l.trim()));
      if (destructive.length && !args.includes('--accept-data-loss')) {
        console.error('destructive statements (pass --accept-data-loss):\n' + destructive.join('\n'));
        process.exit(1);
      }
      const ts = new Date()
        .toISOString()
        .replace(/[-:TZ.]/g, '')
        .slice(0, 14);
      const out = { generatedMigrationName: `${ts}_${name}`, migrationScript: script, extension: 'sql' };
      const dir = path.join(migrationsDir, out.generatedMigrationName);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `migration.${out.extension}`), out.migrationScript + '\n');
      fs.copyFileSync(schemaPath, snapshotPath);
      console.log(`created ${out.generatedMigrationName}`);
      if (!args.includes('--create-only')) {
        const r = await engine.applyMigrations({ migrationsList: migrationList(), filters });
        console.log(`applied: ${r.appliedMigrationNames.join(', ')}`);
      }
    } else {
      console.error(`unknown command ${cmd}`);
      process.exit(1);
    }
  } finally {
    engine.free?.();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
