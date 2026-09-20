import { describe, expect, it } from 'vitest';

import type { JevClient } from '../src/jev/client.js';
import {
  FAILURE_DOMAINS,
  JEV_FAILURE_DECISION_SET_VERSION,
  buildFailureQuestions,
  runJevFailureClassification,
} from '../src/jev/failure-classify.js';
import {
  JEV_FAILURE_EVIDENCE_SCHEMA_VERSION,
  buildJevFailureEvidence,
  type JevFailureEvidenceInput,
} from '../src/jev/failure-evidence.js';
import { JevError } from '../src/jev/errors.js';
import { redactText, sanitizeSnippet } from '../src/jev/evidence.js';
import { createFixtureJevClient, type FixtureJevResponse } from '../src/jev/fixture.js';

// ==========================================================================
// redactText — the shared redaction core
// ==========================================================================

describe('redactText', () => {
  it('redacts a KEY=value assignment', () => {
    const result = redactText('DATABASE_URL=postgres://user:secret@host/db', 500);
    expect(result).toContain('DATABASE_URL=[REDACTED]');
    expect(result).not.toContain('secret');
  });

  it('redacts a keyword-named credential value', () => {
    const result = redactText('auth failed for Bearer tok_abc123def456ghi789', 500);
    expect(result).toContain('Bearer [REDACTED]');
    expect(result).not.toContain('tok_abc123def456ghi789');
  });

  it('redacts a credentialed URI', () => {
    const result = redactText('cannot connect: postgresql://admin:hunter2@rds.internal:5432/app', 500);
    expect(result).toContain('postgresql://[REDACTED]@rds.internal');
    expect(result).not.toContain('hunter2');
  });

  it('redacts a long opaque base64/hex run', () => {
    expect(redactText('signature AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', 500)).toBe('signature [REDACTED]');
  });

  it('collapses whitespace and applies a custom cap', () => {
    expect(redactText('a\n  b\t\tc', 100)).toBe('a b c');
    expect(redactText('word '.repeat(40).trim(), 100)).toHaveLength(100);
  });

  it('caps sanitizeSnippet at the snippet budget', () => {
    expect(sanitizeSnippet('ab '.repeat(150).trim())).toHaveLength(200);
  });
});

// ==========================================================================
// buildJevFailureEvidence — redaction, caps, dropped optionals
// ==========================================================================

describe('buildJevFailureEvidence', () => {
  const realistic: JevFailureEvidenceInput = {
    deploymentStage: 'INSTALL',
    stackStatus: '',
    failureReason:
      'Service task failed: FATAL: password authentication failed, DATABASE_URL=postgres://admin:hunter2@rds.internal:5432/app',
    recentEvents: [
      {
        resourceType: 'AWS::CloudFormation::Stack',
        logicalResourceId: 'app',
        resourceStatus: 'REVIEW_IN_PROGRESS',
        eventAt: '2026-09-20T01:00:00Z',
      },
      {
        resourceType: 'AWS::ECS::Service',
        logicalResourceId: 'Service',
        resourceStatus: 'CREATE_FAILED',
        resourceStatusReason:
          'Resource creation cancelled postgresql://admin:hunter2@rds.internal:5432/app',
        eventAt: '2026-09-20T01:01:00Z',
      },
    ],
    ecsStatus: '   ',
    ecsStoppedReason: 'Task failed ELB health checks',
    healthStatus: 'unhealthy',
    elapsedMs: 0,
    deployzFailureCode: 'UNKNOWN',
  };

  it('maps the signals, redacts free text, and drops empty optionals', () => {
    const evidence = buildJevFailureEvidence(realistic);

    expect(evidence.evidenceSchemaVersion).toBe(JEV_FAILURE_EVIDENCE_SCHEMA_VERSION);
    expect(JEV_FAILURE_EVIDENCE_SCHEMA_VERSION).toBe(1);
    expect(evidence.deploymentStage).toBe('INSTALL');
    expect(evidence.deployzFailureCode).toBe('UNKNOWN');
    expect(evidence.failureReason).not.toContain('hunter2');
    expect(evidence.failureReason).toContain('password [REDACTED]');
    expect(evidence.failureReason).toContain('DATABASE_URL=[REDACTED]');
    expect(evidence.recentEvents[1]?.resourceStatusReason).toContain('[REDACTED]@rds.internal');
    expect(evidence.recentEvents[1]?.resourceStatusReason).not.toContain('hunter2');
    expect(evidence.ecsStoppedReason).toBe('Task failed ELB health checks');
    expect(evidence.healthStatus).toBe('unhealthy');
    // An empty optional never travels; zero is a value and does.
    expect(evidence).not.toHaveProperty('stackStatus');
    expect(evidence).not.toHaveProperty('ecsStatus');
    expect(evidence.elapsedMs).toBe(0);
    expect(evidence).not.toHaveProperty('retryCount');
  });

  it('caps the failure reason at 500 and keeps only the 10 most recent events', () => {
    const events = Array.from({ length: 12 }, (_, index) => ({
      resourceType: 'AWS::ECS::Service',
      logicalResourceId: `Service${index}`,
      resourceStatus: 'CREATE_FAILED',
      eventAt: `2026-09-20T01:${String(index).padStart(2, '0')}:00Z`,
    }));

    const evidence = buildJevFailureEvidence({
      ...realistic,
      failureReason: 'reason '.repeat(100),
      recentEvents: events,
    });

    expect(evidence.failureReason).toHaveLength(500);
    expect(evidence.recentEvents).toHaveLength(10);
    expect(evidence.recentEvents[0]?.logicalResourceId).toBe('Service2');
    expect(evidence.recentEvents[9]?.logicalResourceId).toBe('Service11');
  });
});

