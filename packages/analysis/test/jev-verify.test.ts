import { describe, expect, it } from 'vitest';

import type { JevClient } from '../src/jev/client.js';
import { JevError } from '../src/jev/errors.js';
import type { JevEvidence } from '../src/jev/evidence.js';
import { createFixtureJevClient, type FixtureJevResponse } from '../src/jev/fixture.js';
import {
  JEV_DECISION_SET_VERSION,
  REQUIREMENTS_NOUL_IDS,
  buildRequirementsQuestions,
} from '../src/jev/questions.js';
import {
  runJevRequirementsShadow,
  type JevRequirementsShadowInput,
} from '../src/jev/verify.js';

// ==========================================================================
// Fixtures — a minimal schema-valid evidence object and a canned answer set
// ==========================================================================

const evidence: JevEvidence = {
  evidenceSchemaVersion: 1,
  runtimes: ['node'],
  dependencies: ['express', 'pg'],
  envVariables: [{ name: 'DATABASE_URL', required: true }],
  docker: { present: true, exposedPorts: [3000] },
  database: { postgresDetected: true, enginesSeen: [] },
  cache: { redisDetected: false },
  storage: { s3Detected: false, localFilesystemDetected: false },
  workers: { workerDetected: false },
  bindings: [],
  sourceSignals: [],
  ambiguities: [],
  manifestRequirements: { postgres: true, redisRequired: false, storageRequired: false },
  rejectionReasons: [],
  snippets: [],
};

const input: JevRequirementsShadowInput = {
  evidence,
  fingerprint: 'sha256-fixture-fingerprint',
  deployzRequirements: { postgres: true, redisRequired: true, storageRequired: true },
  planSummary: { components: ['web'], awsResources: ['AWS::ECS::Service'] },
};

/**
 * A full answer set. Against `input`: postgres 0.9 vs true → agree, redis 0.1
 * vs true → disagree, storage 0.5 → uncertain; missingDependency database,
 * evidenceConflict clear, planConsistency contradictory, deeperReview argmax
 * on level index 1.
 */
const baseAnswers: FixtureJevResponse['answers'] = {
  postgres: { type: 'noul', noul: 0.9 },
  redis: { type: 'noul', noul: 0.1 },
  storage: { type: 'noul', noul: 0.5 },
  publicHttp: { type: 'noul', noul: 0.8 },
  worker: { type: 'noul', noul: 0.2 },
  missingDependency: {
    type: 'choice',
    choice: 'database',
    probabilities: { database: 0.8, none: 0.2 },
    confidence: 0.8,
  },
  evidenceConflict: {
    type: 'choice',
    choice: 'clear',
    probabilities: { clear: 0.9, none: 0.1 },
    confidence: 0.9,
  },
  internalConsistency: {
    type: 'choice',
    choice: 'consistent',
    probabilities: { consistent: 1 },
    confidence: 0.95,
  },
  planConsistency: {
    type: 'choice',
    choice: 'contradictory',
    probabilities: { contradictory: 0.85, consistent: 0.15 },
    confidence: 0.85,
  },
  deeperReview: {
    type: 'score',
    score: 1,
    legend: { '0': 'not-needed', '1': 'worth-review', '2': 'needed' },
    probabilities: { '0': 0.1, '1': 0.8, '2': 0.1 },
    confidence: 0.66,
  },
};

function clientWith(overrides?: Partial<FixtureJevResponse>): ReturnType<typeof createFixtureJevClient> {
  return createFixtureJevClient({
    'requirements-shadow': { answers: baseAnswers, ...overrides },
  });
}

// ==========================================================================
// The question set
// ==========================================================================

describe('buildRequirementsQuestions', () => {
  it('covers every capability noul id plus the four judgment questions', () => {
    const questions = buildRequirementsQuestions();

    for (const id of REQUIREMENTS_NOUL_IDS) {
      expect(questions[id]?.type).toBe('noul');
    }
    expect(questions.missingDependency?.type).toBe('choice');
    expect(questions.evidenceConflict?.type).toBe('choice');
    expect(questions.internalConsistency?.type).toBe('choice');
    expect(questions.planConsistency?.type).toBe('choice');
    expect(questions.deeperReview?.type).toBe('score');
  });

  it('orders the deeperReview levels weakest-first', () => {
    const deeperReview = buildRequirementsQuestions().deeperReview;
    expect(deeperReview?.type === 'score' && deeperReview.criteria).toEqual([
      'not-needed',
      'worth-review',
      'needed',
    ]);
  });
});

// ==========================================================================
// Agreement labels — telemetry only
// ==========================================================================

describe('runJevRequirementsShadow — agreement', () => {
  it('labels agree, disagree, and uncertain against the Deployz boolean', async () => {
    const result = await runJevRequirementsShadow(clientWith(), input);

    expect(result.decisions.postgres).toEqual({
      deployz: true,
      jevProbability: 0.9,
      agreement: 'agree',
    });
    expect(result.decisions.redis).toEqual({
      deployz: true,
      jevProbability: 0.1,
      agreement: 'disagree',
    });
    expect(result.decisions.storage).toEqual({
      deployz: true,
      jevProbability: 0.5,
      agreement: 'uncertain',
    });
  });

  it('treats the band edges 0.35 and 0.65 as uncertain', async () => {
    const result = await runJevRequirementsShadow(
      clientWith({
        answers: {
          ...baseAnswers,
          postgres: { type: 'noul', noul: 0.35 },
          redis: { type: 'noul', noul: 0.65 },
        },
      }),
      { ...input, deployzRequirements: { postgres: false, redisRequired: false, storageRequired: false } },
    );

    expect(result.decisions.postgres.agreement).toBe('uncertain');
    expect(result.decisions.redis.agreement).toBe('uncertain');
  });

  it('agrees with a false Deployz boolean on a low probability', async () => {
    const result = await runJevRequirementsShadow(
      clientWith(),
      { ...input, deployzRequirements: { postgres: false, redisRequired: true, storageRequired: true } },
    );

    expect(result.decisions.postgres).toEqual({
      deployz: false,
      jevProbability: 0.9,
      agreement: 'disagree',
    });
  });

  it('marks capabilities without a Deployz boolean as null/null', async () => {
    const result = await runJevRequirementsShadow(clientWith(), input);

    expect(result.decisions.publicHttp).toEqual({
      deployz: null,
      jevProbability: 0.8,
      agreement: null,
    });
    expect(result.decisions.worker).toEqual({
      deployz: null,
      jevProbability: 0.2,
      agreement: null,
    });
  });
});

