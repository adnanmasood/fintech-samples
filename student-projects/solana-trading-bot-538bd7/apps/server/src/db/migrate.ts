import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type Database from 'better-sqlite3';
import { createDb } from './client.js';

/**
 * Migrations.
 *
 * Plain SQL files applied in filename order and recorded in `_migrations`, so
 * a partially-migrated database picks up exactly where it stopped. Running
 * this twice is a no-op.
 */

const here = dirname(fileURLToPath(import.meta.url));

export function migrationsDir(): string {
  // src/db/migrate.ts -> apps/server/migrations, and dist/db/migrate.js too.
  return resolve(here, '..', '..', 'migrations');
}

export function applyMigrations(sqlite: Database.Database, dir = migrationsDir()): string[] {
  sqlite.exec(`CREATE TABLE IF NOT EXISTS _migrations (
    name TEXT PRIMARY KEY,
    applied_at INTEGER NOT NULL
  )`);

  const applied = new Set(
    sqlite.prepare('SELECT name FROM _migrations').all().map((r) => (r as { name: string }).name),
  );

  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const ran: string[] = [];
  const record = sqlite.prepare('INSERT INTO _migrations (name, applied_at) VALUES (?, ?)');

  for (const file of files) {
    if (applied.has(file)) continue;
    const sqlText = readFileSync(join(dir, file), 'utf8');
    // One transaction per file: a failing migration leaves nothing half-applied.
    const run = sqlite.transaction(() => {
      sqlite.exec(sqlText);
      record.run(file, Date.now());
    });
    run();
    ran.push(file);
  }

  return ran;
}

async function main(): Promise<void> {
  const handle = createDb();
  try {
    const ran = applyMigrations(handle.sqlite);
    if (ran.length === 0) {
      console.log('Database is up to date.');
    } else {
      console.log(`Applied ${ran.length} migration(s):`);
      for (const name of ran) console.log(`  ${name}`);
    }
  } finally {
    handle.close();
  }
}

// Only run when invoked directly, never on import.
if (process.argv[1] && process.argv[1].includes('migrate')) {
  main().catch((err) => {
    console.error('Migration failed:', err);
    process.exitCode = 1;
  });
}
