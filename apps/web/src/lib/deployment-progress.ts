import type { ReactNode } from 'react';

import type { CustomerDeploymentStatus, DeploymentStage, DeploymentStep } from '@deployz/contracts';

// Client-side vocabulary for the server-derived deployment stage/step. The
// server (deriveDeploymentStatus in the API) is the only place lifecycle
// state is inferred; this module only formats what it received — it never
// combines raw deployment/relay/health signals itself, and never re-derives
// the step order or which steps apply.

export type ProgressStepState = 'done' | 'current' | 'waiting' | 'attention';

export interface ProgressStep {
  key: string;
  label: string;
  state: ProgressStepState;
  /** Optional muted line rendered under the label — timing/slow-step context. */
  detail?: string | undefined;
  /** Optional right-aligned timing content (vendor card only — e.g. elapsed/duration;
   *  a node rather than a string so a live-ticking elapsed counter can live here). */
  meta?: ReactNode | undefined;
}

/** Order of the six stages along the install path. FAILED is deliberately
 * absent: it is not a position on the path but an interruption of one. */
const STAGE_ORDER: readonly DeploymentStage[] = [
  'WAITING_FOR_AWS',
  'CONNECTING',
  'PROVISIONING',
  'VERIFYING',
  'READY',
];

export function stageRank(stage: DeploymentStage): number {
  const rank = STAGE_ORDER.indexOf(stage);
  // FAILED ranks alongside PROVISIONING: every terminal failure today comes
  // out of the install itself, so the interrupted step is infrastructure.
  return rank === -1 ? STAGE_ORDER.indexOf('PROVISIONING') : rank;
}

export const STAGE_LABEL: Record<DeploymentStage, string> = {
  WAITING_FOR_AWS: 'Waiting for AWS',
  CONNECTING: 'Connecting',
  PROVISIONING: 'Creating infrastructure',
  VERIFYING: 'Verifying',
  READY: 'Ready',
  FAILED: 'Needs attention',
};

/**
 * A removed deployment keeps whatever stage it last earned (the derivation
 * documents this deliberately), so every surface that renders a stage must
 * ask for this copy first — otherwise a deployment whose infrastructure is
 * gone still reads "Verifying · Running health checks".
 */
export const REMOVED_PROGRESS: Record<'DELETING' | 'DELETED', { title: string; body: string }> = {
  DELETING: {
    title: 'Removing deployment',
    body: "Deployz is removing this deployment's infrastructure from your customer's cloud account.",
  },
  DELETED: {
    title: 'Deployment removed',
    body: 'This deployment is no longer running. Anything Deployz kept is listed under Infrastructure.',
  },
};

/** The removed copy for a deployment state, or null while it is still live. */
export function removedProgress(state: string): { title: string; body: string } | null {
  return state === 'DELETING' || state === 'DELETED' ? REMOVED_PROGRESS[state] : null;
}

/** Customer headline + supporting sentence per stage (§ progress spec copy).
 * FAILED gets its own alert layout, so its entry is the fallback headline. */
export const STAGE_HEADLINE: Record<DeploymentStage, { title: string; body: string }> = {
  WAITING_FOR_AWS: {
    title: 'Setting up your AWS connection',
    body: 'AWS is creating the secure Deployz connector in your account. Deployment progress will appear here automatically.',
  },
  CONNECTING: {
    title: 'Connecting your AWS account',
    body: 'Deployz has detected your AWS environment and is preparing the deployment.',
  },
  PROVISIONING: {
    title: 'Creating application infrastructure',
    body: 'Deployz is setting up the resources required to run your application.',
  },
  VERIFYING: {
    title: 'Checking your application',
    body: 'Your infrastructure is ready. Deployz is making sure your application is reachable and healthy.',
  },
  READY: {
    title: 'Your application is ready',
    body: 'Everything is set up and your application passed its health checks.',
  },
  FAILED: {
    title: 'Deployment needs attention',
    body: "The deployment couldn't finish. The details below explain what happened.",
  },
};

/**
 * Copy per deployment step, keyed by the step's own state: `pending` (not
 * reached yet), `active` (in progress, or the interrupted step on FAILED),
 * `done` (behind us). The server decides WHICH step is active and which
 * steps apply (`steps`/`step` on the status wire shapes) — this map only
 * supplies the words.
 */
