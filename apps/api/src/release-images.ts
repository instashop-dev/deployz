/**
 * Release image availability — a READY release whose image no longer exists
 * in the control plane's registry is not a deployable release.
 *
 * The release row keeps the digest CodeBuild pushed, but the registry is the
 * only truth about whether that image still exists (a lifecycle rule or an
 * operator can delete it). Two deterministic checks, no background polling:
 *
 *   deploy time  → `requireReleaseImageAvailable` asks the registry for THIS
 *                  digest right now, so a release the page listed as READY
 *                  before its image was deleted is still refused (409
 *                  RELEASE_UNAVAILABLE) and marked, and the running release
 *                  is never touched.
 *   list time    → `refreshReleaseImageAvailability` re-checks READY releases
 *                  at most once per RELEASE_IMAGE_RECHECK_MS per release, so
 *                  the vendor sees "Unavailable" without a failed deploy.
 *
 * The registry not answering is never taken as "missing"
 * (docs/deployment-resilience.md, the uncertain-result rule): an unknown
 * outcome leaves the release as it is. A missing image is sticky —
 * `image_unavailable_at` is set once and the copy points at creating a new
 * release.
 */

import { BatchGetImageCommand, ECRClient } from '@aws-sdk/client-ecr';
import { and, eq, inArray, isNull } from 'drizzle-orm';

import type { ReleaseStatus } from '@deployz/contracts';
import type { RuntimeDb } from '@deployz/db';
import * as schema from '@deployz/db/schema';

import { ApiError } from './errors.js';

export type ImageAvailability = 'available' | 'missing';

export interface ReleaseImageClient {
  /**
   * The availability of each digest in one repository. Returns null when the
   * registry could not answer at all; a digest absent from the map is
   * unknown. Never throws.
   */
  getImageAvailability(
    repositoryName: string,
    digests: readonly string[],
  ): Promise<ReadonlyMap<string, ImageAvailability> | null>;
}

/** How long a list-time availability answer stays fresh. */
export const RELEASE_IMAGE_RECHECK_MS = 10 * 60 * 1000;

/** The wire status a release shows once its image is known to be gone. */
export const RELEASE_UNAVAILABLE_STATUS = 'UNAVAILABLE';
export type ReleaseWireStatus = ReleaseStatus | typeof RELEASE_UNAVAILABLE_STATUS;

const BATCH_GET_IMAGE_LIMIT = 100;
const IMAGE_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

type ReleaseRow = typeof schema.releases.$inferSelect;

/**
 * Split a stored `repository@sha256:…` reference into the registry
 * repository NAME (the path after the registry host) and the digest. Null
 * for anything that is not a strict immutable reference.
 */
export function parseImageReference(
  imageDigest: string | null,
): { repositoryName: string; digest: string } | null {
  if (!imageDigest) return null;
  const at = imageDigest.lastIndexOf('@');
  if (at <= 0) return null;
  const repository = imageDigest.slice(0, at);
  const digest = imageDigest.slice(at + 1);
  if (!IMAGE_DIGEST_PATTERN.test(digest)) return null;
  const slash = repository.indexOf('/');
  const repositoryName = slash >= 0 ? repository.slice(slash + 1) : repository;
  return repositoryName.length > 0 ? { repositoryName, digest } : null;
}

export function releaseWireStatus(
  release: Pick<ReleaseRow, 'releaseStatus' | 'imageUnavailableAt'>,
): ReleaseWireStatus {
  return release.imageUnavailableAt !== null ? RELEASE_UNAVAILABLE_STATUS : release.releaseStatus;
}

export function releaseUnavailableError(version: string): ApiError {
  return new ApiError(
    409,
    'RELEASE_UNAVAILABLE',
    `Version ${version} can no longer be deployed because its build is no longer available. Create a new release to deploy this version again.`,
  );
}

/**
 * Deploy-time guard. Refuses a release already known to be unavailable
 * without a registry call; otherwise asks the registry for this one digest
 * and marks the release when the image is gone. An unanswered check lets the
 * deploy proceed — the pipeline's own image-pull failure stays honest and
 * the previous release keeps serving.
 */
export async function requireReleaseImageAvailable(
  db: RuntimeDb,
  client: ReleaseImageClient,
  release: Pick<ReleaseRow, 'id' | 'version' | 'imageDigest' | 'imageUnavailableAt'>,
  now: Date = new Date(),
): Promise<void> {
  if (release.imageUnavailableAt !== null) throw releaseUnavailableError(release.version);
  const reference = parseImageReference(release.imageDigest);
  if (reference === null) return;
  const availability = await client.getImageAvailability(reference.repositoryName, [reference.digest]);
  const outcome = availability?.get(reference.digest);
  if (outcome === undefined) return;
  if (outcome === 'missing') {
    await db
      .update(schema.releases)
      .set({ imageUnavailableAt: now, imageCheckedAt: now })
      .where(and(eq(schema.releases.id, release.id), isNull(schema.releases.imageUnavailableAt)));
    throw releaseUnavailableError(release.version);
  }
  await db.update(schema.releases).set({ imageCheckedAt: now }).where(eq(schema.releases.id, release.id));
}

