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
      deployments?: { status?: string | undefined; rolloutState?: string | undefined }[];
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
  }): Promise<void>;
  listTasks(input: { cluster: string; serviceName: string }): Promise<{ taskArns: string[] }>;
  describeTasks(input: {
    cluster: string;
    tasks: string[];
  }): Promise<{
    tasks: {
      lastStatus?: string | undefined;
      stopCode?: string | undefined;
      stoppedReason?: string | undefined;
      containers?: { imageDigest?: string | undefined; exitCode?: number | undefined }[] | undefined;
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
  | { readonly state: 'in-progress'; readonly migration?: PendingMigration };

/** Per-call deploy context: which command family is running and any migration state already started. */
export interface DeploySettleContext {
  /**
   * Migrations run only for DEPLOY_RELEASE. ROLLBACK rolls the old digest
   * without them — schema changes are never auto-reversed.
   */
  readonly allowMigration: boolean;
  /** The pending marker's migration state, when this command was already started. */
  readonly migration?: PendingMigration | null;
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
    return {
      state: 'failed',
      reason: 'The ECS deployment circuit breaker reported a failed rollout',
      failureCode: 'ECS_DEPLOYMENT_FAILED',
    };
  }

  const runningDigest = await observeRunningDigest(deps, cluster, serviceArn);
  const stable =
    (service.desiredCount ?? 0) > 0 && (service.runningCount ?? 0) >= (service.desiredCount ?? 0);
  const rolloutCompleted = primaryRolloutCompleted(service.deployments);
  const targetsHealthy = await deploymentTargetsHealthy(deps);
  if (runningDigest === request.imageDigest && stable && rolloutCompleted && targetsHealthy) {
    return { state: 'succeeded', alreadyRunning: true };
  }

  const { taskDefinition } = await deps.ecs.describeTaskDefinition({
    taskDefinition: service.taskDefinition,
  });
  const nextImage = `${request.imageRepository}@${request.imageDigest}`;
  let alreadyRegistered = taskDefinition.containerDefinitions.some(
    (container) => container.image === nextImage,
  );

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
      return { state: 'failed', reason: outcome.reason, failureCode: 'MIGRATION_FAILED' };
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
    });
  } else if (runningDigest !== request.imageDigest) {
    // The application copy already exists — the migration stage registered it
    // (or an earlier attempt did) — but the service never picked it up.
    // Re-issue the update against that copy.
    await deps.ecs.updateService({
      cluster,
      service: serviceArn,
      taskDefinition: registeredApplicationArn ?? service.taskDefinition,
    });
  }

  // The rollout just started or is still in flight — only its own progress
  // can settle it, on a later poll.
  return migration === undefined ? { state: 'in-progress' } : { state: 'in-progress', migration };
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
  | { readonly state: 'failed'; readonly reason: string };

/**
 * Runs (or resumes) the migration stage: one one-off ECS task on the SAME
 * cluster/VPC/subnets/security groups as the app service, running the NEW
 * digest with the command overridden, no load balancer. Polls DescribeTasks
 * until STOPPED; a task that outlives the invocation is resumed by ARN on a
 * later poll, never re-run. Exit code 0 completes the stage; anything else
 * fails the job with MIGRATION_FAILED (exit code + stoppedReason as detail —
 * never log bodies: the relay role deliberately has no logs:GetLogEvents).
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
            : [{ name: appContainer.name, command: migrationCommand.split(' ') }],
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
    const exitCode = task.containers?.find((container) => container.exitCode !== undefined)?.exitCode;
    if (exitCode !== 0) {
      return {
        state: 'failed',
        reason: `Migration failed: exit code ${exitCode ?? 'unknown'} (${task.stopCode ?? 'STOPPED'}: ${task.stoppedReason ?? 'no reason given'})`,
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
): Promise<string | null> {
  const { taskArns } = await deps.ecs.listTasks({ cluster, serviceName: serviceArn });
  if (taskArns.length === 0) return null;
  const { tasks } = await deps.ecs.describeTasks({ cluster, tasks: taskArns });
  for (const task of tasks) {
    const digest = task.containers?.find((c) => c.imageDigest?.startsWith('sha256:'))?.imageDigest;
    if (digest) return digest;
  }
  return null;
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
      payload: command.payload,
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

    const outcome = await settleEcsDeploy(deps, request, {
      allowMigration: pending.type === 'DEPLOY_RELEASE',
      migration: pending.migration ?? null,
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
