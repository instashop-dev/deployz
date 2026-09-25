import { createHash } from 'node:crypto';

import {
  type ApplicationGraph,
  type Binding,
  type CapabilityRegistry,
  type DeployzIR,
  type DeploymentSpecV2,
  type InfrastructureSizeProfile,
  type IrBinding,
  type IrResource,
  type IrWorkload,
  type Region,
  type Resource,
  type Workload,
  CAPABILITY_KEYS,
  DEPLOYMENT_SPEC_V2_SCHEMA_VERSION,
  DEPLOYZ_IR_SCHEMA_VERSION,
  INFRA_VERSION_DYNAMIC_COMPILER_V2,
  defaultCapabilityRegistry,
  defaultInfrastructureSizeProfile,
  deploymentSpecV2Schema,
  deployzIrSchema,
  findCapability,
} from '@deployz/contracts';

// ---------------------------------------------------------------------------
// Planner — Phase 1 shadow-mode.
//
// Pure, deterministic transform from ApplicationGraph + region/size/policy
// config into DeployzIR. Does NOT touch production provisioning.
// ---------------------------------------------------------------------------

function computeCapabilityKey(workload: Workload): string {
  return workload.kind === 'migration'
    ? CAPABILITY_KEYS.ECS_FARGATE_TASK
    : CAPABILITY_KEYS.ECS_FARGATE_SERVICE;
}

function buildConfiguration(resource: Resource, profile: InfrastructureSizeProfile): Record<string, unknown> {
  const key = resource.capabilityKey;
  if (key === CAPABILITY_KEYS.RDS_POSTGRES) {
    return {
      engine: 'postgres',
      engineVersion: '16',
      instanceType: profile.database.instanceClass,
      storageGb: profile.database.storageGb,
      maxStorageGb: profile.database.maxStorageGb,
    };
  }
  if (key === CAPABILITY_KEYS.ELASTICACHE_VALKEY) {
    return {
      engine: 'valkey',
      nodeType: profile.cache.nodeType,
      nodes: profile.cache.nodeCount,
    };
  }
  return {};
}

function collectIamActions(
  targetResource: Resource | undefined,
  registry: CapabilityRegistry,
): string[] {
  if (!targetResource?.capabilityKey) return [];
  const cap = findCapability(registry, targetResource.capabilityKey);
  if (!cap?.bindings.iam) return [];
  return cap.bindings.iam.flatMap((entry) => entry.actions);
}

function sortedJsonStringify(value: unknown): string {
  return JSON.stringify(value, (_key, val) => {
    if (val !== null && typeof val === 'object' && !Array.isArray(val)) {
      return Object.fromEntries(
        Object.entries(val as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)),
      );
    }
    return val;
  });
}

function stableHash(value: unknown): string {
  return createHash('sha256').update(sortedJsonStringify(value)).digest('hex');
}

