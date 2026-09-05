/**
 * Stage B phase 2 — post-install binding-alias registration.
 *
 * The published application template bakes the STANDARD injected env names
 * (DATABASE_URL + DATABASE_HOST/PORT/NAME/USER/PASSWORD secrets/env, the
 * REDIS_* set, the S3 bucket names). A dynamic app's manifest may additionally
 * carry alias bindings (MEMOS_DSN, PAPERLESS_DBHOST…, S3_ATTACHMENTS_BUCKET)
 * that the pre-published template cannot know about. This module closes that
 * gap the smallest way the runtime allows: right after the INSTALL executor
 * has settled and verified a fresh stack, it reads the task definition the
 * template created, copies the standard entries' VALUES/ARNs onto the alias
 * names, registers one new task-definition revision, and points the service
 * at it.
 *
 * Every alias VALUE is copied from the standard entry already on the running
 * definition — never a relay-held constant, never a secret read. A postgres
 * `url` alias (MEMOS_DSN) becomes a secret entry bound to the same
 * DatabaseUrlSecret ARN as DATABASE_URL; a `host` alias (PAPERLESS_DBHOST)
 * becomes plain env with DATABASE_HOST's value; a `password` alias becomes a
 * secret entry bound to `${DbSecretArn}:password::` exactly like
 * DATABASE_PASSWORD; a storage `bucket` alias becomes plain env with
 * AWS_S3_BUCKET's value. Later DEPLOY_RELEASE / CONFIG_UPDATE revisions copy
 * the whole definition forward, so the aliases survive every subsequent
 * change. Idempotent: when the aliases already match the running definition,
 * nothing is registered.
 */

import type { DeploymentManifest, ManifestEnvBinding } from '@deployz/contracts';

import type { EcsDeployClient, RegisterTaskDefinitionInput } from './deploy.js';
import type { CloudFormationReader } from './verify.js';

// ── Alias shape ──────────────────────────────────────────────────────────────

export type BindingAliasResource = 'postgres' | 'redis' | 's3';
export type BindingAliasKind = ManifestEnvBinding['kind'];

/** One place a provisioned value must be (re)injected on the task definition. */
export interface BindingAlias {
  readonly resource: BindingAliasResource;
  readonly name: string;
  readonly kind: BindingAliasKind;
}

/**
 * The alias bindings a manifest asks Deployz to inject, per provisioned
 * resource. Standard names are included too — applying them is a no-op, which
 * keeps this a single, idempotent source for every revision the relay writes.
 */
export function manifestBindingAliases(manifest: DeploymentManifest): BindingAlias[] {
  const aliases: BindingAlias[] = [];
  const seen = new Set<string>();
  const push = (resource: BindingAliasResource, bindings: ManifestEnvBinding[] | undefined): void => {
    for (const binding of bindings ?? []) {
      if (seen.has(binding.name)) continue;
      seen.add(binding.name);
      aliases.push({ resource, name: binding.name, kind: binding.kind });
    }
  };
  if (manifest.database.postgres) push('postgres', manifest.database.envBindings);
  if (manifest.redis.required) push('redis', manifest.redis.envBindings);
  if (manifest.storage.required) push('s3', manifest.storage.envBindings);
  return aliases;
}

/**
 * Read the compact alias list a deferred install wrote into its pending
 * marker (the full manifest does not survive the SSM size cap). Anything not
 * shaped like an alias is ignored.
 */
export function bindingAliasesFromPayload(payload: Record<string, unknown>): BindingAlias[] {
  const raw = payload['bindingAliases'];
  if (!Array.isArray(raw)) return [];
  const aliases: BindingAlias[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue;
    const record = entry as Partial<BindingAlias>;
    if (
      (record.resource === 'postgres' || record.resource === 'redis' || record.resource === 's3') &&
      typeof record.name === 'string' &&
      record.name.length > 0 &&
      typeof record.kind === 'string'
    ) {
      aliases.push({ resource: record.resource, name: record.name, kind: record.kind as BindingAliasKind });
    }
  }
  return aliases;
}

