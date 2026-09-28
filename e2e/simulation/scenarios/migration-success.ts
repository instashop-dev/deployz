import type { ScenarioDefinition } from '../types.js';
import { happyPath } from './happy-path.js';

/**
 * Phase 4C migration-success: the deployment's frozen spec carries a one-shot
 * migration workload, so the post-install auto-deploy (and every later release
 * deploy with a NEW migration identity) runs the spec-frozen migration task
 * BEFORE any service rolls. The simulated account answers the migration task
 * with exit 0 (the default `migrationBehavior`), then the rollout proceeds
 * exactly like happy-path. `@scenario:migration-success` asserts ordering
 * (migration before any service update) and exactly-once semantics.
 */
export const migrationSuccess: ScenarioDefinition = {
  ...happyPath,
  id: 'migration-success',
  description:
    'Install reaches HEALTHY; the release deploy runs the frozen migration task first (exit 0), then rolls the services.',
  migrationBehavior: 'succeed',
};
