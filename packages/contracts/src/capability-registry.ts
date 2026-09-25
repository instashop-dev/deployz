import { z } from 'zod';

// ---------------------------------------------------------------------------
// Capability registry — Phase 1 interface.
//
// A capability is a known, versioned unit of infrastructure that Deployz can
// provision. Phase 1 introduces the interface and registers only the existing
// supported capabilities. New capabilities are added in later phases.
// ---------------------------------------------------------------------------

export const capabilityMaturitySchema = z.enum(['EXPERIMENTAL', 'PREVIEW', 'SUPPORTED', 'DEPRECATED']);
export type CapabilityMaturity = z.infer<typeof capabilityMaturitySchema>;

export const capabilityLifecycleOperationSchema = z.enum([
  'CREATE',
  'VERIFY',
  'UPDATE',
  'BACKUP',
  'RESTORE',
  'DESTROY',
  'PURGE',
]);
export type CapabilityLifecycleOperation = z.infer<typeof capabilityLifecycleOperationSchema>;

export const resourceLifecycleSchema = z.enum(['delete', 'retain']);
export type ResourceLifecycle = z.infer<typeof resourceLifecycleSchema>;

export const resourceScopeSchema = z.enum(['REGIONAL', 'GLOBAL', 'FIXED_REGION']);
export type ResourceScope = z.infer<typeof resourceScopeSchema>;

export const capabilityCompatibilitySchema = z.enum([
  'SUPPORTED',
  'CONFIGURATION_REQUIRED',
  'RECOGNIZED_UNSUPPORTED',
  'UNKNOWN_ARCHITECTURE',
]);
export type CapabilityCompatibility = z.infer<typeof capabilityCompatibilitySchema>;

/** Capability identity — stable key plus version. */
export const capabilityRefSchema = z
  .object({
    key: z.string().min(1),
    version: z.string().min(1),
  })
  .strict();
export type CapabilityRef = z.infer<typeof capabilityRefSchema>;

/** Network placement intent a capability may require. */
export const networkRequirementSchema = z
  .object({
    requiresVpc: z.boolean(),
    requiresSubnet: z.boolean(),
    requiresPublicSubnet: z.boolean().optional(),
    requiresPrivateSubnet: z.boolean().optional(),
    requiresSecurityGroup: z.boolean().optional(),
    requiresServiceDiscovery: z.boolean().optional(),
  })
  .strict();
export type NetworkRequirement = z.infer<typeof networkRequirementSchema>;

/** Lifecycle metadata for a capability. */
export const capabilityLifecycleSchema = z
  .object({
    stateful: z.boolean(),
    lifecycle: resourceLifecycleSchema,
    /** Whether the capability supports in-place updates without replacement. */
    supportsInPlaceUpdate: z.boolean(),
    /** Whether the capability supports migration between major versions. */
    supportsMajorVersionMigration: z.boolean(),
    /** Supported lifecycle operations — unsupported operations must be explicit. */
    operations: z.array(capabilityLifecycleOperationSchema),
    /** Default retention/purge behavior. */
    retentionPolicy: z.enum(['retain', 'delete', 'snapshot_then_delete']).nullable(),
    purgeStrategy: z.enum(['delete', 'skip', 'require_manual']).nullable(),
  })
  .strict();
export type CapabilityLifecycle = z.infer<typeof capabilityLifecycleSchema>;

/** IAM permission shape a capability declares for bound workloads. */
export const capabilityIamIntentSchema = z
  .object({
    actions: z.array(z.string().min(1)),
    resourcePattern: z.string().min(1),
    conditionKeys: z.array(z.string()).optional(),
  })
  .strict();
export type CapabilityIamIntent = z.infer<typeof capabilityIamIntentSchema>;

/** Binding a capability produces for workloads. */
export const capabilityBindingSchema = z
  .object({
    envBindings: z.array(
      z.object({
        name: z.string().min(1),
        kind: z.enum(['url', 'host', 'port', 'bucket', 'database', 'username', 'password', 'arn']),
      }).strict(),
    ),
    iam: z.array(capabilityIamIntentSchema).optional(),
  })
  .strict();
export type CapabilityBinding = z.infer<typeof capabilityBindingSchema>;

/** Pricing metadata a capability provides. */
export const capabilityPricingSchema = z
  .object({
    category: z.enum(['compute', 'database', 'cache', 'storage', 'messaging', 'networking', 'other']),
    estimateAvailable: z.boolean(),
  })
  .strict();
export type CapabilityPricing = z.infer<typeof capabilityPricingSchema>;

/** Presentation metadata for UI/progress/diagnostics. */
export const capabilityPresentationSchema = z
  .object({
    singular: z.string().min(1),
    plural: z.string().min(1),
    group: z.enum(['Application', 'Data', 'Messaging', 'Storage', 'Networking', 'Edge', 'Security']),
    icon: z.string().optional(),
  })
  .strict();
export type CapabilityPresentation = z.infer<typeof capabilityPresentationSchema>;

