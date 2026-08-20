import type { DeploymentState } from './deployment-vocabulary';

// Fleet-surface data access. The deployments API endpoint arrives in a later
// todo; until then these fetchers fall back to realistic FIXTURE data on a 404
// so the dashboard renders a fleet without a backend. §46 vocabulary only —
// no raw AWS/CFN/ECS terms at the top level (M14: deployment health only).

const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

// ── Wire shapes ────────────────────────────────────────────────────────────

/** A deployment row on the fleet dashboard. */
export interface FleetDeployment {
  id: string;
  /** Display name (application name). */
  name: string;
  /** Customer name. */
  customer: string;
  /** §46 product-vocabulary state. */
  state: DeploymentState;
  region: string;
  installationId: string;
  infraVersion: string;
  lastHealthAt: string | null;
}

/** One deployment-health signal (§28) as rendered on the detail page. */
export interface DeploymentHealthSignal {
  key: string;
  /** §65-friendly label (e.g. "Traffic", "Database"). */
  label: string;
  status: 'HEALTHY' | 'DEGRADED' | 'UNHEALTHY';
  /** §65-friendly one-liner. */
  summary: string;
  /** Technical values (rendered behind an expandable layer). */
  detail?: Record<string, unknown>;
}

/** A deployment detail, incl. health signals + desired/observed state. */
export interface FleetDeploymentDetail extends FleetDeployment {
  desiredState: Record<string, unknown>;
  observedState: Record<string, unknown> | null;
  signals: DeploymentHealthSignal[];
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

/** Fetch the fleet's deployments, falling back to fixture data when the endpoint is absent (404). */
export async function fetchDeployments(): Promise<FleetDeployment[]> {
  try {
    const body = await getJson<{ deployments?: FleetDeployment[] }>('/api/deployments');
    return body.deployments ?? [];
  } catch (error) {
    if (isNotFound(error)) return FIXTURE_DEPLOYMENTS;
    throw error;
  }
}

/** Fetch one deployment detail, falling back to fixture data on 404. */
export async function fetchDeployment(id: string): Promise<FleetDeploymentDetail> {
  try {
    return await getJson<FleetDeploymentDetail>(
      `/api/deployments/${encodeURIComponent(id)}`,
    );
  } catch (error) {
    if (isNotFound(error)) {
      const fixture = FIXTURE_DETAILS.find((d) => d.id === id);
      if (fixture) return fixture;
      throw new Error(`Deployment ${id} not found`);
    }
    throw error;
  }
}

/** Fetch a deployment's activity feed, falling back to fixture events on 404. */
export async function fetchDeploymentEvents(id: string): Promise<ActivityEvent[]> {
  try {
    const body = await getJson<{ events?: ActivityEvent[] }>(
      `/api/deployments/${encodeURIComponent(id)}/events`,
    );
    return body.events ?? [];
  } catch (error) {
    if (isNotFound(error)) return FIXTURE_EVENTS[id] ?? [];
    throw error;
  }
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && error.message.includes('(404)');
}

// ── Fixture data (§46 vocabulary, no raw AWS terms) ───────────────────────

export const FIXTURE_DEPLOYMENTS: FleetDeployment[] = [
  {
    id: 'deployment-acme-analytics',
    name: 'Acme Analytics',
    customer: 'Acme Corp',
    state: 'HEALTHY',
    region: 'us-east-1',
    installationId: 'inst-acme-analytics',
    infraVersion: 'runtime-v1',
    lastHealthAt: '2026-08-20T12:00:00.000Z',
  },
  {
    id: 'deployment-northwind-shop',
    name: 'Northwind Shop',
    customer: 'Northwind Retail',
    state: 'INSTALLING',
    region: 'eu-west-1',
    installationId: 'inst-northwind-shop',
    infraVersion: 'runtime-v1',
    lastHealthAt: null,
  },
  {
    id: 'deployment-globex-portal',
    name: 'Globex Portal',
    customer: 'Globex Inc',
    state: 'FAILED',
    region: 'ap-southeast-1',
    installationId: 'inst-globex-portal',
    infraVersion: 'runtime-v1',
    lastHealthAt: '2026-08-20T08:15:00.000Z',
  },
];

function healthySignals(): DeploymentHealthSignal[] {
  return [
    { key: 'stack', label: 'Infrastructure', status: 'HEALTHY', summary: 'Infrastructure is up to date.' },
    { key: 'service', label: 'Service', status: 'HEALTHY', summary: 'All tasks are running.', detail: { runningTasks: 2, desiredTasks: 2 } },
    { key: 'target-health', label: 'Traffic', status: 'HEALTHY', summary: 'All routes are healthy.', detail: { healthyRoutes: 2, unhealthyRoutes: 0 } },
    { key: 'rds', label: 'Database', status: 'HEALTHY', summary: 'The database is reachable and backups are enabled.' },
    { key: 'relay', label: 'Connection', status: 'HEALTHY', summary: 'The helper is connected and checking in.', detail: { lastContactMsAgo: 9000 } },
    { key: 'http', label: 'App health', status: 'HEALTHY', summary: "The app's health check is passing.", detail: { statusCode: 200 } },
    { key: 'utilization', label: 'Capacity', status: 'HEALTHY', summary: 'Capacity is within limits.', detail: { cpuPercent: 34, memoryPercent: 51 } },
    { key: 'consistency', label: 'State', status: 'HEALTHY', summary: 'Reported state matches what we expect.' },
  ];
}

export const FIXTURE_DETAILS: FleetDeploymentDetail[] = [
  {
    ...FIXTURE_DEPLOYMENTS[0]!,
    desiredState: { infraVersion: 'runtime-v1', state: 'HEALTHY' },
    observedState: { infraVersion: 'runtime-v1', state: 'HEALTHY' },
    signals: healthySignals(),
  },
  {
    ...FIXTURE_DEPLOYMENTS[1]!,
    desiredState: { infraVersion: 'runtime-v1', state: 'HEALTHY' },
    observedState: { state: 'INSTALLING' },
    signals: [
      { key: 'stack', label: 'Infrastructure', status: 'DEGRADED', summary: 'Infrastructure is still provisioning.' },
      { key: 'relay', label: 'Connection', status: 'HEALTHY', summary: 'The helper is connected and checking in.', detail: { lastContactMsAgo: 2000 } },
      { key: 'consistency', label: 'State', status: 'DEGRADED', summary: 'Reported state has drifted from what we expect.' },
    ],
  },
  {
    ...FIXTURE_DEPLOYMENTS[2]!,
    desiredState: { infraVersion: 'runtime-v1', state: 'HEALTHY' },
    observedState: { infraVersion: 'runtime-v1', state: 'FAILED' },
    signals: [
      { key: 'stack', label: 'Infrastructure', status: 'UNHEALTHY', summary: 'Infrastructure is in a failed state.' },
      { key: 'service', label: 'Service', status: 'UNHEALTHY', summary: 'No tasks are running.', detail: { runningTasks: 0, desiredTasks: 2 } },
      { key: 'http', label: 'App health', status: 'UNHEALTHY', summary: "The app's health check is unreachable.", detail: { statusCode: null } },
      { key: 'consistency', label: 'State', status: 'DEGRADED', summary: 'Reported state has drifted from what we expect.' },
    ],
  },
];

export const FIXTURE_EVENTS: Record<string, ActivityEvent[]> = {
  'deployment-acme-analytics': [
    {
      occurredAt: '2026-08-20T09:00:00.000Z',
      eventType: 'install.state.healthy',
      actorType: 'system',
      result: 'ok',
      previousState: 'INSTALLING',
      requestedState: 'HEALTHY',
      payload: { installationId: 'inst-acme-analytics' },
    },
    {
      occurredAt: '2026-08-20T10:30:00.000Z',
      eventType: 'deploy.preflight',
      actorType: 'system',
      result: 'passed',
      previousState: 'HEALTHY',
      requestedState: 'UPDATING',
      payload: { region: 'us-east-1' },
    },
    {
      occurredAt: '2026-08-20T10:31:00.000Z',
      eventType: 'deploy.state.updating',
      actorType: 'system',
      result: 'ok',
      previousState: 'HEALTHY',
      requestedState: 'UPDATING',
      payload: { releaseVersion: 'v1.2.0' },
    },
    {
      occurredAt: '2026-08-20T10:34:00.000Z',
      eventType: 'deploy.state.healthy',
      actorType: 'system',
      result: 'ok',
      previousState: 'UPDATING',
      requestedState: 'HEALTHY',
      payload: { releaseVersion: 'v1.2.0' },
    },
    {
      occurredAt: '2026-08-20T12:00:00.000Z',
      eventType: 'health.report',
      actorType: 'relay',
      result: 'ok',
      previousState: 'HEALTHY',
      requestedState: 'HEALTHY',
      payload: { installationId: 'inst-acme-analytics' },
    },
  ],
  'deployment-northwind-shop': [
    {
      occurredAt: '2026-08-20T11:00:00.000Z',
      eventType: 'install.state.installing',
      actorType: 'system',
      result: 'ok',
      previousState: 'NOT_INSTALLED',
      requestedState: 'INSTALLING',
      payload: { installationId: 'inst-northwind-shop' },
    },
  ],
  'deployment-globex-portal': [
    {
      occurredAt: '2026-08-20T07:00:00.000Z',
      eventType: 'install.state.healthy',
      actorType: 'system',
      result: 'ok',
      previousState: 'INSTALLING',
      requestedState: 'HEALTHY',
      payload: { installationId: 'inst-globex-portal' },
    },
    {
      occurredAt: '2026-08-20T08:15:00.000Z',
      eventType: 'deploy.state.updating',
      actorType: 'system',
      result: 'ok',
      previousState: 'HEALTHY',
      requestedState: 'UPDATING',
      payload: { releaseVersion: 'v2.0.0' },
    },
    {
      occurredAt: '2026-08-20T08:20:00.000Z',
      eventType: 'deploy.ecs-update',
      actorType: 'system',
      result: 'failed:ECS_DEPLOYMENT_FAILED',
      previousState: 'UPDATING',
      requestedState: 'UPDATING',
      payload: { imageDigest: 'sha256:deadbeef' },
    },
  ],
};
