/**
 * Runtime health observation — measures what the application is actually
 * doing in ECS and at the load balancer, and derives one of four health
 * verdicts. Lifecycle state and analysis flags say nothing about health;
 * only these observations do.
 */

import type { CloudFormationReader, StackResource } from './verify.js';

export type RuntimeHealthStatus = 'HEALTHY' | 'DEGRADED' | 'UNHEALTHY' | 'UNKNOWN';

/** The ECS service surface this module needs (injectable seam for testing). */
export interface EcsServiceReader {
  describeServices(input: {
    cluster: string;
    services: string[];
  }): Promise<{
    services: {
      desiredCount?: number | undefined;
      runningCount?: number | undefined;
      deployments?: { status?: string | undefined; rolloutState?: string | undefined }[];
    }[];
  }>;
}

/** The ELBv2 target-health surface this module needs. */
export interface TargetHealthReader {
  describeTargetHealth(input: {
    targetGroupArn: string;
  }): Promise<{ targets: { state?: string | undefined }[] }>;
}

export interface ObserveHealthDeps {
  readonly cfn: CloudFormationReader;
  readonly ecs: EcsServiceReader;
  readonly elb: TargetHealthReader;
}

/** Everything one heartbeat reports about runtime health. */
export interface RuntimeHealth {
  readonly healthStatus: RuntimeHealthStatus;
  /**
   * A component is omitted, not `UNKNOWN`, when its backing resource never
   * reached a complete state — a rolled-back stack's phantom service or
   * target-group reference must not be reported as "running, health
   * unknown". With a workload list (Phase 4A) each workload's health rides
   * under its own id (`web`, `email-worker`, …); without one, the legacy
   * single `application` key carries the aggregate.
   */
  readonly components: {
    application?: RuntimeHealthStatus;
    loadBalancer?: RuntimeHealthStatus;
    database?: RuntimeHealthStatus;
    storage?: RuntimeHealthStatus;
    redis?: RuntimeHealthStatus;
    [workloadId: string]: RuntimeHealthStatus | undefined;
  };
  readonly desiredCount: number | null;
  readonly runningCount: number | null;
  readonly unhealthyTargetCount: number | null;
  /** Targets still registering or draining — `initial`/`draining` (serving, but pending). */
  readonly pendingTargetCount: number | null;
  /** Targets whose ELB state the API did not classify — `unknown`, `unused`, `unavailable`. */
  readonly unknownTargetCount: number | null;
  readonly deploymentRolloutState: string | null;
}

/** The inputs the verdict is derived from — pure, so the rules are testable. */
export interface HealthObservation {
  readonly desiredCount: number | null;
  readonly runningCount: number | null;
  readonly targetCount: number;
  readonly unhealthyTargetCount: number;
  /** Targets in `initial`/`draining` — the ALB is not fully ready, but not failing either. */
  readonly pendingTargetCount: number;
  /** Targets ELB reports in an unclassified state — the ALB verdict cannot be told. */
  readonly unknownTargetCount: number;
  readonly rolloutFailed: boolean;
}

/**
 * HEALTHY   — full running count, every target healthy, no failed rollout.
 * DEGRADED  — still serving (runningCount > 0), but with unhealthy, pending
 *             (`initial`/`draining`) or unclassified targets: reachable but not
 *             fully healthy. `initial` is the ALB's "registering" state — it
 *             must never count as healthy, or the first POST-install heartbeat
 *             would claim HEALTHY before a single target answered a probe.
 * UNHEALTHY — nothing serving, or every target unhealthy, or a failed rollout.
 * UNKNOWN   — not derivable from what was observed (no counts, or every target
 *             unclassified).
 */
export function deriveHealthStatus(o: HealthObservation): RuntimeHealthStatus {
  if (o.rolloutFailed) return 'UNHEALTHY';
  if (o.runningCount === null || o.desiredCount === null) return 'UNKNOWN';
  const allTargetsUnhealthy = o.targetCount > 0 && o.unhealthyTargetCount >= o.targetCount;
  if (o.runningCount === 0 || allTargetsUnhealthy) return 'UNHEALTHY';
  const allTargetsUnknown = o.targetCount > 0 && o.unknownTargetCount >= o.targetCount;
  if (allTargetsUnknown) return 'UNKNOWN';
  const fullyRunning = o.runningCount >= o.desiredCount && o.desiredCount > 0;
  if (o.unhealthyTargetCount > 0) return 'DEGRADED';
  if (o.pendingTargetCount > 0 || o.unknownTargetCount > 0) return 'DEGRADED';
  return fullyRunning ? 'HEALTHY' : 'DEGRADED';
}

