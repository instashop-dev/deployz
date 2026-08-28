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
 */

import type { CommandExecutor, RelayCommand, RelayCommandResult } from './commands.js';
import type { PendingStore } from './pending.js';
import type { CloudFormationReader } from './verify.js';

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
  }): Promise<{ tasks: { containers?: { imageDigest?: string | undefined }[] }[] }>;
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
  readonly pending: PendingStore;
  readonly stackName: string;
  /** Stamped on every registered task-definition copy (IAM tag boundary). */
  readonly installationId: string;
  readonly now?: () => string;
}

/** A deploy request after payload validation. */
export interface DeployRequest {
  readonly imageRepository: string;
  readonly imageDigest: string;
}

const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

/** Parses and validates the control plane's deploy payload contract. */
export function readDeployRequest(payload: Record<string, unknown>): DeployRequest | null {
  const imageRepository = payload['imageRepository'];
  const imageDigest = payload['imageDigest'];
  if (typeof imageRepository !== 'string' || imageRepository.length === 0) return null;
  if (typeof imageDigest !== 'string' || !DIGEST_PATTERN.test(imageDigest)) return null;
  return { imageRepository, imageDigest };
}

type EcsDeployOutcome =
  | { readonly state: 'succeeded'; readonly alreadyRunning: boolean }
  | { readonly state: 'failed'; readonly reason: string; readonly failureCode?: string }
  | { readonly state: 'in-progress' };

/**
 * Runs the deploy to whatever conclusion is available right now. Reads
 * before writes: a rollout that already reached the requested digest (or the
 * circuit breaker) is settled without registering anything.
 */
export async function settleEcsDeploy(
  deps: EcsDeployDeps,
  request: DeployRequest,
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
  if (runningDigest === request.imageDigest && stable) {
    return { state: 'succeeded', alreadyRunning: true };
  }

  const { taskDefinition } = await deps.ecs.describeTaskDefinition({
    taskDefinition: service.taskDefinition,
  });
  const nextImage = `${request.imageRepository}@${request.imageDigest}`;
  const alreadyRegistered = taskDefinition.containerDefinitions.some(
    (container) => container.image === nextImage,
  );

  if (!alreadyRegistered) {
    const replaced = replaceApplicationImages(taskDefinition, request);
    if (!replaced) {
      return {
        state: 'failed',
        reason: `No container in the task definition references repository "${request.imageRepository}"`,
      };
    }
    replaced.tags = [{ key: 'deployz:installation', value: deps.installationId }];
    const registered = await deps.ecs.registerTaskDefinition(replaced);
    await deps.ecs.updateService({
      cluster,
      service: serviceArn,
      taskDefinition: registered.taskDefinitionArn,
    });
  } else if (runningDigest !== request.imageDigest) {
    // Registered on an earlier attempt but the service never picked it up
    // (an update that did not land). Re-issue the update.
    await deps.ecs.updateService({ cluster, service: serviceArn, taskDefinition: service.taskDefinition });
  }

  // The rollout just started or is still in flight — only its own progress
  // can settle it, on a later poll.
  return { state: 'in-progress' };
}

function rolloutFailed(
  deployments: { status?: string | undefined; rolloutState?: string | undefined }[] | undefined,
): boolean {
  return deployments?.some((deployment) => deployment.rolloutState === 'FAILED') ?? false;
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
      outcome = await settleEcsDeploy(deps, request);
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
    // job in RUNNING forever, which is worse than an honest failure.
    const recorded = await deps.pending.write({
      commandId: command.id,
      idempotencyKey: command.idempotencyKey,
      type: command.type,
      stackName: deps.stackName,
      startedAt: (deps.now ?? (() => new Date().toISOString()))(),
      payload: command.payload,
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

    const outcome = await settleEcsDeploy(deps, request);
    if (outcome.state === 'in-progress') {
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
