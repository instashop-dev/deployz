import { PGlite } from '@electric-sql/pglite';
import { eq, inArray } from 'drizzle-orm';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { applyMigrations, createDb, type Db } from '@deployz/db';
import * as schema from '@deployz/db/schema';

import {
  buildFailureDetail,
  handleMessage,
  normalizeBuildId,
  recordBuildResult,
  resolveBuildContext,
  sweepRelayLiveness,
  sweepStuckBuilds,
  sweepStuckJobs,
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
        // StartBuild resolves the short "project:uuid" form, not an ARN.
        return `deployz-build:started-${started.length}`;
      },
      async batchGetBuilds() {
        return [];
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
        // A state a relay can actually act on — pre-install and removed
        // deployments are skipped by the fanout (see configUpdate).
        state: 'HEALTHY',
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
      changedKeys: ['API_KEY', 'DATABASE_URL'],
      // Newly-entered secret values ride the job payload transiently so the
      // relay can persist them into the customer's Secrets Manager.
      secrets: [{ key: 'DATABASE_URL', value: 'postgres://relay-transport-only' }],
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
    // The durable payload carries the transport values exactly once here;
    // `GET /api/relay/commands` serves them to the relay and scrubs the
    // stored row in the same request (see `redactClaimedPayload`).
    expect(jobs[0]?.payload).toEqual({
      changedKeys: ['API_KEY', 'DATABASE_URL'],
      secrets: [{ key: 'DATABASE_URL', value: 'postgres://relay-transport-only' }],
    });

    // A deployment no relay can act on gets no job: nothing is enrolled
    // before install, nothing remains during/after removal.
    await db
      .update(schema.deployments)
      .set({ state: 'DELETED' })
      .where(eq(schema.deployments.id, deployment!.id));
    await handleMessage(deps(), { ...message, changedKeys: ['OTHER'] }, 'msg-5');
    const after = await db
      .select()
      .from(schema.deploymentJobs)
      .where(eq(schema.deploymentJobs.deploymentId, deployment!.id));
    expect(after).toHaveLength(1);
  });

  function buildEvent(
    releaseId: string,
    status: string,
    digest?: string,
    buildId?: string,
  ): CodeBuildStateChangeEvent {
    return {
      'detail-type': 'CodeBuild Build State Change',
      detail: {
        'build-status': status,
        ...(buildId ? { 'build-id': buildId } : {}),
        'additional-information': {
          environment: { 'environment-variables': [{ name: 'RELEASE_ID', value: releaseId }] },
        },
        ...(digest
          ? { 'exported-environment-variables': [{ name: 'IMAGE_DIGEST', value: digest }] }
          : {}),
      },
    };
  }

  const DIGEST_A = 'acme/docs@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const DIGEST_B = 'acme/docs@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

  async function pinBuild(releaseId: string, buildId: string): Promise<void> {
    await db
      .update(schema.releases)
      .set({ currentBuildId: buildId, buildStatus: 'BUILDING', releaseStatus: 'BUILDING' })
      .where(eq(schema.releases.id, releaseId));
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

  it('records the digest when the event nests exported vars under additional-information (real EventBridge shape)', async () => {
    const release = await insertRelease('v2.0.5');
    const digest =
      'acme/docs@sha256:5555555555555555555555555555555555555555555555555555555555555555';

    await recordBuildResult(db, {
      'detail-type': 'CodeBuild Build State Change',
      detail: {
        'build-status': 'SUCCEEDED',
        'additional-information': {
          environment: { 'environment-variables': [{ name: 'RELEASE_ID', value: release.id }] },
          'exported-environment-variables': [{ name: 'IMAGE_DIGEST', value: digest }],
        },
      },
    });

    const [row] = await db.select().from(schema.releases).where(eq(schema.releases.id, release.id));
    expect(row?.imageDigest).toBe(digest);
    expect(row?.releaseStatus).toBe('READY');
  });

  it('fails the release when a build fails', async () => {
    const release = await insertRelease('v2.1.0');

    await recordBuildResult(db, buildEvent(release.id, 'FAILED'));

    const [row] = await db.select().from(schema.releases).where(eq(schema.releases.id, release.id));
    expect(row?.buildStatus).toBe('FAILED');
    expect(row?.imageDigest).toBeNull();
    expect(row?.failureReason).toBe('CodeBuild reported FAILED');
  });

  // A success with no digest is not a usable release: §21 pins deployments to
  // the digest, so "SUCCEEDED, digest unknown" must not read as ready.
  it('fails the release when a successful build reports no digest', async () => {
    const release = await insertRelease('v2.2.0');

    await recordBuildResult(db, buildEvent(release.id, 'SUCCEEDED'));

    const [row] = await db.select().from(schema.releases).where(eq(schema.releases.id, release.id));
    expect(row?.buildStatus).toBe('FAILED');
  });

  // ── Build-attempt correlation ────────────────────────────────────────────

  it('ignores a stale failure arriving after the current build succeeded', async () => {
    const release = await insertRelease('v3.0.0');
    await pinBuild(release.id, 'build-new');
    await recordBuildResult(db, buildEvent(release.id, 'SUCCEEDED', DIGEST_A, 'build-new'));

    await recordBuildResult(db, buildEvent(release.id, 'FAILED', undefined, 'build-old'));

    const [row] = await db.select().from(schema.releases).where(eq(schema.releases.id, release.id));
    expect(row?.releaseStatus).toBe('READY');
    expect(row?.imageDigest).toBe(DIGEST_A);
  });

  it('ignores a stale success arriving after the current build failed', async () => {
    const release = await insertRelease('v3.1.0');
    await pinBuild(release.id, 'build-new');
    await recordBuildResult(db, buildEvent(release.id, 'FAILED', undefined, 'build-new'));

    await recordBuildResult(db, buildEvent(release.id, 'SUCCEEDED', DIGEST_A, 'build-old'));

    const [row] = await db.select().from(schema.releases).where(eq(schema.releases.id, release.id));
    expect(row?.releaseStatus).toBe('FAILED');
    expect(row?.imageDigest).toBeNull();
  });

  it('is idempotent on a duplicate success for the same build', async () => {
    const release = await insertRelease('v3.2.0');
    await pinBuild(release.id, 'build-1');
    await recordBuildResult(db, buildEvent(release.id, 'SUCCEEDED', DIGEST_A, 'build-1'));

    await recordBuildResult(db, buildEvent(release.id, 'SUCCEEDED', DIGEST_B, 'build-1'));

    const [row] = await db.select().from(schema.releases).where(eq(schema.releases.id, release.id));
    expect(row?.releaseStatus).toBe('READY');
    expect(row?.imageDigest).toBe(DIGEST_A);
  });

  it('is idempotent on a duplicate failure for the same build', async () => {
    const release = await insertRelease('v3.3.0');
    await pinBuild(release.id, 'build-1');
    await recordBuildResult(db, buildEvent(release.id, 'FAILED', undefined, 'build-1'));
    await recordBuildResult(db, buildEvent(release.id, 'FAILED', undefined, 'build-1'));

    const [row] = await db.select().from(schema.releases).where(eq(schema.releases.id, release.id));
    expect(row?.releaseStatus).toBe('FAILED');
  });

  it('applies the current successful build', async () => {
    const release = await insertRelease('v3.4.0');
    await pinBuild(release.id, 'build-current');

    await recordBuildResult(db, buildEvent(release.id, 'SUCCEEDED', DIGEST_B, 'build-current'));

    const [row] = await db.select().from(schema.releases).where(eq(schema.releases.id, release.id));
    expect(row?.releaseStatus).toBe('READY');
    expect(row?.imageDigest).toBe(DIGEST_B);
  });

  it('applies the current failed build', async () => {
    const release = await insertRelease('v3.5.0');
    await pinBuild(release.id, 'build-current');

    await recordBuildResult(db, buildEvent(release.id, 'FAILED', undefined, 'build-current'));

    const [row] = await db.select().from(schema.releases).where(eq(schema.releases.id, release.id));
    expect(row?.releaseStatus).toBe('FAILED');
    expect(row?.failureReason).toBe('CodeBuild reported FAILED');
  });

  // StartBuild resolves the short "project:uuid" form of a build id, but the
  // EventBridge state-change event's build-id is the full ARN wrapping that
  // same id. Without normalizing both sides, every real completion event
  // reads as stale and the release never leaves BUILDING (audit blocker N2).
  it('reaches READY from a real build-then-event round trip, where the event carries the ARN form', async () => {
    const release = await insertRelease('v3.6.0');

    await handleMessage(deps(), { type: 'BUILD_RELEASE', releaseId: release.id }, 'msg-n2');
    const [building] = await db
      .select()
      .from(schema.releases)
      .where(eq(schema.releases.id, release.id));
    // buildRelease pins the release to startBuild's short-form return value.
    expect(building?.currentBuildId).not.toContain('arn:');

    const shortBuildId = building!.currentBuildId!;
    const arnBuildId = `arn:aws:codebuild:us-east-1:151955775369:build/${shortBuildId}`;
    await recordBuildResult(db, buildEvent(release.id, 'SUCCEEDED', DIGEST_A, arnBuildId));

    const [row] = await db.select().from(schema.releases).where(eq(schema.releases.id, release.id));
    expect(row?.releaseStatus).toBe('READY');
    expect(row?.imageDigest).toBe(DIGEST_A);
  });
});

