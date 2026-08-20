import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createRuntimeDb, type RuntimeDb } from './client.js';
import { organization } from './schema/index.js';

// createRuntimeDb without DATABASE_URL boots a file-backed PGlite and applies
// drizzle migrations at startup. PGlite cold boot is ~6-7s on this machine —
// the suite gets explicit timeouts, not sleeps.
describe('createRuntimeDb (PGlite, file-backed)', () => {
  let dataDir: string;
  let first: RuntimeDb | undefined;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'deployz-pgdata-'));
  });

  afterAll(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it('applies migrations at startup so schema tables are queryable', async () => {
    // Given a data dir with no prior state
    // When the runtime factory boots over it
    first = await createRuntimeDb({ pgliteDataDir: dataDir });
    // Then migrated tables exist and are queryable
    const rows = await first.select().from(organization);
    expect(rows).toEqual([]);
  }, 60_000);

  it('second boot over the same data dir is idempotent and preserves data', async () => {
    // Given a booted instance where we insert a row, then close it
    await first!.insert(organization).values({ id: 'org_keep', name: 'Keep', slug: 'keep' });
    await (first!.$client as PGlite).close();
    // When the factory boots again over the same dir
    const second = await createRuntimeDb({ pgliteDataDir: dataDir });
    // Then migration replay is a no-op and prior data survives
    const rows = await second.select().from(organization);
    expect(rows.map((r) => r.id)).toEqual(['org_keep']);
    await (second.$client as PGlite).close();
  }, 60_000);
});
