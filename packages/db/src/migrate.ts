import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { PGlite } from '@electric-sql/pglite';

// packages/db/drizzle/ — resolved from this module so it works both from
// src/ (vitest runs from source) and dist/ (compiled output); both are
// siblings of the drizzle/ directory under the package root.
const MIGRATIONS_DIR = fileURLToPath(new URL('../drizzle/', import.meta.url));

// Applies every drizzle/*.sql migration in filename order (drizzle-kit's
// numeric prefixes make lexicographic order == chronological order).
export async function applyMigrations(client: PGlite): Promise<void> {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  for (const file of files) {
    await client.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'));
  }
}
