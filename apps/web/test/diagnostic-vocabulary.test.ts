import { describe, expect, it } from 'vitest';

import {
  EXPLANATION_FALLBACK,
  FAILURE_CODE_COPY,
  FAILURE_CODES,
  FAILURE_SEVERITY_BADGE,
  FAILURE_SEVERITY_DOT,
  failureCodeCopy,
} from '../src/lib/diagnostic-vocabulary';

// Locks the §61/§65 guardrail for the diagnostics surface: the failure-code
// vocabulary is exactly the ten §61 codes, and every top-level label,
// description, and fallback string is jargon-free — no raw AWS/ECS/CFN/IAM
// terms reach the UI edge (the raw code lives behind the expandable layer).

const JARGON = /\b(CloudFormation|IAM|ECS|ALB|Lambda|VPC|CFN|RDS)\b/i;

describe('§61 failure codes', () => {
  it('defines exactly the ten §61 taxonomy codes', () => {
    expect(FAILURE_CODES).toEqual([
      'AWS_SCP_BLOCKED',
      'PORT_MISMATCH',
      'REGION_NOT_SUPPORTED',
      'QUOTA_EXCEEDED',
      'IMAGE_HEALTH_CHECK_FAILED',
      'MIGRATION_FAILED',
      'RELAY_DISCONNECTED',
      'ECS_DEPLOYMENT_FAILED',
      'RDS_UNAVAILABLE',
      'UNKNOWN',
    ]);
  });

  it('maps every code to non-empty, jargon-free label and description', () => {
    for (const code of FAILURE_CODES) {
      const copy = FAILURE_CODE_COPY[code];
      expect(copy.label, `label for ${code}`).toBeTruthy();
      expect(copy.description, `description for ${code}`).toBeTruthy();
      expect(copy.label, `label for ${code}`).not.toMatch(JARGON);
      expect(copy.description, `description for ${code}`).not.toMatch(JARGON);
    }
  });

  it('keeps raw service names out of even the sensitive codes', () => {
    expect(FAILURE_CODE_COPY.AWS_SCP_BLOCKED.label).toBe('Cloud policy blocks this');
    expect(FAILURE_CODE_COPY.PORT_MISMATCH.label).toBe('Port conflict');
    expect(FAILURE_CODE_COPY.ECS_DEPLOYMENT_FAILED.label).toBe('Deployment failed');
    expect(FAILURE_CODE_COPY.RDS_UNAVAILABLE.label).toBe('Database unreachable');
    expect(FAILURE_CODE_COPY.RELAY_DISCONNECTED.label).toBe('Helper disconnected');
  });

  it('exposes a valid severity + badge + dot mapping per code', () => {
    for (const code of FAILURE_CODES) {
      const { severity } = FAILURE_CODE_COPY[code];
      expect(['critical', 'warning']).toContain(severity);
      expect(FAILURE_SEVERITY_BADGE[severity]).toBeTruthy();
      expect(FAILURE_SEVERITY_DOT[severity]).toBeTruthy();
    }
  });

  it('maps critical codes to the destructive badge', () => {
    for (const code of FAILURE_CODES) {
      if (FAILURE_CODE_COPY[code].severity === 'critical') {
        expect(FAILURE_SEVERITY_BADGE[FAILURE_CODE_COPY[code].severity]).toBe('destructive');
      }
    }
  });

  it('falls back to UNKNOWN copy for an unrecognized code', () => {
    expect(failureCodeCopy('SOME_UNLISTED_CODE').label).toBe(FAILURE_CODE_COPY.UNKNOWN.label);
  });
});

describe('§65 explanation fallback copy', () => {
  it('is jargon-free for when the AI explanation is unavailable', () => {
    expect(EXPLANATION_FALLBACK.why).not.toMatch(JARGON);
    expect(EXPLANATION_FALLBACK.fix).not.toMatch(JARGON);
  });
});
