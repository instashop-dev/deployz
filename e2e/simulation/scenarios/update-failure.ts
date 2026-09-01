import type { ScenarioDefinition } from '../types.js';
import { happyPath } from './happy-path.js';

/**
 * Lifecycle D2: install reaches HEALTHY exactly like happy-path (same
 * timeline/outputs/ecsBehavior), then a second release's DEPLOY_RELEASE
 * rolls out and the ECS deployment circuit breaker trips.
 *
 * `updateRollouts` is consumed one outcome per UpdateService call — see
 * deploy.ts's `settleEcsDeploy` and ../simulated-account.ts's
 * `ecsDeployClient`. The test drives two real deploys against this
 * deployment (v1, then v2): the FIRST UpdateService call (v1's own deploy)
 * always succeeds, the SECOND (v2's) fails.
 */
export const updateFailure: ScenarioDefinition = {
  ...happyPath,
  id: 'update-failure',
  description:
    'Install reaches HEALTHY; a second release deploy rolls out and the ECS deployment circuit breaker trips.',
  updateRollouts: ['succeed', 'fail'],
};
