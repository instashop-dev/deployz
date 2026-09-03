import { describe, expect, it } from 'vitest';

import {
  aggregateInfrastructureComponents,
  type InfrastructureResourceRow,
} from './infrastructure.js';

const OBSERVED_AT = new Date('2026-09-01T12:00:00.000Z');

function row(overrides: Partial<InfrastructureResourceRow> = {}): InfrastructureResourceRow {
  return {
    componentKind: 'application',
    resourceRole: 'supporting',
    lifecyclePolicy: 'delete',
    resourceStatus: 'ready',
    rawResourceStatus: 'CREATE_COMPLETE',
    resourceType: 'AWS::ECS::Service',
    logicalResourceId: 'Service',
    physicalResourceId: 'arn:aws:ecs:us-east-1:123456789012:service/app',
    resourceStatusReason: null,
    lastUpdatedAt: OBSERVED_AT,
    ...overrides,
  };
}

describe('aggregateInfrastructureComponents', () => {
  it('composes an all-ready snapshot into ready components and a ready summary', () => {
    const result = aggregateInfrastructureComponents(
      [
        row({ logicalResourceId: 'Service', resourceRole: 'primary' }),
        row({
          componentKind: 'database',
          logicalResourceId: 'Database',
          resourceRole: 'primary',
          resourceType: 'AWS::RDS::DBInstance',
          lifecyclePolicy: 'retain',
        }),
      ],
      { deploymentState: 'HEALTHY', region: 'us-east-1' },
    );

    expect(result.summaryStatus).toBe('ready');
    expect(result.components.map((c) => [c.kind, c.status])).toEqual([
      ['application', 'ready'],
      ['database', 'ready'],
    ]);
    expect(result.components[0]).toMatchObject({
      name: 'Application',
      purpose: 'Runs your application',
      awsService: 'ECS',
      region: 'us-east-1',
      lifecycle: 'delete',
    });
    const database = result.components[1]!;
    expect(database).toMatchObject({
      name: 'Database',
      purpose: 'Stores persistent application data',
      awsService: 'RDS',
      lifecycle: 'retain',
    });
    // The technical disclosure carries the RAW AWS status, not the mapped one.
    expect(database.resources[0]).toEqual({
      logicalId: 'Database',
      physicalId: 'arn:aws:ecs:us-east-1:123456789012:service/app',
      type: 'AWS::RDS::DBInstance',
      status: 'CREATE_COMPLETE',
      statusReason: null,
    });
  });

  it('empty rows produce no components and an unknown summary — kinds are never invented', () => {
    const result = aggregateInfrastructureComponents([], { deploymentState: 'NOT_INSTALLED', region: 'us-east-1' });
    expect(result.components).toEqual([]);
    expect(result.summaryStatus).toBe('unknown');
  });

  it('provisioning — a CREATE_IN_PROGRESS row dominates a ready sibling', () => {
    const result = aggregateInfrastructureComponents(
      [
        row({ logicalResourceId: 'Service', resourceRole: 'primary', resourceStatus: 'provisioning', rawResourceStatus: 'CREATE_IN_PROGRESS' }),
        row({ logicalResourceId: 'TaskDef', resourceType: 'AWS::ECS::TaskDefinition' }),
      ],
      { deploymentState: 'INSTALLING', region: 'us-east-1' },
    );

    expect(result.components).toHaveLength(1);
    expect(result.components[0]!.status).toBe('provisioning');
    expect(result.summaryStatus).toBe('provisioning');
  });

  it('updating — an UPDATE_IN_PROGRESS row rolls the component up to updating', () => {
    const result = aggregateInfrastructureComponents(
      [row({ logicalResourceId: 'Service', resourceRole: 'primary', resourceStatus: 'updating', rawResourceStatus: 'UPDATE_IN_PROGRESS' })],
      { deploymentState: 'HEALTHY', region: 'us-east-1' },
    );

    expect(result.components[0]!.status).toBe('updating');
    expect(result.summaryStatus).toBe('updating');
  });

  it('failure — a failed primary fails the component and the summary', () => {
    const result = aggregateInfrastructureComponents(
      [
        row({ logicalResourceId: 'Service', resourceRole: 'primary', resourceStatus: 'failed', rawResourceStatus: 'CREATE_FAILED', resourceStatusReason: 'boom' }),
        row({ logicalResourceId: 'TaskDef', resourceType: 'AWS::ECS::TaskDefinition', resourceStatus: 'ready' }),
      ],
      { deploymentState: 'FAILED', region: 'us-east-1' },
    );

    expect(result.components[0]!.status).toBe('failed');
    expect(result.summaryStatus).toBe('failed');
    // Raw status + reason surface in the technical disclosure.
    expect(result.components[0]!.resources[0]).toMatchObject({
      status: 'CREATE_FAILED',
      statusReason: 'boom',
    });
  });

  it('failure — a failed SUPPORTING resource fails the component too', () => {
    const result = aggregateInfrastructureComponents(
      [
        row({ logicalResourceId: 'Service', resourceRole: 'primary', resourceStatus: 'ready' }),
        row({ logicalResourceId: 'TaskDef', resourceType: 'AWS::ECS::TaskDefinition', resourceRole: 'supporting', resourceStatus: 'failed', rawResourceStatus: 'UPDATE_FAILED' }),
      ],
      { deploymentState: 'UPDATING', region: 'us-east-1' },
    );

    expect(result.components[0]!.status).toBe('failed');
    expect(result.summaryStatus).toBe('failed');
  });

  it('retained — DELETE_SKIPPED rows read as retained, never healthy', () => {
    const result = aggregateInfrastructureComponents(
      [
        row({
          componentKind: 'database',
          logicalResourceId: 'Database',
          resourceRole: 'primary',
          resourceType: 'AWS::RDS::DBInstance',
          lifecyclePolicy: 'retain',
          resourceStatus: 'retained',
          rawResourceStatus: 'DELETE_SKIPPED',
        }),
      ],
      { deploymentState: 'HEALTHY', region: 'us-east-1' },
    );

    expect(result.components[0]!.status).toBe('retained');
    expect(result.summaryStatus).toBe('retained');
  });

  it('unknown — an unmapped raw status is never presented as healthy', () => {
    const result = aggregateInfrastructureComponents(
      [row({ logicalResourceId: 'Service', resourceRole: 'primary', resourceStatus: 'unknown', rawResourceStatus: 'WEIRD_STATE' })],
      { deploymentState: 'HEALTHY', region: 'us-east-1' },
    );

    expect(result.components[0]!.status).toBe('unknown');
    expect(result.summaryStatus).toBe('unknown');
  });

  it('delete — a DELETED deployment re-derives statuses from lifecycle', () => {
    const result = aggregateInfrastructureComponents(
      [
        row({
          logicalResourceId: 'Service',
          resourceRole: 'primary',
          resourceType: 'AWS::ECS::Service',
          lifecyclePolicy: 'delete',
          resourceStatus: 'ready',
          rawResourceStatus: 'CREATE_COMPLETE',
        }),
        row({
          componentKind: 'database',
          logicalResourceId: 'Database',
          resourceRole: 'primary',
          resourceType: 'AWS::RDS::DBInstance',
          lifecyclePolicy: 'retain',
          resourceStatus: 'ready',
          rawResourceStatus: 'CREATE_COMPLETE',
        }),
        row({
          componentKind: 'storage',
          logicalResourceId: 'BackupBucket',
          resourceRole: 'primary',
          resourceType: 'AWS::S3::Bucket',
          lifecyclePolicy: 'snapshot',
          resourceStatus: 'ready',
          rawResourceStatus: 'CREATE_COMPLETE',
        }),
      ],
      { deploymentState: 'DELETED', region: 'us-east-1' },
    );

    // Application → Removed; Database/Storage → Retained. The preserved final
    // snapshot is what aggregates — nothing is re-read from AWS.
    expect(result.components.map((c) => [c.kind, c.status])).toEqual([
      ['application', 'removed'],
      ['database', 'retained'],
      ['storage', 'retained'],
    ]);
    expect(result.summaryStatus).toBe('retained');
    // Raw technical detail survives the override unchanged.
    expect(result.components[0]!.resources[0]).toMatchObject({ status: 'CREATE_COMPLETE', type: 'AWS::ECS::Service' });
  });

  it('delete — an observed-retained row (DELETE_SKIPPED) is never overwritten to removed', () => {
    const result = aggregateInfrastructureComponents(
      [
        row({
          componentKind: 'network',
          logicalResourceId: 'DbSecurityGroupE9D701AD',
          resourceRole: 'supporting',
          resourceType: 'AWS::EC2::SecurityGroup',
          lifecyclePolicy: 'delete',
          resourceStatus: 'retained',
          rawResourceStatus: 'DELETE_SKIPPED',
        }),
      ],
      { deploymentState: 'DELETED', region: 'us-east-1' },
    );

    expect(result.components[0]!.status).toBe('retained');
    expect(result.summaryStatus).toBe('retained');
    // The technical disclosure must not hide it as removed either.
    expect(result.components[0]!.resources[0]).toMatchObject({ status: 'DELETE_SKIPPED' });
  });

  it('delete — a genuinely deleted delete-policy row still reports removed', () => {
    const result = aggregateInfrastructureComponents(
      [
        row({
          componentKind: 'network',
          logicalResourceId: 'PublicSubnet',
          resourceRole: 'supporting',
          resourceType: 'AWS::EC2::Subnet',
          lifecyclePolicy: 'delete',
          resourceStatus: 'removed',
          rawResourceStatus: 'DELETE_COMPLETE',
        }),
      ],
      { deploymentState: 'DELETED', region: 'us-east-1' },
    );

    expect(result.components[0]!.status).toBe('removed');
  });

  it('delete — a mixed component with one retained-on-failure row still reports retained', () => {
    const result = aggregateInfrastructureComponents(
      [
        row({
          componentKind: 'network',
          logicalResourceId: 'DbSecurityGroupE9D701AD',
          resourceRole: 'supporting',
          resourceType: 'AWS::EC2::SecurityGroup',
          lifecyclePolicy: 'delete',
          resourceStatus: 'retained',
          rawResourceStatus: 'DELETE_SKIPPED',
        }),
        row({
          componentKind: 'network',
          logicalResourceId: 'PublicSubnet',
          resourceRole: 'supporting',
          resourceType: 'AWS::EC2::Subnet',
          lifecyclePolicy: 'delete',
          resourceStatus: 'removed',
          rawResourceStatus: 'DELETE_COMPLETE',
        }),
        row({
          componentKind: 'network',
          logicalResourceId: 'RouteTable',
          resourceRole: 'supporting',
          resourceType: 'AWS::EC2::RouteTable',
          lifecyclePolicy: 'delete',
          resourceStatus: 'removed',
          rawResourceStatus: 'DELETE_COMPLETE',
        }),
      ],
      { deploymentState: 'DELETED', region: 'us-east-1' },
    );

    expect(result.components).toHaveLength(1);
    expect(result.components[0]!.status).toBe('retained');
    expect(result.summaryStatus).toBe('retained');
  });
});