// Homepage state derivation. The homepage renders one of five states from
// the organization's real applications and deployments — there is no separate
// "homepage" endpoint, and nothing here invents data the backend does not
// have. Kept pure (no fetching, no React) so it is unit-testable.

import type { Application } from './applications';
import type { FleetDeployment } from './deployments';

// ── Deployments that need the vendor to act ────────────────────────────────

/**
 * Why this deployment needs attention, or null when it does not. Only the
 * §46 states and the relay/health columns the API actually returns are
 * classified — never a fabricated condition.
 */
export function attentionReason(deployment: FleetDeployment): string | null {
  if (deployment.state === 'FAILED') return 'Deployment failed';
  if (deployment.state === 'DISCONNECTED') return 'Deployment disconnected';
  // A deployment nobody has installed yet, or one on its way out, cannot be
  // unhealthy in a way the vendor can act on.
  if (
    deployment.state === 'NOT_INSTALLED' ||
    deployment.state === 'DELETING' ||
    deployment.state === 'DELETED'
  ) {
    return null;
  }
  if (deployment.relayStatus === 'DISCONNECTED') return 'Lost contact with this deployment';
  if (deployment.healthStatus === 'UNHEALTHY') return 'Health check failing';
  if (deployment.healthStatus === 'DEGRADED') return 'Health check degraded';
  return null;
}

/** A deployment that needs the vendor to act, paired with the reason to show. */
export interface AttentionItem {
  deployment: FleetDeployment;
  reason: string;
}

// ── Fleet summary ──────────────────────────────────────────────────────────

/** The compact fleet counts shown above the list. Deployment health only. */
export interface FleetSummary {
  /** Customer deployments that still exist (deleted ones are excluded). */
  total: number;
  healthy: number;
  attention: number;
  deploying: number;
  /** Created, but the customer has not installed it yet. */
  waiting: number;
}

/** Deployments the vendor still has: deleted ones leave the homepage. */
function activeDeployments(deployments: FleetDeployment[]): FleetDeployment[] {
  return deployments.filter(
    (deployment) => deployment.state !== 'DELETED' && deployment.deletedAt === null,
  );
}

export function summarise(deployments: FleetDeployment[]): FleetSummary {
  const summary: FleetSummary = {
    total: deployments.length,
    healthy: 0,
    attention: 0,
    deploying: 0,
    waiting: 0,
  };
  for (const deployment of deployments) {
    if (attentionReason(deployment) !== null) {
      summary.attention += 1;
    } else if (deployment.state === 'INSTALLING' || deployment.state === 'UPDATING') {
      summary.deploying += 1;
    } else if (deployment.state === 'NOT_INSTALLED') {
      summary.waiting += 1;
    } else if (deployment.state === 'HEALTHY' || deployment.state === 'UPDATE_AVAILABLE') {
      summary.healthy += 1;
    }
  }
  return summary;
}

/** Actionable first, then in-flight, then waiting, then the rest — newest first inside each group. */
export function sortForHomepage(deployments: FleetDeployment[]): FleetDeployment[] {
  return [...deployments].sort((a, b) => {
    const rankDiff = homeRank(a) - homeRank(b);
    if (rankDiff !== 0) return rankDiff;
    return Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
  });
}

function homeRank(deployment: FleetDeployment): number {
  if (attentionReason(deployment) !== null) return 0;
  if (deployment.state === 'INSTALLING' || deployment.state === 'UPDATING') return 1;
  if (deployment.state === 'NOT_INSTALLED') return 2;
  return 3;
}

// ── Application preparation ────────────────────────────────────────────────

/** An application is deployable once analysis finished and the verdict is READY. */
export function isApplicationReady(application: Application): boolean {
  return application.analysisStatus === 'COMPLETE' && application.compatibilityStatus === 'READY';
}

