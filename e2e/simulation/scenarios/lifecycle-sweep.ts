import type { ScenarioDefinition } from '../types.js';
import { retainedResources } from './retained-resources.js';

/**
 * Phase 14 full-lifecycle sweep: one scenario that lets ONE test drive a
 * single deployment through the whole reachable chain. Install behaves
 * exactly like happy-path; `updateRollouts` then supplies the four
 * UpdateService outcomes the sweep's deploy sequence needs, in order:
 *
 *   1. post-install auto-deploy      (rollout 1: 'succeed')
 *   2. v1 deploy succeeds            (rollout 2: 'succeed')
 *   3. v2 deploy fails               (rollout 3: 'fail'    — ECS circuit breaker)
 *   4. rollback to v1 succeeds       (rollout 4: 'succeed')
 *   5. post-reconnect deploy of v3   (rollout 5: 'succeed')
 *
 * and `destroy` comes from retained-resources (a clean DELETE_COMPLETE) so
 * the sweep can end with a PURGE of the DELETED deployment.
 */
export const lifecycleSweep: ScenarioDefinition = {
  ...retainedResources,
  id: 'lifecycle-sweep',
  description:
    'Install reaches HEALTHY; v1 deploy succeeds, v2 deploy fails, rollback to v1 succeeds, a later deploy succeeds, then DESTROY completes cleanly.',
  updateRollouts: ['succeed', 'succeed', 'fail', 'succeed', 'succeed'],
};
