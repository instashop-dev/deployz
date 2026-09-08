/**
 * ECS deploy/rollback/restart executors — the day-2 write path.
 *
 * DEPLOY_RELEASE and ROLLBACK share one executor: both roll the application
 * to an immutable `repository@sha256:…` image, discovered through the
 * application's CloudFormation stack (never a hard-coded service name). The
 * only difference between them is which release the control plane derived
 * the payload from.
 *
 * Built around the same three properties as `./install.ts`:
 *
 * 1. **Idempotent.** If the requested digest is already running and the
 *    service is stable, the answer is success with no new task-definition
 *    revision — a retried command must not mutate twice.
 *
 * 2. **Bounded, resumable waiting.** An ECS rollout outlives a Lambda
 *    invocation, so `settleEcsDeploy` returns `in-progress` and the caller
 *    defers through `./pending.ts`; the resumer re-asks the same questions
 *    on later polls until the rollout settles one way or the other.
 *
 * 3. **Failure is classified.** A rollout the ECS circuit breaker reports
 *    FAILED fails the job with `ECS_DEPLOYMENT_FAILED`, never a success.
 *
 * DEPLOY_RELEASE additionally runs a migration stage before the service
 * update when the payload carries a `migrationCommand` (Phase 4 boundary):
 * a one-off RunTask on the same cluster/VPC/secrets as the app service —
 * the same copy the service update will use — command overridden, no load
 * balancer, polled until STOPPED. Exit code 0 continues the deploy;
 * anything else fails with `MIGRATION_FAILED` and the previous release
 * keeps running. ROLLBACK never runs migrations: schema changes are never
 * auto-reversed.
 */

import type { CommandExecutor, RelayCommand, RelayCommandResult } from './commands.js';
import type { PendingStore } from './pending.js';
import type { CloudFormationReader } from './verify.js';
import { applicationContainers, essentialContainerNames } from './ecs-observe.js';
import type { TargetHealthReader } from './ecs-health.js';

/** The ECS write surface this module needs (injectable seam for testing). */
export interface EcsDeployClient {
  describeServices(input: {
    cluster: string;
    services: string[];
  }): Promise<{
    services: {
      desiredCount?: number | undefined;
      runningCount?: number | undefined;
      taskDefinition?: string | undefined;
      deployments?: {
        status?: string | undefined;
        rolloutState?: string | undefined;
        taskDefinition?: string | undefined;
      }[];
      networkConfiguration?: {
        awsvpcConfiguration?: {
          subnets?: string[] | undefined;
          securityGroups?: string[] | undefined;
          assignPublicIp?: string | undefined;
        } | undefined;
      } | undefined;
    }[];
  }>;
  describeTaskDefinition(input: { taskDefinition: string }): Promise<{
    taskDefinition: EcsTaskDefinition;
  }>;
  registerTaskDefinition(input: RegisterTaskDefinitionInput): Promise<{ taskDefinitionArn: string }>;
  updateService(input: {
    cluster: string;
    service: string;
    taskDefinition?: string;
    forceNewDeployment?: boolean;
    desiredCount?: number;
  }): Promise<void>;
  listTasks(input: {
    cluster: string;
    serviceName: string;
    /** Defaults to RUNNING; STOPPED lists the tasks ECS still remembers (about an hour). */
    desiredStatus?: 'RUNNING' | 'STOPPED';
  }): Promise<{ taskArns: string[] }>;
  describeTasks(input: {
    cluster: string;
    tasks: string[];
  }): Promise<{
    tasks: {
      lastStatus?: string | undefined;
      stopCode?: string | undefined;
      stoppedReason?: string | undefined;
      taskDefinitionArn?: string | undefined;
      containers?:
        | { name?: string | undefined; imageDigest?: string | undefined; exitCode?: number | undefined }[]
        | undefined;
    }[];
  }>;
  /** Starts a one-off migration task — no load balancer, command overridden. */
  runTask(input: {
    cluster: string;
    taskDefinition: string;
    count?: number;
    launchType?: string;
    networkConfiguration: {
      awsvpcConfiguration: { subnets: string[]; securityGroups: string[]; assignPublicIp: string };
    };
    overrides: { containerOverrides: { name?: string; command?: string[] }[] };
  }): Promise<{ taskArns: string[] }>;
}

/**
 * The task-definition fields carried across a copy. Deliberately the full
 * register-time shape minus the fields AWS owns (revision, status,
 * registration metadata) — a partial copy would silently drop configuration
 * the running service depends on.
 */
export interface EcsTaskDefinition {
  family?: string | undefined;
  cpu?: string | undefined;
  memory?: string | undefined;
  networkMode?: string | undefined;
  requiresCompatibilities?: string[] | undefined;
  executionRoleArn?: string | undefined;
  taskRoleArn?: string | undefined;
  containerDefinitions: {
    name?: string | undefined;
    image?: string | undefined;
    [field: string]: unknown;
  }[];
  volumes?: unknown[];
}

