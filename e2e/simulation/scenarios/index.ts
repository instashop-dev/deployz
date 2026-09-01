import type { ScenarioDefinition } from '../types.js';
import { cloudformationRollback } from './cloudformation-rollback.js';
import { ecsFailure } from './ecs-failure.js';
import { happyPath } from './happy-path.js';
import { healthcheckFailure } from './healthcheck-failure.js';

/**
 * Registry of implemented scenarios. Only these four exist today — the
 * remaining Phase 1 scenario list (slow-provision, bootstrap-failure,
 * cloudformation-failure, ecs-failure variants, database-failure,
 * redis-failure, relay-disconnect, update-failure, rollback-success/failure,
 * delete-failure, retained-resources) is future work; `ScenarioDefinition`
 * (../types.ts) is shaped so adding them never requires reshaping it.
 */
const SCENARIOS: Readonly<Record<string, ScenarioDefinition>> = {
  [happyPath.id]: happyPath,
  [cloudformationRollback.id]: cloudformationRollback,
  [ecsFailure.id]: ecsFailure,
  [healthcheckFailure.id]: healthcheckFailure,
};

export function getScenario(id: string): ScenarioDefinition {
  const scenario = SCENARIOS[id];
  if (!scenario) {
    throw new Error(
      `Unknown deployz E2E scenario "${id}" — known scenarios: ${Object.keys(SCENARIOS).join(', ')}`,
    );
  }
  return scenario;
}

export { cloudformationRollback, ecsFailure, happyPath, healthcheckFailure };
