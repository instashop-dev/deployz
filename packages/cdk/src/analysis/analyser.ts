/**
 * Repository analyser orchestrator — runs all §18 detectors and §10 rejection
 * checks against a file tree and produces a structured analysis result.
 *
 * This is a PURELY DETERMINISTIC analyser (§20): rule-based, no ML, no AI.
 * The output maps to the `detectedMetadata` JSONB column on the Application row.
 */

import type { FileTree } from './detectors.js';
import type { DetectorFinding } from './detectors.js';
import {
  detectDockerfile,
  detectFramework,
  detectPort,
  detectHealthEndpoint,
  detectEnvVars,
  detectPostgresql,
  detectLocalFilesystem,
  detectWorker,
  detectS3,
  detectMigrationCommand,
} from './detectors.js';

import type { RejectionFinding } from './rejection.js';
import {
  checkRedis,
  checkMysql,
  checkMongo,
  checkElasticsearch,
  checkOtherUnsupportedDatabases,
} from './rejection.js';

// ── Types ───────────────────────────────────────────────────────────────────

/** Complete result from a repository analysis. */
export interface AnalysisResult {
  /** All §18 detector findings. */
  findings: DetectorFinding[];
  /** All §10 rejection check results. */
  rejections: RejectionFinding[];
  /** Flattened metadata suitable for the `detectedMetadata` JSONB column. */
  metadata: Record<string, unknown>;
}

// ── Orchestrator ────────────────────────────────────────────────────────────

/** All §18 detector functions, in order. */
const DETECTORS = [
  detectDockerfile,
  detectFramework,
  detectPort,
  detectHealthEndpoint,
  detectEnvVars,
  detectPostgresql,
  detectLocalFilesystem,
  detectWorker,
  detectS3,
  detectMigrationCommand,
] as const;

/** All §10 rejection check functions, in order. */
const REJECTION_CHECKS = [
  checkRedis,
  checkMysql,
  checkMongo,
  checkElasticsearch,
  checkOtherUnsupportedDatabases,
] as const;

/**
 * Build a flat metadata record from findings.
 * Maps detector names to their detected values for easy JSONB storage and querying.
 */
function buildMetadata(findings: DetectorFinding[]): Record<string, unknown> {
  const meta: Record<string, unknown> = {};

  for (const f of findings) {
    const key = f.detector.replace(/-/g, '');

    // Map common detectors to friendly metadata keys
    switch (f.detector) {
      case 'dockerfile':
        meta['hasDockerfile'] = f.detected;
        if (f.detected && f.value) meta['dockerfilePath'] = f.value;
        break;
      case 'framework':
        meta['framework'] = f.detected ? f.value : null;
        break;
      case 'port':
        meta['port'] = f.detected ? f.value : null;
        break;
      case 'health-endpoint':
        meta['hasHealthEndpoint'] = f.detected;
        if (f.detected && f.value) meta['healthEndpointSources'] = f.value;
        break;
      case 'env-vars':
        meta['hasEnvVars'] = f.detected;
        if (f.detected && f.value) meta['envVars'] = f.value;
        break;
      case 'postgresql':
        meta['usesPostgresql'] = f.detected;
        if (f.detected && f.value) meta['postgresqlDrivers'] = f.value;
        break;
      case 'local-filesystem':
        meta['usesLocalFilesystem'] = f.detected;
        if (f.detected && f.value) meta['localFilesystemOps'] = f.value;
        break;
      case 'worker':
        meta['hasWorkerProcesses'] = f.detected;
        if (f.detected && f.value) meta['workerPatterns'] = f.value;
        break;
      case 's3':
        meta['usesS3'] = f.detected;
        if (f.detected && f.value) meta['s3Indicators'] = f.value;
        break;
      case 'migration-command':
        meta['hasMigrationCommand'] = f.detected;
        if (f.detected && f.value) meta['migrationCommands'] = f.value;
        break;
      default:
        meta[key] = f.detected ? f.value ?? true : false;
    }
  }

  return meta;
}

/**
 * Run the full deterministic analysis: all §18 detectors + all §10 rejection checks.
 *
 * Returns an `AnalysisResult` whose `metadata` field maps to the
 * `applications.detected_metadata` JSONB column.
 *
 * This function is PURE: same input → same output every time. No randomness, no
 * AI, no external calls. The §19 verdict engine (todo 23) consumes this output.
 */
export function analyseRepo(tree: FileTree): AnalysisResult {
  const findings: DetectorFinding[] = [];
  const rejections: RejectionFinding[] = [];

  for (const detector of DETECTORS) {
    findings.push(detector(tree));
  }

  for (const check of REJECTION_CHECKS) {
    rejections.push(check(tree));
  }

  const metadata = buildMetadata(findings);

  return { findings, rejections, metadata };
}