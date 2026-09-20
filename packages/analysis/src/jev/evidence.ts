/**
 * Jev shadow-mode evidence — the compact, sanitized facts object derived from
 * one deterministic analysis run and sent as the decision model's `state`.
 *
 * Facts only: names, booleans and short reason codes. A secret value and raw
 * repository content never travel with it. Every list is capped and the
 * serialized object is held under `JEV_EVIDENCE_MAX_JSON_CHARS` (Jev's state
 * limit is ≈ 32k tokens): the builder deterministically sheds its largest
 * lists instead of throwing.
 */

import { createHash } from 'node:crypto';

import type { ManifestEnvVariable } from '@deployz/contracts';
import { z } from 'zod';

import type { InfrastructureBinding } from '../bindings.js';
import type { DetectorFinding } from '../detectors.js';
import type { AnalysisAmbiguity, RepositoryEvidence } from '../evidence.js';
import { redactSecrets } from '../redact.js';
import { DATABASE_REJECTION_TOKENS } from '../rejection.js';
import type { RejectionFinding } from '../rejection.js';

// ── Version and size bounds ─────────────────────────────────────────────────

export const JEV_EVIDENCE_SCHEMA_VERSION = 1;

/** Hard cap on the serialized evidence — Jev's state limit is ≈ 32k tokens. */
export const JEV_EVIDENCE_MAX_JSON_CHARS = 30_000;

const MAX_DEPENDENCIES = 50;
const MAX_ENV_VARIABLES = 100;
const MAX_BINDINGS = 40;
const MAX_SOURCE_SIGNALS = 60;
const MAX_AMBIGUITIES = 20;
const MAX_REJECTION_REASONS = 10;
const MAX_SNIPPETS = 3;
const MAX_SNIPPET_CHARS = 200;

// ── Schema ──────────────────────────────────────────────────────────────────

const jevEnvVariableSchema = z
  .object({
    /** The variable NAME — a value never travels with the evidence. */
    name: z.string().min(1),
    required: z.boolean(),
    classification: z.string().optional(),
    purpose: z.string().optional(),
  })
  .strict();

const jevBindingSchema = z
  .object({
    resource: z.string(),
    semantic: z.string(),
    applicationVariable: z.string(),
    confidence: z.string(),
  })
  .strict();

const jevSourceSignalSchema = z
  .object({
    sourcePath: z.string(),
    type: z.string(),
    confidence: z.string().optional(),
  })
  .strict();

const jevSnippetSchema = z
  .object({
    sourcePath: z.string(),
    excerpt: z.string(),
  })
  .strict();

export const jevEvidenceSchema = z
  .object({
    evidenceSchemaVersion: z.literal(JEV_EVIDENCE_SCHEMA_VERSION),
    runtimes: z.array(z.string()),
    framework: z.string().optional(),
    packageManager: z.string().optional(),
    dependencies: z.array(z.string()).max(MAX_DEPENDENCIES),
    envVariables: z.array(jevEnvVariableSchema).max(MAX_ENV_VARIABLES),
    docker: z
      .object({
        present: z.boolean(),
        exposedPorts: z.array(z.number().int().min(1).max(65535)),
        healthEndpoint: z.string().optional(),
        startupCommand: z.string().optional(),
        buildCommand: z.string().optional(),
        bindAddress: z.string().optional(),
      })
      .strict(),
    database: z
      .object({
        postgresDetected: z.boolean(),
        enginesSeen: z.array(z.string()),
      })
      .strict(),
    cache: z
      .object({
        redisDetected: z.boolean(),
      })
      .strict(),
    storage: z
      .object({
        s3Detected: z.boolean(),
        localFilesystemDetected: z.boolean(),
      })
      .strict(),
    workers: z
      .object({
        workerDetected: z.boolean(),
      })
      .strict(),
    bindings: z.array(jevBindingSchema).max(MAX_BINDINGS),
    sourceSignals: z.array(jevSourceSignalSchema).max(MAX_SOURCE_SIGNALS),
    ambiguities: z.array(z.string()).max(MAX_AMBIGUITIES),
    manifestRequirements: z
      .object({
        postgres: z.boolean(),
        redisRequired: z.boolean(),
        storageRequired: z.boolean(),
      })
      .strict(),
    rejectionReasons: z.array(z.string()).max(MAX_REJECTION_REASONS),
    snippets: z.array(jevSnippetSchema).max(MAX_SNIPPETS).default([]),
  })
  .strict();

