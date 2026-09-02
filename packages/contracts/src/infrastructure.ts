import { z } from 'zod';

// Infrastructure resource inventory — the canonical classification of every
// resource CloudFormation creates for an installation, and the wire shape the
// API serves it back in.
//
// The relay transports the RAW `StackResource` list it read with
// ListStackResources; classification happens once, at persistence time, from
// the CloudFormation resource TYPE (AWS-controlled and stable) with LOGICAL
// ID hints only where a type is shared by several products (SecurityGroups,
// Secrets). The DB stays the parity source for the enum values below
// (packages/db/src/enums.ts).

export const infrastructureComponentKindSchema = z.enum([
  'application',
  'database',
  'storage',
  'cache',
  'endpoint',
  'network',
  'monitoring',
  'container_registry',
  'other',
]);
export type InfrastructureComponentKind = z.infer<typeof infrastructureComponentKindSchema>;

export const infrastructureComponentStatusSchema = z.enum([
  'pending',
  'provisioning',
  'ready',
  'updating',
  'deleting',
  'failed',
  'retained',
  'removed',
  'unknown',
]);
export type InfrastructureComponentStatus = z.infer<typeof infrastructureComponentStatusSchema>;

export const infrastructureLifecycleSchema = z.enum(['delete', 'retain', 'snapshot', 'conditional']);
export type InfrastructureLifecycle = z.infer<typeof infrastructureLifecycleSchema>;

export const infrastructureResourceRoleSchema = z.enum(['primary', 'supporting']);
export type InfrastructureResourceRole = z.infer<typeof infrastructureResourceRoleSchema>;

/**
 * One persisted inventory row, in wire form (timestamptz as ISO datetime
 * strings). Mirrors the `deployment_resources` table exactly.
 */
export const infrastructureComponentSchema = z
  .object({
    deploymentId: z.uuid(),
    stackId: z.string(),
    logicalResourceId: z.string(),
    physicalResourceId: z.string().nullable(),
    resourceType: z.string(),
    resourceStatus: z.string(),
    resourceStatusReason: z.string().nullable(),
    componentKind: infrastructureComponentKindSchema,
    resourceRole: infrastructureResourceRoleSchema,
    lifecyclePolicy: infrastructureLifecycleSchema,
    lastUpdatedAt: z.iso.datetime(),
    firstSeenAt: z.iso.datetime(),
  })
  .strict();
export type InfrastructureComponent = z.infer<typeof infrastructureComponentSchema>;

export interface ResourceClassification {
  readonly componentKind: InfrastructureComponentKind;
  readonly role: InfrastructureResourceRole;
  readonly lifecycle: InfrastructureLifecycle;
}

function component(
  componentKind: InfrastructureComponentKind,
  role: InfrastructureResourceRole,
  lifecycle: InfrastructureLifecycle,
): ResourceClassification {
  return { componentKind, role, lifecycle };
}

// Case-sensitive on purpose: CDK logical ids are PascalCase, so 'Db' below
// cannot be the lowercase 'db' run that happens to sit inside 'LoadBalancer'.
const DATABASE_HINT = /Db|Rds|Database/;

function securityGroupClassification(logicalId: string): ResourceClassification {
  if (DATABASE_HINT.test(logicalId)) return component('database', 'supporting', 'delete');
  if (/Redis|Cache/.test(logicalId)) return component('cache', 'supporting', 'delete');
  if (/Alb|LoadBalancer|Listener/.test(logicalId)) return component('endpoint', 'supporting', 'delete');
  return component('network', 'supporting', 'delete');
}

// The seed grants for the application stack's database secret carry no
// DATABASE_HINT, so they classify as 'other'. DB-scoped secrets (DatabaseSecret,
// DatabaseUrlSecret) are RETAINED alongside the retained DB instance (Phase 9
// lifecycle — their DeletionPolicy is Retain so a disconnect never strands a
// retained database without its password), so they classify 'retain'. The
// SecretTargetAttachment row is not a real secret — CloudFormation deletes it
// with the stack — so it stays 'delete'. Everything else (AppConfigSecret)
// still has DeletionPolicy Delete.
function secretClassification(logicalId: string): ResourceClassification {
  if (/SecretTargetAttachment/.test(logicalId)) {
    return component('database', 'supporting', 'delete');
  }
  return DATABASE_HINT.test(logicalId)
    ? component('database', 'supporting', 'retain')
    : component('other', 'supporting', 'delete');
}

const NETWORK_TYPES = [
  'AWS::EC2::VPC',
  'AWS::EC2::Subnet',
  'AWS::EC2::RouteTable',
  'AWS::EC2::InternetGateway',
  'AWS::EC2::NatGateway',
  'AWS::EC2::NetworkAcl',
  'AWS::EC2::Route',
  'AWS::EC2::EIP',
] as const;