export function deriveComponents(o: HealthObservation): {
  application: RuntimeHealthStatus;
  loadBalancer: RuntimeHealthStatus;
} {
  const application =
    o.runningCount === null || o.desiredCount === null
      ? 'UNKNOWN'
      : o.rolloutFailed || o.runningCount === 0
        ? 'UNHEALTHY'
        : o.runningCount >= o.desiredCount
          ? 'HEALTHY'
          : 'DEGRADED';
  // Known-bad targets outrank the unknown signal; an unclassified target that
  // is not known-bad leaves the ALB verdict UNKNOWN until ELB says more.
  const loadBalancer =
    o.targetCount === 0
      ? 'UNKNOWN'
      : allTargetsUnhealthy(o)
        ? 'UNHEALTHY'
        : o.unhealthyTargetCount > 0
          ? 'DEGRADED'
          : o.unknownTargetCount > 0
            ? 'UNKNOWN'
            : o.pendingTargetCount > 0
              ? 'DEGRADED'
              : 'HEALTHY';
  return { application, loadBalancer };
}

function allTargetsUnhealthy(o: HealthObservation): boolean {
  return o.targetCount > 0 && o.unhealthyTargetCount >= o.targetCount;
}

const SERVICE_TYPE = 'AWS::ECS::Service';
const TARGET_GROUP_TYPE = 'AWS::ElasticLoadBalancingV2::TargetGroup';
const DATABASE_TYPE = 'AWS::RDS::DBInstance';
const STORAGE_TYPE = 'AWS::S3::Bucket';
const CACHE_TYPE = 'AWS::ElastiCache::ReplicationGroup';

/** Resource statuses whose physicalId actually backs live infrastructure. */
const RESOURCE_COMPLETE_STATUSES: ReadonlySet<string> = new Set(['CREATE_COMPLETE', 'UPDATE_COMPLETE']);

/**
 * A rolled-back stack still has a `CREATE_FAILED` (or `DELETE_COMPLETE`)
 * resource record with a physicalId attached — CloudFormation does not erase
 * it. Using that id would ask ECS/ELB about infrastructure that no longer
 * backs the stack, so a physicalId only counts once its resource reached a
 * complete state.
 */
function completedPhysicalId(resources: readonly StackResource[], type: string): string | null {
  const resource = resources.find((r) => r.type === type);
  if (!resource?.physicalId) return null;
  return RESOURCE_COMPLETE_STATUSES.has(resource.status) ? resource.physicalId : null;
}

/** Every completed resource of one type, with its logical id. */
function completedResources(resources: readonly StackResource[], type: string): { logicalId: string; physicalId: string }[] {
  return resources
    .filter((r) => r.type === type && r.physicalId !== undefined && RESOURCE_COMPLETE_STATUSES.has(r.status))
    .map((r) => ({ logicalId: r.logicalId, physicalId: r.physicalId! }));
}

/** One ECS service's observed rollout state. */
interface ServiceObservation {
  readonly desiredCount: number | null;
  readonly runningCount: number | null;
  readonly rolloutFailed: boolean;
  readonly primaryRolloutState: string | null;
}

/**
 * Observes runtime health for the application stack. A failed AWS call
 * yields healthStatus UNKNOWN with the counts that were still observable —
 * never a thrown heartbeat. A component whose backing resource is absent or
 * never completed is omitted rather than reported UNKNOWN.
 *
 * `workloads` (Phase 4A) names each compiled workload and the logical id of
 * the ECS service backing it, so every workload reports health under its own
 * id — a worker has no ALB target and no HTTP health check, so its service
 * counts and rollout state ARE its health. Absent (an older control plane),
 * the single `application` key carries the aggregate exactly as before.
 */