describe('normalizeBuildId', () => {
  it('strips an ARN down to the short "project:uuid" form', () => {
    expect(
      normalizeBuildId('arn:aws:codebuild:us-east-1:151955775369:build/deployz-build:some-uuid'),
    ).toBe('deployz-build:some-uuid');
  });

  it('leaves an already-short build id unchanged', () => {
    expect(normalizeBuildId('deployz-build:some-uuid')).toBe('deployz-build:some-uuid');
  });

  it('returns input unchanged when the ":build/" marker is absent', () => {
    expect(normalizeBuildId('some-opaque-id')).toBe('some-opaque-id');
  });
});

describe('buildFailureDetail', () => {
  const event = (phases: unknown): CodeBuildStateChangeEvent =>
    ({
      'detail-type': 'CodeBuild Build State Change',
      detail: {
        'build-status': 'FAILED',
        'additional-information': { phases },
      },
    }) as CodeBuildStateChangeEvent;

  it('returns the first failed phase with its context', () => {
    expect(
      buildFailureDetail(
        event([
          { 'phase-type': 'BUILD', 'phase-status': 'SUCCEEDED', 'phase-context': [': '] },
          {
            'phase-type': 'POST_BUILD',
            'phase-status': 'FAILED',
            'phase-context': [
              'COMMAND_EXECUTION_ERROR: Error while executing command: docker push …. Reason: exit status 1',
            ],
          },
        ]),
      ),
    ).toBe(
      'POST_BUILD: COMMAND_EXECUTION_ERROR: Error while executing command: docker push …. Reason: exit status 1',
    );
  });

  it('returns null when no failed phase carries a context message', () => {
    expect(
      buildFailureDetail(
        event([{ 'phase-type': 'BUILD', 'phase-status': 'FAILED', 'phase-context': [] }]),
      ),
    ).toBeNull();
    expect(buildFailureDetail(event(undefined))).toBeNull();
  });
});

