import { normalizeDeploymentManifest } from '@deployz/analysis';
import {
  environmentSettingsSchema,
  evaluateEnvironmentSetup,
  type EnvironmentSetting,
  type EnvironmentSetupEvaluation,
} from '@deployz/contracts';
import type { RuntimeDb } from '@deployz/db';

import { listProvidedConfigKeys } from './config.js';
import { applicationToManifestOverrides, type ManifestApplicationRow } from './manifest.js';

// Env-var setup (docs/environment-variables.md) — the API-side glue between the stored
// vendor decisions (`applications.environment_settings`) and the pure
// contracts helper that combines them with the detected manifest into the
// rows the config page, preflight and public install all read.

/** Parse the stored `environment_settings` jsonb column; invalid data never crashes a request. */
export function readEnvironmentSettings(app: { environmentSettings?: unknown }): EnvironmentSetting[] | null {
  const raw = app.environmentSettings;
  if (raw === null || raw === undefined) return null;
  const parsed = environmentSettingsSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

export type EnvironmentSetupApplicationRow = ManifestApplicationRow & {
  id: string;
  environmentSettings?: unknown;
};

/**
 * The evaluation for one application: the effective manifest (the same
 * construction `runApplicationPreflight` builds), its saved settings, and
 * the vendor-default keys that have a deliverable value.
 */
export async function evaluateForApplication(
  db: RuntimeDb,
  application: EnvironmentSetupApplicationRow,
): Promise<EnvironmentSetupEvaluation> {
  const manifest = normalizeDeploymentManifest(
    { metadata: application.detectedMetadata ?? {} },
    applicationToManifestOverrides(application),
  );
  const settings = readEnvironmentSettings(application);
  const vendorValueKeys = new Set(await listProvidedConfigKeys(db, application.id, null));
  return evaluateEnvironmentSetup({
    variables: manifest.environment.variables,
    settings,
    vendorValueKeys,
  });
}
