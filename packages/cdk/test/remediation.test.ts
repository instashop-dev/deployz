import { describe, expect, it } from 'vitest';

import {
  getRemediation,
  type Remediation,
} from '../src/analysis/remediation.js';
import {
  FAILURE_CODES,
  type FailureCode,
  type StructuredEvent,
} from '../src/analysis/failure-classifier.js';

// ==========================================================================
// Type-system invariants
// ==========================================================================

describe('Remediation type invariants', () => {
  it('automatic is the literal false type (never true)', () => {
    // Compile-time check: the type system must reject `true` for `automatic`.
    const r: Remediation = {
      code: 'UNKNOWN',
      summary: 'test',
      steps: ['step 1'],
      requiresManual: true,
      automatic: false,
    };
    expect(r.automatic).toBe(false);
  });

  it('getRemediation returns a Remediation (not a promise)', () => {
    const result = getRemediation('UNKNOWN');
    expect(result).not.toBeInstanceOf(Promise);
  });
});

// ==========================================================================
// §61 taxonomy parity with @deployz/db
// ==========================================================================

describe('§61 failure taxonomy parity', () => {
  it('getRemediation handles every FAILURE_CODES entry', () => {
    for (const code of FAILURE_CODES) {
      const result = getRemediation(code);
      expect(result.code).toBe(code);
    }
  });
});

// ==========================================================================
// Remediation table — every §61 code
// ==========================================================================

describe('getRemediation — AWS_SCP_BLOCKED', () => {
  it('returns the correct fixed guidance', () => {
    const result = getRemediation('AWS_SCP_BLOCKED');
    expect(result.code).toBe('AWS_SCP_BLOCKED');
    expect(result.summary).toBe(
      'Your cloud account has a policy that prevents this action.',
    );
    expect(result.steps).toEqual([
      'Check service control policies in your account.',
      'Remove or modify the policy blocking the required action.',
      'Contact your cloud administrator.',
    ]);
    expect(result.requiresManual).toBe(true);
    expect(result.automatic).toBe(false);
  });
});

describe('getRemediation — PORT_MISMATCH', () => {
  it('returns the correct fixed guidance', () => {
    const result = getRemediation('PORT_MISMATCH');
    expect(result.code).toBe('PORT_MISMATCH');
    expect(result.summary).toBe(
      "Your app listens on a different port than what's set up.",
    );
    expect(result.steps).toEqual([
      'Check what port your app actually listens on (from the PORT env var or app code).',
      'Update the deployment configuration to match.',
    ]);
    expect(result.requiresManual).toBe(true);
    expect(result.automatic).toBe(false);
  });
});

describe('getRemediation — REGION_NOT_SUPPORTED', () => {
  it('returns the correct fixed guidance with region list', () => {
    const result = getRemediation('REGION_NOT_SUPPORTED');
    expect(result.code).toBe('REGION_NOT_SUPPORTED');
    expect(result.summary).toBe('The selected region is not yet supported.');
    expect(result.steps).toHaveLength(2);
    expect(result.steps[0]).toContain(
      'us-east-1, us-east-2, us-west-1, us-west-2, ca-central-1',
    );
    expect(result.steps[0]).toContain(
      'Choose one of the supported regions:',
    );
    expect(result.steps[1]).toBe(
      'Re-create the deployment in the supported region.',
    );
    expect(result.requiresManual).toBe(true);
    expect(result.automatic).toBe(false);
  });

  it('lists all 17 supported regions', () => {
    const result = getRemediation('REGION_NOT_SUPPORTED');
    const regionStep = result.steps[0];
    // Should mention all 17 regions from the db enum (§32).
    const expectedRegions = [
      'us-east-1',
      'us-east-2',
      'us-west-1',
      'us-west-2',
      'ca-central-1',
      'sa-east-1',
      'eu-west-1',
      'eu-west-2',
      'eu-west-3',
      'eu-central-1',
      'eu-north-1',
      'ap-northeast-1',
      'ap-northeast-2',
      'ap-northeast-3',
      'ap-south-1',
      'ap-southeast-1',
      'ap-southeast-2',
    ];
    for (const r of expectedRegions) {
      expect(regionStep).toContain(r);
    }
  });
});

