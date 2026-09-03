import type { VendorDeploymentStatus } from '@deployz/contracts';

import type { DeploymentState } from './deployment-vocabulary';
import { everInstalled } from './deployment-vocabulary';
import type { DeploymentJob, FleetDeploymentDetail } from './deployments';

// The vendor detail page's hero: ONE state-aware headline answering "is it
// working, what is happening, is my live application safe" — derived purely
// from the fields the API already returns (§46 state, the server-derived
// deploymentStatus, the job list). Nothing here infers lifecycle from raw
// AWS signals; it only chooses words for what the server already decided.

export type HeroKind =
  | 'not-installed'
  | 'installing'
  | 'live'
  | 'degraded'
  | 'unhealthy'
  | 'lost-contact'
  | 'updating'
  | 'operation-failed'
  | 'install-failed'
  | 'removal-failed'
  | 'deleting'
  | 'deleted';

export type HeroTone = 'neutral' | 'progress' | 'success' | 'warning' | 'destructive';

export interface HeroModel {
  kind: HeroKind;
  tone: HeroTone;
  /** The headline — the page's one aria-live element. */
  title: string;
  /** One sentence on what is happening or what it means. */
  description: string;
  /** The reassurance a failed update must carry: the running release is safe. */
  liveReleaseNote: string | null;
  /** Whether the install step list is meaningful for this state. */
  showSteps: boolean;
}

export type HeroInput = Pick<
  FleetDeploymentDetail,
  | 'state'
  | 'currentReleaseId'
  | 'version'
  | 'cleanupState'
  | 'customerName'
  | 'relayStatus'
  | 'jobs'
  | 'deploymentStatus'
>;

const ACTIVE_JOB_STATES = new Set(['REQUESTED', 'QUEUED', 'WAITING', 'RUNNING']);
const DAY_TWO_JOB_TYPES = new Set(['DEPLOY_RELEASE', 'ROLLBACK', 'RESTART', 'CONFIG_UPDATE']);

function latestJob(jobs: DeploymentJob[], keep: (job: DeploymentJob) => boolean): DeploymentJob | null {
  return (
    jobs
      .filter(keep)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null
  );
}

const INSTALLING_TITLE: Record<VendorDeploymentStatus['stage'], string> = {
  WAITING_FOR_AWS: 'Setting up in AWS',
  CONNECTING: 'Connecting to AWS',
  PROVISIONING: 'Deploying',
  VERIFYING: 'Verifying your application',
  READY: 'Your application is live',
  FAILED: 'Deployment failed',
};

const OPERATION_TITLE: Record<string, { running: string; failed: string; runningNote: string }> = {
  DEPLOY_RELEASE: {
    running: 'Updating your application',
    failed: 'Update failed',
    runningNote: 'stays live until the new version passes its health checks.',
  },
  ROLLBACK: {
    running: 'Rolling back',
    failed: 'Rollback failed',
    runningNote: 'keeps serving while the previous version is restored.',
  },
  RESTART: {
    running: 'Restarting your application',
    failed: 'Restart failed',
    runningNote: 'restarts in place. The running version does not change.',
  },
  CONFIG_UPDATE: {
    running: 'Applying configuration',
    failed: 'Configuration update failed',
    runningNote: 'restarts with the new configuration.',
  },
};

function releaseLabel(version: string | null): string {
  return version ? `Release v${version}` : 'Your current release';
}

