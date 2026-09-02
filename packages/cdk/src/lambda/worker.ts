/**
 * Control-plane worker — what the SQS job queue actually does.
 *
 * The API cannot do slow work itself: Lambda freezes an execution environment
 * the moment its response is sent, so anything started after a reply never
 * finishes. Every such task is queued (apps/api/src/queue.ts) and handled
 * here, in an invocation of its own with its own timeout.
 *
 * Two kinds of work arrive:
 *   - queue messages — ANALYSE_APPLICATION / BUILD_RELEASE / CONFIG_UPDATE.
 *   - a CodeBuild state change — the completion signal for a release build.
 *     The build's exported IMAGE_DIGEST becomes releases.image_digest; §21
 *     pins deployments to that digest.
 *
 * The Lambda entry point (worker-handler.ts) wires the real seams; this
 * module holds no AWS clients of its own, so the logic stays testable.
 */
import { and, eq, inArray, isNotNull, isNull, lt, or } from 'drizzle-orm';

import { mintInstallationToken } from '@deployz/api/github';
import { createOrReuseJob } from '@deployz/api/jobs';
import type { QueueMessage } from '@deployz/api/queue';
import { JOB_TIMEOUTS_MS, RELAY_STALE_AFTER_MS } from '@deployz/contracts';
import type { RuntimeDb } from '@deployz/db';
import * as schema from '@deployz/db/schema';

import { fetchRepoArchive } from '../pipeline/source-fetch.js';
import type { S3Client } from '../quick-create/publish.js';

export type { S3Client };

// ── Event shapes ─────────────────────────────────────────────────────────

export interface CodeBuildStateChangeEvent {
  readonly 'detail-type': string;
  readonly detail: {
    readonly 'build-status': string;
    /** The build's ARN — correlates the event to the release's current build. */
    readonly 'build-id'?: string;
    readonly 'additional-information'?: {
      readonly environment?: {
        readonly 'environment-variables'?: readonly {
          readonly name: string;
          readonly value: string;
        }[];
      };
      readonly phases?: readonly {
        readonly 'phase-type'?: string;
        readonly 'phase-status'?: string;
        readonly 'phase-context'?: readonly string[];
      }[];
      /** Where the real EventBridge event carries the exported vars (verified live). */
      readonly 'exported-environment-variables'?: readonly {
        readonly name: string;
        readonly value: string;
      }[];
    };
    readonly 'exported-environment-variables'?: readonly {
      readonly name: string;
      readonly value: string;
    }[];
  };
}

/**
 * Everything the worker touches outside its own process. Injected so the
 * dispatch logic is testable without AWS, GitHub, or Secrets Manager — the
 * same seam pattern as the §30 preflight engine and the publisher.
 */
export interface WorkerDeps {
  readonly db: RuntimeDb;
  readonly fetchFn: RepositoryFetch;
  readonly s3: S3Client;
  /** Starts a CodeBuild build and resolves its build id (the short "project:uuid" form StartBuild returns), or null. */
  readonly startBuild: (input: {
    projectName: string;
    environmentVariables: { name: string; value: string }[];
  }) => Promise<string | null>;
  /** Looks up builds by their short "project:uuid" id — the stuck-build watchdog's polling seam. */
  readonly batchGetBuilds: (ids: string[]) => Promise<
    {
      id: string;
      buildStatus: string;
      exportedEnvironmentVariables?: { name: string; value: string }[];
      phases?: {
        'phase-type'?: string;
        'phase-status'?: string;
        'phase-context'?: string[];
      }[];
    }[]
  >;
  readonly runAnalysis: (applicationId: string, options?: { force?: boolean }) => Promise<void>;
}

// ── Seams ────────────────────────────────────────────────────────────────

/**
 * Satisfies both fetch seams at once: the GitHub client needs `json()`, the
 * source fetcher needs `arrayBuffer()` and `text()`.
 */
export type RepositoryFetch = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
  arrayBuffer(): Promise<ArrayBuffer>;
  text(): Promise<string>;
}>;

/**
 * `docker/` is the convention for a Dockerfile written to be built from the
 * repo root (e.g. Documenso's `docker build -f docker/Dockerfile .`), unlike
 * a Dockerfile in another subdirectory (e.g. `backend/Dockerfile`) whose
 * context is that subdirectory. Only a top-level `docker/` counts — a nested
 * `foo/docker/Dockerfile` does not imply a repo-root context.
 */
