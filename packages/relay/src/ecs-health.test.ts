import { describe, expect, it, vi } from 'vitest';

import {
  deriveComponents,
  deriveHealthStatus,
  observeRuntimeHealth,
  type EcsServiceReader,
  type TargetHealthReader,
} from './ecs-health.js';
import type { CloudFormationReader, StackResource } from './verify.js';

function observation(overrides: Partial<Parameters<typeof deriveHealthStatus>[0]> = {}) {
  return {
    desiredCount: 1,
    runningCount: 1,
    targetCount: 1,
    unhealthyTargetCount: 0,
    pendingTargetCount: 0,
    unknownTargetCount: 0,
    rolloutFailed: false,
    ...overrides,
  };
}

describe('deriveHealthStatus', () => {
  it('HEALTHY when fully running with all targets healthy', () => {
    expect(deriveHealthStatus(observation())).toBe('HEALTHY');
  });

  it('DEGRADED when serving with unhealthy targets', () => {
    expect(deriveHealthStatus(observation({ targetCount: 2, unhealthyTargetCount: 1 }))).toBe(
      'DEGRADED',
    );
  });

  it('DEGRADED when still scaling up', () => {
    expect(deriveHealthStatus(observation({ desiredCount: 2, runningCount: 1 }))).toBe('DEGRADED');
  });

  it('UNHEALTHY when nothing is running', () => {
    expect(deriveHealthStatus(observation({ runningCount: 0 }))).toBe('UNHEALTHY');
  });

  it('UNHEALTHY when all targets are unhealthy', () => {
    expect(
      deriveHealthStatus(observation({ targetCount: 2, unhealthyTargetCount: 2 })),
    ).toBe('UNHEALTHY');
  });

  it('DEGRADED while targets are still registering (initial) — never HEALTHY before a probe passes', () => {
    expect(deriveHealthStatus(observation({ targetCount: 2, pendingTargetCount: 2 }))).toBe(
      'DEGRADED',
    );
  });

  it('DEGRADED while targets are draining', () => {
    expect(deriveHealthStatus(observation({ targetCount: 1, pendingTargetCount: 1 }))).toBe(
      'DEGRADED',
    );
  });

  it('DEGRADED when some targets are healthy and some pending', () => {
    expect(
      deriveHealthStatus(observation({ targetCount: 2, pendingTargetCount: 1 })),
    ).toBe('DEGRADED');
  });

  it('UNKNOWN when every target state is unclassified', () => {
    expect(deriveHealthStatus(observation({ targetCount: 2, unknownTargetCount: 2 }))).toBe(
      'UNKNOWN',
    );
  });

  it('DEGRADED when unclassified targets mix with a healthy verdict', () => {
    expect(
      deriveHealthStatus(observation({ targetCount: 2, unknownTargetCount: 1 })),
    ).toBe('DEGRADED');
  });

  it('UNHEALTHY when the ECS rollout failed', () => {
    expect(deriveHealthStatus(observation({ rolloutFailed: true }))).toBe('UNHEALTHY');
  });

  it('UNKNOWN when the counts could not be observed', () => {
    expect(deriveHealthStatus(observation({ runningCount: null, desiredCount: null }))).toBe(
      'UNKNOWN',
    );
  });
});

describe('deriveComponents', () => {
  it('derives application and load balancer independently', () => {
    expect(deriveComponents(observation())).toEqual({
      application: 'HEALTHY',
      loadBalancer: 'HEALTHY',
    });
    expect(deriveComponents(observation({ targetCount: 2, unhealthyTargetCount: 1 }))).toEqual({
      application: 'HEALTHY',
      loadBalancer: 'DEGRADED',
    });
    expect(deriveComponents(observation({ targetCount: 0 }))).toEqual({
      application: 'HEALTHY',
      loadBalancer: 'UNKNOWN',
    });
    // initial/draining targets keep the ALB from claiming healthy.
    expect(deriveComponents(observation({ targetCount: 2, pendingTargetCount: 2 }))).toEqual({
      application: 'HEALTHY',
      loadBalancer: 'DEGRADED',
    });
    // unclassified targets leave the ALB verdict unknown, not healthy.
    expect(deriveComponents(observation({ targetCount: 1, unknownTargetCount: 1 }))).toEqual({
      application: 'HEALTHY',
      loadBalancer: 'UNKNOWN',
    });
  });
});

// ── Orchestration ────────────────────────────────────────────────────────────

const SERVICE_ARN = 'arn:aws:ecs:us-east-1:151955775369:service/app-cluster/app-service';

function cfnWith(resources: StackResource[]): CloudFormationReader {
  return {
    async describeStack() {
      return { found: true, stack: { stackName: 'deployz-app', status: 'CREATE_COMPLETE', tags: {} } };
    },
    async describeStackResources() {
      return resources;
    },
  };
}