export function deriveHero(detail: HeroInput): HeroModel {
  const status = detail.deploymentStatus;
  const state = detail.state as DeploymentState;
  const installed = everInstalled(state, detail.currentReleaseId);

  if (state === 'DELETED') {
    const description =
      detail.cleanupState === 'COMPLETE'
        ? `Deployz removed everything it created for this deployment from ${detail.customerName}'s AWS account.`
        : detail.cleanupState === 'SKIPPED_RELAY_OFFLINE' || detail.cleanupState === 'PURGE_FAILED'
          ? 'The deployment was disconnected, but some AWS resources may still exist in the customer account.'
          : 'The application and its networking were removed. The database, stored files and connector stay until you remove them.';
    return {
      kind: 'deleted',
      tone: 'neutral',
      title: 'Deployment removed',
      description,
      liveReleaseNote: null,
      showSteps: false,
    };
  }

  if (state === 'DELETING') {
    return {
      kind: 'deleting',
      tone: 'progress',
      title: 'Removing this deployment',
      description: `Deployz is removing the application and its networking from ${detail.customerName}'s AWS account. The database and stored files are kept.`,
      liveReleaseNote: null,
      showSteps: false,
    };
  }

  const failure = status.failure;
  const latestFailed = latestJob(detail.jobs, (job) => job.state === 'FAILED');

  if (status.stage === 'FAILED') {
    if (latestFailed?.type === 'DESTROY') {
      return {
        kind: 'removal-failed',
        tone: 'destructive',
        title: 'Removal failed',
        description:
          failure?.message ?? 'The deployment could not be removed from the customer AWS account.',
        liveReleaseNote: null,
        showSteps: false,
      };
    }
    if (installed && latestFailed && DAY_TWO_JOB_TYPES.has(latestFailed.type)) {
      const copy = OPERATION_TITLE[latestFailed.type] ?? OPERATION_TITLE.DEPLOY_RELEASE!;
      return {
        kind: 'operation-failed',
        tone: 'destructive',
        title: copy.failed,
        description: failure?.message ?? 'The operation did not complete.',
        liveReleaseNote: `${releaseLabel(detail.version)} is still live and unaffected.`,
        showSteps: false,
      };
    }
    return {
      kind: 'install-failed',
      tone: 'destructive',
      title: 'Deployment failed',
      description: failure?.message ?? 'The first install did not complete.',
      liveReleaseNote: null,
      showSteps: true,
    };
  }

  if (failure) {
    // A failed day-2 operation on a live stage: the previous release keeps
    // serving (docs/deployment-resilience.md). Never read as "down".
    const copy = OPERATION_TITLE[latestFailed?.type ?? ''] ?? OPERATION_TITLE.DEPLOY_RELEASE!;
    return {
      kind: 'operation-failed',
      tone: 'destructive',
      title: copy.failed,
      description: failure.message,
      liveReleaseNote: `${releaseLabel(detail.version)} is still live and unaffected.`,
      showSteps: false,
    };
  }

  if (state === 'UPDATING') {
    const active = latestJob(
      detail.jobs,
      (job) => DAY_TWO_JOB_TYPES.has(job.type) && ACTIVE_JOB_STATES.has(job.state),
    );
    const copy = OPERATION_TITLE[active?.type ?? 'DEPLOY_RELEASE'] ?? OPERATION_TITLE.DEPLOY_RELEASE!;
    return {
      kind: 'updating',
      tone: 'progress',
      title: copy.running,
      description: `${releaseLabel(detail.version)} ${copy.runningNote}`,
      liveReleaseNote: null,
      showSteps: false,
    };
  }

  if (status.stage === 'READY' || status.stage === 'VERIFYING') {
    if (detail.relayStatus === 'DISCONNECTED') {
      return {
        kind: 'lost-contact',
        tone: 'warning',
        title: 'Lost contact with this deployment',
        description: `The Deployz connector in ${detail.customerName}'s AWS account stopped checking in. Your application may still be running; this page shows the last confirmed state.`,
        liveReleaseNote: null,
        showSteps: false,
      };
    }
    const health = status.health.status;
    if (health === 'UNHEALTHY') {
      return {
        kind: 'unhealthy',
        tone: 'destructive',
        title: 'Your application is not responding',
        description: 'Health checks are failing. Users may see errors until it recovers.',
        liveReleaseNote: null,
        showSteps: false,
      };
    }
    if (health === 'DEGRADED') {
      return {
        kind: 'degraded',
        tone: 'warning',
        title: 'Your application is degraded',
        description: 'Some health checks are failing. The application is still reachable.',
        liveReleaseNote: null,
        showSteps: false,
      };
    }
    if (status.stage === 'READY' || health === 'HEALTHY') {
      const description =
        state === 'UPDATE_AVAILABLE'
          ? `${releaseLabel(detail.version)} is running and healthy. A newer release is ready to deploy.`
          : status.needsDomainSetup
            ? `${releaseLabel(detail.version)} is running and healthy over a temporary address. Add a custom domain to serve it over HTTPS.`
            : `${releaseLabel(detail.version)} is running and passing health checks.`;
      return {
        kind: 'live',
        tone: 'success',
        title: 'Your application is live',
        description,
        liveReleaseNote: null,
        showSteps: false,
      };
    }
    return {
      kind: 'installing',
      tone: 'progress',
      title: INSTALLING_TITLE.VERIFYING,
      description: status.currentActivity,
      liveReleaseNote: null,
      showSteps: true,
    };
  }

  if (state === 'NOT_INSTALLED') {
    return {
      kind: 'not-installed',
      tone: 'neutral',
      title: 'Waiting for your customer to install',
      description: `Send ${detail.customerName} the install link below. Progress appears here as soon as they start.`,
      liveReleaseNote: null,
      showSteps: false,
    };
  }

  return {
    kind: 'installing',
    tone: 'progress',
    title: INSTALLING_TITLE[status.stage],
    description: status.currentActivity,
    liveReleaseNote: null,
    showSteps: true,
  };
}

/** Human title for the kind of operation a job represents — used where the
 *  page names the job that failed or is running. */
export function operationLabel(jobType: string): string {
  return OPERATION_TITLE[jobType]?.running ?? 'Operation in progress';
}