export type JevEvidence = z.infer<typeof jevEvidenceSchema>;

// ── Input ───────────────────────────────────────────────────────────────────

/**
 * The shapes available at the analysis hook point. Everything is read-model
 * output the pipeline already produced; `buildJevEvidence` never re-scans a
 * tree and never guesses a missing signal.
 */
export interface JevEvidenceInput {
  /** Every §18 detector finding from the analysis run. */
  findings: readonly DetectorFinding[];
  /** The normalized repository evidence read-model. */
  evidence: RepositoryEvidence;
  /** The ambiguities the deterministic pipeline left unresolved. */
  ambiguities: readonly AnalysisAmbiguity[];
  /** Dependency names declared anywhere in the repository (`collectDependencyNames`). */
  dependencies: readonly string[];
  /** The §11.2 env-var model — names and classifications only, never values. */
  envVariables: readonly ManifestEnvVariable[];
  /** The manifest's infrastructure requirement booleans. */
  requirements: { postgres: boolean; redisRequired: boolean; storageRequired: boolean };
  /** The provisioned-value injection bindings. */
  bindings: readonly InfrastructureBinding[];
  /** The §10 rejection check results. */
  rejections: readonly RejectionFinding[];
  /** Optional pre-selected excerpts; sanitized before they enter the evidence. */
  snippets?: readonly { sourcePath: string; excerpt: string }[];
}

// ── Snippet sanitization ────────────────────────────────────────────────────

/** A credential keyword followed by its value (`Bearer x`, `password: y`). */
const KEYWORD_VALUE_REGEX =
  /(\b(?:token|password|passwd|secret|bearer|api[_-]?key)\b)(\s*[:=]\s*|\s+)("\S+"|'[^']*'|[^\s,;]+)/gi;
/** A base64/hex run long enough to be an encoded secret (≥ 20 chars). Runs before the assignment rule — a run's `=` padding would otherwise read as a KEY=value separator. */
const OPAQUE_RUN_REGEX = /\b[A-Za-z0-9+/]{20,}={0,2}/g;
/** Any KEY=value assignment — a value never travels with a snippet. */
const ASSIGNMENT_REGEX = /\b([A-Za-z_][A-Za-z0-9_-]*)\s*=\s*("[^"]*"|'[^']*'|[^\s,;]+)/g;

const ELLIPSIS = '...';

/**
 * Redact secret-looking content — assignments, keyword-named credentials,
 * credentialed URIs and long base64/hex runs, on top of the shared
 * `redactSecrets` shapes — then collapse whitespace and cap at `maxLength`
 * with a trailing ellipsis. Redaction runs before the cap so a cut can never
 * expose a fragment of a secret.
 */
export function redactText(text: string, maxLength: number): string {
  let result = redactSecrets(text);
  result = result.replace(KEYWORD_VALUE_REGEX, '$1$2[REDACTED]');
  result = result.replace(OPAQUE_RUN_REGEX, '[REDACTED]');
  result = result.replace(ASSIGNMENT_REGEX, '$1=[REDACTED]');
  const collapsed = result.replace(/\s+/g, ' ').trim();
  return collapsed.length > maxLength
    ? collapsed.slice(0, maxLength - ELLIPSIS.length) + ELLIPSIS
    : collapsed;
}

/** A snippet excerpt, sanitized by the shared redaction core at the snippet budget. */
export function sanitizeSnippet(text: string): string {
  return redactText(text, MAX_SNIPPET_CHARS);
}

// ── Mapping ─────────────────────────────────────────────────────────────────