export function planApplicationGraph(input: {
  graph: ApplicationGraph;
  region: Region | null;
  sizeProfile?: InfrastructureSizeProfile;
  registry?: CapabilityRegistry;
}): DeployzIR {
  const profile = input.sizeProfile ?? defaultInfrastructureSizeProfile();
  const registry = input.registry ?? defaultCapabilityRegistry();
  const { graph, region } = input;

  const resourceMap = new Map(graph.resources.map((r) => [r.id, r]));

  // Workloads
  const workloads: IrWorkload[] = graph.workloads.map((w) => {
    const bindingTargetIds = graph.bindings
      .filter((b) => b.sourceId === w.id)
      .map((b) => b.targetId);
    const dependencyCapabilityKeys = bindingTargetIds
      .map((targetId) => resourceMap.get(targetId))
      .filter(
        (r): r is Resource =>
          r !== undefined && r.ownership === 'DEPLOYZ_MANAGED' && r.capabilityKey !== null,
      )
      .map((r) => r.capabilityKey as string);

    return {
      componentId: w.id,
      kind: w.kind,
      label: w.label,
      buildArtifactId: w.buildArtifactId,
      command: w.command,
      port: w.port,
      public: w.public,
      healthCheck: w.healthCheck,
      desiredCount: w.desiredCount,
      compute: {
        provider: 'aws' as const,
        capabilityKey: computeCapabilityKey(w),
        cpuUnits: profile.workload.cpuUnits,
        memoryMiB: profile.workload.memoryMiB,
        sizeLabel: profile.label,
        architecture: null,
      },
      dependencyCapabilityKeys: [...new Set(dependencyCapabilityKeys)],
    };
  });

  // Resources — only DEPLOYZ_MANAGED with non-null capabilityKey
  const resources: IrResource[] = graph.resources
    .filter((r) => r.ownership === 'DEPLOYZ_MANAGED' && r.capabilityKey !== null)
    .map((r) => {
      const cap = findCapability(registry, r.capabilityKey!);
      return {
        componentId: r.id,
        capabilityKey: r.capabilityKey!,
        label: r.label,
        quantity: r.quantity,
        configuration: buildConfiguration(r, profile),
        lifecycle: (cap?.lifecycle.lifecycle ?? 'retain') as IrResource['lifecycle'],
        scope: 'REGIONAL' as const,
        envBindings: r.envBindings,
      };
    });

  // Bindings
  const bindings: IrBinding[] = graph.bindings.map((b: Binding) => {
    const targetResource = resourceMap.get(b.targetId);
    return {
      id: b.id,
      sourceId: b.sourceId,
      targetId: b.targetId,
      envBindings: b.envBindings,
      iamActions: collectIamActions(targetResource, registry),
    };
  });

  // Ingress
  const publicWorkloads = graph.workloads.filter((w) => w.public === true);
  const ingress = {
    public: publicWorkloads.length > 0,
    capabilityKey: publicWorkloads.length > 0 ? CAPABILITY_KEYS.ALB : null,
    targetWorkloadIds: publicWorkloads.map((w) => w.id),
  };

  const ir: DeployzIR = {
    schemaVersion: DEPLOYZ_IR_SCHEMA_VERSION,
    workloads,
    resources,
    bindings,
    ingress,
    schedules: [],
    policies: {
      allowTopologyChanges: false,
      defaultRetention: 'retain',
    },
    metadata: {
      graphSchemaVersion: graph.schemaVersion,
      capabilityRegistryVersion: registry.version,
      sizeProfileId: profile.id,
      region,
    },
  };

  return deployzIrSchema.parse(ir);
}

export function buildDeploymentSpecV2(input: {
  graph: ApplicationGraph;
  ir: DeployzIR;
  sizeProfileId: string;
  capabilityRegistryVersion: string;
}): DeploymentSpecV2 {
  const spec: DeploymentSpecV2 = {
    schemaVersion: DEPLOYMENT_SPEC_V2_SCHEMA_VERSION,
    infraVersion: INFRA_VERSION_DYNAMIC_COMPILER_V2,
    graph: input.graph,
    ir: input.ir,
    graphHash: stableHash(input.graph),
    irHash: stableHash(input.ir),
    capabilityRegistryVersion: input.capabilityRegistryVersion,
    sizeProfileId: input.sizeProfileId,
    compilerVersion: null,
    templateHash: null,
    artifactLocation: null,
    frozenAt: new Date().toISOString(),
  };

  return deploymentSpecV2Schema.parse(spec);
}

export function planApplicationGraphWithSpec(input: {
  graph: ApplicationGraph;
  region: Region | null;
  sizeProfile?: InfrastructureSizeProfile;
  registry?: CapabilityRegistry;
}): { ir: DeployzIR; spec: DeploymentSpecV2 } {
  const profile = input.sizeProfile ?? defaultInfrastructureSizeProfile();
  const registry = input.registry ?? defaultCapabilityRegistry();

  const ir = planApplicationGraph({ ...input, sizeProfile: profile, registry });

  const spec = buildDeploymentSpecV2({
    graph: input.graph,
    ir,
    sizeProfileId: profile.id,
    capabilityRegistryVersion: registry.version,
  });

  return { ir, spec };
}