/**
 * The application the homepage speaks for. An organization can own several,
 * so a ready one wins (it is the one a customer can be deployed to); failing
 * that, the most recently created one is the one still being prepared.
 */
export function primaryApplication(applications: Application[]): Application | null {
  const ready = applications.filter(isApplicationReady);
  const pool = ready.length > 0 ? ready : applications;
  return [...pool].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0] ?? null;
}

/** One line of the preparation checklist. `detail` is the detected value, when there is one. */
export interface PreparationCheck {
  label: string;
  detail: string | null;
  state: 'complete' | 'pending' | 'missing';
}

/**
 * The preparation checklist, built only from fields the analyser actually
 * persists (§18 detectors backfill the §35 contract columns). While analysis
 * is still running every detection row is pending — an undetected value is
 * never reported as detected.
 */
export function preparationChecks(application: Application): PreparationCheck[] {
  const analysed = application.analysisStatus === 'COMPLETE';
  const metadata = application.detectedMetadata ?? {};

  return [
    { label: 'Repository connected', detail: application.repoFullName, state: 'complete' },
    detectionCheck(
      'Runtime detected',
      analysed,
      metadata['hasDockerfile'] === true ? 'Docker' : null,
    ),
    analysed
      ? {
          label: 'Database detected',
          detail: application.databaseRequired ? 'PostgreSQL' : 'Not required',
          state: 'complete',
        }
      : { label: 'Database detected', detail: null, state: 'pending' },
    detectionCheck('Health endpoint detected', analysed, application.healthPath),
    { label: 'Preparing deployment setup', detail: null, state: analysed ? 'complete' : 'pending' },
  ];
}

function detectionCheck(label: string, analysed: boolean, detail: string | null): PreparationCheck {
  if (!analysed) return { label, detail: null, state: 'pending' };
  return detail === null
    ? { label, detail: null, state: 'missing' }
    : { label, detail, state: 'complete' };
}

// ── The homepage state ─────────────────────────────────────────────────────

export type HomeState =
  /** A — nothing connected yet. */
  | { kind: 'setup' }
  /** B — an application exists, but it is not ready to deploy yet. */
  | { kind: 'preparing'; application: Application }
  /** C — ready to deploy, no customer deployment yet. */
  | { kind: 'ready'; application: Application }
  /** D — the organization's only deployment is still being set up. */
  | { kind: 'first-deployment'; deployment: FleetDeployment }
  /** E — the operational fleet view. */
  | {
      kind: 'operational';
      deployments: FleetDeployment[];
      summary: FleetSummary;
      attention: AttentionItem[];
      /** Only worth naming the application when the org has more than one. */
      showApplication: boolean;
    };

/** Rows shown on the homepage before "View all deployments" takes over. */
export const HOMEPAGE_DEPLOYMENT_LIMIT = 5;

/** Attention items shown on the homepage; the rest live on the deployments page. */
export const HOMEPAGE_ATTENTION_LIMIT = 3;

export function deriveHomeState(input: {
  applications: Application[];
  deployments: FleetDeployment[];
}): HomeState {
  const deployments = sortForHomepage(activeDeployments(input.deployments));

  if (deployments.length === 0) {
    const application = primaryApplication(input.applications);
    if (application === null) return { kind: 'setup' };
    return isApplicationReady(application)
      ? { kind: 'ready', application }
      : { kind: 'preparing', application };
  }

  const only = deployments.length === 1 ? deployments[0]! : null;
  if (only !== null && (only.state === 'NOT_INSTALLED' || only.state === 'INSTALLING')) {
    return { kind: 'first-deployment', deployment: only };
  }

  return {
    kind: 'operational',
    deployments,
    summary: summarise(deployments),
    attention: deployments
      .map((deployment) => ({ deployment, reason: attentionReason(deployment) }))
      .filter((item): item is AttentionItem => item.reason !== null),
    showApplication: new Set(deployments.map((deployment) => deployment.applicationId)).size > 1,
  };
}
