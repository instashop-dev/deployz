import { generatedEnvKeys } from '@deployz/analysis';
import { infrastructureProfileForManifest, type DeploymentManifest } from '@deployz/contracts';
import type { RuntimeDb } from '@deployz/db';

import { getConfig, type ConfigStore, type EffectiveConfigEntry } from './config.js';
import { ApiError } from './errors.js';
import { DESIRED_COUNT_PARAMETER, buildInstallParameters } from './install-parameters.js';
import { createOrReuseJob } from './jobs.js';
import { readStoredManifest } from './manifest.js';

// Post-install configuration (AI MVP Phase 4).
//
// A fresh install runs the template's task definition: it carries the
// managed bindings (database, cache, storage, port) and nothing the vendor
// configured. The CONFIG_UPDATE fan-out only ever targets installed
// deployments, so a value saved before the first install never reached it,
// and an app-internal secret Deployz should mint had no moment to be minted.
// This module gives a successful INSTALL that moment: one CONFIG_UPDATE job
// (no values in the payload — the relay fetches the effective config and
// mints generated secrets inside the customer's account) whenever there is
// anything to apply.

/** One line of the relay's effective-config view, plus the generated keys it must mint. */
export interface RelayConfigEntry {
  key: string;
  isSecret: boolean;
  value?: string;
  source: EffectiveConfigEntry['source'] | 'generated';
  generated?: true;
}

/**
 * The entries the relay applies: every effective config entry (plain values
 * travel, secret values never do) plus, for each generated key without a
 * vendor or customer value, an entry the relay mints.
 */
export async function buildRelayConfigEntries(
  db: RuntimeDb,
  deployment: { applicationId: string; customerId: string; desiredState: Record<string, unknown> | null },
  store: ConfigStore,
): Promise<RelayConfigEntry[]> {
  const view = await getConfig(deployment.applicationId, deployment.customerId, store);
  const manifest = readStoredManifest(deployment.desiredState);
  const mintable = new Set<string>(manifest ? mintableKeys(manifest) : []);
  // A secret the vendor typed is write-only (§31): its value reached only
  // the deployments whose relay was connected at the time, and a deployment
  // installed later has nothing to bind. For an app-internal secret the
  // relay may mint one — it keeps any value already in the customer's
  // store, so a delivered vendor value always wins (DEPLOY-013).
  const entries: RelayConfigEntry[] = view.effective.map((entry) => ({
    key: entry.key,
    isSecret: entry.isSecret,
    ...(entry.isSecret ? {} : { value: entry.value ?? '' }),
    source: entry.source,
    ...(entry.isSecret && mintable.has(entry.key) ? { generated: true as const } : {}),
  }));
  const configured = new Set(entries.map((entry) => entry.key));
  for (const key of mintable) {
    if (configured.has(key)) continue;
    entries.push({ key, isSecret: true, source: 'generated', generated: true });
  }
  return entries;
}

/**
 * Keys the relay may mint inside the customer's account when no value has
 * reached it: the analyser's `deployz_generated` classification, plus every
 * secret whose purpose is an app-internal secret (a JWT/session/encryption
 * key the application only needs to be random) whatever its classification.
 * External credentials and customer-required values are never minted.
 */
function mintableKeys(manifest: DeploymentManifest): string[] {
  const generated = new Set(generatedEnvKeys(manifest));
  for (const variable of manifest.environment.variables) {
    if (variable.secret === true && variable.purpose === 'internal_secret') generated.add(variable.key);
  }
  return [...generated];
}

/**
 * Whether anything must reach the task before it first starts (DEPLOY-009):
 * a vendor/customer value or a generated secret. An application that
 * validates such a value at boot exits on an unconfigured task, so the
 * install then creates the service with zero tasks and the first deploy
 * after the configuration pass is the first start.
 */
export async function configPrecedesFirstStart(
  db: RuntimeDb,
  deployment: { applicationId: string; customerId: string; desiredState: Record<string, unknown> | null },
  store: ConfigStore,
): Promise<boolean> {
  return (await buildRelayConfigEntries(db, deployment, store)).length > 0;
}

/**
 * The INSTALL job's payload: the template parameters, the Redis/database
 * flags, the canonical manifest and — when configuration must precede the
 * first start and there is a release to run — `startAfterConfig`, the marker
 * that this install starts no task by itself (the service is created with
 * `param_DesiredCount=0`; the post-install CONFIG_UPDATE and the auto-deploy
 * that follow are the first start).
 *
 * `databaseRequired`/`redisRequired` are derived from the deployment's
 * frozen manifest, never the live `applications` columns (Phase 2) — the
 * relay's INSTALL executor and the heartbeat's requirement checks must agree
 * with whatever this deployment was actually created with, even after a
 * vendor later changes the application's requirements.
 */
export async function buildInstallPayload(
  db: RuntimeDb,
  deployment: { id: string; applicationId: string; customerId: string; desiredState: Record<string, unknown> | null },
  store: ConfigStore,
): Promise<Record<string, unknown>> {
  const manifest = readStoredManifest(deployment.desiredState);
  if (!manifest) {
    throw new ApiError(
      422,
      'MANIFEST_NEEDS_CONFIGURATION',
      'Deployment has no valid deployment manifest. Run analysis or correct the application configuration first.',
    );
  }
  const profile = infrastructureProfileForManifest(manifest);
  const startAfterConfig = await configPrecedesFirstStart(db, deployment, store);
  const parameters = await buildInstallParameters(db, deployment.id, { startAfterConfig });
  return {
    parameters,
    databaseRequired: profile.postgres,
    redisRequired: profile.redis,
    // The canonical manifest this deployment was created with — the relay
    // derives port/health/binding parameters from it (Phase 2).
    manifest,
    ...(parameters[DESIRED_COUNT_PARAMETER] === '0' ? { startAfterConfig: true } : {}),
  };
}

/**
 * Queue the first configuration pass for a deployment whose INSTALL just
 * succeeded, when there is anything to apply. Idempotent per install job;
 * a replayed INSTALL result reuses the job. Creates no event: the result
 * route records `config.updated` / `config.failed` as for any config job.
 */
export async function queuePostInstallConfig(
  db: RuntimeDb,
  deployment: { id: string; applicationId: string; customerId: string; desiredState: Record<string, unknown> | null },
  installJobId: string,
  store: ConfigStore,
): Promise<{ queued: boolean }> {
  const entries = await buildRelayConfigEntries(db, deployment, store);
  if (entries.length === 0) return { queued: false };
  const { created } = await createOrReuseJob(db, {
    deploymentId: deployment.id,
    type: 'CONFIG_UPDATE',
    idempotencyKey: `${deployment.id}:CONFIG_UPDATE:install:${installJobId}`,
    payload: { reason: 'install', changedKeys: entries.map((entry) => entry.key) },
    requestedBy: null,
  });
  return { queued: created };
}
