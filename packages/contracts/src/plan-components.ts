import { CAPABILITY_KEYS } from './capability-registry.js';
import type { DeploymentSpecV2 } from './deployment-spec-v2.js';
import type { IrResource, IrWorkload } from './deployz-ir.js';
import { INFRASTRUCTURE_COMPONENT_DISPLAY } from './infrastructure.js';
import { planComponentKindSchema } from './plan.js';
import type { DeploymentPlanComponent, PlanComponentGroup } from './plan.js';

// ---------------------------------------------------------------------------
// Spec-derived plan components — the presentation foundation for dynamic
// infrastructure (phase 3). Maps a frozen DeploymentSpecV2's IR onto the
// generic plan component shape. Pure and dependency-free: no registry
// lookups, no label upgrades (the IR's own labels stand in; the API layer
// resolves registry presentation labels on top). Unknown/future capability
// keys never crash and never drop their entry.
// ---------------------------------------------------------------------------

/**
 * Placeholder kind for a component whose capability key is not in the
 * current capability map. The entry stays in the list and renders as a
 * generic application component until its capability is registered.
 */
export const UNKNOWN_PLAN_COMPONENT_KIND: DeploymentPlanComponent['kind'] = 'application';

/**
 * The ONE kind→group mapping — the API and web render groups from this and
 * must not re-derive it. `schedule` rides the messaging group for the MVP;
 * there is no scheduling group yet.
 */
export const PLAN_COMPONENT_GROUP_BY_KIND: Readonly<
  Record<DeploymentPlanComponent['kind'], PlanComponentGroup>
> = {
  application: 'application',
  worker: 'application',
  endpoint: 'edge',
  database: 'data',
  cache: 'cache',
  storage: 'storage',
  queue: 'messaging',
  schedule: 'messaging',
};

/** Current registry capability keys → plan component kinds. */
const KIND_BY_CAPABILITY_KEY: Readonly<Record<string, DeploymentPlanComponent['kind']>> = {
  [CAPABILITY_KEYS.ECS_FARGATE_SERVICE]: 'application',
  [CAPABILITY_KEYS.ECS_FARGATE_TASK]: 'worker',
  [CAPABILITY_KEYS.RDS_POSTGRES]: 'database',
  [CAPABILITY_KEYS.RDS_MYSQL]: 'database',
  [CAPABILITY_KEYS.ELASTICACHE_VALKEY]: 'cache',
  [CAPABILITY_KEYS.S3]: 'storage',
  [CAPABILITY_KEYS.ALB]: 'endpoint',
};

function workloadKind(workload: IrWorkload): DeploymentPlanComponent['kind'] {
  const byCapability = KIND_BY_CAPABILITY_KEY[workload.compute.capabilityKey];
  if (byCapability) return byCapability;
  // Unknown capability — keep the entry with the IR kind when that is a
  // valid plan kind ('worker'), else the stable placeholder. The schema is
  // read here, not at module top level: this module is reached through the
  // index.ts import cycle while plan.ts is still initializing.
  return (planComponentKindSchema.options as readonly string[]).includes(workload.kind)
    ? (workload.kind as DeploymentPlanComponent['kind'])
    : UNKNOWN_PLAN_COMPONENT_KIND;
}

function resourceKind(resource: IrResource): DeploymentPlanComponent['kind'] {
  return KIND_BY_CAPABILITY_KEY[resource.capabilityKey] ?? UNKNOWN_PLAN_COMPONENT_KIND;
}

/**
 * The components a frozen spec's infrastructure would present. Components
 * always read as 'UNCHANGED' — a frozen spec describes what exists, not a
 * pending change; the API layer sets actions when a plan proposes one.
 * Deterministic: the same spec always yields the same list.
 */
export function derivePlanComponentsFromSpec(spec: DeploymentSpecV2): DeploymentPlanComponent[] {
  const entries: DeploymentPlanComponent[] = [];

  for (const workload of spec.ir.workloads) {
    const kind = workloadKind(workload);
    entries.push({
      kind,
      name: workload.label,
      action: 'UNCHANGED',
      lifecycle: 'delete',
      componentId: workload.componentId,
      group: PLAN_COMPONENT_GROUP_BY_KIND[kind],
    });
  }

  // The public endpoint is not an IR resource — it rides `ingress`. Its
  // componentId matches the compiler's and resolver's 'endpoint' convention.
  if (spec.ir.ingress.public && spec.ir.ingress.capabilityKey === CAPABILITY_KEYS.ALB) {
    entries.push({
      kind: 'endpoint',
      name: INFRASTRUCTURE_COMPONENT_DISPLAY.endpoint.name,
      action: 'UNCHANGED',
      lifecycle: 'delete',
      componentId: 'endpoint',
      group: PLAN_COMPONENT_GROUP_BY_KIND.endpoint,
    });
  }

  for (const resource of spec.ir.resources) {
    const kind = resourceKind(resource);
    entries.push({
      kind,
      name: resource.label,
      action: 'UNCHANGED',
      lifecycle: resource.lifecycle,
      componentId: resource.componentId,
      group: PLAN_COMPONENT_GROUP_BY_KIND[kind],
    });
  }

  // A componentId is an identity — a graph that both models the endpoint as
  // a resource and declares public ingress must not yield it twice.
  const seen = new Set<string>();
  return entries.filter((entry) => {
    if (seen.has(entry.componentId!)) return false;
    seen.add(entry.componentId!);
    return true;
  });
}
