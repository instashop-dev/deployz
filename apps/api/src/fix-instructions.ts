import { createHash } from 'node:crypto';

import {
  reconcileReadiness,
  type FixInstructionsContext,
  type ReadinessFinding,
  type ReadinessReport,
  type ReadinessResolution,
} from '@deployz/analysis';

// Fix-instructions context assembly — turns a persisted application row (the
// merged analysis metadata plus the §35 contract fields, vendor overrides
// included) into the structured context the generator consumes. Structured
// facts only: no repository file contents ever reach the model.

/** The application-row slice the context builder reads. */
export interface FixInstructionsSource {
  repoFullName: string;
  containerPort: number | null;
  healthPath: string | null;
  migrationCommand: string | null;
  redisRequired: boolean;
  detectedMetadata: Record<string, unknown> | null;
}

/** The stored readiness report, when this row has one. */
export function readReadinessReport(
  metadata: Record<string, unknown> | null,
): ReadinessReport | null {
  const raw = metadata?.['readiness'] as ReadinessReport | undefined;
  if (!raw || !Array.isArray(raw.findings) || !Array.isArray(raw.passed)) return null;
  return raw;
}

/**
 * The vendor configuration that can resolve a finding without a repository
 * change: the container port column and the manifest-only start command.
 */
export function readinessResolution(application: {
  containerPort: number | null;
  detectedMetadata: Record<string, unknown> | null;
}): ReadinessResolution {
  const overrides = application.detectedMetadata?.['manifestOverrides'] as Record<string, unknown> | undefined;
  const startCommand = overrides?.['startCommand'];
  return {
    containerPort: application.containerPort,
    startCommand: typeof startCommand === 'string' && startCommand.length > 0 ? startCommand : null,
  };
}

/** The stored report with the vendor's configuration applied — what the page, the verdict and the fix instructions all read. */
export function effectiveReadinessReport(application: {
  containerPort: number | null;
  detectedMetadata: Record<string, unknown> | null;
}): ReadinessReport | null {
  const report = readReadinessReport(application.detectedMetadata);
  return report ? reconcileReadiness(report, readinessResolution(application)) : null;
}

function firstString(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  return null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** A cached fix-instructions document, stored on `detected_metadata.fixInstructions`. */
export interface CachedFixInstructions {
  /** `fixInstructionsCacheKey` of the context the document was generated for. */
  key: string;
  instructions: string;
  generatedAt: string;
}

/**
 * The cache key for one generation: the analysed commit, the analysis
 * version, every fact, and every finding's id, evidence and confidence. Any
 * change in what the document would be built from changes the key, so a
 * cached document is only ever reused for the same repository state and the
 * same findings.
 */
export function fixInstructionsCacheKey(context: FixInstructionsContext, analysisVersion: unknown): string {
  const material = JSON.stringify({
    commitSha: context.commitSha,
    analysisVersion: typeof analysisVersion === 'number' ? analysisVersion : null,
    facts: context.facts,
    findings: context.findings.map((f) => [f.id, f.technicalEvidence, f.suggestedOutcome, f.confidence]),
  });
  return createHash('sha256').update(material).digest('hex');
}

/** The stored document when it was generated for exactly this key, else null. */
export function readCachedFixInstructions(
  metadata: Record<string, unknown> | null,
  key: string,
): CachedFixInstructions | null {
  const raw = metadata?.['fixInstructions'] as Partial<CachedFixInstructions> | undefined;
  if (
    raw?.key !== key ||
    typeof raw.instructions !== 'string' ||
    raw.instructions.length === 0 ||
    typeof raw.generatedAt !== 'string'
  ) {
    return null;
  }
  return { key, instructions: raw.instructions, generatedAt: raw.generatedAt };
}

/**
 * Build the generation context from an application row, or null when there is
 * nothing to generate for (no stored report, or no unresolved findings).
 * Contract fields the vendor edited (row columns) win over detected metadata.
 */
export function buildFixInstructionsContext(
  application: FixInstructionsSource,
): FixInstructionsContext | null {
  const metadata = application.detectedMetadata;
  const report = effectiveReadinessReport(application);
  if (!report || report.findings.length === 0) return null;

  const redis = metadata?.['redis'] as { required?: unknown } | undefined;

  return {
    repoFullName: application.repoFullName,
    commitSha: asString(metadata?.['analysisCommitSha']),
    facts: {
      runtime: asString(metadata?.['runtime']),
      framework: asString(metadata?.['framework']),
      packageManager: asString(metadata?.['packageManager']),
      buildCommand: firstString(metadata?.['buildCommands']),
      startCommand: firstString(metadata?.['startupCommands']),
      port:
        application.containerPort !== null
          ? String(application.containerPort)
          : asString(metadata?.['port']),
      dockerfilePath: asString(metadata?.['dockerfilePath']),
      database: metadata?.['usesPostgresql'] === true ? 'postgres' : 'none',
      migrationCommand: application.migrationCommand,
      healthPath: application.healthPath,
      redisRequired: application.redisRequired || redis?.required === true,
      workingDirectory: asString(metadata?.['workingDirectory']),
    },
    findings: report.findings as ReadinessFinding[],
  };
}
