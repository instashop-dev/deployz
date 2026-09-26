import {
  deploymentManifestOverridesSchema,
  deploymentManifestSchema,
  deploymentSpecV2Schema,
  requirementsFromSpec,
  type DeploymentManifest,
  type DeploymentManifestOverrides,
  type DeploymentSpecV2,
} from '@deployz/contracts';

import type { DerivationApplication } from './deployment-status.js';

/**
 * Phase 2/3 boundary — API-side manifest plumbing.
 *
 * `applicationToManifestOverrides` translates an applications row into the
 * vendor-override inputs `normalizeDeploymentManifest` (packages/analysis)
 * consumes: column-backed inputs (port, health/migration/worker commands, the
 * boolean requirements) plus the five manifest-only paths the vendor corrected
 * via PATCH /api/applications/:id, which live on
 * `detected_metadata.manifestOverrides`.
 */

/** The shape of an applications row the overrides builder needs. */
export interface ManifestApplicationRow {
  containerPort: number | null;
  healthPath: string | null;
  migrationCommand: string | null;
  workerCommand: string | null;
  databaseRequired: boolean;
  storageRequired: boolean;
  redisRequired: boolean;
  detectedMetadata: Record<string, unknown> | null;
}

function takeString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Build the vendor overrides for an application row. Column-backed fields win
 * over manifestOverrides (they are the canonical vendor-owned store for port /
 * health path / migration / worker / boolean requirements); manifest-only paths
 * read from the stored overrides record.
 */
export function applicationToManifestOverrides(row: ManifestApplicationRow): DeploymentManifestOverrides {
  const stored = (row.detectedMetadata?.['manifestOverrides'] ?? {}) as Record<string, unknown>;
  return deploymentManifestOverridesSchema.parse({
    appRoot: takeString(stored['appRoot']),
    dockerfilePath: takeString(stored['dockerfilePath']),
    buildContext: takeString(stored['buildContext']),
    buildCommand: takeString(stored['buildCommand']),
    startCommand: takeString(stored['startCommand']),
    port: row.containerPort,
    healthPath: row.healthPath,
    migrationCommand: row.migrationCommand,
    workerCommand: row.workerCommand,
    databaseRequired: row.databaseRequired,
    storageRequired: row.storageRequired,
    redisRequired: row.redisRequired,
  });
}

/**
 * Read the manifest persisted on a deployment's desired state — the historical
 * manifest the deployment was created with, which rollback/deploy use instead
 * of re-deriving from the application's (possibly changed) config.
 */
export function readStoredManifest(desiredState: Record<string, unknown> | null): DeploymentManifest | null {
  const parsed = deploymentManifestSchema.safeParse(desiredState?.['manifest']);
  return parsed.success ? parsed.data : null;
}

/**
 * Read the spec persisted on a deployment's spec_v2 column — the frozen
 * DeploymentSpecV2 the deployment was created with. Null when the column is
 * empty or invalid (a pre-compiler row).
 */
export function readStoredDeploymentSpec(specV2: Record<string, unknown> | null): DeploymentSpecV2 | null {
  const parsed = deploymentSpecV2Schema.safeParse(specV2);
  return parsed.success ? parsed.data : null;
}

/**
 * The one place a deployment's `DerivationApplication` (deployment-status.ts)
 * is built — the requirement booleans from the deployment's frozen spec's
 * verification contract, never the live `applications` columns. They come
 * out `null` ("not known", never a guessed `false`) when the stored spec is
 * missing, invalid, or uncompiled; `storageRequired` stays manifest-derived
 * (the application's own requirement, not the template's unconditional S3
 * resource); `migrationCommand` stays the live column, since a vendor fixing
 * a broken migration command must take effect on the next deploy without
 * re-installing. The display layer (deployment-status.ts) treats a null
 * boolean as "not required" — that is a rendering fallback only, never a
 * provisioning decision.
 */
export function derivationApplicationFor(
  deployment: { desiredState: Record<string, unknown> | null; specV2: Record<string, unknown> | null },
  application: { migrationCommand?: string | null } | null | undefined,
): DerivationApplication {
  const manifest = readStoredManifest(deployment.desiredState);
  const spec = readStoredDeploymentSpec(deployment.specV2);
  const requirements = spec ? requirementsFromSpec(spec) : null;
  return {
    databaseRequired: requirements ? requirements.databaseRequired : null,
    storageRequired: manifest ? manifest.storage.required : null,
    redisRequired: requirements ? requirements.redisRequired : null,
    migrationCommand: application?.migrationCommand ?? null,
  };
}
