import type { ScenarioDefinition } from '../types.js';

/**
 * RDS fails on a realistic capacity reason (distinct from
 * ./cloudformation-rollback.ts's instance-class/AZ mismatch reason) and the
 * stack rolls back to `ROLLBACK_COMPLETE`. Network completes fine first, so
 * `snapshotFailedStep` (apps/api/src/deployment-status.ts) has exactly one
 * failed category to report: `database` — e2e/scenario-provisioning.spec.ts
 * pins the resulting `deploymentStatus.step` as `DATABASE_STORAGE`, which
 * ./cloudformation-rollback.ts's existing test does not assert.
 */
export const databaseFailure: ScenarioDefinition = {
  id: 'database-failure',
  description:
    'RDS CREATE_FAILED on capacity; stack rolls back to ROLLBACK_COMPLETE. Terminal FAILED with step DATABASE_STORAGE.',
  finalStackStatus: 'ROLLBACK_COMPLETE',
  redisRequired: false,
  timeline: [
    { afterMs: 30, atVirtualMs: 0, logicalResourceId: 'ApplicationVpc', resourceType: 'AWS::EC2::VPC', status: 'CREATE_IN_PROGRESS' },
    { afterMs: 80, atVirtualMs: 40_000, logicalResourceId: 'ApplicationVpc', resourceType: 'AWS::EC2::VPC', status: 'CREATE_COMPLETE' },
    { afterMs: 110, atVirtualMs: 60_000, logicalResourceId: 'ApplicationDatabase', resourceType: 'AWS::RDS::DBInstance', status: 'CREATE_IN_PROGRESS' },
    {
      afterMs: 220,
      atVirtualMs: 180_000,
      logicalResourceId: 'ApplicationDatabase',
      resourceType: 'AWS::RDS::DBInstance',
      status: 'CREATE_FAILED',
      statusReason:
        'InsufficientDBInstanceCapacity: There is not enough capacity for the requested DB instance class in this Availability Zone.',
    },
    {
      afterMs: 230,
      atVirtualMs: 185_000,
      logicalResourceId: '__stack__',
      resourceType: 'AWS::CloudFormation::Stack',
      status: 'ROLLBACK_IN_PROGRESS',
      statusReason: 'The following resource(s) failed to create: [ApplicationDatabase].',
    },
    {
      afterMs: 260,
      atVirtualMs: 200_000,
      logicalResourceId: '__stack__',
      resourceType: 'AWS::CloudFormation::Stack',
      status: 'ROLLBACK_COMPLETE',
    },
  ],
};
