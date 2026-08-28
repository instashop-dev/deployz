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
      containers?: { imageDigest?: string | undefined }[];
    }[];
  }>;
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
  for (const task of tasks) {
    const digest = task.containers?.find((c) => c.imageDigest?.startsWith('sha256:'))?.imageDigest;
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
