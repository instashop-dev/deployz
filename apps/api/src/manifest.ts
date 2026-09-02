import {
  deploymentManifestOverridesSchema,
  deploymentManifestSchema,
  type DeploymentManifest,
  type DeploymentManifestOverrides,
  type ManifestReadinessResult,
} from '@deployz/contracts';
import { evaluateManifestReadiness as evaluateManifestReadinessCore } from '@deployz/analysis';

import { ApiError } from './errors.js';

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
 * Re-evaluate the stored manifest and throw a typed 422 if it is not READY.
 * Used at every boundary where a not-yet-provisioned deployment could be
 * advanced (install-link launch, relay registration, INSTALL job creation).
 */
export function requireReadyManifest(
  desiredState: Record<string, unknown> | null,
): { manifest: DeploymentManifest; readiness: ManifestReadinessResult } {
  const manifest = readStoredManifest(desiredState);
  if (!manifest) {
    throw new ApiError(
      422,
      'MANIFEST_NEEDS_CONFIGURATION',
      'Deployment has no valid deployment manifest. Run analysis or correct the application configuration first.',
    );
  }
  const readiness = evaluateManifestReadinessCore(manifest);
  if (readiness.state === 'NOT_COMPATIBLE') {
    throw new ApiError(
      422,
      'MANIFEST_NOT_COMPATIBLE',
      'This application cannot be deployed with Deployz as configured.',
      { findings: readiness.findings },
    );
  }
  if (readiness.state === 'NEEDS_CONFIGURATION') {
    throw new ApiError(
      422,
      'MANIFEST_NEEDS_CONFIGURATION',
      'This application is missing configuration required for deployment. Run analysis or correct it in the application settings first.',
      { findings: readiness.findings },
    );
  }
  return { manifest, readiness };
}