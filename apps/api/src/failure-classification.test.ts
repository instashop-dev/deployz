import { describe, expect, it } from 'vitest';

import { isRetainedDataDeleteBlocked, refineFailureCode, type FailureStackEvent } from './failure-classification.js';

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

describe('refineFailureCode — Phase 1 evidence signatures', () => {
  const dbRefusal = {
    container: {
      exitCode: 1,
      stopCode: 'EssentialContainerExited',
      stoppedReason: 'connect ECONNREFUSED 10.0.1.5:5432',
      stoppedTaskCount: 3,
    },
  };

  it('DATABASE_CONNECTION_FAILED outranks the generic exit rule when the stopped task names ECONNREFUSED to postgres/5432', () => {
    expect(
      refineFailureCode({
        reported: 'STACK_CREATE_FAILED',
        errorText: 'Stack "deployz-app" finished in ROLLBACK_COMPLETE',
        stackEvents: [
          {
            resourceType: 'AWS::ECS::Service',
            resourceStatus: 'CREATE_FAILED',
            resourceStatusReason: 'Resource creation cancelled',
          },
        ],
        evidence: dbRefusal,
      }),
    ).toBe('DATABASE_CONNECTION_FAILED');
    expect(
      refineFailureCode({
        reported: 'UNKNOWN',
        errorText: '3 tasks of the new revision exited with code 1 (connect ECONNREFUSED 127.0.0.1:5432)',
        stackEvents: [],
      }),
    ).toBe('DATABASE_CONNECTION_FAILED');
  });

  it('a plain non-zero exit with no signature keeps the generic CONTAINER_START_FAILED behavior', () => {
    expect(
      refineFailureCode({
        reported: 'UNKNOWN',
        errorText: '3 tasks of the new revision exited with code 1 (Essential container in task exited)',
        stackEvents: [],
        evidence: {
          container: {
            exitCode: 1,
            stopCode: 'EssentialContainerExited',
            stoppedReason: 'Essential container in task exited',
            stoppedTaskCount: 3,
          },
        },
      }),
    ).toBe('CONTAINER_START_FAILED');
  });

  it('never downgrades a specific relay code, even with a database-refusal signature present', () => {
    expect(
      refineFailureCode({
        reported: 'IMAGE_PULL_FAILED',
        errorText: 'connect ECONNREFUSED 127.0.0.1:5432',
        stackEvents: [],
        evidence: dbRefusal,
      }),
    ).toBe('IMAGE_PULL_FAILED');
  });

  it('MISSING_SECRET fires on the missing-variable signature in the stopped reason', () => {
    expect(
      refineFailureCode({
        reported: 'STACK_CREATE_FAILED',
        errorText: 'Stack "deployz-app" finished in ROLLBACK_COMPLETE',
        stackEvents: [],
        evidence: {
          container: {
            exitCode: 1,
            stopCode: 'EssentialContainerExited',
            stoppedReason: 'Error: DATABASE_URL is not set',
            stoppedTaskCount: 2,
          },
        },
      }),
    ).toBe('MISSING_SECRET');
  });

  it('PORT_MISMATCH fires on the port-in-use signature', () => {
    expect(
      refineFailureCode({
        reported: 'UNKNOWN',
        errorText: 'Error: listen EADDRINUSE: address already in use 0.0.0.0:3000',
        stackEvents: [],
      }),
    ).toBe('PORT_MISMATCH');
    expect(
      refineFailureCode({
        reported: 'STACK_CREATE_FAILED',
        errorText: null,
        stackEvents: [],
        evidence: {
          container: {
            exitCode: 1,
            stopCode: 'EssentialContainerExited',
            stoppedReason: 'Error: listen EACCES 0.0.0.0:80',
            stoppedTaskCount: 1,
          },
        },
      }),
    ).toBe('PORT_MISMATCH');
  });
});

describe('isRetainedDataDeleteBlocked', () => {
  const dbDeletionProtected: FailureStackEvent = {
    resourceType: 'AWS::RDS::DBInstance',
    resourceStatus: 'DELETE_FAILED',
    resourceStatusReason: 'Cannot delete the instance because deletion protection is enabled',
  };
  const sgPinnedByEni: FailureStackEvent = {
    resourceType: 'AWS::EC2::SecurityGroup',
    resourceStatus: 'DELETE_FAILED',
    resourceStatusReason: 'Resource has 1 dependent object: NetworkInterface eni-0a1b2c3d4e5f6a7b',
  };
  const subnetPinnedByEni: FailureStackEvent = {
    resourceType: 'AWS::EC2::Subnet',
    resourceStatus: 'DELETE_FAILED',
    resourceStatusReason:
      'The subnet has dependencies and cannot be deleted: NetworkInterface eni-0a1b2c3d4e5f6a7b is attached',
  };

  it('recognises the retained-data cascade: the retained database and the resources its ENI pins', () => {
    expect(isRetainedDataDeleteBlocked([dbDeletionProtected, sgPinnedByEni, subnetPinnedByEni])).toBe(true);
  });

  it('reads an ENI pin from a security group alone — the database itself need not be among the failed events', () => {
    expect(isRetainedDataDeleteBlocked([sgPinnedByEni])).toBe(true);
  });

  it('never reads a genuine permission failure on a security group as benign retained-data evidence', () => {
    expect(
      isRetainedDataDeleteBlocked([
        {
          resourceType: 'AWS::EC2::SecurityGroup',
          resourceStatus: 'DELETE_FAILED',
          resourceStatusReason: 'User: arn:aws:sts::123 is not authorized to perform: ec2:DeleteSecurityGroup',
        },
        {
          resourceType: 'AWS::EC2::Subnet',
          resourceStatus: 'DELETE_FAILED',
          resourceStatusReason: 'AccessDenied: the caller lacks ec2:DeleteSubnet permission',
        },
      ]),
    ).toBe(false);
  });

  it('ignores install-time CREATE_FAILED debris, non-failed events, and empty evidence', () => {
    expect(isRetainedDataDeleteBlocked([rdsFailed('capacity unavailable')])).toBe(false);
    expect(
      isRetainedDataDeleteBlocked([{ resourceType: 'AWS::RDS::DBInstance', resourceStatus: 'DELETE_COMPLETE', resourceStatusReason: null }]),
    ).toBe(false);
    expect(isRetainedDataDeleteBlocked([])).toBe(false);
  });

  it('an unrelated delete failure with no RDS/ENI evidence is not retained data', () => {
    expect(
      isRetainedDataDeleteBlocked([
        {
          resourceType: 'AWS::S3::Bucket',
          resourceStatus: 'DELETE_FAILED',
          resourceStatusReason: 'BucketNotEmpty: The bucket you tried to delete is not empty',
        },
      ]),
    ).toBe(false);
  });

  it('a stack-level DELETE_FAILED alone is unattributable, not retained data', () => {
    expect(
      isRetainedDataDeleteBlocked([
        {
          resourceType: 'AWS::CloudFormation::Stack',
          resourceStatus: 'DELETE_FAILED',
          resourceStatusReason: 'One or more resources could not be deleted.',
        },
      ]),
    ).toBe(false);
  });
});
