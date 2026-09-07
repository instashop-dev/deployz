/**
 * Runtime image-digest observation — what is ACTUALLY running in ECS, read
 * from the running tasks rather than from any control-plane pointer.
 *
 * Discovery path: CloudFormation stack resources → ECS service → running
 * tasks → container imageDigest. The task's imageDigest is the truth even
 * when the task definition references a mutable tag, because ECS resolves
 * the digest at pull time.
 */

import type { CloudFormationReader } from './verify.js';

/** The ECS surface this module needs (injectable seam for testing). */
export interface EcsTaskReader {
  listTasks(input: {
    cluster: string;
    serviceName: string;
  }): Promise<{ taskArns: string[] }>;
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

export interface ObserveDigestDeps {
  readonly cfn: CloudFormationReader;
  readonly ecs: EcsTaskReader;
  readonly installationId: string;
}

const SERVICE_RESOURCE_TYPE = 'AWS::ECS::Service';

/**
 * The sha256 digest currently running for this installation's application,
 * or null when it cannot be resolved (no stack, no service, no running
 * task). Health reporting must continue even when this fails.
 */
export async function observeRunningImageDigest(
  deps: ObserveDigestDeps,
  stackName: string,
): Promise<string | null> {
  const serviceArn = await findServiceArn(deps, stackName);
  if (!serviceArn) return null;

  // arn:aws:ecs:REGION:ACCOUNT:service/CLUSTER/SERVICE
  const parts = serviceArn.split('/');
  const cluster = parts[1];
  if (!cluster) return null;

  const { taskArns } = await deps.ecs.listTasks({ cluster, serviceName: parts[2]! });
  if (taskArns.length === 0) return null;

  const { tasks } = await deps.ecs.describeTasks({ cluster, tasks: taskArns });
  const essentialByDefinition = new Map<string, ReadonlySet<string>>();
  for (const task of tasks) {
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
    if (digest) return digest;
  }
  return null;
}

async function findServiceArn(deps: ObserveDigestDeps, stackName: string): Promise<string | null> {
  const resources = await deps.cfn.describeStackResources(stackName);
  return (
    resources.find((resource) => resource.type === SERVICE_RESOURCE_TYPE)?.physicalId ?? null
  );
}
