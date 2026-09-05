import { describe, expect, it } from 'vitest';

import { buildEnvPlan, envPlanSummary } from '../src/lib/env-plan';
import type { DetectedApplication } from '../src/lib/readiness';

// AI MVP Phase 4 — the environment plan: what Deployz configures on its own
// and what the vendor must provide, derived from the classified env-var
// model and the keys already saved for one scope. Plain words, never a value.

const JARGON = /\b(CloudFormation|IAM|ECS|ALB|Lambda|VPC|CFN|Secrets Manager)\b/i;

type Variable = DetectedApplication['environmentVariables'][number];

function variable(key: string, overrides: Partial<Variable> = {}): Variable {
  return { key, required: true, secret: false, source: ['read in src/index.ts'], ...overrides };
}

const variables: Variable[] = [
  variable('DATABASE_URL', { classification: 'deployz_managed' }),
  variable('SESSION_SECRET', { secret: true, classification: 'deployz_generated' }),
  variable('STRIPE_SECRET_KEY', { secret: true, classification: 'customer_required' }),
  variable('LICENSE_KEY', { secret: true, classification: 'customer_required' }),
  variable('LOG_LEVEL', { required: false, classification: 'optional' }),
  variable('UNUSED_FLAG', { required: false, classification: 'unknown' }),
];

describe('buildEnvPlan', () => {
  it('splits the variables into automatic, required (missing first) and optional', () => {
    const plan = buildEnvPlan(variables, ['STRIPE_SECRET_KEY']);
    expect(plan.automatic.map((r) => r.key)).toEqual(['DATABASE_URL', 'SESSION_SECRET']);
    expect(plan.required.map((r) => [r.key, r.provided])).toEqual([
      ['LICENSE_KEY', false],
      ['STRIPE_SECRET_KEY', true],
    ]);
    expect(plan.optional.map((r) => r.key)).toEqual(['LOG_LEVEL', 'UNUSED_FLAG']);
    for (const row of [...plan.automatic, ...plan.required, ...plan.optional]) {
      expect(row.reason).not.toMatch(JARGON);
    }
  });

  it('falls back on required/optional for a model analysed before classification existed', () => {
    const plan = buildEnvPlan([variable('API_TOKEN', { secret: true }), variable('DEBUG', { required: false })], []);
    expect(plan.automatic).toEqual([]);
    expect(plan.required.map((r) => r.key)).toEqual(['API_TOKEN']);
    expect(plan.optional.map((r) => r.key)).toEqual(['DEBUG']);
  });
});

describe('envPlanSummary', () => {
  it('counts provided required values and says when nothing is needed', () => {
    expect(envPlanSummary(buildEnvPlan(variables, []))).toBe('0 of 2 required values provided.');
    expect(envPlanSummary(buildEnvPlan(variables, ['STRIPE_SECRET_KEY', 'LICENSE_KEY']))).toBe('All required values provided.');
    expect(envPlanSummary(buildEnvPlan(variables.slice(0, 2), []))).toBe(
      'Nothing for you to provide — Deployz configures every variable.',
    );
  });
});
