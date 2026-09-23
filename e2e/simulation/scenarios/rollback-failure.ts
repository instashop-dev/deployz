import type { ScenarioDefinition } from '../types.js';
import { happyPath } from './happy-path.js';

/**
 * Lifecycle D2: same setup as update-failure (the post-install auto-deploy
 * and v1 deploy succeed, v2 deploy fails), but the rollback to v1 ALSO fails —
 * the fourth UpdateService call consumes 'fail' too. No release pointer ever advances past v1, and the
 * relay must never report a false success.
 */
export const rollbackFailure: ScenarioDefinition = {
  ...happyPath,
  id: 'rollback-failure',
  description: 'Install reaches HEALTHY; v2 deploy fails; the rollback to v1 also fails.',
  updateRollouts: ['succeed', 'succeed', 'fail', 'fail'],
};
