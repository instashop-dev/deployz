// Pre-deployment preflight (AI MVP Phase 5) — data access and presentation
// for `GET /api/applications/:id/preflight` and `GET /api/deployments/:id/
// preflight`. The result is the deterministic gate every path into AWS
// provisioning runs; the UI shows it before the vendor creates a deployment
// and beside the install link. §65: plain words, never a percentage.

import { apiUrl } from '@/lib/api-url';

export type PreflightState = 'READY' | 'READY_WITH_WARNINGS' | 'ACTION_REQUIRED' | 'UNSUPPORTED';

export interface PreflightCheck {
  id: string;
  label: string;
  status: 'passed' | 'warning' | 'blocked';
  detail: string | null;
}

export interface PreflightFinding {
  id: string;
  category: string;
  severity: 'error' | 'warning';
  message: string;
}

/** The wire shape of both preflight routes. */
export interface PreflightResult {
  state: PreflightState;
  ready: boolean;
  blockers: PreflightFinding[];
  warnings: PreflightFinding[];
  checks: PreflightCheck[];
}

export interface PreflightPresentation {
  /** The one status line, e.g. "11 checks passed". */
  heading: string;
  /** Visual tone — ready is green, warnings amber, blocked red. */
  tone: 'ready' | 'attention' | 'blocked';
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** The status line and tone for a preflight result with `passedCount` passed checks. */
export function preflightPresentation(result: PreflightResult, passedCount: number): PreflightPresentation {
  const passed = plural(passedCount, 'check passed', 'checks passed');
  switch (result.state) {
    case 'READY':
      return { heading: passed, tone: 'ready' };
    case 'READY_WITH_WARNINGS':
      return {
        heading: `${passed}, ${plural(result.warnings.length, 'recommendation', 'recommendations')}`,
        tone: 'attention',
      };
    case 'ACTION_REQUIRED':
      return {
        heading: `Fix ${plural(result.blockers.length, 'issue', 'issues')} before deploying`,
        tone: 'blocked',
      };
    case 'UNSUPPORTED':
      return { heading: "Can't deploy this application yet", tone: 'blocked' };
  }
}

/** Fetch the preflight for an application, optionally against one customer's configuration. */
export async function fetchApplicationPreflight(applicationId: string, customerId?: string): Promise<PreflightResult> {
  const query = customerId ? `?customerId=${encodeURIComponent(customerId)}` : '';
  const response = await fetch(`${apiUrl}/api/applications/${encodeURIComponent(applicationId)}/preflight${query}`, {
    credentials: 'include',
    cache: 'no-store',
  });
  if (!response.ok) throw new Error(`Preflight request failed (${response.status})`);
  return (await response.json()) as PreflightResult;
}

/** Fetch the preflight for a deployment that has not provisioned yet. */
export async function fetchDeploymentPreflight(deploymentId: string): Promise<PreflightResult> {
  const response = await fetch(`${apiUrl}/api/deployments/${encodeURIComponent(deploymentId)}/preflight`, {
    credentials: 'include',
    cache: 'no-store',
  });
  if (!response.ok) throw new Error(`Preflight request failed (${response.status})`);
  return (await response.json()) as PreflightResult;
}
