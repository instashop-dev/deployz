import { PGlite } from '@electric-sql/pglite';
import { eq } from 'drizzle-orm';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { applyMigrations, createDb, type Db } from '@deployz/db';
import * as schema from '@deployz/db/schema';

import {
  handleMessage,
  recordBuildResult,
  type CodeBuildStateChangeEvent,
  type WorkerDeps,
} from '../src/lambda/worker.js';

// The worker is what makes a queued job actually happen. Every case below is
// a step that silently did nothing before it existed: an analysis that never
// ran, a release that stayed BUILDING for ever, a config write that never
// reached the relay.
describe('worker handler', () => {
  let client: PGlite | undefined;
  let db: Db;
  let organizationId: string;
  let applicationId: string;
  let customerId: string;

  const started: { projectName: string; environmentVariables: { name: string; value: string }[] }[] =
    [];
  const uploaded: { bucket: string; key: string }[] = [];
  const analysed: string[] = [];

  function deps(): WorkerDeps {
    return {
      db: db,
      fetchFn: (async () => ({
        status: 200,
        headers: { get: () => null },
        json: async () => ({ token: 'ghs_test', expires_at: '2099-01-01T00:00:00Z' }),
        arrayBuffer: async () => new TextEncoder().encode('tarball').buffer,
        text: async () => '',
      })) as unknown as WorkerDeps['fetchFn'],
      s3: {
        async putObject(params) {
          uploaded.push({ bucket: params.bucket, key: params.key });
        },
      },
      async startBuild(input) {
        started.push(input);
      },
      async runAnalysis(id) {
        analysed.push(id);
      },
    };
  }

  beforeAll(async () => {
    process.env.GITHUB_APP_ID = 'test-app';
    // A real key: minting the installation token signs an RS256 JWT, so a
    // placeholder string fails inside node:crypto rather than in our code.
    process.env.GITHUB_APP_PRIVATE_KEY = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    }).privateKey;
    process.env.SOURCE_BUCKET = 'source-bucket';
    process.env.BUILD_PROJECT_NAME = 'deployz-build';

    client = new PGlite();
    await applyMigrations(client);
    db = createDb(client);

    const [org] = await db
      .insert(schema.organization)
      .values({ id: 'org-worker', name: 'Worker Org', slug: 'worker-org-1234' })
      .returning();
    organizationId = org!.id;

    const [application] = await db
      .insert(schema.applications)
      .values({
        organizationId,
        name: 'Docs App',
        githubInstallationId: '4242',
        repoFullName: 'acme/docs',
        repoUrl: 'https://github.com/acme/docs',
        defaultBranch: 'main',
        detectedMetadata: { dockerfilePath: 'docker/Dockerfile' },
      })
      .returning();
    applicationId = application!.id;

    const [customer] = await db
      .insert(schema.customers)
      .values({ organizationId, name: 'Acme', email: 'ops@acme.test' })
      .returning();
    customerId = customer!.id;
  }, 60_000);

  afterAll(async () => {
    await client?.close();
  });

  async function insertRelease(version: string) {
    const [release] = await db
      .insert(schema.releases)
      .values({ applicationId, version, gitSha: 'abc123' })
      .returning();
    return release!;
  }

  it('runs the analysis for an ANALYSE_APPLICATION message', async () => {
    await handleMessage(deps(), { type: 'ANALYSE_APPLICATION', applicationId }, 'msg-1');
    expect(analysed).toEqual([applicationId]);
  });

  it('uploads the source and starts a build for BUILD_RELEASE', async () => {
    const release = await insertRelease('v1.0.0');

    await handleMessage(deps(), { type: 'BUILD_RELEASE', releaseId: release.id }, 'msg-2');

    expect(uploaded).toEqual([
      { bucket: 'source-bucket', key: `build-source/${applicationId}/${release.id}/abc123.tar.gz` },
    ]);
    const build = started[0];
    expect(build?.projectName).toBe('deployz-build');
    // The build must be able to find the release again when it finishes, and
    // must build the Dockerfile the analyser actually found.
    expect(build?.environmentVariables).toContainEqual({ name: 'RELEASE_ID', value: release.id });
    expect(build?.environmentVariables).toContainEqual({
      name: 'DOCKERFILE_PATH',
      value: 'docker/Dockerfile',
    });

    const [row] = await db.select().from(schema.releases).where(eq(schema.releases.id, release.id));
    expect(row?.buildStatus).toBe('BUILDING');
  });

  it('fails the release when the application has no GitHub installation', async () => {
    const [application] = await db
      .insert(schema.applications)
      .values({
        organizationId,
        name: 'Unlinked',
        repoFullName: 'acme/unlinked',
        repoUrl: 'https://github.com/acme/unlinked',
        defaultBranch: 'main',
      })
      .returning();
    const [release] = await db
      .insert(schema.releases)
      .values({ applicationId: application!.id, version: 'v0.1.0', gitSha: 'def456' })
      .returning();

    await handleMessage(deps(), { type: 'BUILD_RELEASE', releaseId: release!.id }, 'msg-3');

    const [row] = await db.select().from(schema.releases).where(eq(schema.releases.id, release!.id));
    expect(row?.buildStatus).toBe('FAILED');
    expect(row?.releaseStatus).toBe('FAILED');
  });

  it('creates a relay job per deployment for CONFIG_UPDATE', async () => {
    const [deployment] = await db
      .insert(schema.deployments)
      .values({
        organizationId,
        applicationId,
        customerId,
        region: 'us-east-1',
        installationId: randomUUID(),
      })
      .returning();

    const message = {
      type: 'CONFIG_UPDATE' as const,
      customerId,
      entries: [{ key: 'API_KEY', value: 'secret', isSecret: true }],
    };
    await handleMessage(deps(), message, 'msg-4');
    // A redelivery of the same message must not create a second job.
    await handleMessage(deps(), message, 'msg-4');

    const jobs = await db
      .select()
      .from(schema.deploymentJobs)
      .where(eq(schema.deploymentJobs.deploymentId, deployment!.id));
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.type).toBe('CONFIG_UPDATE');
  });

  function buildEvent(releaseId: string, status: string, digest?: string): CodeBuildStateChangeEvent {
    return {
      'detail-type': 'CodeBuild Build State Change',
      detail: {
        'build-status': status,
        'additional-information': {
          environment: { 'environment-variables': [{ name: 'RELEASE_ID', value: releaseId }] },
        },
        ...(digest
          ? { 'exported-environment-variables': [{ name: 'IMAGE_DIGEST', value: digest }] }
          : {}),
      },
    };
  }

  it('records the image digest when a build succeeds', async () => {
    const release = await insertRelease('v2.0.0');
    const digest =
      'acme/docs@sha256:1111111111111111111111111111111111111111111111111111111111111111';

    await recordBuildResult(
      db,
      buildEvent(release.id, 'SUCCEEDED', digest),
    );

    const [row] = await db.select().from(schema.releases).where(eq(schema.releases.id, release.id));
    expect(row?.imageDigest).toBe(digest);
    expect(row?.buildStatus).toBe('SUCCEEDED');
    expect(row?.releaseStatus).toBe('READY');
  });

  it('fails the release when a build fails', async () => {
    const release = await insertRelease('v2.1.0');

    await recordBuildResult(db, buildEvent(release.id, 'FAILED'));

    const [row] = await db.select().from(schema.releases).where(eq(schema.releases.id, release.id));
    expect(row?.buildStatus).toBe('FAILED');
    expect(row?.imageDigest).toBeNull();
  });

  // A success with no digest is not a usable release: §21 pins deployments to
  // the digest, so "SUCCEEDED, digest unknown" must not read as ready.
  it('fails the release when a successful build reports no digest', async () => {
    const release = await insertRelease('v2.2.0');

    await recordBuildResult(db, buildEvent(release.id, 'SUCCEEDED'));

    const [row] = await db.select().from(schema.releases).where(eq(schema.releases.id, release.id));
    expect(row?.buildStatus).toBe('FAILED');
  });
});
