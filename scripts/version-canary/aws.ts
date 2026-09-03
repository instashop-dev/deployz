/**
 * The canary's own view of the customer AWS account — independent of what
 * the control plane claims. Everything goes through the `aws` CLI (already
 * required by the other live suites) so no new SDK dependency is added.
 *
 * Reads are unrestricted. Every deletion takes an identifier the run
 * captured at creation time (a stack name the control plane minted, an
 * installation id from a stack output, a Lambda name from a stack's own
 * resource list, an ECR tag the run named) — never a name pattern, never
 * "everything tagged canary" across the account.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { CANARY_TAGS, canaryTags } from './config.js';

const execFileAsync = promisify(execFile);

export async function aws(args: string[], region?: string): Promise<unknown> {
  const full = ['--output', 'json', ...(region ? ['--region', region] : []), ...args];
  try {
    const { stdout } = await execFileAsync('aws', full, {
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, AWS_PAGER: '' },
      windowsHide: true,
    });
    return stdout.trim().length > 0 ? JSON.parse(stdout) : null;
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr ?? '';
    throw new Error(`aws ${args.slice(0, 3).join(' ')} failed: ${stderr.trim() || String(error)}`);
  }
}

/** True when the failure is CloudFormation's "does not exist" ValidationError. */
function isStackMissing(error: unknown): boolean {
  return /does not exist/i.test(String(error));
}

// ── Identity ──────────────────────────────────────────────────────────────

export async function callerIdentity(): Promise<{ account: string; arn: string }> {
  const identity = (await aws(['sts', 'get-caller-identity'])) as { Account: string; Arn: string };
  return { account: identity.Account, arn: identity.Arn };
}

// ── CloudFormation ────────────────────────────────────────────────────────

export interface StackSummary {
  readonly name: string;
  readonly status: string;
  readonly statusReason: string | null;
  readonly outputs: Record<string, string>;
  readonly tags: Record<string, string>;
}

export async function describeStack(region: string, stackName: string): Promise<StackSummary | null> {
  try {
    const response = (await aws(['cloudformation', 'describe-stacks', '--stack-name', stackName], region)) as {
      Stacks: {
        StackName: string;
        StackStatus: string;
        StackStatusReason?: string;
        Outputs?: { OutputKey: string; OutputValue: string }[];
        Tags?: { Key: string; Value: string }[];
      }[];
    };
    const stack = response.Stacks[0];
    if (!stack) return null;
    return {
      name: stack.StackName,
      status: stack.StackStatus,
      statusReason: stack.StackStatusReason ?? null,
      outputs: Object.fromEntries((stack.Outputs ?? []).map((o) => [o.OutputKey, o.OutputValue])),
      tags: Object.fromEntries((stack.Tags ?? []).map((t) => [t.Key, t.Value])),
    };
  } catch (error) {
    if (isStackMissing(error)) return null;
    throw error;
  }
}

export interface StackResource {
  readonly logicalId: string;
  readonly physicalId: string | null;
  readonly type: string;
  readonly status: string;
}

export async function listStackResources(region: string, stackName: string): Promise<StackResource[]> {
  const response = (await aws(
    ['cloudformation', 'list-stack-resources', '--stack-name', stackName],
    region,
  )) as {
    StackResourceSummaries: {
      LogicalResourceId: string;
      PhysicalResourceId?: string;
      ResourceType: string;
      ResourceStatus: string;
    }[];
  };
  return response.StackResourceSummaries.map((r) => ({
    logicalId: r.LogicalResourceId,
    physicalId: r.PhysicalResourceId ?? null,
    type: r.ResourceType,
    status: r.ResourceStatus,
  }));
}

export interface CreateStackInput {
  readonly stackName: string;
  readonly templateUrl: string;
  readonly parameters: Record<string, string>;
  readonly runId: string;
}