// ==========================================================================
// buildFailureQuestions
// ==========================================================================

describe('buildFailureQuestions', () => {
  it('offers every failure domain plus the two follow-up questions', () => {
    const questions = buildFailureQuestions();
    const domainQuestion = questions.failureDomain;

    expect(domainQuestion?.type).toBe('choice');
    expect(
      domainQuestion?.type === 'choice' && Object.keys(domainQuestion.criteria),
    ).toEqual([...FAILURE_DOMAINS]);
    expect(questions.likelyTransient?.type).toBe('noul');
    expect(questions.recommendedAction?.type).toBe('choice');
  });
});

// ==========================================================================
// runJevFailureClassification — normalization
// ==========================================================================

const failureEvidence = buildJevFailureEvidence({
  deploymentStage: 'INSTALL',
  stackStatus: 'ROLLBACK_COMPLETE',
  failureReason: 'Service task failed: exited with code 1',
  recentEvents: [
    {
      resourceType: 'AWS::ECS::Service',
      logicalResourceId: 'Service',
      resourceStatus: 'CREATE_FAILED',
      resourceStatusReason: 'Resource creation cancelled',
      eventAt: '2026-09-20T01:01:00Z',
    },
  ],
  healthStatus: 'unhealthy',
  elapsedMs: 45_000,
  retryCount: 0,
  deployzFailureCode: 'UNKNOWN',
});

const baseDomainProbabilities = {
  APPLICATION: 0.1,
  CUSTOMER_CONFIGURATION: 0.6,
  AWS: 0.1,
  DEPLOYZ: 0.05,
  DEPENDENCY: 0.05,
  REGISTRY: 0.05,
  NETWORK: 0.03,
  UNKNOWN: 0.02,
};

const baseAnswers: FixtureJevResponse['answers'] = {
  failureDomain: {
    type: 'choice',
    choice: 'CUSTOMER_CONFIGURATION',
    probabilities: baseDomainProbabilities,
    confidence: 0.72,
  },
  likelyTransient: { type: 'noul', noul: 0.8 },
  recommendedAction: {
    type: 'choice',
    choice: 'customer',
    probabilities: { customer: 0.8, none: 0.1, vendor: 0.05, deployz: 0.05 },
    confidence: 0.8,
  },
};

function clientWith(overrides?: Partial<FixtureJevResponse>): ReturnType<typeof createFixtureJevClient> {
  return createFixtureJevClient({
    'failure-shadow': { answers: baseAnswers, ...overrides },
  });
}

