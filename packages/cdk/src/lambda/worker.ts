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
import { eq } from 'drizzle-orm';

import { mintInstallationToken } from '@deployz/api/github';
import { createOrReuseJob } from '@deployz/api/jobs';
import type { QueueMessage } from '@deployz/api/queue';
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
    readonly 'additional-information'?: {
      readonly environment?: {
        readonly 'environment-variables'?: readonly {
          readonly name: string;
          readonly value: string;
        }[];
      };
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
  readonly startBuild: (input: {
    projectName: string;
    environmentVariables: { name: string; value: string }[];
  }) => Promise<void>;
  readonly runAnalysis: (applicationId: string) => Promise<void>;
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

    await deps.startBuild({
      projectName: requireEnv('BUILD_PROJECT_NAME'),
      environmentVariables: [
        { name: 'SOURCE_S3_URI', value: `s3://${bucket}/${archive.s3Key}` },
        { name: 'RELEASE_VERSION', value: release.version },
        { name: 'GIT_SHA', value: release.gitSha },
        { name: 'RELEASE_ID', value: release.id },
        { name: 'DOCKERFILE_PATH', value: dockerfilePath },
      ],
    });

    await db
      .update(schema.releases)
      .set({ buildStatus: 'BUILDING' })
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
    .set({ buildStatus: 'FAILED', releaseStatus: 'FAILED' })
    .where(eq(schema.releases.id, releaseId));
}

// ── CONFIG_UPDATE ────────────────────────────────────────────────────────

type ConfigUpdateMessage = Extract<QueueMessage, { type: 'CONFIG_UPDATE' }>;

/**
 * Turns a config write-through into per-deployment CONFIG_UPDATE jobs. The
 * relay in each customer account picks them up on its next poll and writes
 * the values into that account's Secrets Manager.
 */
async function configUpdate(
  db: RuntimeDb,
  customerId: string,
  entries: ConfigUpdateMessage['entries'],
  messageId: string,
): Promise<void> {
  const deployments = await db
    .select()
    .from(schema.deployments)
    .where(eq(schema.deployments.customerId, customerId));

  for (const deployment of deployments) {
    await createOrReuseJob(db, {
      deploymentId: deployment.id,
      type: 'CONFIG_UPDATE',
      // Keyed on the SQS message, so a redelivery of the same write reuses
      // the job it already created while a genuinely new write makes a new
      // one — writing the same key twice is a legitimate second job.
      idempotencyKey: `${deployment.id}:CONFIG_UPDATE:${messageId}`,
      payload: { entries },
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

export async function recordBuildResult(
  db: RuntimeDb,
  event: CodeBuildStateChangeEvent,
): Promise<void> {
  const exported = event.detail['exported-environment-variables'];
  const supplied = event.detail['additional-information']?.environment?.['environment-variables'];
  const releaseId = readVariable(exported, 'RELEASE_ID') ?? readVariable(supplied, 'RELEASE_ID');
  if (!releaseId) return; // A build the control plane did not start.

  const status = event.detail['build-status'];
  if (status !== 'SUCCEEDED') {
    await failRelease(db, releaseId, `CodeBuild reported ${status}`);
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
      await deps.runAnalysis(message.applicationId);
      return;
    case 'BUILD_RELEASE':
      await buildRelease(deps, message.releaseId);
      return;
    case 'CONFIG_UPDATE':
      await configUpdate(deps.db, message.customerId, message.entries, messageId);
      return;
  }
}
