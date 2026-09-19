/**
 * Jev requirements/plan shadow verifier — the evaluation orchestration.
 *
 * Sends the sanitized evidence (plus the Deployz requirements and plan
 * summary, never the fingerprint) as the state, asks the fixed requirements
 * question set, and normalizes the typed answers into the shadow result a
 * telemetry writer persists.
 *
 * Agreement labels are TELEMETRY ONLY and never policy: they compare Jev's
 * yes-probability against the Deployz boolean inside an uncertainty band, and
 * the Deployz requirements stay the single source of truth. Client errors
 * (JevError) propagate untouched — no catch, no swallow, no logging here (the
 * client already emits the one structured line per call).
 */

import type { JevClient } from './client.js';
import { JevError } from './errors.js';
import type { JevEvidence } from './evidence.js';
import {
  DEEPER_REVIEW_LEVELS,
  JEV_DECISION_SET_VERSION,
  REQUIREMENTS_NOUL_IDS,
  buildRequirementsQuestions,
  type RequirementsNoulId,
} from './questions.js';
import type { JevAnswer } from './schemas.js';

export interface JevRequirementsShadowInput {
  readonly evidence: JevEvidence;
  readonly fingerprint: string;
  readonly deployzRequirements: {
    readonly postgres: boolean;
    readonly redisRequired: boolean;
    readonly storageRequired: boolean;
  };
  readonly planSummary: {
    readonly components: string[];
    readonly awsResources: string[];
  };
}

export type JevAgreement = 'agree' | 'disagree' | 'uncertain';

export interface JevCapabilityDecision {
  readonly deployz: boolean | null;
  readonly jevProbability: number;
  readonly agreement: JevAgreement | null;
}

export interface JevRequirementsShadowResult {
  readonly decisions: Record<RequirementsNoulId, JevCapabilityDecision>;
  readonly possibleMissingRequirements: string[];
  readonly evidenceConflict: string;
  readonly requirementsConsistency: string;
  readonly planConsistency: string;
  readonly reviewSignal: {
    readonly level: string;
    readonly score: number;
    readonly confidence: number;
  };
  readonly conflicts: string[];
  readonly latencyMs: number;
  readonly model: string;
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number };
  readonly evidenceSchemaVersion: number;
  readonly decisionSetVersion: number;
}

const DEFAULT_LABEL = 'requirements-shadow';

/**
 * A probability inside the band is too close to the 0.5 yes-line to call
 * either way — labelled uncertain rather than counted on either side.
 */
const UNCERTAIN_MIN = 0.35;
const UNCERTAIN_MAX = 0.65;
const YES_THRESHOLD = 0.5;

function agreement(deployz: boolean, probability: number): JevAgreement {
  if (probability >= UNCERTAIN_MIN && probability <= UNCERTAIN_MAX) return 'uncertain';
  return (probability >= YES_THRESHOLD) === deployz ? 'agree' : 'disagree';
}

/** The Deployz boolean for a capability, or null where Deployz has no such flag. */
function deployzRequirement(
  id: RequirementsNoulId,
  requirements: JevRequirementsShadowInput['deployzRequirements'],
): boolean | null {
  if (id === 'postgres') return requirements.postgres;
  if (id === 'redis') return requirements.redisRequired;
  if (id === 'storage') return requirements.storageRequired;
  return null;
}

/** An answer whose variant does not match its question is a malformed response. */
function malformed(): JevError {
  return new JevError('malformed', { attempts: 0 });
}

function noulProbability(answers: Record<string, JevAnswer>, id: string): number {
  const answer = answers[id];
  if (answer?.type !== 'noul') throw malformed();
  return answer.noul;
}

function choiceValue(answers: Record<string, JevAnswer>, id: string): string {
  const answer = answers[id];
  if (answer?.type !== 'choice') throw malformed();
  return answer.choice;
}

