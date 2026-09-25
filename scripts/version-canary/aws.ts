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

/** The signatures a failed CLI invocation is retried for — a throttling,
 * network, or session-refresh race, never a real, operator-actionable
 * failure. `ExpiredToken` is deliberately absent: that is a real expiry the
 * operator must fix, not a race to wait out. */
const TRANSIENT_AWS_CLI_SIGNATURES = [
  'CreateOAuth2Token',
  'Throttling',
  'ThrottlingException',
  'RequestLimitExceeded',
  'TooManyRequestsException',
  'RequestExpired',
  'ServiceUnavailable',
  'InternalError',
  'ECONNRESET',
  'EAI_AGAIN',
  'getaddrinfo',
] as const;

/** True when a failed `aws` CLI invocation is worth retrying (see
 * `TRANSIENT_AWS_CLI_SIGNATURES`), false for a real failure the operator
 * must fix. */
export function isTransientAwsCliError(stderr: string): boolean {
  return TRANSIENT_AWS_CLI_SIGNATURES.some((signature) => stderr.includes(signature));
}

/** Backoff before each retry. A lost session refresh clears itself within
 * seconds (2026-09-17 22:33Z incident), but two lanes that poll at the same
 * time collided three times in a row twice on 2026-09-18, so the ladder
 * reaches past a minute. Tests inject an instant delay. */
const RETRY_DELAYS_MS = [2000, 5000, 10000, 20000, 40000];

export type AwsCliExecutor = (command: string, args: string[]) => Promise<{ stdout: string }>;

async function defaultAwsCliExecutor(command: string, args: string[]): Promise<{ stdout: string }> {
  return execFileAsync(command, args, {
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, AWS_PAGER: '' },
    windowsHide: true,
  });
}

export type DelayFn = (ms: number) => Promise<void>;

