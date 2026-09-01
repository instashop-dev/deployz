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

  it('creates all 19 core tables', async () => {
    const { rows } = await client!.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
       ORDER BY table_name`,
    );
    expect(rows.map((r) => r.table_name)).toEqual([
      'account',
      'application_configs',
      'applications',
      'custom_domains',
      'customers',
      'deployment_jobs',
      'deployment_stack_events',
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

  it('creates the 16 enum types', async () => {
    const { rows } = await client!.query<{ typname: string }>(
      `SELECT typname FROM pg_type
       WHERE typtype = 'e' AND typnamespace = 'public'::regnamespace
       ORDER BY typname`,
    );
    expect(rows.map((r) => r.typname)).toEqual([
      'ai_explanation_state',
      'analysis_status',
      'build_status',
      'cleanup_state',
      'compatibility_status',
      'custom_domain_status',
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

  // Redis MVP task 3: applications.redis_required mirrors database_required
  // exactly — same shape, same default, so existing apps (redisRequired
  // absent from analysis) stay false without a backfill.
  it('applications has redis_required: boolean, not null, default false', async () => {
    const { rows } = await client!.query<{
      data_type: string;
      is_nullable: string;
      column_default: string | null;
    }>(
      `SELECT data_type, is_nullable, column_default FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'applications' AND column_name = 'redis_required'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.data_type).toBe('boolean');
    expect(rows[0]?.is_nullable).toBe('NO');
    expect(rows[0]?.column_default).toBe('false');
  });

  // §61 taxonomy extension: two Redis failure codes must exist as real enum
  // labels in the migrated catalog, not just in the TypeScript source.
  it('failure_code enum includes the two Redis failure codes', async () => {
    const { rows } = await client!.query<{ enumlabel: string }>(
      `SELECT enumlabel FROM pg_enum
       JOIN pg_type ON pg_type.oid = pg_enum.enumtypid
       WHERE pg_type.typname = 'failure_code'
       ORDER BY enumsortorder`,
    );
    const labels = rows.map((r) => r.enumlabel);
    expect(labels).toContain('REDIS_PROVISIONING_FAILED');
    expect(labels).toContain('REDIS_CONNECTION_FAILED');
  });
});
