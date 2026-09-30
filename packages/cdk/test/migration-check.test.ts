import { describe, expect, it } from 'vitest';

import { migrationsUpToDate } from '../src/lambda/migration-check';

const journal = { entries: [{ when: 100 }, { when: 300 }, { when: 200 }] };
const dbReturning = (created_at: string | number | null | undefined) => ({
  query: async () => ({ rows: created_at === undefined ? [] : [{ created_at }] }),
});

describe('migrationsUpToDate', () => {
  it('is true when the last applied migration is the newest bundled one (bigint arrives as a string)', async () => {
    expect(await migrationsUpToDate(dbReturning('300'), journal)).toBe(true);
    expect(await migrationsUpToDate(dbReturning(400), journal)).toBe(true);
  });

  it('is false when a bundled migration is newer than the last applied one', async () => {
    expect(await migrationsUpToDate(dbReturning('299'), journal)).toBe(false);
  });

  it('is false for an empty migrations table or an empty journal', async () => {
    expect(await migrationsUpToDate(dbReturning(undefined), journal)).toBe(false);
    expect(await migrationsUpToDate(dbReturning(null), journal)).toBe(false);
    expect(await migrationsUpToDate(dbReturning(300), { entries: [] })).toBe(false);
  });

  it('fails safe: a query error means run the migrator', async () => {
    const broken = {
      query: async () => {
        throw new Error('relation "drizzle.__drizzle_migrations" does not exist');
      },
    };
    expect(await migrationsUpToDate(broken, journal)).toBe(false);
  });
});
