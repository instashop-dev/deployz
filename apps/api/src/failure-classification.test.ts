import { describe, expect, it } from 'vitest';

import { refineFailureCode, type FailureStackEvent } from './failure-classification.js';

function rdsFailed(reason: string): FailureStackEvent {
  return {
    resourceType: 'AWS::RDS::DBInstance',
    resourceStatus: 'CREATE_FAILED',
    resourceStatusReason: reason,
  };
}

describe('refineFailureCode', () => {
  it('never second-guesses a specific relay classification', () => {
    expect(
      refineFailureCode({
        reported: 'ECS_DEPLOYMENT_FAILED',
        errorText: 'quota exceeded somewhere',
        stackEvents: [],
      }),
    ).toBe('ECS_DEPLOYMENT_FAILED');
    expect(
      refineFailureCode({ reported: 'MISSING_SECRET', errorText: 'AccessDenied', stackEvents: [] }),
    ).toBe('MISSING_SECRET');
  });

  it('sharpens STACK_CREATE_FAILED using the failed resource event', () => {
    expect(
      refineFailureCode({
        reported: 'STACK_CREATE_FAILED',
        errorText: 'Stack "deployz-app" finished in ROLLBACK_COMPLETE',
        stackEvents: [rdsFailed('Instance class db.t3.micro is not supported in this Availability Zone')],
      }),
    ).toBe('DATABASE_CREATE_FAILED');
    expect(
      refineFailureCode({
        reported: 'STACK_CREATE_FAILED',
        errorText: null,
        stackEvents: [
          {
            resourceType: 'AWS::ElastiCache::ReplicationGroup',
            resourceStatus: 'CREATE_FAILED',
            resourceStatusReason: 'Cache cluster creation failed',
          },
        ],
      }),
    ).toBe('REDIS_PROVISIONING_FAILED');
  });

  it('classifies ECS resource failures by their reason', () => {
    const base = {
      reported: 'STACK_CREATE_FAILED' as const,
      errorText: null,
    };
    expect(
      refineFailureCode({
        ...base,
        stackEvents: [
          {
            resourceType: 'AWS::ECS::Service',
            resourceStatus: 'CREATE_FAILED',
            resourceStatusReason: 'tasks failed container health checks',
          },
        ],
      }),
    ).toBe('IMAGE_HEALTH_CHECK_FAILED');
    expect(
      refineFailureCode({
        ...base,
        stackEvents: [
          {
            resourceType: 'AWS::ECS::Service',
            resourceStatus: 'CREATE_FAILED',
            resourceStatusReason: 'tasks kept exiting with code 1',
          },
        ],
      }),
    ).toBe('CONTAINER_START_FAILED');
  });

  it('detects SCP denials ahead of plain permission denials', () => {
    expect(
      refineFailureCode({
        reported: 'AWS_PERMISSION_DENIED',
        errorText:
          'AccessDenied: with an explicit deny in a service control policy',
        stackEvents: [],
      }),
    ).toBe('AWS_SCP_BLOCKED');
  });

  it('reclassifies the relay catch-all AWS_PERMISSION_DENIED when the evidence says quota or image pull', () => {
    expect(
      refineFailureCode({
        reported: 'AWS_PERMISSION_DENIED',
        errorText: 'LimitExceeded: too many vCPUs requested',
        stackEvents: [],
      }),
    ).toBe('QUOTA_EXCEEDED');
    expect(
      refineFailureCode({
        reported: 'AWS_PERMISSION_DENIED',
        errorText: 'CannotPullContainerError: pull access denied for repository',
        stackEvents: [],
      }),
    ).toBe('IMAGE_PULL_FAILED');
  });

  it('ignores CloudFormation cancellation noise and stack-level events', () => {
    expect(
      refineFailureCode({
        reported: 'STACK_CREATE_FAILED',
        errorText: null,
        stackEvents: [
          {
            resourceType: 'AWS::S3::Bucket',
            resourceStatus: 'CREATE_FAILED',
            resourceStatusReason: 'Resource creation cancelled',
          },
          {
            resourceType: 'AWS::CloudFormation::Stack',
            resourceStatus: 'ROLLBACK_COMPLETE',
            resourceStatusReason: null,
          },
          rdsFailed('capacity unavailable'),
        ],
      }),
    ).toBe('DATABASE_CREATE_FAILED');
  });

  it('gives an unclassified failure a code when the evidence supports one, else leaves it', () => {
    expect(
      refineFailureCode({
        reported: null,
        errorText: 'User: arn:aws:sts::123:assumed-role/x is not authorized to perform: rds:CreateDBInstance',
        stackEvents: [],
      }),
    ).toBe('AWS_PERMISSION_DENIED');
    expect(
      refineFailureCode({ reported: null, errorText: 'something exploded', stackEvents: [] }),
    ).toBeNull();
    expect(
      refineFailureCode({ reported: 'UNKNOWN', errorText: 'mystery', stackEvents: [] }),
    ).toBe('UNKNOWN');
  });
});
