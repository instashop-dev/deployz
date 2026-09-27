/**
 * CONFIG_UPDATE executor — apply desired configuration to the running
 * application.
 *
 * Two kinds of values, two paths (Task 5.1):
 *   - Secret values are written INTO the customer's Secrets Manager by this
 *     executor (they arrive transiently in the command payload — the control
 *     plane never stores them), then the task definition references them
 *     via a `secrets` entry (`valueFrom`), which ECS injects at task start.
 *   - Plain values are environment variables on the ECS task definition.
 *     A force restart alone does NOT update them — the definition must be
 *     copied, the environment array updated, and a new revision registered
 *     before the service is updated to use it.
 *
 * Idempotent: when the desired plain values and secret bindings already
 * match the running task definition, the answer is success with no new
 * revision registered. Secret values are merged into ONE per-installation
 * Secrets Manager secret — the application template's `AppConfigSecret`
 * (its execution role already grants read, so no new IAM is needed) — so a
 * save that only touched one key leaves the other keys intact.
 *
 * Generated secrets (AI MVP Phase 4): an entry flagged `generated` is an
 * application-internal secret the control plane never holds a value for.
 * The relay mints it here — cryptographic randomness, inside the customer's
 * account, once — and keeps it across every later run. A secret key whose
 * value is absent from the store (a vendor-scope secret entered before the
 * relay existed, whose value the control plane could not keep) is reported
 * as unbound rather than bound: binding a missing key would stop every task
 * from starting.
 */

import { randomBytes } from 'node:crypto';

