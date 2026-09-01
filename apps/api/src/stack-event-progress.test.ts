import { describe, expect, it } from 'vitest';

import { categorizeResourceType, summarizeStackEvents, type StoredStackEvent } from './stack-event-progress';

const STACK = 'deployz-app';

function event(overrides: Partial<StoredStackEvent> & Pick<StoredStackEvent, 'eventAt' | 'logicalResourceId'>): StoredStackEvent {
  return {
    resourceType: 'AWS::EC2::VPC',
    resourceStatus: 'CREATE_IN_PROGRESS',
    resourceStatusReason: null,
    ...overrides,
  };
}

describe('categorizeResourceType', () => {
  it('maps every prefix in the target table', () => {
    expect(categorizeResourceType('AWS::EC2::Subnet')).toBe('network');
    expect(categorizeResourceType('AWS::RDS::DBInstance')).toBe('database');
    expect(categorizeResourceType('AWS::ElastiCache::ReplicationGroup')).toBe('redis');
    expect(categorizeResourceType('AWS::S3::Bucket')).toBe('storage');
    expect(categorizeResourceType('AWS::ECS::Service')).toBe('application');
    expect(categorizeResourceType('AWS::ElasticLoadBalancingV2::LoadBalancer')).toBe('application');
    expect(categorizeResourceType('AWS::ECR::Repository')).toBe('application');
    expect(categorizeResourceType('AWS::CertificateManager::Certificate')).toBe('application');
    expect(categorizeResourceType('AWS::Route53::RecordSet')).toBe('application');
  });

  it('returns null for support/deployment services', () => {
    expect(categorizeResourceType('AWS::Lambda::Function')).toBeNull();
    expect(categorizeResourceType('AWS::IAM::Role')).toBeNull();
    expect(categorizeResourceType('AWS::Logs::LogGroup')).toBeNull();
    expect(categorizeResourceType('AWS::SSM::Parameter')).toBeNull();
    expect(categorizeResourceType('AWS::CDK::Metadata')).toBeNull();
  });
});