// ── Canonical source names (the standard entries the template bakes) ────────

const DB_URL_SECRET = 'DATABASE_URL';
const DB_PASSWORD_SECRET = 'DATABASE_PASSWORD';
const PART_ENV: Readonly<Record<string, string>> = {
  host: 'DATABASE_HOST',
  port: 'DATABASE_PORT',
  database: 'DATABASE_NAME',
  username: 'DATABASE_USER',
};
const REDIS_ENV: Readonly<Record<string, string>> = {
  url: 'REDIS_URL',
  host: 'REDIS_HOST',
  port: 'REDIS_PORT',
};
const S3_BUCKET_ENV = 'AWS_S3_BUCKET';

interface ContainerEnvEntry {
  name?: string | undefined;
  value?: string | undefined;
}
interface ContainerSecretEntry {
  name?: string | undefined;
  valueFrom?: string | undefined;
}

/**
 * The alias additions (env + secrets) to make on a task definition whose app
 * container currently carries `currentEnv` / `currentSecrets`. Each alias's
 * value is copied from the canonical standard entry; an alias whose source is
 * missing, whose name is its own source, or that is already present with the
 * same value is skipped. Pure and deterministic — unit-testable without AWS.
 */
export function computeAliasAdditions(
  aliases: readonly BindingAlias[],
  currentEnv: readonly ContainerEnvEntry[],
  currentSecrets: readonly ContainerSecretEntry[],
): { env: { name: string; value: string }[]; secrets: { name: string; valueFrom: string }[] } {
  const envByName = new Map(
    currentEnv
      .filter((entry) => typeof entry.name === 'string')
      .map((entry) => [entry.name as string, entry.value ?? '']),
  );
  const secretsByName = new Map(
    currentSecrets
      .filter((entry) => typeof entry.name === 'string' && typeof entry.valueFrom === 'string')
      .map((entry) => [entry.name as string, entry.valueFrom as string]),
  );

  const envAdditions: { name: string; value: string }[] = [];
  const secretAdditions: { name: string; valueFrom: string }[] = [];
  const seenEnv = new Set<string>();
  const seenSecrets = new Set<string>();

  for (const alias of aliases) {
    // Canonical name for this resource+kind — or null when the template does
    // not bake one (an alias we cannot source is skipped, never invented).
    let sourceName: string | null;
    let secretSource = false;
    if (alias.resource === 'postgres' && alias.kind === 'url') {
      sourceName = DB_URL_SECRET;
      secretSource = true;
    } else if (alias.resource === 'postgres' && alias.kind === 'password') {
      sourceName = DB_PASSWORD_SECRET;
      secretSource = true;
    } else if (alias.resource === 'postgres') {
      sourceName = PART_ENV[alias.kind] ?? null;
    } else if (alias.resource === 'redis') {
      sourceName = REDIS_ENV[alias.kind] ?? null;
    } else if (alias.resource === 's3' && alias.kind === 'bucket') {
      sourceName = S3_BUCKET_ENV;
    } else {
      sourceName = null;
    }
    if (sourceName === null || sourceName === alias.name) continue;

    if (secretSource) {
      const valueFrom = secretsByName.get(sourceName);
      if (valueFrom === undefined) continue;
      if (secretsByName.get(alias.name) !== valueFrom && !seenSecrets.has(alias.name)) {
        seenSecrets.add(alias.name);
        secretAdditions.push({ name: alias.name, valueFrom });
      }
    } else {
      const value = envByName.get(sourceName);
      if (value === undefined) continue;
      if (envByName.get(alias.name) !== value && !seenEnv.has(alias.name)) {
        seenEnv.add(alias.name);
        envAdditions.push({ name: alias.name, value });
      }
    }
  }

  return { env: envAdditions, secrets: secretAdditions };
}

