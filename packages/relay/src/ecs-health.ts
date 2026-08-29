/**
 * Runtime health observation — measures what the application is actually
 * doing in ECS and at the load balancer, and derives one of four health
 * verdicts. Lifecycle state and analysis flags say nothing about health;
 * only these observations do.
 */

import type { CloudFormationReader } from './verify.js';

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
  readonly components: { application: RuntimeHealthStatus; loadBalancer: RuntimeHealthStatus };
  readonly desiredCount: number | null;
  readonly runningCount: number | null;
  readonly unhealthyTargetCount: number | null;
  readonly deploymentRolloutState: string | null;
}

/** The inputs the verdict is derived from — pure, so the rules are testable. */
export interface HealthObservation {
  readonly desiredCount: number | null;
  readonly runningCount: number | null;
  readonly targetCount: number;
  readonly unhealthyTargetCount: number;
  readonly rolloutFailed: boolean;
}

/**
 * HEALTHY   — full running count, every target healthy, no failed rollout.
 * DEGRADED  — still serving (runningCount > 0) but one or more targets unhealthy.
 * UNHEALTHY — nothing serving, or every target unhealthy, or a failed rollout.
 * UNKNOWN   — not derivable from what was observed.
 */
export function deriveHealthStatus(o: HealthObservation): RuntimeHealthStatus {
  if (o.rolloutFailed) return 'UNHEALTHY';
  if (o.runningCount === null || o.desiredCount === null) return 'UNKNOWN';
  const allTargetsUnhealthy = o.targetCount > 0 && o.unhealthyTargetCount >= o.targetCount;
  if (o.runningCount === 0 || allTargetsUnhealthy) return 'UNHEALTHY';
  const fullyRunning = o.runningCount >= o.desiredCount && o.desiredCount > 0;
  if (fullyRunning && o.unhealthyTargetCount === 0) return 'HEALTHY';
  if (o.unhealthyTargetCount > 0) return 'DEGRADED';
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
  const loadBalancer =
    o.targetCount === 0 ? 'UNKNOWN' : allTargetsUnhealthy(o) ? 'UNHEALTHY' : o.unhealthyTargetCount > 0 ? 'DEGRADED' : 'HEALTHY';
  return { application, loadBalancer };
}

function allTargetsUnhealthy(o: HealthObservation): boolean {
  return o.targetCount > 0 && o.unhealthyTargetCount >= o.targetCount;
}

const SERVICE_TYPE = 'AWS::ECS::Service';
const TARGET_GROUP_TYPE = 'AWS::ElasticLoadBalancingV2::TargetGroup';

/**
 * Observes runtime health for the application stack. A missing service or a
 * failed AWS call yields healthStatus UNKNOWN with the counts that were
 * still observable — never a thrown heartbeat.
 */
export async function observeRuntimeHealth(
  deps: ObserveHealthDeps,
  stackName: string,
): Promise<RuntimeHealth> {
  const resources = await deps.cfn.describeStackResources(stackName);
  const serviceArn = resources.find((r) => r.type === SERVICE_TYPE)?.physicalId ?? null;
  const targetGroupArn =
    resources.find((r) => r.type === TARGET_GROUP_TYPE)?.physicalId ?? null;
  if (!serviceArn) {
    return unknownHealth();
  }
  // arn:aws:ecs:REGION:ACCOUNT:service/CLUSTER/SERVICE
  const cluster = serviceArn.split('/')[1] ?? null;
  if (!cluster) {
    return unknownHealth();
  }

  let desiredCount: number | null = null;
  let runningCount: number | null = null;
  let rolloutFailed = false;
  let deploymentRolloutState: string | null = null;
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

  let targetCount = 0;
  let unhealthyTargetCount = 0;
  if (targetGroupArn) {
    try {
      const { targets } = await deps.elb.describeTargetHealth({ targetGroupArn });
      targetCount = targets.length;
      unhealthyTargetCount = targets.filter((t) => t.state === 'unhealthy').length;
    } catch {
      // Target health unreadable: derive from ECS counts alone.
    }
  }

  const observation: HealthObservation = {
    desiredCount,
    runningCount,
    targetCount,
    unhealthyTargetCount,
    rolloutFailed,
  };
  return {
    healthStatus: deriveHealthStatus(observation),
    components: deriveComponents(observation),
    desiredCount,
    runningCount,
    unhealthyTargetCount,
    deploymentRolloutState,
  };
}

function unknownHealth(): RuntimeHealth {
  return {
    healthStatus: 'UNKNOWN',
    components: { application: 'UNKNOWN', loadBalancer: 'UNKNOWN' },
    desiredCount: null,
    runningCount: null,
    unhealthyTargetCount: null,
    deploymentRolloutState: null,
  };
}
