// §22 release data access. The releases API endpoint arrives in a later
// todo; until then fetchReleases falls back to realistic FIXTURE data on a
// 404 so the releases page renders without a backend (same pattern as
// todos 19/25/26/30). §65: all copy is jargon-free.

const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

export type ReleaseStatus = 'BUILDING' | 'READY' | 'FAILED';

export interface Release {
  id: string;
  version: string;
  status: ReleaseStatus;
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

function isNotFound(error: unknown): boolean {
  return error instanceof Error && error.message.includes('(404)');
}

export async function fetchReleases(applicationId: string): Promise<Release[]> {
  try {
    const body = await getJson<{ releases?: Release[] }>(
      `/api/applications/${encodeURIComponent(applicationId)}/releases`,
    );
    return body.releases ?? [];
  } catch (error) {
    if (isNotFound(error)) return fixtureReleases();
    throw error;
  }
}

export const RELEASE_STATUS_BADGE: Record<ReleaseStatus, 'default' | 'secondary' | 'destructive'> = {
  BUILDING: 'secondary',
  READY: 'default',
  FAILED: 'destructive',
};

export const RELEASE_STATUS_LABEL: Record<ReleaseStatus, string> = {
  BUILDING: 'Building',
  READY: 'Ready',
  FAILED: 'Failed',
};

export function releaseStatusLabel(status: string): string {
  return RELEASE_STATUS_LABEL[status as ReleaseStatus] ?? status;
}

export const FIXTURE_RELEASES: Release[] = [
  {
    id: 'release-v1-2-0',
    version: 'v1.2.0',
    status: 'READY',
    createdAt: '2026-08-20T10:34:00.000Z',
  },
  {
    id: 'release-v1-1-0',
    version: 'v1.1.0',
    status: 'READY',
    createdAt: '2026-08-15T14:00:00.000Z',
  },
  {
    id: 'release-v1-0-0',
    version: 'v1.0.0',
    status: 'READY',
    createdAt: '2026-08-01T09:00:00.000Z',
  },
];

function fixtureReleases(): Release[] {
  return FIXTURE_RELEASES;
}
