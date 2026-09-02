import type { ScenarioDefinition } from '../types.js';
import { bootstrapFailure } from './bootstrap-failure.js';
import { cloudformationFailure } from './cloudformation-failure.js';
import { cloudformationRollback } from './cloudformation-rollback.js';
import { databaseFailure } from './database-failure.js';
import { deleteFailure } from './delete-failure.js';
import { ecsFailure } from './ecs-failure.js';
import { happyPath } from './happy-path.js';
import { healthcheckFailure } from './healthcheck-failure.js';
import { redisFailure } from './redis-failure.js';
import { relayDisconnect } from './relay-disconnect.js';
import { retainedResources } from './retained-resources.js';
import { rollbackFailure } from './rollback-failure.js';
import { rollbackSuccess } from './rollback-success.js';
import { slowProvision } from './slow-provision.js';
import { transientAws } from './transient-aws.js';
import { updateFailure } from './update-failure.js';

/**
 * Registry of implemented scenarios. Phase 1 D1 (provisioning-side failures)
 * added slow-provision, cloudformation-failure, database-failure,
 * redis-failure, bootstrap-failure and relay-disconnect on top of the
 * original happy-path/cloudformation-rollback/ecs-failure/healthcheck-failure
 * four. Phase 1 D2 (lifecycle: update/rollback/destroy) adds update-failure,
 * rollback-success, rollback-failure, delete-failure and retained-resources.
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
  [updateFailure.id]: updateFailure,
  [rollbackSuccess.id]: rollbackSuccess,
  [rollbackFailure.id]: rollbackFailure,
  [deleteFailure.id]: deleteFailure,
  [retainedResources.id]: retainedResources,
  [transientAws.id]: transientAws,
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
  deleteFailure,
  ecsFailure,
  happyPath,
  healthcheckFailure,
  redisFailure,
  relayDisconnect,
  retainedResources,
  rollbackFailure,
  rollbackSuccess,
  slowProvision,
  transientAws,
  updateFailure,
};
