import { PGlite } from '@electric-sql/pglite';
import crypto from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { applyMigrations, createDb, type Db } from '@deployz/db';
import * as schema from '@deployz/db/schema';

import { ApiError } from './errors.js';
import {
  RELEASE_IMAGE_RECHECK_MS,
  createFixtureReleaseImageClient,
  parseImageReference,
  refreshReleaseImageAvailability,
  releaseWireStatus,
  requireReleaseImageAvailable,
  type ImageAvailability,
  type ReleaseImageClient,
} from './release-images.js';

// P0: a READY release whose image no longer exists in the registry is not a
// deployable release. These tests cover the pure reference parsing, the
// deploy-time guard, the throttled list refresh and the uncertain-result
// rule (an unanswered registry never marks anything).

const REPOSITORY = '111122223333.dkr.ecr.us-east-1.amazonaws.com/deployz-images';

function digest(seed: string): string {
  return `sha256:${crypto.createHash('sha256').update(seed).digest('hex')}`;
}

/** A client that records calls and answers from a scripted map (null = no answer). */
function scriptedClient(
  answers: ReadonlyMap<string, ImageAvailability> | null,
): ReleaseImageClient & { calls: Array<{ repositoryName: string; digests: readonly string[] }> } {
  const calls: Array<{ repositoryName: string; digests: readonly string[] }> = [];
  return {
    calls,
    async getImageAvailability(repositoryName, digests) {
      calls.push({ repositoryName, digests });
      return answers;
    },
  };
}

describe('parseImageReference', () => {
  it('splits a repository@digest reference into the registry repository name and the digest', () => {
    const d = digest('one');
    expect(parseImageReference(`${REPOSITORY}@${d}`)).toEqual({ repositoryName: 'deployz-images', digest: d });
    expect(parseImageReference(`registry.example/team/app@${d}`)).toEqual({ repositoryName: 'team/app', digest: d });
  });

  it('rejects anything that is not a strict immutable reference', () => {
    expect(parseImageReference(null)).toBeNull();
    expect(parseImageReference('')).toBeNull();
    expect(parseImageReference(`${REPOSITORY}:latest`)).toBeNull();
    expect(parseImageReference(`${REPOSITORY}@sha256:abc`)).toBeNull();
    expect(parseImageReference(`@${digest('x')}`)).toBeNull();
  });
});

describe('releaseWireStatus', () => {
  it('reads UNAVAILABLE once the image is marked missing, else the stored status', () => {
    expect(releaseWireStatus({ releaseStatus: 'READY', imageUnavailableAt: null })).toBe('READY');
    expect(releaseWireStatus({ releaseStatus: 'READY', imageUnavailableAt: new Date() })).toBe('UNAVAILABLE');
    expect(releaseWireStatus({ releaseStatus: 'BUILDING', imageUnavailableAt: null })).toBe('BUILDING');
  });
});

