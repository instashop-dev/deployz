import { z } from 'zod';

import { INFRASTRUCTURE_COMPONENT_DISPLAY } from './infrastructure.js';
import { requiredInfrastructureComponents } from './components.js';
import type { InfrastructureProfile, Region } from './index.js';
import { infrastructureProfileForManifest, regionSchema } from './index.js';
import type { DeploymentManifest } from './manifest.js';

// The canonical Deployment Footprint — the resolved infrastructure one
// deployment creates: workloads (things that run vendor code) and managed
// resources (infrastructure dependencies). Derived deterministically from the
// deployment manifest and the shared sizing table below — never from AWS,
// never from an LLM. Plans (`plan.ts`) embed it, so provisioning intent and
// everything the UI shows come from the same resolved values.
//
// Generic resource model, explicit supported implementations: nothing here
// special-cases PostgreSQL or Redis. Capability handlers are registered in
// FOOTPRINT_RESOURCES; adding MySQL or a queue later means adding a handler
// (plus pricing), not touching display code.

export const FOOTPRINT_SCHEMA_VERSION = 1 as const;

/**
 * The ONE sizing table for a published application template generation.
 * `packages/cdk/src/application/application-stack.ts` provisions from these
 * values and `packages/cdk/test/sizing-parity.test.ts` pins them to the four
 * committed template artifacts — editing a value without republishing the
 * templates fails CI, so display and CloudFormation cannot drift.
 * Ceiling: when a second sizing generation ships, this needs a
 * per-`infraVersion` registry (see docs/footprint-implementation-note.md).
 */
export const DEPLOYMENT_SIZING = {
  workload: {
    web: { cpuUnits: 256, memoryMiB: 512, quantity: 1, sizeLabel: 'Small' },
    worker: { cpuUnits: 256, memoryMiB: 512, quantity: 1, sizeLabel: 'Small' },
  },
  database: {
    engine: 'postgres',
    engineVersion: '16',
    instanceType: 'db.t4g.micro',
    storageGb: 20,
  },
  cache: {
    engine: 'valkey',
    nodeType: 'cache.t4g.micro',
  },
} as const;

export const footprintCategorySchema = z.enum(['database', 'cache', 'storage', 'queue', 'network', 'other']);
export type FootprintCategory = z.infer<typeof footprintCategorySchema>;

/** Human names for the supported categories — the only source the UI renders category text from. */
export const FOOTPRINT_CATEGORY_DISPLAY: Readonly<Record<FootprintCategory, string>> = {
  database: 'Database',
  cache: 'Cache',
  storage: 'Storage',
  queue: 'Queue',
  network: 'Networking',
  other: 'Other',
};

/** Customer-facing AWS service names per footprint `service` key. */
export const FOOTPRINT_SERVICE_DISPLAY: Readonly<Record<string, string>> = {
  'ecs-fargate': 'AWS Fargate',
  'rds-postgres': 'RDS PostgreSQL',
  'elasticache-valkey': 'ElastiCache Valkey',
  s3: 'S3',
  alb: 'Application Load Balancer',
  'nat-gateway': 'NAT gateway',
};

/** Display names for the engines footprint configurations carry. */
export const FOOTPRINT_ENGINE_DISPLAY: Readonly<Record<string, string>> = {
  postgres: 'PostgreSQL',
  valkey: 'Redis (Valkey)',
  mysql: 'MySQL',
};

export const footprintWorkloadSchema = z
  .object({
    id: z.string(),
    role: z.string(),
    label: z.string(),
    quantity: z.number().int().min(1),
    compute: z
      .object({
        provider: z.literal('aws'),
        service: z.string(),
        cpuUnits: z.number().int(),
        memoryMiB: z.number().int(),
        /** Readable tier ("Small") shown next to the exact CPU/memory values. */
        sizeLabel: z.string(),
      })
      .strict(),
    lifecycle: z
      .object({
        persistent: z.boolean(),
      })
      .strict(),
  })
  .strict();
export type FootprintWorkload = z.infer<typeof footprintWorkloadSchema>;

export const footprintResourceSchema = z
  .object({
    id: z.string(),
    category: footprintCategorySchema,
    provider: z.literal('aws'),
    /** Stable capability key ('rds-postgres', 'elasticache-valkey', 's3', …) — pricing adapters key on this. */
    service: z.string(),
    /** The catalog role this resource plays ('database', 'cache', …). */
    role: z.string(),
    label: z.string(),
    quantity: z.number().int().min(1),
    configuration: z.record(z.string(), z.unknown()),
    lifecycle: z
      .object({
        persistent: z.boolean(),
        retainOnDelete: z.boolean(),
      })
      .strict(),
  })
  .strict();
export type FootprintResource = z.infer<typeof footprintResourceSchema>;

export const deploymentFootprintSchema = z
  .object({
    version: z.literal(FOOTPRINT_SCHEMA_VERSION),
    region: z.lazy(() => regionSchema).nullable(),
    workloads: z.array(footprintWorkloadSchema),
    resources: z.array(footprintResourceSchema),
    generatedFrom: z
      .object({
        /** The application-template generation the sizing was resolved for. */
        infraVersion: z.string().nullable(),
      })
      .strict(),
  })
  .strict();
