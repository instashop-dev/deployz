import { createHash } from 'node:crypto';

import {
  type ApplicationGraph,
  type Binding,
  type CapabilityRegistry,
  type DeployzIR,
  type DeploymentSpecCompilation,
  type DeploymentSpecV2,
  type InfrastructureSizeProfile,
  type IrBinding,
  type IrResource,
  type IrSchedule,
  type IrWorkload,
  type Region,
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

import { relationshipViolations } from './relationships.js';
import { buildCapabilityConfiguration, resolveResourceCapability } from './resolver.js';

// ---------------------------------------------------------------------------
// Planner — the production compile path.
//
// Pure, deterministic transform from ApplicationGraph + region/size/policy
// config into DeployzIR, then into the frozen DeploymentSpecV2 an install
// executes. Never touches AWS directly.
// ---------------------------------------------------------------------------

/** One-shot workloads (migration, scheduled job) run as tasks; the rest as services. */
function computeCapabilityKey(workload: Workload): string {
  return workload.kind === 'migration' || workload.kind === 'scheduled-job'
    ? CAPABILITY_KEYS.ECS_FARGATE_TASK
    : CAPABILITY_KEYS.ECS_FARGATE_SERVICE;
}

/**
 * The IAM actions an edge needs against its target capability — only the
 * intents declared for the edge's own access (Phase 5B), so a producer edge
 * never carries consumer actions. An edge without an access matches the
 * intents without one (the pre-Phase-5 behaviour).
 */
function collectIamActions(
  capabilityKey: string | null,
  registry: CapabilityRegistry,
  access: Binding['access'],
): string[] {
  if (!capabilityKey) return [];
  const cap = findCapability(registry, capabilityKey);
  if (!cap?.bindings.iam) return [];
  return cap.bindings.iam.filter((entry) => entry.access === access).flatMap((entry) => entry.actions);
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

  const violations = relationshipViolations(graph);
  if (violations.length > 0) {
    throw new Error(`planner: invalid relationships:\n${violations.join('\n')}`);
  }

  const resolvedCapability = new Map(
    graph.resources.map((r) => [r.id, resolveResourceCapability(r)] as const),
  );
  const workloadCapability = new Map(graph.workloads.map((w) => [w.id, computeCapabilityKey(w)] as const));
  const deadLetterTargets = new Set(
    graph.bindings.filter((b) => b.access === 'dead-letter').map((b) => b.targetId),
  );

  // Every edge with an access must land on a capability: a produce/consume/
  // dead-letter edge to a queue with no capability (e.g. FIFO) fails closed.
  for (const b of graph.bindings) {
    if (b.access !== undefined && b.access !== 'invoke' && !resolvedCapability.get(b.targetId)) {
      throw new Error(`planner: ${b.access} edge ${b.id} targets ${b.targetId}, which resolves to no capability`);
    }
  }

  // Workloads
  const workloads: IrWorkload[] = graph.workloads.map((w) => {
    const bindingTargetIds = graph.bindings
      .filter((b) => b.sourceId === w.id)
      .map((b) => b.targetId);
    const dependencyCapabilityKeys = bindingTargetIds
      .map((targetId) => resolvedCapability.get(targetId))
      // A binding may target another workload (a RUNTIME edge), which has no
      // capability of its own — only resource targets contribute keys.
      .filter((key): key is string => typeof key === 'string');

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

  // Resources — only DEPLOYZ_MANAGED with a resolved capability key
  const resources: IrResource[] = graph.resources
    .filter((r) => {
      const key = resolvedCapability.get(r.id);
      return key !== null && key !== undefined;
    })
    .map((r) => {
      const capabilityKey = resolvedCapability.get(r.id)!;
      const cap = findCapability(registry, capabilityKey);
      return {
        componentId: r.id,
        capabilityKey,
        label: r.label,
        quantity: r.quantity,
        configuration: buildCapabilityConfiguration(capabilityKey, profile, r, deadLetterTargets.has(r.id)),
        lifecycle: (cap?.lifecycle.lifecycle ?? 'retain') as IrResource['lifecycle'],
        scope: 'REGIONAL' as const,
        envBindings: r.envBindings,
      };
    });

  // Bindings
  // An edge's target capability is the target resource's — or, for an
  // invoke edge, the target workload's compute capability.
  const bindings: IrBinding[] = graph.bindings.map((b: Binding) => {
    const targetCapability =
      resolvedCapability.get(b.targetId) ?? (b.access === 'invoke' ? workloadCapability.get(b.targetId) ?? null : null);
    return {
      id: b.id,
      sourceId: b.sourceId,
      targetId: b.targetId,
      envBindings: b.envBindings,
      iamActions: collectIamActions(targetCapability, registry, b.access),
      ...(b.access !== undefined ? { access: b.access } : {}),
      ...(b.maxReceiveCount !== undefined ? { maxReceiveCount: b.maxReceiveCount } : {}),
    };
  });

  // Schedules (Phase 5C) — each resolved from its invoke / dead-letter edges.
  const schedules: IrSchedule[] = (graph.schedules ?? []).map((s) => {
    const edgeTarget = (access: Binding['access']): string | null =>
      graph.bindings.find((b) => b.sourceId === s.id && b.access === access)?.targetId ?? null;
    return {
      id: s.id,
      capabilityKey: CAPABILITY_KEYS.EVENTBRIDGE_SCHEDULER,
      label: s.label,
      expression: s.expression,
      timezone: s.timezone,
      targetWorkloadId: edgeTarget('invoke')!,
      retry: s.retry,
      deadLetterQueueId: edgeTarget('dead-letter'),
      enabled: s.enabled,
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
    schedules,
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

/** The graph's canonical hash — the spec's identity/diff key. */
export function applicationGraphHash(graph: ApplicationGraph): string {
  return stableHash(graph);
}

export function buildDeploymentSpecV2(input: {
  graph: ApplicationGraph;
  ir: DeployzIR;
  sizeProfileId: string;
  capabilityRegistryVersion: string;
  /** Compiler output + published artifact location; absent leaves the spec uncompiled. */
  compilation?: DeploymentSpecCompilation;
}): DeploymentSpecV2 {
  const compilation = input.compilation;
  const spec: DeploymentSpecV2 = {
    schemaVersion: DEPLOYMENT_SPEC_V2_SCHEMA_VERSION,
    infraVersion: INFRA_VERSION_DYNAMIC_COMPILER_V2,
    graph: input.graph,
    ir: input.ir,
    graphHash: stableHash(input.graph),
    irHash: stableHash(input.ir),
    capabilityRegistryVersion: input.capabilityRegistryVersion,
    sizeProfileId: input.sizeProfileId,
    compilerVersion: compilation?.compilerVersion ?? null,
    templateHash: compilation?.templateHash ?? null,
    artifactLocation: compilation?.artifactLocation ?? null,
    verificationContract: compilation?.verificationContract ?? null,
    ownershipRecords: compilation ? [...compilation.ownershipRecords] : null,
    footprint: compilation?.footprint ?? null,
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
