import { PGlite } from '@electric-sql/pglite';
import crypto from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { DeploymentManifest } from '@deployz/contracts';
import { applyMigrations, createDb, type Db } from '@deployz/db';
import * as schema from '@deployz/db/schema';

import { createAuth, type Auth } from './auth.js';
import { applicationToManifestOverrides, readStoredManifest } from './manifest.js';
import { buildServer } from './server.js';

// Phase 2 boundary — canonical deployment manifest: vendor overrides flow into
// the final manifest, the manifest is persisted on deployments.desired_state,
// and the readiness gate blocks NOT_COMPATIBLE / NEEDS_CONFIGURATION BEFORE any
// deployment row exists.

const READY_METADATA = {
  hasDockerfile: true,
  dockerfilePath: 'Dockerfile',
  framework: 'express',
  port: '3000',
  startupCommands: ['node dist/index.js'],
  hasStartupCommand: true,
  usesPostgresql: false,
  postgres: { required: false, evidence: [] },
  usesRedis: false,
  redis: { required: false, confidence: 'low', purposes: [], evidence: [], connectionEnvVars: [], compatibility: { supported: true } },
  usesS3: false,
  usesLocalFilesystem: false,
  usesWorkerProcesses: false,
  hasMigrationCommand: false,
  hasEnvVars: false,
  hasExternalServices: false,
  hasBuildCommand: false,
  buildCommands: ['npm run build'],
  envVars: ['NODE_ENV'],
  databaseState: 'none',
  externalServices: [] as string[],
} as Record<string, unknown>;

