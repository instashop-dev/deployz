import type { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';

import * as schema from './schema/index.js';

// PGlite-compatible client factory. @electric-sql/pglite is a devDependency
// of this package ON PURPOSE: callers (tests today, apps/api for local dev
// later) construct the PGlite instance and pass it in — the type-only import
// above is erased at compile time, so nothing here forces pglite onto
// production consumers.
export function createDb(client: PGlite) {
  return drizzle({ client, schema });
}

export type Db = ReturnType<typeof createDb>;