/** Creates the bootstrap stack exactly as the customer's Quick Create would, plus canary tags. */
export async function createBootstrapStack(region: string, input: CreateStackInput): Promise<string> {
  const tags = canaryTags(input.runId);
  const response = (await aws(
    [
      'cloudformation',
      'create-stack',
      '--stack-name',
      input.stackName,
      '--template-url',
      input.templateUrl,
      '--capabilities',
      'CAPABILITY_IAM',
      'CAPABILITY_NAMED_IAM',
      'CAPABILITY_AUTO_EXPAND',
      '--parameters',
      ...Object.entries(input.parameters).map(([key, value]) => `ParameterKey=${key},ParameterValue=${value}`),
      '--tags',
      ...Object.entries(tags).map(([key, value]) => `Key=${key},Value=${value}`),
    ],
    region,
  )) as { StackId: string };
  return response.StackId;
}

export async function deleteStack(region: string, stackName: string): Promise<void> {
  await aws(['cloudformation', 'delete-stack', '--stack-name', stackName], region);
}

/** Stacks whose name starts with `prefix`, any status except DELETE_COMPLETE. */
export async function listStacksByPrefix(region: string, prefix: string): Promise<{ name: string; status: string }[]> {
  const response = (await aws(['cloudformation', 'list-stacks'], region)) as {
    StackSummaries: { StackName: string; StackStatus: string }[];
  };
  return response.StackSummaries.filter(
    (s) => s.StackName.startsWith(prefix) && s.StackStatus !== 'DELETE_COMPLETE',
  ).map((s) => ({ name: s.StackName, status: s.StackStatus }));
}

// ── ECS / ELB ─────────────────────────────────────────────────────────────

export interface RunningService {
  readonly serviceArn: string;
  readonly cluster: string;
  readonly taskDefinition: string;
  readonly desiredCount: number;
  readonly runningCount: number;
  readonly deployments: { status: string; rolloutState: string | null; taskDefinition: string }[];
  readonly runningDigests: string[];
  readonly runningTaskDefinitions: string[];
}

export async function describeRunningService(region: string, stackName: string): Promise<RunningService | null> {
  const resources = await listStackResources(region, stackName);
  const serviceArn = resources.find((r) => r.type === 'AWS::ECS::Service')?.physicalId;
  if (!serviceArn) return null;
  const cluster = serviceArn.split('/')[1];
  if (!cluster) return null;
  const services = (await aws(
    ['ecs', 'describe-services', '--cluster', cluster, '--services', serviceArn],
    region,
  )) as {
    services: {
      taskDefinition: string;
      desiredCount: number;
      runningCount: number;
      deployments: { status: string; rolloutState?: string; taskDefinition: string }[];
    }[];
  };
  const service = services.services[0];
  if (!service) return null;
  const tasks = (await aws(['ecs', 'list-tasks', '--cluster', cluster, '--service-name', serviceArn], region)) as {
    taskArns: string[];
  };
  const runningDigests: string[] = [];
  const runningTaskDefinitions: string[] = [];
  if (tasks.taskArns.length > 0) {
    const described = (await aws(
      ['ecs', 'describe-tasks', '--cluster', cluster, '--tasks', ...tasks.taskArns],
      region,
    )) as { tasks: { lastStatus: string; taskDefinitionArn: string; containers: { imageDigest?: string }[] }[] };
    for (const task of described.tasks) {
      if (task.lastStatus !== 'RUNNING') continue;
      runningTaskDefinitions.push(task.taskDefinitionArn);
      for (const container of task.containers) {
        if (container.imageDigest) runningDigests.push(container.imageDigest);
      }
    }
  }
  return {
    serviceArn,
    cluster,
    taskDefinition: service.taskDefinition,
    desiredCount: service.desiredCount,
    runningCount: service.runningCount,
    deployments: service.deployments.map((d) => ({
      status: d.status,
      rolloutState: d.rolloutState ?? null,
      taskDefinition: d.taskDefinition,
    })),
    runningDigests: [...new Set(runningDigests)],
    runningTaskDefinitions: [...new Set(runningTaskDefinitions)],
  };
}

