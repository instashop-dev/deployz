import { describe, expect, it } from 'vitest';

import { failureCodeEnum } from '@deployz/db';

import {
  classifyFailure,
  FAILURE_CODES,
  type FailureCode,
  type StructuredEvent,
} from '../src/analysis/failure-classifier.js';

// ==========================================================================
// §61 taxonomy parity with @deployz/db
// ==========================================================================

describe('§61 failure taxonomy parity with @deployz/db', () => {
  it('FAILURE_CODES === failureCodeEnum (no drift)', () => {
    expect([...FAILURE_CODES].sort()).toEqual([...failureCodeEnum.enumValues].sort());
  });
});

// ==========================================================================
// Positive tests — every §61 code
// ==========================================================================

describe('classifyFailure — AWS_SCP_BLOCKED (rule 1)', () => {
  it('AccessDenied + "service control policy" → AWS_SCP_BLOCKED', () => {
    const event: StructuredEvent = {
      source: 'ecs',
      error: {
        code: 'AccessDenied',
        message:
          'User is not authorized to perform: ecs:RunTask with an explicit deny in a service control policy',
      },
    };
    expect(classifyFailure(event)).toBe('AWS_SCP_BLOCKED');
  });

  it('AccessDenied + "explicit deny" → AWS_SCP_BLOCKED', () => {
    const event: StructuredEvent = {
      source: 'cloudformation',
      error: {
        code: 'AccessDenied',
        message: 'explicit deny — this account is blocked by an SCP',
      },
    };
    expect(classifyFailure(event)).toBe('AWS_SCP_BLOCKED');
  });

  it('AccessDeniedException (SDK name) also recognized', () => {
    const event: StructuredEvent = {
      source: 'ecs',
      error: {
        code: 'AccessDeniedException',
        message: 'not authorized ... explicit deny in a service control policy',
      },
    };
    expect(classifyFailure(event)).toBe('AWS_SCP_BLOCKED');
  });

  it('AccessDenied WITHOUT an SCP signature is NOT SCP-blocked', () => {
    // A plain IAM denial (no SCP marker) must not resolve to AWS_SCP_BLOCKED.
    const event: StructuredEvent = {
      source: 'ecs',
      error: { code: 'AccessDenied', message: 'not authorized to perform this action' },
    };
    expect(classifyFailure(event)).toBe('AWS_PERMISSION_DENIED');
  });
});

describe('classifyFailure — PORT_MISMATCH (rule 2, §29)', () => {
  it('§29 canonical: signal "port" + expected/actual ports → PORT_MISMATCH', () => {
    const event: StructuredEvent = {
      source: 'health-check',
      signal: 'port',
      context: { expectedPort: 3000, actualPort: 8080 },
    };
    expect(classifyFailure(event)).toBe('PORT_MISMATCH');
  });

  it('context.portMismatch flag → PORT_MISMATCH', () => {
    const event: StructuredEvent = {
      source: 'ecs',
      context: { portMismatch: true },
    };
    expect(classifyFailure(event)).toBe('PORT_MISMATCH');
  });

  it('differing expectedPort/actualPort (no signal) → PORT_MISMATCH', () => {
    const event: StructuredEvent = {
      source: 'ecs',
      context: { expectedPort: 3000, actualPort: 8080 },
    };
    expect(classifyFailure(event)).toBe('PORT_MISMATCH');
  });

  it('error message describing a port difference → PORT_MISMATCH', () => {
    const event: StructuredEvent = {
      source: 'ecs',
      error: {
        message: 'Container listens on port 8080 but the service exposes port 3000',
      },
    };
    expect(classifyFailure(event)).toBe('PORT_MISMATCH');
  });

  it('matching expectedPort/actualPort is NOT a mismatch', () => {
    const event: StructuredEvent = {
      source: 'ecs',
      context: { expectedPort: 3000, actualPort: 3000 },
    };
    expect(classifyFailure(event)).toBe('UNKNOWN');
  });
});

