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

  it("classifies the relay's own state-persistence failure as Deployz-side, not a stack rollback (CANARY-006)", () => {
    expect(
      refineFailureCode({
        reported: 'STACK_CREATE_FAILED',
        errorText:
          'Stack "deployz-app-af4ecb86" is still CREATE_IN_PROGRESS, but the relay could not record that it must report back — failing now rather than leaving the install unaccounted for',
        stackEvents: [
          {
            resourceType: 'AWS::ECS::Service',
            resourceStatus: 'CREATE_IN_PROGRESS',
            resourceStatusReason: null,
          },
          {
            resourceType: 'AWS::RDS::DBInstance',
            resourceStatus: 'CREATE_COMPLETE',
            resourceStatusReason: null,
          },
        ],
      }),
    ).toBe('RELAY_STATE_WRITE_FAILED');
    expect(
      refineFailureCode({
        reported: 'UNKNOWN',
        errorText: 'Install could not run: the deferral marker write failed',
        stackEvents: [],
      }),
    ).toBe('RELAY_STATE_WRITE_FAILED');
  });

  it('still sharpens a genuine CREATE_FAILED event set to its resource-specific code (no regression)', () => {
    expect(
      refineFailureCode({
        reported: 'STACK_CREATE_FAILED',
        errorText:
          'Stack "deployz-app-af4ecb86" is still CREATE_IN_PROGRESS, but the relay could not record that it must report back — failing now rather than leaving the install unaccounted for',
        stackEvents: [rdsFailed('Instance class db.t3.micro is not supported in this Availability Zone')],
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

describe('refineFailureCode — Phase 6 signatures', () => {
  it('maps a wrong-region artifact (S3 PermanentRedirect) onto REGION_NOT_SUPPORTED', () => {
    expect(
      refineFailureCode({
        reported: 'STACK_CREATE_FAILED',
        errorText: 'PermanentRedirect: The bucket you are attempting to access must be addressed using the specified endpoint',
        stackEvents: [],
      }),
    ).toBe('REGION_NOT_SUPPORTED');
  });

  it('separates a container that failed its health checks from one whose process exited', () => {
    expect(
      refineFailureCode({ reported: 'UNKNOWN', errorText: '(service app) (task abc) failed container health checks.', stackEvents: [] }),
    ).toBe('IMAGE_HEALTH_CHECK_FAILED');
    expect(
      refineFailureCode({ reported: 'UNKNOWN', errorText: 'Essential container in task exited (exit code 1)', stackEvents: [] }),
    ).toBe('CONTAINER_START_FAILED');
    expect(refineFailureCode({ reported: 'UNKNOWN', errorText: 'OutOfMemoryError: container killed', stackEvents: [] })).toBe(
      'CONTAINER_START_FAILED',
    );
  });

  it('still lets an IAM denial win over container wording that follows it', () => {
    expect(
      refineFailureCode({
        reported: 'UNKNOWN',
        errorText: 'User is not authorized to perform ecs:RunTask; task exited with code 1',
        stackEvents: [],
      }),
    ).toBe('AWS_PERMISSION_DENIED');
  });
});
