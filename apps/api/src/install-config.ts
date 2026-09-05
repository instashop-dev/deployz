import { generatedEnvKeys } from '@deployz/analysis';
import type { RuntimeDb } from '@deployz/db';

import { getConfig, type ConfigStore, type EffectiveConfigEntry } from './config.js';
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
  const entries: RelayConfigEntry[] = view.effective.map((entry) => ({
    key: entry.key,
    isSecret: entry.isSecret,
    ...(entry.isSecret ? {} : { value: entry.value ?? '' }),
    source: entry.source,
  }));
  const configured = new Set(entries.map((entry) => entry.key));
  const manifest = readStoredManifest(deployment.desiredState);
  for (const key of manifest ? generatedEnvKeys(manifest) : []) {
    if (configured.has(key)) continue;
    entries.push({ key, isSecret: true, source: 'generated', generated: true });
  }
  return entries;
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
