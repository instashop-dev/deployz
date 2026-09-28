import type { ScenarioDefinition } from '../types.js';
import { happyPath } from './happy-path.js';

/**
 * Phase 4C migration-failure: the one-shot migration task STOPPED with exit
 * code 1, so the release deploy fails with MIGRATION_FAILED, names the
 * migration, and NO service is rolled — the previous release keeps serving.
 * `@scenario:migration-failure` asserts the failure surfaces with actionable
 * diagnostics and the services are untouched.
 */
export const migrationFailure: ScenarioDefinition = {
  ...happyPath,
  id: 'migration-failure',
  description:
    'The release deploy runs the frozen migration task first; it exits 1, the deploy fails MIGRATION_FAILED and no service rolls.',
  migrationBehavior: 'fail',
};
