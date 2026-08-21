import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { PGlite } from '@electric-sql/pglite';

// Lazy: computed inside the function so CJS bundling (Lambda) does not
// evaluate import.meta.url at module load time.
function getMigrationsDir(): string {
  return fileURLToPath(new URL('../drizzle/', import.meta.url));
}

// Applies every drizzle/*.sql migration in filename order (drizzle-kit's
// numeric prefixes make lexicographic order == chronological order).
export async function applyMigrations(client: PGlite): Promise<void> {
  const migrationsDir = getMigrationsDir();
  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  for (const file of files) {
    await client.exec(readFileSync(join(migrationsDir, file), 'utf8'));
  }
}
