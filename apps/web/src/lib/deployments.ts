import type { VendorDeploymentStatus } from '@deployz/contracts';

import type { DeploymentState } from './deployment-vocabulary';
import type { CustomDomainStatus } from './domains';

// Fleet-surface data access. Wired to the real `/api/deployments` endpoints.
// No fixture fallback: a 404/error is a real failure, not a loading state
// (an empty list is the genuine empty state, handled by the caller). §46
// vocabulary only — no raw AWS/CFN/ECS terms at the top level (M14:
// deployment health only).

import { apiRequest } from '@/lib/api-client';
import { apiUrl } from '@/lib/api-url';

// ── Wire shapes ────────────────────────────────────────────────────────────

export type RelayStatus = 'CONNECTED' | 'DISCONNECTED' | 'UNKNOWN';
export type HealthStatus = 'UNKNOWN' | 'HEALTHY' | 'DEGRADED' | 'UNHEALTHY';
/** A required component the verifier found no AWS resource for. */
export type ComponentState = HealthStatus | 'NOT_PROVISIONED';

/** What the installed relay can execute. Null = relay never reported
 *  capabilities (pre-capability build) — the UI treats that as nothing
 *  supported. */
export interface RelayCapabilities {
  deployRelease: boolean;
  rollback: boolean;
  restart: boolean;
  configUpdate: boolean;
  destroy: boolean;
  domainManagement: boolean;
}

/** §24 the components a relay reports on. Absent = not required. */
export interface HealthComponents {
  application?: ComponentState;
  database?: ComponentState;
  storage?: ComponentState;
  loadBalancer?: ComponentState;
  /** Present only when the application requires a managed Redis cache. */
  redis?: ComponentState;
}

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
  healthStatus: HealthStatus;
  /** Per-component health as last reported. Null until the relay reports. */
  components: HealthComponents | null;
  /** The public install link id — never the relay's installation id. */
  installLinkId: string;
  desiredState: Record<string, unknown>;
  observedState: Record<string, unknown> | null;
  infraVersion: string;
  installationId: string;
  isTestDeployment: boolean;
  lastHealthAt: string | null;
  deletedAt: string | null;
  /** What the control plane knows about AWS leftovers at disconnect. */
  cleanupState: 'SKIPPED_RELAY_OFFLINE' | 'PURGE_FAILED' | 'COMPLETE' | null;
  createdAt: string;
  updatedAt: string;
  createdBy: string | null;
  updatedBy: string | null;
  customerName: string;
  applicationName: string;
  /** Current release version, or null if no release has been deployed yet. */
  version: string | null;
  /** Version of the installed relay, once it has reported it. */
  relayVersion: string | null;
  /** Version of the customer's bootstrap stack, once the relay reported it. */
  bootstrapVersion: string | null;
  /** Capabilities advertised by the installed relay; null = unknown. */
  relayCapabilities: RelayCapabilities | null;
  /** Digest the relay last observed running in ECS; null = not observed. */
  runningImageDigest: string | null;
  /** Install-attempt counter; bumped by each retry. */
  attemptNumber: number;
  /** The expected bootstrap stack name once an attempt has launched. */
  bootstrapStackName: string | null;
  /** When the customer launched the current install attempt. */
  installStartedAt: string | null;
  /** The read-time derived stage/progress projection (vendor detail) — the
   *  single source both fleet surfaces render "where is this deployment
   *  right now" from, so the list and detail pages can never disagree. */
  deploymentStatus: VendorDeploymentStatus;
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
  /** Last progress signal (relay acknowledgement, heartbeat, result). */
  lastProgressAt: string | null;
  finishedAt: string | null;
}

/** `GET /api/deployments/:id` — the fleet row plus its job history. */
export interface FleetDeploymentDetail extends FleetDeployment {
  jobs: DeploymentJob[];
  /** Compact custom-domain summary for the detail page, or null if none is attached. */
  customDomain: { hostname: string; status: CustomDomainStatus } | null;
  /** The deployment's public application URL, or null if it has none yet. */
  appUrl: string | null;
}

// ── Infrastructure inventory (Lane 3 composed component view) ───────────────

export type InfrastructureComponentKind =
  | 'application'
  | 'database'
  | 'storage'
  | 'cache'
  | 'endpoint'
  | 'network'
  | 'monitoring'
  | 'container_registry'
  | 'other';