export async function albDnsName(region: string, stackName: string): Promise<string | null> {
  const resources = await listStackResources(region, stackName);
  const arn = resources.find((r) => r.type === 'AWS::ElasticLoadBalancingV2::LoadBalancer')?.physicalId;
  if (!arn) return null;
  const response = (await aws(['elbv2', 'describe-load-balancers', '--load-balancer-arns', arn], region)) as {
    LoadBalancers: { DNSName: string }[];
  };
  return response.LoadBalancers[0]?.DNSName ?? null;
}

export async function targetHealth(region: string, stackName: string): Promise<string[]> {
  const resources = await listStackResources(region, stackName);
  const arn = resources.find((r) => r.type === 'AWS::ElasticLoadBalancingV2::TargetGroup')?.physicalId;
  if (!arn) return [];
  const response = (await aws(['elbv2', 'describe-target-health', '--target-group-arn', arn], region)) as {
    TargetHealthDescriptions: { TargetHealth: { State: string } }[];
  };
  return response.TargetHealthDescriptions.map((t) => t.TargetHealth.State);
}

// ── ECR ───────────────────────────────────────────────────────────────────

export async function ecrDigestForTag(region: string, repository: string, tag: string): Promise<string | null> {
  try {
    const response = (await aws(
      ['ecr', 'describe-images', '--repository-name', repository, '--image-ids', `imageTag=${tag}`],
      region,
    )) as { imageDetails: { imageDigest: string }[] };
    return response.imageDetails[0]?.imageDigest ?? null;
  } catch (error) {
    if (/ImageNotFoundException/.test(String(error))) return null;
    throw error;
  }
}

export async function deleteEcrTags(region: string, repository: string, tags: string[]): Promise<string[]> {
  if (tags.length === 0) return [];
  const response = (await aws(
    [
      'ecr',
      'batch-delete-image',
      '--repository-name',
      repository,
      '--image-ids',
      ...tags.map((tag) => `imageTag=${tag}`),
    ],
    region,
  )) as { imageIds?: { imageTag?: string }[] };
  return (response.imageIds ?? []).flatMap((i) => (i.imageTag ? [i.imageTag] : []));
}

// ── Tag-based inventory (audit) ───────────────────────────────────────────

export async function resourcesTagged(region: string, key: string, value: string): Promise<string[]> {
  const response = (await aws(
    ['resourcegroupstaggingapi', 'get-resources', '--tag-filters', `Key=${key},Values=${value}`],
    region,
  )) as { ResourceTagMappingList: { ResourceARN: string }[] };
  return response.ResourceTagMappingList.map((r) => r.ResourceARN);
}

export interface LeakAudit {
  readonly installationTagged: string[];
  readonly runTagged: string[];
  readonly stacks: { name: string; status: string }[];
  readonly rdsInstances: string[];
  readonly loadBalancers: string[];
  readonly ecsClusters: string[];
  readonly buckets: string[];
  readonly secrets: string[];
  readonly logGroups: string[];
  readonly ssmParameters: string[];
  readonly certificates: string[];
  readonly ecrTags: string[];
  readonly taskDefinitions: string[];
}

/**
 * What the account still holds that can be attributed to this run. ECS
 * clusters/task definitions that the tagging API keeps listing as INACTIVE
 * after deletion are filtered by the caller (they cost nothing and are
 * documented behaviour).
 */