export type DeploymentFootprint = z.infer<typeof deploymentFootprintSchema>;

function workloadFrom(
  id: string,
  role: string,
  label: string,
  sizing: { cpuUnits: number; memoryMiB: number; quantity: number; sizeLabel: string },
): FootprintWorkload {
  return {
    id,
    role,
    label,
    quantity: sizing.quantity,
    compute: {
      provider: 'aws',
      service: 'ecs-fargate',
      cpuUnits: sizing.cpuUnits,
      memoryMiB: sizing.memoryMiB,
      sizeLabel: sizing.sizeLabel,
    },
    lifecycle: { persistent: false },
  };
}

interface FootprintResourceHandler {
  readonly id: string;
  readonly category: FootprintCategory;
  readonly service: string;
  readonly role: string;
  readonly label: string;
  readonly requiredBy: (profile: InfrastructureProfile) => boolean;
  readonly configuration: () => Record<string, unknown>;
  /** True when the resource outlives a deployment removal. */
  readonly persistent: boolean;
}

// The supported managed-resource handlers. Lifecycle comes from
// INFRASTRUCTURE_COMPONENTS where a catalog component exists, so destroy
// semantics have exactly one source; the NAT gateway has no catalog
// component (it is material for cost, not verified), so its lifecycle is
// declared here.
const FOOTPRINT_RESOURCES: readonly FootprintResourceHandler[] = [
  {
    id: 'database',
    category: 'database',
    service: 'rds-postgres',
    role: 'database',
    label: INFRASTRUCTURE_COMPONENT_DISPLAY.database.name,
    requiredBy: (profile) => profile.postgres,
    configuration: () => ({
      engine: DEPLOYMENT_SIZING.database.engine,
      engineVersion: DEPLOYMENT_SIZING.database.engineVersion,
      instanceType: DEPLOYMENT_SIZING.database.instanceType,
      storageGb: DEPLOYMENT_SIZING.database.storageGb,
    }),
    persistent: true,
  },
  {
    id: 'cache',
    category: 'cache',
    service: 'elasticache-valkey',
    role: 'cache',
    label: INFRASTRUCTURE_COMPONENT_DISPLAY.cache.name,
    requiredBy: (profile) => profile.redis,
    configuration: () => ({
      engine: DEPLOYMENT_SIZING.cache.engine,
      nodeType: DEPLOYMENT_SIZING.cache.nodeType,
      nodes: 1,
    }),
    persistent: false,
  },
  {
    id: 'storage',
    category: 'storage',
    service: 's3',
    role: 'storage',
    label: INFRASTRUCTURE_COMPONENT_DISPLAY.storage.name,
    requiredBy: () => true,
    configuration: () => ({}),
    persistent: true,
  },
  {
    id: 'endpoint',
    category: 'network',
    service: 'alb',
    role: 'endpoint',
    label: INFRASTRUCTURE_COMPONENT_DISPLAY.endpoint.name,
    requiredBy: () => true,
    configuration: () => ({}),
    persistent: false,
  },
  {
    id: 'nat-gateway',
    category: 'network',
    service: 'nat-gateway',
    role: 'network',
    label: FOOTPRINT_SERVICE_DISPLAY['nat-gateway']!,
    requiredBy: () => true,
    configuration: () => ({}),
    persistent: false,
  },
];

function resourceLifecycle(handler: FootprintResourceHandler, profile: InfrastructureProfile): {
  persistent: boolean;
  retainOnDelete: boolean;
} {
  const component = requiredInfrastructureComponents(profile).find((entry) => entry.kind === handler.role);
  const retain = component ? component.lifecycle === 'retain' : handler.persistent;
  return { persistent: retain, retainOnDelete: retain };
}

/**
 * The resolved Deployment Footprint for a manifest: one web workload, an
 * optional worker workload, and every managed resource the manifest's
 * infrastructure profile requires. Pure — the same manifest, region and
 * sizing generation always resolve to the same footprint.
 */
export function resolveDeploymentFootprint(input: {
  manifest: DeploymentManifest;
  region: Region | null;
  infraVersion?: string | null;
}): DeploymentFootprint {
  const profile = infrastructureProfileForManifest(input.manifest);
  const workloads: FootprintWorkload[] = [workloadFrom('web', 'web', 'Web application', DEPLOYMENT_SIZING.workload.web)];
  if (input.manifest.worker.command !== null) {
    workloads.push(workloadFrom('worker', 'worker', 'Background worker', DEPLOYMENT_SIZING.workload.worker));
  }
  return {
    version: FOOTPRINT_SCHEMA_VERSION,
    region: input.region,
    workloads,
    resources: FOOTPRINT_RESOURCES.filter((handler) => handler.requiredBy(profile)).map((handler) => ({
      id: handler.id,
      category: handler.category,
      provider: 'aws' as const,
      service: handler.service,
      role: handler.role,
      label: handler.label,
      quantity: 1,
      configuration: handler.configuration(),
      lifecycle: resourceLifecycle(handler, profile),
    })),
    generatedFrom: { infraVersion: input.infraVersion ?? null },
  };
}
