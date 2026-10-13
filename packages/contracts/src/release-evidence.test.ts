import { describe, expect, it } from 'vitest';
import { evaluateReleaseEvidence, type ExpectedWorkload, type ServiceEvidence } from './release-evidence.js';

const NOW = new Date('2026-10-13T12:00:00.000Z');
const AT = '2026-10-13T11:59:00.000Z';
const DIGEST = 'sha256:aaa';

const WEB: ExpectedWorkload = { id: 'web', serviceLogicalId: 'WebService', public: true };
const WORKER: ExpectedWorkload = { id: 'email-worker', serviceLogicalId: 'EmailWorkerService', public: false };

function service(overrides: Partial<ServiceEvidence> = {}): ServiceEvidence {
  return {
    workloadId: 'web',
    serviceLogicalId: 'WebService',
    observed: true,
    desiredCount: 1,
    runningCount: 1,
    rolloutState: 'COMPLETED',
    runningDigests: [DIGEST],
    targets: { healthy: 1, unhealthy: 0, pending: 0, unknown: 0 },
    ...overrides,
  };
}

function evidence(services: ServiceEvidence[], probe: { ok: boolean; checkedAt?: string } | null = { ok: true }) {
  return {
    version: 1,
    observedAt: AT,
    services,
    httpProbe: probe === null ? null : { ok: probe.ok, status: probe.ok ? 200 : 502, checkedAt: probe.checkedAt ?? AT },
  };
}

const worker = (overrides: Partial<ServiceEvidence> = {}) =>
  service({ workloadId: 'email-worker', serviceLogicalId: 'EmailWorkerService', targets: null, ...overrides });

describe('evaluateReleaseEvidence', () => {
  it('passes a complete healthy web-plus-worker observation and returns the digest', () => {
    expect(evaluateReleaseEvidence(evidence([service(), worker()]), [WEB, WORKER], NOW)).toEqual({ pass: true, digest: DIGEST });
  });

  it.each([
    ['missing evidence', undefined, 'EVIDENCE_MISSING'],
    ['null evidence', null, 'EVIDENCE_MISSING'],
    ['an empty object', {}, 'EVIDENCE_INVALID'],
    ['an unknown version', { ...evidence([service()]), version: 2 }, 'EVIDENCE_INVALID'],
  ])('refuses %s', (_label, raw, reason) => {
    expect(evaluateReleaseEvidence(raw, [WEB], NOW)).toEqual({ pass: false, reason });
  });

  it('refuses when no workload is expected', () => {
    expect(evaluateReleaseEvidence(evidence([service()]), [], NOW)).toEqual({ pass: false, reason: 'NO_EXPECTED_WORKLOADS' });
  });

  it('refuses an empty or partial service list', () => {
    expect(evaluateReleaseEvidence(evidence([]), [WEB], NOW)).toEqual({ pass: false, reason: 'WORKLOAD_MISSING' });
    expect(evaluateReleaseEvidence(evidence([service()]), [WEB, WORKER], NOW)).toEqual({ pass: false, reason: 'WORKLOAD_MISSING' });
    expect(evaluateReleaseEvidence(evidence([service({ observed: false })]), [WEB], NOW)).toEqual({
      pass: false,
      reason: 'WORKLOAD_MISSING',
    });
  });

  it('refuses zero tasks, null counts and insufficient running tasks', () => {
    expect(evaluateReleaseEvidence(evidence([service({ desiredCount: 0, runningCount: 0 })]), [WEB], NOW).pass).toBe(false);
    expect(evaluateReleaseEvidence(evidence([service({ runningCount: null })]), [WEB], NOW)).toEqual({
      pass: false,
      reason: 'TASKS_INSUFFICIENT',
    });
    expect(evaluateReleaseEvidence(evidence([service({ desiredCount: 2, runningCount: 1 })]), [WEB], NOW)).toEqual({
      pass: false,
      reason: 'TASKS_INSUFFICIENT',
    });
  });

  it('refuses an incomplete or unknown rollout', () => {
    for (const rolloutState of ['IN_PROGRESS', 'FAILED', null]) {
      expect(evaluateReleaseEvidence(evidence([service({ rolloutState })]), [WEB], NOW)).toEqual({
        pass: false,
        reason: 'ROLLOUT_INCOMPLETE',
      });
    }
  });

  it('refuses unknown and mixed digests across tasks and services', () => {
    expect(evaluateReleaseEvidence(evidence([service({ runningDigests: null })]), [WEB], NOW)).toEqual({
      pass: false,
      reason: 'DIGEST_UNKNOWN',
    });
    expect(evaluateReleaseEvidence(evidence([service({ runningDigests: [DIGEST, 'sha256:bbb'] })]), [WEB], NOW)).toEqual({
      pass: false,
      reason: 'DIGEST_MIXED',
    });
    expect(
      evaluateReleaseEvidence(evidence([service(), worker({ runningDigests: ['sha256:bbb'] })]), [WEB, WORKER], NOW),
    ).toEqual({ pass: false, reason: 'DIGEST_MIXED' });
  });

  it('refuses missing or unhealthy targets on the public workload', () => {
    expect(evaluateReleaseEvidence(evidence([service({ targets: null })]), [WEB], NOW)).toEqual({
      pass: false,
      reason: 'TARGETS_UNHEALTHY',
    });
    expect(
      evaluateReleaseEvidence(evidence([service({ targets: { healthy: 1, unhealthy: 0, pending: 1, unknown: 0 } })]), [WEB], NOW).pass,
    ).toBe(false);
  });

  it('refuses a missing, failed or stale probe', () => {
    expect(evaluateReleaseEvidence(evidence([service()], null), [WEB], NOW)).toEqual({ pass: false, reason: 'PROBE_MISSING' });
    expect(evaluateReleaseEvidence(evidence([service()], { ok: false }), [WEB], NOW)).toEqual({ pass: false, reason: 'PROBE_FAILED' });
    expect(
      evaluateReleaseEvidence(evidence([service()], { ok: true, checkedAt: '2026-10-13T11:00:00.000Z' }), [WEB], NOW),
    ).toEqual({ pass: false, reason: 'EVIDENCE_STALE' });
  });

  it('refuses a stale heartbeat', () => {
    expect(evaluateReleaseEvidence({ ...evidence([service()]), observedAt: '2026-10-13T11:30:00.000Z' }, [WEB], NOW)).toEqual({
      pass: false,
      reason: 'EVIDENCE_STALE',
    });
  });

  it('does not need a probe when no workload is public', () => {
    expect(evaluateReleaseEvidence(evidence([worker()], null), [WORKER], NOW)).toEqual({ pass: true, digest: DIGEST });
  });
});