export const STEP_LABEL: Record<DeploymentStep, { pending: string; active: string; done: string }> = {
  AWS_SETUP: { pending: 'AWS setup', active: 'Setting up AWS connection', done: 'AWS connected' },
  RELAY_CONNECT: { pending: 'Connect to Deployz', active: 'Connecting to Deployz', done: 'Connected to Deployz' },
  PREPARING: { pending: 'Prepare deployment', active: 'Preparing deployment', done: 'Deployment prepared' },
  NETWORK: { pending: 'Network', active: 'Creating network', done: 'Network created' },
  DATABASE_STORAGE: {
    pending: 'Database & storage',
    active: 'Creating database & storage',
    done: 'Database & storage created',
  },
  REDIS: { pending: 'Redis cache', active: 'Creating Redis cache', done: 'Redis cache created' },
  MIGRATION: { pending: 'Run migrations', active: 'Running migrations', done: 'Migrations applied' },
  APPLICATION: { pending: 'Start application', active: 'Starting application', done: 'Application started' },
  HEALTH_CHECK: { pending: 'Check application', active: 'Checking application', done: 'Health checks passed' },
  TLS: { pending: 'Set up HTTPS', active: 'Setting up HTTPS', done: 'HTTPS set up' },
  READY: { pending: 'Ready', active: 'Ready', done: 'Ready' },
};

/**
 * Renders the server-sent applicable `steps` list as display steps: steps
 * before the active one are `done`, the active one is `current` (or
 * `attention` while the deployment is FAILED), and later ones `waiting`.
 * READY renders every step `done`. Uses `steps` verbatim — it is already
 * ordered and filtered (REDIS/DATABASE_STORAGE only when required) by the
 * server; this function never re-sorts or re-filters it.
 */
export function stepsFromStatus({
  steps,
  step,
  stage,
}: {
  /** Undefined only when a mixed-version rollout serves an older API to a
   *  newer client — render no step rows then rather than crash mid-poll. */
  steps: DeploymentStep[] | undefined;
  step: DeploymentStep | undefined;
  stage: DeploymentStage;
}): ProgressStep[] {
  if (!steps || !step) return [];
  const activeIndex = steps.indexOf(step);
  return steps.map((candidate, index) => {
    const state: ProgressStepState =
      stage === 'READY'
        ? 'done'
        : index < activeIndex
          ? 'done'
          : index === activeIndex
            ? stage === 'FAILED'
              ? 'attention'
              : 'current'
            : 'waiting';
    const labels = STEP_LABEL[candidate];
    const label = state === 'waiting' ? labels.pending : state === 'done' ? labels.done : labels.active;
    return { key: candidate, label, state };
  });
}

/**
 * '3–8 minutes' (en dash) for a genuine range, or 'about N minutes' once
 * rounding collapses min and max to the same whole minute. The only place
 * either projection may turn TYPICAL_STEP_DURATION_SECONDS into words.
 */
export function formatDurationRange({ min, max }: { min: number; max: number }): string {
  const minMinutes = Math.max(1, Math.round(min / 60));
  const maxMinutes = Math.max(1, Math.round(max / 60));
  if (minMinutes === maxMinutes) {
    return `about ${minMinutes} minute${minMinutes === 1 ? '' : 's'}`;
  }
  return `${minMinutes}–${maxMinutes} minutes`;
}

/** '18s' | '4m 32s' | '1h 4m' — elapsed time, formatted at whatever
 *  granularity is still useful (seconds drop away once we reach an hour). */
export function formatElapsedSeconds(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

/**
 * The active step's muted detail line, shared by the customer and vendor
 * cards: a slow-step nudge takes priority over the plain typical-duration
 * line, and no detail renders at all once neither applies (e.g. TLS/READY,
 * whose typicalDurationSeconds is null).
 */
export function stepDetailLine({
  takingLongerThanUsual,
  typicalDurationSeconds,
  longerMessage,
  typicalLabel,
}: {
  takingLongerThanUsual: boolean;
  typicalDurationSeconds: { min: number; max: number } | null;
  longerMessage: string;
  typicalLabel: (range: string) => string;
}): string | undefined {
  if (takingLongerThanUsual) return longerMessage;
  if (typicalDurationSeconds) return typicalLabel(formatDurationRange(typicalDurationSeconds));
  return undefined;
}

/** True once the stage can no longer advance on its own — polling slows down
 * here rather than stopping, because FAILED can recover via a retried install
 * and READY can regress if health is lost. */
export function isTerminalStage(stage: DeploymentStage): boolean {
  return stage === 'READY' || stage === 'FAILED';
}

export const COMPONENT_PROGRESS_LABEL: Record<CustomerDeploymentStatus['components'][number]['status'], string> = {
  PENDING: 'Waiting',
  IN_PROGRESS: 'Creating',
  READY: 'Ready',
  FAILED: 'Needs attention',
  NOT_REQUIRED: 'Not required',
};