describe('deployment manifest — overrides, persistence and readiness gate', () => {
  let client: PGlite | undefined;
  let db: Db;
  let auth: Auth;
  let app: FastifyInstance;
  let cookie: string;
  let organizationId: string;
  let applicationId: string;
  let customerId: string;

  function post(path: string, body: unknown) {
    return app.inject({
      method: 'POST',
      url: path,
      headers: { cookie, 'content-type': 'application/json' },
      payload: JSON.stringify(body),
    });
  }

  function patch(path: string, body: unknown) {
    return app.inject({
      method: 'PATCH',
      url: path,
      headers: { cookie, 'content-type': 'application/json' },
      payload: JSON.stringify(body),
    });
  }

  async function createApplication(metadata: Record<string, unknown> | null): Promise<string> {
    const [row] = await db
      .insert(schema.applications)
      .values({
        organizationId,
        name: 'Manifest App',
        repoFullName: `acme/manifest-${crypto.randomUUID().slice(0, 8)}`,
        repoUrl: 'https://github.com/acme/manifest',
        defaultBranch: 'main',
        detectedMetadata: metadata,
      })
      .returning();
    return row!.id;
  }

  beforeAll(async () => {
    client = new PGlite();
    await applyMigrations(client);
    db = createDb(client);
    auth = createAuth(db);

    const email = 'manifest@example.com';
    const password = 'super-secret-1';
    await auth.api.signUpEmail({ body: { email, password, name: 'Manifest' } });
    const signin = await auth.api.signInEmail({ body: { email, password }, asResponse: true });
    const setCookie = signin.headers.get('set-cookie');
    if (!setCookie) throw new Error('no session cookie');
    cookie = setCookie;

    app = await buildServer({ auth, db });

    const memberships = await db
      .select({ organizationId: schema.member.organizationId })
      .from(schema.member)
      .limit(1);
    organizationId = memberships[0]!.organizationId;

    const [customer] = await db
      .insert(schema.customers)
      .values({ organizationId, name: 'Cust', email: `cust-${crypto.randomUUID()}@example.com` })
      .returning();
    customerId = customer!.id;
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await client?.close();
  });

  it('creates a deployment with the final manifest in desired_state (rollback can read it)', async () => {
    applicationId = await createApplication(READY_METADATA);

    const response = await post('/api/deployments', {
      applicationId,
      customerId,
      region: 'us-east-1',
    });
    expect(response.statusCode, response.body).toBe(201);

    const [row] = await db
      .select()
      .from(schema.deployments)
      .where(eq(schema.deployments.applicationId, applicationId))
      .limit(1);
    const manifest = readStoredManifest(row!.desiredState);
    expect(manifest).not.toBeNull();
    expect(manifest!.application).toEqual({
      root: '.',
      runtime: 'node',
      framework: 'express',
      dockerfilePath: 'Dockerfile',
    });
    expect(manifest!.web).toEqual({ command: 'node dist/index.js', port: 3000 });
    expect(manifest!.unsupported).toEqual([]);
  });

  it('vendor overrides on PATCH flow into the persisted manifest', async () => {
    const appId = await createApplication(READY_METADATA);
    const patchResponse = await patch(`/api/applications/${appId}`, {
      appRoot: 'apps/web',
      dockerfilePath: 'apps/web/Dockerfile.prod',
      buildContext: 'apps/web',
      buildCommand: 'pnpm build',
      startCommand: 'pnpm start',
      containerPort: 8080,
      healthPath: '/api/health',
      migrationCommand: 'pnpm db:migrate',
      redisRequired: true,
    });
    expect(patchResponse.statusCode, patchResponse.body).toBe(200);

    const createResponse = await post('/api/deployments', {
      applicationId: appId,
      customerId,
      region: 'us-east-1',
    });
    expect(createResponse.statusCode, createResponse.body).toBe(201);

    const [row] = await db
      .select()
      .from(schema.deployments)
      .where(eq(schema.deployments.applicationId, appId))
      .limit(1);
    const manifest = readStoredManifest(row!.desiredState)!;
    expect(manifest.application).toEqual({
      root: 'apps/web',
      runtime: 'node',
      framework: 'express',
      dockerfilePath: 'apps/web/Dockerfile.prod',
    });
    expect(manifest.build).toEqual({ command: 'pnpm build', context: 'apps/web' });
    expect(manifest.web).toEqual({ command: 'pnpm start', port: 8080 });
    expect(manifest.health.path).toBe('/api/health');
    expect(manifest.migration.command).toBe('pnpm db:migrate');
    expect(manifest.redis.required).toBe(true);
    expect(manifest.redis.envBindings.length).toBeGreaterThan(0);
  });

  it('blocks NOT_COMPATIBLE applications before deployment creation (422 MANIFEST_NOT_COMPATIBLE)', async () => {
    const appId = await createApplication({
      ...READY_METADATA,
      databaseState: 'unsupported',
      redis: { required: false, compatibility: { supported: true } },
    } as Record<string, unknown>);

    const response = await post('/api/deployments', {
      applicationId: appId,
      customerId,
      region: 'us-east-1',
    });
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ error: { code: 'MANIFEST_NOT_COMPATIBLE' } });
    const findings = (response.json() as { error: { details: { findings: unknown[] } } }).error.details
      .findings;
    expect(findings.length).toBeGreaterThan(0);
  });

  it('blocks missing-config applications (422 MANIFEST_NEEDS_CONFIGURATION), then allows once overridden', async () => {
    const appId = await createApplication(null);

    const blocked = await post('/api/deployments', {
      applicationId: appId,
      customerId,
      region: 'us-east-1',
    });
    expect(blocked.statusCode).toBe(422);
    expect(blocked.json()).toMatchObject({ error: { code: 'MANIFEST_NEEDS_CONFIGURATION' } });

    // The vendor corrects the manifest-only fields — the same application now
    // passes the gate.
    await patch(`/api/applications/${appId}`, {
      dockerfilePath: 'Dockerfile',
      startCommand: 'npm start',
      containerPort: 3000,
    });
    const allowed = await post('/api/deployments', {
      applicationId: appId,
      customerId,
      region: 'us-east-1',
    });
    expect(allowed.statusCode, allowed.body).toBe(201);
  });

 it('applicationToManifestOverrides prefers columns over stored overrides and skips empties', () => {
    const overrides = applicationToManifestOverrides({
      containerPort: 8080,
      healthPath: '/api/health',
      migrationCommand: 'npm run db:migrate',
      workerCommand: null,
      databaseRequired: true,
      storageRequired: false,
      redisRequired: true,
      detectedMetadata: {
        manifestOverrides: {
          appRoot: 'apps/web',
          dockerfilePath: 'apps/web/Dockerfile',
          buildContext: 'apps/web',
          buildCommand: 'pnpm build',
          startCommand: 'stale-value',
          port: 1111,
        },
      },
    });
    expect(overrides.port).toBe(8080); // column wins over stored override
    expect(overrides.startCommand).toBe('stale-value'); // only manifest-override path set
    expect(overrides.appRoot).toBe('apps/web');
    expect(overrides.buildCommand).toBe('pnpm build');
  });

  it('readStoredManifest returns null for missing or malformed manifests', () => {
    expect(readStoredManifest(null)).toBeNull();
    expect(readStoredManifest({})).toBeNull();
    expect(readStoredManifest({ manifest: { not: 'a manifest' } })).toBeNull();
  });

  it('readStoredManifest round-trips a persisted manifest', () => {
    const manifest: DeploymentManifest = {
      application: { root: '.', runtime: 'node', framework: null, dockerfilePath: 'Dockerfile' },
      build: { command: null, context: '.' },
      web: { command: 'npm start', port: 3000 },
      health: { path: '/health' },
      database: { postgres: false },
      redis: { required: false, envBindings: [] },
      storage: { required: false, envBindings: [] },
      migration: { command: null },
      worker: { command: null },
      environment: { variables: [] },
      externalServices: [],
      unsupported: [],
    };
    expect(readStoredManifest({ manifest })).toEqual(manifest);
  });
});