import {
  GetSecretValueCommand,
  PutSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';

import type { CommandExecutor } from './commands.js';
import type { CloudFormationReader, StackResource } from './verify.js';
import type { EcsDeployClient, RegisterTaskDefinitionInput } from './deploy.js';

/** One entry from the control plane's effective configuration. */
export interface EffectiveConfigEntry {
  readonly key: string;
  readonly isSecret: boolean;
  /** Present only for plain values; secrets are write-only in the control plane. */
  readonly value?: string;
  readonly source: 'vendor' | 'customer' | 'generated';
  /** Deployz mints this secret inside the customer's account when it is absent. */
  readonly generated?: boolean;
}

/**
 * Secrets Manager write surface for customer config secrets (injectable seam
 * for testing). The relay talks only to secrets the customer's own
 * application stack created (`AppConfigSecret`) or the relay itself created.
 */
export interface ConfigSecretsWriter {
  getSecretValue(params: { SecretId: string }): Promise<{
    /** The secret's ARN as Secrets Manager reports it. */
    arn: string;
    secretString: string | undefined;
  }>;
  putSecretValue(params: { SecretId: string; secretString: string }): Promise<void>;
}

export interface ConfigUpdateDeps {
  readonly cfn: CloudFormationReader;
  readonly ecs: EcsDeployClient;
  /** Writes customer config secrets into the customer's Secrets Manager. */
  readonly secrets: ConfigSecretsWriter;
  /** Fetches the effective desired config over the authenticated channel. */
  readonly fetchEffectiveConfig: () => Promise<EffectiveConfigEntry[]>;
  readonly stackName: string;
  readonly installationId: string;
  /** Mints a generated secret value (injectable for tests). */
  readonly generateSecret?: () => string;
}

/** What one configuration pass did with the secret store. */
export interface ConfigSecretReport {
  /** Keys minted in this run. */
  readonly generatedKeys: string[];
  /** Secret keys the effective config names but the store has no value for — left unbound. */
  readonly unboundSecretKeys: string[];
}

type ConfigUpdateOutcome =
  | { readonly state: 'succeeded'; readonly alreadyApplied: boolean; readonly report: ConfigSecretReport }
  | { readonly state: 'failed'; readonly reason: string }
  | { readonly state: 'updating'; readonly report: ConfigSecretReport };

/** 256 bits of randomness, URL-safe — usable as any session/JWT/encryption secret. */
export function generateSecretValue(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * Computes the environment-array delta: which plain entries need to be
 * added or changed on the task definition. Pure, so the comparison rules
 * are testable without AWS.
 */
export function computeEnvChanges(
  desired: readonly EffectiveConfigEntry[],
  currentEnvironment: readonly { name?: string | undefined; value?: string | undefined }[],
  removedKeys: readonly string[] = [],
): { changes: { name: string; value: string }[]; removals: string[] } | null {
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
  // Only the keys the vendor explicitly removed are stripped — everything
  // else in the environment (install-time values the template baked in) is
  // not Deployz-managed and must survive untouched.
  const removals = removedKeys.filter((key) => currentByName.has(key));
  return changes.length > 0 || removals.length > 0 ? { changes, removals } : null;
}

/**
 * Computes the task-definition `secrets` delta: which secret keys need to
 * be (re)bound to the customer's config secret, and which explicitly removed
 * keys leave the array. Pure and testable without AWS.
 */
export function computeSecretChanges(
  desired: readonly EffectiveConfigEntry[],
  currentSecrets: readonly { name?: string | undefined; valueFrom?: string | undefined }[],
  secretArn: string,
  removedKeys: readonly string[] = [],
  availableKeys?: ReadonlySet<string>,
): { bindings: { name: string; valueFrom: string }[]; removals: string[] } | null {
  const currentByName = new Map(
    currentSecrets
      .filter((secret) => typeof secret.name === 'string' && typeof secret.valueFrom === 'string')
      .map((secret) => [secret.name as string, secret.valueFrom as string]),
  );

  const bindings: { name: string; valueFrom: string }[] = [];
  for (const entry of desired) {
    if (!entry.isSecret) continue;
    // A key the store holds no value for is never bound (ECS would refuse
    // to start the task); the caller reports it instead.
    if (availableKeys !== undefined && !availableKeys.has(entry.key)) continue;
    // Deterministic ECS keyed-json reference into the config secret. The
    // secret ARN can change across re-creates, so a re-point is a change.
    const valueFrom = `${secretArn}:${entry.key}::`;
    if (currentByName.get(entry.key) !== valueFrom) {
      bindings.push({ name: entry.key, valueFrom });
    }
  }
  const removals = removedKeys.filter((key) => currentByName.has(key));
  return bindings.length > 0 || removals.length > 0 ? { bindings, removals } : null;
}

/**
 * The application template's runtime-secrets resource, discovered by logical
 * id — the physical id is its Secrets Manager ARN. Null when the stack does
 * not contain it (an old template), which the caller fails on honestly.
 */
export function findAppConfigSecretArn(resources: readonly StackResource[]): string | null {
  // CDK appends a hash to an L2 construct's logical id (`AppConfigSecret251CAC1E`),
  // so the match is on the construct-id prefix, never on equality — an exact
  // match found nothing in every real stack (DEPLOY-010).
  const secret = resources.find(
    (resource) => resource.type === 'AWS::SecretsManager::Secret' && resource.logicalId.startsWith('AppConfigSecret'),
  );
  return secret?.physicalId ?? null;
}

async function settleConfigUpdate(
  deps: ConfigUpdateDeps,
  removedKeys: readonly string[] = [],
  secretValues: Readonly<Record<string, string>> = {},
): Promise<ConfigUpdateOutcome> {
  const desired = await deps.fetchEffectiveConfig();

  const resources = await deps.cfn.describeStackResources(deps.stackName);
  // Phase 4A: one service per persistent workload — the desired config
  // reaches EVERY workload (each task definition bakes the same env/secrets),
  // never just the first service found.
  const serviceArns = resources
    .filter((resource) => resource.type === 'AWS::ECS::Service' && resource.physicalId !== undefined)
    .map((resource) => resource.physicalId!);
  if (serviceArns.length === 0) {
    return { state: 'failed', reason: `No ECS service found in stack "${deps.stackName}"` };
  }
  const cluster = serviceArns[0]!.split('/')[1] ?? null;
  if (!cluster) {
    return { state: 'failed', reason: `Malformed service ARN "${serviceArns[0]!}"` };
  }

  const { services } = await deps.ecs.describeServices({ cluster, services: serviceArns });
  // DescribeServices answers in request order; zip each answer to the ARN
  // that asked for it. A service that cannot be described fails the pass —
  // config that silently skips a workload would leave two sources of truth.
  const live: { arn: string; taskDefinition: string }[] = [];
  for (let i = 0; i < serviceArns.length; i++) {
    const service = services[i];
    if (!service || service.taskDefinition === undefined) {
      return { state: 'failed', reason: `ECS service "${serviceArns[i]}" could not be described` };
    }
    live.push({ arn: serviceArns[i]!, taskDefinition: service.taskDefinition });
  }

  // ── Secret reconciliation ──────────────────────────────────────────────
  // Newly-entered values ride the command payload transiently; previously
  // entered values already live in the customer's config secret. Merge the
  // new values in and remove deleted keys; binding follows the effective
  // config's secret keys (all of them, not just the changed ones). The store
  // is shared by every workload, so this runs ONCE.
  const desiredSecrets = desired.filter((entry) => entry.isSecret);
  const hasIncomingValues = Object.keys(secretValues).length > 0;
  const generatedKeys: string[] = [];
  const unboundSecretKeys: string[] = [];
  const availableSecretKeys = new Set<string>();
  let secretArn: string | null = null;
  if (desiredSecrets.length > 0 || hasIncomingValues || removedKeys.length > 0) {
    const arn = findAppConfigSecretArn(resources);
    if (arn === null) {
      return {
        state: 'failed',
        reason: `Stack "${deps.stackName}" has no AppConfigSecret to write config secrets into`,
      };
    }
    secretArn = arn;

    const existing = await deps.secrets.getSecretValue({ SecretId: arn });
    let merged: Record<string, unknown> = {};
    if (existing.secretString !== undefined) {
      try {
        const parsed: unknown = JSON.parse(existing.secretString);
        if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
          merged = { ...(parsed as Record<string, unknown>) };
        }
      } catch {
        // Not a JSON object — treat as empty rather than corrupting what
        // the application stack manages with a lost merge.
        merged = {};
      }
    }
    let changed = false;
    // Pending pre-relay values arrive in the desired entries (the vault
    // overlay on /api/relay/config), not the command payload. A same-key
    // value in the payload is the newer vendor intent and wins over it.
    for (const entry of desiredSecrets) {
      if (typeof entry.value === 'string' && entry.value.length > 0 && merged[entry.key] !== entry.value) {
        merged[entry.key] = entry.value;
        changed = true;
      }
    }
    for (const [key, value] of Object.entries(secretValues)) {
      if (merged[key] !== value) {
        merged[key] = value;
        changed = true;
      }
    }
    for (const key of removedKeys) {
      if (key in merged) {
        delete merged[key];
        changed = true;
      }
    }
    // Mint each generated secret exactly once: a value already in the store
    // (an earlier pass, or a value the vendor chose to set) is kept.
    for (const entry of desiredSecrets) {
      if (entry.generated === true && !(typeof merged[entry.key] === 'string' && (merged[entry.key] as string).length > 0)) {
        merged[entry.key] = (deps.generateSecret ?? generateSecretValue)();
        generatedKeys.push(entry.key);
        changed = true;
      }
    }
    if (changed) {
      await deps.secrets.putSecretValue({ SecretId: arn, secretString: JSON.stringify(merged) });
    }
    for (const entry of desiredSecrets) {
      if (typeof merged[entry.key] === 'string' && (merged[entry.key] as string).length > 0) {
        availableSecretKeys.add(entry.key);
      } else {
        unboundSecretKeys.push(entry.key);
      }
    }
  }

  const report: ConfigSecretReport = { generatedKeys, unboundSecretKeys };

  // Per-workload deltas: each task definition carries its own current
  // env/secrets arrays, so each computes its own delta against the same
  // desired config.
  interface ServiceDelta {
    readonly arn: string;
    readonly taskDefinition: Awaited<ReturnType<EcsDeployClient['describeTaskDefinition']>>['taskDefinition'];
    readonly envDelta: ReturnType<typeof computeEnvChanges>;
    readonly secretDelta: ReturnType<typeof computeSecretChanges>;
    readonly appContainer: Record<string, unknown>;
  }
  const deltas: ServiceDelta[] = [];
  for (const liveService of live) {
    const { taskDefinition } = await deps.ecs.describeTaskDefinition({
      taskDefinition: liveService.taskDefinition,
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
    const currentSecrets = (appContainer['secrets'] as { name?: string; valueFrom?: string }[]) ?? [];
    const envDelta = computeEnvChanges(desired, currentEnv, removedKeys);
    const secretDelta =
      secretArn === null
        ? null
        : computeSecretChanges(desired, currentSecrets, secretArn, removedKeys, availableSecretKeys);
    if (envDelta === null && secretDelta === null) continue;
    deltas.push({
      arn: liveService.arn,
      taskDefinition,
      envDelta,
      secretDelta,
      appContainer: appContainer as Record<string, unknown>,
    });
  }

  if (deltas.length === 0) {
    return { state: 'succeeded', alreadyApplied: true, report };
  }

  // Apply the deltas: per service, merge changes into the environment array
  // and the secrets array, strip the explicitly removed keys, register a new
  // revision of that workload's task definition, and point its service at it.
  for (const delta of deltas) {
    const currentEnv =
      (delta.appContainer['environment'] as { name?: string; value?: string }[]) ?? [];
    const currentSecrets =
      (delta.appContainer['secrets'] as { name?: string; valueFrom?: string }[]) ?? [];

    const envByName = new Map(currentEnv.map((env) => [env.name ?? '', env.value ?? '']));
    if (delta.envDelta !== null) {
      for (const change of delta.envDelta.changes) {
        envByName.set(change.name, change.value);
      }
      for (const removed of delta.envDelta.removals) {
        envByName.delete(removed);
      }
    }
    const nextEnvironment = [...envByName.entries()].map(([name, value]) => ({ name, value }));

    const secretsByName = new Map(currentSecrets.map((secret) => [secret.name ?? '', secret.valueFrom ?? '']));
    if (delta.secretDelta !== null) {
      for (const binding of delta.secretDelta.bindings) {
        secretsByName.set(binding.name, binding.valueFrom);
      }
      for (const removed of delta.secretDelta.removals) {
        secretsByName.delete(removed);
      }
    }
    const nextSecrets = [...secretsByName.entries()].map(([name, valueFrom]) => ({ name, valueFrom }));

    const updatedContainers = delta.taskDefinition.containerDefinitions.map((container) =>
      container === delta.appContainer
        ? {
            ...container,
            environment: delta.envDelta === null ? container['environment'] : nextEnvironment,
            ...(delta.secretDelta !== null ? { secrets: nextSecrets } : {}),
          }
        : { ...container },
    );

    const nextDefinition: RegisterTaskDefinitionInput = {
      family: delta.taskDefinition.family,
      cpu: delta.taskDefinition.cpu,
      memory: delta.taskDefinition.memory,
      networkMode: delta.taskDefinition.networkMode,
      requiresCompatibilities: delta.taskDefinition.requiresCompatibilities,
      executionRoleArn: delta.taskDefinition.executionRoleArn,
      taskRoleArn: delta.taskDefinition.taskRoleArn,
      containerDefinitions: updatedContainers,
      ...(delta.taskDefinition.volumes ? { volumes: delta.taskDefinition.volumes } : {}),
      // The relay's ecs:RegisterTaskDefinition grant is request-tag scoped —
      // an untagged register is AccessDenied (verified live), same as the
      // deploy executor's register.
      tags: [{ key: 'deployz:installation', value: deps.installationId }],
    };

    const registered = await deps.ecs.registerTaskDefinition(nextDefinition);
    await deps.ecs.updateService({
      cluster,
      service: delta.arn,
      taskDefinition: registered.taskDefinitionArn,
    });
  }

  return { state: 'updating', report };
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

    const payload = command.payload as { removedKeys?: unknown; secrets?: unknown };
    const payloadRemoved = payload.removedKeys;
    const removedKeys = Array.isArray(payloadRemoved)
      ? payloadRemoved.filter((key): key is string => typeof key === 'string')
      : [];

    const payloadSecrets = payload.secrets;
    const secretValues: Record<string, string> = {};
    if (Array.isArray(payloadSecrets)) {
      for (const entry of payloadSecrets) {
        if (typeof entry !== 'object' || entry === null) continue;
        const key = (entry as { key?: unknown }).key;
        const value = (entry as { value?: unknown }).value;
        if (typeof key === 'string' && key.length > 0 && typeof value === 'string') {
          secretValues[key] = value;
        }
      }
    }
    // Values never surface in a log line — count only.
    console.log(
      JSON.stringify({
        event: 'relay:config-update-payload',
        commandId: command.id,
        removedKeyCount: removedKeys.length,
        secretValueCount: Object.keys(secretValues).length,
      }),
    );

    let outcome: ConfigUpdateOutcome;
    try {
      outcome = await settleConfigUpdate(deps, removedKeys, secretValues);
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
        // Key names only — never a value.
        generatedKeys: outcome.report.generatedKeys,
        unboundSecretKeys: outcome.report.unboundSecretKeys,
      },
    };
  };
}

/**
 * Production Secrets Manager writer — credentials come from the standard SDK
 * chain, exactly like the other relay clients.
 */
export function createRealConfigSecretsWriter(): ConfigSecretsWriter {
  const client = new SecretsManagerClient({});
  return {
    async getSecretValue({ SecretId }) {
      const response = await client.send(new GetSecretValueCommand({ SecretId }));
      return { arn: response.ARN ?? SecretId, secretString: response.SecretString };
    },
    async putSecretValue({ SecretId, secretString }) {
      await client.send(new PutSecretValueCommand({ SecretId, SecretString: secretString }));
    },
  };
}