/**
 * The extra customer-account reads Stage B needs beyond the version
 * canary's `aws.ts` — stopped ECS tasks (stop reasons, exit codes), a
 * sanitized tail of the application log group, and the presence of the
 * managed dependencies — plus the sanitizer every recorded text passes
 * through. Reads only; every deletion stays in the canary's id-keyed
 * helpers.
 */
import { aws, listStackResources } from '../version-canary/aws.js';

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
        environment?: { name: string }[];
        secrets?: { name: string }[];
      }[];
    };
  };
  const container = described.taskDefinition.containerDefinitions[0];
  if (!container) return null;
  return {
    environment: (container.environment ?? []).map((e) => e.name).sort(),
    secrets: (container.secrets ?? []).map((s) => s.name).sort(),
    command: container.command ?? null,
    image: container.image ?? null,
  };
}

/** Every resource carrying the given tag value — the Stage B account scan. */
export async function scanTag(region: string, key: string, value: string): Promise<string[]> {
  const response = (await aws(
    ['resourcegroupstaggingapi', 'get-resources', '--tag-filters', `Key=${key},Values=${value}`],
    region,
  )) as { ResourceTagMappingList: { ResourceARN: string }[] };
  return response.ResourceTagMappingList.map((r) => r.ResourceARN);
}