describe('classifyFailure — REGION_NOT_SUPPORTED (rule 3)', () => {
  it('region outside the 17-region allowlist → REGION_NOT_SUPPORTED', () => {
    const event: StructuredEvent = {
      source: 'preflight',
      context: { region: 'eu-south-1' },
    };
    expect(classifyFailure(event)).toBe('REGION_NOT_SUPPORTED');
  });

  it('region inside the allowlist is NOT region-unsupported (falls through)', () => {
    const event: StructuredEvent = {
      source: 'preflight',
      context: { region: 'us-east-1' },
    };
    expect(classifyFailure(event)).toBe('UNKNOWN');
  });

  it('no region in context is NOT region-unsupported (cannot decide)', () => {
    const event: StructuredEvent = { source: 'preflight' };
    expect(classifyFailure(event)).toBe('UNKNOWN');
  });
});

describe('classifyFailure — QUOTA_EXCEEDED (rule 4)', () => {
  it('"quota" message → QUOTA_EXCEEDED', () => {
    const event: StructuredEvent = {
      source: 'ecs',
      error: { message: 'You have exceeded your EC2 instance quota for this region' },
    };
    expect(classifyFailure(event)).toBe('QUOTA_EXCEEDED');
  });

  it('"LimitExceeded" message → QUOTA_EXCEEDED', () => {
    const event: StructuredEvent = {
      source: 'cloudformation',
      error: { message: 'LimitExceededException: too many concurrent requests' },
    };
    expect(classifyFailure(event)).toBe('QUOTA_EXCEEDED');
  });

  it('"Throttling" message → QUOTA_EXCEEDED', () => {
    const event: StructuredEvent = {
      source: 'cloudformation',
      error: { message: 'ThrottlingException: rate exceeded' },
    };
    expect(classifyFailure(event)).toBe('QUOTA_EXCEEDED');
  });
});

describe('classifyFailure — IMAGE_HEALTH_CHECK_FAILED (rule 5)', () => {
  it('health-check target unhealthy → IMAGE_HEALTH_CHECK_FAILED', () => {
    const event: StructuredEvent = {
      source: 'health-check',
      signal: 'target-health',
      context: { healthy: false },
    };
    expect(classifyFailure(event)).toBe('IMAGE_HEALTH_CHECK_FAILED');
  });

  it('health-check target healthy is NOT a failure (falls through)', () => {
    const event: StructuredEvent = {
      source: 'health-check',
      signal: 'target-health',
      context: { healthy: true },
    };
    expect(classifyFailure(event)).toBe('UNKNOWN');
  });
});

describe('classifyFailure — MIGRATION_FAILED (rule 6)', () => {
  it('deploy migration with error → MIGRATION_FAILED', () => {
    const event: StructuredEvent = {
      source: 'deploy',
      action: 'migration',
      error: { code: 'MigrationError', message: 'migration 0002 rolled back' },
    };
    expect(classifyFailure(event)).toBe('MIGRATION_FAILED');
  });

  it('deploy migration without error is NOT a failure (falls through)', () => {
    const event: StructuredEvent = {
      source: 'deploy',
      action: 'migration',
    };
    expect(classifyFailure(event)).toBe('UNKNOWN');
  });
});

describe('classifyFailure — RELAY_DISCONNECTED (rule 7)', () => {
  it('relay connectivity lost → RELAY_DISCONNECTED', () => {
    const event: StructuredEvent = {
      source: 'relay',
      signal: 'connectivity',
      context: { connected: false },
    };
    expect(classifyFailure(event)).toBe('RELAY_DISCONNECTED');
  });

  it('relay direct disconnect signal → RELAY_DISCONNECTED', () => {
    const event: StructuredEvent = {
      source: 'relay',
      signal: 'disconnected',
    };
    expect(classifyFailure(event)).toBe('RELAY_DISCONNECTED');
  });

  it('relay still connected is NOT disconnected (falls through)', () => {
    const event: StructuredEvent = {
      source: 'relay',
      signal: 'connectivity',
      context: { connected: true },
    };
    expect(classifyFailure(event)).toBe('UNKNOWN');
  });
});

