import type { ScenarioDefinition } from '../types.js';

/**
 * Network and database complete fine; `AWS::ElastiCache::ReplicationGroup`
 * (the managed Redis cache) fails to create and the stack rolls back. Used
 * together with a real application whose `redisRequired` came from the real
 * analyser (see e2e/scenario-provisioning.spec.ts's redis-failure test,
 * which seeds `deployz-demo/bullmq-worker` and drives
 * `POST /api/applications/:id/analyse` — mirrors e2e/redis.spec.ts) rather
 * than a hand-set flag, so `snapshotFailedStep`
 * (apps/api/src/deployment-status.ts) has a `redis` category to fail against
 * for a reason genuinely reachable through production logic. The
 * `redisRequired` field below is this scenario's own documentation (per
 * ../types.ts) — the harness's actual redis behaviour (whether the relay's
 * `GET /api/relay/commands` deployment meta reports `redisRequired: true`,
 * which is what `packages/relay/src/index.ts`'s `verifyInstallation` call keys
 * off) comes from the real `applications.redisRequired` column set by the
 * analyser, not from this field.
 */
export const redisFailure: ScenarioDefinition = {
  id: 'redis-failure',
  description:
    'Network + database complete; AWS::ElastiCache::ReplicationGroup CREATE_FAILED; stack rolls back to ROLLBACK_COMPLETE.',
  finalStackStatus: 'ROLLBACK_COMPLETE',
  redisRequired: true,
  timeline: [
    { afterMs: 30, atVirtualMs: 0, logicalResourceId: 'ApplicationVpc', resourceType: 'AWS::EC2::VPC', status: 'CREATE_IN_PROGRESS' },
    { afterMs: 70, atVirtualMs: 30_000, logicalResourceId: 'ApplicationVpc', resourceType: 'AWS::EC2::VPC', status: 'CREATE_COMPLETE' },
    { afterMs: 90, atVirtualMs: 40_000, logicalResourceId: 'ApplicationDatabase', resourceType: 'AWS::RDS::DBInstance', status: 'CREATE_IN_PROGRESS' },
    { afterMs: 160, atVirtualMs: 200_000, logicalResourceId: 'ApplicationDatabase', resourceType: 'AWS::RDS::DBInstance', status: 'CREATE_COMPLETE' },
    { afterMs: 180, atVirtualMs: 210_000, logicalResourceId: 'ApplicationRedis', resourceType: 'AWS::ElastiCache::ReplicationGroup', status: 'CREATE_IN_PROGRESS' },
    {
      afterMs: 320,
      atVirtualMs: 600_000,
      logicalResourceId: 'ApplicationRedis',
      resourceType: 'AWS::ElastiCache::ReplicationGroup',
      status: 'CREATE_FAILED',
      statusReason: 'The requested cache node type is not available in this Availability Zone.',
    },
    {
      afterMs: 340,
      atVirtualMs: 605_000,
      logicalResourceId: '__stack__',
      resourceType: 'AWS::CloudFormation::Stack',
      status: 'ROLLBACK_IN_PROGRESS',
      statusReason: 'The following resource(s) failed to create: [ApplicationRedis].',
    },
    {
      afterMs: 370,
      atVirtualMs: 620_000,
      logicalResourceId: '__stack__',
      resourceType: 'AWS::CloudFormation::Stack',
      status: 'ROLLBACK_COMPLETE',
    },
  ],
};
