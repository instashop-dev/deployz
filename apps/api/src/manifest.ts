import {
  deploymentManifestOverridesSchema,
  deploymentManifestSchema,
  type DeploymentManifest,
  type DeploymentManifestOverrides,
} from '@deployz/contracts';

/**
 * Phase 2 boundary — API-side manifest plumbing.
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