export function resolveBuildContext(dockerfilePath: string): string | undefined {
  const dir = dockerfilePath.includes('/') ? dockerfilePath.slice(0, dockerfilePath.lastIndexOf('/')) : '.';
  return dir === 'docker' ? '.' : undefined;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is not set`);
  }
  return value;
}

// ── BUILD_RELEASE ────────────────────────────────────────────────────────

/**
 * Fetches the release's repository source into S3 and starts the CodeBuild
 * project on it. The build itself is asynchronous: its completion arrives
 * later as a CodeBuild state-change event.
 */
async function buildRelease(deps: WorkerDeps, releaseId: string): Promise<void> {
  const { db } = deps;
  const rows = await db
    .select({ release: schema.releases, application: schema.applications })
    .from(schema.releases)
    .innerJoin(schema.applications, eq(schema.releases.applicationId, schema.applications.id))
    .where(eq(schema.releases.id, releaseId))
    .limit(1);
  const row = rows[0];
  if (!row) return; // The release was deleted between enqueue and pickup.

  const { release, application } = row;
  const installationId = application.githubInstallationId;
  if (!installationId) {
    await failRelease(db, releaseId, 'No GitHub installation is linked to this application');
    return;
  }

  try {
    const { token } = await mintInstallationToken(
      installationId,
      requireEnv('GITHUB_APP_ID'),
      requireEnv('GITHUB_APP_PRIVATE_KEY'),
      Date.now(),
      deps.fetchFn,
    );

    const bucket = requireEnv('SOURCE_BUCKET');
    const archive = await fetchRepoArchive(token, application.repoFullName, deps.fetchFn, deps.s3, {
      bucket,
      s3KeyPrefix: `build-source/${application.id}/${release.id}`,
      ref: release.gitSha,
    });

    // The analyser records where the Dockerfile actually lives; a repository
    // is free to keep it out of the root.
    const dockerfilePath =
      (application.detectedMetadata?.['dockerfilePath'] as string | undefined) ?? 'Dockerfile';
    const buildContext = resolveBuildContext(dockerfilePath);

    const environmentVariables: { name: string; value: string }[] = [
      { name: 'SOURCE_S3_URI', value: `s3://${bucket}/${archive.s3Key}` },
      { name: 'RELEASE_VERSION', value: release.version },
      { name: 'GIT_SHA', value: release.gitSha },
      { name: 'RELEASE_ID', value: release.id },
      { name: 'DOCKERFILE_PATH', value: dockerfilePath },
    ];
    if (buildContext !== undefined) {
      environmentVariables.push({ name: 'BUILD_CONTEXT', value: buildContext });
    }

    const buildId = await deps.startBuild({
      projectName: requireEnv('BUILD_PROJECT_NAME'),
      environmentVariables,
    });

    // Pin the release to this build attempt so a terminal event from any
    // earlier attempt (redelivered, or racing a retried build) reads as
    // stale instead of corrupting the result.
    await db
      .update(schema.releases)
      .set({
        buildStatus: 'BUILDING',
        releaseStatus: 'BUILDING',
        ...(buildId ? { currentBuildId: buildId } : {}),
      })
      .where(eq(schema.releases.id, releaseId));
  } catch (error) {
    await failRelease(db, releaseId, error instanceof Error ? error.message : String(error));
    throw error;
  }
}

async function failRelease(db: RuntimeDb, releaseId: string, reason: string): Promise<void> {
  console.error(`release ${releaseId} build failed: ${reason}`);
  await db
    .update(schema.releases)
    .set({
      buildStatus: 'FAILED',
      releaseStatus: 'FAILED',
      failureReason: reason.slice(0, 500),
    })
    .where(eq(schema.releases.id, releaseId));
}

// ── CONFIG_UPDATE ────────────────────────────────────────────────────────

type ConfigUpdateMessage = Extract<QueueMessage, { type: 'CONFIG_UPDATE' }>;

