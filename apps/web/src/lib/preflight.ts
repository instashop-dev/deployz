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
  heading: string;
  /** Visual tone — ready is green, warnings amber, blocked red. */
  tone: 'ready' | 'attention' | 'blocked';
  /** One supporting line. */
  summary: string;
}

/** The headline, tone and supporting line for a preflight state. */
export function preflightPresentation(result: PreflightResult): PreflightPresentation {
  const blockers = result.blockers.length;
  const warnings = result.warnings.length;
  switch (result.state) {
    case 'READY':
      return { heading: 'Ready to deploy', tone: 'ready', summary: 'Every deployment check passed.' };
    case 'READY_WITH_WARNINGS':
      return {
        heading: 'Ready to deploy',
        tone: 'attention',
        summary: `${warnings} ${warnings === 1 ? 'recommendation' : 'recommendations'} — deployment can go ahead.`,
      };
    case 'ACTION_REQUIRED':
      return {
        heading: 'Action required',
        tone: 'blocked',
        summary: `Fix ${blockers === 1 ? 'this issue' : `these ${blockers} issues`} before deployment.`,
      };
    case 'UNSUPPORTED':
      return {
        heading: "Can't deploy this application yet",
        tone: 'blocked',
        summary: 'This application needs changes before Deployz can deploy it.',
      };
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