/**
 * Classify a CloudFormation resource by TYPE, with LOGICAL ID hints only for
 * multi-purpose types (SecurityGroup, Secret). First matching prefix wins;
 * every unlisted type falls back to `other/supporting/conditional`.
 */
export function classifyResource(type: string, logicalId: string): ResourceClassification {
  if (type === 'AWS::ECS::Service') return component('application', 'primary', 'delete');
  if (type.startsWith('AWS::ECS::')) return component('application', 'supporting', 'delete');
  if (type === 'AWS::ElasticLoadBalancingV2::LoadBalancer')
    return component('endpoint', 'primary', 'delete');
  if (type.startsWith('AWS::ElasticLoadBalancingV2::'))
    return component('endpoint', 'supporting', 'delete');
  if (type.startsWith('AWS::CertificateManager::'))
    return component('endpoint', 'supporting', 'conditional');
  if (type === 'AWS::RDS::DBInstance') return component('database', 'primary', 'retain');
  if (type === 'AWS::RDS::DBSubnetGroup') return component('database', 'supporting', 'retain');
  if (type.startsWith('AWS::RDS::')) return component('database', 'supporting', 'retain');
  if (type.startsWith('AWS::SecretsManager::')) return secretClassification(logicalId);
  if (type === 'AWS::S3::Bucket') return component('storage', 'primary', 'retain');
  if (type === 'AWS::S3::BucketPolicy') return component('storage', 'supporting', 'retain');
  if (type === 'AWS::ElastiCache::ReplicationGroup' || type === 'AWS::ElastiCache::CacheCluster')
    return component('cache', 'primary', 'delete');
  if (type === 'AWS::ElastiCache::SubnetGroup' || type === 'AWS::ElastiCache::CacheSubnetGroup')
    return component('cache', 'supporting', 'delete');
  for (const networkType of NETWORK_TYPES) {
    if (type.startsWith(networkType)) return component('network', 'supporting', 'delete');
  }
  if (type === 'AWS::EC2::SecurityGroup') return securityGroupClassification(logicalId);
  if (type.startsWith('AWS::Logs::')) return component('monitoring', 'supporting', 'delete');
  if (type === 'AWS::CloudWatch::Alarm') return component('monitoring', 'supporting', 'delete');
  if (type === 'AWS::ECR::Repository') return component('container_registry', 'primary', 'retain');
  if (type.startsWith('AWS::IAM::')) return component('application', 'supporting', 'delete');
  return component('other', 'supporting', 'conditional');
}

const STATUS_MAP: Readonly<Record<string, InfrastructureComponentStatus>> = {
  CREATE_IN_PROGRESS: 'provisioning',
  CREATE_COMPLETE: 'ready',
  UPDATE_IN_PROGRESS: 'updating',
  UPDATE_COMPLETE: 'ready',
  DELETE_IN_PROGRESS: 'deleting',
  DELETE_SKIPPED: 'retained',
  DELETE_COMPLETE: 'removed',
  CREATE_FAILED: 'failed',
  UPDATE_FAILED: 'failed',
  DELETE_FAILED: 'failed',
  ROLLBACK_FAILED: 'failed',
  UPDATE_ROLLBACK_FAILED: 'failed',
  ROLLBACK_COMPLETE: 'failed',
};

/** Map a CloudFormation resource status to the product vocabulary. Unknown
 *  statuses map to 'unknown' — never to a healthy-looking value. */
export function mapResourceStatus(awsStatus: string): InfrastructureComponentStatus {
  return STATUS_MAP[awsStatus] ?? 'unknown';
}

// ---------------------------------------------------------------------------
// Composed component view (GET /api/deployments/:id/infrastructure)
// ---------------------------------------------------------------------------

/** Human-readable component name and purpose. The only source the API and UI
 *  render names from — a kind never invents prose at a call site. */
export const INFRASTRUCTURE_COMPONENT_DISPLAY: Readonly<
  Record<InfrastructureComponentKind, { readonly name: string; readonly purpose: string }>
> = {
  application: { name: 'Application', purpose: 'Runs your application' },
  database: { name: 'Database', purpose: 'Stores persistent application data' },
  storage: { name: 'Storage', purpose: 'Stores uploaded files' },
  cache: { name: 'Cache', purpose: 'Speeds up application requests' },
  endpoint: { name: 'Secure endpoint', purpose: 'Provides HTTPS access' },
  network: { name: 'Network', purpose: 'Isolates application infrastructure' },
  monitoring: { name: 'Monitoring', purpose: 'Collects logs and health information' },
  container_registry: { name: 'Container registry', purpose: 'Stores application images' },
  other: { name: 'Other', purpose: 'Supporting infrastructure' },
};

/** One persisted inventory row as the aggregation consumes it. Structural
 *  superset of what the deployment_resources table returns — the API feeds
 *  drizzle rows through directly. */
