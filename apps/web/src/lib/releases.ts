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
    createdAt: string;
  };
  return {
    id: row.id,
    version: row.version,
    status: row.releaseStatus,
    failureReason: row.failureReason ?? null,
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
 * What a new deployment would install. An install runs the newest READY
 * release; without one the API refuses the deployment, so the create screen
 * says so up front: `building` while the newest release is still building,
 * `none` when nothing is built (or every build failed).
 */
export type InstallReleaseState =
  | { kind: 'ready'; release: Release }
  | { kind: 'building'; release: Release }
  | { kind: 'none' };

export function installReleaseState(releases: readonly Release[]): InstallReleaseState {
  const newestFirst = [...releases].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  const ready = newestFirst.find((r) => r.status === 'READY');
  if (ready) return { kind: 'ready', release: ready };
  const building = newestFirst.find((r) => r.status === 'BUILDING');
  if (building) return { kind: 'building', release: building };
  return { kind: 'none' };
}

/**
 * The first release of an application, built from the commit its analysis
 * read — the same version scheme the public install link uses (the first 12
 * characters of the SHA). Null when the analysis recorded no commit.
 */
export function firstReleaseInput(detectedMetadata: Record<string, unknown> | null): CreateReleaseInput | null {
  const sha = detectedMetadata?.analysisCommitSha;
  if (typeof sha !== 'string' || sha.length === 0) return null;
  return { version: sha.slice(0, 12), gitSha: sha };
}

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