// ── Applier ─────────────────────────────────────────────────────────────────

export interface BindingAliasApplierDeps {
  readonly cfn: CloudFormationReader;
  readonly ecs: EcsDeployClient;
  /** Stamped on every registered task-definition copy (IAM tag boundary). */
  readonly installationId: string;
}

export type BindingAliasApplyOutcome =
  | { readonly state: 'applied' }
  | { readonly state: 'already-applied' }
  | { readonly state: 'failed'; readonly reason: string };

/**
 * Creates the alias applier: describe the app service's current task
 * definition, copy the standard entries' values onto the alias names, register
 * one new revision, point the service at it. Runs only when the definition
 * actually needs the aliases — a re-install that already carries them is a
 * no-op (idempotent), never a second registration.
 */
export function createBindingAliasApplier(
  deps: BindingAliasApplierDeps,
): (options: { stackName: string; aliases: readonly BindingAlias[] }) => Promise<BindingAliasApplyOutcome> {
  return async ({ stackName, aliases }) => {
    if (aliases.length === 0) return { state: 'already-applied' };
    try {
      const resources = await deps.cfn.describeStackResources(stackName);
      const serviceArn = resources.find((resource) => resource.type === 'AWS::ECS::Service')?.physicalId ?? null;
      if (serviceArn === null) {
        return { state: 'failed', reason: `No ECS service found in stack "${stackName}"` };
      }
      const cluster = serviceArn.split('/')[1] ?? null;
      if (cluster === null) {
        return { state: 'failed', reason: `Malformed service ARN "${serviceArn}"` };
      }

      const { services } = await deps.ecs.describeServices({ cluster, services: [serviceArn] });
      const service = services[0];
      if (service === undefined || service.taskDefinition === undefined) {
        return { state: 'failed', reason: `ECS service "${serviceArn}" could not be described` };
      }

      const { taskDefinition } = await deps.ecs.describeTaskDefinition({
        taskDefinition: service.taskDefinition,
      });
      const appContainer =
        taskDefinition.containerDefinitions.find(
          (container) =>
            Array.isArray(container['environment']) && (container['environment'] as unknown[]).length > 0,
        ) ?? taskDefinition.containerDefinitions[0];
      if (appContainer === undefined) {
        return { state: 'failed', reason: 'Task definition has no container definitions' };
      }

      const currentEnv = (appContainer['environment'] as ContainerEnvEntry[]) ?? [];
      const currentSecrets = (appContainer['secrets'] as ContainerSecretEntry[]) ?? [];
      const additions = computeAliasAdditions(aliases, currentEnv, currentSecrets);
      if (additions.env.length === 0 && additions.secrets.length === 0) {
        return { state: 'already-applied' };
      }

      const envByName = new Map(currentEnv.map((entry) => [entry.name ?? '', entry.value ?? '']));
      for (const change of additions.env) envByName.set(change.name, change.value);
      const secretsByName = new Map(
        currentSecrets.map((entry) => [entry.name ?? '', entry.valueFrom ?? '']),
      );
      for (const binding of additions.secrets) secretsByName.set(binding.name, binding.valueFrom);

      const updatedContainers = taskDefinition.containerDefinitions.map((container) =>
        container === appContainer
          ? {
              ...container,
              environment: [...envByName.entries()].map(([name, value]) => ({ name, value })),
              secrets: [...secretsByName.entries()].map(([name, valueFrom]) => ({ name, valueFrom })),
            }
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
        // Same request-tag boundary as the deploy/config-update registers.
        tags: [{ key: 'deployz:installation', value: deps.installationId }],
      };

      const registered = await deps.ecs.registerTaskDefinition(nextDefinition);
      await deps.ecs.updateService({
        cluster,
        service: serviceArn,
        taskDefinition: registered.taskDefinitionArn,
      });
      return { state: 'applied' };
    } catch (error) {
      return { state: 'failed', reason: String(error) };
    }
  };
}