describe('release image availability (database)', () => {
  let client: PGlite | undefined;
  let db: Db;
  let applicationId: string;

  beforeAll(async () => {
    client = new PGlite();
    await applyMigrations(client);
    db = createDb(client);
    const [organization] = await db
      .insert(schema.organization)
      .values({ id: `org-${crypto.randomUUID()}`, name: 'Org', slug: `org-${crypto.randomUUID()}` })
      .returning();
    const [application] = await db
      .insert(schema.applications)
      .values({
        organizationId: organization!.id,
        name: 'App',
        repoFullName: `acme/app-${crypto.randomUUID().slice(0, 8)}`,
        repoUrl: 'https://github.com/acme/app',
        defaultBranch: 'main',
      })
      .returning();
    applicationId = application!.id;
  }, 60_000);

  afterAll(async () => {
    await client?.close();
  });

  async function insertRelease(
    overrides: Partial<typeof schema.releases.$inferInsert> = {},
  ): Promise<typeof schema.releases.$inferSelect> {
    const version = `v-${crypto.randomUUID().slice(0, 8)}`;
    const [row] = await db
      .insert(schema.releases)
      .values({
        applicationId,
        version,
        gitSha: 'abc123',
        buildStatus: 'SUCCEEDED',
        releaseStatus: 'READY',
        imageDigest: `${REPOSITORY}@${digest(version)}`,
        ...overrides,
      })
      .returning();
    return row!;
  }

  async function reload(id: string): Promise<typeof schema.releases.$inferSelect> {
    const [row] = await db.select().from(schema.releases).where(eq(schema.releases.id, id));
    return row!;
  }

  describe('requireReleaseImageAvailable (deploy time)', () => {
    it('passes an available image and records the check time', async () => {
      const release = await insertRelease();
      const fixture = createFixtureReleaseImageClient();
      await expect(requireReleaseImageAvailable(db, fixture, release)).resolves.toBeUndefined();
      const after = await reload(release.id);
      expect(after.imageUnavailableAt).toBeNull();
      expect(after.imageCheckedAt).not.toBeNull();
    });

    it('refuses a missing image with 409 RELEASE_UNAVAILABLE, marks the release, and stays refused without another registry call', async () => {
      const release = await insertRelease();
      const reference = parseImageReference(release.imageDigest)!;
      const answers = scriptedClient(new Map([[reference.digest, 'missing']]));

      await expect(requireReleaseImageAvailable(db, answers, release)).rejects.toMatchObject({
        statusCode: 409,
        code: 'RELEASE_UNAVAILABLE',
      });
      const marked = await reload(release.id);
      expect(marked.imageUnavailableAt).not.toBeNull();
      expect(answers.calls).toHaveLength(1);

      // Known-unavailable: deterministic refusal, no registry round trip.
      await expect(requireReleaseImageAvailable(db, answers, marked)).rejects.toBeInstanceOf(ApiError);
      expect(answers.calls).toHaveLength(1);
    });

    it('the refusal copy is actionable and names no registry jargon', async () => {
      const release = await insertRelease({ version: 'v2.3.4' });
      const fixture = createFixtureReleaseImageClient();
      fixture.markMissing(parseImageReference(release.imageDigest)!.digest);
      const error = await requireReleaseImageAvailable(db, fixture, release).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(ApiError);
      const message = (error as ApiError).message;
      expect(message).toContain('v2.3.4');
      expect(message).toContain('Create a new release');
      expect(message).not.toMatch(/ECR|digest|registry|image/i);
    });

    it('lets the deploy proceed when the registry does not answer (the uncertain-result rule)', async () => {
      const release = await insertRelease();
      const silent = scriptedClient(null);
      await expect(requireReleaseImageAvailable(db, silent, release)).resolves.toBeUndefined();
      const after = await reload(release.id);
      expect(after.imageUnavailableAt).toBeNull();
      expect(after.imageCheckedAt).toBeNull();
    });
  });

  describe('refreshReleaseImageAvailability (list time)', () => {
    it('checks READY releases once per repository, marks the missing ones and skips non-READY rows', async () => {
      const ready = await insertRelease();
      const gone = await insertRelease();
      const building = await insertRelease({ releaseStatus: 'BUILDING', buildStatus: 'BUILDING', imageDigest: null });
      const goneDigest = parseImageReference(gone.imageDigest)!.digest;
      const readyDigest = parseImageReference(ready.imageDigest)!.digest;
      const answers = scriptedClient(
        new Map([
          [goneDigest, 'missing'],
          [readyDigest, 'available'],
        ]),
      );

      const rows = await refreshReleaseImageAvailability(db, answers, [ready, gone, building]);

      expect(answers.calls).toHaveLength(1);
      expect(answers.calls[0]!.repositoryName).toBe('deployz-images');
      expect([...answers.calls[0]!.digests].sort()).toEqual([goneDigest, readyDigest].sort());
      expect(releaseWireStatus(rows.find((row) => row.id === gone.id)!)).toBe('UNAVAILABLE');
      expect(releaseWireStatus(rows.find((row) => row.id === ready.id)!)).toBe('READY');
      expect(releaseWireStatus(rows.find((row) => row.id === building.id)!)).toBe('BUILDING');
      expect((await reload(gone.id)).imageUnavailableAt).not.toBeNull();
      expect((await reload(ready.id)).imageCheckedAt).not.toBeNull();
    });

    it('does not ask the registry again inside the recheck window, and asks once it has passed', async () => {
      const release = await insertRelease();
      const fixture = createFixtureReleaseImageClient();
      const counting: ReleaseImageClient & { calls: number } = {
        calls: 0,
        async getImageAvailability(repositoryName, digests) {
          counting.calls += 1;
          return fixture.getImageAvailability(repositoryName, digests);
        },
      };
      const first = await refreshReleaseImageAvailability(db, counting, [release]);
      expect(counting.calls).toBe(1);

      await refreshReleaseImageAvailability(db, counting, first);
      expect(counting.calls).toBe(1);

      const later = new Date(first[0]!.imageCheckedAt!.getTime() + RELEASE_IMAGE_RECHECK_MS + 1);
      await refreshReleaseImageAvailability(db, counting, first, later);
      expect(counting.calls).toBe(2);
    });

    it('never re-checks a release already marked unavailable, and an unanswered registry marks nothing', async () => {
      const marked = await insertRelease({ imageUnavailableAt: new Date() });
      const fresh = await insertRelease();
      const silent = scriptedClient(null);
      const rows = await refreshReleaseImageAvailability(db, silent, [marked, fresh]);
      expect(silent.calls).toHaveLength(1);
      expect(silent.calls[0]!.digests).toEqual([parseImageReference(fresh.imageDigest)!.digest]);
      expect(releaseWireStatus(rows[0]!)).toBe('UNAVAILABLE');
      expect(releaseWireStatus(rows[1]!)).toBe('READY');
      expect((await reload(fresh.id)).imageCheckedAt).toBeNull();
    });
  });
});