/** `CMD: node server.js` → `node server.js`; the label is not the command. */
const COMMAND_LABEL_REGEX = /^(?:CMD|ENTRYPOINT|start):\s*/;

function detectorFinding(findings: readonly DetectorFinding[], detector: string): DetectorFinding | undefined {
  return findings.find((finding) => finding.detector === detector);
}

/** The finding's detected single string value, or null when undetected. */
function detectedString(finding: DetectorFinding | undefined): string | null {
  return finding?.detected === true && typeof finding.value === 'string' && finding.value.length > 0
    ? finding.value
    : null;
}

/** The first string of the finding's value, or null when it has none. */
function firstStringValue(finding: DetectorFinding | undefined): string | null {
  const value = finding?.value;
  if (typeof value === 'string' && value.length > 0) return value;
  if (Array.isArray(value) && typeof value[0] === 'string' && value[0].length > 0) return value[0];
  return null;
}

/** Canonical engine names for the §10 unsupported-database dependency tokens. */
const DATABASE_ENGINE_BY_DEPENDENCY: Record<string, string> = {
  mysql2: 'mysql',
  mongoose: 'mongodb',
  'mongodb-client': 'mongodb',
  '@elastic/elasticsearch': 'elasticsearch',
  '@opensearch-project/opensearch': 'opensearch',
  'cassandra-driver': 'cassandra',
  'neo4j-driver': 'neo4j',
};

/** Engine names for the detected unsupported-database rejections (§10 tokens only). */
function databaseEngines(rejections: readonly RejectionFinding[]): string[] {
  const engines = new Set<string>();
  for (const rejection of rejections) {
    if (!rejection.detected || !DATABASE_REJECTION_TOKENS.has(rejection.dependency)) continue;
    engines.add(DATABASE_ENGINE_BY_DEPENDENCY[rejection.dependency] ?? rejection.dependency);
  }
  return [...engines];
}

// ── Builder ─────────────────────────────────────────────────────────────────

/**
 * Build the canonical facts object. Pure and deterministic; an absent signal
 * stays absent. Lists are capped at their schema maxima and the result is
 * held under `JEV_EVIDENCE_MAX_JSON_CHARS` — never by throwing.
 */
export function buildJevEvidence(input: JevEvidenceInput): JevEvidence {
  const finding = (detector: string) => detectorFinding(input.findings, detector);
  const runtime = detectedString(finding('runtime'));
  const framework = detectedString(finding('framework'));
  const packageManager = detectedString(finding('package-manager'));
  const port = finding('port');
  const portNumber =
    port?.detected === true && typeof port.value === 'string' && /^\d+$/.test(port.value)
      ? Number(port.value)
      : null;
  const health = finding('health-endpoint');
  const startupCommand = firstStringValue(finding('startup-command'));
  const buildCommand = firstStringValue(finding('build-command'));
  const bindAddress = finding('bind-address')?.value;

  const draft = {
    evidenceSchemaVersion: JEV_EVIDENCE_SCHEMA_VERSION,
    runtimes: runtime !== null ? [runtime] : [],
    ...(framework !== null ? { framework } : {}),
    ...(packageManager !== null ? { packageManager } : {}),
    dependencies: input.dependencies.slice(0, MAX_DEPENDENCIES),
    envVariables: input.envVariables.slice(0, MAX_ENV_VARIABLES).map((entry) => ({
      name: entry.key,
      required: entry.required,
      ...(entry.classification !== undefined ? { classification: entry.classification } : {}),
      ...(entry.purpose !== undefined ? { purpose: entry.purpose } : {}),
    })),
    docker: {
      present: finding('dockerfile')?.detected === true,
      exposedPorts: portNumber !== null && portNumber > 0 && portNumber <= 65535 ? [portNumber] : [],
      ...(health?.detected === true && health.path !== undefined ? { healthEndpoint: health.path } : {}),
      ...(startupCommand !== null ? { startupCommand: startupCommand.replace(COMMAND_LABEL_REGEX, '') } : {}),
      ...(buildCommand !== null ? { buildCommand } : {}),
      ...(typeof bindAddress === 'string' ? { bindAddress } : {}),
    },
    database: {
      postgresDetected: finding('postgresql')?.detected === true,
      enginesSeen: databaseEngines(input.rejections),
    },
    cache: { redisDetected: finding('redis')?.detected === true },
    storage: {
      s3Detected: finding('s3')?.detected === true,
      localFilesystemDetected: finding('local-filesystem')?.detected === true,
    },
    workers: { workerDetected: finding('worker')?.detected === true },
    bindings: input.bindings.slice(0, MAX_BINDINGS).map((binding) => ({
      resource: binding.resource,
      semantic: binding.semantic,
      applicationVariable: binding.applicationVariable,
      confidence: binding.confidence,
    })),
    sourceSignals: [
      ...input.evidence.environment,
      ...input.evidence.database,
      ...input.evidence.redis,
      ...input.evidence.storage,
    ]
      .slice(0, MAX_SOURCE_SIGNALS)
      .map((item) => ({ sourcePath: item.sourcePath, type: item.type, confidence: item.confidence })),
    ambiguities: [...new Set(input.ambiguities.map((ambiguity) => ambiguity.kind))].slice(0, MAX_AMBIGUITIES),
    manifestRequirements: {
      postgres: input.requirements.postgres,
      redisRequired: input.requirements.redisRequired,
      storageRequired: input.requirements.storageRequired,
    },
    rejectionReasons: input.rejections
      .filter((rejection) => rejection.detected)
      .map((rejection) => rejection.dependency)
      .slice(0, MAX_REJECTION_REASONS),
    snippets: (input.snippets ?? []).slice(0, MAX_SNIPPETS).map((snippet) => ({
      sourcePath: snippet.sourcePath,
      excerpt: sanitizeSnippet(snippet.excerpt),
    })),
  };
  return withinJsonCharCap(jevEvidenceSchema.parse(draft));
}

