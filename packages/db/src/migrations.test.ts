import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestDb } from './test-utils.js';

// Smoke tests: the generated SQL migrations apply cleanly to a fresh
// ephemeral Postgres (PGlite) and produce the expected catalog shape.
describe('migrations', () => {
  let client: PGlite | undefined;

  beforeAll(async () => {
    ({ client } = await createTestDb());
  });

  afterAll(async () => {
    // Guarded: if beforeAll throws, client is undefined — don't mask the real
    // error behind "Cannot read properties of undefined (reading 'close')".
    await client?.close();
  });

  it('creates all 17 core tables', async () => {
    const { rows } = await client!.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
       ORDER BY table_name`,
    );
    expect(rows.map((r) => r.table_name)).toEqual([
      'account',
      'application_configs',
      'applications',
      'customers',
      'deployment_jobs',
      'deployments',
      'event_logs',
      'github_installations',
      'invitation',
      'member',
      'organization',
      'releases',
      'session',
      'subscriptions',
      'usage_records',
      'user',
      'verification',
    ]);
  });

  it('creates the 13 enum types', async () => {
    const { rows } = await client!.query<{ typname: string }>(
      `SELECT typname FROM pg_type
       WHERE typtype = 'e' AND typnamespace = 'public'::regnamespace
       ORDER BY typname`,
    );
    expect(rows.map((r) => r.typname)).toEqual([
      'analysis_status',
      'build_status',
      'compatibility_status',
      'deployment_state',
      'failure_code',
      'health_status',
      'job_state',
      'job_type',
      'org_plan',
      'region',
      'relay_status',
      'release_status',
      'subscription_status',
    ]);
  });

  it('starts event_logs empty', async () => {
    const { rows } = await client!.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM event_logs`,
    );
    expect(rows[0]?.c).toBe(0);
  });
});
