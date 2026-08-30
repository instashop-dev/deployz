/**
 * CONFIG_UPDATE executor — apply desired configuration to the running
 * application.
 *
 * Two kinds of values, two paths (Task 5.1):
 *   - Secret values live in the customer's Secrets Manager already (written
 *     at save time by the write-through). The task definition references
 *     them; nothing to write here.
 *   - Plain values are environment variables on the ECS task definition.
 *     A force restart alone does NOT update them — the definition must be
 *     copied, the environment array updated, and a new revision registered
 *     before the service is updated to use it.
 *
 * Idempotent: when the desired plain values already match the running task
 * definition, the answer is success with no new revision registered.
 */

import type { CommandExecutor } from './commands.js';
import type { CloudFormationReader } from './verify.js';
import type { EcsDeployClient, RegisterTaskDefinitionInput } from './deploy.js';

/** One entry from the control plane's effective configuration. */
export interface EffectiveConfigEntry {
  readonly key: string;
  readonly isSecret: boolean;
  /** Present only for plain values; secrets are write-only in the control plane. */
  readonly value?: string;
  readonly source: 'vendor' | 'customer';
}

export interface ConfigUpdateDeps {
  readonly cfn: CloudFormationReader;
  readonly ecs: EcsDeployClient;
  /** Fetches the effective desired config over the authenticated channel. */
  readonly fetchEffectiveConfig: () => Promise<EffectiveConfigEntry[]>;
  readonly stackName: string;
  readonly installationId: string;
}

type ConfigUpdateOutcome =
  | { readonly state: 'succeeded'; readonly alreadyApplied: boolean }
  | { readonly state: 'failed'; readonly reason: string }
  | { readonly state: 'updating' };

/**
 * Computes the environment-array delta: which plain entries need to be
 * added or changed on the task definition. Pure, so the comparison rules
 * are testable without AWS.
 */
export function computeEnvChanges(
  desired: readonly EffectiveConfigEntry[],
  currentEnvironment: readonly { name?: string | undefined; value?: string | undefined }[],
): { name: string; value: string }[] | null {
  const desiredPlain = desired.filter((entry) => !entry.isSecret && entry.value !== undefined);
  const currentByName = new Map(
    currentEnvironment
      .filter((env) => typeof env.name === 'string')
      .map((env) => [env.name as string, env.value ?? '']),
  );

  const changes: { name: string; value: string }[] = [];
  for (const entry of desiredPlain) {
    const current = currentByName.get(entry.key);
    if (current !== entry.value) {
      changes.push({ name: entry.key, value: entry.value! });
    }
  }
  return changes.length > 0 ? changes : null;
}

async function findServiceArn(deps: ConfigUpdateDeps): Promise<string | null> {
  const resources = await deps.cfn.describeStackResources(deps.stackName);
  return (
    resources.find((resource) => resource.type === 'AWS::ECS::Service')?.physicalId ?? null
  );
}

async function settleConfigUpdate(deps: ConfigUpdateDeps): Promise<ConfigUpdateOutcome> {
  const desired = await deps.fetchEffectiveConfig();

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
    return { state: 'failed', reason: `ECS service "${serviceArn}" could not be described` };
  }

  const { taskDefinition } = await deps.ecs.describeTaskDefinition({
    taskDefinition: service.taskDefinition,
  });

  // Find the application container (the one with environment variables or
  // the first one — same heuristic the deploy executor uses).
  const appContainer =
    taskDefinition.containerDefinitions.find(
      (container) =>
        Array.isArray(container['environment']) && (container['environment'] as unknown[]).length > 0,
    ) ?? taskDefinition.containerDefinitions[0];
  if (!appContainer) {
    return { state: 'failed', reason: 'Task definition has no container definitions' };
  }

  const currentEnv = (appContainer['environment'] as { name?: string; value?: string }[]) ?? [];
  const changes = computeEnvChanges(desired, currentEnv);

  if (changes === null) {
    return { state: 'succeeded', alreadyApplied: true };
  }

  // Apply the changes: merge into the environment array, register a new
  // task definition, update the service.
  const envByName = new Map(currentEnv.map((env) => [env.name ?? '', env.value ?? '']));
  for (const change of changes) {
    envByName.set(change.name, change.value);
  }
  const nextEnvironment = [...envByName.entries()].map(([name, value]) => ({ name, value }));

  const updatedContainers = taskDefinition.containerDefinitions.map((container) =>
    container === appContainer
      ? { ...container, environment: nextEnvironment }
      : { ...container },
  );

  const nextDefinition: RegisterTaskDefinitionInput = {
    family: taskDefinition.family,
    cpu: taskDefinition.cpu,
    memory: taskDefinition.memory,
    networkMode: taskDefinition.networkMode,
    requiresCompatibilities: taskDefinition.requiresCompatibilities,
    executionRoleArn: taskDefinition.executionRoleArn,
    taskRoleArn: taskDefinition.taskRoleArn,
    containerDefinitions: updatedContainers,
    ...(taskDefinition.volumes ? { volumes: taskDefinition.volumes } : {}),
    // The relay's ecs:RegisterTaskDefinition grant is request-tag scoped —
    // an untagged register is AccessDenied (verified live), same as the
    // deploy executor's register.
    tags: [{ key: 'deployz:installation', value: deps.installationId }],
  };

  const registered = await deps.ecs.registerTaskDefinition(nextDefinition);
  await deps.ecs.updateService({
    cluster,
    service: serviceArn,
    taskDefinition: registered.taskDefinitionArn,
  });

  return { state: 'updating' };
}

export function createConfigUpdateExecutor(deps: ConfigUpdateDeps): CommandExecutor {
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

    let outcome: ConfigUpdateOutcome;
    try {
      outcome = await settleConfigUpdate(deps);
    } catch (err) {
      return {
        commandId: command.id,
        idempotencyKey: command.idempotencyKey,
        success: false,
        error: String(err),
        failureCode: 'AWS_PERMISSION_DENIED',
      };
    }

    if (outcome.state === 'failed') {
      return {
        commandId: command.id,
        idempotencyKey: command.idempotencyKey,
        success: false,
        error: outcome.reason,
      };
    }

    // Both 'succeeded' and 'updating' report success from the executor's
    // perspective: the task definition was registered and the service
    // updated. The rollout itself is ECS's problem — the watchdog will
    // catch a stuck rollout.
    return {
      commandId: command.id,
      idempotencyKey: command.idempotencyKey,
      success: true,
      output: {
        executed: true,
        type: command.type,
        alreadyApplied: outcome.state === 'succeeded',
      },
    };
  };
}