/**
 * Keep the serialized evidence under `JEV_EVIDENCE_MAX_JSON_CHARS` by
 * emptying the largest capped lists in a fixed order — sourceSignals, then
 * dependencies, then envVariables, then snippets. An object still over the
 * cap after every drop (only possible through an uncapped scalar) is
 * returned as-is; the builder never throws.
 */
function withinJsonCharCap(evidence: JevEvidence): JevEvidence {
  if (JSON.stringify(evidence).length <= JEV_EVIDENCE_MAX_JSON_CHARS) return evidence;
  const withoutSourceSignals = { ...evidence, sourceSignals: [] };
  if (JSON.stringify(withoutSourceSignals).length <= JEV_EVIDENCE_MAX_JSON_CHARS) return withoutSourceSignals;
  const withoutDependencies = { ...withoutSourceSignals, dependencies: [] };
  if (JSON.stringify(withoutDependencies).length <= JEV_EVIDENCE_MAX_JSON_CHARS) return withoutDependencies;
  const withoutEnvVariables = { ...withoutDependencies, envVariables: [] };
  if (JSON.stringify(withoutEnvVariables).length <= JEV_EVIDENCE_MAX_JSON_CHARS) return withoutEnvVariables;
  return { ...withoutEnvVariables, snippets: [] };
}

// ── Fingerprint ─────────────────────────────────────────────────────────────

/**
 * Canonicalize for hashing: object keys sorted recursively, plain string
 * arrays sorted — equal evidence yields an equal fingerprint whatever order
 * the inputs arrived in. `evidenceSchemaVersion` is part of the object, so a
 * schema bump changes every fingerprint.
 */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    const items = value.map(canonicalize);
    return items.every((item) => typeof item === 'string') ? [...(items as string[])].sort() : items;
  }
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(record).sort().map((key) => [key, canonicalize(record[key])]));
  }
  return value;
}

/** The sha256 hex of the evidence's canonical JSON — equal evidence, equal fingerprint. */
export function fingerprintJevEvidence(evidence: JevEvidence): string {
  return createHash('sha256').update(JSON.stringify(canonicalize(evidence))).digest('hex');
}