export interface InfrastructureResourceRow {
  readonly componentKind: InfrastructureComponentKind;
  readonly resourceRole: InfrastructureResourceRole;
  readonly lifecyclePolicy: InfrastructureLifecycle;
  /** The MAPPED Deployz status (mapResourceStatus), never raw AWS wording. */
  readonly resourceStatus: InfrastructureComponentStatus;
  /** The raw AWS status verbatim (CREATE_COMPLETE, …) — null for rows written
   *  before the column existed. */
  readonly rawResourceStatus: string | null;
  readonly resourceType: string;
  readonly logicalResourceId: string;
  readonly physicalResourceId: string | null;
  readonly resourceStatusReason: string | null;
  readonly lastUpdatedAt: Date;
}

export interface InfrastructureTechnicalResource {
  readonly logicalId: string;
  readonly physicalId: string | null;
  readonly type: string;
  readonly status: string;
  readonly statusReason: string | null;
}

export interface InfrastructureComponentSummary {
  readonly kind: InfrastructureComponentKind;
  readonly name: string;
  readonly purpose: string;
  readonly status: InfrastructureComponentStatus;
  readonly awsService: string;
  readonly region: string;
  readonly lifecycle: InfrastructureLifecycle;
  readonly resources: readonly InfrastructureTechnicalResource[];
}

export interface AggregateInfrastructureOptions {
  /** deployment.state — drives the post-deletion view. */
  readonly deploymentState: string;
  /** The deployment's AWS region, echoed into every component. */
  readonly region: string;
}

export interface AggregateInfrastructureResult {
  readonly components: readonly InfrastructureComponentSummary[];
  /** Rollup over the COMPONENT statuses, highest priority first:
   *  failed > deleting > updating > provisioning > unknown > retained > ready.
   *  A deployment with nothing to show rolls up to 'unknown' — never to a
   *  healthy-looking value. Wire form maps 'ready' → 'healthy' (see
   *  infrastructureSummaryStatusSchema). */
  readonly summaryStatus: InfrastructureComponentStatus;
}

// Component status rollup priority, highest first. A 'failed' row — primary
// or supporting — always fails its component; 'removed' is the quiet tail a
// mixed group ignores.
const COMPONENT_STATUS_PRIORITY: readonly InfrastructureComponentStatus[] = [
  'failed',
  'deleting',
  'updating',
  'provisioning',
  'unknown',
  'retained',
  'ready',
  'removed',
];

// 'removed' sits OUTSIDE the summary order: a removed row must not drag a
// summary upward, while a component of only removed rows still reads as the
// deleted state it is. A deployment with nothing summarizable falls back to
// 'unknown' — never to a healthy-looking value.
const SUMMARY_STATUS_PRIORITY = COMPONENT_STATUS_PRIORITY.filter((status) => status !== 'removed');

const AWS_SERVICE_PREFIXES: ReadonlyArray<readonly [prefix: string, label: string]> = [
  ['AWS::RDS::', 'RDS'],
  ['AWS::S3::', 'S3'],
  ['AWS::ECS::', 'ECS'],
  ['AWS::ElastiCache::', 'ElastiCache'],
  ['AWS::ElasticLoadBalancingV2::', 'ELB'],
  ['AWS::EC2::', 'EC2'],
  ['AWS::Logs::', 'CloudWatch Logs'],
  ['AWS::CloudWatch::', 'CloudWatch'],
  ['AWS::ECR::', 'ECR'],
  ['AWS::CertificateManager::', 'ACM'],
  ['AWS::SecretsManager::', 'Secrets Manager'],
  ['AWS::IAM::', 'IAM'],
];

function awsServiceForType(resourceType: string): string {
  for (const [prefix, label] of AWS_SERVICE_PREFIXES) {
    if (resourceType.startsWith(prefix)) return label;
  }
  return 'AWS';
}

function mostCommonAwsService(rows: readonly InfrastructureResourceRow[]): string {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const label = awsServiceForType(row.resourceType);
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  let best = 'AWS';
  let bestCount = -1;
  for (const [label, count] of counts) {
    if (count > bestCount) {
      best = label;
      bestCount = count;
    }
  }
  return best;
}

function componentLifecycle(rows: readonly InfrastructureResourceRow[]): InfrastructureLifecycle {
  if (rows.some((row) => row.lifecyclePolicy === 'retain')) return 'retain';
  if (rows.some((row) => row.lifecyclePolicy === 'snapshot')) return 'snapshot';
  if (rows.every((row) => row.lifecyclePolicy === 'delete')) return 'delete';
  return 'conditional';
}

