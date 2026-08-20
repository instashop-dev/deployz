import { PGlite } from '@electric-sql/pglite';
import { drizzle as drizzleNode, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { drizzle as drizzlePglite, type PgliteDatabase } from 'drizzle-orm/pglite';
import { migrate as migratePglite } from 'drizzle-orm/pglite/migrator';
import { Pool } from 'pg';
import { fileURLToPath } from 'node:url';

import * as schema from './schema/index.js';

export interface RuntimeDbOptions {
  // Overrides the PGlite data directory (tests point this at a tmpdir;
  // production dev runs use the repo-local default below).
  pgliteDataDir?: string;
}

export type Schema = typeof schema;
export type RuntimeDb = NodePgDatabase<Schema> | PgliteDatabase<Schema>;

// PGlite-compatible client factory for tests: callers construct the PGlite
// instance and pass it in (in-memory), migrations stay in test-utils.
export function createDb(client: PGlite) {
  return drizzlePglite({ client, schema });
}

export type Db = ReturnType<typeof createDb>;

// packages/db/.pgdata — repo-local, file-backed dev database (gitignored).
// Resolved from this module so it works from both src/ and dist/.
const DEFAULT_PGDATA_DIR = fileURLToPath(new URL('../.pgdata', import.meta.url));

// Runtime factory used by long-lived processes (apps/api). Two honest paths:
//   - DATABASE_URL set   -> real Postgres via node-pool (migrations are the
//                           platform's concern there, not startup's)
//   - DATABASE_URL unset -> local file-backed PGlite at packages/db/.pgdata,
//                           with drizzle migrations applied at startup via
//                           the bundled migrator (journal-tracked, idempotent)
// Both branches return the same drizzle-over-schema instance shape.
export async function createRuntimeDb(options: RuntimeDbOptions = {}): Promise<RuntimeDb> {
  const url = process.env.DATABASE_URL;
  if (url) {
    const pool = new Pool({ connectionString: url });
    return drizzleNode({ client: pool, schema });
  }

  const client = new PGlite(options.pgliteDataDir ?? DEFAULT_PGDATA_DIR);
  const db = drizzlePglite({ client, schema });
  const migrationsFolder = fileURLToPath(new URL('../drizzle', import.meta.url));
  await migratePglite(db, { migrationsFolder });
  return db;
}