const STACK = [
  { logicalId: 'Service', type: 'AWS::ECS::Service', status: 'CREATE_COMPLETE', physicalId: SERVICE_ARN },
  { logicalId: 'Targets', type: 'AWS::ElasticLoadBalancingV2::TargetGroup', status: 'CREATE_COMPLETE', physicalId: 'arn:aws:elasticloadbalancing:us-east-1:151955775369:targetgroup/app/abc' },
] as const;

function ecsWith(service?: {
  desiredCount?: number | undefined;
  runningCount?: number | undefined;
  deployments?: { status?: string | undefined; rolloutState?: string | undefined }[];
}): EcsServiceReader {
  return {
    async describeServices() {
      return { services: service ? [service] : [] };
    },
  };
}

function elbWith(states: string[]): TargetHealthReader {
  return {
    async describeTargetHealth() {
      return { targets: states.map((state) => ({ state })) };
    },
  };
}

describe('observeRuntimeHealth', () => {
  it('observes healthy counts and healthy targets', async () => {
    const health = await observeRuntimeHealth(
      {
        cfn: cfnWith([...STACK]),
        ecs: ecsWith({ desiredCount: 1, runningCount: 1, deployments: [{ status: 'PRIMARY', rolloutState: 'COMPLETED' }] }),
        elb: elbWith(['healthy']),
      },
      'deployz-app',
    );
    expect(health.healthStatus).toBe('HEALTHY');
    expect(health.desiredCount).toBe(1);
    expect(health.unhealthyTargetCount).toBe(0);
    expect(health.deploymentRolloutState).toBe('COMPLETED');
    // No cache in this stack — the redis component must be omitted, not
    // reported, so the dashboard's Redis row stays driven by the observe
    // hook's cache check alone.
    expect(health.components.redis).toBeUndefined();
  });

  it('reports the redis component HEALTHY when the stack has a complete replication group', async () => {
    const health = await observeRuntimeHealth(
      {
        cfn: cfnWith([
          ...STACK,
          { logicalId: 'Cache', type: 'AWS::ElastiCache::ReplicationGroup', status: 'CREATE_COMPLETE', physicalId: 'dec1abc' },
        ]),
        ecs: ecsWith({ desiredCount: 1, runningCount: 1, deployments: [{ status: 'PRIMARY', rolloutState: 'COMPLETED' }] }),
        elb: elbWith(['healthy']),
      },
      'deployz-app',
    );
    expect(health.components.redis).toBe('HEALTHY');
  });

  it('reports database and storage components when the stack carries complete RDS and S3 resources', async () => {
    const health = await observeRuntimeHealth(
      {
        cfn: cfnWith([
          ...STACK,
          { logicalId: 'Database', type: 'AWS::RDS::DBInstance', status: 'CREATE_COMPLETE', physicalId: 'app-db' },
          { logicalId: 'Storage', type: 'AWS::S3::Bucket', status: 'CREATE_COMPLETE', physicalId: 'app-bucket' },
        ]),
        ecs: ecsWith({ desiredCount: 1, runningCount: 1, deployments: [{ status: 'PRIMARY', rolloutState: 'COMPLETED' }] }),
        elb: elbWith(['healthy']),
      },
      'deployz-app',
    );
    expect(health.components.database).toBe('HEALTHY');
    expect(health.components.storage).toBe('HEALTHY');
  });

  it('omits database and storage when the stack has neither resource', async () => {
    const health = await observeRuntimeHealth(
      {
        cfn: cfnWith([...STACK]),
        ecs: ecsWith({ desiredCount: 1, runningCount: 1, deployments: [{ status: 'PRIMARY', rolloutState: 'COMPLETED' }] }),
        elb: elbWith(['healthy']),
      },
      'deployz-app',
    );
    expect(health.components.database).toBeUndefined();
    expect(health.components.storage).toBeUndefined();
  });

  it('omits the redis component for a cache that never reached a complete state', async () => {
    const health = await observeRuntimeHealth(
      {
        cfn: cfnWith([
          ...STACK,
          { logicalId: 'Cache', type: 'AWS::ElastiCache::ReplicationGroup', status: 'CREATE_FAILED', physicalId: 'dec1abc' },
        ]),
        ecs: ecsWith({ desiredCount: 1, runningCount: 1, deployments: [{ status: 'PRIMARY', rolloutState: 'COMPLETED' }] }),
        elb: elbWith(['healthy']),
      },
      'deployz-app',
    );
    expect(health.components.redis).toBeUndefined();
  });

  it('reports UNHEALTHY with a failed rollout', async () => {
    const health = await observeRuntimeHealth(
      {
        cfn: cfnWith([...STACK]),
        ecs: ecsWith({ desiredCount: 1, runningCount: 1, deployments: [{ status: 'PRIMARY', rolloutState: 'FAILED' }] }),
        elb: elbWith(['healthy']),
      },
      'deployz-app',
    );
    expect(health.healthStatus).toBe('UNHEALTHY');
    expect(health.deploymentRolloutState).toBe('FAILED');
  });

  it('returns UNKNOWN when the stack has no ECS service', async () => {
    const health = await observeRuntimeHealth(
      {
        cfn: cfnWith([{ logicalId: 'Bucket', type: 'AWS::S3::Bucket', status: 'CREATE_COMPLETE' }]),
        ecs: ecsWith(),
        elb: elbWith([]),
      },
      'deployz-app',
    );
    expect(health.healthStatus).toBe('UNKNOWN');
    expect(health.desiredCount).toBeNull();
    expect(health.components).toEqual({});
  });

  it('omits components — never UNKNOWN — for a rolled-back stack instead of using phantom physicalIds', async () => {
    const ecs = vi.fn();
    const elb = vi.fn();
    const health = await observeRuntimeHealth(
      {
        cfn: cfnWith([
          { logicalId: 'Service', type: 'AWS::ECS::Service', status: 'CREATE_FAILED', physicalId: SERVICE_ARN },
          {
            logicalId: 'Targets',
            type: 'AWS::ElasticLoadBalancingV2::TargetGroup',
            status: 'DELETE_COMPLETE',
          },
        ]),
        ecs: { describeServices: ecs },
        elb: { describeTargetHealth: elb },
      },
      'deployz-app',
    );

    expect(health.components).toEqual({});
    expect(health.healthStatus).toBe('UNKNOWN');
    // Phantom physicalIds from failed/rolled-back resources must never be
    // used to ask ECS/ELB about infrastructure that no longer backs the stack.
    expect(ecs).not.toHaveBeenCalled();
    expect(elb).not.toHaveBeenCalled();
  });

  it('still observes the load balancer when only the ECS service failed to create', async () => {
    const health = await observeRuntimeHealth(
      {
        cfn: cfnWith([
          { logicalId: 'Service', type: 'AWS::ECS::Service', status: 'CREATE_FAILED', physicalId: SERVICE_ARN },
          {
            logicalId: 'Targets',
            type: 'AWS::ElasticLoadBalancingV2::TargetGroup',
            status: 'CREATE_COMPLETE',
            physicalId: 'arn:aws:elasticloadbalancing:us-east-1:151955775369:targetgroup/app/abc',
          },
        ]),
        ecs: ecsWith(),
        elb: elbWith(['healthy']),
      },
      'deployz-app',
    );

    expect(health.components).toEqual({ loadBalancer: 'HEALTHY' });
  });

  it('keeps ECS-derived health when target health is unreadable', async () => {
    const elbFails: TargetHealthReader = {
      async describeTargetHealth() {
        throw new Error('AccessDenied');
      },
    };
    const health = await observeRuntimeHealth(
      {
        cfn: cfnWith([...STACK]),
        ecs: ecsWith({ desiredCount: 1, runningCount: 1 }),
        elb: elbFails,
      },
      'deployz-app',
    );
    expect(health.healthStatus).toBe('HEALTHY');
    expect(health.unhealthyTargetCount).toBe(0);
    expect(health.components.loadBalancer).toBe('UNKNOWN');
  });

  it('maps initial/draining targets to pending, unknown to unknown, and never reports HEALTHY while pending', async () => {
    const health = await observeRuntimeHealth(
      {
        cfn: cfnWith([...STACK]),
        ecs: ecsWith({ desiredCount: 2, runningCount: 2, deployments: [{ status: 'PRIMARY', rolloutState: 'COMPLETED' }] }),
        elb: elbWith(['healthy', 'initial', 'draining', 'unknown']),
      },
      'deployz-app',
    );
    // Serving (ECS full) but not fully healthy: pending targets + an
    // unclassified one. The overall verdict stays DEGRADED...
    expect(health.healthStatus).toBe('DEGRADED');
    expect(health.unhealthyTargetCount).toBe(0);
    expect(health.pendingTargetCount).toBe(2);
    expect(health.unknownTargetCount).toBe(1);
    // ...while the loadBalancer component cannot be told healthy or
    // degraded because one target's state is unknown.
    expect(health.components.loadBalancer).toBe('UNKNOWN');
  });

  it('reports UNKNOWN when every target is unclassified', async () => {
    const health = await observeRuntimeHealth(
      {
        cfn: cfnWith([...STACK]),
        ecs: ecsWith({ desiredCount: 1, runningCount: 1, deployments: [{ status: 'PRIMARY', rolloutState: 'COMPLETED' }] }),
        elb: elbWith(['unknown']),
      },
      'deployz-app',
    );
    expect(health.healthStatus).toBe('UNKNOWN');
    expect(health.components.loadBalancer).toBe('UNKNOWN');
  });
});