describe('classifyFailure — ECS_DEPLOYMENT_FAILED (rule 8)', () => {
  it('ecs-sourced error → ECS_DEPLOYMENT_FAILED', () => {
    const event: StructuredEvent = {
      source: 'ecs',
      error: { code: 'InvalidParameterException', message: 'task definition invalid' },
    };
    expect(classifyFailure(event)).toBe('ECS_DEPLOYMENT_FAILED');
  });

  it('ecs without error is NOT a failure (falls through)', () => {
    const event: StructuredEvent = { source: 'ecs' };
    expect(classifyFailure(event)).toBe('UNKNOWN');
  });
});

describe('classifyFailure — RDS_UNAVAILABLE (rule 9)', () => {
  it('rds-sourced error → RDS_UNAVAILABLE', () => {
    const event: StructuredEvent = {
      source: 'rds',
      error: { code: 'DBInstanceNotFound', message: 'DB instance not found' },
    };
    expect(classifyFailure(event)).toBe('RDS_UNAVAILABLE');
  });

  it('rds available=false → RDS_UNAVAILABLE', () => {
    const event: StructuredEvent = {
      source: 'rds',
      context: { available: false },
    };
    expect(classifyFailure(event)).toBe('RDS_UNAVAILABLE');
  });

  it('rds available=true is NOT unavailable (falls through)', () => {
    const event: StructuredEvent = {
      source: 'rds',
      context: { available: true },
    };
    expect(classifyFailure(event)).toBe('UNKNOWN');
  });
});

describe('classifyFailure — UNKNOWN (fallback)', () => {
  it('unrecognized source → UNKNOWN', () => {
    const event: StructuredEvent = { source: 'unknown-source' };
    expect(classifyFailure(event)).toBe('UNKNOWN');
  });

  it('event with no matching rule → UNKNOWN', () => {
    const event: StructuredEvent = { source: 'deploy', action: 'deploy' };
    expect(classifyFailure(event)).toBe('UNKNOWN');
  });
});

// ==========================================================================
// §20 — every one of the seven example failure strings classifies sensibly
// ==========================================================================

describe('classifyFailure — §20 example failure strings', () => {
  const cases: Array<{ label: string; event: StructuredEvent; expected: FailureCode }> = [
    {
      label: 'AccessDenied',
      event: { source: 'ecs', error: { code: 'AccessDenied' } },
      expected: 'AWS_PERMISSION_DENIED',
    },
    {
      label: 'ResourceLimitExceeded',
      event: { source: 'ecs', error: { code: 'ResourceLimitExceeded' } },
      expected: 'QUOTA_EXCEEDED',
    },
    {
      label: 'Target failed health check',
      event: { source: 'ecs', error: { message: 'Target failed health check' } },
      expected: 'IMAGE_HEALTH_CHECK_FAILED',
    },
    {
      label: 'Container exited 1',
      event: { source: 'ecs', error: { message: 'Container exited 1' } },
      expected: 'CONTAINER_START_FAILED',
    },
    {
      label: 'Database connection timeout',
      event: { source: 'rds', error: { message: 'Database connection timeout' } },
      expected: 'DATABASE_CONNECTION_FAILED',
    },
    {
      label: 'Invalid secret',
      event: { source: 'ecs', error: { message: 'Invalid secret' } },
      expected: 'MISSING_SECRET',
    },
    {
      label: 'Port unavailable',
      event: { source: 'ecs', error: { message: 'Port unavailable' } },
      expected: 'PORT_MISMATCH',
    },
  ];

  it.each(cases)('"$label" classifies to $expected', ({ event, expected }) => {
    expect(classifyFailure(event)).toBe(expected);
  });
});

// ==========================================================================
// Precedence — first match wins
// ==========================================================================

