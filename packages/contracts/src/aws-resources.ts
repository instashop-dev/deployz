import { z } from 'zod';

import { infrastructureComponentKindSchema, type InfrastructureComponentKind } from './infrastructure.js';
import type { InfrastructureProfile } from './index.js';

// The customer-facing AWS resource catalog — the meaningful AWS resources a
// deployment's application stack creates, bound to the component catalog
// (`components.ts`) and to the committed CloudFormation templates. Plans
// (`plan.ts`) derive their `awsResources` from this list, so the "AWS
// infrastructure details" preview the vendor and customer see comes from the
// same authoritative plan provisioning uses. Deliberately NOT every
// CloudFormation object: route tables, subnet associations, listeners, bucket
// policies and the like stay out of customer-facing UI.
//
// `packages/cdk/test/lifecycle-parity.test.ts` fails when a row here disagrees
// with the four committed application templates: each row's resource type
// (plus logical-id hint where a type is shared) must appear exactly where
// `requiredBy` predicts, and its `lifecycle` must match the template's
// DeletionPolicy.

export const awsResourceGroupSchema = z.enum(['connector', 'compute_networking', 'data', 'security_operations']);
export type AwsResourceGroup = z.infer<typeof awsResourceGroupSchema>;

/** Group headings in display order. The only source the UI renders group names from. */
export const AWS_RESOURCE_GROUP_DISPLAY: Readonly<Record<AwsResourceGroup, string>> = {
  connector: 'Deployz connector',
  compute_networking: 'Compute & Networking',
  data: 'Data',
  security_operations: 'Security & Operations',
};

export const AWS_RESOURCE_GROUP_ORDER: readonly AwsResourceGroup[] = [
  'connector',
  'compute_networking',
  'data',
  'security_operations',
];

export interface AwsResourceDefinition {
  /** Stable key — the plan row id the UI keys on. */
  readonly id: string;
  /** Customer-facing AWS resource name ("RDS PostgreSQL database"). */
  readonly name: string;
  /** Customer-facing purpose, one short sentence. */
  readonly purpose: string;
  readonly group: AwsResourceGroup;
  /** The catalog component (or supporting kind) this resource belongs to —
   *  must agree with `classifyResource` for the template resource it names. */
  readonly componentKind: InfrastructureComponentKind;
  /** The CloudFormation resource type that materializes this row. */
  readonly resourceType: string;
  /** Logical-id hint, only where `resourceType` is shared by several rows. */
  readonly logicalIdHint?: RegExp;
  /** What happens on destroy — must agree with the template's DeletionPolicy. */
  readonly lifecycle: 'delete' | 'retain';
  /** Whether a deployment with this profile creates the resource. */
  readonly requiredBy: (profile: InfrastructureProfile) => boolean;
}

const ALWAYS = (): boolean => true;
const WITH_POSTGRES = (profile: InfrastructureProfile): boolean => profile.postgres;
const WITH_REDIS = (profile: InfrastructureProfile): boolean => profile.redis;

export const AWS_RESOURCES: readonly AwsResourceDefinition[] = [
  // ── Compute & Networking ────────────────────────────────────────────────
  {
    id: 'vpc',
    name: 'Private network (VPC)',
    purpose: 'Isolates the application from other resources in your account',
    group: 'compute_networking',
    componentKind: 'network',
    resourceType: 'AWS::EC2::VPC',
    lifecycle: 'delete',
    requiredBy: ALWAYS,
  },
  {
    id: 'nat_gateway',
    name: 'NAT gateway',
    purpose: 'Lets the application reach the internet from the private network',
    group: 'compute_networking',
    componentKind: 'network',
    resourceType: 'AWS::EC2::NatGateway',
    lifecycle: 'delete',
    requiredBy: ALWAYS,
  },
  {
    id: 'ecs_cluster',
    name: 'ECS cluster',
    purpose: 'Groups the containers that run the application',
    group: 'compute_networking',
    componentKind: 'application',
    resourceType: 'AWS::ECS::Cluster',
    lifecycle: 'delete',
    requiredBy: ALWAYS,
  },
  {
    id: 'ecs_service',
    name: 'ECS Fargate service',
    purpose: 'Runs the application container and restarts it if it stops',
    group: 'compute_networking',
    componentKind: 'application',
    resourceType: 'AWS::ECS::Service',
    lifecycle: 'delete',
    requiredBy: ALWAYS,
  },
  {
    id: 'load_balancer',
    name: 'Application Load Balancer',
    purpose: 'Receives web traffic and sends it to the application',
    group: 'compute_networking',
    componentKind: 'endpoint',
    resourceType: 'AWS::ElasticLoadBalancingV2::LoadBalancer',
    lifecycle: 'delete',
    requiredBy: ALWAYS,
  },
  // ── Data ────────────────────────────────────────────────────────────────
  {
    id: 'database',
    name: 'RDS PostgreSQL database',
    purpose: 'Stores persistent application data',
    group: 'data',
    componentKind: 'database',
    resourceType: 'AWS::RDS::DBInstance',
    lifecycle: 'retain',
    requiredBy: WITH_POSTGRES,
  },
  {
    id: 'cache',
    name: 'ElastiCache Valkey cache',
    purpose: 'Speeds up application requests',
    group: 'data',
    componentKind: 'cache',
    resourceType: 'AWS::ElastiCache::ReplicationGroup',
    lifecycle: 'delete',
    requiredBy: WITH_REDIS,
  },
  {
    id: 'storage_bucket',
    name: 'S3 bucket',
    purpose: 'Stores uploaded files',
    group: 'data',
    componentKind: 'storage',
    resourceType: 'AWS::S3::Bucket',
    lifecycle: 'retain',
    requiredBy: ALWAYS,
  },
  // ── Security & Operations ───────────────────────────────────────────────
  {
    id: 'app_config_secret',
    name: 'Application configuration secret',
    purpose: 'Holds the application settings and secrets you provide',
    group: 'security_operations',
    componentKind: 'other',
    resourceType: 'AWS::SecretsManager::Secret',
    logicalIdHint: /^AppConfig/,
    lifecycle: 'delete',
    requiredBy: ALWAYS,
  },
  {
    id: 'database_secrets',
    name: 'Database credential secrets',
    purpose: 'Hold the database password and connection details',
    group: 'security_operations',
    componentKind: 'database',
    resourceType: 'AWS::SecretsManager::Secret',
    logicalIdHint: /^Database/,
    lifecycle: 'retain',
    requiredBy: WITH_POSTGRES,
  },
  {
    id: 'iam_roles',
    name: 'IAM roles',
    purpose: 'Give the application only the permissions it needs',
    group: 'security_operations',
    componentKind: 'application',
    resourceType: 'AWS::IAM::Role',
    lifecycle: 'delete',
    requiredBy: ALWAYS,
  },
  {
    id: 'security_groups',
    name: 'Security groups',
    purpose: 'Restrict network traffic between the components',
    group: 'security_operations',
    // One row for every security group in the stack. classifyResource binds
    // each one to the component it guards; the customer sees them together.
    componentKind: 'network',
    resourceType: 'AWS::EC2::SecurityGroup',
    lifecycle: 'delete',
    requiredBy: ALWAYS,
  },
  {
    id: 'log_group',
    name: 'CloudWatch log group',
    purpose: 'Collects application logs',
    group: 'security_operations',
    componentKind: 'monitoring',
    resourceType: 'AWS::Logs::LogGroup',
    lifecycle: 'delete',
    requiredBy: ALWAYS,
  },
  {
    id: 'health_alarm',
    name: 'CloudWatch alarm',
    purpose: 'Alerts when the application stops responding',
    group: 'security_operations',
    componentKind: 'monitoring',
    resourceType: 'AWS::CloudWatch::Alarm',
    lifecycle: 'delete',
    requiredBy: ALWAYS,
  },
] as const;