export type InfrastructureComponentStatus =
  | 'pending'
  | 'provisioning'
  | 'ready'
  | 'updating'
  | 'deleting'
  | 'failed'
  | 'retained'
  | 'removed'
  | 'unknown';

export type InfrastructureLifecycle = 'delete' | 'retain' | 'snapshot' | 'conditional';

export type InfrastructureConnectionState = 'connected' | 'disconnected';
export type InfrastructureSnapshotState = 'fresh' | 'stale' | 'none';

export type InfrastructureSummaryStatus =
  | 'healthy'
  | 'provisioning'
  | 'updating'
  | 'degraded'
  | 'failed'
  | 'deleting'
  | 'retained'
  | 'unknown';

export interface InfrastructureResource {
  logicalId: string;
  physicalId: string | null;
  type: string;
  status: string;
  statusReason: string | null;
}

export interface InfrastructureComponent {
  kind: InfrastructureComponentKind;
  name: string;
  purpose: string;
  status: InfrastructureComponentStatus;
  awsService: string;
  region: string;
  lifecycle: InfrastructureLifecycle;
  resources: InfrastructureResource[];
}

export interface InfrastructureSummary {
  status: InfrastructureSummaryStatus;
  componentCount: number;
  technicalResourceCount: number;
}

export interface InfrastructureDisconnectWarning {
  lastVerifiedAt: string;
}

export interface InfrastructureResponse {
  provider: 'aws';
  region: string;
  stackStatus: string | null;
  connectionState: InfrastructureConnectionState;
  snapshotState: InfrastructureSnapshotState;
  summary: InfrastructureSummary;
  components: InfrastructureComponent[];
  lastUpdatedAt: string | null;
  disconnectWarning: InfrastructureDisconnectWarning | null;
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

/** A failed deployment fetch that knows WHICH HTTP status failed. */
export class DeploymentRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'DeploymentRequestError';
  }
}

/** True when the error is a 404 — the deployment doesn't exist or is hidden
 *  from this caller, which is a different screen from a transient failure. */
export function isDeploymentNotFound(error: unknown): boolean {
  return error instanceof DeploymentRequestError && error.status === 404;
}

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(`${apiUrl}${path}`, {
    credentials: 'include',
    cache: 'no-store',
  });
  if (!response.ok) {
    throw new DeploymentRequestError(`Deployments request failed (${response.status})`, response.status);
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

/** Fetch the composed infrastructure inventory for a deployment (Lane 3). */
export function fetchDeploymentInfrastructure(id: string): Promise<InfrastructureResponse> {
  return getJson<InfrastructureResponse>(`/api/deployments/${encodeURIComponent(id)}/infrastructure`);
}

/** Fetch a deployment's activity feed (§40). */
export async function fetchDeploymentEvents(id: string): Promise<ActivityEvent[]> {
  const body = await getJson<{ events?: ActivityEvent[] }>(
    `/api/deployments/${encodeURIComponent(id)}/events`,
  );
  return body.events ?? [];
}

// ── Action triggers (§24, §25, §27, §63) ────────────────────────────────────

/** A failed action that knows WHICH status and error code came back. */
export class DeploymentActionError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(`Deployment action failed (${status})`);
    this.name = 'DeploymentActionError';
  }
}

/**
 * User-facing message for a failed action. A DEPLOYMENT_BUSY 409 is not a
 * transient fault — "try again in a moment" sent people into a retry loop
 * against the busy gate; say what is actually happening instead.
 */
