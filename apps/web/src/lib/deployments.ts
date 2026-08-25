import type { DeploymentState } from './deployment-vocabulary';

// Fleet-surface data access. Wired to the real `/api/deployments` endpoints.
// No fixture fallback: a 404/error is a real failure, not a loading state
// (an empty list is the genuine empty state, handled by the caller). §46
// vocabulary only — no raw AWS/CFN/ECS terms at the top level (M14:
// deployment health only).

import { apiUrl } from '@/lib/api-url';

// ── Wire shapes ────────────────────────────────────────────────────────────

export type RelayStatus = 'CONNECTED' | 'DISCONNECTED' | 'UNKNOWN';
export type HealthStatus = 'HEALTHY' | 'DEGRADED' | 'UNHEALTHY';

/**
 * A deployment row exactly as `GET /api/deployments` returns it: the raw
 * `deployments` table columns (§38) plus the joined display fields the UI
 * needs (§23/§24) — customer/application name and current version. The AWS
 * account id arrives already masked by the API.
 */
export interface FleetDeployment {
  id: string;
  customerId: string;
  applicationId: string;
  organizationId: string;
  region: string;
  state: DeploymentState;
  awsAccountId: string | null;
  currentReleaseId: string | null;
  previousReleaseId: string | null;
  relayStatus: RelayStatus;
  healthStatus: HealthStatus | null;
  desiredState: Record<string, unknown>;
  observedState: Record<string, unknown> | null;
  infraVersion: string;
  installationId: string;
  isTestDeployment: boolean;
  lastHealthAt: string | null;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
  createdBy: string | null;
  updatedBy: string | null;
  customerName: string;
  applicationName: string;
  /** Current release version, or null if no release has been deployed yet. */
  version: string | null;
}

/** A §39 deployment job, as returned in the deployment-detail `jobs` array. */
export interface DeploymentJob {
  id: string;
  deploymentId: string;
  type: string;
  state: string;
  idempotencyKey: string;
  payload: Record<string, unknown>;
  result: Record<string, unknown> | null;
  requestedBy: string | null;
  failureCode: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

/** `GET /api/deployments/:id` — the fleet row plus its job history. */
export interface FleetDeploymentDetail extends FleetDeployment {
  jobs: DeploymentJob[];
}

/** A single §40 activity-feed event. */
export interface ActivityEvent {
  occurredAt: string;
  eventType: string;
  actorType: string;
  result: string | null;
  previousState: string | null;
  requestedState: string | null;
  payload: Record<string, unknown>;
}

// ── Fetch helpers ──────────────────────────────────────────────────────────

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(`${apiUrl}${path}`, {
    credentials: 'include',
    cache: 'no-store',
  });
  if (!response.ok) {
    throw new Error(`Deployments request failed (${response.status})`);
  }
  return (await response.json()) as T;
}

/** Fetch the fleet's deployments (§23). */
export async function fetchDeployments(): Promise<FleetDeployment[]> {
  const body = await getJson<{ deployments?: FleetDeployment[] }>('/api/deployments');
  return body.deployments ?? [];
}

/** Fetch one application's deployments (used to check for a test deployment, §25 bulk deploy). */
export async function fetchDeploymentsForApplication(
  applicationId: string,
): Promise<FleetDeployment[]> {
  const body = await getJson<{ deployments?: FleetDeployment[] }>(
    `/api/deployments?applicationId=${encodeURIComponent(applicationId)}`,
  );
  return body.deployments ?? [];
}

/** Fetch one deployment detail (§24). */
export function fetchDeployment(id: string): Promise<FleetDeploymentDetail> {
  return getJson<FleetDeploymentDetail>(`/api/deployments/${encodeURIComponent(id)}`);
}

/** Fetch a deployment's activity feed (§40). */
export async function fetchDeploymentEvents(id: string): Promise<ActivityEvent[]> {
  const body = await getJson<{ events?: ActivityEvent[] }>(
    `/api/deployments/${encodeURIComponent(id)}/events`,
  );
  return body.events ?? [];
}