/**
 * Compose the persisted inventory rows into the customer-facing component
 * view. Pure — no database access, no AWS calls. A component exists iff it
 * has at least one row; empty kinds are never invented.
 *
 * Post-deletion override: when the deployment state is DELETED, every row's
 * effective status is re-derived from its lifecycle BEFORE aggregation —
 * retain/snapshot → 'retained', delete → 'removed', conditional keeps its
 * last mapped status. This yields the "Application→Removed,
 * Database→Retained" view from the preserved final snapshot.
 */
export function aggregateInfrastructureComponents(
  rows: readonly InfrastructureResourceRow[],
  options: AggregateInfrastructureOptions,
): AggregateInfrastructureResult {
  const effectiveRows = rows.map((row) => {
    if (options.deploymentState !== 'DELETED') return row;
    if (row.lifecyclePolicy === 'retain' || row.lifecyclePolicy === 'snapshot') {
      return { ...row, resourceStatus: 'retained' as const };
    }
    if (row.lifecyclePolicy === 'delete') {
      return { ...row, resourceStatus: 'removed' as const };
    }
    return row;
  });

  const byKind = new Map<InfrastructureComponentKind, InfrastructureResourceRow[]>();
  for (const row of effectiveRows) {
    const group = byKind.get(row.componentKind);
    if (group === undefined) {
      byKind.set(row.componentKind, [row]);
    } else {
      group.push(row);
    }
  }

  const components: InfrastructureComponentSummary[] = [];
  for (const [kind, group] of byKind) {
    const display = INFRASTRUCTURE_COMPONENT_DISPLAY[kind];
    // Highest-priority present status wins; a row whose mapped status is
    // outside the vocabulary degrades to 'unknown' rather than inventing one.
    const status =
      COMPONENT_STATUS_PRIORITY.find((candidate) => group.some((row) => row.resourceStatus === candidate)) ??
      'unknown';
    components.push({
      kind,
      name: display.name,
      purpose: display.purpose,
      status,
      awsService: mostCommonAwsService(group),
      region: options.region,
      lifecycle: componentLifecycle(group),
      resources: group.map((row) => ({
        logicalId: row.logicalResourceId,
        physicalId: row.physicalResourceId,
        type: row.resourceType,
        // Raw AWS status for the technical disclosure; fall back to the
        // mapped status only for rows written before raw status existed.
        status: row.rawResourceStatus ?? row.resourceStatus,
        statusReason: row.resourceStatusReason,
      })),
    });
  }

  const summaryStatus =
    SUMMARY_STATUS_PRIORITY.find((candidate) => components.some((component) => component.status === candidate)) ??
    'unknown';

  return { components, summaryStatus };
}

// ---------------------------------------------------------------------------
// Wire shape — GET /api/deployments/:id/infrastructure
// ---------------------------------------------------------------------------

/** Aggregate summary status vocabulary. Distinct from the per-component
 *  vocabulary: the rollup's 'ready' is presented as 'healthy', and 'removed'
 *  has no summary seat — a preserved final snapshot after deletion reads as
 *  'retained' while the deployment state carries "removed". */
export const infrastructureSummaryStatusSchema = z.enum([
  'healthy',
  'provisioning',
  'updating',
  'degraded',
  'failed',
  'deleting',
  'retained',
  'unknown',
]);
export type InfrastructureSummaryStatus = z.infer<typeof infrastructureSummaryStatusSchema>;

export const infrastructureResourceSchema = z
  .object({
    logicalId: z.string(),
    physicalId: z.string().nullable(),
    type: z.string(),
    status: z.string(),
    statusReason: z.string().nullable(),
  })
  .strict();

export const infrastructureComponentSummarySchema = z
  .object({
    kind: infrastructureComponentKindSchema,
    name: z.string(),
    purpose: z.string(),
    status: infrastructureComponentStatusSchema,
    awsService: z.string(),
    region: z.string(),
    lifecycle: infrastructureLifecycleSchema,
    resources: z.array(infrastructureResourceSchema),
  })
  .strict();

/** The exact GET /api/deployments/:id/infrastructure response. Lane 2's UI
 *  compiles against this shape — never change it without the web team. */
export const infrastructureResponseSchema = z
  .object({
    provider: z.literal('aws'),
    region: z.string(),
    stackStatus: z.string().nullable(),
    connectionState: z.enum(['connected', 'disconnected']),
    snapshotState: z.enum(['fresh', 'stale', 'none']),
    summary: z
      .object({
        status: infrastructureSummaryStatusSchema,
        componentCount: z.number().int(),
        technicalResourceCount: z.number().int(),
      })
      .strict(),
    components: z.array(infrastructureComponentSummarySchema),
    lastUpdatedAt: z.iso.datetime().nullable(),
    disconnectWarning: z
      .object({ lastVerifiedAt: z.iso.datetime() })
      .strict()
      .nullable(),
  })
  .strict();
export type InfrastructureResponse = z.infer<typeof infrastructureResponseSchema>;