export function actionErrorMessage(caught: unknown, fallback: string): string {
  if (caught instanceof DeploymentActionError && caught.code === 'DEPLOYMENT_BUSY') {
    return 'Another operation is already running on this deployment. Wait for it to finish, then try again.';
  }
  return fallback;
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`${apiUrl}${path}`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const payload: unknown = await response.json().catch(() => null);
    const envelope = payload as { error?: { code?: string } } | null;
    throw new DeploymentActionError(response.status, envelope?.error?.code ?? 'REQUEST_FAILED');
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

/** §24 "Restart application" — POST /api/deployments/:id/restart. */
export function restartDeployment(deploymentId: string): Promise<JobResult> {
  return postJson<JobResult>(`/api/deployments/${encodeURIComponent(deploymentId)}/restart`, {});
}

/**
 * Recovery for a failed FIRST install — POST /api/deployments/:id/retry-install.
 * The relay is authorized to clean up the failed stack and its orphaned
 * blockers before recreating; refused once any install has succeeded.
 */
export function retryInstall(deploymentId: string): Promise<JobResult> {
  return postJson<JobResult>(
    `/api/deployments/${encodeURIComponent(deploymentId)}/retry-install`,
    {},
  );
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

/**
 * Mirrors DESTROY_PENDING_STALE_AFTER_MS in @deployz/contracts — the API's
 * force-complete gate enforces the same value. The web app mirrors wire
 * constants locally rather than importing the contracts package (the web
 * image stages no workspace packages beyond copy-map).
 */
export const DESTROY_PENDING_STALE_AFTER_MS = 60 * 60 * 1000;

export interface ForceCompleteResult {
  state: string;
  cleanupState: string;
}

/**
 * Settle a disconnect whose relay went offline mid-delete. Control-plane
 * only: the API refuses it unless the DESTROY has been pending past
 * DESTROY_PENDING_STALE_AFTER_MS on a relay the sweep confirmed offline, and
 * the deployment keeps the "resources may remain" warning afterwards.
 */
export function forceCompleteDisconnect(
  deploymentId: string,
): Promise<ForceCompleteResult> {
  return postJson<ForceCompleteResult>(
    `/api/deployments/${encodeURIComponent(deploymentId)}/disconnect/force-complete`,
    {},
  );
}

/**
 * P2 "Permanently remove retained AWS resources" — POST
 * /api/deployments/:id/purge. Eligible only for a force-completed
 * deployment; the relay re-verifies ownership of every resource before
 * deleting it, and a successful purge clears the retained-resources warning.
 */
export function purgeDeployment(deploymentId: string): Promise<JobResult> {
  return postJson<JobResult>(`/api/deployments/${encodeURIComponent(deploymentId)}/purge`, {});
}

/**
 * §14 clear the relay binding and mint a fresh enrollment code.
 *
 * The recovery path when a customer has to install again: the binding is
 * single-use, so something has to be able to clear it, and that something is
 * a deliberate vendor action rather than anyone who has the link.
 */
export function resetRelay(deploymentId: string): Promise<{ installLinkId: string }> {
  return postJson<{ installLinkId: string }>(
    `/api/deployments/${encodeURIComponent(deploymentId)}/relay/reset`,
    {},
  );
}

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

/** §37 create customer — POST /api/customers. Routed through `apiRequest`
 *  (not `postJson`) so a failure carries the server's message (§65) rather
 *  than just a status/code. */
export function createCustomerRecord(input: CreateCustomerInput): Promise<CustomerRecord> {
  return apiRequest<CustomerRecord>('/api/customers', {
    method: 'POST',
    body: {
      name: input.name,
      email: input.email,
      company: input.company ?? null,
      externalReference: input.externalReference ?? null,
    },
  });
}

/** A customer already created by an earlier failed create-deployment
 *  attempt (§12 screen 12) — kept so a retry can reuse it instead of
 *  inserting a duplicate customer row (CANARY-004). */
export interface RememberedCustomer {
  id: string;
  name: string;
  email: string;
}

/** True when `remembered` was created for the same trimmed name/email the
 *  form now carries, so the retry should reuse its id rather than calling
 *  `createCustomerRecord` again. */
export function matchesRememberedCustomer(
  remembered: RememberedCustomer | null,
  name: string,
  email: string,
): remembered is RememberedCustomer {
  return remembered !== null && remembered.name === name && remembered.email === email;
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
  /** The public install link id. The relay's own id is minted in the customer's account. */
  installLinkId: string;
  isTestDeployment: boolean;
  createdAt: string;
}

/** §12/§38 create deployment — POST /api/deployments. Stays NOT_INSTALLED
 * until the customer approves the AWS CloudFormation stack and the relay
 * first registers. Routed through `apiRequest` so a readiness rejection
 * (e.g. MANIFEST_NOT_COMPATIBLE) surfaces its real message instead of a
 * generic one. */
export function createDeploymentRecord(input: CreateDeploymentInput): Promise<DeploymentRecord> {
  return apiRequest<DeploymentRecord>('/api/deployments', {
    method: 'POST',
    body: {
      applicationId: input.applicationId,
      customerId: input.customerId,
      region: input.region,
      isTestDeployment: input.isTestDeployment ?? false,
    },
  });
}