/**
 * Turns a config write-through into per-deployment CONFIG_UPDATE jobs. The
 * durable payload carries KEYS ONLY — plaintext secret values never persist
 * in the control plane; the relay fetches the effective configuration over
 * its authenticated channel when it executes.
 */
async function configUpdate(
  db: RuntimeDb,
  message: ConfigUpdateMessage,
  messageId: string,
): Promise<void> {
  const deployments = await db
    .select()
    .from(schema.deployments)
    .where(eq(schema.deployments.customerId, message.customerId));

  console.log(
    JSON.stringify({
      event: 'worker:config-update-fanout',
      messageId,
      customerId: message.customerId,
      deployments: deployments.length,
    }),
  );

  for (const deployment of deployments) {
    await createOrReuseJob(db, {
      deploymentId: deployment.id,
      type: 'CONFIG_UPDATE',
      // Keyed on the SQS message, so a redelivery of the same write reuses
      // the job it already created while a genuinely new write makes a new
      // one - writing the same key twice is a legitimate second job.
      idempotencyKey: `${deployment.id}:CONFIG_UPDATE:${messageId}`,
      payload: {
        ...(message.changedKeys ? { changedKeys: [...message.changedKeys] } : {}),
        ...(message.removedKeys ? { removedKeys: [...message.removedKeys] } : {}),
      },
      requestedBy: null,
    });
  }
}

// ── CodeBuild completion ─────────────────────────────────────────────────

function readVariable(
  variables: readonly { name: string; value: string }[] | undefined,
  name: string,
): string | undefined {
  return variables?.find((variable) => variable.name === name)?.value;
}

/**
 * StartBuild resolves a build id in the short "project-name:uuid" form, but
 * the EventBridge CodeBuild state-change event's `detail['build-id']` is the
 * full ARN `arn:aws:codebuild:region:acct:build/project-name:uuid`. Strips
 * everything through the `:build/` marker so both sides of a correlation
 * check compare in the same format. Input with no marker (already short) is
 * returned unchanged.
 */
export function normalizeBuildId(buildId: string): string {
  const marker = ':build/';
  const index = buildId.indexOf(marker);
  return index === -1 ? buildId : buildId.slice(index + marker.length);
}

/**
 * The first failed phase's context from a CodeBuild event — e.g.
 * "POST_BUILD: COMMAND_EXECUTION_ERROR: Error while executing command:
 * docker push …". "CodeBuild reported FAILED" alone leaves the vendor
 * opening the AWS console to learn why; the event already carries the why.
 */
export function buildFailureDetail(event: CodeBuildStateChangeEvent): string | null {
  const phases = event.detail['additional-information']?.phases ?? [];
  for (const phase of phases) {
    if (phase['phase-status'] !== 'FAILED' && phase['phase-status'] !== 'FAULT') continue;
    const context = (phase['phase-context'] ?? []).find((entry) => entry.trim().length > 0);
    if (context === undefined) continue;
    return `${phase['phase-type'] ?? 'unknown phase'}: ${context}`.slice(0, 400);
  }
  return null;
}

