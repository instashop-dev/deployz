import type { ScenarioDefinition } from '../types.js';
import { bootstrapFailure } from './bootstrap-failure.js';
import { cloudformationFailure } from './cloudformation-failure.js';
import { cloudformationRollback } from './cloudformation-rollback.js';
import { databaseFailure } from './database-failure.js';
import { ecsFailure } from './ecs-failure.js';
import { happyPath } from './happy-path.js';
import { healthcheckFailure } from './healthcheck-failure.js';
import { redisFailure } from './redis-failure.js';
import { relayDisconnect } from './relay-disconnect.js';
import { slowProvision } from './slow-provision.js';

/**
 * Registry of implemented scenarios. Phase 1 D1 (provisioning-side failures)
 * added slow-provision, cloudformation-failure, database-failure,
 * redis-failure, bootstrap-failure and relay-disconnect on top of the
 * original happy-path/cloudformation-rollback/ecs-failure/healthcheck-failure
 * four. The remaining Phase 1 scenario list (update-failure,
 * rollback-success/failure, delete-failure, retained-resources) is future
 * work; `ScenarioDefinition` (../types.ts) is shaped so adding them never
 * requires reshaping it.
 */
const SCENARIOS: Readonly<Record<string, ScenarioDefinition>> = {
  [happyPath.id]: happyPath,
  [cloudformationRollback.id]: cloudformationRollback,
  [ecsFailure.id]: ecsFailure,
  [healthcheckFailure.id]: healthcheckFailure,
  [slowProvision.id]: slowProvision,
  [cloudformationFailure.id]: cloudformationFailure,
  [databaseFailure.id]: databaseFailure,
  [redisFailure.id]: redisFailure,
  [bootstrapFailure.id]: bootstrapFailure,
  [relayDisconnect.id]: relayDisconnect,
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

export {
  bootstrapFailure,
  cloudformationFailure,
  cloudformationRollback,
  databaseFailure,
  ecsFailure,
  happyPath,
  healthcheckFailure,
  redisFailure,
  relayDisconnect,
  slowProvision,
};
