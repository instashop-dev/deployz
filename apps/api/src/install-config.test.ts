import { PGlite } from '@electric-sql/pglite';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { applyMigrations, createDb, type Db } from '@deployz/db';
import * as schema from '@deployz/db/schema';

import { createConfigStore } from './config.js';
import { buildInstallPayload, buildRelayConfigEntries, queuePostInstallConfig } from './install-config.js';

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
  // An app-internal secret the analyser did not classify as generated (kutt's
  // JWT_SECRET: `str({ devDefault })`, so "optional" to the detector).
  { key: 'JWT_SECRET', required: false, secret: true, source: [], purpose: 'internal_secret', classification: 'optional' },
  // An external credential: never minted, whatever its value state.
  { key: 'OIDC_CLIENT_SECRET', required: false, secret: true, source: [], purpose: 'external_credential', classification: 'optional' },
];

// An outline-shaped manifest (DEPLOY-030): the purpose values the FIXED
// analyser now produces for the real outline minting incident (see
// packages/analysis/test/stage-b-phase3.test.ts's provider-prefix/TLS/
// location-suffix assertions). Only SECRET_KEY/UTILS_SECRET stay
// purpose: internal_secret; the rest reclassify to external_credential or
// optional_configuration, so mintableKeys's unchanged `secret && purpose ===
// 'internal_secret'` rule mints only the first two.
const OUTLINE_MANIFEST_ENV = [
  { key: 'SECRET_KEY', required: false, secret: true, source: [], purpose: 'internal_secret', classification: 'optional' },
  { key: 'UTILS_SECRET', required: false, secret: true, source: [], purpose: 'internal_secret', classification: 'unknown' },
  { key: 'SSL_KEY', required: false, secret: true, source: [], purpose: 'optional_configuration', classification: 'unknown' },
  { key: 'AWS_ACCESS_KEY_ID', required: false, secret: true, source: [], purpose: 'external_credential', classification: 'unknown' },
  { key: 'DROPBOX_APP_KEY', required: false, secret: true, source: [], purpose: 'external_credential', classification: 'unknown' },
  { key: 'GITHUB_WEBHOOK_SECRET', required: false, secret: true, source: [], purpose: 'external_credential', classification: 'unknown' },
  { key: 'SLACK_VERIFICATION_TOKEN', required: false, secret: true, source: [], purpose: 'external_credential', classification: 'unknown' },
  { key: 'OIDC_TOKEN_URI', required: false, secret: false, source: [], purpose: 'external_credential', classification: 'unknown' },
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
      // Vendor-typed before any install: write-only, so no value can reach a
      // later install — the relay mints one unless the store already has it.
      { applicationId, customerId: null, key: 'JWT_SECRET', value: '***', isSecret: true },
      { applicationId, customerId: null, key: 'OIDC_CLIENT_SECRET', value: '***', isSecret: true },
    ]);
  }, 60_000);

  afterAll(async () => {
    await client?.close();
  });

  it('lists the effective config plus a generated entry for each unconfigured generated key, never a secret value', async () => {
    const [deployment] = await db.select().from(schema.deployments).where(eq(schema.deployments.id, deploymentId));
    const entries = await buildRelayConfigEntries(db, deployment!, createConfigStore(db));
    const byKey = [...entries].sort((a, b) => a.key.localeCompare(b.key));
    expect(byKey).toEqual([
      // Vendor-typed secrets are write-only: the relay keeps the value if it
      // ever reached the customer's store, and mints an app-internal one
      // otherwise (DEPLOY-013). An external credential is never minted.
      { key: 'ENCRYPTION_KEY', isSecret: true, source: 'customer', generated: true },
      { key: 'JWT_SECRET', isSecret: true, source: 'vendor', generated: true },
      { key: 'LICENSE_KEY', isSecret: true, source: 'customer' },
      { key: 'LOG_LEVEL', isSecret: false, value: 'debug', source: 'vendor' },
      { key: 'OIDC_CLIENT_SECRET', isSecret: true, source: 'vendor' },
      { key: 'SESSION_SECRET', isSecret: true, source: 'generated', generated: true },
    ]);
    expect(JSON.stringify(entries)).not.toContain('***');
  });

  it('marks the INSTALL payload startAfterConfig with a zero task count when configuration waits and a release exists (DEPLOY-009)', async () => {
    const [deployment] = await db.select().from(schema.deployments).where(eq(schema.deployments.id, deploymentId));
    const [release] = await db
      .insert(schema.releases)
      .values({
        applicationId,
        version: '1.0.0',
        gitSha: 'abc1234',
        imageDigest: '111122223333.dkr.ecr.us-east-1.amazonaws.com/deployz-images@sha256:' + 'a'.repeat(64),
        buildStatus: 'SUCCEEDED',
        releaseStatus: 'READY',
      })
      .returning();

    const payload = await buildInstallPayload(db, deployment!, createConfigStore(db));

    expect(payload['startAfterConfig']).toBe(true);
    expect((payload['parameters'] as Record<string, string>)['paramDesiredCount']).toBe('0');
    expect(payload['redisRequired']).toBe(false);
    expect(payload['manifest']).toMatchObject({ web: { port: 3000 } });
    // Control-plane-minted identity tags — stable internal ids only, with the
    // selected release named because one exists.
    expect(payload['tags']).toEqual({
      'deployz:managed-by': 'deployz',
      'deployz:deployment-id': deploymentId,
      'deployz:application-id': applicationId,
      'deployz:customer-id': customerId,
      'deployz:vendor-id': organizationId,
      'deployz:release-id': release!.id,
      'deployz:environment': 'production',
    });
  });

  // The release-id tag omission itself is covered in @deployz/contracts
  // tags.test.ts; an install can no longer reach it without a release.
  it('refuses the INSTALL payload when no release can be selected (never the template default image)', async () => {
    const [application] = await db
      .insert(schema.applications)
      .values({
        organizationId,
        name: 'Releaseless',
        repoFullName: 'acme/releaseless',
        repoUrl: 'https://github.com/acme/releaseless',
        defaultBranch: 'main',
        analysisStatus: 'COMPLETE',
      })
      .returning();
    const [deployment] = await db
      .insert(schema.deployments)
      .values({
        organizationId,
        applicationId: application!.id,
        customerId,
        region: 'us-east-1',
        state: 'INSTALLING',
        desiredState: { manifest: manifest([MANIFEST_ENV[0]!]) },
        enrollmentCode: 'enrol-releaseless',
      })
      .returning();

    await expect(buildInstallPayload(db, deployment!, createConfigStore(db))).rejects.toMatchObject({
      statusCode: 409,
      code: 'RELEASE_NOT_PUBLISHED',
    });
  });

  it('starts the install normally when nothing waits to be configured', async () => {
    const [application] = await db
      .insert(schema.applications)
      .values({
        organizationId,
        name: 'Bare',
        repoFullName: 'acme/bare-install',
        repoUrl: 'https://github.com/acme/bare-install',
        defaultBranch: 'main',
        analysisStatus: 'COMPLETE',
      })
      .returning();
    await db.insert(schema.releases).values({
      applicationId: application!.id,
      version: '1.0.0',
      gitSha: 'abc1234',
      imageDigest: '111122223333.dkr.ecr.us-east-1.amazonaws.com/deployz-images@sha256:' + 'b'.repeat(64),
      buildStatus: 'SUCCEEDED',
      releaseStatus: 'READY',
    });
    const [deployment] = await db
      .insert(schema.deployments)
      .values({
        organizationId,
        applicationId: application!.id,
        customerId,
        region: 'us-east-1',
        state: 'INSTALLING',
        desiredState: { manifest: manifest([MANIFEST_ENV[0]!, MANIFEST_ENV[4]!]) },
        enrollmentCode: 'enrol-bare-install',
      })
      .returning();

    const payload = await buildInstallPayload(db, deployment!, createConfigStore(db));

    expect(payload['startAfterConfig']).toBeUndefined();
    expect((payload['parameters'] as Record<string, string>)['paramDesiredCount']).toBeUndefined();
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
      payload: { reason: 'install' },
    });
    expect([...((jobs[0]!.payload as { changedKeys: string[] }).changedKeys)].sort()).toEqual(
      ['ENCRYPTION_KEY', 'JWT_SECRET', 'LICENSE_KEY', 'LOG_LEVEL', 'OIDC_CLIENT_SECRET', 'SESSION_SECRET'],
    );
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

  it('mints only SECRET_KEY/UTILS_SECRET for an outline manifest produced by the fixed analyser (DEPLOY-030)', async () => {
    const [application] = await db
      .insert(schema.applications)
      .values({
        organizationId,
        name: 'Outline',
        repoFullName: 'acme/outline',
        repoUrl: 'https://github.com/acme/outline',
        defaultBranch: 'main',
        analysisStatus: 'COMPLETE',
      })
      .returning();
    const [deployment] = await db
      .insert(schema.deployments)
      .values({
        organizationId,
        applicationId: application!.id,
        customerId,
        region: 'us-east-1',
        state: 'INSTALLING',
        desiredState: { manifest: manifest(OUTLINE_MANIFEST_ENV) },
        enrollmentCode: 'enrol-outline',
      })
      .returning();

    const entries = await buildRelayConfigEntries(db, deployment!, createConfigStore(db));

    expect([...entries].sort((a, b) => a.key.localeCompare(b.key))).toEqual([
      { key: 'SECRET_KEY', isSecret: true, source: 'generated', generated: true },
      { key: 'UTILS_SECRET', isSecret: true, source: 'generated', generated: true },
    ]);
  });
});
