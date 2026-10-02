import type { ScenarioDefinition } from '../types.js';
import { happyPath } from './happy-path.js';

/**
 * Migration recovery on an existing deployment: the frozen migration command
 * exits 1, so the first release deploy fails MIGRATION_FAILED and no service
 * rolls. A vendor correction (a new revision of the same migration family
 * with another command) succeeds on the SAME image; "No separate migration"
 * skips the migration and deploys. The spec, artifact and stack never change.
 */
export const migrationCorrection: ScenarioDefinition = {
  ...happyPath,
  id: 'migration-correction',
  description:
    'The frozen migration command fails; a corrected command, or no separate migration, recovers the same release without changing the deployment.',
  migrationBehavior: 'fail-frozen',
};
