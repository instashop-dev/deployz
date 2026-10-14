import { describe, expect, it } from 'vitest';

import { INSTALL_VERIFICATION_WINDOW_MS, unverifiedInstall, type VerificationJob } from './install-verification.js';

const NOW = new Date('2026-01-01T12:00:00Z');
const OLD = new Date(NOW.getTime() - INSTALL_VERIFICATION_WINDOW_MS - 1000);
const RECENT = new Date(NOW.getTime() - 60_000);
const failing = { pass: false, reason: 'PROBE_FAILED', notStarted: false };

function job(patch: Partial<VerificationJob> = {}): VerificationJob {
  return { id: 'j1', type: 'INSTALL', state: 'SUCCEEDED', createdAt: OLD, finishedAt: OLD, ...patch };
}

describe('unverifiedInstall', () => {
  it('classifies a probe that never passed once the window has elapsed', () => {
    expect(unverifiedInstall({ jobs: [job()], verdict: failing, now: NOW })).toEqual({
      anchorJobId: 'j1',
      failureCode: 'IMAGE_HEALTH_CHECK_FAILED',
      reason: 'PROBE_FAILED',
    });
  });

  it.each([
    ['TARGETS_UNHEALTHY', 'IMAGE_HEALTH_CHECK_FAILED'],
    ['TASKS_INSUFFICIENT', 'CONTAINER_START_FAILED'],
    ['ROLLOUT_INCOMPLETE', 'ECS_DEPLOYMENT_FAILED'],
    ['DIGEST_MIXED', 'UNKNOWN'],
  ])('maps %s to %s', (reason, failureCode) => {
    expect(unverifiedInstall({ jobs: [job()], verdict: { ...failing, reason }, now: NOW })?.failureCode).toBe(
      failureCode,
    );
  });

  it('waits inside the window', () => {
    expect(unverifiedInstall({ jobs: [job({ finishedAt: RECENT })], verdict: failing, now: NOW })).toBeNull();
  });

  it('measures the window from the latest settled deploy', () => {
    const deploy = job({ id: 'j2', type: 'DEPLOY_RELEASE', createdAt: RECENT, finishedAt: RECENT });
    expect(unverifiedInstall({ jobs: [job(), deploy], verdict: failing, now: NOW })).toBeNull();
  });

  it.each(['EVIDENCE_MISSING', 'EVIDENCE_STALE', 'EVIDENCE_INVALID', 'NO_EXPECTED_WORKLOADS'])(
    'never fails on %s',
    (reason) => {
      expect(unverifiedInstall({ jobs: [job()], verdict: { ...failing, reason }, now: NOW })).toBeNull();
    },
  );

  it('does not fail a passing verdict, a configured first start or an active job', () => {
    expect(unverifiedInstall({ jobs: [job()], verdict: { pass: true, reason: null, notStarted: false }, now: NOW })).toBeNull();
    expect(unverifiedInstall({ jobs: [job()], verdict: { ...failing, notStarted: true }, now: NOW })).toBeNull();
    const running = job({ id: 'j2', type: 'DEPLOY_RELEASE', state: 'RUNNING', finishedAt: null, createdAt: RECENT });
    expect(unverifiedInstall({ jobs: [job(), running], verdict: failing, now: NOW })).toBeNull();
  });

  it('leaves a failed later job to its own failure path', () => {
    const failed = job({ id: 'j2', type: 'DEPLOY_RELEASE', state: 'FAILED', createdAt: RECENT, finishedAt: RECENT });
    expect(unverifiedInstall({ jobs: [job(), failed], verdict: failing, now: NOW })).toBeNull();
  });

  it('requires a succeeded install', () => {
    expect(unverifiedInstall({ jobs: [job({ state: 'FAILED' })], verdict: failing, now: NOW })).toBeNull();
  });
});
