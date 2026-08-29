import { describe, expect, it } from 'vitest';

import {
  COMPATIBILITY_VERDICTS,
  COPY_RULES_65,
  DEPLOYMENT_STATE_BADGE,
  DEPLOYMENT_STATE_LABELS,
  DEPLOYMENT_STATES,
  EXPLANATION_FALLBACK,
  FAILURE_CODE_COPY,
  FAILURE_CODES,
  FAILURE_REMEDIATION,
  FAILURE_SEVERITY_BADGE,
  FAILURE_SEVERITY_DOT,
  JARGON_PATTERN,
  ONBOARDING_STEPS,
  SECRET_MASK,
  VERDICT_PRESENTATION,
  deploymentStateLabel,
  eventFamily,
  eventResultLabel,
  eventTypeLabel,
  failureCodeCopy,
} from '../src/index';

// Locks the §46/§61/§19 vocabulary + §65 copy principles in the single
// source of truth (packages/copy-map). Every label at the top level must be
// jargon-free; raw AWS/CFN/ECS/IAM terms must not appear.

// ── §46 deployment states ───────────────────────────────────────────────────

describe('§46 deployment states', () => {
  it('defines exactly the 9 product-vocabulary states', () => {
    expect(DEPLOYMENT_STATES).toEqual([
      'NOT_INSTALLED',
      'INSTALLING',
      'HEALTHY',
      'UPDATING',
      'UPDATE_AVAILABLE',
      'FAILED',
      'DISCONNECTED',
      'DELETING',
      'DELETED',
    ]);
  });

  it('maps every state to a non-empty, jargon-free label', () => {
    for (const state of DEPLOYMENT_STATES) {
      const label = DEPLOYMENT_STATE_LABELS[state];
      expect(label, `label for ${state}`).toBeTruthy();
      expect(label, `label for ${state}`).not.toMatch(JARGON_PATTERN);
    }
  });

  it('uses the plan §46 product wording for the key states', () => {
    expect(DEPLOYMENT_STATE_LABELS.HEALTHY).toBe('Healthy');
    expect(DEPLOYMENT_STATE_LABELS.INSTALLING).toBe('Installing');
    expect(DEPLOYMENT_STATE_LABELS.FAILED).toBe('Failed');
    expect(DEPLOYMENT_STATE_LABELS.UPDATE_AVAILABLE).toBe('Update available');
  });

  it('marks FAILED and DISCONNECTED as destructive', () => {
    expect(DEPLOYMENT_STATE_BADGE.FAILED).toBe('destructive');
    expect(DEPLOYMENT_STATE_BADGE.DISCONNECTED).toBe('destructive');
  });

  it('maps every state to a valid badge variant', () => {
    const validVariants = ['default', 'secondary', 'destructive', 'outline'];
    for (const state of DEPLOYMENT_STATES) {
      expect(validVariants, `badge for ${state}`).toContain(DEPLOYMENT_STATE_BADGE[state]);
    }
  });

  it('deploymentStateLabel falls back to raw string for unknown states', () => {
    expect(deploymentStateLabel('SOME_UNKNOWN')).toBe('SOME_UNKNOWN');
  });
});

// ── §40 event families ──────────────────────────────────────────────────────

describe('§40 event families', () => {
  it('classifies the six §40 families', () => {
    expect(eventFamily('deploy.state.updating')).toBe('deploy');
    expect(eventFamily('rollback.restore')).toBe('rollback');
    expect(eventFamily('config.write')).toBe('config');
    expect(eventFamily('health.report')).toBe('health');
    expect(eventFamily('install.state.healthy')).toBe('install');
    expect(eventFamily('destroy.state.started')).toBe('destroy');
    expect(eventFamily('billing.usage')).toBeNull();
  });

  it('maps known workflow event types to human labels', () => {
    expect(eventTypeLabel('deploy.state.updating')).toBe('Update started');
    expect(eventTypeLabel('rollback.restore')).toBe('Previous version restored');
    expect(eventTypeLabel('install.state.healthy')).toBe('Installed and healthy');
    expect(eventTypeLabel('deploy.state.update-available')).toBe('Update available');
  });

  it('falls back to a family label for an unknown type (never raw)', () => {
    expect(eventTypeLabel('health.report')).toBe('Health');
    expect(eventTypeLabel('destroy.state.started')).toBe('Teardown');
  });

  it('classifies the redis family and maps its known event types', () => {
    expect(eventFamily('redis.provision.started')).toBe('redis');
    expect(eventTypeLabel('redis.provision.started')).toBe('Setting up cache');
    expect(eventTypeLabel('redis.provision.succeeded')).toBe('Cache ready');
    expect(eventTypeLabel('redis.provision.failed')).toBe('Cache setup failed');
  });

  it('falls back to the redis family label for an unknown redis event (never raw)', () => {
    expect(eventTypeLabel('redis.something.unmapped')).toBe('Cache');
  });

  it('produces no raw AWS terms for any known or fallback label', () => {
    const allTypes = [
      'install.preflight.region',
      'install.preflight.scp',
      'install.relay.contact',
      'install.state.installing',
      'install.relay.health',
      'install.state.healthy',
      'deploy.preflight',
      'deploy.state.updating',
      'deploy.migration',
      'deploy.ecs-update',
      'deploy.infra-upgrade',
      'deploy.health',
      'deploy.state.healthy',
      'deploy.state.update-available',
      'rollback.state.updating',
      'rollback.disclosure',
      'rollback.restore',
      'rollback.health',
      'rollback.state.healthy',
      'config.validate',
      'config.write',
      'config.health',
      'config.state.healthy',
      'destroy.state.started',
      'health.report',
      'redis.provision.started',
      'redis.provision.succeeded',
      'redis.provision.failed',
    ];
    for (const type of allTypes) {
      expect(eventTypeLabel(type), `label for ${type}`).not.toMatch(JARGON_PATTERN);
    }
  });
});

