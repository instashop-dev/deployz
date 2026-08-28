import { PGlite } from '@electric-sql/pglite';
import { eq } from 'drizzle-orm';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { applyMigrations, createDb, type Db } from '@deployz/db';
import * as schema from '@deployz/db/schema';

import {
  handleMessage,
  recordBuildResult,
  resolveBuildContext,
  summarizeBuildFailure,
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
  const analysedForce: (boolean | undefined)[] = [];

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
      async runAnalysis(id, options) {
        analysed.push(id);
        analysedForce.push(options?.force);
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
    expect(analysedForce.at(-1)).toBeUndefined();
  });

  // Task 6 commit-SHA analysis cache: the queue message's `force` flag must
  // reach `runAnalysis` so a vendor-triggered re-analyse can bypass the
  // cache, not just an auto-triggered one.
  it('threads the ANALYSE_APPLICATION message force flag through to runAnalysis', async () => {
    await handleMessage(deps(), { type: 'ANALYSE_APPLICATION', applicationId, force: true }, 'msg-1-force');
    expect(analysedForce.at(-1)).toBe(true);
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
    // `docker/Dockerfile` is the repo-root-context convention: the build
    // must be told to build from `.`, not the Dockerfile's own directory.
    expect(build?.environmentVariables).toContainEqual({ name: 'BUILD_CONTEXT', value: '.' });

    const [row] = await db.select().from(schema.releases).where(eq(schema.releases.id, release.id));
    expect(row?.buildStatus).toBe('BUILDING');
  });

  it('does not pass BUILD_CONTEXT for a non-`docker/` Dockerfile path', async () => {
    const [application] = await db
      .insert(schema.applications)
      .values({
        organizationId,
        name: 'Backend App',
        githubInstallationId: '4242',
        repoFullName: 'acme/backend',
        repoUrl: 'https://github.com/acme/backend',
        defaultBranch: 'main',
        detectedMetadata: { dockerfilePath: 'backend/Dockerfile' },
      })
      .returning();
    const [release] = await db
      .insert(schema.releases)
      .values({ applicationId: application!.id, version: 'v1.1.0', gitSha: 'abc124' })
      .returning();

    await handleMessage(deps(), { type: 'BUILD_RELEASE', releaseId: release!.id }, 'msg-2b');

    const build = started[started.length - 1];
    expect(build?.environmentVariables).toContainEqual({
      name: 'DOCKERFILE_PATH',
      value: 'backend/Dockerfile',
    });
    expect(build?.environmentVariables.some((v) => v.name === 'BUILD_CONTEXT')).toBe(false);
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

  describe('resolveBuildContext', () => {
    it('returns "." for a top-level docker/ Dockerfile', () => {
      expect(resolveBuildContext('docker/Dockerfile')).toBe('.');
    });

    it('returns undefined for a root Dockerfile', () => {
      expect(resolveBuildContext('Dockerfile')).toBeUndefined();
    });

    it('returns undefined for a Dockerfile in another subdirectory', () => {
      expect(resolveBuildContext('backend/Dockerfile')).toBeUndefined();
    });
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
        // Single-use enrollment code the bootstrap stack carries; NOT NULL,
        // because a deployment no relay can ever enrol with is not a
        // deployment.
        enrollmentCode: randomUUID(),
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

  function buildEvent(
    releaseId: string,
    status: string,
    digest?: string,
    phases?: NonNullable<CodeBuildStateChangeEvent['detail']['additional-information']>['phases'],
  ): CodeBuildStateChangeEvent {
    return {
      'detail-type': 'CodeBuild Build State Change',
      detail: {
        'build-status': status,
        'additional-information': {
          environment: { 'environment-variables': [{ name: 'RELEASE_ID', value: releaseId }] },
          ...(phases ? { phases } : {}),
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

  // Task 8: the release failure reason (currently only logged — §36's
  // `releases` table has no failure-reason column) should carry the failed
  // phase's own context instead of the bare CodeBuild status, so an operator
  // reading the log knows which phase broke and why.
  describe('summarizeBuildFailure', () => {
    it('surfaces the failed phase context', () => {
      const event = buildEvent('release-x', 'FAILED', undefined, [
        {
          'phase-type': 'BUILD',
          'phase-status': 'FAILED',
          'phase-context': ['COMMAND_EXECUTION_ERROR: exit status 1: npm install failed'],
        },
      ]);

      const reason = summarizeBuildFailure(event);

      expect(reason).toContain('Build failed in BUILD');
      expect(reason).toContain('npm install failed');
    });

    it('redacts credentials embedded in the phase context', () => {
      const event = buildEvent('release-x', 'FAILED', undefined, [
        {
          'phase-type': 'DOWNLOAD_SOURCE',
          'phase-status': 'FAILED',
          'phase-context': ['fatal: could not read from https://user:token@github.com/x'],
        },
      ]);

      const reason = summarizeBuildFailure(event);

      expect(reason).not.toContain('user:token');
      expect(reason).toContain('https://[REDACTED]@github.com/x');
    });

    it('falls back to the bare status when the event has no phase info', () => {
      const event = buildEvent('release-x', 'FAILED');

      expect(summarizeBuildFailure(event)).toBe('CodeBuild reported FAILED');
    });
  });

  it('logs the failed phase context as the release failure reason', async () => {
    const release = await insertRelease('v2.1.1');
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await recordBuildResult(
      db,
      buildEvent(release.id, 'FAILED', undefined, [
        {
          'phase-type': 'BUILD',
          'phase-status': 'FAILED',
          'phase-context': ['COMMAND_EXECUTION_ERROR: exit status 1: npm install failed'],
        },
      ]),
    );

    expect(consoleSpy.mock.calls.some((call) => String(call[0]).includes('npm install failed'))).toBe(
      true,
    );
    consoleSpy.mockRestore();
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