describe('runJevFailureClassification — normalization', () => {
  it('takes the argmax domain and plumbs probabilities and confidence', async () => {
    const result = await runJevFailureClassification(clientWith(), { failureEvidence });

    expect(result.failureDomain).toBe('CUSTOMER_CONFIGURATION');
    expect(result.domainProbabilities).toEqual({
      APPLICATION: 0.1,
      CUSTOMER_CONFIGURATION: 0.6,
      AWS: 0.1,
      DEPLOYZ: 0.05,
      DEPENDENCY: 0.05,
      REGISTRY: 0.05,
      NETWORK: 0.03,
      UNKNOWN: 0.02,
    });
    expect(result.domainConfidence).toBe(0.72);
  });

  it('fills absent domain options with 0 and still argmaxes over them', async () => {
    const result = await runJevFailureClassification(
      clientWith({
        answers: {
          ...baseAnswers,
          failureDomain: {
            type: 'choice',
            choice: 'APPLICATION',
            probabilities: { APPLICATION: 0.1, AWS: 0.9 },
            confidence: 0.6,
          },
        },
      }),
      { failureEvidence },
    );

    // The probabilities decide, not the picked option.
    expect(result.failureDomain).toBe('AWS');
    expect(result.domainProbabilities.DEPLOYZ).toBe(0);
    expect(result.domainProbabilities.UNKNOWN).toBe(0);
  });

  it('applies the 0.5 transient threshold on both sides', async () => {
    const atThreshold = await runJevFailureClassification(
      clientWith({ answers: { ...baseAnswers, likelyTransient: { type: 'noul', noul: 0.5 } } }),
      { failureEvidence },
    );
    const below = await runJevFailureClassification(
      clientWith({ answers: { ...baseAnswers, likelyTransient: { type: 'noul', noul: 0.49 } } }),
      { failureEvidence },
    );

    expect(atThreshold.likelyTransient).toBe(true);
    expect(atThreshold.likelyTransientProbability).toBe(0.5);
    expect(below.likelyTransient).toBe(false);
    expect(below.likelyTransientProbability).toBe(0.49);
  });

  it('plumbs the recommended action and its confidence', async () => {
    const result = await runJevFailureClassification(
      clientWith({
        answers: {
          ...baseAnswers,
          recommendedAction: {
            type: 'choice',
            choice: 'vendor',
            probabilities: { vendor: 0.9, none: 0.05, customer: 0.03, deployz: 0.02 },
            confidence: 0.9,
          },
        },
      }),
      { failureEvidence },
    );

    expect(result.recommendedAction).toBe('vendor');
    expect(result.actionConfidence).toBe(0.9);
  });

  it('marks UNKNOWN argmax as unclear', async () => {
    const result = await runJevFailureClassification(
      clientWith({
        answers: {
          ...baseAnswers,
          failureDomain: {
            type: 'choice',
            choice: 'UNKNOWN',
            probabilities: { UNKNOWN: 0.6, APPLICATION: 0.2, AWS: 0.2 },
            confidence: 0.6,
          },
        },
      }),
      { failureEvidence },
    );

    expect(result.failureDomain).toBe('UNKNOWN');
    expect(result.classificationUnclear).toBe(true);
  });

  it('marks low domain confidence as unclear', async () => {
    const result = await runJevFailureClassification(
      clientWith({
        answers: {
          ...baseAnswers,
          failureDomain: {
            type: 'choice',
            choice: 'CUSTOMER_CONFIGURATION',
            probabilities: baseDomainProbabilities,
            confidence: 0.3,
          },
        },
      }),
      { failureEvidence },
    );

    expect(result.failureDomain).toBe('CUSTOMER_CONFIGURATION');
    expect(result.classificationUnclear).toBe(true);
  });

  it('is not unclear on a confident non-UNKNOWN classification', async () => {
    const result = await runJevFailureClassification(clientWith(), { failureEvidence });

    expect(result.classificationUnclear).toBe(false);
  });
});

// ==========================================================================
// Request shape, metadata, errors
// ==========================================================================

describe('runJevFailureClassification — request and result metadata', () => {
  it('sends only the failure evidence as the state', async () => {
    const client = clientWith();

    await runJevFailureClassification(client, { failureEvidence });

    const request = client.lastRequest();
    expect(request?.label).toBe('failure-shadow');
    expect(Object.keys(request?.state ?? {})).toEqual(['failureEvidence']);
    expect(request?.state).toEqual({ failureEvidence });
    expect(request?.questions).toEqual(buildFailureQuestions());
  });

  it('returns latency, model, usage, and both schema versions', async () => {
    const result = await runJevFailureClassification(
      clientWith({ model: 'jev-1.13.0', usage: { input_tokens: 21, output_tokens: 7 } }),
      { failureEvidence },
    );

    expect(result.model).toBe('jev-1.13.0');
    expect(result.usage).toEqual({ inputTokens: 21, outputTokens: 7 });
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(result.evidenceSchemaVersion).toBe(1);
    expect(result.decisionSetVersion).toBe(JEV_FAILURE_DECISION_SET_VERSION);
    expect(JEV_FAILURE_DECISION_SET_VERSION).toBe(1);
  });
});

describe('runJevFailureClassification — errors', () => {
  it('treats a missing answer as malformed', async () => {
    const withoutTransient: FixtureJevResponse['answers'] = { ...baseAnswers };
    delete withoutTransient.likelyTransient;
    const client = clientWith({ answers: withoutTransient });

    await expect(runJevFailureClassification(client, { failureEvidence })).rejects.toMatchObject({
      kind: 'malformed',
    });
  });

  it('treats a wrong-variant answer as malformed', async () => {
    const client = clientWith({
      answers: {
        ...baseAnswers,
        failureDomain: { type: 'noul', noul: 0.7 },
      },
    });

    await expect(runJevFailureClassification(client, { failureEvidence })).rejects.toMatchObject({
      kind: 'malformed',
    });
  });

  it('treats a recommended action outside the option set as malformed', async () => {
    const client = clientWith({
      answers: {
        ...baseAnswers,
        recommendedAction: {
          type: 'choice',
          choice: 'someone',
          probabilities: { someone: 1 },
          confidence: 0.5,
        },
      },
    });

    await expect(runJevFailureClassification(client, { failureEvidence })).rejects.toMatchObject({
      kind: 'malformed',
    });
  });

  it('propagates a client JevError untouched', async () => {
    const thrown = new JevError('timeout', { attempts: 1 });
    const client: JevClient = {
      evaluate: () => Promise.reject(thrown),
    };

    await expect(runJevFailureClassification(client, { failureEvidence })).rejects.toBe(thrown);
  });
});