// ── §62 event result labels ─────────────────────────────────────────────────

describe('§62 event result labels', () => {
  it('maps results to jargon-free labels', () => {
    expect(eventResultLabel('ok')).toBe('Succeeded');
    expect(eventResultLabel('passed')).toBe('Succeeded');
    expect(eventResultLabel('skipped')).toBe('Skipped');
    expect(eventResultLabel('failed:MIGRATION_FAILED')).toBe('Failed');
    expect(eventResultLabel(null)).toBeNull();
  });

  it('produces no raw AWS terms in result labels', () => {
    expect(eventResultLabel('ok')).not.toMatch(JARGON_PATTERN);
    expect(eventResultLabel('failed:MIGRATION_FAILED')).not.toMatch(JARGON_PATTERN);
  });
});

// ── §61 failure codes ───────────────────────────────────────────────────────

describe('§61 failure codes', () => {
  it('defines exactly the twenty-one §61 taxonomy codes', () => {
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
      'AWS_PERMISSION_DENIED',
      'STACK_CREATE_FAILED',
      'STACK_DELETE_FAILED',
      'DATABASE_CREATE_FAILED',
      'DATABASE_CONNECTION_FAILED',
      'IMAGE_PULL_FAILED',
      'CONTAINER_START_FAILED',
      'MISSING_SECRET',
      'UNSUPPORTED_ARCHITECTURE',
      'UNKNOWN',
      'REDIS_PROVISIONING_FAILED',
      'REDIS_CONNECTION_FAILED',
    ]);
  });

  it('maps every code to non-empty, jargon-free label and description', () => {
    for (const code of FAILURE_CODES) {
      const copy = FAILURE_CODE_COPY[code];
      expect(copy.label, `label for ${code}`).toBeTruthy();
      expect(copy.description, `description for ${code}`).toBeTruthy();
      expect(copy.label, `label for ${code}`).not.toMatch(JARGON_PATTERN);
      expect(copy.description, `description for ${code}`).not.toMatch(JARGON_PATTERN);
    }
  });

  it('keeps raw service names out of even the sensitive codes', () => {
    expect(FAILURE_CODE_COPY.AWS_SCP_BLOCKED.label).toBe('Cloud policy blocks this');
    expect(FAILURE_CODE_COPY.PORT_MISMATCH.label).toBe('Port conflict');
    expect(FAILURE_CODE_COPY.ECS_DEPLOYMENT_FAILED.label).toBe('Deployment failed');
    expect(FAILURE_CODE_COPY.RDS_UNAVAILABLE.label).toBe('Database unreachable');
    expect(FAILURE_CODE_COPY.RELAY_DISCONNECTED.label).toBe('Helper disconnected');
  });

  it('maps the two Redis MVP codes to plain-English, "Redis"-flavored copy', () => {
    expect(FAILURE_CODE_COPY.REDIS_PROVISIONING_FAILED.label).toBe('Cache setup failed');
    expect(FAILURE_CODE_COPY.REDIS_CONNECTION_FAILED.label).toBe("App can't reach its cache");

    // §65 + Redis MVP global constraint: "ElastiCache"/"Valkey" (the AWS
    // implementation names) never appear at the top level, even though
    // "Redis" itself is acceptable product-language.
    for (const code of ['REDIS_PROVISIONING_FAILED', 'REDIS_CONNECTION_FAILED'] as const) {
      const copy = FAILURE_CODE_COPY[code];
      expect(copy.label).not.toMatch(/ElastiCache|Valkey/i);
      expect(copy.description).not.toMatch(/ElastiCache|Valkey/i);
      const remediation = FAILURE_REMEDIATION[code];
      expect(remediation.what).not.toMatch(/ElastiCache|Valkey/i);
      expect(remediation.why).not.toMatch(/ElastiCache|Valkey/i);
      expect(remediation.fix).not.toMatch(/ElastiCache|Valkey/i);
    }
  });

  it('gives every §61 code non-empty, jargon-free what/why/fix remediation', () => {
    for (const code of FAILURE_CODES) {
      const remediation = FAILURE_REMEDIATION[code];
      expect(remediation.what, `what for ${code}`).toBeTruthy();
      expect(remediation.why, `why for ${code}`).toBeTruthy();
      expect(remediation.fix, `fix for ${code}`).toBeTruthy();
      expect(remediation.what, `what for ${code}`).not.toMatch(JARGON_PATTERN);
      expect(remediation.why, `why for ${code}`).not.toMatch(JARGON_PATTERN);
      expect(remediation.fix, `fix for ${code}`).not.toMatch(JARGON_PATTERN);
    }
  });

  it('REDIS_CONNECTION_FAILED remediation mentions redeploying', () => {
    expect(FAILURE_REMEDIATION.REDIS_CONNECTION_FAILED.fix.toLowerCase()).toMatch(/redeploy/);
  });

  it('REDIS_PROVISIONING_FAILED remediation mentions retrying and service limits', () => {
    const { fix } = FAILURE_REMEDIATION.REDIS_PROVISIONING_FAILED;
    expect(fix.toLowerCase()).toMatch(/retry/);
    expect(fix.toLowerCase()).toMatch(/limit/);
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

// ── §65 explanation fallback ────────────────────────────────────────────────

describe('§65 explanation fallback copy', () => {
  it('is jargon-free for when the AI explanation is unavailable', () => {
    expect(EXPLANATION_FALLBACK.why).not.toMatch(JARGON_PATTERN);
    expect(EXPLANATION_FALLBACK.fix).not.toMatch(JARGON_PATTERN);
  });
});

// ── §19 readiness verdicts ──────────────────────────────────────────────────

describe('§19 readiness verdicts', () => {
  it('defines exactly the 3 compatibility verdicts', () => {
    expect(COMPATIBILITY_VERDICTS).toEqual([
      'READY',
      'NEEDS_ATTENTION',
      'NOT_COMPATIBLE',
    ]);
  });

  it('maps every verdict to a non-empty, jargon-free heading and label', () => {
    for (const verdict of COMPATIBILITY_VERDICTS) {
      const presentation = VERDICT_PRESENTATION[verdict];
      expect(presentation.heading, `heading for ${verdict}`).toBeTruthy();
      expect(presentation.label, `label for ${verdict}`).toBeTruthy();
      expect(presentation.heading, `heading for ${verdict}`).not.toMatch(JARGON_PATTERN);
      expect(presentation.label, `label for ${verdict}`).not.toMatch(JARGON_PATTERN);
    }
  });

  it('assigns the correct tones per verdict', () => {
    expect(VERDICT_PRESENTATION.READY.tone).toBe('ready');
    expect(VERDICT_PRESENTATION.NEEDS_ATTENTION.tone).toBe('attention');
    expect(VERDICT_PRESENTATION.NOT_COMPATIBLE.tone).toBe('incompatible');
  });
});

// ── §42 onboarding steps ────────────────────────────────────────────────────

describe('§42 onboarding steps', () => {
  it('defines the six steps in exact order', () => {
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

// ── §31 secret mask ─────────────────────────────────────────────────────────

describe('§31 secret mask', () => {
  it('is the canonical mask value', () => {
    expect(SECRET_MASK).toBe('***');
  });

  it('is a non-empty string', () => {
    expect(SECRET_MASK.length).toBeGreaterThan(0);
  });
});

// ── §65 copy principles ─────────────────────────────────────────────────────

describe('§65 copy principles', () => {
  it('documents all five §65 rules', () => {
    expect(COPY_RULES_65.JARGON_FREE_TOP_LEVEL).toBe(true);
    expect(COPY_RULES_65.EXPANDABLE_TECHNICAL_DETAIL).toBe(true);
    expect(COPY_RULES_65.NO_RAW_AWS_TERMS_AT_TOP_LEVEL).toBe(true);
    expect(COPY_RULES_65.HONEST_TRUST_STORY).toBe(true);
    expect(COPY_RULES_65.MASKED_SECRETS).toBe(true);
  });

  it('JARGON_PATTERN matches all known raw AWS terms', () => {
    expect('CloudFormation').toMatch(JARGON_PATTERN);
    expect('IAM').toMatch(JARGON_PATTERN);
    expect('ECS').toMatch(JARGON_PATTERN);
    expect('ALB').toMatch(JARGON_PATTERN);
    expect('Lambda').toMatch(JARGON_PATTERN);
    expect('VPC').toMatch(JARGON_PATTERN);
    expect('CFN').toMatch(JARGON_PATTERN);
    expect('RDS').toMatch(JARGON_PATTERN);
  });

  it('JARGON_PATTERN does not match product-language terms', () => {
    expect('Healthy').not.toMatch(JARGON_PATTERN);
    expect('Installing').not.toMatch(JARGON_PATTERN);
    expect('Deployment failed').not.toMatch(JARGON_PATTERN);
    expect('Database unreachable').not.toMatch(JARGON_PATTERN);
    expect('Helper disconnected').not.toMatch(JARGON_PATTERN);
  });
});