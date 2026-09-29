import type { ScenarioDefinition, TimelineEvent } from '../types.js';
import { happyPath } from './happy-path.js';
import { retainedResources } from './retained-resources.js';

/**
 * Phase 5 composition timeline: `deployz-demo/async-app`'s topology — a web
 * service and a worker service over a managed MySQL database (engine-blind
 * `AWS::RDS::DBInstance`, same as happy-path/mysql-sweep), a standard SQS
 * queue with its own dead-letter queue (`orders-queue` / `orders-queue-dlq`,
 * logical ids `OrdersQueueQueue`/`OrdersQueueDlqQueue` — `pascalCase(componentId,
 * 'queue')`, packages/infrastructure-compiler/src/stable-identity.ts), and an
 * EventBridge Scheduler schedule (`cleanup-schedule`, logical id
 * `CleanupScheduleSchedule`) targeting the one-shot scheduled-job task
 * definition `CleanupTaskDefinition` (family `DeployzAppCleanup`,
 * `deployzTaskFamily('cleanup')`). Every logical id here is derived by hand
 * from the same `pascalCase(componentId, resourceRole)` rule the compiler and
 * `@deployz/contracts` pin with golden tests, exactly like
 * `phase4-composition.ts` hand-derives `EmailWorkerService` — no dynamic
 * lookup exists yet for a scenario's own timeline authoring.
 *
 * Timeline events are authored in strictly non-decreasing `afterMs` order —
 * array order doubles as reveal order (see `SimulatedCustomerAccount`'s doc
 * comment).
 */
const compositionTimeline: readonly TimelineEvent[] = [
  // The stack-level IN_PROGRESS marker — kept first, exactly like happyPath's
  // own. Its own `__stack__` CREATE_COMPLETE (at 430ms) is dropped below: this
  // scenario appends its OWN, later one — keeping happyPath's original would
  // let the stack report CREATE_COMPLETE (the "latest revealed stack-level
  // event" — see SimulatedCustomerAccount.currentStackStatus) long before the
  // services, queues and schedule this scenario adds have actually finished.
  { afterMs: 20, atVirtualMs: 0, logicalResourceId: '__stack__', resourceType: 'AWS::CloudFormation::Stack', status: 'CREATE_IN_PROGRESS' },
  ...happyPath.timeline.filter(
    (event) => event.logicalResourceId !== 'ApplicationService' && event.logicalResourceId !== '__stack__',
  ),
  // The cluster itself — needed so DESTROY's `stopStandaloneTasks`
  // (packages/relay/src/destroy.ts) can find it and stop a running
  // standalone (scheduled-job) task before the delete call.
  { afterMs: 340, atVirtualMs: 355_000, logicalResourceId: 'WebCluster', resourceType: 'AWS::ECS::Cluster', status: 'CREATE_COMPLETE' },
  { afterMs: 350, atVirtualMs: 360_000, logicalResourceId: 'WebService', resourceType: 'AWS::ECS::Service', status: 'CREATE_IN_PROGRESS' },
  { afterMs: 355, atVirtualMs: 365_000, logicalResourceId: 'WorkerService', resourceType: 'AWS::ECS::Service', status: 'CREATE_IN_PROGRESS' },
  // The queue/DLQ/schedule resources below carry a SINGLE CREATE_COMPLETE
  // event each (no CREATE_IN_PROGRESS phase) — deliberately, unlike the
  // VPC/database/storage resources above. `specComponentsForStatus`'s
  // `aggregateEvents` (apps/api/src/spec-components.ts) marks a component
  // COMPLETE only once EVERY stack event it has ever seen for that
  // component is itself COMPLETE — a resource whose IN_PROGRESS event was
  // also captured stays reported IN_PROGRESS for the rest of the install,
  // even once its own CREATE_COMPLETE event follows. That is a real,
  // pre-existing quirk of the specComponents projection (not Phase-5-
  // specific — it affects the database/storage entries above the exact same
  // way), reported in this scenario's spec file rather than worked around
  // in product code.
  { afterMs: 365, atVirtualMs: 372_000, logicalResourceId: 'OrdersQueueDlqQueue', resourceType: 'AWS::SQS::Queue', status: 'CREATE_COMPLETE' },
  { afterMs: 368, atVirtualMs: 373_000, logicalResourceId: 'OrdersQueueDlqQueuePolicy', resourceType: 'AWS::SQS::QueuePolicy', status: 'CREATE_COMPLETE' },
  { afterMs: 375, atVirtualMs: 377_000, logicalResourceId: 'OrdersQueueQueue', resourceType: 'AWS::SQS::Queue', status: 'CREATE_COMPLETE' },
  { afterMs: 378, atVirtualMs: 378_000, logicalResourceId: 'OrdersQueueQueuePolicy', resourceType: 'AWS::SQS::QueuePolicy', status: 'CREATE_COMPLETE' },
  { afterMs: 382, atVirtualMs: 380_000, logicalResourceId: 'CleanupTaskDefinition', resourceType: 'AWS::ECS::TaskDefinition', status: 'CREATE_COMPLETE' },
  { afterMs: 384, atVirtualMs: 381_000, logicalResourceId: 'CleanupTaskSecurityGroup', resourceType: 'AWS::EC2::SecurityGroup', status: 'CREATE_COMPLETE' },
  { afterMs: 386, atVirtualMs: 382_000, logicalResourceId: 'CleanupScheduleSchedulerRole', resourceType: 'AWS::IAM::Role', status: 'CREATE_COMPLETE' },
  { afterMs: 388, atVirtualMs: 383_000, logicalResourceId: 'CleanupScheduleSchedulerRolePolicy', resourceType: 'AWS::IAM::Policy', status: 'CREATE_COMPLETE' },
  { afterMs: 400, atVirtualMs: 400_000, logicalResourceId: 'CleanupScheduleSchedule', resourceType: 'AWS::Scheduler::Schedule', status: 'CREATE_COMPLETE' },
  // A deliberately wide gap before the stack itself settles: every queue/
  // schedule resource above is already CREATE_COMPLETE well before the
  // services and the stack are — a real multi-second window during which
  // GET /api/install/:id/status's specComponents (server.ts's
  // `stackOperationActive` — only queried while `stage === 'PROVISIONING'`,
  // and only reflects whatever the relay's stack-event collector has
  // batched to the control plane by then) can be polled for the queue/DLQ/
  // schedule's friendly-labeled, non-CFN component identity. See
  // scenario-phase5-composition.spec.ts.
  { afterMs: 3_500, atVirtualMs: 3_500_000, logicalResourceId: 'WebService', resourceType: 'AWS::ECS::Service', status: 'CREATE_COMPLETE' },
  { afterMs: 3_505, atVirtualMs: 3_502_000, logicalResourceId: 'WorkerService', resourceType: 'AWS::ECS::Service', status: 'CREATE_COMPLETE' },
  { afterMs: 3_510, atVirtualMs: 3_505_000, logicalResourceId: '__stack__', resourceType: 'AWS::CloudFormation::Stack', status: 'CREATE_COMPLETE' },
];