/**
 * List-time refresh: one registry call per repository for the READY releases
 * whose last answer is older than RELEASE_IMAGE_RECHECK_MS (or that were
 * never checked). Returns the rows with the fresh marks applied.
 */
export async function refreshReleaseImageAvailability(
  db: RuntimeDb,
  client: ReleaseImageClient,
  releases: readonly ReleaseRow[],
  now: Date = new Date(),
): Promise<ReleaseRow[]> {
  const due = releases.flatMap((release) => {
    if (release.releaseStatus !== 'READY' || release.imageUnavailableAt !== null) return [];
    if (
      release.imageCheckedAt !== null &&
      now.getTime() - release.imageCheckedAt.getTime() < RELEASE_IMAGE_RECHECK_MS
    ) {
      return [];
    }
    const reference = parseImageReference(release.imageDigest);
    return reference === null ? [] : [{ release, reference }];
  });
  if (due.length === 0) return [...releases];

  const byRepository = new Map<string, typeof due>();
  for (const entry of due) {
    const group = byRepository.get(entry.reference.repositoryName);
    if (group === undefined) byRepository.set(entry.reference.repositoryName, [entry]);
    else group.push(entry);
  }

  const checked = new Set<string>();
  const missing = new Set<string>();
  for (const [repositoryName, group] of byRepository) {
    for (let start = 0; start < group.length; start += BATCH_GET_IMAGE_LIMIT) {
      const chunk = group.slice(start, start + BATCH_GET_IMAGE_LIMIT);
      const availability = await client.getImageAvailability(
        repositoryName,
        chunk.map((entry) => entry.reference.digest),
      );
      if (availability === null) continue;
      for (const entry of chunk) {
        const outcome = availability.get(entry.reference.digest);
        if (outcome === undefined) continue;
        checked.add(entry.release.id);
        if (outcome === 'missing') missing.add(entry.release.id);
      }
    }
  }

  if (checked.size > 0) {
    await db
      .update(schema.releases)
      .set({ imageCheckedAt: now })
      .where(inArray(schema.releases.id, [...checked]));
  }
  if (missing.size > 0) {
    await db
      .update(schema.releases)
      .set({ imageUnavailableAt: now })
      .where(and(inArray(schema.releases.id, [...missing]), isNull(schema.releases.imageUnavailableAt)));
  }

  return releases.map((release) => {
    if (missing.has(release.id)) return { ...release, imageUnavailableAt: now, imageCheckedAt: now };
    if (checked.has(release.id)) return { ...release, imageCheckedAt: now };
    return release;
  });
}

// ── Clients ─────────────────────────────────────────────────────────────────

/** Production client — BatchGetImage on the control plane's own registry. */
export function createRealReleaseImageClient(): ReleaseImageClient {
  const ecr = new ECRClient({});
  return {
    async getImageAvailability(repositoryName, digests) {
      const result = new Map<string, ImageAvailability>();
      try {
        for (let start = 0; start < digests.length; start += BATCH_GET_IMAGE_LIMIT) {
          const chunk = digests.slice(start, start + BATCH_GET_IMAGE_LIMIT);
          const response = await ecr.send(
            new BatchGetImageCommand({
              repositoryName,
              imageIds: chunk.map((imageDigest) => ({ imageDigest })),
            }),
          );
          for (const image of response.images ?? []) {
            const digest = image.imageId?.imageDigest;
            if (digest) result.set(digest, 'available');
          }
          for (const failure of response.failures ?? []) {
            const digest = failure.imageId?.imageDigest;
            if (digest && (failure.failureCode === 'ImageNotFound' || failure.failureCode === 'InvalidImageDigest')) {
              result.set(digest, 'missing');
            }
          }
        }
        return result;
      } catch (error) {
        console.error(
          JSON.stringify({ event: 'ecr:image-availability-failed', repositoryName, error: String(error) }),
        );
        return null;
      }
    },
  };
}

export interface FixtureReleaseImageClient extends ReleaseImageClient {
  /** Script a digest as deleted from the registry. */
  markMissing(digest: string): void;
  restore(digest: string): void;
  snapshot(): { missing: string[] };
}

/**
 * BUILD_FIXTURE_MODE client (E2E, local): every fixture digest exists until a
 * scenario deletes it through the gated `/internal/fixture/release-images`
 * route, which models the operator deleting the image after the page loaded.
 */
export function createFixtureReleaseImageClient(): FixtureReleaseImageClient {
  const missing = new Set<string>();
  return {
    async getImageAvailability(_repositoryName, digests) {
      return new Map(digests.map((digest) => [digest, missing.has(digest) ? 'missing' : 'available']));
    },
    markMissing(digest) {
      missing.add(digest);
    },
    restore(digest) {
      missing.delete(digest);
    },
    snapshot() {
      return { missing: [...missing] };
    },
  };
}
