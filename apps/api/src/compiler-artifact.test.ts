import { PGlite } from '@electric-sql/pglite';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  bootstrapTemplateBucketName,
  deploymentSpecV2Schema,
  requirementsFromSpec,
} from '@deployz/contracts';
import { applyMigrations, createDb, type Db } from '@deployz/db';
import * as schema from '@deployz/db/schema';

import {
  compilerArtifactKey,
  compilerArtifactPublishInput,
  compilerArtifactUrl,
  compileDeploymentIntent,
  NO_OP_TEMPLATE_PUBLISHER,
  type PublishTemplateInput,
} from './compiler-artifact.js';
import { createDeploymentRecord } from './deploy-links.js';
import { normalizeDeploymentManifest } from '@deployz/analysis';

// Compiler-v2 provisioning intent: creation compiles the frozen manifest,
// publishes the artifact BEFORE the row is written, and persists the
// completed spec. The publisher is injectable; a failure fails creation
// closed (no row without its artifact).

/** Full §18 analysis metadata so the creation preflight passes. */
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

const MANIFEST = normalizeDeploymentManifest(
  { metadata: {} },
  {
    appRoot: '.',
    port: 3000,
    healthPath: '/health',
    migrationCommand: null,
    workerCommand: null,
    databaseRequired: true,
    storageRequired: false,
    redisRequired: false,
  },
) as unknown as Parameters<typeof compileDeploymentIntent>[0]['manifest'];

describe('compileDeploymentIntent', () => {
  it('produces a completed, schema-valid spec with a deterministic content address', () => {
    const first = compileDeploymentIntent({ manifest: MANIFEST, region: 'us-east-1' });
    const second = compileDeploymentIntent({ manifest: MANIFEST, region: 'us-east-1' });

    expect(first.templateHash).toBe(second.templateHash);
    expect(first.spec.compilerVersion).toBe('dynamic-compiler-v2-1');
    expect(first.spec.templateHash).toBe(first.templateHash);
    expect(first.spec.artifactLocation).toBe(compilerArtifactUrl('us-east-1', first.templateHash));
    // The published spec re-parses from its stored JSON form.
    expect(deploymentSpecV2Schema.safeParse(JSON.parse(JSON.stringify(first.spec))).success).toBe(true);

    // The verification contract proves database + storage (+ compute/ingress);
    // storage is unconditional — the compiler always emits S3.
    expect(requirementsFromSpec(first.spec)).toEqual({ databaseRequired: true, redisRequired: false });
    const checks = first.spec.verificationContract!.checks.map((check) => check.check).sort();
    expect(checks).toEqual(['compute', 'database', 'ingress', 'storage']);
    // One ownership record per compiled logical resource, all unpublished.
    expect(first.spec.ownershipRecords!.length).toBeGreaterThan(0);
    for (const record of first.spec.ownershipRecords!) {
      expect(record.physicalResourceId).toBeNull();
    }
    expect(first.spec.footprint!.region).toBe('us-east-1');
  });
});

describe('artifact addressing', () => {
  it('keys artifacts by template hash in the region template bucket, no-overwrite URL', () => {
    const input = compilerArtifactPublishInput('eu-west-1', 'abc123', '{"Resources":{}}');
    expect(input.bucket).toBe(bootstrapTemplateBucketName('eu-west-1'));
    expect(input.bucket).toBe('deployz-templates-eu-west-1');
    expect(input.key).toBe('compiler-v2/abc123.json');
    expect(input.key).toBe(compilerArtifactKey('abc123'));
    expect(input.body).toBe('{"Resources":{}}');
    expect(compilerArtifactUrl('eu-west-1', 'abc123')).toBe(
      'https://deployz-templates-eu-west-1.s3.eu-west-1.amazonaws.com/compiler-v2/abc123.json',
    );
  });

  it('the default publisher is a no-op', async () => {
    await expect(NO_OP_TEMPLATE_PUBLISHER.publishTemplate({
      region: 'us-east-1',
      bucket: 'deployz-templates-us-east-1',
      key: 'compiler-v2/x.json',
      body: '{}',
    })).resolves.toBeUndefined();
  });
});