function scoreAnswer(answers: Record<string, JevAnswer>, id: string): {
  score: number;
  confidence: number;
  probabilities: Record<string, number>;
} {
  const answer = answers[id];
  if (answer?.type !== 'score') throw malformed();
  return answer;
}

/**
 * The argmax level of a score answer's probabilities, mapped from the level
 * index to the ordered criteria name. The lowest index wins a tie, so the
 * mapping is deterministic.
 */
function argmaxReviewLevel(probabilities: Record<string, number>): string {
  const levels: readonly string[] = DEEPER_REVIEW_LEVELS;
  let bestIndex = 0;
  let bestProbability = Number.NEGATIVE_INFINITY;
  for (let index = 0; index < levels.length; index += 1) {
    const probability = probabilities[String(index)] ?? 0;
    if (probability > bestProbability) {
      bestProbability = probability;
      bestIndex = index;
    }
  }
  return levels[bestIndex] ?? 'not-needed';
}

function capabilityDecision(
  id: RequirementsNoulId,
  input: JevRequirementsShadowInput,
  answers: Record<string, JevAnswer>,
): JevCapabilityDecision {
  const deployz = deployzRequirement(id, input.deployzRequirements);
  const jevProbability = noulProbability(answers, id);
  return {
    deployz,
    jevProbability,
    agreement: deployz === null ? null : agreement(deployz, jevProbability),
  };
}

export async function runJevRequirementsShadow(
  client: JevClient,
  input: JevRequirementsShadowInput,
  options?: { label?: string; signal?: AbortSignal },
): Promise<JevRequirementsShadowResult> {
  // The fingerprint identifies the row, not the ask — it never travels to Jev.
  const response = await client.evaluate(
    {
      evidence: input.evidence,
      deployzRequirements: input.deployzRequirements,
      planSummary: input.planSummary,
    },
    buildRequirementsQuestions(),
    { label: options?.label ?? DEFAULT_LABEL, signal: options?.signal },
  );

  const decisions: Record<RequirementsNoulId, JevCapabilityDecision> = {
    postgres: capabilityDecision('postgres', input, response.answers),
    redis: capabilityDecision('redis', input, response.answers),
    storage: capabilityDecision('storage', input, response.answers),
    publicHttp: capabilityDecision('publicHttp', input, response.answers),
    worker: capabilityDecision('worker', input, response.answers),
  };

  const missingDependency = choiceValue(response.answers, 'missingDependency');
  const evidenceConflict = choiceValue(response.answers, 'evidenceConflict');
  const requirementsConsistency = choiceValue(response.answers, 'internalConsistency');
  const planConsistency = choiceValue(response.answers, 'planConsistency');
  const review = scoreAnswer(response.answers, 'deeperReview');

  const conflicts: string[] = [];
  for (const id of REQUIREMENTS_NOUL_IDS) {
    if (decisions[id].agreement === 'disagree') conflicts.push(`${id}-disagreement`);
  }
  if (evidenceConflict === 'possible' || evidenceConflict === 'clear') {
    conflicts.push(`evidence-conflict:${evidenceConflict}`);
  }
  if (requirementsConsistency === 'contradictory') conflicts.push('requirements-inconsistent');
  if (planConsistency === 'contradictory') conflicts.push('plan-inconsistent');
  if (missingDependency !== 'none') conflicts.push(`possible-missing:${missingDependency}`);

  return {
    decisions,
    possibleMissingRequirements: missingDependency !== 'none' ? [missingDependency] : [],
    evidenceConflict,
    requirementsConsistency,
    planConsistency,
    reviewSignal: {
      level: argmaxReviewLevel(review.probabilities),
      score: review.score,
      confidence: review.confidence,
    },
    conflicts,
    latencyMs: response.latencyMs,
    model: response.model,
    usage: {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
    },
    evidenceSchemaVersion: input.evidence.evidenceSchemaVersion,
    decisionSetVersion: JEV_DECISION_SET_VERSION,
  };
}
