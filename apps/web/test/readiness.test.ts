import { describe, expect, it } from 'vitest';

import {
  ONBOARDING_STEPS,
  READINESS_STATE_PRESENTATION,
  READINESS_SUPPORT_READY,
  FIX_INSTRUCTIONS_REUSED_NOTE,
  deriveOnboardingStep,
  detectedFactRows,
  fixInstructionsGeneratedLabel,
  readinessBlockedSummary,
  readinessChangesHeading,
  readinessChecksLabel,
  readinessFailure,
  readinessFixCtaSupport,
  readinessStateHeading,
  type ApplicationReadiness,
  type DetectedApplication,
  type DetectedFact,
  type FactSource,
} from '../src/lib/readiness';

// Locks the §42 onboarding vocabulary and the §19 readiness presentation:
// the six steps are verbatim and in order, every readiness state's
// presentation is §65 jargon-free and never a percentage, and the
// ApplicationReadiness shape renders correctly for each real (non-fixture)
// state returned by GET /api/applications/:id/readiness.

const JARGON = /\b(CloudFormation|IAM|ECS|ALB|Lambda|VPC|CFN)\b/i;
const PERCENT = /%/;

describe('§42 onboarding steps', () => {
  it('is exactly the six steps, verbatim and in order', () => {
    expect(ONBOARDING_STEPS).toEqual([
      'Connect GitHub',
      'Choose repository',
      'Analyse',
      'Fix compatibility issues',
      'Create test deployment',
      'Ready for customer deployment',
    ]);
  });
});

describe('§19 readiness state presentation', () => {
  it('READY uses the §42 success wording', () => {
    expect(readinessStateHeading('READY', 0)).toBe('Ready to deploy');
    expect(READINESS_STATE_PRESENTATION.READY.tone).toBe('ready');
  });

  it('assigns the correct tone per state', () => {
    expect(READINESS_STATE_PRESENTATION.READY.tone).toBe('ready');
    expect(READINESS_STATE_PRESENTATION.ALMOST_READY.tone).toBe('attention');
    expect(READINESS_STATE_PRESENTATION.NEEDS_CHANGES.tone).toBe('incompatible');
    expect(READINESS_STATE_PRESENTATION.ANALYSIS_INCOMPLETE.tone).toBe('pending');
  });

  it('never says "Almost ready" while deployment is blocked', () => {
    expect(READINESS_STATE_PRESENTATION.ALMOST_READY.label).toBe('Action needed');
    expect(READINESS_STATE_PRESENTATION.NEEDS_CHANGES.label).toBe('Changes needed');
    expect(readinessStateHeading('ALMOST_READY', 1)).not.toMatch(/almost/i);
    expect(readinessStateHeading('NEEDS_CHANGES', 2)).not.toMatch(/almost/i);
  });

  it('every presentation label and heading is jargon-free and never a percentage (§65)', () => {
    for (const presentation of Object.values(READINESS_STATE_PRESENTATION)) {
      expect(presentation.label).not.toMatch(JARGON);
      expect(presentation.label).not.toMatch(PERCENT);
    }
    for (const state of ['READY', 'ALMOST_READY', 'NEEDS_CHANGES', 'ANALYSIS_INCOMPLETE'] as const) {
      expect(readinessStateHeading(state, 2)).not.toMatch(JARGON);
      expect(readinessStateHeading(state, 2)).not.toMatch(PERCENT);
    }
  });
});

describe('readinessChangesHeading', () => {
  it('formats the exact blocked-state heading with a count', () => {
    expect(readinessChangesHeading(2)).toBe('2 changes needed before deployment');
  });

  it('singularizes for exactly one change', () => {
    expect(readinessChangesHeading(1)).toBe('1 change needed before deployment');
  });

  it('never contains a percentage sign', () => {
    expect(readinessChangesHeading(3)).not.toMatch(PERCENT);
  });
});

