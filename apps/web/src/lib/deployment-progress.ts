import type { CustomerDeploymentStatus, DeploymentStage } from '@deployz/contracts';

// Client-side vocabulary for the server-derived deployment stage. The server
// (deriveDeploymentStatus in the API) is the only place lifecycle state is
// inferred; this module maps the received stage onto display steps and never
// combines raw deployment/relay/health signals itself.

export type ProgressStepState = 'done' | 'current' | 'waiting' | 'attention';

export interface ProgressStep {
  key: string;
  label: string;
  state: ProgressStepState;
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
 * The customer's five-step path for a given stage. Labels shift tense as the
 * spec's copy does — "AWS setup started" while in flight collapses into a
 * single completed "AWS connected" once the connection is behind us.
 */
export function customerSteps(stage: DeploymentStage): ProgressStep[] {
  const rank = stageRank(stage);
  const failed = stage === 'FAILED';

  if (rank <= 1 && !failed) {
    // Before the relay is talking, AWS setup and the Deployz connection are
    // two visibly distinct waits.
    return [
      { key: 'aws', label: 'AWS setup started', state: rank === 0 ? 'current' : 'done' },
      { key: 'connect', label: 'Connecting to Deployz', state: rank === 1 ? 'current' : 'waiting' },
      { key: 'infra', label: 'Creating infrastructure', state: 'waiting' },
      { key: 'health', label: 'Running health checks', state: 'waiting' },
      { key: 'ready', label: 'Ready', state: 'waiting' },
    ];
  }

  const infraState: ProgressStepState = failed ? 'attention' : rank === 2 ? 'current' : 'done';
  const healthState: ProgressStepState = failed ? 'waiting' : rank === 3 ? 'current' : rank > 3 ? 'done' : 'waiting';
  return [
    { key: 'aws', label: 'AWS connected', state: 'done' },
    {
      key: 'infra',
      label: infraState === 'done' ? 'Infrastructure created' : 'Creating infrastructure',
      state: infraState,
    },
    {
      key: 'health',
      label: healthState === 'done' ? 'Health checks passed' : 'Running health checks',
      state: healthState,
    },
    {
      key: 'ready',
      label: stage === 'READY' ? 'Application ready' : 'Ready',
      state: stage === 'READY' ? 'done' : 'waiting',
    },
  ];
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
