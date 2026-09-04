/**
 * The canonical application analysis — the typed projection of what Deployz
 * understands about an application, built once per analysis from the same
 * detector findings and merged metadata that feed the flat
 * `detected_metadata` keys and the deployment manifest.
 *
 * Every fact carries its normalized value, where the value came from, how
 * sure the analyser is, and concise evidence. Deterministic evidence always
 * wins: an AI-resolved value is reported as `source: 'ai'` with `likely`
 * confidence and never displaces a detector value (see `mergeAiAnalysis`).
 */

import {
  applicationAnalysisSchema,
  manifestEnvVariableSchema,
  runtimeFamilySchema,
  type AnalysisEvidence,
  type ApplicationAnalysis,
  type FactConfidence,
  type FactSource,
} from '@deployz/contracts';
import { z } from 'zod';

import type { AnalysisResult } from './analyser.js';
import type { DetectorFinding, DetectorSource } from './detectors.js';

export interface ApplicationAnalysisContext {
  /** The analyser logic version the metadata was produced by. */
  analysisVersion: number;
  /** Metadata keys the AI fallback filled (`AiMergeOutcome.aiResolved`). */
  aiResolved: string[];
  /** The deploy-safe migration command the API resolved, when any. */
  resolvedMigrationCommand: string | null;
}

type Fact<T> = { value: T; source: FactSource; confidence: FactConfidence; evidence: AnalysisEvidence[] };

const NO_EVIDENCE: AnalysisEvidence[] = [];

function evidenceFrom(details: string | undefined, file?: string): AnalysisEvidence[] {
  if (!details) return NO_EVIDENCE;
  return [file ? { file, reason: details } : { reason: details }];
}

function unknownFact<T>(value: T): Fact<T> {
  return { value, source: 'none', confidence: 'needs_confirmation', evidence: NO_EVIDENCE };
}

/** Explicit configuration is confirmed; a value inferred from source code is only likely. */
function confidenceForSource(source: DetectorSource | 'ai'): FactConfidence {
  return source === 'source' || source === 'ai' ? 'likely' : 'confirmed';
}

