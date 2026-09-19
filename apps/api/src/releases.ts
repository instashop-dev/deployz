import { eq } from 'drizzle-orm';
import type { RuntimeDb } from '@deployz/db';
import * as schema from '@deployz/db/schema';

import { env } from './env.js';
import { recordEvent } from './events.js';
import { flipHealthyDeploymentsToUpdateAvailable } from './jobs.js';
import { enqueue } from './queue.js';
import { hashRelayToken } from './relay-store.js';

// BUILD_FIXTURE_MODE: a deterministic fake `repository@sha256:…` digest so
// the E2E lifecycle scenarios can drive deploy/rollback without a live
// CodeBuild/ECR — same shape any real IMAGE_DIGEST has (see the regex below).
// Reuses hashRelayToken's sha256-hex helper rather than adding a new one;
// different release ids (one per version) hash to different digests.
const FIXTURE_IMAGE_REPOSITORY = '123456789012.dkr.ecr.us-east-1.amazonaws.com/deployz-fixture';
function fixtureImageDigest(releaseId: string): string {
  return `${FIXTURE_IMAGE_REPOSITORY}@sha256:${hashRelayToken(releaseId)}`;
}

/**
 * §36 Insert a new release row, record the release.created event, then start
 * the build (or mark it done in BUILD_FIXTURE_MODE). Returns the inserted row
 * — the same shape the POST /api/applications/:id/releases route body has
 * always returned (buildStatus 'PENDING' / releaseStatus 'BUILDING' before the
 * build completes; the fixture path updates the DB but does not re-read).
 */
export async function createReleaseRecord(
  db: RuntimeDb,
  params: {
    organizationId: string;
    userId: string | null;
    applicationId: string;
    version: string;
    gitSha: string;
    migrationCommand?: string | null;
  },
): Promise<typeof schema.releases.$inferSelect> {
  const row = await db.transaction(async (tx) => {
    const [inserted] = await tx
      .insert(schema.releases)
      .values({
        applicationId: params.applicationId,
        version: params.version,
        gitSha: params.gitSha,
        migrationCommand: params.migrationCommand ?? null,
        buildStatus: 'PENDING',
        createdBy: params.userId,
        updatedBy: params.userId,
      })
      .returning();
    await recordEvent(tx, {
      organizationId: params.organizationId,
      eventType: 'release.created',
      actorType: 'user',
      actorId: params.userId!,
      releaseId: inserted!.id,
      payload: { schemaVersion: 1, applicationId: params.applicationId },
    });
    return inserted;
  });
  // A release with no build is a release that can never deploy: the
  // §21 image digest only exists once CodeBuild has pushed the image.
  // The worker fetches the repository source and starts that build.
  if (row) {
    if (env.buildFixtureMode) {
      // BUILD_FIXTURE_MODE: locally JOB_QUEUE_URL is never configured, so
      // enqueue() no-ops and the release could never reach READY — every
      // deploy/rollback would 409 forever. Skip the queue and mark the
      // release built immediately, so E2E lifecycle scenarios can exercise
      // the real deploy/rollback/destroy routes end-to-end.
      await db
        .update(schema.releases)
        .set({
          imageDigest: fixtureImageDigest(row.id),
          buildStatus: 'SUCCEEDED',
          releaseStatus: 'READY',
        })
        .where(eq(schema.releases.id, row.id));
      // Same fleet flip the worker's recordBuildResult performs in
      // production — the fixture build path must stay truthful (DZ-AUDIT-007).
      await flipHealthyDeploymentsToUpdateAvailable(db, params.applicationId);
    } else {
      await enqueue({ type: 'BUILD_RELEASE', releaseId: row.id });
    }
  }

  return row!;
}