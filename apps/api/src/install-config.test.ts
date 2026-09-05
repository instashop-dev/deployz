import { PGlite } from '@electric-sql/pglite';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { applyMigrations, createDb, type Db } from '@deployz/db';
import * as schema from '@deployz/db/schema';

import { createConfigStore } from './config.js';
import { buildRelayConfigEntries, queuePostInstallConfig } from './install-config.js';

// AI MVP Phase 4 — the first configuration pass after a successful INSTALL:
// the relay's effective-config view carries every saved entry (plain values
// travel, secret values never do) plus one `generated` entry per app-internal
// secret the vendor did not set, and a successful INSTALL queues exactly one
// CONFIG_UPDATE job for it.

const MANIFEST_ENV = [
  { key: 'DATABASE_URL', required: true, secret: false, source: [], classification: 'deployz_managed' },
  { key: 'SESSION_SECRET', required: true, secret: true, source: [], classification: 'deployz_generated' },
  { key: 'ENCRYPTION_KEY', required: true, secret: true, source: [], classification: 'deployz_generated' },
  { key: 'LICENSE_KEY', required: true, secret: true, source: [], classification: 'customer_required' },
  { key: 'LOG_LEVEL', required: false, secret: false, source: [], classification: 'optional' },
];

function manifest(variables: unknown[] = MANIFEST_ENV) {
  return {
    application: { root: '.', runtime: 'node', framework: 'express', dockerfilePath: 'Dockerfile' },
    build: { command: null, context: '.' },
    web: { command: 'node server.js', port: 3000 },
    health: { path: '/health' },
    database: { postgres: true },
    redis: { required: false, envBindings: [] },
    storage: { required: false, envBindings: [] },
    migration: { command: null },
    worker: { command: null },
    environment: { variables },
    externalServices: [],
    unsupported: [],
  };
}

describe('post-install configuration', () => {
  let client: PGlite | undefined;
  let db: Db;
  let applicationId: string;
  let customerId: string;
  let deploymentId: string;
  const organizationId = 'org-install-config';

  beforeAll(async () => {
    client = new PGlite();
    await applyMigrations(client);
    db = createDb(client);
    await db.insert(schema.organization).values({ id: organizationId, name: 'Acme', slug: organizationId });
    const [application] = await db
      .insert(schema.applications)
      .values({
        organizationId,
        name: 'App',
        repoFullName: 'acme/app',
        repoUrl: 'https://github.com/acme/app',
        defaultBranch: 'main',
        analysisStatus: 'COMPLETE',
      })
      .returning();
    applicationId = application!.id;
    const [customer] = await db
      .insert(schema.customers)
      .values({ organizationId, name: 'Customer', email: 'customer@example.com' })
      .returning();
    customerId = customer!.id;
    const [deployment] = await db
      .insert(schema.deployments)
      .values({
        organizationId,
        applicationId,
        customerId,
        region: 'us-east-1',
        state: 'INSTALLING',
        desiredState: { manifest: manifest() },
        enrollmentCode: 'enrol-1',
      })
      .returning();
    deploymentId = deployment!.id;
    await db.insert(schema.applicationConfigs).values([
      { applicationId, customerId: null, key: 'LOG_LEVEL', value: 'debug', isSecret: false },
      { applicationId, customerId, key: 'LICENSE_KEY', value: '***', isSecret: true },
      { applicationId, customerId, key: 'ENCRYPTION_KEY', value: '***', isSecret: true },
    ]);
  }, 60_000);

  afterAll(async () => {
    await client?.close();
  });

  it('lists the effective config plus a generated entry for each unconfigured generated key, never a secret value', async () => {
    const [deployment] = await db.select().from(schema.deployments).where(eq(schema.deployments.id, deploymentId));
    const entries = await buildRelayConfigEntries(db, deployment!, createConfigStore(db));
    expect(entries).toEqual([
      { key: 'LOG_LEVEL', isSecret: false, value: 'debug', source: 'vendor' },
      // The vendor chose a value for ENCRYPTION_KEY — it is theirs, not minted.
      { key: 'ENCRYPTION_KEY', isSecret: true, source: 'customer' },
      { key: 'LICENSE_KEY', isSecret: true, source: 'customer' },
      { key: 'SESSION_SECRET', isSecret: true, source: 'generated', generated: true },
    ]);
    expect(JSON.stringify(entries)).not.toContain('***');
  });

  it('queues one CONFIG_UPDATE job per install, with key names only, and reuses it on a replay', async () => {
    const [deployment] = await db.select().from(schema.deployments).where(eq(schema.deployments.id, deploymentId));
    const store = createConfigStore(db);
    expect(await queuePostInstallConfig(db, deployment!, 'install-job-1', store)).toEqual({ queued: true });
    expect(await queuePostInstallConfig(db, deployment!, 'install-job-1', store)).toEqual({ queued: false });

    const jobs = await db
      .select()
      .from(schema.deploymentJobs)
      .where(and(eq(schema.deploymentJobs.deploymentId, deploymentId), eq(schema.deploymentJobs.type, 'CONFIG_UPDATE')));
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      state: 'REQUESTED',
      idempotencyKey: `${deploymentId}:CONFIG_UPDATE:install:install-job-1`,
      payload: { reason: 'install', changedKeys: ['LOG_LEVEL', 'ENCRYPTION_KEY', 'LICENSE_KEY', 'SESSION_SECRET'] },
    });
    expect(JSON.stringify(jobs[0]!.payload)).not.toContain('debug');
  });

  it('queues nothing when there is nothing to apply', async () => {
    const [bare] = await db
      .insert(schema.deployments)
      .values({
        organizationId,
        applicationId,
        customerId: (
          await db
            .insert(schema.customers)
            .values({ organizationId, name: 'Bare', email: 'bare@example.com' })
            .returning()
        )[0]!.id,
        region: 'us-east-1',
        state: 'INSTALLING',
        desiredState: { manifest: manifest([]) },
        enrollmentCode: 'enrol-2',
      })
      .returning();
    // The vendor default LOG_LEVEL still applies to every customer.
    expect(await queuePostInstallConfig(db, bare!, 'install-job-2', createConfigStore(db))).toEqual({ queued: true });

    const [noConfigApp] = await db
      .insert(schema.applications)
      .values({
        organizationId,
        name: 'Bare app',
        repoFullName: 'acme/bare',
        repoUrl: 'https://github.com/acme/bare',
        defaultBranch: 'main',
        analysisStatus: 'COMPLETE',
      })
      .returning();
    const [nothing] = await db
      .insert(schema.deployments)
      .values({
        organizationId,
        applicationId: noConfigApp!.id,
        customerId: bare!.customerId,
        region: 'us-east-1',
        state: 'INSTALLING',
        desiredState: { manifest: manifest([]) },
        enrollmentCode: 'enrol-3',
      })
      .returning();
    expect(await queuePostInstallConfig(db, nothing!, 'install-job-3', createConfigStore(db))).toEqual({ queued: false });
  });
});