describe('readinessChecksLabel', () => {
  it('formats the exact example: "4 of 6 checks passed"', () => {
    expect(readinessChecksLabel(4, 6)).toBe('4 of 6 checks passed');
  });

  it('reports the full count when everything passed', () => {
    expect(readinessChecksLabel(6, 6)).toBe('6 of 6 checks passed');
  });

  it('is a check count, never a percentage', () => {
    expect(readinessChecksLabel(1, 3)).not.toMatch(PERCENT);
    expect(readinessChecksLabel(0, 3)).not.toMatch(PERCENT);
  });
});

describe('readinessBlockedSummary', () => {
  it('states what passed and what to do next', () => {
    expect(readinessBlockedSummary(4, 6, 2)).toBe(
      'Your application passed 4 of 6 deployment checks. Fix the items below before deploying.',
    );
  });

  it('singularizes for exactly one blocking item', () => {
    expect(readinessBlockedSummary(5, 6, 1)).toBe(
      'Your application passed 5 of 6 deployment checks. Fix the item below before deploying.',
    );
  });

  it('never contains a percentage sign', () => {
    expect(readinessBlockedSummary(0, 3, 3)).not.toMatch(PERCENT);
  });
});

describe('readinessFixCtaSupport', () => {
  it('interpolates the issue count', () => {
    expect(readinessFixCtaSupport(2)).toBe(
      'Creates one prompt to fix these 2 issues with your coding agent.',
    );
  });

  it('uses the singular phrasing for exactly one issue', () => {
    expect(readinessFixCtaSupport(1)).toBe(
      'Creates one prompt to fix this 1 issue with your coding agent.',
    );
  });
});

describe('READY supporting copy', () => {
  it('tells the vendor every required check passed', () => {
    expect(READINESS_SUPPORT_READY).toBe(
      'Your application passed all required deployment checks.',
    );
  });
});

describe('deriveOnboardingStep', () => {
  it('is analysing (step 3) until analysis completes', () => {
    expect(
      deriveOnboardingStep({
        analysisStatus: 'ANALYZING',
        state: 'ANALYSIS_INCOMPLETE',
        testDeploymentCreated: false,
      }),
    ).toBe(3);
  });

  it('is analysing (step 3) when analysis failed', () => {
    expect(
      deriveOnboardingStep({
        analysisStatus: 'FAILED',
        state: 'ANALYSIS_INCOMPLETE',
        testDeploymentCreated: false,
      }),
    ).toBe(3);
  });

  it('sends non-ready complete states to fix compatibility issues (step 4)', () => {
    expect(
      deriveOnboardingStep({
        analysisStatus: 'COMPLETE',
        state: 'ALMOST_READY',
        testDeploymentCreated: false,
      }),
    ).toBe(4);
    expect(
      deriveOnboardingStep({
        analysisStatus: 'COMPLETE',
        state: 'NEEDS_CHANGES',
        testDeploymentCreated: false,
      }),
    ).toBe(4);
  });

  it('sends READY to create test deployment (step 5)', () => {
    expect(
      deriveOnboardingStep({
        analysisStatus: 'COMPLETE',
        state: 'READY',
        testDeploymentCreated: false,
      }),
    ).toBe(5);
  });

  it('marks the flow complete once the test deployment exists (step 6)', () => {
    expect(
      deriveOnboardingStep({
        analysisStatus: 'COMPLETE',
        state: 'READY',
        testDeploymentCreated: true,
      }),
    ).toBe(6);
  });
});