export type RegisterTaskDefinitionInput = Omit<EcsTaskDefinition, 'containerDefinitions'> & {
  containerDefinitions: Record<string, unknown>[];
  /** The installation tag the relay's IAM conditions require on register. */
  tags?: { key: string; value: string }[];
};

export interface EcsDeployDeps {
  readonly cfn: CloudFormationReader;
  readonly ecs: EcsDeployClient;
  /**
   * ALB target-health reader behind the settle gate: a deploy does not count
   * as settled until every registered target is `healthy`. Rollout state
   * alone is not enough — ECS can mark a deployment COMPLETED while target
   * registration lags behind it (§10.3).
   */
  readonly elb: TargetHealthReader;
  readonly pending: PendingStore;
  readonly stackName: string;
  /** Stamped on every registered task-definition copy (IAM tag boundary). */
  readonly installationId: string;
  readonly now?: () => string;
  /** How long the in-invocation migration poll waits between DescribeTasks calls. */
  readonly migrationPollIntervalMs?: number;
  /** How many in-invocation migration polls may run before deferring to a later invocation. */
  readonly migrationPollMaxAttempts?: number;
}

/** A deploy request after payload validation. */
export interface DeployRequest {
  readonly imageRepository: string;
  readonly imageDigest: string;
  /**
   * Migration command to run as a one-off ECS task before the service
   * update. Absent (null) deploys exactly as before the migration stage.
   */
  readonly migrationCommand: string | null;
}

/**
 * One-off migration-task state, carried on the pending marker so a migration
 * that outlives one invocation resumes on the SAME task (never a second run).
 * `completedAt` is set the moment the task STOPPED with exit code 0.
 * `registeredArn` is the application copy the migration registered (the def
 * the service update will also use) — without it, a resume would describe
 * the still-old service definition and mindlessly register a second copy.
 */
export interface PendingMigration {
  readonly taskArn: string;
  readonly registeredArn?: string;
  readonly completedAt?: string;
}

const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

/** Parses and validates the control plane's deploy payload contract. */
export function readDeployRequest(payload: Record<string, unknown>): DeployRequest | null {
  const imageRepository = payload['imageRepository'];
  const imageDigest = payload['imageDigest'];
  if (typeof imageRepository !== 'string' || imageRepository.length === 0) return null;
  if (typeof imageDigest !== 'string' || !DIGEST_PATTERN.test(imageDigest)) return null;
  const rawCommand = payload['migrationCommand'];
  const migrationCommand =
    typeof rawCommand === 'string' && rawCommand.trim().length > 0 ? rawCommand.trim() : null;
  return { imageRepository, imageDigest, migrationCommand };
}

type EcsDeployOutcome =
  | { readonly state: 'succeeded'; readonly alreadyRunning: boolean }
  | { readonly state: 'failed'; readonly reason: string; readonly failureCode?: string }
  | {
      readonly state: 'in-progress';
      readonly migration?: PendingMigration;
      readonly startedFromZero?: boolean;
      /** The task-definition revision this deploy rolls out (DEPLOY-015). */
      readonly targetTaskDefinitionArn?: string;
    };

/**
 * Tasks a service is scaled to when a deploy finds it at zero (DEPLOY-009):
 * an install that had to wait for configuration creates the service with
 * `param_DesiredCount=0`, and the first deploy is the first start. The MVP
 * runs one task, which is also the template's default count.
 */
const FIRST_START_DESIRED_COUNT = 1;

/** Per-call deploy context: which command family is running and any migration state already started. */
export interface DeploySettleContext {
  /**
   * Migrations run only for DEPLOY_RELEASE. ROLLBACK rolls the old digest
   * without them — schema changes are never auto-reversed.
   */
  readonly allowMigration: boolean;
  /** The pending marker's migration state, when this command was already started. */
  readonly migration?: PendingMigration | null;
  /**
   * This command scaled the service up from zero tasks (a configured first
   * start). A rollout the circuit breaker rolls back then goes back to zero,
   * so the template's unconfigured task definition never churns.
   */
  readonly startedFromZero?: boolean;
  /**
   * The revision an earlier invocation of this command rolled out. A service
   * whose PRIMARY deployment runs another revision was rolled back by the
   * circuit breaker — never a success, even when that revision runs the
   * same image (a pinned first start's template revision, DEPLOY-015).
   */
  readonly targetTaskDefinitionArn?: string | null;
}

/**
 * Runs the deploy to whatever conclusion is available right now. Reads
 * before writes: a rollout that already reached the requested digest (or the
 * circuit breaker) is settled without registering anything.
 *
 * "Settled" (§10.3) means all four ECS-side gates have passed — the digest
 * is running, the expected task count is up, the primary deployment's
 * rollout state is COMPLETED, and every registered ALB target is healthy. A
 * rollout that is still draining old tasks, or whose targets are still
 * registering, is `in-progress` — never a success.
 */
