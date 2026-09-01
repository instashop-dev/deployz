import type { ScenarioDefinition } from '../types.js';
import { happyPath } from './happy-path.js';

/**
 * Lifecycle D2: same setup as update-failure (v1 deploy succeeds, v2 deploy
 * fails), plus a third UpdateService call — the rollback to v1 — that
 * succeeds. See ../simulated-account.ts's `ecsDeployClient` for how
 * `updateRollouts` is consumed in order, one outcome per call.
 */
export const rollbackSuccess: ScenarioDefinition = {
  ...happyPath,
  id: 'rollback-success',
  description: 'Install reaches HEALTHY; v2 deploy fails; rollback to v1 succeeds.',
  updateRollouts: ['succeed', 'fail', 'succeed'],
};