function firstString(value: unknown): string | null {
  if (typeof value === 'string' && value.length > 0) return value;
  if (Array.isArray(value) && typeof value[0] === 'string' && value[0].length > 0) return value[0];
  return null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** `CMD: node server.js` → `node server.js`; the label is evidence, not the command. */
function stripCommandLabel(command: string): string {
  return command.replace(/^(?:CMD|ENTRYPOINT|start):\s*/, '');
}

function commandFact(
  finding: DetectorFinding | undefined,
  metadataKey: string,
  metadata: Record<string, unknown>,
  aiResolved: string[],
): Fact<string | null> {
  const value = firstString(metadata[metadataKey]);
  if (value === null) return unknownFact(null);
  if (aiResolved.includes(metadataKey)) {
    return { value, source: 'ai', confidence: 'likely', evidence: [{ reason: 'Resolved by AI analysis' }] };
  }
  const source = finding?.source ?? 'package-manifest';
  return {
    value: stripCommandLabel(value),
    source,
    confidence: confidenceForSource(source),
    evidence: evidenceFrom(finding?.details, source === 'dockerfile' ? firstString(metadata['dockerfilePath']) ?? undefined : undefined),
  };
}

function portFact(
  finding: DetectorFinding | undefined,
  metadata: Record<string, unknown>,
  aiResolved: string[],
): Fact<number | null> {
  const raw = typeof metadata['port'] === 'string' ? Number.parseInt(metadata['port'], 10) : Number.NaN;
  if (!Number.isFinite(raw) || raw <= 0) return unknownFact(null);
  if (aiResolved.includes('port')) {
    return { value: raw, source: 'ai', confidence: 'likely', evidence: [{ reason: 'Resolved by AI analysis' }] };
  }
  const source = finding?.source ?? 'source';
  return { value: raw, source, confidence: confidenceForSource(source), evidence: evidenceFrom(finding?.details) };
}

function redisConfidence(value: unknown): FactConfidence {
  if (value === 'high') return 'confirmed';
  if (value === 'medium') return 'likely';
  return 'needs_confirmation';
}

/**
 * Build the canonical analysis from one analysis run. Pure: the same
 * findings, metadata and context always produce the same projection. The
 * result is validated against the contract schema so a stored projection is
 * always safe to read back.
 */
export function buildApplicationAnalysis(
  analysis: Pick<AnalysisResult, 'findings' | 'metadata'>,
  context: ApplicationAnalysisContext,
): ApplicationAnalysis {
  const { metadata } = analysis;
  const finding = (name: string) => analysis.findings.find((f) => f.detector === name);
  const dockerfilePath = firstString(metadata['dockerfilePath']) ?? undefined;

  const runtimeFinding = finding('runtime');
  const runtimeValue = runtimeFamilySchema.safeParse(runtimeFinding?.value);
  const runtime: Fact<ApplicationAnalysis['runtime']['value']> =
    runtimeFinding?.detected && runtimeValue.success
      ? {
          value: runtimeValue.data,
          source: runtimeFinding.source ?? 'package-manifest',
          confidence: runtimeFinding.source === 'dockerfile' ? 'confirmed' : 'likely',
          evidence: evidenceFrom(runtimeFinding.details, runtimeFinding.source === 'dockerfile' ? dockerfilePath : undefined),
        }
      : unknownFact('unknown' as const);

  const frameworkFinding = finding('framework');
  const framework: Fact<string | null> = frameworkFinding?.detected
    ? {
        value: firstString(frameworkFinding.value),
        source: 'package-manifest',
        confidence: 'confirmed',
        evidence: evidenceFrom(frameworkFinding.details),
      }
    : unknownFact(null);

  const bindFinding = finding('bind-address');
  const bindAddress: Fact<'all-interfaces' | 'localhost' | null> = bindFinding?.detected
    ? { value: 'localhost', source: 'source', confidence: 'likely', evidence: evidenceFrom(bindFinding.details) }
    : bindFinding?.value === 'all-interfaces'
      ? { value: 'all-interfaces', source: 'source', confidence: 'confirmed', evidence: evidenceFrom(bindFinding.details) }
      : unknownFact(null);

  const postgres = asRecord(metadata['postgres']);
  const postgresRequired = postgres['required'] === true;
  const databaseState = metadata['databaseState'];
  const databaseType = databaseState === 'postgres' || databaseState === 'unsupported' ? databaseState : 'none';
  const databaseEvidence = [
    ...stringArray(postgres['evidence']).map((reason) => ({ reason })),
    ...(databaseType === 'unsupported' ? evidenceFrom(finding('postgresql')?.details) : NO_EVIDENCE),
  ];

  const redis = asRecord(metadata['redis']);
  const redisCompatibility = asRecord(redis['compatibility']);

  const localFs = finding('local-filesystem');
  const s3 = finding('s3');

  const health = finding('health-endpoint');
  const healthSource = health?.source ?? 'package-manifest';

  const migrationLabels = stringArray(metadata['migrationCommands']);
  const migrationFinding = finding('migration-command');
  const migrationResolvedByAi = context.aiResolved.includes('migrationCommands');
  const migrationCommand = context.resolvedMigrationCommand ?? (migrationResolvedByAi ? migrationLabels[0] ?? null : null);

  const envVarModel = z.array(manifestEnvVariableSchema).safeParse(metadata['envVarModel']);

  return applicationAnalysisSchema.parse({
    analysisVersion: context.analysisVersion,
    runtime,
    framework,
    build: commandFact(finding('build-command'), 'buildCommands', metadata, context.aiResolved),
    start: commandFact(finding('startup-command'), 'startupCommands', metadata, context.aiResolved),
    network: {
      port: portFact(finding('port'), metadata, context.aiResolved),
      bindAddress,
    },
    database: {
      required: postgresRequired,
      type: databaseType,
      confidence: context.aiResolved.includes('postgres.required')
        ? 'likely'
        : databaseType === 'postgres' && !postgresRequired
          ? 'likely'
          : 'confirmed',
      evidence: databaseEvidence,
    },
    redis: {
      required: redis['required'] === true,
      detected: metadata['usesRedis'] === true,
      supported: redisCompatibility['supported'] !== false,
      confidence: context.aiResolved.includes('redis.required') ? 'likely' : redisConfidence(redis['confidence']),
      purposes: stringArray(redis['purposes']),
      evidence: [
        ...stringArray(redis['evidence']).map((reason) => ({ reason })),
        ...(typeof redisCompatibility['reason'] === 'string' ? [{ reason: redisCompatibility['reason'] }] : []),
      ],
    },
    storage: {
      persistentLocalRequired: localFs?.detected === true,
      objectStorageDetected: s3?.detected === true,
      evidence: [...evidenceFrom(localFs?.detected ? localFs.details : undefined), ...evidenceFrom(s3?.detected ? s3.details : undefined)],
    },
    healthCheck: {
      detected: health?.detected === true,
      path: health?.detected ? health.path ?? null : null,
      confidence: health?.detected ? (healthSource === 'package-manifest' ? 'likely' : 'confirmed') : 'confirmed',
      evidence: evidenceFrom(health?.detected ? health.details : undefined),
    },
    migrations: {
      detected: metadata['hasMigrationCommand'] === true || migrationCommand !== null,
      command: migrationCommand,
      tools: migrationResolvedByAi ? [] : migrationLabels,
      evidence: migrationResolvedByAi
        ? [{ reason: 'Resolved by AI analysis' }]
        : evidenceFrom(migrationFinding?.detected ? migrationFinding.details : undefined),
    },
    environmentVariables: envVarModel.success ? envVarModel.data : [],
  });
}

/**
 * Read a stored projection back. A row analysed before the projection
 * existed, or one whose stored shape no longer matches the contract, reads
 * as null — never as a partially trusted object.
 */
export function readApplicationAnalysis(metadata: Record<string, unknown> | null): ApplicationAnalysis | null {
  const parsed = applicationAnalysisSchema.safeParse(metadata?.['application']);
  return parsed.success ? parsed.data : null;
}
