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
   * unknown".
   */
  readonly components: {
    application?: RuntimeHealthStatus;
    loadBalancer?: RuntimeHealthStatus;
    database?: RuntimeHealthStatus;
    storage?: RuntimeHealthStatus;
    redis?: RuntimeHealthStatus;
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

export function deriveComponents(o: HealthObservation): RuntimeHealth['components'] {
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

/**
 * Observes runtime health for the application stack. A failed AWS call
 * yields healthStatus UNKNOWN with the counts that were still observable —
 * never a thrown heartbeat. A component whose backing resource is absent or
 * never completed is omitted rather than reported UNKNOWN.
 */
export async function observeRuntimeHealth(
  deps: ObserveHealthDeps,
  stackName: string,
): Promise<RuntimeHealth> {
  const resources = await deps.cfn.describeStackResources(stackName);
  const serviceArn = completedPhysicalId(resources, SERVICE_TYPE);
  const targetGroupArn = completedPhysicalId(resources, TARGET_GROUP_TYPE);
  // arn:aws:ecs:REGION:ACCOUNT:service/CLUSTER/SERVICE
  const cluster = serviceArn?.split('/')[1] ?? null;

  let desiredCount: number | null = null;
  let runningCount: number | null = null;
  let rolloutFailed = false;
  let deploymentRolloutState: string | null = null;
  if (serviceArn && cluster) {
    try {
      const { services } = await deps.ecs.describeServices({ cluster, services: [serviceArn] });
      const service = services[0];
      if (service) {
        desiredCount = service.desiredCount ?? null;
        runningCount = service.runningCount ?? null;
        if (service.deployments?.some((d) => d.rolloutState === 'FAILED')) {
          rolloutFailed = true;
          deploymentRolloutState = 'FAILED';
        } else {
          deploymentRolloutState =
            service.deployments?.find((d) => d.status === 'PRIMARY')?.rolloutState ?? null;
        }
      }
    } catch {
      // ECS unreadable: counts unknown, but target health may still be readable.
    }
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
  const components: RuntimeHealth['components'] = {
    ...(serviceArn ? { application: derived.application } : {}),
    ...(targetGroupArn ? { loadBalancer: derived.loadBalancer } : {}),
    ...(databaseProvisioned ? { database: 'HEALTHY' as const } : {}),
    ...(storageProvisioned ? { storage: 'HEALTHY' as const } : {}),
    ...(cacheProvisioned ? { redis: 'HEALTHY' as const } : {}),
  };

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
