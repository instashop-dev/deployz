import type { ScenarioDefinition } from '../types.js';

/**
 * A mid-provisioning resource fails to create and CloudFormation rolls the
 * stack back: `AWS::RDS::DBInstance` `CREATE_FAILED` (a plausible AWS
 * message, matching the fixture idiom in e2e/stack-events.spec.ts), then the
 * stack itself `ROLLBACK_IN_PROGRESS` → `ROLLBACK_COMPLETE`.
 *
 * `verifyInstallation` never runs for this scenario — `installApplicationStack`
 * short-circuits to a failure the moment the stack settles on a
 * `FAILURE_STATUSES` member, exactly like a real CREATE_FAILED/ROLLBACK_COMPLETE
 * stack.
 */
export const cloudformationRollback: ScenarioDefinition = {
  id: 'cloudformation-rollback',
  description:
    'RDS CREATE_FAILED mid-provisioning; stack rolls back to ROLLBACK_COMPLETE. Terminal FAILED, never verified.',
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
      statusReason: 'Instance class db.t3.micro is not supported in this Availability Zone',
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
