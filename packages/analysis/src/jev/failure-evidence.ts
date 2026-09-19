/**
 * Jev failure shadow evidence — the compact, sanitized failure facts the
 * UNKNOWN-failure shadow classification is decided over.
 *
 * Raw signal text (stack reasons, build errors, stop reasons) passes through
 * the shared `redactText` core before it enters the object, so a credential
 * value never travels and the serialized evidence stays small. A signal that
 * is absent or empty on the input is left out entirely.
 */

import { z } from 'zod';

import { redactText } from './evidence.js';

// ── Version and caps ────────────────────────────────────────────────────────

export const JEV_FAILURE_EVIDENCE_SCHEMA_VERSION = 1;

const MAX_EVENTS = 10;
const MAX_REASON_CHARS = 500;
const MAX_EVENT_REASON_CHARS = 200;
const MAX_BUILD_ERROR_CHARS = 300;
const MAX_STOPPED_REASON_CHARS = 300;

// ── Schema ──────────────────────────────────────────────────────────────────

const jevStackEventSchema = z
  .object({
    resourceType: z.string(),
    logicalResourceId: z.string(),
    resourceStatus: z.string(),
    resourceStatusReason: z.string().optional(),
    eventAt: z.string(),
  })
  .strict();

export const jevFailureEvidenceSchema = z
  .object({
    evidenceSchemaVersion: z.literal(JEV_FAILURE_EVIDENCE_SCHEMA_VERSION),
    /** The job type the failure settled in, e.g. 'INSTALL'. */
    deploymentStage: z.string(),
    stackStatus: z.string().optional(),
    failedResourceType: z.string().optional(),
    failedResourceLogicalId: z.string().optional(),
    /** The normalized failure reason, redacted and capped. */
    failureReason: z.string(),
    /** The most recent stack events, most recent last. */
    recentEvents: z.array(jevStackEventSchema).max(MAX_EVENTS),
    codeBuildStatus: z.string().optional(),
    codeBuildPhase: z.string().optional(),
    codeBuildError: z.string().optional(),
    ecsStatus: z.string().optional(),
    ecsStoppedReason: z.string().optional(),
    healthStatus: z.string().optional(),
    relayStatus: z.string().optional(),
    elapsedMs: z.number().int().nonnegative().optional(),
    retryCount: z.number().int().nonnegative().optional(),
    /** The deterministic Deployz failure code AFTER refinement, e.g. 'UNKNOWN'. */
    deployzFailureCode: z.string(),
  })
  .strict();

export type JevFailureEvidence = z.infer<typeof jevFailureEvidenceSchema>;

// ── Input ───────────────────────────────────────────────────────────────────

/**
 * The raw-signal superset the caller has at the relay-result / watchdog hook
 * points. Same field names as the evidence, but un-sanitized; only the stage,
 * a reason source, and the deterministic code are required.
 */
export interface JevFailureEvidenceInput {
  readonly deploymentStage: string;
  readonly stackStatus?: string | undefined;
  readonly failedResourceType?: string | undefined;
  readonly failedResourceLogicalId?: string | undefined;
  /** Any raw reason text (stack reason, exception message) — redacted and capped before it enters the evidence. */
  readonly failureReason: string;
  readonly recentEvents?: readonly {
    readonly resourceType: string;
    readonly logicalResourceId: string;
    readonly resourceStatus: string;
    readonly resourceStatusReason?: string | undefined;
    readonly eventAt: string;
  }[] | undefined;
  readonly codeBuildStatus?: string | undefined;
  readonly codeBuildPhase?: string | undefined;
  readonly codeBuildError?: string | undefined;
  readonly ecsStatus?: string | undefined;
  readonly ecsStoppedReason?: string | undefined;
  readonly healthStatus?: string | undefined;
  readonly relayStatus?: string | undefined;
  readonly elapsedMs?: number | undefined;
  readonly retryCount?: number | undefined;
  readonly deployzFailureCode: string;
}

// ── Builder ─────────────────────────────────────────────────────────────────

/** A trimmed non-empty string, or undefined — an empty optional never travels. */
function optionalText(value: string | undefined): string | undefined {
  return value?.trim() || undefined;
}

/**
 * Build the canonical failure facts object. Pure: redacts and caps the free
 * text, keeps the most recent `MAX_EVENTS` events (most recent last), and
 * drops empty optionals.
 */
export function buildJevFailureEvidence(input: JevFailureEvidenceInput): JevFailureEvidence {
  const stackStatus = optionalText(input.stackStatus);
  const failedResourceType = optionalText(input.failedResourceType);
  const failedResourceLogicalId = optionalText(input.failedResourceLogicalId);
  const codeBuildStatus = optionalText(input.codeBuildStatus);
  const codeBuildPhase = optionalText(input.codeBuildPhase);
  const codeBuildError = optionalText(input.codeBuildError);
  const ecsStatus = optionalText(input.ecsStatus);
  const ecsStoppedReason = optionalText(input.ecsStoppedReason);
  const healthStatus = optionalText(input.healthStatus);
  const relayStatus = optionalText(input.relayStatus);

  return jevFailureEvidenceSchema.parse({
    evidenceSchemaVersion: JEV_FAILURE_EVIDENCE_SCHEMA_VERSION,
    deploymentStage: input.deploymentStage,
    ...(stackStatus !== undefined ? { stackStatus } : {}),
    ...(failedResourceType !== undefined ? { failedResourceType } : {}),
    ...(failedResourceLogicalId !== undefined ? { failedResourceLogicalId } : {}),
    failureReason: redactText(input.failureReason, MAX_REASON_CHARS),
    recentEvents: (input.recentEvents ?? []).slice(-MAX_EVENTS).map((event) => {
      const resourceStatusReason = optionalText(event.resourceStatusReason);
      return {
        resourceType: event.resourceType,
        logicalResourceId: event.logicalResourceId,
        resourceStatus: event.resourceStatus,
        ...(resourceStatusReason !== undefined
          ? { resourceStatusReason: redactText(resourceStatusReason, MAX_EVENT_REASON_CHARS) }
          : {}),
        eventAt: event.eventAt,
      };
    }),
    ...(codeBuildStatus !== undefined ? { codeBuildStatus } : {}),
    ...(codeBuildPhase !== undefined ? { codeBuildPhase } : {}),
    ...(codeBuildError !== undefined
      ? { codeBuildError: redactText(codeBuildError, MAX_BUILD_ERROR_CHARS) }
      : {}),
    ...(ecsStatus !== undefined ? { ecsStatus } : {}),
    ...(ecsStoppedReason !== undefined
      ? { ecsStoppedReason: redactText(ecsStoppedReason, MAX_STOPPED_REASON_CHARS) }
      : {}),
    ...(healthStatus !== undefined ? { healthStatus } : {}),
    ...(relayStatus !== undefined ? { relayStatus } : {}),
    ...(input.elapsedMs !== undefined ? { elapsedMs: input.elapsedMs } : {}),
    ...(input.retryCount !== undefined ? { retryCount: input.retryCount } : {}),
    deployzFailureCode: input.deployzFailureCode,
  });
}
