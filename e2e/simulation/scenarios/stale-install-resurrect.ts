import type { ScenarioDefinition } from '../types.js';
import { cloudformationRollback } from './cloudformation-rollback.js';

/**
 * Stale-install-resurrect regression: a pending INSTALL marker left behind
 * after a failed install (cloudformation-rollback) must NOT cause the relay
 * to recreate the stack after a DESTROY has completed.
 *
 * This scenario reuses the cloudformation-rollback timeline (RDS CREATE_FAILED
 * → ROLLBACK_COMPLETE) but does NOT define a `destroy` block — the simulator
 * must allow the recovery create path so the regression is observable pre-fix.
 * The test drives the DESTROY through the real API and the real relay code.
 */
export const staleInstallResurrect: ScenarioDefinition = {
  ...cloudformationRollback,
  id: 'stale-install-resurrect',
  description:
    'Stale INSTALL pending marker after failed install + DESTROY: the resumer must not recreate the stack.',
};