export async function observeRuntimeHealth(
  deps: ObserveHealthDeps,
  stackName: string,
  workloads?: readonly { readonly id: string; readonly serviceLogicalId: string }[],
): Promise<RuntimeHealth> {
  const resources = await deps.cfn.describeStackResources(stackName);
  const services = completedResources(resources, SERVICE_TYPE);
  const firstServiceArn = services[0]?.physicalId ?? null;
  const targetGroupArn = completedPhysicalId(resources, TARGET_GROUP_TYPE);
  // arn:aws:ecs:REGION:ACCOUNT:service/CLUSTER/SERVICE
  const cluster = firstServiceArn?.split('/')[1] ?? null;

  let desiredCount: number | null = null;
  let runningCount: number | null = null;
  let rolloutFailed = false;
  let deploymentRolloutState: string | null = null;
  const perService = new Map<string, ServiceObservation>();
  if (services.length > 0 && cluster) {
    try {
      const { services: described } = await deps.ecs.describeServices({
        cluster,
        services: services.map((service) => service.physicalId),
      });
      // DescribeServices answers in request order; zip so each observation
      // lands on the service (and therefore workload) that asked for it.
      for (let i = 0; i < services.length; i++) {
        const service = described[i];
        if (!service) continue;
        const observation: ServiceObservation = {
          desiredCount: service.desiredCount ?? null,
          runningCount: service.runningCount ?? null,
          rolloutFailed: service.deployments?.some((d) => d.rolloutState === 'FAILED') ?? false,
          primaryRolloutState: service.deployments?.find((d) => d.status === 'PRIMARY')?.rolloutState ?? null,
        };
        perService.set(services[i]!.logicalId, observation);
        if (observation.rolloutFailed) rolloutFailed = true;
      }
      // An aggregate count is only honest when EVERY observed service
      // reported one — a single unreadable service must leave the aggregate
      // "unknown", never a deceptively small sum.
      const observed = [...perService.values()];
      desiredCount = observed.every((s) => s.desiredCount !== null)
        ? observed.reduce((sum, s) => sum + (s.desiredCount ?? 0), 0)
        : null;
      runningCount = observed.every((s) => s.runningCount !== null)
        ? observed.reduce((sum, s) => sum + (s.runningCount ?? 0), 0)
        : null;
    } catch {
      // ECS unreadable: counts unknown, but target health may still be readable.
      desiredCount = null;
      runningCount = null;
    }
  }
  if (rolloutFailed) {
    deploymentRolloutState = 'FAILED';
  } else if (perService.size > 0) {
    deploymentRolloutState = [...perService.values()].every((s) => s.primaryRolloutState === 'COMPLETED')
      ? 'COMPLETED'
      : 'IN_PROGRESS';
  }

  let targetCount = 0;
  let unhealthyTargetCount = 0;
  let pendingTargetCount = 0;
  let unknownTargetCount = 0;
  if (targetGroupArn) {
    try {
      const { targets } = await deps.elb.describeTargetHealth({ targetGroupArn });
      targetCount = targets.length;
      unhealthyTargetCount = targets.filter((t) => t.state === 'unhealthy').length;
      // 'initial' means the target is still registering (health checks have
      // not passed yet); 'draining' marks a target being drained before
      // deregistration. Both mean "not serving yet", never "healthy".
      pendingTargetCount = targets.filter(
        (t) => t.state === 'initial' || t.state === 'draining',
      ).length;
      // Everything ELB does not classify as healthy/unhealthy/pending
      // (unknown, unused, unavailable) means the verdict cannot be told.
      unknownTargetCount = targets.filter(
        (t) => !['healthy', 'unhealthy', 'initial', 'draining'].includes(t.state ?? ''),
      ).length;
    } catch {
      // Target health unreadable: derive from ECS counts alone.
    }
  }

  const observation: HealthObservation = {
    desiredCount,
    runningCount,
    targetCount,
    unhealthyTargetCount,
    pendingTargetCount,
    unknownTargetCount,
    rolloutFailed,
  };
  // The cache, database and storage have no runtime probe (no describe
  // calls, by the same IAM-frugality that keeps this module to ECS + ELB
  // reads), so their components report what CloudFormation observed: a
  // resource in a complete state IS what the install verified. Absent or
  // incomplete, the component is omitted per this module's rule.
  const cacheProvisioned = completedPhysicalId(resources, CACHE_TYPE) !== null;
  const databaseProvisioned = completedPhysicalId(resources, DATABASE_TYPE) !== null;
  const storageProvisioned = completedPhysicalId(resources, STORAGE_TYPE) !== null;

  const derived = deriveComponents(observation);
  /** Per-workload verdict from its OWN service — no targets, no HTTP probe. */
  const workloadStatus = (observation: ServiceObservation): RuntimeHealthStatus =>
    observation.rolloutFailed
      ? 'UNHEALTHY'
      : observation.runningCount === null || observation.desiredCount === null
        ? 'UNKNOWN'
        : observation.runningCount === 0
          ? 'UNHEALTHY'
          : observation.runningCount >= observation.desiredCount
            ? 'HEALTHY'
            : 'DEGRADED';

  const components: RuntimeHealth['components'] = {
    ...(targetGroupArn ? { loadBalancer: derived.loadBalancer } : {}),
    ...(databaseProvisioned ? { database: 'HEALTHY' as const } : {}),
    ...(storageProvisioned ? { storage: 'HEALTHY' as const } : {}),
    ...(cacheProvisioned ? { redis: 'HEALTHY' as const } : {}),
  };
  if (workloads !== undefined && workloads.length > 0) {
    for (const workload of workloads) {
      const observation = perService.get(workload.serviceLogicalId);
      // The workload's service is absent or never completed — omitted, per
      // this module's "not a phantom" rule, never reported as running.
      if (observation !== undefined) components[workload.id] = workloadStatus(observation);
    }
  } else if (perService.size > 0) {
    // Legacy single-application shape (no workload list): the aggregate.
    components['application'] = derived.application;
  }

  return {
    healthStatus: deriveHealthStatus(observation),
    components,
    desiredCount,
    runningCount,
    unhealthyTargetCount,
    pendingTargetCount,
    unknownTargetCount,
    deploymentRolloutState,
  };
}
