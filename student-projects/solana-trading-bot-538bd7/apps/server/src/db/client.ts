import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { getEnv } from '../config/env.js';
import * as schema from './schema.js';

export type Db = BetterSQLite3Database<typeof schema>;

export interface DbHandle {
  db: Db;
  sqlite: Database.Database;
  close(): void;
}

/** Turn a DATABASE_URL into a filesystem path. `:memory:` is honoured for tests. */
export function resolveDbPath(url: string): string {
  if (url === ':memory:') return ':memory:';
  const stripped = url.startsWith('file:') ? url.slice('file:'.length) : url;
  return resolve(process.cwd(), stripped);
}

export function createDb(url = getEnv().DATABASE_URL): DbHandle {
  const path = resolveDbPath(url);
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true });
  }
  const sqlite = new Database(path);
  // WAL keeps the scheduler's writes from blocking the dashboard's reads.
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  // The scheduler and the HTTP layer share one process, but a long agent run
  // can still hold a write lock; wait rather than throw SQLITE_BUSY.
  sqlite.pragma('busy_timeout = 5000');
  const db = drizzle(sqlite, { schema });
  return {
    db,
    sqlite,
    close: () => sqlite.close(),
  };
}

export { schema };
