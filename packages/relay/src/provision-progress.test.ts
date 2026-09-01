import { describe, expect, it } from 'vitest';

import { summarizeProvisioning, buildProvisioningSnapshot } from './provision-progress.js';
import type { CloudFormationReader, StackLookup, StackResource } from './verify.js';

function reader(lookup: StackLookup, resources: StackResource[] = []): CloudFormationReader {
  return {
    describeStack: async () => lookup,
    describeStackResources: async () => resources,
  };
}

describe('summarizeProvisioning', () => {
  it('maps resource types to categories by prefix', () => {
    const resources: StackResource[] = [
      { logicalId: 'Vpc', type: 'AWS::EC2::VPC', status: 'CREATE_COMPLETE', timestamp: '2026-01-01T00:00:00.000Z' },
      { logicalId: 'Db', type: 'AWS::RDS::DBInstance', status: 'CREATE_COMPLETE', timestamp: '2026-01-01T00:00:00.000Z' },
      { logicalId: 'Secret', type: 'AWS::SecretsManager::Secret', status: 'CREATE_COMPLETE', timestamp: '2026-01-01T00:00:00.000Z' },
      { logicalId: 'Bucket', type: 'AWS::S3::Bucket', status: 'CREATE_COMPLETE', timestamp: '2026-01-01T00:00:00.000Z' },
      { logicalId: 'Cache', type: 'AWS::ElastiCache::ReplicationGroup', status: 'CREATE_COMPLETE', timestamp: '2026-01-01T00:00:00.000Z' },
      { logicalId: 'Service', type: 'AWS::ECS::Service', status: 'CREATE_COMPLETE', timestamp: '2026-01-01T00:00:00.000Z' },
      { logicalId: 'Alb', type: 'AWS::ElasticLoadBalancingV2::LoadBalancer', status: 'CREATE_COMPLETE', timestamp: '2026-01-01T00:00:00.000Z' },
      { logicalId: 'Role', type: 'AWS::IAM::Role', status: 'CREATE_COMPLETE', timestamp: '2026-01-01T00:00:00.000Z' },
      { logicalId: 'LogGroup', type: 'AWS::Logs::LogGroup', status: 'CREATE_COMPLETE', timestamp: '2026-01-01T00:00:00.000Z' },
    ];

    const snapshot = summarizeProvisioning('CREATE_IN_PROGRESS', resources, '2026-01-01T00:05:00.000Z');

    expect(Object.keys(snapshot.categories).sort()).toEqual([
      'application',
      'database',
      'network',
      'redis',
      'storage',
    ]);
    expect(snapshot.stackStatus).toBe('CREATE_IN_PROGRESS');
    expect(snapshot.observedAt).toBe('2026-01-01T00:05:00.000Z');
  });

  it('ignores resource types that are not mapped to any category', () => {
    const resources: StackResource[] = [
      { logicalId: 'Nag', type: 'AWS::CDK::Metadata', status: 'CREATE_COMPLETE' },
    ];

    const snapshot = summarizeProvisioning('CREATE_IN_PROGRESS', resources, 'now');

    expect(snapshot.categories).toEqual({});
  });

  it('returns an empty categories map for no resources', () => {
    const snapshot = summarizeProvisioning('CREATE_IN_PROGRESS', [], 'now');
    expect(snapshot.categories).toEqual({});
  });

  it('marks a category FAILED when any resource in it ended in _FAILED', () => {
    const resources: StackResource[] = [
      { logicalId: 'Vpc', type: 'AWS::EC2::VPC', status: 'CREATE_COMPLETE' },
      { logicalId: 'Subnet', type: 'AWS::EC2::Subnet', status: 'CREATE_FAILED' },
    ];

    const snapshot = summarizeProvisioning('ROLLBACK_IN_PROGRESS', resources, 'now');

    expect(snapshot.categories.network?.status).toBe('FAILED');
  });

  it('marks a category COMPLETE only when every resource is CREATE_COMPLETE or UPDATE_COMPLETE', () => {
    const allComplete: StackResource[] = [
      { logicalId: 'Vpc', type: 'AWS::EC2::VPC', status: 'CREATE_COMPLETE' },
      { logicalId: 'Subnet', type: 'AWS::EC2::Subnet', status: 'UPDATE_COMPLETE' },
    ];
    expect(summarizeProvisioning('CREATE_COMPLETE', allComplete, 'now').categories.network?.status).toBe(
      'COMPLETE',
    );

    const stillMoving: StackResource[] = [
      { logicalId: 'Vpc', type: 'AWS::EC2::VPC', status: 'CREATE_COMPLETE' },
      { logicalId: 'Subnet', type: 'AWS::EC2::Subnet', status: 'CREATE_IN_PROGRESS' },
    ];
    expect(
      summarizeProvisioning('CREATE_IN_PROGRESS', stillMoving, 'now').categories.network?.status,
    ).toBe('IN_PROGRESS');
  });

  it('sets startedAt to the earliest timestamp in the category, regardless of input order', () => {
    const resources: StackResource[] = [
      { logicalId: 'Subnet', type: 'AWS::EC2::Subnet', status: 'CREATE_IN_PROGRESS', timestamp: '2026-01-01T00:10:00.000Z' },
      { logicalId: 'Vpc', type: 'AWS::EC2::VPC', status: 'CREATE_COMPLETE', timestamp: '2026-01-01T00:02:00.000Z' },
    ];

    const snapshot = summarizeProvisioning('CREATE_IN_PROGRESS', resources, 'now');

    expect(snapshot.categories.network).toMatchObject({
      status: 'IN_PROGRESS',
      startedAt: '2026-01-01T00:02:00.000Z',
    });
    expect(snapshot.categories.network?.completedAt).toBeUndefined();
  });

  it('sets completedAt to the latest timestamp, only once the category is COMPLETE', () => {
    const resources: StackResource[] = [
      { logicalId: 'Vpc', type: 'AWS::EC2::VPC', status: 'CREATE_COMPLETE', timestamp: '2026-01-01T00:02:00.000Z' },
      { logicalId: 'Subnet', type: 'AWS::EC2::Subnet', status: 'CREATE_COMPLETE', timestamp: '2026-01-01T00:10:00.000Z' },
    ];

    const snapshot = summarizeProvisioning('CREATE_COMPLETE', resources, 'now');

    expect(snapshot.categories.network).toEqual({
      status: 'COMPLETE',
      startedAt: '2026-01-01T00:02:00.000Z',
      completedAt: '2026-01-01T00:10:00.000Z',
    });
  });

  it('omits startedAt/completedAt entirely when no resource in the category carries a timestamp', () => {
    const resources: StackResource[] = [{ logicalId: 'Vpc', type: 'AWS::EC2::VPC', status: 'CREATE_COMPLETE' }];

    const snapshot = summarizeProvisioning('CREATE_COMPLETE', resources, 'now');

    expect(snapshot.categories.network).toEqual({ status: 'COMPLETE' });
  });
});

