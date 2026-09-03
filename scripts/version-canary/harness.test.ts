import { describe, expect, it } from 'vitest';

import { canaryTags, loadConfig, mintRunId, releaseVersionFor, requireRealAwsOptIn } from './config.js';
import { isTerminalJobState, waitFor } from './control-plane.js';
import { renderSummary, type RunRecord } from './evidence.js';
import { assertSameInfrastructure, parseQuickCreateUrl, type InfraSnapshot } from './steps.js';

describe('real-AWS guard', () => {
  it('refuses without the opt-in, with the shared refusal text', () => {
    expect(() => requireRealAwsOptIn({})).toThrow('Real AWS E2E is disabled.');
    expect(() => requireRealAwsOptIn({ DEPLOYZ_E2E_ALLOW_REAL_AWS: '0' })).toThrow('DEPLOYZ_E2E_ALLOW_REAL_AWS=1');
    expect(() => requireRealAwsOptIn({ DEPLOYZ_E2E_ALLOW_REAL_AWS: '1' })).not.toThrow();
  });
});

describe('run identity', () => {
  it('mints a sortable, unique run id', () => {
    const id = mintRunId(new Date('2026-09-03T09:45:00.123Z'));
    expect(id).toMatch(/^20260903-094500-[0-9a-f]{4}$/);
    expect(mintRunId()).not.toBe(mintRunId());
  });

  it('names releases per run so the shared immutable ECR repository cannot collide', () => {
    expect(releaseVersionFor('20260903-094500-a72c', 'v3-bad-health')).toBe('v3-bad-health-20260903-094500-a72c');
  });

  it('stamps every canary-created resource with the run', () => {
    expect(canaryTags('run-1')).toEqual({
      DeployzCanary: 'true',
      DeployzCanaryRun: 'run-1',
      DeployzTestMode: 'canary',
      DeployzEnvironment: 'e2e',
    });
  });

  it('defaults to the deployed control plane and the test account, overridable by env', () => {
    const config = loadConfig({});
    expect(config.apiUrl).toBe('https://api.deployz.dev');
    expect(config.expectedAccountId).toBe('151955775369');
    expect(config.region).toBe('us-east-1');
    expect(loadConfig({ DEPLOYZ_CANARY_API_URL: 'http://localhost:3001/' }).apiUrl).toBe('http://localhost:3001');
    expect(loadConfig({}, { runId: 'fixed' }).runId).toBe('fixed');
  });
});

describe('Quick Create URL', () => {
  it('extracts the template, stack name and non-secret parameters the customer console would use', () => {
    const parsed = parseQuickCreateUrl(
      'https://us-east-1.console.aws.amazon.com/cloudformation/home?region=us-east-1#/stacks/create/review' +
        '?templateURL=https%3A%2F%2Fb.s3.us-east-1.amazonaws.com%2Fbootstrap%2Fv1%2Fbootstrap-template-v1.json' +
        '&stackName=deployz-bootstrap-app-12345678&param_ControlPlaneUrl=https%3A%2F%2Fapi.deployz.dev&param_EnrollmentCode=abc',
    );
    expect(parsed).toEqual({
      templateUrl: 'https://b.s3.us-east-1.amazonaws.com/bootstrap/v1/bootstrap-template-v1.json',
      stackName: 'deployz-bootstrap-app-12345678',
      parameters: { ControlPlaneUrl: 'https://api.deployz.dev', EnrollmentCode: 'abc' },
    });
  });

  it('refuses a URL without a template or stack name', () => {
    expect(() => parseQuickCreateUrl('https://console.aws.amazon.com/#/stacks/create/review?stackName=x')).toThrow(
      'lacks templateURL/stackName',
    );
  });
});

describe('infrastructure comparison', () => {
  const snapshot: InfraSnapshot = {
    stackResourceCount: 40,
    rdsCount: 1,
    albCount: 1,
    targetGroupCount: 1,
    serviceCount: 1,
    bucketCount: 1,
    securityGroupCount: 3,
    stackStatus: 'CREATE_COMPLETE',
  };

  it('accepts an unchanged stack and a stack that CloudFormation updated', () => {
    expect(() => assertSameInfrastructure(snapshot, snapshot)).not.toThrow();
    expect(() => assertSameInfrastructure(snapshot, { ...snapshot, stackStatus: 'UPDATE_COMPLETE' })).not.toThrow();
  });

  it('names the resource kind that changed', () => {
    expect(() => assertSameInfrastructure(snapshot, { ...snapshot, rdsCount: 2 })).toThrow('rdsCount 1 → 2');
    expect(() => assertSameInfrastructure(snapshot, { ...snapshot, stackStatus: 'UPDATE_ROLLBACK_COMPLETE' })).toThrow(
      'application stack now UPDATE_ROLLBACK_COMPLETE',
    );
  });
});

describe('waiting', () => {
  it('returns the first non-null verdict and times out with the last observation', async () => {
    let reads = 0;
    const value = await waitFor('counter', async () => ++reads, (n) => (n >= 3 ? n : null), {
      timeoutMs: 5_000,
      intervalMs: 1,
    });
    expect(value).toBe(3);

    await expect(
      waitFor('never', async () => 'still waiting', () => null, {
        timeoutMs: 20,
        intervalMs: 5,
        describe: (v) => v,
      }),
    ).rejects.toThrow('waiting for never; last: still waiting');
  });

  it('knows which job states are terminal', () => {
    expect(isTerminalJobState('SUCCEEDED')).toBe(true);
    expect(isTerminalJobState('FAILED')).toBe(true);
    expect(isTerminalJobState('CANCELLED')).toBe(true);
    expect(isTerminalJobState('RUNNING')).toBe(false);
    expect(isTerminalJobState('WAITING')).toBe(false);
  });
});

describe('evidence summary', () => {
  it('renders the PASS/FAIL table, releases and jobs', () => {
    const run: RunRecord = {
      runId: 'r1',
      startedAt: '2026-09-03T09:00:00.000Z',
      finishedAt: '2026-09-03T10:30:00.000Z',
      apiUrl: 'https://api.deployz.dev',
      region: 'us-east-1',
      accountId: '151955775369',
      scenario: 'core',
      result: 'FAIL',
      releases: { v1: { id: 'rel-1', version: 'v1-r1', gitSha: 'abc', imageDigest: 'repo@sha256:1' } },
      markers: [],
      jobs: [{ id: 'job-1', type: 'DEPLOY_RELEASE', releaseTag: 'v1', state: 'FAILED', failureCode: 'ECS_DEPLOYMENT_FAILED' }],
      steps: [
        { index: 1, name: 'Preflight', scenario: 'core', startedAt: 't', status: 'PASS', details: {} },
        { index: 2, name: 'Deploy v1', scenario: 'core', startedAt: 't', status: 'FAIL', details: {}, error: 'job FAILED\nstack' },
      ],
    };
    const summary = renderSummary(run);
    expect(summary).toContain('# AWS Canary: FAIL');
    expect(summary).toContain('| 1 | Preflight | PASS |  |');
    expect(summary).toContain('| 2 | Deploy v1 | FAIL | job FAILED |');
    expect(summary).toContain('- v1: version `v1-r1`, gitSha `abc`, digest `repo@sha256:1`');
    expect(summary).toContain('- DEPLOY_RELEASE v1: `job-1` → FAILED (ECS_DEPLOYMENT_FAILED)');
  });
});
