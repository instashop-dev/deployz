import type { ScenarioDefinition } from '../types.js';
import { happyPath } from './happy-path.js';

/**
 * The data-preserving DELETE_FAILED recovery (packages/relay/src/destroy.ts),
 * end to end: the first DeleteStack fails because the retained database's
 * deletion protection rejects the delete and its ENI pins the security group
 * and subnet behind it. `settleDestroy` reads exactly those DELETE_FAILED
 * resources, re-issues DeleteStack with `RetainResources` for them (the
 * simulated account honours the retry — see `SimulatedCustomerAccount`'s
 * `retainedLogicalIds`), and the stack reaches DELETE_COMPLETE while the
 * database, its secrets and the bucket stay behind. Truthful success, not a
 * FAILED deployment — PURGE is what later removes the retained data.
 */
export const retainedDeleteRecovery: ScenarioDefinition = {
  ...happyPath,
  id: 'retained-delete-recovery',
  description:
    'Install reaches HEALTHY; DESTROY hits DELETE_FAILED on the retained database cascade; the RetainResources retry completes it while RDS/secrets/bucket stay retained.',
  destroy: {
    timeline: [
      {
        afterMs: 10,
        atVirtualMs: 0,
        logicalResourceId: '__stack__',
        resourceType: 'AWS::CloudFormation::Stack',
        status: 'DELETE_IN_PROGRESS',
      },
      {
        afterMs: 40,
        atVirtualMs: 120_000,
        logicalResourceId: 'ApplicationDatabase',
        resourceType: 'AWS::RDS::DBInstance',
        status: 'DELETE_FAILED',
        statusReason: 'Cannot delete the instance because deletion protection is enabled',
      },
      {
        afterMs: 45,
        atVirtualMs: 135_000,
        logicalResourceId: 'DbSecurityGroup',
        resourceType: 'AWS::EC2::SecurityGroup',
        status: 'DELETE_FAILED',
        statusReason: 'Resource has 1 dependent object: NetworkInterface eni-0a1b2c3d4e5f6a7b',
      },
      {
        afterMs: 50,
        atVirtualMs: 135_000,
        logicalResourceId: 'PrivateSubnet1',
        resourceType: 'AWS::EC2::Subnet',
        status: 'DELETE_FAILED',
        statusReason:
          'The subnet has dependencies and cannot be deleted: NetworkInterface eni-0a1b2c3d4e5f6a7b is attached',
      },
      {
        afterMs: 55,
        atVirtualMs: 150_000,
        logicalResourceId: '__stack__',
        resourceType: 'AWS::CloudFormation::Stack',
        status: 'DELETE_FAILED',
        statusReason: 'One or more resources could not be deleted.',
      },
    ],
    outcome: 'delete-failed',
    blockedResources: [
      {
        logicalId: 'ApplicationDatabase',
        resourceType: 'AWS::RDS::DBInstance',
        reason: 'Cannot delete the instance because deletion protection is enabled',
      },
      {
        logicalId: 'DbSecurityGroup',
        resourceType: 'AWS::EC2::SecurityGroup',
        reason: 'Resource has 1 dependent object: NetworkInterface eni-0a1b2c3d4e5f6a7b',
      },
      {
        logicalId: 'PrivateSubnet1',
        resourceType: 'AWS::EC2::Subnet',
        reason: 'The subnet has dependencies and cannot be deleted',
      },
    ],
  },
};
