import { describe, expect, it } from 'vitest';

import {
  ONBOARDING_STEPS,
  VERDICT_PRESENTATION,
  deriveOnboardingStep,
  fixtureReadiness,
} from '../src/lib/readiness';

// Locks the §42 onboarding vocabulary and the §19 readiness presentation:
// the six steps are verbatim and in order, every verdict label is §65
// jargon-free, and the fixture fallback renders each verdict state without a
// backend (the readiness endpoint arrives in a later todo).

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

describe('fixtureReadiness fallback (no backend yet)', () => {
  it('fixture repo 2 is NOT_COMPATIBLE with the Redis rejection', () => {
    const fixture = fixtureReadiness('fixture-repo-2');
    expect(fixture.readiness?.verdict).toBe('NOT_COMPATIBLE');
    expect(fixture.readiness?.issues.some((issue) => issue.code === 'REDIS_DEPENDENCY')).toBe(
      true,
    );
  });

  it('the attention fixture lists the specific attention items', () => {
    const fixture = fixtureReadiness('fixture-repo-attention');
    expect(fixture.readiness?.verdict).toBe('NEEDS_ATTENTION');
    expect(fixture.readiness?.issues.map((issue) => issue.code)).toEqual([
      'MISSING_DOCKERFILE',
      'MISSING_HEALTH_ENDPOINT',
    ]);
  });

  it('unknown ids fall back to READY — success is readiness', () => {
    const fixture = fixtureReadiness('fixture-repo-1');
    expect(fixture.readiness?.verdict).toBe('READY');
    expect(fixture.readiness?.issues).toEqual([]);
  });

  it('fixture copy is jargon-free (§65)', () => {
    for (const id of ['fixture-repo-1', 'fixture-repo-2', 'fixture-repo-attention'] as const) {
      const fixture = fixtureReadiness(id);
      const text = [
        fixture.readiness?.reason ?? '',
        ...(fixture.readiness?.issues ?? []).map((issue) => issue.message),
        fixture.explanation?.summary ?? '',
        fixture.explanation?.why ?? '',
        fixture.explanation?.fix ?? '',
      ].join(' ');
      expect(text, `fixture ${id}`).not.toMatch(JARGON);
    }
  });
});
