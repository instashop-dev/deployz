/**
 * Jev UNKNOWN-failure shadow classifier — the evaluation orchestration.
 *
 * Sends only the sanitized failure evidence as the state, asks the fixed
 * failure question set, and normalizes the typed answers into the shadow
 * classification a telemetry writer persists. The labels are TELEMETRY ONLY
 * and never policy: the deterministic failure handling in apps/api stays the
 * single source of truth. Client errors (JevError) propagate untouched — no
 * catch, no swallow, no logging here (the client already emits the one
 * structured line per call).
 */

import type { JevClient } from './client.js';
import { JevError } from './errors.js';
import type { JevFailureEvidence } from './failure-evidence.js';
import type { JevAnswer, JevQuestion } from './schemas.js';

/** Bump when any question's wording or option set changes. */
export const JEV_FAILURE_DECISION_SET_VERSION = 1;

/** The failure domains, in decision-set order. */
export const FAILURE_DOMAINS = [
  'APPLICATION',
  'CUSTOMER_CONFIGURATION',
  'AWS',
  'DEPLOYZ',
  'DEPENDENCY',
  'REGISTRY',
  'NETWORK',
  'UNKNOWN',
] as const;
export type JevFailureDomain = (typeof FAILURE_DOMAINS)[number];

/** Every question shares this instruction — the state carries the facts, never the ask. */
const JUDGE_FROM_EVIDENCE = 'Judge from the evidence only.';

export function buildFailureQuestions(): Record<string, JevQuestion> {
  return {
    failureDomain: {
      type: 'choice',
      instructions: `${JUDGE_FROM_EVIDENCE} Which domain does the deployment failure belong to?`,
      criteria: {
        APPLICATION: 'The application code or configuration crashed or did not start.',
        CUSTOMER_CONFIGURATION:
          'Values the customer supplied (secrets, environment variables, domain, account setup) are wrong or missing.',
        AWS: 'An AWS fault, quota, or permission problem that the customer did not cause.',
        DEPLOYZ: 'A Deployz control-plane, relay, or template fault.',
        DEPENDENCY: 'An external service that the application calls failed.',
        REGISTRY: 'An image pull, push, or authentication problem against the registry.',
        NETWORK: 'A connectivity, DNS, or TLS problem between components.',
        UNKNOWN: 'The evidence does not support any domain.',
      },
    },
    likelyTransient: {
      type: 'noul',
      instructions: `${JUDGE_FROM_EVIDENCE} Would a retry without any change have a real chance to succeed?`,
      criteria: {
        true: 'A retry without changes has a real chance to succeed.',
        false: 'A retry will fail the same way again.',
      },
    },
    recommendedAction: {
      type: 'choice',
      instructions: `${JUDGE_FROM_EVIDENCE} Who most likely must act first to fix the failure?`,
      criteria: {
        none: 'No action is needed — a retry or the passage of time clears the failure.',
        customer:
          'The customer must act first — fix application code, secrets, environment values, domain, or account setup.',
        vendor: 'The AWS vendor must act first — a quota, permission, or AWS-side fault.',
        deployz: 'Deployz must act first — a control-plane, relay, or template fault.',
      },
    },
  };
}

export interface JevFailureShadowInput {
  readonly failureEvidence: JevFailureEvidence;
}

export interface JevFailureClassificationResult {
  readonly failureDomain: JevFailureDomain;
  readonly domainProbabilities: Record<JevFailureDomain, number>;
  readonly domainConfidence: number;
  readonly likelyTransient: boolean;
  readonly likelyTransientProbability: number;
  readonly recommendedAction: 'none' | 'customer' | 'vendor' | 'deployz';
  readonly actionConfidence: number;
  readonly classificationUnclear: boolean;
  readonly latencyMs: number;
  readonly model: string;
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number };
  readonly evidenceSchemaVersion: number;
  readonly decisionSetVersion: number;
}

const DEFAULT_LABEL = 'failure-shadow';
const TRANSIENT_THRESHOLD = 0.5;
/** Below this confidence the classification is not worth reading as an answer. */
const UNCLEAR_CONFIDENCE = 0.4;

/** An answer whose variant does not match its question is a malformed response. */
function malformed(): JevError {
  return new JevError('malformed', { attempts: 0 });
}

function noulProbability(answers: Record<string, JevAnswer>, id: string): number {
  const answer = answers[id];
  if (answer?.type !== 'noul') throw malformed();
  return answer.noul;
}

function choiceAnswer(
  answers: Record<string, JevAnswer>,
  id: string,
): {
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
} {
  const answer = answers[id];
  if (answer?.type !== 'choice') throw malformed();
  return answer;
}

/** The highest-probability domain; the earliest domain in decision-set order wins a tie. */
function argmaxDomain(probabilities: Record<JevFailureDomain, number>): JevFailureDomain {
  let best: JevFailureDomain = 'APPLICATION';
  let bestProbability = Number.NEGATIVE_INFINITY;
  for (const domain of FAILURE_DOMAINS) {
    if (probabilities[domain] > bestProbability) {
      bestProbability = probabilities[domain];
      best = domain;
    }
  }
  return best;
}

export async function runJevFailureClassification(
  client: JevClient,
  input: JevFailureShadowInput,
  options?: { label?: string; signal?: AbortSignal },
): Promise<JevFailureClassificationResult> {
  const response = await client.evaluate(
    { failureEvidence: input.failureEvidence },
    buildFailureQuestions(),
    { label: options?.label ?? DEFAULT_LABEL, signal: options?.signal },
  );

  const domain = choiceAnswer(response.answers, 'failureDomain');
  const domainProbabilities: Record<JevFailureDomain, number> = {
    APPLICATION: domain.probabilities.APPLICATION ?? 0,
    CUSTOMER_CONFIGURATION: domain.probabilities.CUSTOMER_CONFIGURATION ?? 0,
    AWS: domain.probabilities.AWS ?? 0,
    DEPLOYZ: domain.probabilities.DEPLOYZ ?? 0,
    DEPENDENCY: domain.probabilities.DEPENDENCY ?? 0,
    REGISTRY: domain.probabilities.REGISTRY ?? 0,
    NETWORK: domain.probabilities.NETWORK ?? 0,
    UNKNOWN: domain.probabilities.UNKNOWN ?? 0,
  };
  const failureDomain = argmaxDomain(domainProbabilities);

  const action = choiceAnswer(response.answers, 'recommendedAction');
  const recommendedAction = action.choice;
  if (
    recommendedAction !== 'none' &&
    recommendedAction !== 'customer' &&
    recommendedAction !== 'vendor' &&
    recommendedAction !== 'deployz'
  ) {
    throw malformed();
  }

  const transientProbability = noulProbability(response.answers, 'likelyTransient');

  return {
    failureDomain,
    domainProbabilities,
    domainConfidence: domain.confidence,
    likelyTransient: transientProbability >= TRANSIENT_THRESHOLD,
    likelyTransientProbability: transientProbability,
    recommendedAction,
    actionConfidence: action.confidence,
    classificationUnclear:
      failureDomain === 'UNKNOWN' || domain.confidence < UNCLEAR_CONFIDENCE,
    latencyMs: response.latencyMs,
    model: response.model,
    usage: {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
    },
    evidenceSchemaVersion: input.failureEvidence.evidenceSchemaVersion,
    decisionSetVersion: JEV_FAILURE_DECISION_SET_VERSION,
  };
}