// ── Stuck-job watchdog (Phase 7) ──────────────────────────────────────────

describe('sweepStuckJobs', () => {
  let client: PGlite | undefined;
  let db: Db;
  let organizationId: string;
  let applicationId: string;
  let customerId: string;

  beforeAll(async () => {
    client = new PGlite();
    await applyMigrations(client);
    db = createDb(client);

    const [org] = await db
      .insert(schema.organization)
      .values({ id: 'org-watchdog', name: 'Watchdog Org', slug: 'watchdog-org' })
      .returning();
    organizationId = org!.id;

    const [application] = await db
      .insert(schema.applications)
      .values({
        organizationId,
        name: 'App',
        repoFullName: 'acme/watchdog-app',
        repoUrl: 'https://github.com/acme/watchdog-app',
        defaultBranch: 'main',
      })
      .returning();
    applicationId = application!.id;

    const [customer] = await db
      .insert(schema.customers)
      .values({ organizationId, name: 'Cust', email: 'watchdog@example.test' })
      .returning();
    customerId = customer!.id;
  }, 60_000);

  afterAll(async () => {
    await client?.close();
  });

  async function seedJobAndDeployment(
    type: 'INSTALL' | 'DEPLOY_RELEASE' | 'ROLLBACK' | 'RESTART' | 'CONFIG_UPDATE' | 'DESTROY',
    state: 'REQUESTED' | 'QUEUED' | 'WAITING' | 'RUNNING' | 'SUCCEEDED',
    startedMinutesAgo: number,
    lastProgressMinutesAgo: number | null,
    options: {
      relayStatus?: 'CONNECTED' | 'DISCONNECTED' | 'UNKNOWN';
      reconcileCount?: number;
    } = {},
  ): Promise<{ jobId: string; deploymentId: string }> {
    const [deployment] = await db
      .insert(schema.deployments)
      .values({
        organizationId,
        applicationId,
        customerId,
        region: 'us-east-1',
        state: 'UPDATING',
        relayStatus: options.relayStatus ?? 'UNKNOWN',
        installationId: `inst-${randomUUID()}`,
        enrollmentCode: randomUUID(),
      })
      .returning();

    const started = new Date(Date.now() - startedMinutesAgo * 60 * 1000);
    const [job] = await db
      .insert(schema.deploymentJobs)
      .values({
        deploymentId: deployment!.id,
        type,
        state,
        idempotencyKey: `watchdog:${randomUUID()}`,
        payload: {},
        startedAt: started,
        reconcileCount: options.reconcileCount ?? 0,
        ...(lastProgressMinutesAgo !== null
          ? { lastProgressAt: new Date(Date.now() - lastProgressMinutesAgo * 60 * 1000) }
          : {}),
      })
      .returning();

    return { jobId: job!.id, deploymentId: deployment!.id };
  }

  it('parks a stale job WAITING when the relay is quiet — never a false FAILED', async () => {
    const { jobId, deploymentId } = await seedJobAndDeployment('DEPLOY_RELEASE', 'RUNNING', 30, 25);
    const settled = await sweepStuckJobs(db);
    expect(settled).toBeGreaterThanOrEqual(1);

    const [job] = await db.select().from(schema.deploymentJobs).where(eq(schema.deploymentJobs.id, jobId));
    expect(job?.state).toBe('WAITING');

    // The deployment is untouched: the operation may have finished in AWS
    // and a returning relay resumes from its checkpoint.
    const [deployment] = await db
      .select()
      .from(schema.deployments)
      .where(eq(schema.deployments.id, deploymentId));
    expect(deployment?.state).toBe('UPDATING');

    const events = await db.select().from(schema.eventLogs).where(eq(schema.eventLogs.jobId, jobId));
    expect(events.some((e) => e.eventType === 'operation.waiting_for_relay')).toBe(true);
  });

  it('fails a WAITING job as RELAY_DISCONNECTED once the relay grace elapses', async () => {
    // 20-minute timeout + 24h grace, all long exceeded.
    const { jobId, deploymentId } = await seedJobAndDeployment(
      'DEPLOY_RELEASE',
      'WAITING',
      26 * 60,
      25 * 60,
      { relayStatus: 'DISCONNECTED' },
    );
    await sweepStuckJobs(db);

    const [job] = await db.select().from(schema.deploymentJobs).where(eq(schema.deploymentJobs.id, jobId));
    expect(job?.state).toBe('FAILED');
    expect(job?.failureCode).toBe('RELAY_DISCONNECTED');
    expect(job?.result).toMatchObject({ timeout: true });

    const [deployment] = await db
      .select()
      .from(schema.deployments)
      .where(eq(schema.deployments.id, deploymentId));
    expect(deployment?.state).toBe('FAILED');
  });

  it('re-offers a stuck job to a live relay before ever failing it', async () => {
    const { jobId, deploymentId } = await seedJobAndDeployment('DEPLOY_RELEASE', 'RUNNING', 30, 25, {
      relayStatus: 'CONNECTED',
    });
    await sweepStuckJobs(db);

    const [job] = await db.select().from(schema.deploymentJobs).where(eq(schema.deploymentJobs.id, jobId));
    expect(job?.state).toBe('REQUESTED');
    expect(job?.reconcileCount).toBe(1);

    const [deployment] = await db
      .select()
      .from(schema.deployments)
      .where(eq(schema.deployments.id, deploymentId));
    expect(deployment?.state).toBe('UPDATING');

    const events = await db.select().from(schema.eventLogs).where(eq(schema.eventLogs.jobId, jobId));
    expect(events.some((e) => e.eventType === 'operation.requeued')).toBe(true);
  });

  it('re-offers a RUNNING job past its runtime bound even while heartbeats keep it fresh (orphaned invocation)', async () => {
    // A relay invocation died between the AWS mutation and its checkpoint
    // write: heartbeats keep refreshing lastProgressAt, so only the runtime
    // clock can see the job is going nowhere.
    const { jobId } = await seedJobAndDeployment('INSTALL', 'RUNNING', 100, 1, {
      relayStatus: 'CONNECTED',
    });
    await sweepStuckJobs(db);

    const [job] = await db.select().from(schema.deploymentJobs).where(eq(schema.deploymentJobs.id, jobId));
    expect(job?.state).toBe('REQUESTED');
    expect(job?.reconcileCount).toBe(1);
  });

  it('keeps a deployment with a running release live when a day-2 job finally fails', async () => {
    const { jobId, deploymentId } = await seedJobAndDeployment('DEPLOY_RELEASE', 'RUNNING', 30, 25, {
      relayStatus: 'CONNECTED',
      reconcileCount: 3,
    });
    const [release] = await db
      .insert(schema.releases)
      .values({
        applicationId,
        version: `w-${randomUUID().slice(0, 8)}`,
        gitSha: 'abc',
        releaseStatus: 'READY',
        buildStatus: 'SUCCEEDED',
      })
      .returning();
    await db
      .update(schema.deployments)
      .set({ currentReleaseId: release!.id })
      .where(eq(schema.deployments.id, deploymentId));

    await sweepStuckJobs(db);

    const [job] = await db.select().from(schema.deploymentJobs).where(eq(schema.deploymentJobs.id, jobId));
    expect(job?.state).toBe('FAILED');
    expect(job?.result).toMatchObject({ timeout: true, reconcileAttempts: 3 });
    // The previous release is still serving: the deployment returns to a
    // live state instead of FAILED (no newer READY release here -> HEALTHY).
    const [deployment] = await db
      .select()
      .from(schema.deployments)
      .where(eq(schema.deployments.id, deploymentId));
    expect(deployment?.state).toBe('HEALTHY');
  });

  it('leaves the deployment state alone when a CONFIG_UPDATE finally fails', async () => {
    const { jobId, deploymentId } = await seedJobAndDeployment('CONFIG_UPDATE', 'RUNNING', 30, 25, {
      relayStatus: 'CONNECTED',
      reconcileCount: 3,
    });
    await sweepStuckJobs(db);
    const [job] = await db.select().from(schema.deploymentJobs).where(eq(schema.deploymentJobs.id, jobId));
    expect(job?.state).toBe('FAILED');
    const [deployment] = await db
      .select()
      .from(schema.deployments)
      .where(eq(schema.deployments.id, deploymentId));
    expect(deployment?.state).toBe('UPDATING');
  });

  it('records an operation.timeout event with the job evidence', async () => {
    const { jobId } = await seedJobAndDeployment('ROLLBACK', 'RUNNING', 30, 25, {
      relayStatus: 'CONNECTED',
      reconcileCount: 3,
    });
    await sweepStuckJobs(db);

    const events = await db
      .select()
      .from(schema.eventLogs)
      .where(eq(schema.eventLogs.jobId, jobId));
    const timeout = events.find((e) => e.eventType === 'operation.timeout');
    expect(timeout).toBeDefined();
    expect(timeout?.payload).toMatchObject({
      jobType: 'ROLLBACK',
      relayStatus: expect.any(String),
      reconcileCount: 3,
    });
  });

  it('does not sweep a job whose progress is recent', async () => {
    const { jobId } = await seedJobAndDeployment('DEPLOY_RELEASE', 'RUNNING', 10, 5);
    const before = await db
      .select()
      .from(schema.deploymentJobs)
      .where(eq(schema.deploymentJobs.id, jobId));
    await sweepStuckJobs(db);
    const after = await db
      .select()
      .from(schema.deploymentJobs)
      .where(eq(schema.deploymentJobs.id, jobId));
    expect(after[0]?.state).toBe(before[0]?.state);
  });

  it('does not sweep an INSTALL inside its 60-minute budget', async () => {
    const { jobId } = await seedJobAndDeployment('INSTALL', 'RUNNING', 45, 40);
    await sweepStuckJobs(db);
    const [job] = await db.select().from(schema.deploymentJobs).where(eq(schema.deploymentJobs.id, jobId));
    expect(job?.state).toBe('RUNNING');
  });

  it('parks an INSTALL past its 60-minute budget on a quiet relay', async () => {
    const { jobId } = await seedJobAndDeployment('INSTALL', 'RUNNING', 75, 70);
    await sweepStuckJobs(db);
    const [job] = await db.select().from(schema.deploymentJobs).where(eq(schema.deploymentJobs.id, jobId));
    expect(job?.state).toBe('WAITING');
  });

  it('never sweeps a finished job', async () => {
    const { jobId } = await seedJobAndDeployment('DEPLOY_RELEASE', 'SUCCEEDED', 120, 120);
    await sweepStuckJobs(db);
    const [job] = await db.select().from(schema.deploymentJobs).where(eq(schema.deploymentJobs.id, jobId));
    expect(job?.state).toBe('SUCCEEDED');
  });

  // A timed-out DESTROY only ever means the relay is dead (heartbeats refresh
  // lastProgressAt while it lives). Failing it here would strand the
  // deployment in FAILED with no disconnect path; force-complete owns the
  // dead-relay DESTROY instead.
  it('never fails a DESTROY, however stale', async () => {
    const { jobId, deploymentId } = await seedJobAndDeployment('DESTROY', 'RUNNING', 120, 120);
    await sweepStuckJobs(db);
    const [job] = await db.select().from(schema.deploymentJobs).where(eq(schema.deploymentJobs.id, jobId));
    expect(job?.state).toBe('RUNNING');
    const [deployment] = await db
      .select()
      .from(schema.deployments)
      .where(eq(schema.deployments.id, deploymentId));
    expect(deployment?.state).toBe('UPDATING');
  });

  it('re-offers a stale DESTROY to a live relay (but never fails it)', async () => {
    const { jobId } = await seedJobAndDeployment('DESTROY', 'RUNNING', 120, 120, {
      relayStatus: 'CONNECTED',
      reconcileCount: 3,
    });
    await sweepStuckJobs(db);
    // Re-offers exhausted: a DESTROY still never fails from the watchdog —
    // the vendor's force-complete escape hatch owns the dead-end case.
    const [job] = await db.select().from(schema.deploymentJobs).where(eq(schema.deploymentJobs.id, jobId));
    expect(job?.state).toBe('RUNNING');
  });

  // Phase 5 §9.3: CONFIGURE_DOMAIN/REMOVE_DOMAIN previously had no watchdog
  // entry, so a stuck domain job idled in RUNNING forever. Now it is failed
  // with a clear code, the DEPLOYMENT is untouched (separate lifecycle),
  // and the domain row carries the error so the next cycle can retry.
  it('fails a CONFIGURE_DOMAIN stuck past the window with DOMAIN_OPERATION_TIMEOUT, leaving the deployment alone', async () => {
    const [deployment] = await db
      .insert(schema.deployments)
      .values({
        organizationId,
        applicationId,
        customerId,
        region: 'us-east-1',
        state: 'HEALTHY',
        relayStatus: 'CONNECTED',
        installationId: `inst-${randomUUID()}`,
        enrollmentCode: randomUUID(),
      })
      .returning();
    const [domain] = await db
      .insert(schema.customDomains)
      .values({
        deploymentId: deployment!.id,
        organizationId,
        hostname: 'example.com',
        status: 'CONFIGURING',
        createdBy: 'system',
      })
      .returning();

    const started = new Date(Date.now() - 95 * 60 * 1000);
    const [job] = await db
      .insert(schema.deploymentJobs)
      .values({
        deploymentId: deployment!.id,
        type: 'CONFIGURE_DOMAIN',
        state: 'RUNNING',
        idempotencyKey: `domain:${randomUUID()}`,
        payload: { hostname: 'example.com', domainId: domain!.id },
        startedAt: started,
        lastProgressAt: new Date(Date.now() - 65 * 60 * 1000),
        reconcileCount: 3,
      })
      .returning();

    await sweepStuckJobs(db);

    const [jobRow] = await db.select().from(schema.deploymentJobs).where(eq(schema.deploymentJobs.id, job!.id));
    expect(jobRow?.state).toBe('FAILED');
    expect(jobRow?.failureCode).toBe('DOMAIN_OPERATION_TIMEOUT');
    expect(jobRow?.result).toMatchObject({ timeout: true });

    const [deploymentRow] = await db
      .select()
      .from(schema.deployments)
      .where(eq(schema.deployments.id, deployment!.id));
    expect(deploymentRow?.state).toBe('HEALTHY');

    const [domainRow] = await db.select().from(schema.customDomains).where(eq(schema.customDomains.id, domain!.id));
    expect(domainRow?.lastError).toBe('DOMAIN_OPERATION_TIMEOUT');
  });
});

