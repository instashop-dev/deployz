// §22 release data access. A 404 from the API now means the application
// genuinely does not exist for the caller's organization — it is surfaced,
// never swallowed into look-alike placeholder data. §65: copy is jargon-free.

import { apiUrl } from '@/lib/api-url';

export type ReleaseStatus = 'BUILDING' | 'READY' | 'FAILED' | 'UNAVAILABLE';

export interface Release {
  id: string;
  version: string;
  status: ReleaseStatus;
  /** Why the build failed; null unless status is FAILED. */
  failureReason: string | null;
  /** The commit this release was built from (full 40-char SHA). */
  gitSha: string;
  createdAt: string;
}

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(`${apiUrl}${path}`, {
    credentials: 'include',
    cache: 'no-store',
  });
  if (!response.ok) {
    throw new Error(`Releases request failed (${response.status})`);
  }
  return (await response.json()) as T;
}

export async function fetchReleases(applicationId: string): Promise<Release[]> {
  const body = await getJson<{ releases?: Release[] }>(
    `/api/applications/${encodeURIComponent(applicationId)}/releases`,
  );
  return body.releases ?? [];
}

export interface CreateReleaseInput {
  version: string;
  gitSha: string;
  migrationCommand?: string | null;
}

/** §22 create release — POST /api/applications/:id/releases. */
export async function createRelease(
  applicationId: string,
  input: CreateReleaseInput,
): Promise<Release> {
  const response = await fetch(
    `${apiUrl}/api/applications/${encodeURIComponent(applicationId)}/releases`,
    {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        version: input.version,
        gitSha: input.gitSha,
        migrationCommand: input.migrationCommand ?? null,
      }),
    },
  );
  if (!response.ok) {
    throw new Error(`Create release failed (${response.status})`);
  }
  const row = (await response.json()) as {
    id: string;
    version: string;
    releaseStatus: ReleaseStatus;
    failureReason: string | null;
    gitSha: string;
    createdAt: string;
  };
  return {
    id: row.id,
    version: row.version,
    status: row.releaseStatus,
    failureReason: row.failureReason ?? null,
    gitSha: row.gitSha,
    createdAt: row.createdAt,
  };
}

export const RELEASE_STATUS_BADGE: Record<ReleaseStatus, 'success' | 'info' | 'destructive' | 'secondary'> = {
  BUILDING: 'info',
  READY: 'success',
  FAILED: 'destructive',
  UNAVAILABLE: 'secondary',
};

export const RELEASE_STATUS_LABEL: Record<ReleaseStatus, string> = {
  BUILDING: 'Building',
  READY: 'Ready',
  FAILED: 'Failed',
  UNAVAILABLE: 'Unavailable',
};

/** Copy shown under an UNAVAILABLE release's status badge. */
export const RELEASE_UNAVAILABLE_COPY =
  'The build for this version is no longer available. Create a new release to deploy it again.';

export function releaseStatusLabel(status: string): string {
  return RELEASE_STATUS_LABEL[status as ReleaseStatus] ?? status;
}

/** Copy for the deploy picker when no release qualifies. */
export const NO_DEPLOYABLE_RELEASES_COPY =
  'No deployable releases yet. A release must build successfully first.';

/**
 * Releases the deploy picker may offer: READY only (BUILDING may still
 * fail, FAILED cannot run), excluding the release already running, newest
 * first.
 */
export function deployableReleases(
  releases: readonly Release[],
  currentReleaseId: string | null,
): Release[] {
  return releases
    .filter((r) => r.status === 'READY' && r.id !== currentReleaseId)
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

/**
 * The release ids currently deployed by any live deployment of the
 * application — the releases the Runtime column marks as Running.
 */
export function runningReleaseIds(
  deployments: readonly { currentReleaseId: string | null; state: string }[],
): Set<string> {
  return new Set(
    deployments
      .filter((d) => d.state !== 'DELETED' && d.currentReleaseId !== null)
      .map((d) => d.currentReleaseId!),
  );
}

const SEMVER_PATTERN = /^(v?)(\d+)\.(\d+)\.(\d+)$/;

/**
 * A default value for the New release form's Version field: the newest
 * release's version with its patch number incremented, keeping the `v`
 * prefix when the newest version has one. Returns '' when there is no
 * release yet or its version is not plain semver — the field stays
 * editable either way.
 */
export function suggestNextVersion(
  releases: readonly Pick<Release, 'version' | 'createdAt'>[],
): string {
  if (releases.length === 0) return '';
  const newest = releases.reduce((latest, release) =>
    Date.parse(release.createdAt) > Date.parse(latest.createdAt) ? release : latest,
  );
  const match = SEMVER_PATTERN.exec(newest.version);
  if (!match) return '';
  const [, prefix, major, minor, patch] = match;
  return `${prefix}${major}.${minor}.${Number(patch) + 1}`;
}

/**
 * Existing releases already built from `sha` (or from a commit `sha` is a
 * prefix/extension of, so a short manual SHA still matches a full stored
 * one) — shown as unobtrusive "Already released as vX" context under the
 * commit field. Never blocks submit.
 */
export function alreadyReleasedVersions(releases: readonly Release[], sha: string): string[] {
  const needle = sha.trim().toLowerCase();
  if (needle.length < 7) return [];
  return releases
    .filter((release) => {
      const gitSha = release.gitSha.toLowerCase();
      return gitSha.length >= 7 && (gitSha.startsWith(needle) || needle.startsWith(gitSha));
    })
    .map((release) => release.version);
}

