// §22 release data access. A 404 from the API now means the application
// genuinely does not exist for the caller's organization — it is surfaced,
// never swallowed into look-alike placeholder data. §65: copy is jargon-free.

import { apiUrl } from '@/lib/api-url';

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
    createdAt: string;
  };
  return { id: row.id, version: row.version, status: row.releaseStatus, createdAt: row.createdAt };
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