describe('summarizeStackEvents', () => {
  it('returns null for empty input', () => {
    expect(summarizeStackEvents(STACK, [], '2026-09-01T00:00:00.000Z')).toBeNull();
  });

  it('collapses five EC2 subnet events into one network category IN_PROGRESS', () => {
    const events: StoredStackEvent[] = [1, 2, 3, 4, 5].map((n) =>
      event({
        logicalResourceId: `Subnet${n}`,
        resourceType: 'AWS::EC2::Subnet',
        resourceStatus: 'CREATE_IN_PROGRESS',
        eventAt: new Date(`2026-09-01T00:0${n}:00.000Z`),
      }),
    );

    const snapshot = summarizeStackEvents(STACK, events, '2026-09-01T00:10:00.000Z') as Record<string, unknown>;

    expect(Object.keys(snapshot.categories as object)).toEqual(['network']);
    expect((snapshot.categories as Record<string, unknown>).network).toEqual({
      status: 'IN_PROGRESS',
      startedAt: '2026-09-01T00:01:00.000Z',
    });
  });

  it('maps RDS, ElastiCache, S3, and application-tier resources to their categories', () => {
    const events: StoredStackEvent[] = [
      event({ logicalResourceId: 'Db', resourceType: 'AWS::RDS::DBInstance', resourceStatus: 'CREATE_COMPLETE', eventAt: new Date('2026-09-01T00:01:00.000Z') }),
      event({ logicalResourceId: 'Cache', resourceType: 'AWS::ElastiCache::ReplicationGroup', resourceStatus: 'CREATE_COMPLETE', eventAt: new Date('2026-09-01T00:01:00.000Z') }),
      event({ logicalResourceId: 'Bucket', resourceType: 'AWS::S3::Bucket', resourceStatus: 'CREATE_COMPLETE', eventAt: new Date('2026-09-01T00:01:00.000Z') }),
      event({ logicalResourceId: 'Service', resourceType: 'AWS::ECS::Service', resourceStatus: 'CREATE_COMPLETE', eventAt: new Date('2026-09-01T00:01:00.000Z') }),
      event({ logicalResourceId: 'Alb', resourceType: 'AWS::ElasticLoadBalancingV2::LoadBalancer', resourceStatus: 'CREATE_COMPLETE', eventAt: new Date('2026-09-01T00:01:00.000Z') }),
      event({ logicalResourceId: 'Repo', resourceType: 'AWS::ECR::Repository', resourceStatus: 'CREATE_COMPLETE', eventAt: new Date('2026-09-01T00:01:00.000Z') }),
      event({ logicalResourceId: 'Cert', resourceType: 'AWS::CertificateManager::Certificate', resourceStatus: 'CREATE_COMPLETE', eventAt: new Date('2026-09-01T00:01:00.000Z') }),
      event({ logicalResourceId: 'Dns', resourceType: 'AWS::Route53::RecordSet', resourceStatus: 'CREATE_COMPLETE', eventAt: new Date('2026-09-01T00:01:00.000Z') }),
    ];

    const snapshot = summarizeStackEvents(STACK, events, 'now') as Record<string, unknown>;
    const categories = snapshot.categories as Record<string, { status: string }>;

    expect(categories.database?.status).toBe('COMPLETE');
    expect(categories.redis?.status).toBe('COMPLETE');
    expect(categories.storage?.status).toBe('COMPLETE');
    expect(categories.application?.status).toBe('COMPLETE');
  });

  it('leaves Lambda and IAM resource events out of the category map entirely', () => {
    const events: StoredStackEvent[] = [
      event({ logicalResourceId: 'Fn', resourceType: 'AWS::Lambda::Function', resourceStatus: 'CREATE_COMPLETE', eventAt: new Date('2026-09-01T00:01:00.000Z') }),
      event({ logicalResourceId: 'Role', resourceType: 'AWS::IAM::Role', resourceStatus: 'CREATE_COMPLETE', eventAt: new Date('2026-09-01T00:01:00.000Z') }),
    ];

    const snapshot = summarizeStackEvents(STACK, events, 'now') as Record<string, unknown>;

    expect(snapshot.categories).toEqual({});
  });

  it('uses only the latest event per logicalResourceId to determine status', () => {
    const events: StoredStackEvent[] = [
      event({ logicalResourceId: 'Vpc', resourceType: 'AWS::EC2::VPC', resourceStatus: 'CREATE_IN_PROGRESS', eventAt: new Date('2026-09-01T00:01:00.000Z') }),
      event({ logicalResourceId: 'Vpc', resourceType: 'AWS::EC2::VPC', resourceStatus: 'CREATE_COMPLETE', eventAt: new Date('2026-09-01T00:02:00.000Z') }),
    ];

    const snapshot = summarizeStackEvents(STACK, events, 'now') as Record<string, unknown>;
    const categories = snapshot.categories as Record<string, { status: string }>;

    expect(categories.network?.status).toBe('COMPLETE');
  });

  it('marks a category FAILED on a genuine CREATE_FAILED', () => {
    const events: StoredStackEvent[] = [
      event({
        logicalResourceId: 'Vpc',
        resourceType: 'AWS::EC2::VPC',
        resourceStatus: 'CREATE_FAILED',
        resourceStatusReason: 'The maximum number of VPCs has been reached',
        eventAt: new Date('2026-09-01T00:01:00.000Z'),
      }),
    ];

    const snapshot = summarizeStackEvents(STACK, events, 'now') as Record<string, unknown>;
    const categories = snapshot.categories as Record<string, { status: string }>;

    expect(categories.network?.status).toBe('FAILED');
  });

  it('does not fail a category on a cancelled-reason CREATE_FAILED', () => {
    const events: StoredStackEvent[] = [
      event({
        logicalResourceId: 'Subnet',
        resourceType: 'AWS::EC2::Subnet',
        resourceStatus: 'CREATE_FAILED',
        resourceStatusReason: 'Resource creation cancelled',
        eventAt: new Date('2026-09-01T00:01:00.000Z'),
      }),
    ];

    const snapshot = summarizeStackEvents(STACK, events, 'now') as Record<string, unknown>;
    const categories = snapshot.categories as Record<string, { status: string }>;

    expect(categories.network?.status).toBe('IN_PROGRESS');
  });

  it('does not let DELETE_IN_PROGRESS debris change an already-COMPLETE category', () => {
    const events: StoredStackEvent[] = [
      event({ logicalResourceId: 'Vpc', resourceType: 'AWS::EC2::VPC', resourceStatus: 'CREATE_COMPLETE', eventAt: new Date('2026-09-01T00:01:00.000Z') }),
      event({ logicalResourceId: 'Vpc', resourceType: 'AWS::EC2::VPC', resourceStatus: 'DELETE_IN_PROGRESS', eventAt: new Date('2026-09-01T00:05:00.000Z') }),
    ];

    const snapshot = summarizeStackEvents(STACK, events, 'now') as Record<string, unknown>;
    const categories = snapshot.categories as Record<string, { status: string }>;

    expect(categories.network?.status).toBe('COMPLETE');
  });

  it('sets stackStatus from the latest AWS::CloudFormation::Stack event for the stack itself', () => {
    const events: StoredStackEvent[] = [
      event({ logicalResourceId: STACK, resourceType: 'AWS::CloudFormation::Stack', resourceStatus: 'CREATE_IN_PROGRESS', eventAt: new Date('2026-09-01T00:00:00.000Z') }),
      event({ logicalResourceId: STACK, resourceType: 'AWS::CloudFormation::Stack', resourceStatus: 'ROLLBACK_IN_PROGRESS', eventAt: new Date('2026-09-01T00:05:00.000Z') }),
    ];

    const snapshot = summarizeStackEvents(STACK, events, 'now') as Record<string, unknown>;

    expect(snapshot.stackStatus).toBe('ROLLBACK_IN_PROGRESS');
    // The stack-level event itself is not folded into any category.
    expect(snapshot.categories).toEqual({});
  });

  it('sets startedAt to the oldest event and completedAt to the latest COMPLETE event', () => {
    const events: StoredStackEvent[] = [
      event({ logicalResourceId: 'Subnet1', resourceType: 'AWS::EC2::Subnet', resourceStatus: 'CREATE_IN_PROGRESS', eventAt: new Date('2026-09-01T00:02:00.000Z') }),
      event({ logicalResourceId: 'Subnet1', resourceType: 'AWS::EC2::Subnet', resourceStatus: 'CREATE_COMPLETE', eventAt: new Date('2026-09-01T00:04:00.000Z') }),
      event({ logicalResourceId: 'Subnet2', resourceType: 'AWS::EC2::Subnet', resourceStatus: 'CREATE_IN_PROGRESS', eventAt: new Date('2026-09-01T00:01:00.000Z') }),
      event({ logicalResourceId: 'Subnet2', resourceType: 'AWS::EC2::Subnet', resourceStatus: 'CREATE_COMPLETE', eventAt: new Date('2026-09-01T00:10:00.000Z') }),
    ];

    const snapshot = summarizeStackEvents(STACK, events, 'now') as Record<string, unknown>;
    const categories = snapshot.categories as Record<string, { status: string; startedAt?: string; completedAt?: string }>;

    expect(categories.network).toEqual({
      status: 'COMPLETE',
      startedAt: '2026-09-01T00:01:00.000Z',
      completedAt: '2026-09-01T00:10:00.000Z',
    });
  });
});
