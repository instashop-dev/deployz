import type { ScenarioDefinition, TimelineEvent } from '../types.js';
import { happyPath } from './happy-path.js';
import { retainedResources } from './retained-resources.js';

/**
 * The happy-path timeline with the web service named as the compiled template
 * names it (WebService) and TWO worker services added — workers get no
 * load-balancer events (no ALB/target group exists for them, Phase 4A).
 * Timeline events are authored in strictly non-decreasing `afterMs` order —
 * array order doubles as reveal order.
 */
const multiWorkerTimeline: readonly TimelineEvent[] = [
  ...happyPath.timeline.filter((event) => event.logicalResourceId !== 'ApplicationService'),
  { afterMs: 350, atVirtualMs: 360_000, logicalResourceId: 'WebService', resourceType: 'AWS::ECS::Service', status: 'CREATE_IN_PROGRESS' },
  { afterMs: 360, atVirtualMs: 380_000, logicalResourceId: 'EmailWorkerService', resourceType: 'AWS::ECS::Service', status: 'CREATE_IN_PROGRESS' },
  { afterMs: 370, atVirtualMs: 400_000, logicalResourceId: 'ImportWorkerService', resourceType: 'AWS::ECS::Service', status: 'CREATE_IN_PROGRESS' },
  { afterMs: 420, atVirtualMs: 420_000, logicalResourceId: 'WebService', resourceType: 'AWS::ECS::Service', status: 'CREATE_COMPLETE' },
  { afterMs: 425, atVirtualMs: 422_000, logicalResourceId: 'EmailWorkerService', resourceType: 'AWS::ECS::Service', status: 'CREATE_COMPLETE' },
  { afterMs: 428, atVirtualMs: 424_000, logicalResourceId: 'ImportWorkerService', resourceType: 'AWS::ECS::Service', status: 'CREATE_COMPLETE' },
  { afterMs: 430, atVirtualMs: 425_000, logicalResourceId: '__stack__', resourceType: 'AWS::CloudFormation::Stack', status: 'CREATE_COMPLETE' },
];

/**
 * Phase 4A multi-workload lifecycle: one stack with THREE ECS services —
 * the web workload plus two Procfile-declared workers (WebService,
 * EmailWorkerService, ImportWorkerService; workers have NO load balancer and
 * NO target group). Install behaves exactly like happy-path; `updateRollouts`
 * then supplies the UpdateService outcomes the sweep's deploy sequence needs,
 * one per service per deploy, issued web-first:
 *
 *   1. post-install auto-deploy (first start from zero)  → succeed ×3
 *   2. v1 deploy                                          → succeed ×3
 *   3. v2 deploy                                          → succeed ×3
 *   4. rollback to v1                                     → succeed ×3
 *
 * A RESTART's forceNewDeployment never consumes an outcome (it redeploys the
 * current definition). `destroy` comes from retained-resources (a clean
 * DELETE_COMPLETE) so the scenario can end with a PURGE.
 */
export const multiWorkerSweep: ScenarioDefinition = {
  ...retainedResources,
  id: 'multi-worker-sweep',
  description:
    'Install reaches HEALTHY with web + two worker services (no ALB on workers); deploy, restart and rollback roll every service; DESTROY completes cleanly.',
  timeline: multiWorkerTimeline,
  updateRollouts: Array.from({ length: 12 }, () => 'succeed' as const),
};
