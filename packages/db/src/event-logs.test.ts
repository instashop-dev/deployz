import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Db } from './client.js';
import { eventLogs } from './schema/index.js';
import { createTestDb, seedBase } from './test-utils.js';

// §40 EventLog is APPEND-ONLY. Immutability is enforced by the
// `event_logs_immutable` plpgsql trigger installed by the second migration —
// a REVOKE-based guard is impossible against PGlite's single superuser role,
// so the trigger IS the enforcement and these tests are the proof.
describe('event_logs append-only trigger', () => {
  let client: PGlite | undefined;
  let db: Db | undefined;

  beforeAll(async () => {
    ({ client, db } = await createTestDb());
    const ids = await seedBase(db);
    await db!.insert(eventLogs).values({
      actorType: 'user',
      actorId: 'user_1',
      organizationId: ids.organizationId,
      eventType: 'install.requested',
      payload: { note: 'seed event' },
    });
  });

  afterAll(async () => {
    await client?.close();
  });

  it('allows INSERT', async () => {
    const { rows } = await client!.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM event_logs`,
    );
    expect(rows[0]?.c).toBe(1);

    await db!.insert(eventLogs).values({
      actorType: 'system',
      actorId: 'control-plane',
      organizationId: 'org_test',
      eventType: 'install.succeeded',
    });
    const { rows: after } = await client!.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM event_logs`,
    );
    expect(after[0]?.c).toBe(2);
  });

  it('rejects UPDATE with the trigger exception', async () => {
    await expect(
      client!.query(`UPDATE event_logs SET event_type = 'tampered'`),
    ).rejects.toThrow(/append-only/);
  });

  it('rejects DELETE with the trigger exception', async () => {
    await expect(client!.query(`DELETE FROM event_logs`)).rejects.toThrow(
      /append-only/,
    );
  });

  it('rejects TRUNCATE ... and documents why not: TRUNCATE does not fire row triggers', async () => {
    // FOR EACH ROW triggers do not fire on TRUNCATE. A statement-level trigger
    // on TRUNCATE guards that path; asserted here so the gap can never
    // silently reappear.
    await expect(client!.query(`TRUNCATE event_logs`)).rejects.toThrow(
      /append-only/,
    );
  });
});