export async function recordBuildResult(
  db: RuntimeDb,
  event: CodeBuildStateChangeEvent,
): Promise<void> {
  // The real EventBridge event nests exported vars under
  // additional-information; the top-level spelling is kept for the sweep's
  // synthesized events and any older payloads. (Verified live 2026-08-30: a
  // SUCCEEDED build's digest arrived ONLY under additional-information, and
  // the release was wrongly failed as digest-less.)
  const topLevelExported = event.detail['exported-environment-variables'];
  const exported =
    topLevelExported !== undefined && topLevelExported.length > 0
      ? topLevelExported
      : event.detail['additional-information']?.['exported-environment-variables'];
  const supplied = event.detail['additional-information']?.environment?.['environment-variables'];
  const releaseId = readVariable(exported, 'RELEASE_ID') ?? readVariable(supplied, 'RELEASE_ID');
  if (!releaseId) return; // A build the control plane did not start.

  const releaseRows = await db
    .select()
    .from(schema.releases)
    .where(eq(schema.releases.id, releaseId))
    .limit(1);
  const release = releaseRows[0];
  if (!release) return;

  // Build-attempt correlation: an event for any build other than the one
  // currently pinning the release is stale — a redelivery of an earlier
  // attempt, or a terminal report racing a retry. Moving the release on it
  // could flip a fresh success back to FAILED or resurrect an old digest.
  // Releases with no pinned build (started before correlation existed)
  // still accept any event while in flight.
  const eventBuildId = event.detail['build-id'];
  if (
    release.currentBuildId !== null &&
    eventBuildId !== undefined &&
    normalizeBuildId(eventBuildId) !== normalizeBuildId(release.currentBuildId)
  ) {
    console.warn(
      `ignoring stale CodeBuild event for release ${releaseId}: event build ${eventBuildId}, current build ${release.currentBuildId}`,
    );
    return;
  }

  // Duplicate terminal delivery for the same build: the release is already
  // settled, re-writing the same outcome is at best a wasted write.
  if (release.releaseStatus !== 'BUILDING') {
    console.warn(
      `ignoring duplicate CodeBuild event for release ${releaseId}: already ${release.releaseStatus}`,
    );
    return;
  }

  const status = event.detail['build-status'];
  if (status !== 'SUCCEEDED') {
    const detail = buildFailureDetail(event);
    await failRelease(
      db,
      releaseId,
      `CodeBuild reported ${status}${detail === null ? '' : ` — ${detail}`}`,
    );
    return;
  }

  const imageDigest = readVariable(exported, 'IMAGE_DIGEST');
  if (!imageDigest) {
    await failRelease(db, releaseId, 'Build succeeded without an image digest');
    return;
  }

  await db
    .update(schema.releases)
    .set({ imageDigest, buildStatus: 'SUCCEEDED', releaseStatus: 'READY' })
    .where(eq(schema.releases.id, releaseId));
}

// ── Dispatch ─────────────────────────────────────────────────────────────

export async function handleMessage(
  deps: WorkerDeps,
  message: QueueMessage,
  messageId: string,
): Promise<void> {
  switch (message.type) {
    case 'ANALYSE_APPLICATION':
      // `force` must survive the queue hop: the vendor's explicit Re-analyse
      // bypasses the commit-SHA cache, and dropping it here silently turned
      // that into a cache hit whenever the head commit had not moved.
      await deps.runAnalysis(message.applicationId, { force: message.force === true });
      return;
    case 'BUILD_RELEASE':
      await buildRelease(deps, message.releaseId);
      return;
    case 'CONFIG_UPDATE':
      await configUpdate(deps.db, message, messageId);
      return;
  }
}

// ── Stuck-job watchdog (Phase 7) ─────────────────────────────────────────
// JOB_TIMEOUTS_MS lives in @deployz/contracts — shared with Team Admin's
// STUCK flag (docs/admin/team-admin.md) so the two can never disagree.

const ACTIVE_MUTATING_STATES = ['REQUESTED', 'QUEUED', 'WAITING', 'RUNNING'] as const;

/**
 * Fails mutating jobs whose last genuine progress signal is older than the
 * job type's timeout. The signal is lastProgressAt — updated on relay
 * acknowledgement, heartbeat and result — falling back to startedAt, then
 * createdAt. A deployment row update says nothing about a job, so updatedAt
 * is deliberately not consulted.
 */
export async function sweepStuckJobs(db: RuntimeDb, now: Date = new Date()): Promise<number> {
  const rows = await db
    .select({ job: schema.deploymentJobs, deployment: schema.deployments })
    .from(schema.deploymentJobs)
    .innerJoin(schema.deployments, eq(schema.deploymentJobs.deploymentId, schema.deployments.id))
    .where(
      inArray(schema.deploymentJobs.state, [...ACTIVE_MUTATING_STATES]),
    );

  let failed = 0;
  for (const { job, deployment } of rows) {
    const timeout = JOB_TIMEOUTS_MS[job.type];
    if (timeout === undefined) continue;
    const lastSignal = job.lastProgressAt ?? job.startedAt ?? job.createdAt;
    if (now.getTime() - lastSignal.getTime() <= timeout) continue;

    await db.transaction(async (tx) => {
      await tx
        .update(schema.deploymentJobs)
        .set({
          state: 'FAILED',
          finishedAt: now,
          result: { timeout: true },
        })
        .where(eq(schema.deploymentJobs.id, job.id));

      await tx
        .update(schema.deployments)
        .set({ state: 'FAILED' })
        .where(eq(schema.deployments.id, deployment.id));

      await tx.insert(schema.eventLogs).values({
        actorType: 'system',
        actorId: 'watchdog',
        organizationId: deployment.organizationId,
        customerId: deployment.customerId,
        deploymentId: deployment.id,
        jobId: job.id,
        eventType: 'operation.timeout',
        previousState: deployment.state,
        requestedState: 'FAILED',
        result: 'failure',
        payload: {
          jobType: job.type,
          startedAt: job.startedAt?.toISOString() ?? null,
          lastProgressAt: job.lastProgressAt?.toISOString() ?? null,
          relayStatus: deployment.relayStatus,
        },
      });
    });
    failed += 1;
  }
  return failed;
}

