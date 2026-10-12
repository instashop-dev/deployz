import type { ScenarioDefinition } from '../types.js';
import { happyPath } from './happy-path.js';

/**
 * A configuration update on a running deployment: the ECS circuit breaker
 * rolls the first configuration rollout back, so the previous revision keeps
 * serving and the CONFIG_UPDATE fails without touching the lifecycle state
 * or the release pointer. The next configuration update succeeds.
 */
export const configUpdateFailure: ScenarioDefinition = {
  ...happyPath,
  id: 'config-update-failure',
  description:
    'A configuration rollout is rolled back by the circuit breaker; the previous revision keeps serving and the update fails honestly.',
  configRollouts: ['rollback'],
};