/** The AWS resources a deployment with this profile creates, in catalog order. */
export function requiredAwsResources(profile: InfrastructureProfile): readonly AwsResourceDefinition[] {
  return AWS_RESOURCES.filter((resource) => resource.requiredBy(profile));
}

/**
 * The bootstrap ("Deployz connector") stack's customer-meaningful resources —
 * the same shape as `AWS_RESOURCES` but a separate list on purpose: the
 * connector stack is created by the customer's own Quick Create, lives until
 * the customer deletes it, and is NOT part of the application stack whose
 * expected-vs-actual inventory `requiredAwsResources` verifies. The install
 * surface renders both lists together; verification consumes only the
 * application catalog.
 */
export const CONNECTOR_RESOURCES: readonly AwsResourceDefinition[] = [
  {
    id: 'connector_lambda',
    name: 'Deployz connector (AWS Lambda)',
    purpose: 'Runs the Deployz connector — it checks in with Deployz and performs deployment work in your account',
    group: 'connector',
    componentKind: 'other',
    resourceType: 'AWS::Lambda::Function',
    lifecycle: 'retain',
    requiredBy: ALWAYS,
  },
  {
    id: 'connector_role',
    name: 'Connector IAM role',
    purpose: 'Limits the connector to the deployment actions described on this page',
    group: 'connector',
    componentKind: 'other',
    resourceType: 'AWS::IAM::Role',
    lifecycle: 'retain',
    requiredBy: ALWAYS,
  },
  {
    id: 'connector_credential',
    name: 'Connector credential (Secrets Manager)',
    purpose: 'Stores the credential the connector uses to identify itself with Deployz',
    group: 'connector',
    componentKind: 'other',
    resourceType: 'AWS::SecretsManager::Secret',
    lifecycle: 'retain',
    requiredBy: ALWAYS,
  },
  {
    id: 'connector_schedule',
    name: 'Connector schedule (EventBridge)',
    purpose: 'Wakes the connector so it can pick up deployment work',
    group: 'connector',
    componentKind: 'other',
    resourceType: 'AWS::Events::Rule',
    lifecycle: 'retain',
    requiredBy: ALWAYS,
  },
] as const;

/**
 * The install surface's resource rows: the connector stack first, then the
 * application stack resources for this profile. One source for the install
 * page's infrastructure table, the retention messaging and future cost
 * breakdowns — never a hardcoded UI list.
 */
export function installSurfaceResources(profile: InfrastructureProfile): readonly AwsResourceDefinition[] {
  return [...CONNECTOR_RESOURCES, ...requiredAwsResources(profile)];
}

/** Whether a CloudFormation resource (type + logical id) is the one a catalog row names. */
export function awsResourceMatches(resource: AwsResourceDefinition, type: string, logicalId: string): boolean {
  return resource.resourceType === type && (resource.logicalIdHint === undefined || resource.logicalIdHint.test(logicalId));
}

/** One AWS resource row of a deployment plan — the wire shape the UI renders. */
export const deploymentPlanAwsResourceSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    purpose: z.string(),
    group: awsResourceGroupSchema,
    componentKind: infrastructureComponentKindSchema,
    lifecycle: z.enum(['delete', 'retain']),
  })
  .strict();
export type DeploymentPlanAwsResource = z.infer<typeof deploymentPlanAwsResourceSchema>;

export function toPlanAwsResource(resource: AwsResourceDefinition): DeploymentPlanAwsResource {
  return {
    id: resource.id,
    name: resource.name,
    purpose: resource.purpose,
    group: resource.group,
    componentKind: resource.componentKind,
    lifecycle: resource.lifecycle,
  };
}
