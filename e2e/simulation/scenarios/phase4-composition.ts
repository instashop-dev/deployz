import type { ScenarioDefinition, TimelineEvent } from '../types.js';
import { happyPath } from './happy-path.js';
import { retainedResources } from './retained-resources.js';

/**
 * The multi-service timeline (web + two worker services) with a managed
 * MySQL database (engine-blind `AWS::RDS::DBInstance`) AND an ElastiCache
 * Redis replication group — both reaching CREATE_COMPLETE so the relay's
 * requirement-aware verification passes for a MySQL+Redis app. Workers get
 * no load-balancer events (no ALB/target group exists for them, Phase 4A).
 * Timeline events are authored in strictly non-decreasing `afterMs` order —
 * array order doubles as reveal order.
 */
const compositionTimeline: readonly TimelineEvent[] = [
  ...happyPath.timeline.filter((event) => event.logicalResourceId !== 'ApplicationService'),
  { afterMs: 200, atVirtualMs: 120_000, logicalResourceId: 'CacheReplicationGroup', resourceType: 'AWS::ElastiCache::ReplicationGroup', status: 'CREATE_IN_PROGRESS' },
  { afterMs: 260, atVirtualMs: 200_000, logicalResourceId: 'CacheReplicationGroup', resourceType: 'AWS::ElastiCache::ReplicationGroup', status: 'CREATE_COMPLETE' },
  { afterMs: 350, atVirtualMs: 360_000, logicalResourceId: 'WebService', resourceType: 'AWS::ECS::Service', status: 'CREATE_IN_PROGRESS' },
  { afterMs: 360, atVirtualMs: 380_000, logicalResourceId: 'EmailWorkerService', resourceType: 'AWS::ECS::Service', status: 'CREATE_IN_PROGRESS' },
  { afterMs: 370, atVirtualMs: 400_000, logicalResourceId: 'ImportWorkerService', resourceType: 'AWS::ECS::Service', status: 'CREATE_IN_PROGRESS' },
  { afterMs: 420, atVirtualMs: 420_000, logicalResourceId: 'WebService', resourceType: 'AWS::ECS::Service', status: 'CREATE_COMPLETE' },
  { afterMs: 425, atVirtualMs: 422_000, logicalResourceId: 'EmailWorkerService', resourceType: 'AWS::ECS::Service', status: 'CREATE_COMPLETE' },
  { afterMs: 428, atVirtualMs: 424_000, logicalResourceId: 'ImportWorkerService', resourceType: 'AWS::ECS::Service', status: 'CREATE_COMPLETE' },
  { afterMs: 430, atVirtualMs: 425_000, logicalResourceId: '__stack__', resourceType: 'AWS::CloudFormation::Stack', status: 'CREATE_COMPLETE' },
];

/**
 * Phase 4D composition proof: the FULL Phase-4 topology in one lifecycle —
 * three workload services (WebService, EmailWorkerService, ImportWorkerService;
 * workers with no load balancer) over a managed MySQL database and Redis,
 * with the one-shot migration task. Install reaches HEALTHY; `updateRollouts`
 * supplies the UpdateService outcomes for five service rollouts, one outcome
 * per service per deploy, issued web-first (3 × 'succeed' each):
 *
 *   1. post-install auto-deploy (first start + migration)  → 3
 *   2. v1 deploy (new migration identity)                   → 3
 *   3. rollback to the auto-deployed release                → 3
 *   4. re-deploy of v1 (SAME identity — migration skipped)  → 3
 *   5. headroom for a later rollout                          → 3
 *
 * RESTART's forceNewDeployment never consumes an outcome. `destroy` comes
 * from retained-resources (a clean DELETE_COMPLETE that RETAINS the RDS
 * instance, cache, secrets and bucket by policy) and `purge` then sweeps
 * the retained MySQL instance — the Phase-4B generic engine-blind sweep.
 */
export const phase4Composition: ScenarioDefinition = {
  ...retainedResources,
  id: 'phase4-composition',
  description:
    'Install reaches HEALTHY with web + two workers + migration over MySQL and Redis; deploys, restart, rollback and a same-identity re-deploy roll the services; DESTROY retains the data resources; PURGE sweeps the retained MySQL instance.',
  timeline: compositionTimeline,
  purge: {
    retainedDbInstance: {
      identifier: 'deployz-primary-db-mysql',
      subnetGroup: 'deployz-primary-db-subnet-group',
    },
  },
  updateRollouts: Array.from({ length: 15 }, () => 'succeed' as const),
};
