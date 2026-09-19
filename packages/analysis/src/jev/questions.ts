/**
 * Jev requirements shadow question set — the fixed decision set the
 * requirements/plan verifier asks, versioned as a unit.
 *
 * The state carries the facts; the questions carry only the judgment asks.
 * Every question tells the model to judge from the evidence alone, and every
 * noul criteria pair states exactly what a yes and a no mean. A change to any
 * wording or option set bumps `JEV_DECISION_SET_VERSION`, which every shadow
 * result persists, so old rows are never compared against a new question set.
 */

import type { JevQuestion } from './schemas.js';

/** Bump when any question's wording or option set changes. */
export const JEV_DECISION_SET_VERSION = 1;

/** The one-question-per-capability noul ids, in decision-set order. */
export const REQUIREMENTS_NOUL_IDS = ['postgres', 'redis', 'storage', 'publicHttp', 'worker'] as const;
export type RequirementsNoulId = (typeof REQUIREMENTS_NOUL_IDS)[number];

/** Ordered levels of the deeperReview score question, weakest first. */
export const DEEPER_REVIEW_LEVELS = ['not-needed', 'worth-review', 'needed'] as const;

/** Every question shares this instruction — the state carries the facts, never the ask. */
const JUDGE_FROM_EVIDENCE = 'Judge from the evidence only.';

export function buildRequirementsQuestions(): Record<string, JevQuestion> {
  return {
    postgres: {
      type: 'noul',
      instructions: `${JUDGE_FROM_EVIDENCE} Does the application need a PostgreSQL database to start or work?`,
      criteria: {
        true: 'The application needs a PostgreSQL database to start or work.',
        false: 'The application works without a PostgreSQL database.',
      },
    },
    redis: {
      type: 'noul',
      instructions: `${JUDGE_FROM_EVIDENCE} Does the application need a Redis-compatible cache to start or work?`,
      criteria: {
        true: 'The application needs a Redis-compatible cache to start or work.',
        false: 'The application works without a Redis-compatible cache.',
      },
    },
    storage: {
      type: 'noul',
      instructions: `${JUDGE_FROM_EVIDENCE} Does the application need object storage (for example S3) to start or work?`,
      criteria: {
        true: 'The application needs object storage to start or work.',
        false: 'The application works without object storage.',
      },
    },
    publicHttp: {
      type: 'noul',
      instructions: `${JUDGE_FROM_EVIDENCE} Does the application serve public HTTP traffic?`,
      criteria: {
        true: 'The application runs an HTTP server that must be reachable.',
        false: 'The application does not serve HTTP traffic.',
      },
    },
    worker: {
      type: 'noul',
      instructions: `${JUDGE_FROM_EVIDENCE} Does the application run background work separate from the HTTP request path?`,
      criteria: {
        true: 'The application runs background jobs or workers.',
        false: 'The application has no background work.',
      },
    },
    missingDependency: {
      type: 'choice',
      instructions: `${JUDGE_FROM_EVIDENCE} Do the Deployz requirements miss a capability that the repository evidence shows?`,
      criteria: {
        none: 'No requirement is missing.',
        database: 'A database requirement is missing.',
        cache: 'A cache requirement is missing.',
        storage: 'A storage requirement is missing.',
        other: 'Another kind of requirement is missing.',
      },
    },
    evidenceConflict: {
      type: 'choice',
      instructions: `${JUDGE_FROM_EVIDENCE} Do the stated requirements contradict the repository evidence?`,
      criteria: {
        none: 'No contradiction.',
        possible: 'A contradiction is possible but not certain.',
        clear: 'The requirements clearly contradict the evidence.',
      },
    },
    internalConsistency: {
      type: 'choice',
      instructions: `${JUDGE_FROM_EVIDENCE} Are the stated requirements consistent with each other?`,
      criteria: {
        consistent: 'The requirements are consistent.',
        contradictory: 'The requirements contradict each other.',
      },
    },
    planConsistency: {
      type: 'choice',
      instructions: `${JUDGE_FROM_EVIDENCE} Does the deployment plan match the requirements and the repository evidence?`,
      criteria: {
        consistent: 'The plan matches the requirements and the evidence.',
        contradictory: 'The plan contradicts the requirements or the evidence.',
        unclear: 'The plan does not give enough information to judge.',
      },
    },
    deeperReview: {
      type: 'score',
      instructions: `${JUDGE_FROM_EVIDENCE} How much does this deployment need a deeper human review before it is trusted?`,
      criteria: [...DEEPER_REVIEW_LEVELS],
    },
  };
}