describe('getRemediation — QUOTA_EXCEEDED', () => {
  it('returns the correct fixed guidance', () => {
    const result = getRemediation('QUOTA_EXCEEDED');
    expect(result.code).toBe('QUOTA_EXCEEDED');
    expect(result.summary).toBe(
      'Your cloud account has hit a resource limit.',
    );
    expect(result.steps).toEqual([
      "Check your account's service quotas.",
      'Request a quota increase if needed.',
      'Retry the deployment.',
    ]);
    expect(result.requiresManual).toBe(true);
    expect(result.automatic).toBe(false);
  });
});

describe('getRemediation — IMAGE_HEALTH_CHECK_FAILED', () => {
  it('returns the correct fixed guidance', () => {
    const result = getRemediation('IMAGE_HEALTH_CHECK_FAILED');
    expect(result.code).toBe('IMAGE_HEALTH_CHECK_FAILED');
    expect(result.summary).toBe(
      "The container image didn't pass its health check.",
    );
    expect(result.steps).toEqual([
      'Verify your app responds to GET /health on the configured port within 30 seconds of startup.',
      'Check the application logs for startup errors.',
      'Rebuild and redeploy.',
    ]);
    expect(result.requiresManual).toBe(true);
    expect(result.automatic).toBe(false);
  });
});

describe('getRemediation — MIGRATION_FAILED', () => {
  it('returns the correct fixed guidance', () => {
    const result = getRemediation('MIGRATION_FAILED');
    expect(result.code).toBe('MIGRATION_FAILED');
    expect(result.summary).toBe(
      "The database migration didn't complete.",
    );
    expect(result.steps).toEqual([
      'Check the migration command output for errors.',
      'Fix the migration and re-run it manually if needed.',
      'Retry the deployment.',
    ]);
    expect(result.requiresManual).toBe(true);
    expect(result.automatic).toBe(false);
  });
});

describe('getRemediation — RELAY_DISCONNECTED', () => {
  it('returns the correct fixed guidance', () => {
    const result = getRemediation('RELAY_DISCONNECTED');
    expect(result.code).toBe('RELAY_DISCONNECTED');
    expect(result.summary).toBe(
      "The helper that runs in your cloud account can't reach Deployz.",
    );
    expect(result.steps).toEqual([
      "Check your cloud account's network settings and internet connectivity.",
      "Verify the relay Lambda is still deployed and hasn't been removed.",
      'If the issue persists, re-create the bootstrap stack from your install link.',
    ]);
    expect(result.requiresManual).toBe(true);
    expect(result.automatic).toBe(false);
  });
});

describe('getRemediation — ECS_DEPLOYMENT_FAILED', () => {
  it('returns the correct fixed guidance', () => {
    const result = getRemediation('ECS_DEPLOYMENT_FAILED');
    expect(result.code).toBe('ECS_DEPLOYMENT_FAILED');
    expect(result.summary).toBe(
      'The container service failed to start or update.',
    );
    expect(result.steps).toEqual([
      'Check your application logs for startup errors.',
      'Verify your container image is valid and complete.',
      'Retry the deployment.',
    ]);
    expect(result.requiresManual).toBe(true);
    expect(result.automatic).toBe(false);
  });
});

describe('getRemediation — RDS_UNAVAILABLE', () => {
  it('returns the correct fixed guidance', () => {
    const result = getRemediation('RDS_UNAVAILABLE');
    expect(result.code).toBe('RDS_UNAVAILABLE');
    expect(result.summary).toBe("The database isn't responding.");
    expect(result.steps).toEqual([
      'Wait a few minutes — databases sometimes restart for maintenance.',
      "Check your cloud account's database status.",
      'Contact support if the issue persists.',
    ]);
    expect(result.requiresManual).toBe(true);
    expect(result.automatic).toBe(false);
  });
});

