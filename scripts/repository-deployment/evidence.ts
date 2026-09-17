/**
 * The extra customer-account reads Stage B needs beyond the version
 * canary's `aws.ts` — stopped ECS tasks (stop reasons, exit codes), a
 * sanitized tail of the application log group, and the presence of the
 * managed dependencies — plus the sanitizer every recorded text passes
 * through. Reads only; every deletion stays in the canary's id-keyed
 * helpers.
 */
import { aws, listStackResources, type AwsCliExecutor, type DelayFn } from '../version-canary/aws.js';

/** Masks credentials and long tokens; the result is what a result file may carry. */
export function sanitize(text: string): string {
  return text
    .replace(/(\/\/[^/\s:@]+:)[^@\s]+@/g, '$1***@')
    .replace(/((?:password|passwd|secret|token|api[_-]?key|authorization)\s*[=:]\s*)[^\s,;"']+/gi, '$1***')
    .replace(/\b(bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, '$1***')
    .replace(/\b[A-Za-z0-9+/_-]{40,}={0,2}\b/g, '***');
}

export interface StoppedTask {
  readonly taskArn: string;
  readonly stoppedReason: string | null;
  readonly stopCode: string | null;
  readonly stoppedAt: string | null;
  readonly containers: { name: string; exitCode: number | null; reason: string | null }[];
}

/** The most recent stopped tasks of the application stack's service (or cluster when the service is gone). */
export async function describeStoppedTasks(region: string, stackName: string, limit = 5): Promise<StoppedTask[]> {
  const resources = await listStackResources(region, stackName).catch(() => []);
  const cluster = resources.find((r) => r.type === 'AWS::ECS::Cluster')?.physicalId;
  if (!cluster) return [];
  const listed = (await aws(['ecs', 'list-tasks', '--cluster', cluster, '--desired-status', 'STOPPED', '--max-items', String(limit)], region)) as {
    taskArns?: string[];
  } | null;
  const arns = listed?.taskArns ?? [];
  if (arns.length === 0) return [];
  const described = (await aws(['ecs', 'describe-tasks', '--cluster', cluster, '--tasks', ...arns], region)) as {
    tasks: {
      taskArn: string;
      stoppedReason?: string;
      stopCode?: string;
      stoppedAt?: string;
      containers: { name: string; exitCode?: number; reason?: string }[];
    }[];
  };
  return described.tasks.map((task) => ({
    taskArn: task.taskArn,
    stoppedReason: task.stoppedReason ? sanitize(task.stoppedReason) : null,
    stopCode: task.stopCode ?? null,
    stoppedAt: task.stoppedAt ?? null,
    containers: task.containers.map((c) => ({
      name: c.name,
      exitCode: c.exitCode ?? null,
      reason: c.reason ? sanitize(c.reason) : null,
    })),
  }));
}

/** The last `lines` events of the stack's application log group, sanitized. */
export async function tailApplicationLogs(region: string, stackName: string, lines = 80): Promise<string[]> {
  const resources = await listStackResources(region, stackName).catch(() => []);
  const group = resources.find((r) => r.type === 'AWS::Logs::LogGroup')?.physicalId;
  if (!group) return [];
  const streams = (await aws(
    ['logs', 'describe-log-streams', '--log-group-name', group, '--order-by', 'LastEventTime', '--descending', '--max-items', '3'],
    region,
  ).catch(() => null)) as { logStreams?: { logStreamName: string }[] } | null;
  const names = (streams?.logStreams ?? []).map((s) => s.logStreamName);
  if (names.length === 0) return [];
  const events = (await aws(
    ['logs', 'filter-log-events', '--log-group-name', group, '--log-stream-names', ...names, '--limit', String(lines * 3)],
    region,
  ).catch(() => null)) as { events?: { timestamp: number; message: string }[] } | null;
  return (events?.events ?? [])
    .sort((a, b) => a.timestamp - b.timestamp)
    .slice(-lines)
    .map((e) => `${new Date(e.timestamp).toISOString()} ${sanitize(e.message.trimEnd())}`.slice(0, 400));
}

export interface DependencyPresence {
  readonly rds: string | null;
  readonly cache: string | null;
  readonly bucket: string | null;
}

/** Which managed dependencies the application stack actually holds. */
export async function describeDependencies(region: string, stackName: string): Promise<DependencyPresence> {
  const resources = await listStackResources(region, stackName).catch(() => []);
  const physical = (type: string) => resources.find((r) => r.type === type)?.physicalId ?? null;
  return {
    rds: physical('AWS::RDS::DBInstance'),
    cache: physical('AWS::ElastiCache::ReplicationGroup') ?? physical('AWS::ElastiCache::CacheCluster'),
    bucket: physical('AWS::S3::Bucket'),
  };
}

export interface TaskDefinitionEnv {
  readonly environment: string[];
  readonly secrets: string[];
  readonly command: string[] | null;
  readonly image: string | null;
}

/**
 * The application container of a task definition: the essential one (ECS
 * defaults `essential` to true; the RDS CA init container of DEPLOY-007
 * declares false and ECS lists it first). Position is not a rule.
 */
export function applicationContainerDefinition<T extends { essential?: boolean }>(containerDefinitions: readonly T[]): T | null {
  return containerDefinitions.find((container) => container.essential !== false) ?? containerDefinitions[0] ?? null;
}

/**
 * The exit that stopped a task: the application container's, read as the
 * first non-zero exit code (a finished init container exits 0 and may be
 * listed first), else the first exit code any container reports.
 */
export function stoppedExit(containers: readonly { exitCode: number | null; reason: string | null }[]): { exitCode: number | null; reason: string | null } {
  const container =
    containers.find((c) => c.exitCode !== null && c.exitCode !== 0) ?? containers.find((c) => c.exitCode !== null) ?? containers[0];
  return { exitCode: container?.exitCode ?? null, reason: container?.reason ?? null };
}

/** The env/secret NAMES (never values) bound on the service's current task definition. */
export async function describeTaskDefinitionEnv(region: string, stackName: string): Promise<TaskDefinitionEnv | null> {
  const resources = await listStackResources(region, stackName).catch(() => []);
  const serviceArn = resources.find((r) => r.type === 'AWS::ECS::Service')?.physicalId;
  if (!serviceArn) return null;
  const cluster = serviceArn.split('/')[1];
  if (!cluster) return null;
  const services = (await aws(['ecs', 'describe-services', '--cluster', cluster, '--services', serviceArn], region)) as {
    services: { taskDefinition: string }[];
  };
  const definitionArn = services.services[0]?.taskDefinition;
  if (!definitionArn) return null;
  const described = (await aws(['ecs', 'describe-task-definition', '--task-definition', definitionArn], region)) as {
    taskDefinition: {
      containerDefinitions: {
        image?: string;
        command?: string[];
        essential?: boolean;
        environment?: { name: string }[];
        secrets?: { name: string }[];
      }[];
    };
  };
  const container = applicationContainerDefinition(described.taskDefinition.containerDefinitions);
  if (!container) return null;
  return {
    environment: (container.environment ?? []).map((e) => e.name).sort(),
    secrets: (container.secrets ?? []).map((s) => s.name).sort(),
    command: container.command ?? null,
    image: container.image ?? null,
  };
}

export type ArnKind =
  | 'nat-gateway'
  | 'subnet'
  | 'security-group'
  | 'vpc'
  | 'network-interface'
  | 'internet-gateway'
  | 'route-table'
  | 'rds-subnet-group'
  | 'ecs-cluster'
  | 'ecs-task-definition'
  | 'ecs-service'
  | 'log-group'
  | 'acm-certificate'
  | 'secret';

/** Classifies an ARN by the service resource it names, or `null` when the leak audit's caller does not recognize it. */
export function arnKind(arn: string): ArnKind | null {
  if (/:natgateway\/nat-[0-9a-f]+$/.test(arn)) return 'nat-gateway';
  if (/:subnet\/subnet-[0-9a-f]+$/.test(arn)) return 'subnet';
  if (/:security-group\/sg-[0-9a-f]+$/.test(arn)) return 'security-group';
  if (/:vpc\/vpc-[0-9a-f]+$/.test(arn)) return 'vpc';
  if (/:network-interface\/eni-[0-9a-f]+$/.test(arn)) return 'network-interface';
  if (/:internet-gateway\/igw-[0-9a-f]+$/.test(arn)) return 'internet-gateway';
  if (/:route-table\/rtb-[0-9a-f]+$/.test(arn)) return 'route-table';
  if (/:rds:[^:]+:[^:]+:subgrp:/.test(arn)) return 'rds-subnet-group';
  if (/:ecs:[^:]+:[^:]+:cluster\//.test(arn)) return 'ecs-cluster';
  if (/:ecs:[^:]+:[^:]+:task-definition\//.test(arn)) return 'ecs-task-definition';
  if (/:ecs:[^:]+:[^:]+:service\//.test(arn)) return 'ecs-service';
  if (/:logs:[^:]+:[^:]+:log-group:/.test(arn)) return 'log-group';
  if (/:acm:[^:]+:[^:]+:certificate\//.test(arn)) return 'acm-certificate';
  if (/:secretsmanager:[^:]+:[^:]+:secret:/.test(arn)) return 'secret';
  return null;
}

/** The `describe-*` call and its "gone" error signature for the ARN kinds that report a missing resource as a CLI error. */
const NOT_FOUND: Partial<Record<ArnKind, { args: (id: string) => string[]; pattern: RegExp }>> = {
  subnet: { args: (id) => ['ec2', 'describe-subnets', '--subnet-ids', id], pattern: /InvalidSubnetID\.NotFound/ },
  'security-group': { args: (id) => ['ec2', 'describe-security-groups', '--group-ids', id], pattern: /InvalidGroup\.NotFound/ },
  vpc: { args: (id) => ['ec2', 'describe-vpcs', '--vpc-ids', id], pattern: /InvalidVpcID\.NotFound/ },
  'network-interface': {
    args: (id) => ['ec2', 'describe-network-interfaces', '--network-interface-ids', id],
    pattern: /InvalidNetworkInterfaceID\.NotFound/,
  },
  'internet-gateway': {
    args: (id) => ['ec2', 'describe-internet-gateways', '--internet-gateway-ids', id],
    pattern: /InvalidInternetGatewayID\.NotFound/,
  },
  'route-table': { args: (id) => ['ec2', 'describe-route-tables', '--route-table-ids', id], pattern: /InvalidRouteTableID\.NotFound/ },
  'rds-subnet-group': {
    args: (id) => ['rds', 'describe-db-subnet-groups', '--db-subnet-group-name', id],
    pattern: /DBSubnetGroupNotFoundFault/,
  },
  'acm-certificate': { args: (id) => ['acm', 'describe-certificate', '--certificate-arn', id], pattern: /ResourceNotFoundException/ },
  secret: { args: (id) => ['secretsmanager', 'describe-secret', '--secret-id', id], pattern: /ResourceNotFoundException/ },
};

/** The `subnet-…`/`sg-…`/… id (or, for kinds the CLI addresses by ARN, the ARN itself) `resourceStillExists` passes to the describe call. */
function idFor(kind: ArnKind, arn: string): string {
  if (kind === 'rds-subnet-group') return arn.split(':').pop() ?? arn;
  if (kind === 'acm-certificate' || kind === 'secret') return arn;
  return arn.split('/').pop() ?? arn;
}

/**
 * Whether a resource the tagging API still lists actually exists. The tagging
 * API keeps a deleted resource listed for a while after deletion (real AWS,
 * 2026-09-17 23:27Z: a purged subnet was reported as a leak while EC2 already
 * answered `InvalidSubnetID.NotFound`), so this confirms tagged EC2, RDS
 * subnet group, ECS, CloudWatch Logs, ACM, and Secrets Manager ARNs against
 * their owning service before calling them leaks. Unknown kinds are assumed
 * to exist, and so is any ARN a transient CLI error (throttling, auth) kept
 * this from confirming — a real leak must never be hidden by one.
 */
export async function resourceStillExists(region: string, arn: string, exec?: AwsCliExecutor, delay?: DelayFn): Promise<boolean> {
  const kind = arnKind(arn);
  if (kind === null) return true;
  const call = (args: string[]) => aws(args, region, exec, delay);

  try {
    if (kind === 'nat-gateway') {
      const id = idFor(kind, arn);
      const response = (await call(['ec2', 'describe-nat-gateways', '--nat-gateway-ids', id])) as { NatGateways?: { State?: string }[] };
      const state = response.NatGateways?.[0]?.State;
      return state !== undefined && state !== 'deleted';
    }
    if (kind === 'ecs-cluster') {
      const response = (await call(['ecs', 'describe-clusters', '--clusters', arn])) as { clusters?: { status?: string }[] };
      const status = response.clusters?.[0]?.status;
      return status !== undefined && status !== 'INACTIVE';
    }
    if (kind === 'ecs-task-definition') {
      const response = (await call(['ecs', 'describe-task-definition', '--task-definition', arn])) as { taskDefinition?: { status?: string } };
      const status = response.taskDefinition?.status;
      return status !== undefined && status !== 'INACTIVE' && status !== 'DELETE_IN_PROGRESS';
    }
    if (kind === 'ecs-service') {
      const cluster = arn.split('/')[1];
      if (!cluster) return true;
      const response = (await call(['ecs', 'describe-services', '--cluster', cluster, '--services', arn])) as {
        services?: { status?: string }[];
      };
      const status = response.services?.[0]?.status;
      return status !== undefined && status !== 'INACTIVE';
    }
    if (kind === 'log-group') {
      const name = arn.split(':log-group:')[1]?.replace(/:\*$/, '');
      if (!name) return true;
      const response = (await call(['logs', 'describe-log-groups', '--log-group-name-prefix', name])) as {
        logGroups?: { logGroupName: string }[];
      };
      return (response.logGroups ?? []).some((g) => g.logGroupName === name);
    }
    const check = NOT_FOUND[kind]!;
    await call(check.args(idFor(kind, arn)));
    return true;
  } catch (error) {
    if (kind === 'nat-gateway') {
      if (/NatGatewayNotFound/.test(String(error))) return false;
      throw error;
    }
    const check = NOT_FOUND[kind];
    if (check && check.pattern.test(String(error))) return false;
    process.stderr.write(`resourceStillExists: could not confirm ${arn} (${String(error).split('\n')[0]}), assuming present\n`);
    return true;
  }
}

/** Every resource carrying the given tag value — the Stage B account scan. */
export async function scanTag(region: string, key: string, value: string): Promise<string[]> {
  const response = (await aws(
    ['resourcegroupstaggingapi', 'get-resources', '--tag-filters', `Key=${key},Values=${value}`],
    region,
  )) as { ResourceTagMappingList: { ResourceARN: string }[] };
  return response.ResourceTagMappingList.map((r) => r.ResourceARN);
}