/** A capability registered in the Phase 1 catalog. */
export const registeredCapabilitySchema = z
  .object({
    ref: capabilityRefSchema,
    maturity: capabilityMaturitySchema,
    /** Resource kinds this capability can satisfy (e.g. 'relational_database'). */
    satisfiesKinds: z.array(z.string().min(1)),
    /** AWS service key for pricing/footprint grouping. */
    serviceKey: z.string().min(1),
    network: networkRequirementSchema,
    lifecycle: capabilityLifecycleSchema,
    bindings: capabilityBindingSchema,
    pricing: capabilityPricingSchema,
    presentation: capabilityPresentationSchema,
    /** Region-capability availability rules — default is supported everywhere. */
    regionAvailability: z.record(z.string(), z.enum(['available', 'unavailable', 'preview'] as const)).optional(),
  })
  .strict();
export type RegisteredCapability = z.infer<typeof registeredCapabilitySchema>;

/** The Phase 1 capability registry — a small, versioned catalog. */
export const capabilityRegistrySchema = z
  .object({
    version: z.string().min(1),
    capabilities: z.array(registeredCapabilitySchema),
  })
  .strict();
export type CapabilityRegistry = z.infer<typeof capabilityRegistrySchema>;

/** Known Phase 1 capability keys. */
export const CAPABILITY_KEYS = {
  ECS_FARGATE_SERVICE: 'aws.ecs-service',
  ECS_FARGATE_TASK: 'aws.ecs-task',
  RDS_POSTGRES: 'aws.rds-postgres',
  ELASTICACHE_VALKEY: 'aws.elasticache-valkey',
  S3: 'aws.s3',
  ALB: 'aws.alb',
  SECRETS_MANAGER: 'aws.secrets-manager',
} as const;

export const DEFAULT_CAPABILITY_REGISTRY_VERSION = 'phase1-2026-09-25' as const;