describe('buildProvisioningSnapshot', () => {
  const RESOURCES: StackResource[] = [
    { logicalId: 'Vpc', type: 'AWS::EC2::VPC', status: 'CREATE_COMPLETE', timestamp: '2026-01-01T00:00:00.000Z' },
  ];

  it('fetches the stack status and resources and summarizes them', async () => {
    const cfn = reader(
      { found: true, stack: { stackName: 'deployz-app', status: 'CREATE_IN_PROGRESS', tags: {} } },
      RESOURCES,
    );

    const snapshot = await buildProvisioningSnapshot(cfn, 'deployz-app', () => '2026-01-01T00:05:00.000Z');

    expect(snapshot).toEqual({
      stackStatus: 'CREATE_IN_PROGRESS',
      observedAt: '2026-01-01T00:05:00.000Z',
      categories: { network: { status: 'COMPLETE', startedAt: '2026-01-01T00:00:00.000Z', completedAt: '2026-01-01T00:00:00.000Z' } },
    });
  });

  it('returns null when the stack is not found', async () => {
    const cfn = reader({ found: false });
    expect(await buildProvisioningSnapshot(cfn, 'deployz-app')).toBeNull();
  });

  it('returns null when describeStack throws', async () => {
    const cfn: CloudFormationReader = {
      describeStack: async () => {
        throw new Error('network layer exploded');
      },
      describeStackResources: async () => RESOURCES,
    };
    expect(await buildProvisioningSnapshot(cfn, 'deployz-app')).toBeNull();
  });

  it('returns null when describeStackResources throws', async () => {
    const cfn: CloudFormationReader = {
      describeStack: async () => ({
        found: true,
        stack: { stackName: 'deployz-app', status: 'CREATE_IN_PROGRESS', tags: {} },
      }),
      describeStackResources: async () => {
        throw new Error('throttled');
      },
    };
    expect(await buildProvisioningSnapshot(cfn, 'deployz-app')).toBeNull();
  });

  it('defaults observedAt to the current time when no clock is injected', async () => {
    const cfn = reader(
      { found: true, stack: { stackName: 'deployz-app', status: 'CREATE_IN_PROGRESS', tags: {} } },
      RESOURCES,
    );

    const before = Date.now();
    const snapshot = await buildProvisioningSnapshot(cfn, 'deployz-app');
    const after = Date.now();

    expect(snapshot).not.toBeNull();
    const observedAtMs = new Date(snapshot!.observedAt).getTime();
    expect(observedAtMs).toBeGreaterThanOrEqual(before);
    expect(observedAtMs).toBeLessThanOrEqual(after);
  });
});
