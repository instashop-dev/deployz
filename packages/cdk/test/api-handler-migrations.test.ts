import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

// The Lambda bundles migration SQL as text via esbuild, which cannot
// glob-import — so every migration must be listed by hand in api-handler.ts.
// Forgetting one is invisible until a deployed cold start tries to migrate and
// dies with "No file ... found in /tmp/drizzle folder", taking the whole API
// down. That is exactly how 0002-0005 came to be missing. This test turns that
// production outage into a failing build.
const handlerSource = readFileSync(
  fileURLToPath(new URL('../src/lambda/api-handler.ts', import.meta.url)),
  'utf8',
);

const drizzleDir = fileURLToPath(new URL('../../db/drizzle', import.meta.url));

const journal = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../db/drizzle/meta/_journal.json', import.meta.url)), 'utf8'),
) as { entries: { tag: string }[] };

describe('api-handler migration bundling', () => {
  const journalTags = journal.entries.map((entry) => entry.tag);

  it('has at least one migration to check', () => {
    expect(journalTags.length).toBeGreaterThan(0);
  });

  it.each(journalTags)('imports the SQL for %s', (tag) => {
    expect(handlerSource).toContain(`${tag}.sql`);
  });

  it.each(journalTags)('maps %s in MIGRATION_SQL', (tag) => {
    expect(handlerSource).toContain(`'${tag}'`);
  });

  // A .sql file on disk that the journal does not list would never be applied
  // by drizzle either, so the journal — not the directory — is the contract.
  it('journal lists every .sql file on disk', () => {
    const onDisk = readdirSync(drizzleDir)
      .filter((f) => f.endsWith('.sql'))
      .map((f) => f.replace(/\.sql$/, ''))
      .sort();

    expect([...journalTags].sort()).toEqual(onDisk);
  });
});