/** The minimal Phase 1 registry — only currently supported capabilities. */
export function defaultCapabilityRegistry(): CapabilityRegistry {
  return {
    version: DEFAULT_CAPABILITY_REGISTRY_VERSION,
    capabilities: [
      {
        ref: { key: CAPABILITY_KEYS.ECS_FARGATE_SERVICE, version: '1' },
        maturity: 'SUPPORTED',
        satisfiesKinds: ['generic_service'],
        serviceKey: 'ecs-fargate',
        network: {
          requiresVpc: true,
          requiresSubnet: true,
          requiresSecurityGroup: true,
        },
        lifecycle: {
          stateful: false,
          lifecycle: 'delete',
          supportsInPlaceUpdate: true,
          supportsMajorVersionMigration: false,
          operations: ['CREATE', 'VERIFY', 'UPDATE', 'DESTROY', 'PURGE'],
          retentionPolicy: null,
          purgeStrategy: 'delete',
        },
        bindings: {
          envBindings: [],
          iam: [],
        },
        pricing: { category: 'compute', estimateAvailable: false },
        presentation: {
          singular: 'Application service',
          plural: 'Application services',
          group: 'Application',
        },
      },
      {
        ref: { key: CAPABILITY_KEYS.ECS_FARGATE_TASK, version: '1' },
        maturity: 'SUPPORTED',
        satisfiesKinds: ['generic_service'],
        serviceKey: 'ecs-fargate',
        network: {
          requiresVpc: true,
          requiresSubnet: true,
          requiresSecurityGroup: true,
        },
        lifecycle: {
          stateful: false,
          lifecycle: 'delete',
          supportsInPlaceUpdate: true,
          supportsMajorVersionMigration: false,
          operations: ['CREATE', 'VERIFY', 'UPDATE', 'DESTROY', 'PURGE'],
          retentionPolicy: null,
          purgeStrategy: 'delete',
        },
        bindings: {
          envBindings: [],
          iam: [],
        },
        pricing: { category: 'compute', estimateAvailable: false },
        presentation: {
          singular: 'One-shot task',
          plural: 'One-shot tasks',
          group: 'Application',
        },
      },
      {
        ref: { key: CAPABILITY_KEYS.RDS_POSTGRES, version: '1' },
        maturity: 'SUPPORTED',
        satisfiesKinds: ['relational_database'],
        serviceKey: 'rds-postgres',
        network: {
          requiresVpc: true,
          requiresSubnet: true,
          requiresSecurityGroup: true,
        },
        lifecycle: {
          stateful: true,
          lifecycle: 'retain',
          supportsInPlaceUpdate: true,
          supportsMajorVersionMigration: false,
          operations: ['CREATE', 'VERIFY', 'UPDATE', 'BACKUP', 'DESTROY'],
          retentionPolicy: 'retain',
          purgeStrategy: 'require_manual',
        },
        bindings: {
          envBindings: [
            { name: 'DATABASE_URL', kind: 'url' },
            { name: 'DB_HOST', kind: 'host' },
            { name: 'DB_PORT', kind: 'port' },
            { name: 'DB_NAME', kind: 'database' },
            { name: 'DB_USER', kind: 'username' },
            { name: 'DB_PASSWORD', kind: 'password' },
          ],
          iam: [],
        },
        pricing: { category: 'database', estimateAvailable: false },
        presentation: {
          singular: 'PostgreSQL database',
          plural: 'PostgreSQL databases',
          group: 'Data',
        },
      },
      {
        ref: { key: CAPABILITY_KEYS.ELASTICACHE_VALKEY, version: '1' },
        maturity: 'SUPPORTED',
        satisfiesKinds: ['cache'],
        serviceKey: 'elasticache-valkey',
        network: {
          requiresVpc: true,
          requiresSubnet: true,
          requiresSecurityGroup: true,
        },
        lifecycle: {
          stateful: false,
          lifecycle: 'delete',
          supportsInPlaceUpdate: true,
          supportsMajorVersionMigration: false,
          operations: ['CREATE', 'VERIFY', 'UPDATE', 'DESTROY', 'PURGE'],
          retentionPolicy: null,
          purgeStrategy: 'delete',
        },
        bindings: {
          envBindings: [
            { name: 'REDIS_URL', kind: 'url' },
            { name: 'CACHE_URL', kind: 'url' },
          ],
          iam: [],
        },
        pricing: { category: 'cache', estimateAvailable: false },
        presentation: {
          singular: 'Redis cache',
          plural: 'Redis caches',
          group: 'Data',
        },
      },
      {
        ref: { key: CAPABILITY_KEYS.S3, version: '1' },
        maturity: 'SUPPORTED',
        satisfiesKinds: ['object_storage'],
        serviceKey: 's3',
        network: {
          requiresVpc: false,
          requiresSubnet: false,
        },
        lifecycle: {
          stateful: true,
          lifecycle: 'retain',
          supportsInPlaceUpdate: true,
          supportsMajorVersionMigration: false,
          operations: ['CREATE', 'VERIFY', 'UPDATE', 'BACKUP', 'DESTROY'],
          retentionPolicy: 'retain',
          purgeStrategy: 'require_manual',
        },
        bindings: {
          envBindings: [
            { name: 'S3_BUCKET', kind: 'bucket' },
            { name: 'AWS_S3_BUCKET', kind: 'bucket' },
          ],
          iam: [
            {
              actions: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject', 's3:ListBucket'],
              resourcePattern: 'arn:aws:s3:::${bucket}/*',
            },
          ],
        },
        pricing: { category: 'storage', estimateAvailable: false },
        presentation: {
          singular: 'S3 bucket',
          plural: 'S3 buckets',
          group: 'Storage',
        },
      },
      {
        ref: { key: CAPABILITY_KEYS.ALB, version: '1' },
        maturity: 'SUPPORTED',
        satisfiesKinds: ['generic_service'],
        serviceKey: 'alb',
        network: {
          requiresVpc: true,
          requiresSubnet: true,
          requiresPublicSubnet: true,
          requiresSecurityGroup: true,
        },
        lifecycle: {
          stateful: false,
          lifecycle: 'delete',
          supportsInPlaceUpdate: true,
          supportsMajorVersionMigration: false,
          operations: ['CREATE', 'VERIFY', 'UPDATE', 'DESTROY', 'PURGE'],
          retentionPolicy: null,
          purgeStrategy: 'delete',
        },
        bindings: {
          envBindings: [],
          iam: [],
        },
        pricing: { category: 'networking', estimateAvailable: false },
        presentation: {
          singular: 'Application load balancer',
          plural: 'Application load balancers',
          group: 'Networking',
        },
      },
      {
        ref: { key: CAPABILITY_KEYS.SECRETS_MANAGER, version: '1' },
        maturity: 'SUPPORTED',
        satisfiesKinds: ['generic_service'],
        serviceKey: 'secrets-manager',
        network: {
          requiresVpc: false,
          requiresSubnet: false,
        },
        lifecycle: {
          stateful: false,
          lifecycle: 'delete',
          supportsInPlaceUpdate: true,
          supportsMajorVersionMigration: false,
          operations: ['CREATE', 'VERIFY', 'UPDATE', 'DESTROY', 'PURGE'],
          retentionPolicy: null,
          purgeStrategy: 'delete',
        },
        bindings: {
          envBindings: [],
          iam: [
            {
              actions: ['secretsmanager:GetSecretValue'],
              resourcePattern: 'arn:aws:secretsmanager:${region}:${account}:secret:${prefix}/*',
            },
          ],
        },
        pricing: { category: 'other', estimateAvailable: false },
        presentation: {
          singular: 'Secret',
          plural: 'Secrets',
          group: 'Security',
        },
      },
    ],
  };
}

export function findCapability(registry: CapabilityRegistry, key: string): RegisteredCapability | undefined {
  return registry.capabilities.find((c) => c.ref.key === key);
}

export function capabilitiesForKind(registry: CapabilityRegistry, kind: string): RegisteredCapability[] {
  return registry.capabilities.filter((c) => c.satisfiesKinds.includes(kind));
}
