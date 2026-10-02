import type { ScenarioDefinition } from '../types.js';

/**
 * RDS fails with InsufficientDBInstanceCapacity — the exact incident that
 * motivated the AZ-placement fix. The stack rolls back to ROLLBACK_COMPLETE.
 *
 * This scenario reproduces the original failure mode: the database subnet
 * group only covers two AZs, and AWS reports no capacity in either. The fix
 * widens the subnet group to all available AZs, so a retry can succeed when
 * capacity becomes available in a different AZ.
 *
 * The scenario asserts:
 * - The stack rolls back to ROLLBACK_COMPLETE
 * - The failure is classified as RDS_AZ_CAPACITY (not DATABASE_CREATE_FAILED)
 * - The deployment settles FAILED with the correct failure code
 */
export const rdsAzCapacity: ScenarioDefinition = {
  id: 'rds-az-capacity',
  description:
    'RDS CREATE_FAILED on InsufficientDBInstanceCapacity; stack rolls back to ROLLBACK_COMPLETE. Terminal FAILED with failure code RDS_AZ_CAPACITY.',
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