// ── Relay-liveness sweep ──────────────────────────────────────────────────

/**
 * Persists DISCONNECTED on deployments whose relay missed its check-in
 * window. Reads trust the persisted column (see toFleetRow), so someone has
 * to write the transition — this is that someone. A relay that registered
 * but died before its first health report counts from relayBoundAt instead
 * of lastHealthAt, which would otherwise stay NULL forever and pin the row
 * at CONNECTED. A returning relay needs no help: its heartbeat writes
 * CONNECTED back directly.
 */
export async function sweepRelayLiveness(db: RuntimeDb, now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - RELAY_STALE_AFTER_MS);
  const swept = await db
    .update(schema.deployments)
    .set({ relayStatus: 'DISCONNECTED' })
    .where(
      and(
        eq(schema.deployments.relayStatus, 'CONNECTED'),
        or(
          lt(schema.deployments.lastHealthAt, cutoff),
          and(
            isNull(schema.deployments.lastHealthAt),
            isNotNull(schema.deployments.relayBoundAt),
            lt(schema.deployments.relayBoundAt, cutoff),
          ),
        ),
      ),
    )
    .returning({ id: schema.deployments.id });
  return swept.length;
}

// ── Stuck-build watchdog ─────────────────────────────────────────────────

/**
 * A missed or lost CodeBuild state-change event otherwise leaves a release
 * BUILDING forever — nothing else ever moves it on. Every 30 minutes without
 * a status update, ask CodeBuild directly what happened and settle the
 * release the same way a real event would (reusing recordBuildResult, so
 * status/digest handling is not duplicated). A build CodeBuild still reports
 * IN_PROGRESS is left untouched; a build id CodeBuild no longer knows about
 * fails the release outright.
 */
const STUCK_BUILD_TIMEOUT_MS = 30 * 60 * 1000;

export async function sweepStuckBuilds(deps: WorkerDeps, now: Date = new Date()): Promise<number> {
  const { db } = deps;
  const cutoff = new Date(now.getTime() - STUCK_BUILD_TIMEOUT_MS);
  const stuck = await db
    .select()
    .from(schema.releases)
    .where(
      and(
        eq(schema.releases.releaseStatus, 'BUILDING'),
        isNotNull(schema.releases.currentBuildId),
        lt(schema.releases.updatedAt, cutoff),
      ),
    );
  if (stuck.length === 0) return 0;

  const builds = await deps.batchGetBuilds(
    stuck.map((release) => release.currentBuildId as string),
  );
  const buildsById = new Map(builds.map((build) => [normalizeBuildId(build.id), build]));

  let swept = 0;
  for (const release of stuck) {
    const build = buildsById.get(normalizeBuildId(release.currentBuildId as string));
    if (!build) {
      await failRelease(db, release.id, 'CodeBuild no longer has a record of this build');
      swept += 1;
      continue;
    }
    if (build.buildStatus === 'IN_PROGRESS') continue; // Still running — leave it.

    await recordBuildResult(db, {
      'detail-type': 'CodeBuild Build State Change',
      detail: {
        'build-status': build.buildStatus,
        'build-id': build.id,
        ...(build.phases !== undefined
          ? { 'additional-information': { phases: build.phases } }
          : {}),
        'exported-environment-variables': [
          ...(build.exportedEnvironmentVariables ?? []),
          { name: 'RELEASE_ID', value: release.id },
        ],
      },
    });
    swept += 1;
  }
  return swept;
}