/**
 * Phase 5 composition proof: `web` + `worker` services over MySQL, a
 * standard SQS queue with its own dead-letter queue, and an EventBridge
 * Scheduler schedule targeting the `cleanup` one-shot scheduled job. Install
 * reaches HEALTHY; `updateRollouts` supplies the UpdateService outcomes for
 * the two persistent services, issued web-first, one pass per deploy:
 *
 *   1. post-install auto-deploy (first start)  → 2
 *   2. RESTART                                  → 2 (never consumes a knob,
 *                                                     kept for headroom)
 *   3. v1 deploy                                 → 2
 *   4. ROLLBACK                                  → 2
 *
 * DESTROY (from `retainedResources`) completes cleanly (DELETE_COMPLETE)
 * while the database/storage stay retained by policy — same engine-blind
 * behaviour as mysql-sweep; PURGE then sweeps the retained MySQL instance.
 */
export const phase5Composition: ScenarioDefinition = {
  ...retainedResources,
  id: 'phase5-composition',
  description:
    'Install reaches HEALTHY with web + worker over MySQL, an SQS queue + DLQ, and an EventBridge Scheduler schedule targeting a scheduled-job task; deploy, restart and rollback roll the services; DESTROY retains the database; PURGE sweeps it.',
  timeline: compositionTimeline,
  purge: {
    retainedDbInstance: {
      identifier: 'deployz-primary-db-mysql',
      subnetGroup: 'deployz-primary-db-subnet-group',
    },
  },
  updateRollouts: Array.from({ length: 8 }, () => 'succeed' as const),
};