describe('classifyFailure — precedence (first match wins)', () => {
  it('SCP beats QUOTA (rule 1 before rule 4)', () => {
    const event: StructuredEvent = {
      source: 'ecs',
      error: {
        code: 'AccessDenied',
        message:
          'explicit deny in a service control policy — your EC2 quota was exceeded',
      },
    };
    expect(classifyFailure(event)).toBe('AWS_SCP_BLOCKED');
  });

  it('PORT beats REGION (rule 2 before rule 3)', () => {
    const event: StructuredEvent = {
      source: 'preflight',
      signal: 'port',
      context: { region: 'eu-south-1', expectedPort: 3000, actualPort: 8080 },
    };
    expect(classifyFailure(event)).toBe('PORT_MISMATCH');
  });

  it('REGION beats QUOTA (rule 3 before rule 4)', () => {
    const event: StructuredEvent = {
      source: 'preflight',
      error: { message: 'your quota was exceeded' },
      context: { region: 'eu-south-1' },
    };
    expect(classifyFailure(event)).toBe('REGION_NOT_SUPPORTED');
  });

  it('QUOTA beats ECS (rule 4 before rule 8)', () => {
    const event: StructuredEvent = {
      source: 'ecs',
      error: { code: 'ThrottlingException', message: 'Throttling: rate limit exceeded' },
    };
    expect(classifyFailure(event)).toBe('QUOTA_EXCEEDED');
  });

  it('QUOTA beats RDS (rule 4 before rule 9)', () => {
    const event: StructuredEvent = {
      source: 'rds',
      error: { message: 'you have exceeded your instance quota' },
    };
    expect(classifyFailure(event)).toBe('QUOTA_EXCEEDED');
  });
});

// ==========================================================================
// Purity — determinism (§20, no AI)
// ==========================================================================

describe('classifyFailure — purity invariant (§20)', () => {
  it('same input → same code, synchronously (no AI, no randomness)', () => {
    const event: StructuredEvent = {
      source: 'ecs',
      error: { code: 'AccessDenied', message: 'explicit deny in a service control policy' },
    };
    const first = classifyFailure(event);
    const second = classifyFailure(event);
    expect(second).toBe(first);
    expect(first).not.toBeInstanceOf(Promise);
  });

  it('deterministic across every failure code', () => {
    const events: StructuredEvent[] = [
      // AWS_SCP_BLOCKED
      {
        source: 'ecs',
        error: { code: 'AccessDenied', message: 'explicit deny in a service control policy' },
      },
      // AWS_PERMISSION_DENIED
      {
        source: 'ecs',
        error: { code: 'AccessDenied', message: 'not authorized to perform this action' },
      },
      // PORT_MISMATCH
      { source: 'health-check', signal: 'port', context: { expectedPort: 3000, actualPort: 8080 } },
      // REGION_NOT_SUPPORTED
      { source: 'preflight', context: { region: 'eu-south-1' } },
      // QUOTA_EXCEEDED
      { source: 'cloudformation', error: { message: 'LimitExceededException' } },
      // IMAGE_HEALTH_CHECK_FAILED
      { source: 'health-check', signal: 'target-health', context: { healthy: false } },
      // MIGRATION_FAILED
      { source: 'deploy', action: 'migration', error: { message: 'migration failed' } },
      // RELAY_DISCONNECTED
      { source: 'relay', signal: 'connectivity', context: { connected: false } },
      // STACK_CREATE_FAILED
      { source: 'cloudformation', signal: 'stack-create-failed' },
      // DATABASE_CREATE_FAILED
      { source: 'rds', signal: 'db-create-failed' },
      // DATABASE_CONNECTION_FAILED
      { source: 'rds', error: { message: 'connection timeout to database' } },
      // IMAGE_PULL_FAILED
      { source: 'ecs', signal: 'image-pull-failed' },
      // CONTAINER_START_FAILED
      { source: 'ecs', signal: 'container-exit' },
      // MISSING_SECRET
      { source: 'ecs', signal: 'missing-secret' },
      // ECS_DEPLOYMENT_FAILED
      { source: 'ecs', error: { message: 'generic ecs error' } },
      // RDS_UNAVAILABLE
      { source: 'rds', context: { available: false } },
      // UNSUPPORTED_ARCHITECTURE
      { source: 'preflight', signal: 'unsupported-arch' },
      // UNKNOWN
      { source: 'unknown-source' },
    ];

    const codes: FailureCode[] = [];
    for (const event of events) {
      const a = classifyFailure(event);
      const b = classifyFailure(event);
      expect(b).toBe(a);
      codes.push(a);
    }
    // The loop covered all eighteen codes exactly once.
    expect([...codes].sort()).toEqual([...FAILURE_CODES].sort());
  });
});