export async function settleEcsDeploy(
  deps: EcsDeployDeps,
  request: DeployRequest,
  context: DeploySettleContext = { allowMigration: false },
): Promise<EcsDeployOutcome> {
  const serviceArn = await findServiceArn(deps);
  if (!serviceArn) {
    return { state: 'failed', reason: `No ECS service found in stack "${deps.stackName}"` };
  }
  const cluster = serviceArn.split('/')[1] ?? null;
  if (!cluster) {
    return { state: 'failed', reason: `Malformed service ARN "${serviceArn}"` };
  }

  const { services } = await deps.ecs.describeServices({ cluster, services: [serviceArn] });
  const service = services[0];
  if (!service || service.taskDefinition === undefined) {
    return {
      state: 'failed',
      reason: `ECS service "${serviceArn}" could not be described`,
      failureCode: 'AWS_PERMISSION_DENIED',
    };
  }

  if (rolloutFailed(service.deployments)) {
    if (context.startedFromZero) {
      // The circuit breaker restored the previous deployment, which for a
      // first start is the template's unconfigured task definition — at the
      // count this command set, it would keep crashing. Back to zero; the
      // deployment is FAILED and the next deploy starts it again.
      try {
        await deps.ecs.updateService({ cluster, service: serviceArn, desiredCount: 0 });
      } catch {
        // Best effort: the failure below is the outcome either way.
      }
    }
    return {
      state: 'failed',
      reason: 'The ECS deployment circuit breaker reported a failed rollout',
      failureCode: 'ECS_DEPLOYMENT_FAILED',
    };
  }

  // DEPLOY-015: once this command has rolled a revision out, a PRIMARY
  // deployment on any other revision means ECS rolled it back — the circuit
  // breaker restored the previous deployment, which on a pinned first start
  // runs the same image and comes up "healthy" unconfigured.
  const primary = service.deployments?.find((deployment) => deployment.status === 'PRIMARY');
  const target = context.targetTaskDefinitionArn ?? null;
  if (target !== null && primary?.taskDefinition !== undefined && primary.taskDefinition !== target) {
    if (context.startedFromZero) {
      try {
        await deps.ecs.updateService({ cluster, service: serviceArn, desiredCount: 0 });
      } catch {
        // Best effort: the failure below is the outcome either way.
      }
    }
    return {
      state: 'failed',
      reason: `ECS rolled the service back to ${primary.taskDefinition}; the new revision never became healthy`,
      failureCode: 'ECS_DEPLOYMENT_FAILED',
    };
  }

  // A service at zero tasks is an install that waited for configuration
  // (DEPLOY-009): this deploy is its first start.
  const startFromZero = (service.desiredCount ?? 0) === 0;
  const firstStart = startFromZero ? { desiredCount: FIRST_START_DESIRED_COUNT } : {};
  const startedFromZero = startFromZero || context.startedFromZero === true;

  // The definition names the application container (DEPLOY-014): the running
  // digest and the migration exit code are read from it, never from the RDS
  // CA init container or another sidecar.
  const { taskDefinition } = await deps.ecs.describeTaskDefinition({
    taskDefinition: service.taskDefinition,
  });
  const essential = essentialContainerNames(taskDefinition.containerDefinitions);

  const runningDigest = await observeRunningDigest(deps, cluster, serviceArn, essential);
  const stable =
    (service.desiredCount ?? 0) > 0 && (service.runningCount ?? 0) >= (service.desiredCount ?? 0);
  const rolloutCompleted = primaryRolloutCompleted(service.deployments);
  const targetsHealthy = await deploymentTargetsHealthy(deps);
  const onTarget = target === null || primary?.taskDefinition === undefined || primary.taskDefinition === target;
  if (runningDigest === request.imageDigest && stable && rolloutCompleted && targetsHealthy && onTarget) {
    return { state: 'succeeded', alreadyRunning: true };
  }

  const nextImage = `${request.imageRepository}@${request.imageDigest}`;
  let alreadyRegistered = taskDefinition.containerDefinitions.some(
    (container) => container.image === nextImage,
  );

  // DEPLOY-011: ECS's circuit breaker counts a task as failed only when it
  // never reaches RUNNING or fails a health check. A task that starts, runs
  // for a while and then exits is a restart to ECS, so a crash-looping
  // rollout never reaches COMPLETED and never FAILS — it would sit
  // in-progress until the control plane's 24-hour grace. Once the service
  // runs this request's revision, its own stopped tasks are the verdict.
  if (alreadyRegistered) {
    const crashed = await crashedTasksOfRevision(deps, cluster, serviceArn, target ?? service.taskDefinition);
    if (crashed.count >= CRASH_LOOP_THRESHOLD) {
      if (context.startedFromZero) {
        try {
          await deps.ecs.updateService({ cluster, service: serviceArn, desiredCount: 0 });
        } catch {
          // Best effort: the failure below is the outcome either way.
        }
      }
      return {
        state: 'failed',
        reason: `${crashed.count} tasks of the new revision exited with code ${crashed.exitCode} (${crashed.stoppedReason})`,
        failureCode: 'CONTAINER_START_FAILED',
      };
    }
  }

  // Migration stage — before any service update, so the previous release
  // keeps running and the release pointers never move on a MIGRATION_FAILED.
  let migration: PendingMigration | undefined;
  let registeredApplicationArn: string | null = null;
  const migrationCommand = context.allowMigration ? (request.migrationCommand ?? null) : null;
  if (migrationCommand !== null) {
    const outcome = await settleMigration(deps, {
      cluster,
      serviceTaskDefinition: service.taskDefinition,
      networkConfiguration: service.networkConfiguration,
      taskDefinition,
      request,
      migrationCommand,
      alreadyRegistered,
      pendingMigration: context.migration ?? null,
    });
    if (outcome.state === 'failed') {
      return {
        state: 'failed',
        reason: outcome.reason,
        failureCode: outcome.failureCode ?? 'MIGRATION_FAILED',
      };
    }
    if (outcome.state === 'in-progress') {
      return { state: 'in-progress', migration: outcome.migration };
    }
    alreadyRegistered = alreadyRegistered || outcome.registered;
    registeredApplicationArn = outcome.registeredArn;
    migration = outcome.migration;
  }

  if (!alreadyRegistered) {
    // No migration registered the application copy, so this is the same
    // fresh-register path as ever: register, then start the rollout.
    const replaced = replaceApplicationImages(taskDefinition, request);
    if (!replaced) {
      return {
        state: 'failed',
        reason: `No container in the task definition references repository "${request.imageRepository}"`,
      };
    }
    replaced.tags = [{ key: 'deployz:installation', value: deps.installationId }];
    const registered = await deps.ecs.registerTaskDefinition(replaced);
    registeredApplicationArn = registered.taskDefinitionArn;
    await deps.ecs.updateService({
      cluster,
      service: serviceArn,
      taskDefinition: registeredApplicationArn,
      ...firstStart,
    });
  } else if (runningDigest !== request.imageDigest) {
    // The application copy already exists — the migration stage registered it
    // (or an earlier attempt did) — but the service never picked it up.
    // Re-issue the update against that copy.
    await deps.ecs.updateService({
      cluster,
      service: serviceArn,
      taskDefinition: registeredApplicationArn ?? service.taskDefinition,
      ...firstStart,
    });
  }

  // The rollout just started or is still in flight — only its own progress
  // can settle it, on a later poll. The revision it rolls out rides along so
  // that poll can tell a rollback from a rollout (DEPLOY-015).
  const rolledOut = target ?? registeredApplicationArn ?? service.taskDefinition;
  return {
    state: 'in-progress',
    ...(migration === undefined ? {} : { migration }),
    ...(startedFromZero ? { startedFromZero: true } : {}),
    targetTaskDefinitionArn: rolledOut,
  };
}

