/**
 * Runtime image-digest observation — what is ACTUALLY running in ECS, read
 * from the running tasks rather than from any control-plane pointer.
 *
 * Discovery path: CloudFormation stack resources → ECS service → running
 * tasks → container imageDigest. The task's imageDigest is the truth even
 * when the task definition references a mutable tag, because ECS resolves
 * the digest at pull time.
 */

import { listAllStackResources } from './stack-resources.js';
import type { CloudFormationReader } from './verify.js';

/** The ECS surface this module needs (injectable seam for testing). */
export interface EcsTaskReader {
  listTasks(input: {
    cluster: string;
    serviceName: string;
    nextToken?: string | undefined;
  }): Promise<{ taskArns: string[]; nextToken?: string | undefined }>;
  describeTasks(input: {
    cluster: string;
    tasks: string[];
  }): Promise<{
    tasks: {
      lastStatus?: string | undefined;
      taskDefinitionArn?: string | undefined;
      containers?: { name?: string | undefined; imageDigest?: string | undefined }[];
    }[];
  }>;
  describeTaskDefinition(input: { taskDefinition: string }): Promise<{
    taskDefinition: { containerDefinitions?: readonly ContainerEssentials[] | undefined };
  }>;
}

/** The two task-definition fields that tell the application container apart. */
export interface ContainerEssentials {
  readonly name?: unknown;
  readonly essential?: unknown;
}

/**
 * DEPLOY-014 — a task carries more than the application container: the RDS
 * CA init container (DEPLOY-007) runs first and reports its own image digest
 * and exit code, so "the first container with a digest" is a sidecar's. The
 * application is the task's essential container (ECS defaults `essential`
 * to true; init containers and sidecars declare false), and only its digest
 * and exit code count.
 */
export function essentialContainerNames(
  containerDefinitions: readonly ContainerEssentials[] | undefined,
): ReadonlySet<string> {
  const names = new Set<string>();
  for (const container of containerDefinitions ?? []) {
    if (typeof container.name === 'string' && container.essential !== false) names.add(container.name);
  }
  return names;
}

/**
 * The containers of a task that belong to the application. A container the
 * task does not name cannot be told apart and counts; every container counts
 * when the definition names none (a task described without its definition).
 */
export function applicationContainers<T extends { name?: string | undefined }>(
  containers: readonly T[] | undefined,
  essential: ReadonlySet<string>,
): T[] {
  const list = [...(containers ?? [])];
  if (essential.size === 0) return list;
  return list.filter((container) => container.name === undefined || essential.has(container.name));
}

/**
 * The containers of a stopped task whose exit code belongs to the
 * application. A runtime container carries no `essential` field, so the
 * names must come from the revision the task ran. Unlike
 * `applicationContainers`, an unnamed container never counts: a helper's
 * exit must never be read as the application's.
 */
export function applicationExits<T extends { name?: string | undefined; exitCode?: number | undefined }>(
  containers: readonly T[] | undefined,
  essential: ReadonlySet<string>,
): (T & { exitCode: number })[] {
  return (containers ?? []).filter(
    (container): container is T & { exitCode: number } =>
      container.name !== undefined && essential.has(container.name) && container.exitCode !== undefined,
  );
}

export interface ObserveDigestDeps {
  readonly cfn: CloudFormationReader;
  readonly ecs: EcsTaskReader;
  readonly installationId: string;
}

const SERVICE_RESOURCE_TYPE = 'AWS::ECS::Service';

/** DescribeTasks accepts at most 100 task ARNs per call. */
const DESCRIBE_TASKS_BATCH = 100;

/** The distinct digests running in one ECS service of the stack. */
export interface ServiceDigests {
  readonly serviceLogicalId: string;
  /**
   * The distinct application digests of every RUNNING task; empty when no task
   * runs; null when the tasks could not be read in full (a failed call, or a
   * RUNNING task without an application digest).
   */
  readonly digests: string[] | null;
}

/**
 * The digests running in each ECS service of the stack, or null when the
 * stack inventory cannot be read. A service that fails to read gives null
 * digests for that service only.
 */
export async function observeServiceDigests(
  deps: ObserveDigestDeps,
  stackName: string,
): Promise<ServiceDigests[] | null> {
  const inventory = await listAllStackResources(deps.cfn, stackName);
  if (inventory === null) return null;

  const services: ServiceDigests[] = [];
  for (const resource of inventory.resources) {
    if (resource.type !== SERVICE_RESOURCE_TYPE || !resource.physicalId) continue;
    let digests: string[] | null;
    try {
      digests = await observeServiceDigest(deps, resource.physicalId);
    } catch {
      digests = null;
    }
    services.push({ serviceLogicalId: resource.logicalId, digests });
  }
  return services;
}

/**
 * The sha256 digest currently running for this installation's application,
 * or null when it cannot be resolved (no stack, no service, unreadable
 * inventory). Health reporting must continue even when this fails.
 *
 * Every ECS service counts, so a half-applied multi-service rollout never
 * reads as the new release: a service with no running task, a service whose
 * tasks could not be read, and two services (or two tasks) on different
 * digests all give null.
 */
export async function observeRunningImageDigest(
  deps: ObserveDigestDeps,
  stackName: string,
): Promise<string | null> {
  return singleDigest(await observeServiceDigests(deps, stackName));
}

/** The one digest every service runs; null when a service is empty or unread, or digests differ. */
export function singleDigest(services: readonly ServiceDigests[] | null): string | null {
  if (services === null || services.length === 0) return null;
  const digests = new Set<string>();
  for (const service of services) {
    if (service.digests === null || service.digests.length === 0) return null;
    for (const digest of service.digests) digests.add(digest);
  }
  return digests.size === 1 ? [...digests][0]! : null;
}

async function observeServiceDigest(deps: ObserveDigestDeps, serviceArn: string): Promise<string[] | null> {
  // arn:aws:ecs:REGION:ACCOUNT:service/CLUSTER/SERVICE
  const parts = serviceArn.split('/');
  const cluster = parts[1];
  if (!cluster) return null;

  const taskArns: string[] = [];
  let nextToken: string | undefined;
  do {
    const page = await deps.ecs.listTasks({ cluster, serviceName: parts[2]!, nextToken });
    taskArns.push(...page.taskArns);
    nextToken = page.nextToken;
  } while (nextToken);

  const digests = new Set<string>();
  const essentialByDefinition = new Map<string, ReadonlySet<string>>();
  for (let i = 0; i < taskArns.length; i += DESCRIBE_TASKS_BATCH) {
    const { tasks } = await deps.ecs.describeTasks({ cluster, tasks: taskArns.slice(i, i + DESCRIBE_TASKS_BATCH) });
    for (const task of tasks) {
      if (task.lastStatus !== 'RUNNING') continue;
      let essential: ReadonlySet<string> = new Set();
      if (task.taskDefinitionArn !== undefined) {
        const cached = essentialByDefinition.get(task.taskDefinitionArn);
        if (cached) {
          essential = cached;
        } else {
          const { taskDefinition } = await deps.ecs.describeTaskDefinition({
            taskDefinition: task.taskDefinitionArn,
          });
          essential = essentialContainerNames(taskDefinition.containerDefinitions);
          essentialByDefinition.set(task.taskDefinitionArn, essential);
        }
      }
      const digest = applicationContainers(task.containers, essential).find((c) =>
        c.imageDigest?.startsWith('sha256:'),
      )?.imageDigest;
      if (!digest) return null;
      digests.add(digest);
    }
  }
  return [...digests];
}
