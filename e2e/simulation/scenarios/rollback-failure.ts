import type { ScenarioDefinition } from '../types.js';
import { happyPath } from './happy-path.js';

/**
 * Lifecycle D2: same setup as update-failure (v1 deploy succeeds, v2 deploy
 * fails), but the rollback to v1 ALSO fails — the third UpdateService call
 * consumes 'fail' too. No release pointer ever advances past v1, and the
 * relay must never report a false success.
 */
export const rollbackFailure: ScenarioDefinition = {
  ...happyPath,
  id: 'rollback-failure',
  description: 'Install reaches HEALTHY; v2 deploy fails; the rollback to v1 also fails.',
  updateRollouts: ['succeed', 'fail', 'fail'],
};