const defaultDelay: DelayFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function aws(
  args: string[],
  region?: string,
  exec: AwsCliExecutor = defaultAwsCliExecutor,
  delay: DelayFn = defaultDelay,
): Promise<unknown> {
  const full = ['--output', 'json', ...(region ? ['--region', region] : []), ...args];
  for (let attempt = 0; ; attempt++) {
    try {
      const { stdout } = await exec('aws', full);
      return stdout.trim().length > 0 ? JSON.parse(stdout) : null;
    } catch (error) {
      const stderr = (error as { stderr?: string }).stderr ?? '';
      if (attempt < RETRY_DELAYS_MS.length && isTransientAwsCliError(stderr)) {
        const signature = TRANSIENT_AWS_CLI_SIGNATURES.find((s) => stderr.includes(s));
        // Only the service and operation — later args can carry a secret
        // value (e.g. a parameter or payload), so the full command never
        // goes to a log line.
        process.stderr.write(
          `aws ${args.slice(0, 2).join(' ')}: transient error (${signature}), retrying (attempt ${attempt + 1}/${RETRY_DELAYS_MS.length})\n`,
        );
        await delay(RETRY_DELAYS_MS[attempt]!);
        continue;
      }
      throw new Error(`aws ${args.slice(0, 3).join(' ')} failed: ${stderr.trim() || String(error)}`);
    }
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

export interface StackFailureEvent {
  readonly logicalId: string;
  readonly resourceType: string;
  readonly status: string;
  readonly statusReason: string | null;
  readonly timestamp: string;
}

/**
 * The `*_FAILED` events CloudFormation recorded for `stackName` (e.g.
 * `CREATE_FAILED`, `UPDATE_FAILED`, `DELETE_FAILED`) — the same
 * `describe-stack-events` a vendor's CloudFormation diagnostics view reads
 * (apps/api/src/server.ts's `stack-events` route), filtered here to just the
 * failures a postmortem needs. Read-only; `[]` when the stack has none or is
 * already gone.
 */
export async function stackFailureEvents(region: string, stackName: string): Promise<StackFailureEvent[]> {
  try {
    const response = (await aws(
      ['cloudformation', 'describe-stack-events', '--stack-name', stackName],
      region,
    )) as {
      StackEvents: {
        LogicalResourceId: string;
        ResourceType: string;
        ResourceStatus: string;
        ResourceStatusReason?: string;
        Timestamp: string;
      }[];
    };
    return response.StackEvents.filter((e) => e.ResourceStatus.endsWith('_FAILED')).map((e) => ({
      logicalId: e.LogicalResourceId,
      resourceType: e.ResourceType,
      status: e.ResourceStatus,
      statusReason: e.ResourceStatusReason ?? null,
      timestamp: e.Timestamp,
    }));
  } catch (error) {
    if (isStackMissing(error)) return [];
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

/**
 * A deterministic CloudFormation client request token for `stackName`. Stack
 * names already fit CloudFormation's token pattern (`[a-zA-Z0-9][-a-zA-Z0-9]*`,
 * max 128 chars), but this sanitizes defensively rather than assuming it.
 * Passing the same token on a retried create-stack (aws()'s own retry, after
 * a lost response — ECONNRESET/getaddrinfo) makes CloudFormation dedupe the
 * request and hand back the StackId of the stack it already started, instead
 * of an AlreadyExistsException that would strand the real stack unrecorded.
 */
export function clientRequestTokenFor(stackName: string): string {
  const sanitized = stackName.replace(/[^a-zA-Z0-9-]/g, '-').replace(/^[^a-zA-Z0-9]+/, '');
  return (sanitized || 'canary').slice(0, 128);
}

/** Creates the bootstrap stack exactly as the customer's Quick Create would, plus canary tags. */
export async function createBootstrapStack(
  region: string,
  input: CreateStackInput,
  exec: AwsCliExecutor = defaultAwsCliExecutor,
  delay: DelayFn = defaultDelay,
): Promise<string> {
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
      '--client-request-token',
      clientRequestTokenFor(input.stackName),
    ],
    region,
    exec,
    delay,
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
    )) as {
      tasks: {
        lastStatus: string;
        taskDefinitionArn: string;
        containers: { imageDigest?: string; lastStatus?: string }[];
      }[];
    };
    for (const task of described.tasks) {
      if (task.lastStatus !== 'RUNNING') continue;
      runningTaskDefinitions.push(task.taskDefinitionArn);
      for (const container of task.containers) {
        // A finished init container (the RDS CA bundle, DEPLOY-007) stays in
        // the task as STOPPED; only the containers still running serve.
        if (container.imageDigest && (container.lastStatus ?? 'RUNNING') === 'RUNNING') {
          runningDigests.push(container.imageDigest);
        }
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
  readonly natGateways: string[];
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
    /** The region `deployz-images` lives in, when it differs from `region` (Stage B's install region). Defaults to `region`. */
    ecrRegion?: string;
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

  // Tag-based discovery (deterministic — see installationSecretsByTag): the
  // generated secret names never start with a stack name and the RGA index
  // misses Secrets Manager. The bootstrap-name prefix stays for connector
  // credential secrets that may be untagged or differently scoped.
  const taggedSecrets = await installationSecretsByTag(region, ids.installationId);
  const secretList = (await aws(['secretsmanager', 'list-secrets'], region)) as {
    SecretList: { Name: string }[];
  };
  const secrets = [
    ...new Set([
      ...taggedSecrets.map((s) => s.name),
      ...secretList.SecretList.filter((s) =>
        ids.bootstrapStackName ? s.Name.startsWith(ids.bootstrapStackName) : false,
      ).map((s) => s.Name),
    ]),
  ];

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
  const ecrRegion = ids.ecrRegion ?? region;
  for (const tag of ids.ecrTags) {
    if ((await ecrDigestForTag(ecrRegion, ids.ecrRepository, tag)) !== null) ecrTags.push(tag);
  }

  const taskDefinitions = installationTagged.filter((arn) => arn.includes(':task-definition/'));
  const natGateways = await liveNatGateways(
    region,
    installationTagged.filter((arn) => arn.includes(':natgateway/')),
  );

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
    natGateways,
  };
}

/**
 * The subset of NAT gateway ARNs the account still actually holds.
 *
 * The tagging API keeps listing a NAT gateway for a while after its stack
 * deleted it — the same lag it has for INACTIVE ECS resources. A deleted one
 * costs nothing and is not a leak; a live one costs about $32/month and is,
 * so this asks EC2 for the truth rather than trusting either the tag index
 * or a blanket exception (real AWS, 2026-09-10: nat-062a1224… was reported
 * as left behind and had in fact been deleted).
 */
export type NatGatewayStateReader = (region: string, id: string) => Promise<string | null>;

/** Asks EC2 for one NAT gateway's state; `null` when it no longer exists. */
async function readNatGatewayState(region: string, id: string): Promise<string | null> {
  try {
    const response = (await aws(['ec2', 'describe-nat-gateways', '--nat-gateway-ids', id], region)) as {
      NatGateways: { NatGatewayId: string; State: string }[];
    };
    return response.NatGateways[0]?.State ?? null;
  } catch (error) {
    if (/NatGatewayNotFound/.test(String(error))) return null;
    throw error;
  }
}

export async function liveNatGateways(
  region: string,
  arns: string[],
  read: NatGatewayStateReader = readNatGatewayState,
): Promise<string[]> {
  const live: string[] = [];
  for (const arn of arns) {
    const id = arn.split('/').pop();
    if (!id) continue;
    const state = await read(region, id);
    if (state !== null && state !== 'deleted' && state !== 'deleting') live.push(arn);
  }
  return live;
}

// ── Retained-state checks (Disconnect / Purge verification) ────────────────

export interface RetainedDbInstance {
  readonly identifier: string;
  readonly status: string;
  readonly deletionProtection: boolean;
}

/** The RDS instance tagged for this installation, `null` when none is left —
 * the same discovery the leak audit uses. */
export async function installationDbInstance(
  region: string,
  installationId: string | null,
): Promise<RetainedDbInstance | null> {
  if (!installationId) return null;
  const response = (await aws(['rds', 'describe-db-instances'], region)) as {
    DBInstances: {
      DBInstanceIdentifier: string;
      DBInstanceStatus: string;
      DeletionProtection?: boolean;
      TagList?: { Key: string; Value: string }[];
    }[];
  };
  const instance = response.DBInstances.find((db) =>
    (db.TagList ?? []).some((t) => t.Key === 'deployz:installation' && t.Value === installationId),
  );
  return instance
    ? {
        identifier: instance.DBInstanceIdentifier,
        status: instance.DBInstanceStatus,
        deletionProtection: instance.DeletionProtection ?? false,
      }
    : null;
}

/** Bucket names tagged for this installation, as the leak audit reads them. */
export async function installationBuckets(region: string, installationId: string | null): Promise<string[]> {
  if (!installationId) return [];
  const tagged = await resourcesTagged(region, 'deployz:installation', installationId);
  return tagged.filter((arn) => arn.startsWith('arn:aws:s3:::')).map((arn) => arn.replace('arn:aws:s3:::', ''));
}

/** Whether the bucket answers `head-bucket`; a 404 is a clean "gone". */
export async function bucketExists(bucket: string): Promise<boolean> {
  try {
    await aws(['s3api', 'head-bucket', '--bucket', bucket]);
    return true;
  } catch (error) {
    if (/\b404\b|NoSuchBucket/.test(String(error))) return false;
    throw error;
  }
}

export interface InstallationSecret {
  readonly name: string;
  readonly arn: string;
  /** Set when the secret sits in the recovery window (planned deletion). */
  readonly deletedDate: string | null;
  readonly tags: Record<string, string>;
}

/**
 * Every secret tagged `deployz:installation` for this installation, read
 * from `list-secrets --include-planned-deletion` so recovery-window secrets
 * stay visible.
 *
 * Tag-based on purpose, never the resource-group tag index and never a
 * stack-name prefix: CloudFormation generates the physical names
 * (logicalId-hash-random), so a prefix can never match them, and the tag
 * index has already been observed to miss Secrets Manager entirely (real
 * run profile-pg-20260918: both retained database secrets existed and
 * carried the tag; the RGA query returned nothing).
 */
export async function installationSecretsByTag(
  region: string,
  installationId: string | null,
): Promise<InstallationSecret[]> {
  if (!installationId) return [];
  const response = (await aws(['secretsmanager', 'list-secrets', '--include-planned-deletion'], region)) as {
    SecretList: { ARN: string; Name: string; DeletedDate?: number; Tags?: { Key: string; Value: string }[] }[];
  };
  return response.SecretList.filter((s) =>
    (s.Tags ?? []).some((t) => t.Key === 'deployz:installation' && t.Value === installationId),
  ).map((s) => ({
    name: s.Name,
    arn: s.ARN,
    deletedDate: s.DeletedDate ? new Date(s.DeletedDate * 1000).toISOString() : null,
    tags: Object.fromEntries((s.Tags ?? []).map((t) => [t.Key, t.Value])),
  }));
}

/**
 * The ElastiCache resources this installation still actually holds. The tag
 * index lags deletion the way it does for ECS resources, so the cache service
 * is asked for the truth; not-found and deleted/deleting both count as gone.
 * An empty list means the cache is gone.
 */
export async function liveInstallationCache(region: string, installationId: string | null): Promise<string[]> {
  if (!installationId) return [];
  const tagged = await resourcesTagged(region, 'deployz:installation', installationId);
  const live: string[] = [];
  for (const arn of tagged.filter((a) => a.includes(':replicationgroup:'))) {
    const id = arn.split(':').pop();
    if (!id) continue;
    try {
      const response = (await aws(
        ['elasticache', 'describe-replication-groups', '--replication-group-id', id],
        region,
      )) as { ReplicationGroups: { Status: string }[] };
      const status = response.ReplicationGroups[0]?.Status ?? 'unknown';
      if (status !== 'deleted' && status !== 'deleting') live.push(id);
    } catch (error) {
      if (!/ReplicationGroupNotFoundFault/.test(String(error))) throw error;
    }
  }
  for (const arn of tagged.filter((a) => a.includes(':cache:'))) {
    const id = arn.split(':').pop();
    if (!id) continue;
    try {
      const response = (await aws(['elasticache', 'describe-cache-clusters', '--cache-cluster-id', id], region)) as {
        CacheClusters: { CacheClusterStatus: string }[];
      };
      const status = response.CacheClusters[0]?.CacheClusterStatus ?? 'unknown';
      if (status !== 'deleted' && status !== 'deleting') live.push(id);
    } catch (error) {
      if (!/CacheClusterNotFoundFault/.test(String(error))) throw error;
    }
  }
  return live;
}

/**
 * The load balancers / target groups the stack's own resource list names that
 * ELB still actually holds. A deleted stack keeps listing its resources with
 * their physical ids, so this works after DeleteStack; not-found counts as
 * gone. An empty list means the stack's ELB footprint is gone.
 */
export async function liveStackElbResources(region: string, stackName: string): Promise<string[]> {
  const resources = await listStackResources(region, stackName);
  const live: string[] = [];
  for (const resource of resources) {
    if (!resource.physicalId) continue;
    if (resource.type === 'AWS::ElasticLoadBalancingV2::LoadBalancer') {
      try {
        const response = (await aws(
          ['elbv2', 'describe-load-balancers', '--load-balancer-arns', resource.physicalId],
          region,
        )) as { LoadBalancers: unknown[] };
        if (response.LoadBalancers.length > 0) live.push(resource.physicalId);
      } catch (error) {
        if (!/LoadBalancerNotFound/.test(String(error))) throw error;
      }
    } else if (resource.type === 'AWS::ElasticLoadBalancingV2::TargetGroup') {
      try {
        const response = (await aws(
          ['elbv2', 'describe-target-groups', '--target-group-arns', resource.physicalId],
          region,
        )) as { TargetGroups: unknown[] };
        if (response.TargetGroups.length > 0) live.push(resource.physicalId);
      } catch (error) {
        if (!/TargetGroupNotFound/.test(String(error))) throw error;
      }
    }
  }
  return live;
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
