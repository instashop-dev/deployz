/**
 * Runtime health observation — measures what the application is actually
 * doing in ECS and at the load balancer, and derives one of four health
 * verdicts. Lifecycle state and analysis flags say nothing about health;
 * only these observations do.
 */

import type { ServiceEvidence } from '@deployz/contracts';

import type { CloudFormationReader, StackResource } from './verify.js';

export type RuntimeHealthStatus = 'HEALTHY' | 'DEGRADED' | 'UNHEALTHY' | 'UNKNOWN';

/** The ECS service surface this module needs (injectable seam for testing). */
export interface EcsServiceReader {
  describeServices(input: {
    cluster: string;
    services: string[];
  }): Promise<{
    services: {
      serviceArn?: string | undefined;
      desiredCount?: number | undefined;
      runningCount?: number | undefined;
      deployments?: { status?: string | undefined; rolloutState?: string | undefined }[];
      loadBalancers?: { targetGroupArn?: string | undefined }[];
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
  /** One entry per expected workload (or per stack service without a workload list). */
  readonly services: readonly ServiceRuntimeEvidence[];
}

/**
 * What one ECS service reported this observation — the release-evidence
 * fields (see `ServiceEvidence` in contracts) minus the running digests,
 * which come from the task observation.
 */
export type ServiceRuntimeEvidence = Omit<ServiceEvidence, 'runningDigests'>;

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
  /**
   * A normal rollout is under way and no serving capacity is lost: a PRIMARY
   * deployment is IN_PROGRESS, every service that should run has a running
   * task, and the load balancer has a healthy target and no unhealthy one.
   * Missing or pending capacity is then progress, not degradation.
   */
  readonly rolloutProgressing: boolean;
}

/**
 * HEALTHY   — full running count, every target healthy, no failed rollout; or a
 *             rollout in progress that keeps serving.
 * DEGRADED  — still serving (runningCount > 0), but with unhealthy, pending
 *             (`initial`) or unclassified targets, or fewer running
 *             tasks than desired outside a rollout: reachable but not fully
 *             healthy. `initial` is the ALB's "registering" state — it must
 *             never count as healthy, or the first POST-install heartbeat
 *             would claim HEALTHY before a single target answered a probe.
 * UNHEALTHY — nothing serving, or every target unhealthy, or a failed rollout.
 * UNKNOWN   — not derivable from what was observed (no counts, every target
 *             unclassified, or every service intentionally at zero tasks —
 *             "not started", not an outage).
 */
export function deriveHealthStatus(o: HealthObservation): RuntimeHealthStatus {
  if (o.rolloutFailed) return 'UNHEALTHY';
  if (o.runningCount === null || o.desiredCount === null) return 'UNKNOWN';
  if (o.desiredCount === 0) return 'UNKNOWN';
  const allTargetsUnhealthy = o.targetCount > 0 && o.unhealthyTargetCount >= o.targetCount;
  if (o.runningCount === 0 || allTargetsUnhealthy) return 'UNHEALTHY';
  const allTargetsUnknown = o.targetCount > 0 && o.unknownTargetCount >= o.targetCount;
  if (allTargetsUnknown) return 'UNKNOWN';
  if (o.unhealthyTargetCount > 0) return 'DEGRADED';
  if (o.rolloutProgressing) return 'HEALTHY';
  if (o.pendingTargetCount > 0 || o.unknownTargetCount > 0) return 'DEGRADED';
  return o.runningCount >= o.desiredCount ? 'HEALTHY' : 'DEGRADED';
}

export function deriveComponents(o: HealthObservation): {
  application: RuntimeHealthStatus;
  loadBalancer: RuntimeHealthStatus;
} {
  const application =
    o.runningCount === null || o.desiredCount === null
      ? 'UNKNOWN'
      : o.rolloutFailed
        ? 'UNHEALTHY'
        : o.desiredCount === 0
          ? 'UNKNOWN'
          : o.runningCount === 0
            ? 'UNHEALTHY'
            : o.runningCount >= o.desiredCount || o.rolloutProgressing
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
  readonly targetGroupArns: readonly string[];
}

/** Per-workload verdict from its OWN service; `behindHealthyTargets` is false when its load balancer has no healthy target or an unhealthy one. */
function workloadStatus(observation: ServiceObservation, behindHealthyTargets: boolean): RuntimeHealthStatus {
  const { desiredCount, runningCount } = observation;
  if (observation.rolloutFailed) return 'UNHEALTHY';
  if (runningCount === null || desiredCount === null || desiredCount === 0) return 'UNKNOWN';
  if (runningCount === 0) return 'UNHEALTHY';
  if (runningCount >= desiredCount) return 'HEALTHY';
  return observation.primaryRolloutState === 'IN_PROGRESS' && behindHealthyTargets ? 'HEALTHY' : 'DEGRADED';
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
  // The services the verdict must cover: every workload's service, or every
  // stack service when the control plane sent no workload list.
  const expected =
    workloads !== undefined && workloads.length > 0
      ? workloads
      : services.map((service) => ({ id: service.logicalId, serviceLogicalId: service.logicalId }));

  let rolloutFailed = false;
  const perService = new Map<string, ServiceObservation>();
  if (services.length > 0 && cluster) {
    try {
      const { services: described } = await deps.ecs.describeServices({
        cluster,
        services: services.map((service) => service.physicalId),
      });
      // Match each answer to the service that asked for it. A service
      // DescribeServices could not find comes back as a failure, not in
      // `services`, so position alone would shift every later answer. A reader
      // that does not name its services answers in request order.
      const unnamed = described.every((service) => service.serviceArn === undefined);
      for (let i = 0; i < services.length; i++) {
        const service = unnamed
          ? described.length === services.length
            ? described[i]
            : undefined
          : described.find((entry) => entry.serviceArn === services[i]!.physicalId);
        if (!service) continue;
        const observation: ServiceObservation = {
          desiredCount: service.desiredCount ?? null,
          runningCount: service.runningCount ?? null,
          rolloutFailed: service.deployments?.some((d) => d.rolloutState === 'FAILED') ?? false,
          primaryRolloutState: service.deployments?.find((d) => d.status === 'PRIMARY')?.rolloutState ?? null,
          targetGroupArns: (service.loadBalancers ?? []).flatMap((lb) => (lb.targetGroupArn ? [lb.targetGroupArn] : [])),
        };
        perService.set(services[i]!.logicalId, observation);
        if (observation.rolloutFailed) rolloutFailed = true;
      }
    } catch {
      // ECS unreadable: counts unknown, but target health may still be readable.
      perService.clear();
    }
  }
  // An aggregate is only honest when EVERY expected service was observed and
  // reported a count — one missing or unreadable service must leave it
  // "unknown", never a deceptively small or masked sum. Each service counts at
  // most its desired count, so surplus tasks of one service cannot cover a
  // shortfall in another.
  const observedExpected = expected.map((workload) => perService.get(workload.serviceLogicalId));
  const complete = observedExpected.length > 0 && observedExpected.every((o) => o !== undefined);
  const counted = complete ? (observedExpected as ServiceObservation[]) : [];
  const desiredCount =
    complete && counted.every((s) => s.desiredCount !== null)
      ? counted.reduce((sum, s) => sum + (s.desiredCount ?? 0), 0)
      : null;
  const runningCount =
    complete && counted.every((s) => s.runningCount !== null && s.desiredCount !== null)
      ? counted.reduce((sum, s) => sum + Math.min(s.runningCount ?? 0, s.desiredCount ?? 0), 0)
      : null;
  let deploymentRolloutState: string | null = null;
  if (rolloutFailed) {
    deploymentRolloutState = 'FAILED';
  } else if (perService.size > 0) {
    deploymentRolloutState = complete && counted.every((s) => s.primaryRolloutState === 'COMPLETED')
      ? 'COMPLETED'
      : 'IN_PROGRESS';
  }

  let targetCount = 0;
  let healthyTargetCount = 0;
  let unhealthyTargetCount = 0;
  let pendingTargetCount = 0;
  let unknownTargetCount = 0;
  let targetsRead = false;
  if (targetGroupArn) {
    try {
      const described = await deps.elb.describeTargetHealth({ targetGroupArn });
      // A `draining` target is a deregistering task leaving after a rollout:
      // neither serving nor pending, so it is left out of every count.
      const targets = described.targets.filter((t) => t.state !== 'draining');
      targetsRead = true;
      targetCount = targets.length;
      healthyTargetCount = targets.filter((t) => t.state === 'healthy').length;
      unhealthyTargetCount = targets.filter((t) => t.state === 'unhealthy').length;
      // 'initial' means the target is still registering (health checks have
      // not passed yet): not serving yet, never "healthy".
      pendingTargetCount = targets.filter((t) => t.state === 'initial').length;
      // Everything ELB does not classify as healthy/unhealthy/pending
      // (unknown, unused, unavailable) means the verdict cannot be told.
      unknownTargetCount = targets.filter(
        (t) => !['healthy', 'unhealthy', 'initial'].includes(t.state ?? ''),
      ).length;
    } catch {
      // Target health unreadable: derive from ECS counts alone.
    }
  }

  // A rollout that keeps serving: a PRIMARY deployment is IN_PROGRESS and no
  // service that should run has lost all its tasks or (once its own rollout
  // completed) part of its capacity. The load balancer, when one fronts the
  // stack, has a healthy target and no unhealthy one.
  const targetsServing = targetGroupArn === null || (targetsRead && healthyTargetCount > 0 && unhealthyTargetCount === 0);
  const rolloutProgressing =
    !rolloutFailed &&
    complete &&
    counted.some((s) => s.primaryRolloutState === 'IN_PROGRESS') &&
    counted.every(
      (s) =>
        s.desiredCount === 0 ||
        (s.runningCount !== null &&
          s.desiredCount !== null &&
          s.runningCount > 0 &&
          (s.runningCount >= s.desiredCount || s.primaryRolloutState === 'IN_PROGRESS')),
    ) &&
    targetsServing;

  const observation: HealthObservation = {
    desiredCount,
    runningCount,
    targetCount,
    unhealthyTargetCount,
    pendingTargetCount,
    unknownTargetCount,
    rolloutFailed,
    rolloutProgressing,
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
  const behindAlb = (service: ServiceObservation): boolean =>
    targetGroupArn !== null && service.targetGroupArns.includes(targetGroupArn);

  const components: RuntimeHealth['components'] = {
    ...(targetGroupArn ? { loadBalancer: derived.loadBalancer } : {}),
    ...(databaseProvisioned ? { database: 'HEALTHY' as const } : {}),
    ...(storageProvisioned ? { storage: 'HEALTHY' as const } : {}),
    ...(cacheProvisioned ? { redis: 'HEALTHY' as const } : {}),
  };
  if (workloads !== undefined && workloads.length > 0) {
    for (const workload of workloads) {
      const service = perService.get(workload.serviceLogicalId);
      // The workload's service is absent or never completed — omitted, per
      // this module's "not a phantom" rule, never reported as running.
      if (service !== undefined) {
        components[workload.id] = workloadStatus(service, !behindAlb(service) || targetsServing);
      }
    }
  } else if (perService.size > 0) {
    // Legacy single-application shape (no workload list): the aggregate.
    components['application'] = derived.application;
  }

  const evidence: ServiceRuntimeEvidence[] = expected.map((workload) => {
    const service = perService.get(workload.serviceLogicalId);
    if (service === undefined) {
      return {
        workloadId: workload.id,
        serviceLogicalId: workload.serviceLogicalId,
        observed: false,
        desiredCount: null,
        runningCount: null,
        rolloutState: null,
        targets: null,
      };
    }
    return {
      workloadId: workload.id,
      serviceLogicalId: workload.serviceLogicalId,
      observed: true,
      desiredCount: service.desiredCount,
      runningCount: service.runningCount,
      rolloutState: service.primaryRolloutState,
      targets:
        behindAlb(service) && targetsRead
          ? {
              healthy: healthyTargetCount,
              unhealthy: unhealthyTargetCount,
              pending: pendingTargetCount,
              unknown: unknownTargetCount,
            }
          : null,
    };
  });

  return {
    healthStatus: deriveHealthStatus(observation),
    components,
    desiredCount,
    runningCount,
    unhealthyTargetCount,
    pendingTargetCount,
    unknownTargetCount,
    deploymentRolloutState,
    services: evidence,
  };
}