// ── Action triggers (§24, §25, §27, §63) ────────────────────────────────────

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`${apiUrl}${path}`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`Deployment action failed (${response.status})`);
  }
  return (await response.json()) as T;
}

export interface JobResult {
  jobId: string;
  state: string;
}

/** §24 "Deploy Update" — POST /api/deployments/:id/deploy. */
export function deployRelease(deploymentId: string, releaseId: string): Promise<JobResult> {
  return postJson<JobResult>(`/api/deployments/${encodeURIComponent(deploymentId)}/deploy`, {
    releaseId,
  });
}

/** §24/§27 "Rollback" — POST /api/deployments/:id/rollback. */
export function rollbackDeployment(deploymentId: string, releaseId: string): Promise<JobResult> {
  return postJson<JobResult>(`/api/deployments/${encodeURIComponent(deploymentId)}/rollback`, {
    releaseId,
  });
}

/** §24/§63 "Disconnect Deployment" — POST /api/deployments/:id/destroy. */
export function destroyDeployment(
  deploymentId: string,
  finalSnapshot?: boolean,
): Promise<JobResult> {
  return postJson<JobResult>(`/api/deployments/${encodeURIComponent(deploymentId)}/destroy`, {
    finalSnapshot: finalSnapshot ?? false,
  });
}

export interface BulkDeployResultRow {
  deploymentId: string;
  status: 'REQUESTED' | 'ALREADY_REQUESTED' | 'SKIPPED';
  jobId?: string;
  reason?: string;
}

/** §25 bulk deploy — POST /api/applications/:id/deploy-bulk. */
export function deployBulk(
  applicationId: string,
  releaseId: string,
  deploymentIds?: string[],
): Promise<{ results: BulkDeployResultRow[] }> {
  return postJson<{ results: BulkDeployResultRow[] }>(
    `/api/applications/${encodeURIComponent(applicationId)}/deploy-bulk`,
    { releaseId, deploymentIds: deploymentIds ?? null },
  );
}

/** §25 deployable states — the fleet-view states a release can be rolled out to. */
export const BULK_DEPLOYABLE_STATES: readonly DeploymentState[] = ['HEALTHY', 'UPDATE_AVAILABLE'];

// ── Create Customer Deployment (§12, §41 screen 12) ─────────────────────────

export interface CreateCustomerInput {
  name: string;
  email: string;
  company?: string | null;
  externalReference?: string | null;
}

export interface CustomerRecord {
  id: string;
  organizationId: string;
  name: string;
  email: string;
  company: string | null;
  externalReference: string | null;
  createdAt: string;
}

/** §37 create customer — POST /api/customers. */
export function createCustomerRecord(input: CreateCustomerInput): Promise<CustomerRecord> {
  return postJson<CustomerRecord>('/api/customers', {
    name: input.name,
    email: input.email,
    company: input.company ?? null,
    externalReference: input.externalReference ?? null,
  });
}

export interface CreateDeploymentInput {
  applicationId: string;
  customerId: string;
  region: string;
  isTestDeployment?: boolean;
}

/** The raw `deployments` insert result — no joined display fields (unlike FleetDeployment). */
export interface DeploymentRecord {
  id: string;
  customerId: string;
  applicationId: string;
  organizationId: string;
  region: string;
  state: DeploymentState;
  installationId: string;
  isTestDeployment: boolean;
  createdAt: string;
}

/** §12/§38 create deployment — POST /api/deployments. Stays NOT_INSTALLED
 * until the customer approves the AWS CloudFormation stack and the relay
 * first registers. */
export function createDeploymentRecord(input: CreateDeploymentInput): Promise<DeploymentRecord> {
  return postJson<DeploymentRecord>('/api/deployments', {
    applicationId: input.applicationId,
    customerId: input.customerId,
    region: input.region,
    isTestDeployment: input.isTestDeployment ?? false,
  });
}