// ==========================================================================
// Missing requirements, conflicts, review signal
// ==========================================================================

describe('runJevRequirementsShadow — normalization', () => {
  it('surfaces a non-none missingDependency as a possible missing requirement', async () => {
    const result = await runJevRequirementsShadow(clientWith(), input);

    expect(result.possibleMissingRequirements).toEqual(['database']);
    expect(result.conflicts).toContain('possible-missing:database');
  });

  it('reports no missing requirements when the answer is none', async () => {
    const result = await runJevRequirementsShadow(
      clientWith({
        answers: {
          ...baseAnswers,
          missingDependency: {
            type: 'choice',
            choice: 'none',
            probabilities: { none: 1 },
            confidence: 0.9,
          },
        },
      }),
      input,
    );

    expect(result.possibleMissingRequirements).toEqual([]);
    expect(result.conflicts).not.toContain(expect.stringContaining('possible-missing'));
  });

  it('assembles conflicts from every source in decision-set order', async () => {
    const result = await runJevRequirementsShadow(clientWith(), input);

    expect(result.conflicts).toEqual([
      'redis-disagreement',
      'evidence-conflict:clear',
      'plan-inconsistent',
      'possible-missing:database',
    ]);
  });

  it('adds requirements-inconsistent for a contradictory internal consistency', async () => {
    const result = await runJevRequirementsShadow(
      clientWith({
        answers: {
          ...baseAnswers,
          internalConsistency: {
            type: 'choice',
            choice: 'contradictory',
            probabilities: { contradictory: 1 },
            confidence: 0.9,
          },
        },
      }),
      input,
    );

    expect(result.conflicts).toContain('requirements-inconsistent');
  });

  it('maps the argmax score level to the criteria level name and plumbs score and confidence', async () => {
    const result = await runJevRequirementsShadow(clientWith(), input);

    expect(result.reviewSignal).toEqual({ level: 'worth-review', score: 1, confidence: 0.66 });
  });

  it('plumbs evidenceConflict, requirementsConsistency, and planConsistency', async () => {
    const result = await runJevRequirementsShadow(clientWith(), input);

    expect(result.evidenceConflict).toBe('clear');
    expect(result.requirementsConsistency).toBe('consistent');
    expect(result.planConsistency).toBe('contradictory');
  });
});

// ==========================================================================
// Request shape and metadata
// ==========================================================================

describe('runJevRequirementsShadow — request and result metadata', () => {
  it('sends evidence + deployzRequirements + planSummary as the state, never the fingerprint', async () => {
    const client = clientWith();

    await runJevRequirementsShadow(client, input);

    const request = client.lastRequest();
    expect(request?.label).toBe('requirements-shadow');
    expect(request?.state).toEqual({
      evidence: input.evidence,
      deployzRequirements: input.deployzRequirements,
      planSummary: input.planSummary,
    });
    expect(JSON.stringify(request?.state)).not.toContain('sha256-fixture-fingerprint');
    expect(request?.questions).toEqual(buildRequirementsQuestions());
  });

  it('honours a custom label', async () => {
    const client = createFixtureJevClient({ custom: { answers: baseAnswers } });

    await runJevRequirementsShadow(client, input, { label: 'custom' });

    expect(client.lastRequest()?.label).toBe('custom');
  });

  it('returns latency, model, usage, and both schema versions', async () => {
    const result = await runJevRequirementsShadow(
      clientWith({ model: 'jev-1.13.0', usage: { input_tokens: 21, output_tokens: 7 } }),
      input,
    );

    expect(result.model).toBe('jev-1.13.0');
    expect(result.usage).toEqual({ inputTokens: 21, outputTokens: 7 });
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(result.evidenceSchemaVersion).toBe(1);
    expect(result.decisionSetVersion).toBe(JEV_DECISION_SET_VERSION);
    expect(JEV_DECISION_SET_VERSION).toBe(1);
  });
});

// ==========================================================================
// Error propagation
// ==========================================================================

describe('runJevRequirementsShadow — errors', () => {
  it('propagates a client JevError untouched', async () => {
    const thrown = new JevError('rate-limited', { status: 429, attempts: 2 });
    const client: JevClient = {
      evaluate: () => Promise.reject(thrown),
    };

    await expect(runJevRequirementsShadow(client, input)).rejects.toBe(thrown);
  });

  it('treats an answer of the wrong variant for its question as malformed', async () => {
    const client = clientWith({
      answers: { ...baseAnswers, postgres: { type: 'choice', choice: 'yes', probabilities: { yes: 1 }, confidence: 1 } },
    });

    await expect(runJevRequirementsShadow(client, input)).rejects.toMatchObject({ kind: 'malformed' });
  });
});
