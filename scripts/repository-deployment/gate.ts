/**
 * B1 — the deployment gate over a pinned snapshot, through the production
 * analysis path the Stage A harness already drives (`openAnalysisSession`:
 * `runApplicationAnalysis` → `normalizeDeploymentManifest` →
 * `evaluateManifestReadiness`), read from the Stage B side: is the
 * repository expected to be deployable, and does the gate agree?
 *
 * B2 offline — the same gate with the Stage B vendor configuration applied
 * (overrides merged the way `applicationToManifestOverrides` merges them,
 * configured and generated keys counted as provided), so a configuration
 * is validated before any AWS resource exists.
 */
import { evaluateManifestReadiness, normalizeDeploymentManifest } from '@deployz/analysis';
import { applicationToManifestOverrides } from '@deployz/api/manifest';
import type { DeploymentManifest, DeploymentManifestOverrides, ManifestReadinessResult } from '@deployz/contracts';

import type { RawAnalysis } from '../repository-compatibility/analyse.js';
import type { BenchmarkEntry } from '../repository-compatibility/manifest.js';
import { normalizeActual } from '../repository-compatibility/normalize.js';
import { providedKeys, type RepositoryConfig, type VendorOverrides } from './config.js';
import type { GateOutcome, StageBResult } from './results.js';

export function gateOutcome(expectedDeployable: boolean, verdict: StageBResult['gate']['verdict']): GateOutcome | null {
  if (verdict === null) return null;
  const accepted = verdict !== 'NOT_COMPATIBLE';
  if (expectedDeployable && accepted) return 'correct-accept';
  if (!expectedDeployable && !accepted) return 'correct-reject';
  if (!expectedDeployable && accepted) return 'false-acceptance';
  return 'false-rejection';
}

/** Stage B vendor overrides in the manifest's override vocabulary (PATCH /api/applications/:id → manifest). */
export function overridesToManifest(overrides: VendorOverrides | undefined): DeploymentManifestOverrides {
  if (!overrides) return {};
  const out: DeploymentManifestOverrides = {};
  if (overrides.containerPort !== undefined) out.port = overrides.containerPort;
  if (overrides.healthPath !== undefined) out.healthPath = overrides.healthPath;
  if (overrides.migrationCommand !== undefined) out.migrationCommand = overrides.migrationCommand;
  if (overrides.databaseRequired !== undefined) out.databaseRequired = overrides.databaseRequired;
  if (overrides.storageRequired !== undefined) out.storageRequired = overrides.storageRequired;
  if (overrides.redisRequired !== undefined) out.redisRequired = overrides.redisRequired;
  if (overrides.appRoot !== undefined) out.appRoot = overrides.appRoot;
  if (overrides.dockerfilePath !== undefined) out.dockerfilePath = overrides.dockerfilePath;
  if (overrides.buildContext !== undefined) out.buildContext = overrides.buildContext;
  if (overrides.buildCommand !== undefined) out.buildCommand = overrides.buildCommand;
  if (overrides.startCommand !== undefined) out.startCommand = overrides.startCommand;
  return out;
}

/** The gate re-evaluated with the Stage B configuration — the B2 offline check. */
export function evaluateConfiguredGate(
  raw: RawAnalysis,
  entry: RepositoryConfig,
): { manifest: DeploymentManifest; gate: ManifestReadinessResult } {
  if (raw.status !== 'analysed') throw new Error('cannot evaluate the gate of a failed analysis');
  const manifest = normalizeDeploymentManifest(
    { metadata: raw.row.detectedMetadata ?? {} },
    { ...applicationToManifestOverrides(raw.row), ...overridesToManifest(entry.overrides) },
  );
  const gate = evaluateManifestReadiness(manifest, { providedEnvKeys: providedKeys(entry) });
  return { manifest, gate };
}

/** Fill the `gate` section of a result from one in-process analysis. */
export function gateSection(
  benchmarkEntry: BenchmarkEntry,
  raw: RawAnalysis,
  entry: RepositoryConfig,
  analysisVersion: number,
): { gate: StageBResult['gate']; manifest: DeploymentManifest | null; configuredManifest: DeploymentManifest | null } {
  const expectedDeployable = benchmarkEntry.expected.compatibility !== 'NOT_COMPATIBLE';
  if (raw.status !== 'analysed' || !raw.gate) {
    return {
      gate: {
        status: 'FAIL',
        verdict: null,
        analysisVerdict: raw.row.compatibilityStatus,
        outcome: null,
        gateFindings: [],
        requiredKeys: [],
        unsupported: [],
        configuredVerdict: null,
        configuredFindings: [],
        source: 'in-process',
        analysisVersion,
        detail: raw.failure ?? 'analysis did not complete',
      },
      manifest: null,
      configuredManifest: null,
    };
  }
  const actual = normalizeActual(raw);
  const configured = evaluateConfiguredGate(raw, entry);
  const verdict = raw.gate.state;
  const outcome = gateOutcome(expectedDeployable, verdict);
  return {
    gate: {
      status: outcome === 'correct-accept' || outcome === 'correct-reject' ? 'PASS' : 'FAIL',
      verdict,
      analysisVerdict: actual.analysisVerdict,
      outcome,
      gateFindings: actual.gateFindings,
      requiredKeys: actual.requiredEnvVars,
      unsupported: actual.unsupported,
      configuredVerdict: configured.gate.state,
      configuredFindings: configured.gate.findings.map((finding) => finding.id),
      source: 'in-process',
      analysisVersion,
      detail: null,
    },
    manifest: raw.manifest,
    configuredManifest: configured.manifest,
  };
}