describe('getRemediation — UNKNOWN', () => {
  it('returns the correct fixed guidance', () => {
    const result = getRemediation('UNKNOWN');
    expect(result.code).toBe('UNKNOWN');
    expect(result.summary).toBe("This issue isn't one we've seen before.");
    expect(result.steps).toEqual([
      "Check the deployment's health signals for more detail.",
      'Contact Deployz support with your deployment ID.',
    ]);
    expect(result.requiresManual).toBe(true);
    expect(result.automatic).toBe(false);
  });
});

// ==========================================================================
// Purity — determinism
// ==========================================================================

describe('getRemediation — purity invariant', () => {
  it('same code → same remediation (pure function)', () => {
    for (const code of FAILURE_CODES) {
      const a = getRemediation(code);
      const b = getRemediation(code);
      expect(b).toEqual(a);
    }
  });

  it('same code + same event → same remediation (event is advisory only)', () => {
    const event: StructuredEvent = {
      source: 'ecs',
      error: { code: 'AccessDenied', message: 'explicit deny' },
    };
    const a = getRemediation('AWS_SCP_BLOCKED', event);
    const b = getRemediation('AWS_SCP_BLOCKED', event);
    expect(b).toEqual(a);
  });

  it('event parameter does not change output (advisory only)', () => {
    const noEvent = getRemediation('AWS_SCP_BLOCKED');
    const withEvent = getRemediation('AWS_SCP_BLOCKED', {
      source: 'ecs',
      error: { code: 'AccessDenied', message: 'explicit deny' },
    });
    expect(withEvent).toEqual(noEvent);
  });
});

// ==========================================================================
// automatic is always false, requiresManual is always true
// ==========================================================================

describe('getRemediation — automatic is NEVER true', () => {
  it('automatic is false for every failure code', () => {
    for (const code of FAILURE_CODES) {
      const result = getRemediation(code);
      expect(result.automatic).toBe(false);
    }
  });
});

describe('getRemediation — requiresManual is always true', () => {
  it('requiresManual is true for every failure code', () => {
    for (const code of FAILURE_CODES) {
      const result = getRemediation(code);
      expect(result.requiresManual).toBe(true);
    }
  });
});

// ==========================================================================
// Complete coverage — no missing codes
// ==========================================================================

describe('getRemediation — complete coverage', () => {
  it('FAILURE_CODES matches the keys of the remediation table', () => {
    const codes = new Set<FailureCode>();
    for (const code of FAILURE_CODES) {
      codes.add(code);
    }
    expect(codes.size).toBe(10);
    for (const code of FAILURE_CODES) {
      const result = getRemediation(code);
      expect(result.code).toBe(code);
      expect(result.summary).toBeTruthy();
      expect(result.steps.length).toBeGreaterThanOrEqual(1);
    }
  });
});

// ==========================================================================
// Shape invariants
// ==========================================================================

describe('Remediation shape invariants', () => {
  it('every remediation has a non-empty summary', () => {
    for (const code of FAILURE_CODES) {
      const result = getRemediation(code);
      expect(result.summary.length).toBeGreaterThan(0);
    }
  });

  it('every remediation has at least one step', () => {
    for (const code of FAILURE_CODES) {
      const result = getRemediation(code);
      expect(result.steps.length).toBeGreaterThanOrEqual(1);
    }
  });

  it('every remediation has at most 3 steps', () => {
    for (const code of FAILURE_CODES) {
      const result = getRemediation(code);
      expect(result.steps.length).toBeLessThanOrEqual(3);
    }
  });

  it('every step is a non-empty string', () => {
    for (const code of FAILURE_CODES) {
      const result = getRemediation(code);
      for (const step of result.steps) {
        expect(step.length).toBeGreaterThan(0);
      }
    }
  });
});