export async function auditLeaks(
  region: string,
  ids: {
    installationId: string | null;
    runId: string;
    bootstrapStackName: string | null;
    applicationStackName: string | null;
    bootstrapLambdaNames: string[];
    deploymentId: string | null;
    ecrRepository: string;
    ecrTags: string[];
  },
): Promise<LeakAudit> {
  const installationTagged = ids.installationId
    ? await resourcesTagged(region, 'deployz:installation', ids.installationId)
    : [];
  const runTagged = await resourcesTagged(region, CANARY_TAGS.run, ids.runId);

  const stacks = [
    ...(ids.bootstrapStackName ? await listStacksByPrefix(region, ids.bootstrapStackName) : []),
    ...(ids.applicationStackName ? await listStacksByPrefix(region, ids.applicationStackName) : []),
  ];

  const rds = (await aws(['rds', 'describe-db-instances'], region)) as {
    DBInstances: { DBInstanceIdentifier: string; DBInstanceArn: string; TagList?: { Key: string; Value: string }[] }[];
  };
  const rdsInstances = rds.DBInstances.filter((db) =>
    (db.TagList ?? []).some((t) => t.Key === 'deployz:installation' && t.Value === ids.installationId),
  ).map((db) => db.DBInstanceIdentifier);

  const albs = (await aws(['elbv2', 'describe-load-balancers'], region)) as {
    LoadBalancers: { LoadBalancerArn: string; LoadBalancerName: string }[];
  };
  const loadBalancers = albs.LoadBalancers.filter((lb) => installationTagged.includes(lb.LoadBalancerArn)).map(
    (lb) => lb.LoadBalancerName,
  );

  const clusters = (await aws(['ecs', 'list-clusters'], region)) as { clusterArns: string[] };
  const ecsClusters = clusters.clusterArns.filter((arn) => installationTagged.includes(arn));

  const bucketArns = installationTagged.filter((arn) => arn.startsWith('arn:aws:s3:::'));
  const buckets = bucketArns.map((arn) => arn.replace('arn:aws:s3:::', ''));

  const secretList = (await aws(['secretsmanager', 'list-secrets'], region)) as {
    SecretList: { ARN: string; Name: string }[];
  };
  const secrets = secretList.SecretList.filter(
    (s) =>
      installationTagged.includes(s.ARN) ||
      (ids.bootstrapStackName ? s.Name.startsWith(ids.bootstrapStackName) : false) ||
      (ids.applicationStackName ? s.Name.startsWith(ids.applicationStackName) : false),
  ).map((s) => s.Name);

  const logGroups: string[] = [];
  for (const prefix of [
    ...ids.bootstrapLambdaNames.map((name) => `/aws/lambda/${name}`),
    ...(ids.applicationStackName ? [`/deployz/${ids.applicationStackName}`, `${ids.applicationStackName}`] : []),
  ]) {
    const groups = (await aws(['logs', 'describe-log-groups', '--log-group-name-prefix', prefix], region)) as {
      logGroups: { logGroupName: string }[];
    };
    logGroups.push(...groups.logGroups.map((g) => g.logGroupName));
  }
  const appLogGroups = installationTagged.filter((arn) => arn.includes(':logs:')).map((arn) => arn.split(':log-group:')[1] ?? arn);
  logGroups.push(...appLogGroups);

  const ssmParameters: string[] = [];
  if (ids.installationId) {
    const params = (await aws(
      ['ssm', 'describe-parameters', '--parameter-filters', `Key=Name,Option=BeginsWith,Values=/deployz/${ids.installationId}`],
      region,
    )) as { Parameters: { Name: string }[] };
    ssmParameters.push(...params.Parameters.map((p) => p.Name));
  }

  const certs = (await aws(['acm', 'list-certificates'], region)) as {
    CertificateSummaryList: { CertificateArn: string; DomainName: string }[];
  };
  const certificates = certs.CertificateSummaryList.filter(
    (c) => ids.deploymentId !== null && c.DomainName.includes(ids.deploymentId),
  ).map((c) => `${c.DomainName} ${c.CertificateArn}`);

  const ecrTags: string[] = [];
  for (const tag of ids.ecrTags) {
    if ((await ecrDigestForTag(region, ids.ecrRepository, tag)) !== null) ecrTags.push(tag);
  }

  const taskDefinitions = installationTagged.filter((arn) => arn.includes(':task-definition/'));

  return {
    installationTagged,
    runTagged,
    stacks,
    rdsInstances,
    loadBalancers,
    ecsClusters,
    buckets,
    secrets,
    logGroups: [...new Set(logGroups)],
    ssmParameters,
    certificates,
    ecrTags,
    taskDefinitions,
  };
}