// ── Relay-liveness sweep (persisted DISCONNECTED) ─────────────────────────
describe('sweepRelayLiveness', () => {
  let client: PGlite | undefined;
  let db: Db;
  let organizationId: string;
  let applicationId: string;
  let customerId: string;

  beforeAll(async () => {
    client = new PGlite();
    await applyMigrations(client);
    db = createDb(client);

    const [org] = await db
      .insert(schema.organization)
      .values({ id: 'org-liveness', name: 'Liveness Org', slug: 'liveness-org' })
      .returning();
    organizationId = org!.id;

    const [application] = await db
      .insert(schema.applications)
      .values({
        organizationId,
        name: 'App',
        repoFullName: 'acme/liveness-app',
        repoUrl: 'https://github.com/acme/liveness-app',
        defaultBranch: 'main',
      })
      .returning();
    applicationId = application!.id;

    const [customer] = await db
      .insert(schema.customers)
      .values({ organizationId, name: 'Cust', email: 'liveness@example.test' })
      .returning();
    customerId = customer!.id;
  }, 60_000);

  afterAll(async () => {
    await client?.close();
  });

  async function seedRelay(overrides: {
    relayStatus: 'CONNECTED' | 'DISCONNECTED' | 'UNKNOWN';
    lastHealthMinutesAgo: number | null;
    relayBoundMinutesAgo?: number | null;
  }): Promise<string> {
    const [deployment] = await db
      .insert(schema.deployments)
      .values({
        organizationId,
        applicationId,
        customerId,
        region: 'us-east-1',
        state: 'HEALTHY',
        installationId: `inst-${randomUUID()}`,
        enrollmentCode: randomUUID(),
        relayStatus: overrides.relayStatus,
        ...(overrides.lastHealthMinutesAgo !== null
          ? { lastHealthAt: new Date(Date.now() - overrides.lastHealthMinutesAgo * 60 * 1000) }
          : {}),
        ...(overrides.relayBoundMinutesAgo !== undefined
          ? { relayBoundAt: new Date(Date.now() - overrides.relayBoundMinutesAgo * 60 * 1000) }
          : {}),
      })
      .returning();
    return deployment!.id;
  }

  it('persists DISCONNECTED once the check-in window is missed', async () => {
    const id = await seedRelay({ relayStatus: 'CONNECTED', lastHealthMinutesAgo: 30 });
    await sweepRelayLiveness(db);
    const [row] = await db.select().from(schema.deployments).where(eq(schema.deployments.id, id));
    expect(row?.relayStatus).toBe('DISCONNECTED');
  });

  it('keeps a CONNECTED relay whose last check-in is recent', async () => {
    const id = await seedRelay({ relayStatus: 'CONNECTED', lastHealthMinutesAgo: 5 });
    await sweepRelayLiveness(db);
    const [row] = await db.select().from(schema.deployments).where(eq(schema.deployments.id, id));
    expect(row?.relayStatus).toBe('CONNECTED');
  });

  it('counts a registered-but-never-reporting relay from relayBoundAt', async () => {
    const stale = await seedRelay({ relayStatus: 'CONNECTED', lastHealthMinutesAgo: null, relayBoundMinutesAgo: 60 });
    const fresh = await seedRelay({ relayStatus: 'CONNECTED', lastHealthMinutesAgo: null, relayBoundMinutesAgo: 5 });
    await sweepRelayLiveness(db);
    const rows = await db
      .select()
      .from(schema.deployments)
      .where(inArray(schema.deployments.id, [stale, fresh]));
    const byId = new Map(rows.map((row) => [row.id, row.relayStatus]));
    expect(byId.get(stale)).toBe('DISCONNECTED');
    expect(byId.get(fresh)).toBe('CONNECTED');
  });

  it('never touches UNKNOWN or already-DISCONNECTED rows', async () => {
    const unknown = await seedRelay({ relayStatus: 'UNKNOWN', lastHealthMinutesAgo: 60 });
    const disconnected = await seedRelay({ relayStatus: 'DISCONNECTED', lastHealthMinutesAgo: 60 });
    const swept = await sweepRelayLiveness(db);
    expect(swept).toBe(0);
    const rows = await db
      .select()
      .from(schema.deployments)
      .where(inArray(schema.deployments.id, [unknown, disconnected]));
    const byId = new Map(rows.map((row) => [row.id, row.relayStatus]));
    expect(byId.get(unknown)).toBe('UNKNOWN');
    expect(byId.get(disconnected)).toBe('DISCONNECTED');
  });
});

