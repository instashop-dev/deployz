// §35 application data access. Client-side (fetched from 'use client'
// components), so the browser-facing origin — mirrors lib/github.ts and
// lib/deployments.ts.

import { apiUrl } from '@/lib/api-url';

/** Mirrors `analysisStatusEnum` in packages/db. */
export type AnalysisStatus = 'PENDING' | 'ANALYZING' | 'COMPLETE' | 'FAILED';

/** Mirrors `compatibilityStatusEnum` in packages/db (§19 verdict). */
export type CompatibilityStatus = 'READY' | 'NEEDS_ATTENTION' | 'NOT_COMPATIBLE';

/** The `applications` row shape (§35), as returned by the API. */
export interface Application {
  id: string;
  organizationId: string;
  name: string;
  githubInstallationId: string | null;
  repoFullName: string;
  repoUrl: string;
  defaultBranch: string;
  containerPort: number | null;
  healthPath: string | null;
  migrationCommand: string | null;
  workerCommand: string | null;
  databaseRequired: boolean;
  storageRequired: boolean;
  redisRequired: boolean;
  analysisStatus: AnalysisStatus;
  compatibilityStatus: CompatibilityStatus | null;
  compatibilityReason: string | null;
  detectedMetadata: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(`${apiUrl}${path}`, {
    credentials: 'include',
    cache: 'no-store',
  });
  if (!response.ok) {
    throw new Error(`Applications request failed (${response.status})`);
  }
  return (await response.json()) as T;
}

/** Fetch one application (§35). */
export function fetchApplication(id: string): Promise<Application> {
  return getJson<Application>(`/api/applications/${encodeURIComponent(id)}`);
}

/** List the org's applications (used to populate the "Application" picker
 * on the Create Customer Deployment screen, §12). */
export async function fetchApplications(): Promise<Application[]> {
  const body = await getJson<{ applications?: Application[] }>('/api/applications');
  return body.applications ?? [];
}

export interface CreateApplicationInput {
  name: string;
  githubInstallationId: string;
  repoFullName: string;
  repoUrl: string;
  defaultBranch: string;
}

/**
 * §42 step 2 "Choose repository" — creates the real Application row so the
 * readiness page has something real to analyse and show, instead of a
 * navigate-only "Choose" button that never persists anything.
 */
export async function createApplication(input: CreateApplicationInput): Promise<Application> {
  const response = await fetch(`${apiUrl}/api/applications`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!response.ok) {
    throw new Error(`Create application failed (${response.status})`);
  }
  return (await response.json()) as Application;
}

/** §42 step 3 "Deployz analyses application" — kicks off analysis. */
export async function triggerAnalysis(applicationId: string): Promise<void> {
  const response = await fetch(
    `${apiUrl}/api/applications/${encodeURIComponent(applicationId)}/analyse`,
    { method: 'POST', credentials: 'include' },
  );
  if (!response.ok) {
    throw new Error(`Trigger analysis failed (${response.status})`);
  }
}

export interface UpdateApplicationInput {
  name?: string;
  containerPort?: number | null;
  healthPath?: string | null;
  migrationCommand?: string | null;
  workerCommand?: string | null;
  databaseRequired?: boolean;
  storageRequired?: boolean;
}

export async function updateApplication(id: string, input: UpdateApplicationInput): Promise<Application> {
  const response = await fetch(`${apiUrl}/api/applications/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!response.ok) {
    throw new Error(`Update application failed (${response.status})`);
  }
  return (await response.json()) as Application;
}

export async function deleteApplication(id: string): Promise<void> {
  const response = await fetch(`${apiUrl}/api/applications/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    credentials: 'include',
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    const err = new Error(body?.error?.message ?? 'We couldn\'t remove this application. Try again in a moment.');
    (err as { code?: string }).code = body?.error?.code;
    throw err;
  }
}