/** The outcome of one migration-stage pass. */
type MigrationOutcome =
  | {
      readonly state: 'completed';
      readonly registered: boolean;
      /** The application copy the migration registered, when it registered one. */
      readonly registeredArn: string | null;
      readonly migration: PendingMigration;
    }
  | { readonly state: 'in-progress'; readonly migration: PendingMigration }
  | {
      readonly state: 'failed';
      readonly reason: string;
      /**
       * Sharper classification for a migration task that could not run at
       * all — the image pull failed before the migration command started
       * (the task's stoppedReason names CannotPullContainerError). Absent
       * when the migration itself failed, which stays MIGRATION_FAILED.
       */
      readonly failureCode?: string;
    };

/**
 * Runs (or resumes) the migration stage: one one-off ECS task on the SAME
 * cluster/VPC/subnets/security groups as the app service, running the NEW
 * digest with the command overridden, no load balancer. The vendor's
 * `migrationCommand` is a shell command line — the same thing a Dockerfile
 * `CMD "…"` string or a Procfile line is — so it runs as `sh -c <command>`
 * inside the container, exactly as written: PATH lookup, `npx`, `&&`, env-var
 * prefixes and quoting all behave the way the vendor's own start script
 * expects. Polls DescribeTasks until STOPPED; a task that outlives the
 * invocation is resumed by ARN on a later poll, never re-run. Exit code 0
 * completes the stage; anything else fails the job with MIGRATION_FAILED
 * (exit code + stoppedReason as detail — never log bodies: the relay role
 * deliberately has no logs:GetLogEvents).
 */