describe('§19 ApplicationReadiness shape (GET /api/applications/:id/readiness)', () => {
  it('a pending (non-COMPLETE) analysis carries ANALYSIS_INCOMPLETE and empty lists', () => {
    const pending: ApplicationReadiness = {
      analysisStatus: 'ANALYZING',
      state: 'ANALYSIS_INCOMPLETE',
      requiredCount: 0,
      recommendedCount: 0,
      summary: null,
      failureReason: null,
      findings: [],
      passed: [],
      analyzedCommitSha: null,
      detected: null,
    };
    expect(pending.state).toBe('ANALYSIS_INCOMPLETE');
    expect(pending.findings).toEqual([]);
    expect(pending.passed).toEqual([]);
  });

  it('a FAILED analysis carries ANALYSIS_INCOMPLETE and a failureReason', () => {
    const failed: ApplicationReadiness = {
      analysisStatus: 'FAILED',
      state: 'ANALYSIS_INCOMPLETE',
      requiredCount: 0,
      recommendedCount: 0,
      summary: null,
      failureReason: 'Failed to mint a GitHub installation token',
      findings: [],
      passed: [],
      analyzedCommitSha: null,
      detected: null,
    };
    expect(failed.state).toBe('ANALYSIS_INCOMPLETE');
    expect(failed.failureReason).toBe('Failed to mint a GitHub installation token');
  });

  it('an ALMOST_READY result splits findings into required and recommended', () => {
    const readiness: ApplicationReadiness = {
      analysisStatus: 'COMPLETE',
      state: 'ALMOST_READY',
      requiredCount: 1,
      recommendedCount: 1,
      summary: 'One required change and one recommendation.',
      failureReason: null,
      findings: [
        {
          id: 'health-endpoint',
          category: 'health',
          title: 'Health endpoint missing',
          severity: 'required',
          blocking: true,
          plainEnglishExplanation: 'Deployz requires an HTTP health endpoint.',
          whyItMatters: 'Without it, Deployz cannot tell if your app is running.',
          technicalEvidence: 'No route responded on /health.',
          suggestedOutcome: 'Add a GET /health route that returns HTTP 200.',
          confidence: 'confirmed',
        },
        {
          id: 'logging',
          category: 'observability',
          title: 'Structured logging recommended',
          severity: 'recommended',
          blocking: false,
          plainEnglishExplanation: 'Logs are not structured as JSON.',
          whyItMatters: 'Structured logs are easier to search.',
          technicalEvidence: 'Log lines are plain text.',
          suggestedOutcome: 'Emit logs as JSON.',
          confidence: 'likely',
        },
      ],
      passed: [{ id: 'docker', label: 'Docker container detected' }],
      analyzedCommitSha: 'abc1234',
      detected: null,
    };
    const required = readiness.findings.filter((f) => f.severity === 'required');
    const recommended = readiness.findings.filter((f) => f.severity === 'recommended');
    expect(required).toHaveLength(1);
    expect(recommended).toHaveLength(1);
    expect(required[0]).toMatchObject({
      title: 'Health endpoint missing',
      blocking: true,
    });
    expect(recommended[0]).toMatchObject({
      title: 'Structured logging recommended',
      blocking: false,
    });
    const text = [
      readiness.passed[0]?.label ?? '',
      required[0]?.title ?? '',
      required[0]?.plainEnglishExplanation ?? '',
      required[0]?.suggestedOutcome ?? '',
    ].join(' ');
    expect(text).not.toMatch(JARGON);
  });

  it('a NEEDS_CHANGES result carries only required findings for the incompatibility', () => {
    const readiness: ApplicationReadiness = {
      analysisStatus: 'COMPLETE',
      state: 'NEEDS_CHANGES',
      requiredCount: 1,
      recommendedCount: 0,
      summary: 'One required change.',
      failureReason: null,
      findings: [
        {
          id: 'persistent-redis',
          category: 'architecture',
          title: 'Persistent Redis required',
          severity: 'required',
          blocking: true,
          plainEnglishExplanation: 'Persistent Redis is required.',
          whyItMatters: 'Session data would be lost without it.',
          technicalEvidence: 'No Redis connection string found.',
          suggestedOutcome: 'Configure a persistent Redis instance.',
          confidence: 'confirmed',
        },
      ],
      passed: [],
      analyzedCommitSha: 'def5678',
      detected: null,
    };
    expect(readiness.findings[0]?.plainEnglishExplanation).toBe('Persistent Redis is required.');
  });
});

