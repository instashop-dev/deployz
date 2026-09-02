import type { ScenarioDefinition } from '../types.js';

/**
 * A generic stack failure with rollback DISABLED: the network resource fails
 * to create and the stack settles directly on the terminal `CREATE_FAILED`
 * status — never `ROLLBACK_IN_PROGRESS`/`ROLLBACK_COMPLETE`, unlike
 * ./cloudformation-rollback.ts (RDS) and ./database-failure.ts (RDS,
 * rollback) and ./ecs-failure.ts (ECS, rollback). `CREATE_FAILED` is a
 * `FAILURE_STATUSES` member in `packages/relay/src/install.ts` on its own,
 * so `installApplicationStack` fails the same way it would for a rollback —
 * this scenario exists to prove that path is honoured too.
 */
export const cloudformationFailure: ScenarioDefinition = {
  id: 'cloudformation-failure',
  description:
    'AWS::EC2::VPC CREATE_FAILED; the stack itself terminates at CREATE_FAILED with no rollback at all.',
  finalStackStatus: 'CREATE_FAILED',
  redisRequired: false,
  timeline: [
    { afterMs: 30, atVirtualMs: 0, logicalResourceId: 'ApplicationVpc', resourceType: 'AWS::EC2::VPC', status: 'CREATE_IN_PROGRESS' },
    {
      afterMs: 100,
      atVirtualMs: 30_000,
      logicalResourceId: 'ApplicationVpc',
      resourceType: 'AWS::EC2::VPC',
      status: 'CREATE_FAILED',
      statusReason: 'The maximum number of VPCs has been reached.',
    },
    {
      afterMs: 120,
      atVirtualMs: 35_000,
      logicalResourceId: '__stack__',
      resourceType: 'AWS::CloudFormation::Stack',
      status: 'CREATE_FAILED',
      statusReason: 'The following resource(s) failed to create: [ApplicationVpc].',
    },
  ],
};