async function settleMigration(
  deps: EcsDeployDeps,
  params: {
    cluster: string;
    serviceTaskDefinition: string;
    networkConfiguration?: {
      awsvpcConfiguration?: {
        subnets?: string[] | undefined;
        securityGroups?: string[] | undefined;
        assignPublicIp?: string | undefined;
      } | undefined;
    } | undefined;
    taskDefinition: EcsTaskDefinition;
    request: DeployRequest;
    migrationCommand: string;
    alreadyRegistered: boolean;
    pendingMigration: PendingMigration | null;
  },
): Promise<MigrationOutcome> {
  const { cluster, serviceTaskDefinition, taskDefinition, request, migrationCommand } = params;

  if (params.pendingMigration?.completedAt !== undefined) {
    return {
      state: 'completed',
      registered: params.alreadyRegistered || params.pendingMigration.registeredArn !== undefined,
      registeredArn: params.pendingMigration.registeredArn ?? null,
      migration: params.pendingMigration,
    };
  }

  let registered = params.alreadyRegistered;
  let registeredArn: string | null = params.pendingMigration?.registeredArn ?? null;
  if (registeredArn !== null) registered = true;
  let taskArn: string | null = params.pendingMigration?.taskArn ?? null;

  if (taskArn === null) {
    // The migration task runs the NEW digest — register the copy the service
    // update will use (or reuse the one an earlier attempt registered), then
    // start it with the command overridden.
    const appContainer = taskDefinition.containerDefinitions.find(
      (container) =>
        typeof container.image === 'string' &&
        container.image.startsWith(`${request.imageRepository}@`),
    );
    let definitionArn = registeredArn ?? serviceTaskDefinition;
    if (!registered) {
      const replaced = replaceApplicationImages(taskDefinition, request);
      if (!replaced) {
        return {
          state: 'failed',
          reason: `No container in the task definition references repository "${request.imageRepository}"`,
        };
      }
      replaced.tags = [{ key: 'deployz:installation', value: deps.installationId }];
      definitionArn = (await deps.ecs.registerTaskDefinition(replaced)).taskDefinitionArn;
      registeredArn = definitionArn;
      registered = true;
    }

    const network = params.networkConfiguration?.awsvpcConfiguration;
    if (network === undefined || network.subnets === undefined || network.securityGroups === undefined) {
      return {
        state: 'failed',
        reason:
          "Migration needs the service's VPC network configuration, which could not be described",
      };
    }

    const { taskArns } = await deps.ecs.runTask({
      cluster,
      taskDefinition: definitionArn,
      count: 1,
      launchType: 'FARGATE',
      networkConfiguration: {
        awsvpcConfiguration: {
          subnets: network.subnets,
          securityGroups: network.securityGroups,
          assignPublicIp: network.assignPublicIp ?? 'DISABLED',
        },
      },
      overrides: {
        containerOverrides:
          appContainer === undefined || appContainer.name === undefined
            ? []
            : [{ name: appContainer.name, command: ['sh', '-c', migrationCommand.trim()] }],
      },
    });
    taskArn = taskArns[0] ?? null;
    if (taskArn === null) {
      return {
        state: 'failed',
        reason: 'Migration task could not be started (RunTask returned no task ARN)',
      };
    }
  }

  const pollIntervalMs = deps.migrationPollIntervalMs ?? 10_000;
  const maxAttempts = deps.migrationPollMaxAttempts ?? 24;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) await sleep(pollIntervalMs);
    const { tasks } = await deps.ecs.describeTasks({ cluster, tasks: [taskArn] });
    const task = tasks[0];
    if (task === undefined) {
      return {
        state: 'failed',
        reason: `Migration task "${taskArn}" could not be described`,
      };
    }
    if (task.lastStatus !== 'STOPPED') continue;
    const exitCode = applicationContainers(
      task.containers,
      essentialContainerNames(taskDefinition.containerDefinitions),
    ).find((container) => container.exitCode !== undefined)?.exitCode;
    if (exitCode !== 0) {
      return {
        state: 'failed',
        reason: `Migration failed: exit code ${exitCode ?? 'unknown'} (${task.stopCode ?? 'STOPPED'}: ${task.stoppedReason ?? 'no reason given'})`,
        // §14.2 ECR-image-pull classification: the migration task never ran
        // because its image could not be pulled. The migration uses the same
        // image as the service update, so this is IMAGE_PULL_FAILED, never a
        // migration bug the "fix the migration" remediation would address.
        ...(isImagePullFailure(task.stoppedReason)
          ? { failureCode: 'IMAGE_PULL_FAILED' }
          : {}),
      };
    }
    const completedAt = (deps.now ?? (() => new Date().toISOString()))();
    return {
      state: 'completed',
      registered,
      registeredArn,
      migration: {
        taskArn,
        ...(registeredArn !== null ? { registeredArn } : {}),
        completedAt,
      },
    };
  }

  return {
    state: 'in-progress',
    migration: {
      taskArn,
      ...(registeredArn !== null ? { registeredArn } : {}),
    },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Markers that tell a migration task never ran because ECS could not pull
 * the application image — the task's stoppedReason names them verbatim
 * (CannotPullContainerError is ECS's own wrap; the others are the ECR /
 * registry error texts inside it). Mirrors the server-side refinement
 * vocabulary in apps/api/src/failure-classification.ts so the relay and the
 * control plane agree on what an image-pull failure looks like.
 */
const IMAGE_PULL_FAILURE_MARKERS =
  /cannotpullcontainererror|pull access denied|no basic auth credentials|failed to pull image/i;

/**
 * True when a stopped migration task never started because its image could
 * not be pulled. The migration command runs the SAME image the service
 * update will use, so a pull denial here is the ECR grant / registry
 * problem §29's IMAGE_PULL_FAILED exists for — not a migration bug, and the
 * "fix the migration" remediation would send the vendor the wrong way.
 */
function isImagePullFailure(stoppedReason: string | null | undefined): boolean {
  return stoppedReason !== undefined && stoppedReason !== null && IMAGE_PULL_FAILURE_MARKERS.test(stoppedReason);
}

function rolloutFailed(
  deployments: { status?: string | undefined; rolloutState?: string | undefined }[] | undefined,
): boolean {
  return deployments?.some((deployment) => deployment.rolloutState === 'FAILED') ?? false;
}

/**
 * Whether the PRIMARY deployment reached ECS's COMPLETED rollout state. A
 * service mid-rollout has its new deployment PRIMARY and IN_PROGRESS; a
 * service that is not (or has never been) rolling exposes no COMPLETED
 * primary, so this is false and the deploy keeps waiting.
 */
function primaryRolloutCompleted(
  deployments: { status?: string | undefined; rolloutState?: string | undefined }[] | undefined,
): boolean {
  return deployments?.find((deployment) => deployment.status === 'PRIMARY')?.rolloutState === 'COMPLETED';
}

const TARGET_GROUP_TYPE = 'AWS::ElasticLoadBalancingV2::TargetGroup';

/**
 * Resource statuses whose physicalId actually backs live infrastructure —
 * the same rule ecs-health.ts applies, so a rolled-back stack's phantom
 * target-group reference is never asked about.
 */
const COMPLETE_RESOURCE_STATUSES: ReadonlySet<string> = new Set(['CREATE_COMPLETE', 'UPDATE_COMPLETE']);

/**
 * Whether every registered ALB target for the application's target group is
 * healthy. Only `healthy` counts: a target still registering (`initial`),
 * draining, unclassified, or unhealthy means the load balancer is not
 * finished with this release, however complete the ECS rollout looks.
 * Absent target group (never completed, or not readable) also means not
 * healthy — the deploy keeps waiting rather than guessing.
 */
async function deploymentTargetsHealthy(deps: EcsDeployDeps): Promise<boolean> {
  const resources = await deps.cfn.describeStackResources(deps.stackName);
  const targetGroup = resources.find(
    (resource) => resource.type === TARGET_GROUP_TYPE && COMPLETE_RESOURCE_STATUSES.has(resource.status),
  );
  if (!targetGroup?.physicalId) return false;
  const { targets } = await deps.elb.describeTargetHealth({ targetGroupArn: targetGroup.physicalId });
  return targets.length > 0 && targets.every((target) => target.state === 'healthy');
}

async function observeRunningDigest(
  deps: EcsDeployDeps,
  cluster: string,
  serviceArn: string,
  essential: ReadonlySet<string>,
): Promise<string | null> {
  const { taskArns } = await deps.ecs.listTasks({ cluster, serviceName: serviceArn });
  if (taskArns.length === 0) return null;
  const { tasks } = await deps.ecs.describeTasks({ cluster, tasks: taskArns });
  for (const task of tasks) {
    const digest = applicationContainers(task.containers, essential).find((c) =>
      c.imageDigest?.startsWith('sha256:'),
    )?.imageDigest;
    if (digest) return digest;
  }
  return null;
}

/**
 * Stopped tasks of one task-definition revision whose essential container
 * exited non-zero — the crash loop ECS's circuit breaker does not count.
 * Tasks the scheduler stopped (an old revision draining, a scale-down) have
 * another stop code and are never counted.
 */
const CRASH_LOOP_THRESHOLD = 3;

async function crashedTasksOfRevision(
  deps: EcsDeployDeps,
  cluster: string,
  serviceArn: string,
  taskDefinitionArn: string,
): Promise<{ count: number; exitCode: number | null; stoppedReason: string }> {
  const { taskArns } = await deps.ecs.listTasks({ cluster, serviceName: serviceArn, desiredStatus: 'STOPPED' });
  if (taskArns.length === 0) return { count: 0, exitCode: null, stoppedReason: '' };
  const { tasks } = await deps.ecs.describeTasks({ cluster, tasks: taskArns.slice(0, 20) });
  let count = 0;
  let exitCode: number | null = null;
  let stoppedReason = '';
  for (const task of tasks) {
    if (task.taskDefinitionArn !== taskDefinitionArn || task.stopCode !== 'EssentialContainerExited') continue;
    const failed = task.containers?.find((c) => c.exitCode !== undefined && c.exitCode !== 0);
    if (!failed) continue;
    count += 1;
    exitCode = failed.exitCode ?? null;
    stoppedReason = task.stoppedReason ?? stoppedReason;
  }
  return { count, exitCode, stoppedReason };
}

async function findServiceArn(deps: EcsDeployDeps): Promise<string | null> {
  const resources = await deps.cfn.describeStackResources(deps.stackName);
  return (
    resources.find((resource) => resource.type === 'AWS::ECS::Service')?.physicalId ?? null
  );
}

/**
 * Copies the definition with only application images from the expected
 * repository replaced. Sidecars from other registries are copied verbatim.
 * Returns null when no container matched — a deploy that changes nothing is
 * a misconfiguration, not a success.
 */
export function replaceApplicationImages(
  taskDefinition: EcsTaskDefinition,
  request: DeployRequest,
): RegisterTaskDefinitionInput | null {
  const nextImage = `${request.imageRepository}@${request.imageDigest}`;
  let matched = false;
  const containerDefinitions = taskDefinition.containerDefinitions.map((container) => {
    if (typeof container.image === 'string' && container.image.startsWith(`${request.imageRepository}@`)) {
      matched = true;
      return { ...container, image: nextImage };
    }
    return { ...container };
  });
  if (!matched) return null;
  const copy: RegisterTaskDefinitionInput = {
    family: taskDefinition.family,
    cpu: taskDefinition.cpu,
    memory: taskDefinition.memory,
    networkMode: taskDefinition.networkMode,
    requiresCompatibilities: taskDefinition.requiresCompatibilities,
    executionRoleArn: taskDefinition.executionRoleArn,
    taskRoleArn: taskDefinition.taskRoleArn,
    containerDefinitions,
    ...(taskDefinition.volumes ? { volumes: taskDefinition.volumes } : {}),
  };
  return copy;
}

// ── Executors ────────────────────────────────────────────────────────────────

function result(
  command: RelayCommand,
  success: boolean,
  extra: { output?: Record<string, unknown>; error?: string; failureCode?: string } = {},
): RelayCommandResult {
  return {
    commandId: command.id,
    idempotencyKey: command.idempotencyKey,
    success,
    ...extra,
  };
}

/** The shared DEPLOY_RELEASE / ROLLBACK executor. */
export function createEcsDeployExecutor(deps: EcsDeployDeps): CommandExecutor {
  return async (command) => {
    console.log(
      JSON.stringify({
        event: 'relay:command-executed',
        commandId: command.id,
        type: command.type,
        deploymentId: command.deploymentId,
        idempotencyKey: command.idempotencyKey,
      }),
    );

    const request = readDeployRequest(command.payload);
    if (!request) {
      return result(command, false, {
        error: 'Command payload is missing a valid imageRepository/imageDigest pair',
      });
    }

    let outcome: EcsDeployOutcome;
    try {
      // Only this command's OWN marker may carry a migration task forward —
      // a stale marker from an earlier command must never resume its task.
      const existing = await deps.pending.read();
      const migration = existing?.commandId === command.id ? (existing.migration ?? null) : null;
      outcome = await settleEcsDeploy(deps, request, {
        allowMigration: command.type === 'DEPLOY_RELEASE',
        migration,
      });
    } catch (err) {
      return result(command, false, {
        error: String(err),
        failureCode: 'AWS_PERMISSION_DENIED',
      });
    }

    if (outcome.state === 'failed') {
      console.log(
        JSON.stringify({
          event: 'relay:command-failed',
          commandId: command.id,
          type: command.type,
          reason: outcome.reason,
        }),
      );
      return result(command, false, {
        error: outcome.reason,
        ...(outcome.failureCode ? { failureCode: outcome.failureCode } : {}),
      });
    }

    if (outcome.state === 'succeeded') {
      console.log(
        JSON.stringify({
          event: 'relay:command-succeeded',
          commandId: command.id,
          type: command.type,
          alreadyRunning: outcome.alreadyRunning,
        }),
      );
      return result(command, true, {
        output: { executed: true, type: command.type, alreadyRunning: outcome.alreadyRunning },
      });
    }

    // Record the debt BEFORE deferring — an unfindable deferral leaves the
    // job in RUNNING forever, which is worse than an honest failure. The
    // marker also carries any migration task so a later invocation resumes
    // the SAME task instead of starting a second migration.
    const recorded = await deps.pending.write({
      commandId: command.id,
      idempotencyKey: command.idempotencyKey,
      type: command.type,
      stackName: deps.stackName,
      startedAt: (deps.now ?? (() => new Date().toISOString()))(),
      // A first start from zero rides the marker so the resumer can scale a
      // rolled-back rollout back down (DEPLOY-009); the revision rolled out
      // rides along so the resumer can tell a rollback from a rollout
      // (DEPLOY-015).
      payload: {
        ...command.payload,
        ...(outcome.startedFromZero ? { startedFromZero: true } : {}),
        ...(outcome.targetTaskDefinitionArn ? { targetTaskDefinitionArn: outcome.targetTaskDefinitionArn } : {}),
      },
      ...(outcome.migration ? { migration: outcome.migration } : {}),
    });
    if (!recorded) {
      return result(command, false, {
        error: 'Rollout in progress, but the relay could not record that it must report back',
      });
    }

    console.log(
      JSON.stringify({
        event: 'relay:command-deferred',
        commandId: command.id,
        type: command.type,
        stackName: deps.stackName,
      }),
    );
    return { commandId: command.id, idempotencyKey: command.idempotencyKey, success: false, deferred: true };
  };
}

/** The other half: finish a deploy an earlier invocation started. */
export function createEcsDeployResumer(deps: EcsDeployDeps): () => Promise<RelayCommandResult[]> {
  return async () => {
    const pending = await deps.pending.read();
    if (pending === null || (pending.type !== 'DEPLOY_RELEASE' && pending.type !== 'ROLLBACK')) {
      return [];
    }

    const request = readDeployRequest(pending.payload);
    if (!request) {
      await deps.pending.clear();
      return [
        {
          commandId: pending.commandId,
          idempotencyKey: pending.idempotencyKey,
          success: false,
          error: 'Pending payload lost its imageRepository/imageDigest pair',
        },
      ];
    }

    const target = pending.payload['targetTaskDefinitionArn'];
    const outcome = await settleEcsDeploy(deps, request, {
      allowMigration: pending.type === 'DEPLOY_RELEASE',
      migration: pending.migration ?? null,
      startedFromZero: pending.payload['startedFromZero'] === true,
      targetTaskDefinitionArn: typeof target === 'string' ? target : null,
    });
    if (outcome.state === 'in-progress') {
      // The moment a migration task is first observed STOPPED + exit 0, pin
      // completion onto the marker: a stopped task ages out of DescribeTasks,
      // and re-polling it on later polls would eventually fail a deploy
      // whose migration already succeeded. One extra write, exactly once.
      if (outcome.migration !== undefined && outcome.migration.completedAt !== pending.migration?.completedAt) {
        await deps.pending.write({ ...pending, migration: outcome.migration });
      }
      console.log(
        JSON.stringify({
          event: 'relay:command-still-pending',
          commandId: pending.commandId,
          type: pending.type,
          startedAt: pending.startedAt,
        }),
      );
      return [];
    }

    // Clear first: reporting twice would re-emit the control plane's
    // deploy/rollback event on every poll.
    await deps.pending.clear();
    console.log(
      JSON.stringify({
        event: 'relay:command-resumed',
        commandId: pending.commandId,
        type: pending.type,
        success: outcome.state === 'succeeded',
        startedAt: pending.startedAt,
      }),
    );
    return [
      outcome.state === 'succeeded'
        ? {
            commandId: pending.commandId,
            idempotencyKey: pending.idempotencyKey,
            success: true,
            output: { executed: true, type: pending.type, alreadyRunning: outcome.alreadyRunning },
          }
        : {
            commandId: pending.commandId,
            idempotencyKey: pending.idempotencyKey,
            success: false,
            error: outcome.reason,
            ...(outcome.failureCode ? { failureCode: outcome.failureCode } : {}),
          },
    ];
  };
}

/** The RESTART executor: force a new deployment of the current definition. */
export function createRestartExecutor(deps: EcsDeployDeps): CommandExecutor {
  return async (command) => {
    console.log(
      JSON.stringify({
        event: 'relay:command-executed',
        commandId: command.id,
        type: command.type,
        deploymentId: command.deploymentId,
        idempotencyKey: command.idempotencyKey,
      }),
    );

    const serviceArn = await findServiceArn(deps);
    if (!serviceArn) {
      return result(command, false, {
        error: `No ECS service found in stack "${deps.stackName}"`,
      });
    }
    const cluster = serviceArn.split('/')[1] ?? null;
    if (!cluster) {
      return result(command, false, { error: `Malformed service ARN "${serviceArn}"` });
    }

    try {
      // The service's rolling replacement makes forceNewDeployment safe to
      // re-issue: it never leaves the service with zero tasks.
      await deps.ecs.updateService({ cluster, service: serviceArn, forceNewDeployment: true });
    } catch (err) {
      return result(command, false, { error: String(err), failureCode: 'AWS_PERMISSION_DENIED' });
    }

    return result(command, true, { output: { executed: true, type: command.type } });
  };
}