// A FAILED analysis rendered as "Analysing your app — this usually takes a
// minute" and polling stopped, so Re-analyse looked like it did nothing at
// all. FAILED is its own state, and it says what went wrong.
describe('readinessFailure (FAILED analysis)', () => {
  const failed = (failureReason: string | null): ApplicationReadiness => ({
    analysisStatus: 'FAILED',
    state: 'ANALYSIS_INCOMPLETE',
    requiredCount: 0,
    recommendedCount: 0,
    summary: null,
    failureReason,
    findings: [],
    passed: [],
    analyzedCommitSha: null,
    detected: null,
  });

  it('is null while the analysis is still running', () => {
    expect(
      readinessFailure({
        analysisStatus: 'ANALYZING',
        state: 'ANALYSIS_INCOMPLETE',
        requiredCount: 0,
        recommendedCount: 0,
        summary: null,
        failureReason: null,
        findings: [],
        passed: [],
        analyzedCommitSha: null,
        detected: null,
      }),
    ).toBeNull();
  });

  it('surfaces the reason the analysis failed', () => {
    expect(readinessFailure(failed('Failed to mint a GitHub installation token'))?.detail).toBe(
      'Failed to mint a GitHub installation token',
    );
  });

  it('uses the deployment-readiness failure heading', () => {
    expect(readinessFailure(failed(null))?.heading).toBe(
      "We couldn't check deployment readiness",
    );
  });

  it('falls back to jargon-free copy when the API sent no reason', () => {
    const failure = readinessFailure(failed(null));
    expect(failure?.detail).toBeTruthy();
    expect(failure?.detail).not.toMatch(JARGON);
    expect(failure?.heading).not.toMatch(JARGON);
  });
});


// ── What Deployz detected (AI MVP Phase 2) ──────────────────────────────────

function detectedFixture(overrides: Partial<DetectedApplication> = {}): DetectedApplication {
  const fact = <T,>(value: T, source: FactSource = 'dockerfile'): DetectedFact<T> => ({
    value,
    source,
    confidence: source === 'source' || source === 'ai' ? 'likely' : 'confirmed',
    evidence: source === 'none' ? [] : [{ file: 'Dockerfile', reason: `Found in ${source}` }],
  });
  return {
    analysisVersion: 13,
    runtime: fact('node'),
    framework: fact('express', 'package-manifest'),
    build: fact('tsc', 'package-manifest'),
    start: fact('node dist/index.js'),
    network: { port: fact(3000), bindAddress: fact(null, 'none') },
    database: { required: true, type: 'postgres', confidence: 'confirmed', evidence: [{ reason: 'pg dependency' }] },
    redis: { required: false, detected: false, supported: true, confidence: 'needs_confirmation', purposes: [], evidence: [] },
    storage: { persistentLocalRequired: false, objectStorageDetected: false, evidence: [] },
    healthCheck: { detected: true, path: '/health', confidence: 'confirmed', evidence: [{ reason: 'route' }] },
    migrations: { detected: true, command: 'npx drizzle-kit push', tools: ['drizzle-kit'], evidence: [{ reason: 'script' }] },
    environmentVariables: [],
    ...overrides,
  };
}

