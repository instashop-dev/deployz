import { normalizeErrorText, redactSecrets, type StructuredEvent } from '@deployz/analysis';
import type { FailureCode } from '@deployz/contracts';

// Deployment failure context (AI MVP Phase 6) — the ONE bounded, sanitised
// representation of a failed operation that both the diagnostics response
// and the AI explainer consume. Built deterministically from what the
// control plane already holds: the failed job (its type, the code the relay
// reported and the code refinement settled on, the relay's verbatim error)
// and the CloudFormation events persisted for that job. Everything free-text
// is redacted and truncated before it leaves this module; nothing here reads
// application logs (the relay never collects them by design).

/** One CloudFormation event that names a failed resource. */
export interface FailureContextEvent {
  logicalResourceId: string;
  resourceType: string;
  resourceStatus: string;
  /** Redacted, truncated. Null when CloudFormation gave no reason. */
  reason: string | null;
}

export interface DeploymentFailureContext {
  deploymentId: string;
  /** The operation that failed — the job type in product words is the UI's job. */
  phase: string;
  /** Which attempt this was, when the job carries one. */
  attempt: number | null;
  /** The settled §61 code (after server-side refinement). */
  failureCode: FailureCode;
  /** The code the relay reported before refinement, when it differed. */
  reportedFailureCode: FailureCode | null;
  /** The resource type CloudFormation blamed first, when any. */
  resourceType: string | null;
  /** The relay's error, redacted and truncated for display. Null when none. */
  message: string | null;
  /** The failed resource events, oldest first — bounded. */
  relevantEvents: FailureContextEvent[];
  /** The release version this operation targeted, when known. */
  applicationVersion: string | null;
}

export interface FailureContextInput {
  deploymentId: string;
  job: {
    type: string;
    failureCode: FailureCode | null;
    /** The relay's result body as stored — its own `failureCode` and `error`. */
    result: unknown;
  };
  /** The deployment's attempt counter, when it carries one. */
  attempt: number | null;
  stackEvents: readonly {
    logicalResourceId: string;
    resourceType: string;
    resourceStatus: string;
    resourceStatusReason: string | null;
  }[];
  applicationVersion: string | null;
}

/** The most failed-resource events kept — enough to see a cascade, never a dump. */
export const MAX_RELEVANT_EVENTS = 5;
const MAX_MESSAGE_CHARS = 500;
const MAX_REASON_CHARS = 300;

/** CloudFormation's own cascade noise — a resource cancelled because another failed. */
const CANCELLATION_NOISE = /resource creation cancelled|resource update cancelled/i;

function isFailedResourceEvent(event: FailureContextInput['stackEvents'][number]): boolean {
  return (
    /_FAILED$/.test(event.resourceStatus) &&
    event.resourceType !== 'AWS::CloudFormation::Stack' &&
    !(event.resourceStatusReason !== null && CANCELLATION_NOISE.test(event.resourceStatusReason))
  );
}

function readString(value: unknown, key: string): string | null {
  if (typeof value !== 'object' || value === null) return null;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === 'string' && field.length > 0 ? field : null;
}

/**
 * Build the context. Pure: the same job, events and version always give the
 * same context. The relay's original code is kept only when refinement
 * changed it, so the technical view can show both without repeating itself.
 */
export function buildFailureContext(input: FailureContextInput): DeploymentFailureContext {
  const failed = input.stackEvents.filter(isFailedResourceEvent);
  const relevantEvents = failed.slice(0, MAX_RELEVANT_EVENTS).map((event) => ({
    logicalResourceId: event.logicalResourceId,
    resourceType: event.resourceType,
    resourceStatus: event.resourceStatus,
    reason:
      event.resourceStatusReason !== null && event.resourceStatusReason.length > 0
        ? normalizeErrorText(event.resourceStatusReason, { maxLength: MAX_REASON_CHARS })
        : null,
  }));
  const rawMessage = readString(input.job.result, 'error');
  const reported = readString(input.job.result, 'failureCode') as FailureCode | null;
  const failureCode = input.job.failureCode ?? 'UNKNOWN';
  return {
    deploymentId: input.deploymentId,
    phase: input.job.type,
    attempt: input.attempt,
    failureCode,
    reportedFailureCode: reported !== null && reported !== failureCode ? reported : null,
    resourceType: failed[0]?.resourceType ?? null,
    message: rawMessage !== null ? normalizeErrorText(rawMessage, { maxLength: MAX_MESSAGE_CHARS }) : null,
    relevantEvents,
    applicationVersion: input.applicationVersion !== null ? redactSecrets(input.applicationVersion) : null,
  };
}

/**
 * The bounded structured event the AI explainer receives — built from the
 * context only, never from raw text the context did not already sanitise.
 * Only the first two failed-resource reasons ride along: enough for a
 * cause, small enough to stay inside the prompt budget.
 */
export function toStructuredEvent(context: DeploymentFailureContext, deploymentState: string): StructuredEvent {
  const failedResources = context.relevantEvents
    .slice(0, 2)
    .map((event) => `${event.resourceType} ${event.resourceStatus}${event.reason ? `: ${event.reason}` : ''}`);
  return {
    source: 'deployment',
    action: context.phase,
    ...(context.message !== null ? { error: { message: context.message } } : {}),
    context: {
      deploymentState,
      ...(context.attempt !== null ? { attempt: context.attempt } : {}),
      ...(context.resourceType !== null ? { resourceType: context.resourceType } : {}),
      ...(failedResources.length > 0 ? { failedResources } : {}),
      ...(context.applicationVersion !== null ? { applicationVersion: context.applicationVersion } : {}),
    },
  };
}
