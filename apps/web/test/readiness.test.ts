import { describe, expect, it } from 'vitest';

import {
  ONBOARDING_STEPS,
  VERDICT_PRESENTATION,
  deriveOnboardingStep,
  readinessSummaryLabel,
  type ApplicationReadiness,
} from '../src/lib/readiness';

// Locks the §42 onboarding vocabulary and the §19 readiness presentation:
// the six steps are verbatim and in order, every verdict label is §65
// jargon-free, and the §19 summary line + result shape render correctly for
// each real (non-fixture) verdict state returned by
// GET /api/applications/:id/readiness.

const JARGON = /\b(CloudFormation|IAM|ECS|ALB|Lambda|VPC|CFN)\b/i;

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

describe('§19 verdict presentation', () => {
  it('READY uses the §42 success wording', () => {
    expect(VERDICT_PRESENTATION.READY.heading).toBe('Your app is ready to deploy.');
    expect(VERDICT_PRESENTATION.READY.tone).toBe('ready');
  });

  it('every presentation heading and label is jargon-free (§65)', () => {
    for (const presentation of Object.values(VERDICT_PRESENTATION)) {
      expect(presentation.heading).not.toMatch(JARGON);
      expect(presentation.label).not.toMatch(JARGON);
    }
  });
});

describe('deriveOnboardingStep', () => {
  it('is analysing (step 3) until analysis completes', () => {
    expect(
      deriveOnboardingStep({
        analysisStatus: 'ANALYZING',
        verdict: null,
        testDeploymentCreated: false,
      }),
    ).toBe(3);
  });

  it('sends non-ready verdicts to fix compatibility issues (step 4)', () => {
    expect(
      deriveOnboardingStep({
        analysisStatus: 'COMPLETE',
        verdict: 'NEEDS_ATTENTION',
        testDeploymentCreated: false,
      }),
    ).toBe(4);
    expect(
      deriveOnboardingStep({
        analysisStatus: 'COMPLETE',
        verdict: 'NOT_COMPATIBLE',
        testDeploymentCreated: false,
      }),
    ).toBe(4);
  });

  it('sends READY to create test deployment (step 5)', () => {
    expect(
      deriveOnboardingStep({
        analysisStatus: 'COMPLETE',
        verdict: 'READY',
        testDeploymentCreated: false,
      }),
    ).toBe(5);
  });

  it('marks the flow complete once the test deployment exists (step 6)', () => {
    expect(
      deriveOnboardingStep({
        analysisStatus: 'COMPLETE',
        verdict: 'READY',
        testDeploymentCreated: true,
      }),
    ).toBe(6);
  });
});

describe('readinessSummaryLabel (§19 "82% — 2 changes required")', () => {
  it('formats the exact §19 example', () => {
    expect(readinessSummaryLabel(82, 2)).toBe('82% — 2 changes required');
  });

  it('singularizes "change" for exactly one', () => {
    expect(readinessSummaryLabel(90, 1)).toBe('90% — 1 change required');
  });

  it('handles zero changes required', () => {
    expect(readinessSummaryLabel(100, 0)).toBe('100% — 0 changes required');
  });
});

describe('§19 readiness result shape (GET /api/applications/:id/readiness)', () => {
  it('a pending (non-COMPLETE) analysis carries null verdict/score and empty groups', () => {
    const pending: ApplicationReadiness = {
      analysisStatus: 'ANALYZING',
      verdict: null,
      score: null,
      changesRequired: null,
      ready: [],
      needsAttention: [],
      unsupported: [],
    };
    expect(pending.verdict).toBeNull();
    expect(pending.score).toBeNull();
    expect(pending.ready).toEqual([]);
  });

  it('a NEEDS_ATTENTION result carries per-issue title/detail/suggestedFix', () => {
    const readiness: ApplicationReadiness = {
      analysisStatus: 'COMPLETE',
      verdict: 'NEEDS_ATTENTION',
      score: 82,
      changesRequired: 2,
      ready: [{ label: 'Docker container detected' }],
      needsAttention: [
        {
          title: 'Health endpoint missing',
          detail: 'Deployz requires an HTTP health endpoint.',
          suggestedFix: 'GET /health → HTTP 200',
        },
      ],
      unsupported: [],
    };
    expect(readiness.needsAttention[0]).toMatchObject({
      title: 'Health endpoint missing',
      suggestedFix: 'GET /health → HTTP 200',
    });
    const text = [
      readiness.ready[0]?.label ?? '',
      readiness.needsAttention[0]?.title ?? '',
      readiness.needsAttention[0]?.detail ?? '',
      readiness.needsAttention[0]?.suggestedFix ?? '',
    ].join(' ');
    expect(text).not.toMatch(JARGON);
  });

  it('a NOT_COMPATIBLE result carries title/reason pairs, not a single message', () => {
    const readiness: ApplicationReadiness = {
      analysisStatus: 'COMPLETE',
      verdict: 'NOT_COMPATIBLE',
      score: 0,
      changesRequired: 0,
      ready: [],
      needsAttention: [],
      unsupported: [{ title: 'Persistent Redis required', reason: 'Persistent Redis is required.' }],
    };
    expect(readiness.unsupported[0]?.reason).toBe('Persistent Redis is required.');
  });
});