describe('detectedFactRows', () => {
  it('renders every fact as a plain-words row in reading order, with the source as a hint', () => {
    const rows = detectedFactRows(detectedFixture());
    expect(rows.map((r) => r.id)).toEqual([
      'runtime', 'framework', 'start', 'build', 'port', 'database', 'redis', 'storage', 'health', 'migrations',
    ]);
    expect(rows.find((r) => r.id === 'runtime')).toMatchObject({ value: 'Node.js', found: true, hint: 'From the container setup', code: false });
    expect(rows.find((r) => r.id === 'start')).toMatchObject({ value: 'node dist/index.js', code: true });
    expect(rows.find((r) => r.id === 'port')).toMatchObject({ value: '3000', code: true, hint: 'From the container setup' });
    expect(rows.find((r) => r.id === 'database')?.value).toBe('PostgreSQL — Deployz provides a managed database');
    expect(rows.find((r) => r.id === 'health')).toMatchObject({ value: '/health', code: true });
    expect(rows.find((r) => r.id === 'migrations')).toMatchObject({ value: 'npx drizzle-kit push', code: true });
    for (const row of rows) {
      expect(row.value).not.toMatch(JARGON);
      expect(row.value).not.toMatch(PERCENT);
    }
  });

  it('renders missing values quietly and never as failures', () => {
    const rows = detectedFactRows(
      detectedFixture({
        runtime: { value: 'unknown', source: 'none', confidence: 'needs_confirmation', evidence: [] },
        framework: { value: null, source: 'none', confidence: 'needs_confirmation', evidence: [] },
        start: { value: null, source: 'none', confidence: 'needs_confirmation', evidence: [] },
        healthCheck: { detected: false, path: null, confidence: 'confirmed', evidence: [] },
        migrations: { detected: false, command: null, tools: [], evidence: [] },
        database: { required: false, type: 'none', confidence: 'confirmed', evidence: [] },
      }),
    );
    expect(rows.find((r) => r.id === 'runtime')).toMatchObject({ value: 'Not detected', found: false, hint: null });
    expect(rows.find((r) => r.id === 'framework')).toMatchObject({ value: 'None detected', found: false });
    expect(rows.find((r) => r.id === 'start')).toMatchObject({ value: 'Not found', found: false, code: false });
    expect(rows.find((r) => r.id === 'health')).toMatchObject({ value: 'Not found', found: false });
    expect(rows.find((r) => r.id === 'migrations')).toMatchObject({ value: 'None detected', found: false });
    expect(rows.find((r) => r.id === 'database')).toMatchObject({ value: 'None detected', found: false });
  });

  it('marks AI-inferred and likely values so the vendor knows to verify them', () => {
    const rows = detectedFactRows(
      detectedFixture({
        start: { value: 'node server.js', source: 'ai', confidence: 'likely', evidence: [{ reason: 'Resolved by AI analysis' }] },
        network: {
          port: { value: 8080, source: 'source', confidence: 'likely', evidence: [{ reason: 'Default port 8080 detected in src/index.ts' }] },
          bindAddress: { value: 'localhost', source: 'source', confidence: 'likely', evidence: [] },
        },
        redis: { required: true, detected: true, supported: true, confidence: 'confirmed', purposes: ['queue'], evidence: [{ reason: 'bullmq' }] },
        storage: { persistentLocalRequired: false, objectStorageDetected: true, evidence: [{ reason: '@aws-sdk/client-s3' }] },
      }),
    );
    expect(rows.find((r) => r.id === 'start')?.hint).toBe('Inferred by AI analysis — verify before relying on it');
    expect(rows.find((r) => r.id === 'port')?.hint).toBe('Inferred from the source code · Likely');
    expect(rows.find((r) => r.id === 'redis')?.value).toBe('Redis — provisioned automatically (queue)');
    expect(rows.find((r) => r.id === 'storage')?.value).toBe('Object storage — Deployz provides a bucket');
  });
});

describe('fixInstructionsGeneratedLabel', () => {
  it('names when the document was generated, and degrades for an unparseable date', () => {
    expect(fixInstructionsGeneratedLabel('2026-09-05T10:00:00.000Z')).toMatch(/^Generated .*2026/);
    expect(fixInstructionsGeneratedLabel('not a date')).toBe('Generated for this analysis');
    expect(FIX_INSTRUCTIONS_REUSED_NOTE).not.toMatch(JARGON);
  });
});