// ── Stuck-build watchdog (audit blocker N2) ───────────────────────────────
//
// A missed or lost CodeBuild state-change event otherwise leaves a release
// BUILDING forever — nothing else ever moves it on. sweepStuckBuilds asks
// CodeBuild directly once a release has gone quiet past the timeout.
describe('sweepStuckBuilds', () => {
  let client: PGlite | undefined;
  let db: Db;
  let applicationId: string;

  beforeAll(async () => {
    client = new PGlite();
    await applyMigrations(client);
    db = createDb(client);

    const [org] = await db
      .insert(schema.organization)
      .values({ id: 'org-build-watchdog', name: 'Build Watchdog Org', slug: 'build-watchdog-org' })
      .returning();

    const [application] = await db
      .insert(schema.applications)
      .values({
        organizationId: org!.id,
        name: 'App',
        repoFullName: 'acme/build-watchdog-app',
        repoUrl: 'https://github.com/acme/build-watchdog-app',
        defaultBranch: 'main',
      })
      .returning();
    applicationId = application!.id;
  }, 60_000);

  afterAll(async () => {
    await client?.close();
  });

  async function insertStuckRelease(version: string, minutesAgo: number, buildId: string) {
    const [release] = await db
      .insert(schema.releases)
      .values({
        applicationId,
        version,
        gitSha: 'abc123',
        currentBuildId: buildId,
        buildStatus: 'BUILDING',
        releaseStatus: 'BUILDING',
        updatedAt: new Date(Date.now() - minutesAgo * 60 * 1000),
      })
      .returning();
    return release!;
  }

  function depsWithBuilds(
    builds: {
      id: string;
      buildStatus: string;
      exportedEnvironmentVariables?: { name: string; value: string }[];
    }[],
  ): WorkerDeps {
    return {
      db,
      fetchFn: (async () => {
        throw new Error('not used by sweepStuckBuilds');
      }) as unknown as WorkerDeps['fetchFn'],
      s3: { async putObject() {} },
      async startBuild() {
        return null;
      },
      async batchGetBuilds() {
        return builds;
      },
      async runAnalysis() {},
    };
  }

  it('moves a stuck BUILDING release to READY when CodeBuild reports SUCCEEDED', async () => {
    const release = await insertStuckRelease('sb-1.0.0', 35, 'deployz-build:stuck-1');
    const digest = `acme/watchdog@sha256:${'c'.repeat(64)}`;

    const swept = await sweepStuckBuilds(
      depsWithBuilds([
        {
          id: 'deployz-build:stuck-1',
          buildStatus: 'SUCCEEDED',
          exportedEnvironmentVariables: [{ name: 'IMAGE_DIGEST', value: digest }],
        },
      ]),
    );

    expect(swept).toBe(1);
    const [row] = await db.select().from(schema.releases).where(eq(schema.releases.id, release.id));
    expect(row?.releaseStatus).toBe('READY');
    expect(row?.imageDigest).toBe(digest);
  });

  it('fails a stuck BUILDING release when CodeBuild reports FAILED', async () => {
    const release = await insertStuckRelease('sb-1.1.0', 35, 'deployz-build:stuck-2');

    const swept = await sweepStuckBuilds(
      depsWithBuilds([{ id: 'deployz-build:stuck-2', buildStatus: 'FAILED' }]),
    );

    expect(swept).toBe(1);
    const [row] = await db.select().from(schema.releases).where(eq(schema.releases.id, release.id));
    expect(row?.releaseStatus).toBe('FAILED');
  });

  it('leaves a release untouched when it has not yet timed out', async () => {
    const release = await insertStuckRelease('sb-1.2.0', 5, 'deployz-build:fresh');

    const swept = await sweepStuckBuilds(depsWithBuilds([]));

    expect(swept).toBe(0);
    const [row] = await db.select().from(schema.releases).where(eq(schema.releases.id, release.id));
    expect(row?.releaseStatus).toBe('BUILDING');
  });

  it('fails a stuck release with a clear reason when CodeBuild no longer knows the build', async () => {
    const release = await insertStuckRelease('sb-1.3.0', 35, 'deployz-build:vanished');

    const swept = await sweepStuckBuilds(depsWithBuilds([]));

    expect(swept).toBe(1);
    const [row] = await db.select().from(schema.releases).where(eq(schema.releases.id, release.id));
    expect(row?.releaseStatus).toBe('FAILED');
    expect(row?.failureReason).toMatch(/no longer has a record/i);
  });

  it('leaves a release untouched while CodeBuild still reports IN_PROGRESS', async () => {
    const release = await insertStuckRelease('sb-1.4.0', 35, 'deployz-build:still-running');

    const swept = await sweepStuckBuilds(
      depsWithBuilds([{ id: 'deployz-build:still-running', buildStatus: 'IN_PROGRESS' }]),
    );

    expect(swept).toBe(0);
    const [row] = await db.select().from(schema.releases).where(eq(schema.releases.id, release.id));
    expect(row?.releaseStatus).toBe('BUILDING');
  });
});