describe('createDeploymentRecord compiles, publishes, then persists', () => {
  let client: PGlite | undefined;
  let db: Db;
  let applicationId: string;
  let customerId: string;
  const organizationId = 'org-compiler-artifact';

  beforeAll(async () => {
    client = new PGlite();
    await applyMigrations(client);
    db = createDb(client);
    await db.insert(schema.organization).values({ id: organizationId, name: 'Acme', slug: organizationId });
    const [application] = await db
      .insert(schema.applications)
      .values({
        organizationId,
        name: 'Compiler App',
        repoFullName: 'acme/compiler-artifact',
        repoUrl: 'https://github.com/acme/compiler-artifact',
        defaultBranch: 'main',
        analysisStatus: 'COMPLETE',
        detectedMetadata: READY_METADATA,
        containerPort: 3000,
        healthPath: '/health',
        migrationCommand: 'npm run migrate',
        databaseRequired: true,
        storageRequired: false,
        redisRequired: false,
      })
      .returning();
    applicationId = application!.id;
    const [customer] = await db
      .insert(schema.customers)
      .values({ organizationId, name: 'Customer', email: 'compiler@example.com' })
      .returning();
    customerId = customer!.id;
    await db.insert(schema.releases).values({
      applicationId,
      version: '1.0.0',
      gitSha: 'a'.repeat(40),
      releaseStatus: 'READY',
      imageDigest: `123456789012.dkr.ecr.us-east-1.amazonaws.com/deployz-fixture@sha256:${'b'.repeat(64)}`,
    });
  }, 60_000);

  afterAll(async () => {
    await client?.close();
  });

  function createParams() {
    return {
      organizationId,
      applicationId,
      customerId,
      region: 'us-east-1' as const,
      deploymentType: 'TEST' as const,
      createdBy: null,
      updatedBy: null,
      source: 'manual' as const,
    };
  }

  it('publishes to the right bucket/key before inserting, and persists the completed spec', async () => {
    const published: PublishTemplateInput[] = [];
    let rowCountDuringPublish = -1;
    const { deployment } = await createDeploymentRecord(db, createParams(), {
      templatePublisher: {
        async publishTemplate(input) {
          published.push(input);
          // Publish runs BEFORE the DB write: no row can exist yet.
          const rows = await db
            .select({ id: schema.deployments.id })
            .from(schema.deployments)
            .where(eq(schema.deployments.organizationId, organizationId));
          rowCountDuringPublish = rows.length;
        },
      },
    });

    expect(rowCountDuringPublish).toBe(0);
    expect(published).toHaveLength(1);
    expect(published[0]!.bucket).toBe('deployz-templates-us-east-1');
    expect(published[0]!.key).toBe(compilerArtifactKey((deployment.specV2 as { templateHash: string }).templateHash));
    expect(JSON.parse(published[0]!.body)).toMatchObject({ Resources: expect.any(Object) });

    const spec = deployment.specV2 as Record<string, unknown>;
    expect(deploymentSpecV2Schema.safeParse(spec).success).toBe(true);
    expect(spec['artifactLocation']).toBeTruthy();
    // Row and artifact agree on the content address.
    expect(compilerArtifactKey(spec['templateHash'] as string)).toBe(published[0]!.key);
  });

  it('a publish failure fails creation closed: no row is written', async () => {
    await expect(
      createDeploymentRecord(db, createParams(), {
        templatePublisher: {
          async publishTemplate() {
            throw new Error('S3 unavailable');
          },
        },
      }),
    ).rejects.toThrow('S3 unavailable');

    const rows = await db
      .select({ id: schema.deployments.id })
      .from(schema.deployments)
      .where(eq(schema.deployments.organizationId, organizationId));
    // Only the first test's deployment exists.
    expect(rows).toHaveLength(1);
  });

  it('the same manifest compiles to the same content address on a second deployment', async () => {
    const [first] = await db
      .select({ specV2: schema.deployments.specV2 })
      .from(schema.deployments)
      .where(eq(schema.deployments.organizationId, organizationId));
    // The one-active-TEST-per-application index requires the previous
    // deployment to be DELETED before a replacement TEST is created.
    await db
      .update(schema.deployments)
      .set({ state: 'DELETED' })
      .where(eq(schema.deployments.organizationId, organizationId));
    const { deployment: second } = await createDeploymentRecord(db, createParams());

    expect((second.specV2 as { templateHash: string }).templateHash).toBe(
      (first!.specV2 as { templateHash: string }).templateHash,
    );
  });
});

describe('createS3TemplatePublisher', () => {
  it('treats an already-published artifact (412 PreconditionFailed) as success', async () => {
    // Same IR -> same templateHash -> same content-addressed key: the
    // conditional put loses the race on every deployment after the first,
    // and the stored object is byte-identical by construction.
    const send = vi.fn().mockRejectedValue({ name: 'PreconditionFailed' });
    // The file's static imports already loaded the real module — drop it
    // from the registry so the doMock applies to the re-import.
    vi.resetModules();
    vi.doMock('@aws-sdk/client-s3', () => ({
      S3Client: class {
        send = send;
        destroy = () => {};
      },
      PutObjectCommand: class {
        constructor(public input: Record<string, unknown>) {}
      },
    }));
    const { createS3TemplatePublisher } = await import('./compiler-artifact.js');
    await expect(
      createS3TemplatePublisher().publishTemplate({
        region: 'us-east-1',
        bucket: 'deployz-templates-us-east-1',
        key: 'compiler-v2/abc123.json',
        body: '{"Resources":{}}',
      }),
    ).resolves.toBeUndefined();
    expect(send).toHaveBeenCalledOnce();
  });
});