// ── Canary-scoped cleanup helpers (ids only) ──────────────────────────────

export async function deleteLogGroupIfExists(region: string, name: string): Promise<boolean> {
  try {
    await aws(['logs', 'delete-log-group', '--log-group-name', name], region);
    return true;
  } catch (error) {
    if (/ResourceNotFoundException/.test(String(error))) return false;
    throw error;
  }
}

export async function deleteSsmParameterIfExists(region: string, name: string): Promise<boolean> {
  try {
    await aws(['ssm', 'delete-parameter', '--name', name], region);
    return true;
  } catch (error) {
    if (/ParameterNotFound/.test(String(error))) return false;
    throw error;
  }
}

export async function deleteTaskDefinitions(region: string, arns: string[]): Promise<void> {
  for (const arn of arns) {
    try {
      await aws(['ecs', 'deregister-task-definition', '--task-definition', arn], region);
    } catch {
      // Already INACTIVE — fine, delete below still applies.
    }
  }
  for (let offset = 0; offset < arns.length; offset += 10) {
    await aws(['ecs', 'delete-task-definitions', '--task-definitions', ...arns.slice(offset, offset + 10)], region);
  }
}

export async function disableRulesForStack(region: string, bootstrapStackName: string): Promise<string[]> {
  const rules = (await aws(['events', 'list-rules', '--name-prefix', bootstrapStackName], region)) as {
    Rules: { Name: string }[];
  };
  const disabled: string[] = [];
  for (const rule of rules.Rules) {
    await aws(['events', 'disable-rule', '--name', rule.Name], region);
    disabled.push(rule.Name);
  }
  return disabled;
}

export async function enableRulesForStack(region: string, bootstrapStackName: string): Promise<string[]> {
  const rules = (await aws(['events', 'list-rules', '--name-prefix', bootstrapStackName], region)) as {
    Rules: { Name: string }[];
  };
  const enabled: string[] = [];
  for (const rule of rules.Rules) {
    await aws(['events', 'enable-rule', '--name', rule.Name], region);
    enabled.push(rule.Name);
  }
  return enabled;
}

/** Invokes the relay Lambda once, out of schedule — an extra poll tick. */
export async function invokeRelay(region: string, functionName: string): Promise<number> {
  const response = (await aws(
    [
      'lambda',
      'invoke',
      '--function-name',
      functionName,
      '--invocation-type',
      'RequestResponse',
      '--payload',
      '{}',
      '--cli-binary-format',
      'raw-in-base64-out',
      process.platform === 'win32' ? 'NUL' : '/dev/null',
    ],
    region,
  )) as { StatusCode: number };
  return response.StatusCode;
}

export async function deleteS3Prefix(bucket: string, prefix: string): Promise<string[]> {
  const listed = (await aws(['s3api', 'list-objects-v2', '--bucket', bucket, '--prefix', prefix])) as {
    Contents?: { Key: string }[];
  } | null;
  const keys = (listed?.Contents ?? []).map((o) => o.Key);
  for (const key of keys) {
    await aws(['s3api', 'delete-object', '--bucket', bucket, '--key', key]);
  }
  return keys;
}

export async function templateBucketName(region: string, controlPlaneStack = 'Deployz'): Promise<string> {
  const exports = (await aws(['cloudformation', 'list-exports'], region)) as {
    Exports: { Name: string; Value: string }[];
  };
  const match = exports.Exports.find((e) => e.Name === `${controlPlaneStack}-TemplateBucket`);
  if (!match) throw new Error(`Export ${controlPlaneStack}-TemplateBucket not found`);
  return match.Value;
}

export async function lambdaFunctionNames(region: string, stackName: string): Promise<string[]> {
  const resources = await listStackResources(region, stackName);
  return resources.flatMap((r) => (r.type === 'AWS::Lambda::Function' && r.physicalId ? [r.physicalId] : []));
}
