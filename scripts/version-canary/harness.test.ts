import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { canaryTags, loadConfig, mintRunId, releaseVersionFor, requireRealAwsOptIn, validateDigest } from './config.js';
import { isTerminalJobState, waitFor, type ControlPlane } from './control-plane.js';
import { destroyThroughProduct, isConnectorSecret, isRetainedDatabaseSecret, relayFunctionName, removeCanaryLeftovers } from './teardown.js';
import { captureFailureDiagnostics, withDiagnosticsOnFailure, type DiagnosticsContext } from './diagnostics.js';
import { Evidence, renderSummary, type RunRecord } from './evidence.js';
import {
  assertSameInfrastructure,
  assertTargetsServing,
  expectedBindings,
  parseQuickCreateUrl,
  probeBaseUrl,
  type Canary,
  type InfraSnapshot,
} from './steps.js';
import { probeLiveApp, writeMarker } from './app.js';
import {
  aws,
  clientRequestTokenFor,
  createBootstrapStack,
  deleteStack,
  describeStack,
  disableRulesForStack,
  isTransientAwsCliError,
  liveNatGateways,
  type InstallationSecret,
} from './aws.js';

vi.mock('./aws.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./aws.js')>();
  return { ...actual, describeStack: vi.fn(), deleteStack: vi.fn(), disableRulesForStack: vi.fn() };
});

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

describe('digest validation', () => {
  it('accepts a valid sha256 digest', () => {
    const digest = `sha256:${'a'.repeat(64)}`;
    expect(validateDigest(digest)).toBe(digest);
  });

  it('accepts null and undefined as "not set"', () => {
    expect(validateDigest(null)).toBeNull();
    expect(validateDigest(undefined)).toBeNull();
    expect(validateDigest('')).toBeNull();
  });

  it('rejects a digest that is too short', () => {
    expect(() => validateDigest('sha256:abc')).toThrow('Invalid image digest');
  });

  it('rejects a digest without the sha256: prefix', () => {
    expect(() => validateDigest(`${'a'.repeat(64)}`)).toThrow('Invalid image digest');
  });

  it('rejects a digest with uppercase hex', () => {
    expect(() => validateDigest(`sha256:${'A'.repeat(64)}`)).toThrow('Invalid image digest');
  });
});

describe('existing-image config', () => {
  it('is unset by default', () => {
    expect(loadConfig({}).existingImageDigest).toBeNull();
  });

  it('reads from the env var', () => {
    const digest = `sha256:${'b'.repeat(64)}`;
    const config = loadConfig({ DEPLOYZ_E2E_EXISTING_IMAGE_DIGEST: digest });
    expect(config.existingImageDigest).toBe(digest);
  });

  it('prefers the override to the env var', () => {
    const envDigest = `sha256:${'c'.repeat(64)}`;
    const overrideDigest = `sha256:${'d'.repeat(64)}`;
    const config = loadConfig({ DEPLOYZ_E2E_EXISTING_IMAGE_DIGEST: envDigest }, { existingImageDigest: overrideDigest });
    expect(config.existingImageDigest).toBe(overrideDigest);
  });

  it('rejects an invalid digest from the env var', () => {
    expect(() => loadConfig({ DEPLOYZ_E2E_EXISTING_IMAGE_DIGEST: 'sha256:nothex' })).toThrow('Invalid image digest');
  });
});

describe('reuse-stack config', () => {
  it('is false by default', () => {
    expect(loadConfig({}).reuseStack).toBe(false);
  });

  it('accepts the override', () => {
    expect(loadConfig({}, { reuseStack: true }).reuseStack).toBe(true);
  });
});

describe('expectedBindings', () => {
  it('the legacy (profile-less) ladder requires postgres, never redis', () => {
    expect(expectedBindings(null)).toEqual({ database: true, redis: false });
  });

  it('a profile carries the requirements it certifies', () => {
    expect(expectedBindings({ name: 'pg', postgres: true, redis: false, fixtureRepo: 'x' })).toEqual({ database: true, redis: false });
    expect(expectedBindings({ name: 'stateless', postgres: false, redis: false, fixtureRepo: 'x' })).toEqual({ database: false, redis: false });
    expect(expectedBindings({ name: 'redis', postgres: false, redis: true, fixtureRepo: 'x' })).toEqual({ database: false, redis: true });
  });
});

describe('production-canary config', () => {
  it('is false by default — branch-testing mode with the template override', () => {
    expect(loadConfig({}).production).toBe(false);
  });

  it('reads DEPLOYZ_CANARY_PRODUCTION=1 from the env', () => {
    expect(loadConfig({ DEPLOYZ_CANARY_PRODUCTION: '1' }).production).toBe(true);
    expect(loadConfig({ DEPLOYZ_CANARY_PRODUCTION: '0' }).production).toBe(false);
  });

  it('the --production override wins over the env var', () => {
    expect(loadConfig({ DEPLOYZ_CANARY_PRODUCTION: '0' }, { production: true }).production).toBe(true);
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

describe('evidence: the vendor password never lands in run.json', () => {
  function newRun(runId: string): RunRecord {
    return {
      runId,
      startedAt: '2026-09-24T00:00:00.000Z',
      apiUrl: 'https://api.deployz.dev',
      region: 'us-east-1',
      accountId: '151955775369',
      scenario: 'core',
      releases: {},
      markers: [],
      jobs: [],
      steps: [],
    };
  }

  let resultsDir: string;

  afterEach(() => {
    if (resultsDir) rmSync(resultsDir, { recursive: true, force: true });
  });

  it('saveCredentials writes a separate credentials.json, not run.json', () => {
    resultsDir = mkdtempSync(join(tmpdir(), 'deployz-canary-test-'));
    const evidence = new Evidence(resultsDir, newRun('run-1'));
    evidence.run.vendor = { email: 'canary-run-1@deployz-canary.example.com' };
    evidence.saveCredentials('canary-run-1@deployz-canary.example.com', 'super-secret-password');
    evidence.save();

    const runJson = readFileSync(join(resultsDir, 'run-1', 'run.json'), 'utf8');
    expect(runJson).not.toContain('super-secret-password');
    expect(runJson).toContain('canary-run-1@deployz-canary.example.com');

    const credentials = JSON.parse(readFileSync(join(resultsDir, 'run-1', 'credentials.json'), 'utf8')) as {
      email: string;
      password: string;
    };
    expect(credentials).toEqual({ email: 'canary-run-1@deployz-canary.example.com', password: 'super-secret-password' });
  });

  it('loadCredentials reads it back for cleanup --run-id, and returns null when absent', () => {
    resultsDir = mkdtempSync(join(tmpdir(), 'deployz-canary-test-'));
    const evidence = new Evidence(resultsDir, newRun('run-2'));
    expect(evidence.loadCredentials()).toBeNull();

    evidence.saveCredentials('v@example.com', 'pw');
    const reopened = Evidence.open(resultsDir, 'run-2');
    expect(reopened.loadCredentials()).toEqual({ email: 'v@example.com', password: 'pw' });
  });
});

describe('live application endpoint', () => {
  // The default-HTTPS flow switches the ALB's port-80 listener to a 301 that
  // preserves `#{host}`, so the raw ALB DNS name redirects to itself over TLS
  // against a certificate that only covers `d-<deployment>.deployz.dev`.
  // Probing the endpoint recorded at install then reads as "the app answered
  // nothing" even though the deploy succeeded (real AWS, 2026-09-10).
  it('prefers the URL the product advertises over the endpoint recorded at install', () => {
    expect(
      probeBaseUrl('https://d-abc.deployz.dev', 'http://alb-1.us-east-1.elb.amazonaws.com'),
    ).toBe('https://d-abc.deployz.dev');
  });

  it('falls back to the ALB endpoint before a domain is configured', () => {
    expect(probeBaseUrl(null, 'http://alb-1.us-east-1.elb.amazonaws.com')).toBe(
      'http://alb-1.us-east-1.elb.amazonaws.com',
    );
    expect(probeBaseUrl(undefined, 'http://alb-1.us-east-1.elb.amazonaws.com')).toBe(
      'http://alb-1.us-east-1.elb.amazonaws.com',
    );
  });

  it('refuses to probe when there is no endpoint at all', () => {
    expect(() => probeBaseUrl(null, undefined)).toThrow('no endpoint to probe');
  });
});

describe('live probes over the public internet', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const jsonResponse = (body: unknown) =>
    new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

  it('retries a lost connection rather than reporting it as the app answering nothing', async () => {
    let calls = 0;
    vi.stubGlobal('fetch', async (url: string) => {
      calls++;
      if (calls === 1) throw new TypeError('fetch failed');
      return url.endsWith('/health')
        ? jsonResponse({ status: 'ok' })
        : jsonResponse({ version: 'v2', commit: 'abc', healthMode: 'ok' });
    });

    const probe = await probeLiveApp('https://d-abc.deployz.dev');
    expect(probe.healthStatus).toBe(200);
    expect(probe.version?.version).toBe('v2');
  });

  it('reports a persistent transport failure, so a dead app still fails the step', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('fetch failed');
    });

    const probe = await probeLiveApp('https://d-abc.deployz.dev');
    expect(probe.healthStatus).toBeNull();
    expect(probe.error).toContain('fetch failed');
  });

  it('never resends the write-once marker POST', async () => {
    let posts = 0;
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      if (init?.method === 'POST') {
        posts++;
        throw new TypeError('fetch failed');
      }
      return jsonResponse({});
    });

    await expect(writeMarker('https://d-abc.deployz.dev', 'K', 'v1')).rejects.toThrow('fetch failed');
    expect(posts).toBe(1);
  });
});

describe('leak audit: NAT gateways', () => {
  const arn = (id: string) => `arn:aws:ec2:us-east-1:151955775369:natgateway/${id}`;

  it('ignores one the tagging index still lists after deletion', async () => {
    // Real AWS, 2026-09-10: the audit reported nat-062a1224… as left behind
    // and EC2 answered NatGatewayNotFound for it.
    const left = await liveNatGateways('us-east-1', [arn('nat-deleted'), arn('nat-gone')], async (_r, id) =>
      id === 'nat-deleted' ? 'deleted' : null,
    );
    expect(left).toEqual([]);
  });

  it('still reports one the account really holds — it costs about $32/month', async () => {
    const left = await liveNatGateways('us-east-1', [arn('nat-live')], async () => 'available');
    expect(left).toEqual([arn('nat-live')]);
  });
});

describe('ALB target health of a serving version', () => {
  it('accepts a replaced task still draining after a rollout', () => {
    // Real AWS, run 20260910-120851-9df9 step 18: the v3 deploy had FAILED,
    // ECS had reverted to v2 and ran only the v2 digest, and the v3 task's
    // target was still deregistering.
    expect(() => assertTargetsServing(['healthy', 'draining'])).not.toThrow();
    expect(() => assertTargetsServing(['initial', 'healthy'])).not.toThrow();
  });

  it('rejects a target that is still failing its health check', () => {
    expect(() => assertTargetsServing(['healthy', 'unhealthy'])).toThrow('still unhealthy');
  });

  it('rejects a version nothing can reach', () => {
    expect(() => assertTargetsServing(['draining'])).toThrow('none healthy');
    expect(() => assertTargetsServing([])).toThrow('no targets');
  });
});

describe('teardown nudges the relay', () => {
  it('picks the relay out of the connector stack Lambdas', () => {
    // The names a real bootstrap stack records, in the order it records them.
    expect(
      relayFunctionName([
        'deployz-bootstrap-deployz-InstallIdFunctionE00E99D-uJpCL5wEYiRZ',
        'deployz-bootstrap-deployz-InstallIdProviderframewo-XkZmjygTHj83',
        'deployz-bootstrap-deployz-LogRetentionaae0aa3c5b4d-Xff5w3WjVlTQ',
        'deployz-bootstrap-deployz-ca-RelayFunctionD137DF95-BhoHfcVP23J0',
      ]),
    ).toBe('deployz-bootstrap-deployz-ca-RelayFunctionD137DF95-BhoHfcVP23J0');
  });

  it('has nothing to nudge when the run never recorded a connector', () => {
    expect(relayFunctionName([])).toBeUndefined();
    expect(relayFunctionName()).toBeUndefined();
  });

  it('runs the nudge between polls, and still returns the verdict', async () => {
    let ticks = 0;
    let reads = 0;
    const settled = await waitFor(
      'purge',
      async () => ++reads,
      (n) => (n >= 3 ? `done after ${n}` : null),
      { timeoutMs: 10_000, intervalMs: 1, onTick: async () => void ticks++ },
    );
    expect(settled).toBe('done after 3');
    expect(ticks).toBe(2);
  });
});

describe('retained database credential secrets (BUG-002)', () => {
  const secret = (name: string, tags: Record<string, string>, deletedDate: string | null = null): InstallationSecret => ({
    name,
    arn: `arn:aws:secretsmanager:us-east-1:1:secret:${name}`,
    deletedDate,
    tags,
  });

  it('treats an unprefixed, CloudFormation-generated name as retained when its logical id says so', () => {
    // CloudFormation names this template's secrets `<LogicalId>-<random>`
    // with no stack-name prefix at all (real run stage-b-repo-004-…).
    const dbSecret = secret('DatabaseSecret86DBB7B3-VgOM2g2GjldR', {
      'deployz:installation': '9a8aef85-865d-4583-9a61-7d89ea983b0a',
      'aws:cloudformation:logical-id': 'DatabaseSecret86DBB7B3',
    });
    const urlSecret = secret('DatabaseUrlSecretFA7DE062-cnJ1KWcterKP', {
      'deployz:installation': '9a8aef85-865d-4583-9a61-7d89ea983b0a',
      'aws:cloudformation:logical-id': 'DatabaseUrlSecretFA7DE062',
    });
    expect(isRetainedDatabaseSecret(dbSecret)).toBe(true);
    expect(isRetainedDatabaseSecret(urlSecret)).toBe(true);
  });

  it('does not count the delete-by-design app config secret or the connector credential as retained', () => {
    const appConfig = secret('AppConfigSecret251CAC1E-abc123', { 'aws:cloudformation:logical-id': 'AppConfigSecret251CAC1E' });
    const relayCredential = secret('RelayCredentialFromParam-xyz789', { 'aws:cloudformation:logical-id': 'RelayCredentialFromParam' });
    expect(isRetainedDatabaseSecret(appConfig)).toBe(false);
    expect(isRetainedDatabaseSecret(relayCredential)).toBe(false);
  });

  it('still fails the retained check when only non-database secrets survived Disconnect', () => {
    // Same predicate the real check filters with: an empty result here is
    // exactly what makes `verifyRetainedState` throw.
    const secrets = [
      secret('AppConfigSecret251CAC1E-abc', { 'aws:cloudformation:logical-id': 'AppConfigSecret251CAC1E' }),
      secret('RelayCredentialFromParam-xyz', { 'aws:cloudformation:logical-id': 'RelayCredentialFromParam' }),
    ];
    expect(secrets.filter(isRetainedDatabaseSecret)).toEqual([]);
  });

  it('excludes a secret already scheduled for deletion', () => {
    const scheduled = secret(
      'DatabaseSecret86DBB7B3-VgOM2g2GjldR',
      { 'aws:cloudformation:logical-id': 'DatabaseSecret86DBB7B3' },
      '2026-09-24T00:00:00.000Z',
    );
    expect(isRetainedDatabaseSecret(scheduled)).toBe(false);
  });
});

describe('the purged check ignores the connector secret (BUG-002)', () => {
  const secret = (name: string, tags: Record<string, string>): InstallationSecret => ({
    name,
    arn: `arn:aws:secretsmanager:us-east-1:1:secret:${name}`,
    deletedDate: null,
    tags,
  });

  it('excludes the connector credential by its bootstrap stack, not by a name prefix', () => {
    const bootstrapStackName = 'deployz-bootstrap-stage-b-repo-004-1306e305';
    const relayCredential = secret('RelayCredentialFromParam-xyz789', { 'aws:cloudformation:stack-name': bootstrapStackName });
    expect(isConnectorSecret(relayCredential, bootstrapStackName)).toBe(true);
  });

  it('also excludes it by the bootstrap component tag when the stack name is unavailable', () => {
    const relayCredential = secret('RelayCredentialFromParam-xyz789', { 'deployz:component': 'bootstrap' });
    expect(isConnectorSecret(relayCredential, null)).toBe(true);
  });

  it('does not exclude a retained-set secret that survived — the purge must have force-deleted it', () => {
    const dbSecret = secret('DatabaseSecret86DBB7B3-VgOM2g2GjldR', { 'aws:cloudformation:stack-name': 'deployz-app-9a8aef85' });
    expect(isConnectorSecret(dbSecret, 'deployz-bootstrap-stage-b-repo-004-1306e305')).toBe(false);
  });
});

describe('Disconnect after a timed-out step', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('lets the in-flight rollback settle before it requests the destroy (no 409)', async () => {
    vi.useFakeTimers();
    const rollback = (state: string) => ({ id: 'job-rollback', type: 'ROLLBACK', state });
    const detail = (state: string, jobs: unknown[], cleanupState: string | null = null) => ({
      id: 'dep-1',
      state,
      jobs,
      cleanupState,
      healthStatus: 'HEALTHY',
      relayStatus: 'CONNECTED',
      version: null,
      currentReleaseId: null,
      deploymentStatus: { stage: 'READY' },
    });
    const reads = [
      detail('UPDATING', [rollback('RUNNING')]),
      detail('UPDATING', [rollback('RUNNING')]),
      detail('HEALTHY', [rollback('SUCCEEDED')]),
      detail('DELETED', [rollback('SUCCEEDED'), { id: 'job-destroy', type: 'DESTROY', state: 'SUCCEEDED' }], 'COMPLETE'),
    ];
    const calls: string[] = [];
    const api = {
      getDeployment: vi.fn(async () => {
        calls.push('get');
        return reads.length > 1 ? reads.shift() : reads[0];
      }),
      destroy: vi.fn(async () => {
        calls.push('destroy');
        return { status: 202, body: {} };
      }),
    } as unknown as ControlPlane;
    const evidence = {
      run: { deploymentId: 'dep-1', releases: {} },
      step: async (_name: string, fn: (details: Record<string, unknown>) => Promise<unknown>) => fn({}),
    } as unknown as Evidence;

    const done = destroyThroughProduct({ config: loadConfig({}), evidence, api } as Canary);
    await vi.runAllTimersAsync();
    await done;

    expect(api.destroy).toHaveBeenCalledTimes(1);
    expect(calls.indexOf('destroy')).toBe(3);
  });
});

describe('removeCanaryLeftovers never deletes the connector before Purge completes (BUG-003)', () => {
  afterEach(() => {
    vi.mocked(describeStack).mockReset();
    vi.mocked(deleteStack).mockReset();
    vi.mocked(disableRulesForStack).mockReset();
  });

  it('refuses while cleanupState is not COMPLETE, even without run.vendor (Stage B never sets it)', async () => {
    vi.mocked(describeStack).mockResolvedValueOnce({ status: 'UPDATE_COMPLETE' } as never);

    const run = {
      bootstrapStackName: 'deployz-bootstrap-stage-b-repo-004-1306e305',
      deploymentId: 'dep-1',
      installationId: 'inst-1',
      releases: {},
      // No `vendor` — a Stage B ledger never sets it (the vendor lives in
      // series.json), which is exactly what let BUG-003 through before.
    } as unknown as RunRecord;
    const evidence = {
      run,
      step: async (_name: string, fn: (details: Record<string, unknown>) => Promise<unknown>) => fn({}),
    } as unknown as Evidence;
    const api = { getDeployment: async () => ({ cleanupState: 'PENDING', jobs: [] }) } as unknown as ControlPlane;
    const canary: Canary = { config: loadConfig({}), evidence, api };

    await expect(removeCanaryLeftovers(canary)).rejects.toThrow('cleanupState is PENDING');
    expect(deleteStack).not.toHaveBeenCalled();
  });

  it('also refuses while a PURGE job is still active, even with cleanupState already COMPLETE', async () => {
    vi.mocked(describeStack).mockResolvedValueOnce({ status: 'UPDATE_COMPLETE' } as never);

    const run = {
      bootstrapStackName: 'deployz-bootstrap-stage-b-repo-004-1306e305',
      deploymentId: 'dep-1',
      installationId: 'inst-1',
      releases: {},
    } as unknown as RunRecord;
    const evidence = {
      run,
      step: async (_name: string, fn: (details: Record<string, unknown>) => Promise<unknown>) => fn({}),
    } as unknown as Evidence;
    const api = {
      getDeployment: async () => ({ cleanupState: 'COMPLETE', jobs: [{ id: 'j1', type: 'PURGE', state: 'RUNNING' }] }),
    } as unknown as ControlPlane;
    const canary: Canary = { config: loadConfig({}), evidence, api };

    await expect(removeCanaryLeftovers(canary)).rejects.toThrow('purge job j1 is still RUNNING');
    expect(deleteStack).not.toHaveBeenCalled();
  });

  it('refuses while cleanupState is SKIPPED_RELAY_OFFLINE — that needs an operator, not a rerun', async () => {
    vi.mocked(describeStack).mockResolvedValueOnce({ status: 'UPDATE_COMPLETE' } as never);

    const run = {
      bootstrapStackName: 'deployz-bootstrap-stage-b-repo-004-1306e305',
      deploymentId: 'dep-1',
      installationId: 'inst-1',
      releases: {},
    } as unknown as RunRecord;
    const evidence = {
      run,
      step: async (_name: string, fn: (details: Record<string, unknown>) => Promise<unknown>) => fn({}),
    } as unknown as Evidence;
    const api = {
      getDeployment: async () => ({ cleanupState: 'SKIPPED_RELAY_OFFLINE', jobs: [] }),
    } as unknown as ControlPlane;
    const canary: Canary = { config: loadConfig({}), evidence, api };

    await expect(removeCanaryLeftovers(canary)).rejects.toThrow('cleanupState is SKIPPED_RELAY_OFFLINE');
    expect(deleteStack).not.toHaveBeenCalled();
  });

  it('allows the connector deletion when no installationId was ever recorded — nothing retained to purge (DEPLOY-023)', async () => {
    // A run that failed before the relay enrolled or before an application
    // stack existed can only be force-completed to SKIPPED_RELAY_OFFLINE, so
    // the cleanupState guard alone would strand its connector forever.
    vi.mocked(describeStack)
      .mockResolvedValueOnce({ status: 'UPDATE_COMPLETE' } as never) // the pre-deletion check
      .mockResolvedValueOnce({ status: 'DELETE_COMPLETE' } as never); // waitFor's poll
    vi.mocked(deleteStack).mockResolvedValue(undefined);
    vi.mocked(disableRulesForStack).mockResolvedValue([]);
    let deploymentRead = false;

    const run = {
      bootstrapStackName: 'deployz-bootstrap-stage-b-repo-005-abcdef01',
      deploymentId: 'dep-2',
      releases: {},
      // No installationId — no application stack was ever created.
    } as unknown as RunRecord;
    const evidence = {
      run,
      step: async (_name: string, fn: (details: Record<string, unknown>) => Promise<unknown>) => fn({}),
    } as unknown as Evidence;
    const api = {
      getDeployment: async () => {
        deploymentRead = true;
        return { cleanupState: 'SKIPPED_RELAY_OFFLINE', jobs: [] };
      },
    } as unknown as ControlPlane;
    const canary: Canary = { config: loadConfig({}), evidence, api };

    await expect(removeCanaryLeftovers(canary)).resolves.toBeUndefined();
    expect(deleteStack).toHaveBeenCalledWith(canary.config.region, run.bootstrapStackName);
    // The product's state is irrelevant here — nothing retained means
    // nothing to check it against.
    expect(deploymentRead).toBe(false);
  });
});

describe('failure diagnostics (fake path — mocked control plane, no AWS)', () => {
  function fakeContext(overrides: Partial<RunRecord> = {}, apiOverrides: Record<string, unknown> = {}): DiagnosticsContext {
    const run: RunRecord = {
      runId: 'r1',
      startedAt: 't',
      apiUrl: 'https://api.deployz.dev',
      region: 'us-east-1',
      accountId: '151955775369',
      scenario: 'core',
      releases: {},
      markers: [],
      jobs: [],
      steps: [],
      ...overrides,
    };
    return {
      config: { region: 'us-east-1' } as unknown as DiagnosticsContext['config'],
      evidence: { run } as unknown as DiagnosticsContext['evidence'],
      api: {
        getDeployment: vi.fn().mockResolvedValue({
          state: 'FAILED',
          relayStatus: 'ONLINE',
          healthStatus: 'UNHEALTHY',
          cleanupState: null,
          deploymentStatus: { stage: 'FAILED' },
          jobs: [{ id: 'job-1', type: 'DEPLOY_RELEASE', state: 'FAILED' }],
        }),
        diagnostics: vi.fn().mockResolvedValue({ failureCode: 'ECS_DEPLOYMENT_FAILED' }),
        listReleases: vi.fn().mockResolvedValue([{ id: 'rel-1', version: 'v1', status: 'FAILED', failureReason: 'build failed' }]),
        buildFailure: vi.fn().mockResolvedValue({ evidence: 'exit code 1' }),
        ...apiOverrides,
      } as unknown as DiagnosticsContext['api'],
    };
  }

  it('captures deployment, control-plane diagnostics and the failed release build, when recorded', async () => {
    const canary = fakeContext({ deploymentId: 'dep-1', applicationId: 'app-1' });
    const result = await captureFailureDiagnostics(canary);
    expect(result.deployment).toMatchObject({ state: 'FAILED', relayStatus: 'ONLINE' });
    expect(result.controlPlaneDiagnostics).toEqual({ failureCode: 'ECS_DEPLOYMENT_FAILED' });
    expect(result.release).toEqual({ id: 'rel-1', version: 'v1', status: 'FAILED', failureReason: 'build failed' });
    expect(result.releaseBuildFailure).toEqual({ evidence: 'exit code 1' });
  });

  it('captures nothing but does not throw when the run recorded no ids yet', async () => {
    const canary = fakeContext();
    await expect(captureFailureDiagnostics(canary)).resolves.toEqual({});
  });

  it('one piece failing does not stop the others — recorded as an *Error field instead', async () => {
    const canary = fakeContext(
      { deploymentId: 'dep-1' },
      { getDeployment: vi.fn().mockRejectedValue(new Error('control plane unreachable')) },
    );
    const result = await captureFailureDiagnostics(canary);
    expect(result.deploymentError).toContain('control plane unreachable');
  });

  it('withDiagnosticsOnFailure attaches diagnostics and rethrows the original error unchanged', async () => {
    const canary = fakeContext({ deploymentId: 'dep-1' });
    const details: Record<string, unknown> = {};
    await expect(
      withDiagnosticsOnFailure(canary, details, async () => {
        throw new Error('deploy job FAILED');
      }),
    ).rejects.toThrow('deploy job FAILED');
    expect(details['diagnostics']).toBeDefined();
    expect((details['diagnostics'] as { deployment?: unknown }).deployment).toMatchObject({ state: 'FAILED' });
  });

  it('withDiagnosticsOnFailure never masks the original error with a diagnostics-capture failure', async () => {
    const canary = fakeContext(
      { deploymentId: 'dep-1' },
      { getDeployment: vi.fn().mockRejectedValue(new Error('unreachable')), diagnostics: vi.fn().mockRejectedValue(new Error('unreachable')) },
    );
    const details: Record<string, unknown> = {};
    await expect(
      withDiagnosticsOnFailure(canary, details, async () => {
        throw new Error('the real failure');
      }),
    ).rejects.toThrow('the real failure');
  });

  it('withDiagnosticsOnFailure returns fn\'s result untouched on success', async () => {
    const canary = fakeContext();
    const details: Record<string, unknown> = {};
    await expect(withDiagnosticsOnFailure(canary, details, async () => 'ok')).resolves.toBe('ok');
    expect(details['diagnostics']).toBeUndefined();
  });
});

describe('aws() CLI retry', () => {
  // Real AWS, 2026-09-17 22:33Z: two harness processes sharing one `aws
  // login` session both refreshed the session token at the same moment; one
  // `describe-stacks` call failed with this message while the next call a
  // few seconds later succeeded.
  const createOAuth2TokenError =
    'An error occurred (ValidationException) when calling the CreateOAuth2Token operation: ' +
    'The provided authorization grant is invalid, expired, revoked, or malformed';
  const throttlingError =
    'An error occurred (ThrottlingException) when calling the DescribeStacks operation: Rate exceeded';
  const expiredTokenError =
    'An error occurred (ExpiredTokenException) when calling the GetCallerIdentity operation: ' +
    'The security token included in the request is expired';
  const accessDeniedError =
    'An error occurred (AccessDenied) when calling the DescribeStacks operation: User is not authorized';
  const missingStackError =
    'An error occurred (ValidationError) when calling the DescribeStacks operation: ' +
    'Stack with id deployz-bootstrap-x does not exist';

  it('is transient for a lost session refresh and for throttling', () => {
    expect(isTransientAwsCliError(createOAuth2TokenError)).toBe(true);
    expect(isTransientAwsCliError(throttlingError)).toBe(true);
  });

  it('is not transient for a real token expiry, a denial, or a missing stack', () => {
    // ExpiredToken is a real expiry the operator must fix — never retried.
    expect(isTransientAwsCliError(expiredTokenError)).toBe(false);
    expect(isTransientAwsCliError(accessDeniedError)).toBe(false);
    expect(isTransientAwsCliError(missingStackError)).toBe(false);
  });

  function cliError(stderr: string): Error & { stderr: string } {
    return Object.assign(new Error('Command failed'), { stderr });
  }

  it('retries a transient failure with backoff and returns the eventual success', async () => {
    let calls = 0;
    const delays: number[] = [];
    const exec = async () => {
      calls++;
      if (calls < 3) throw cliError(throttlingError);
      return { stdout: '{"ok":true}' };
    };
    const delay = async (ms: number) => {
      delays.push(ms);
    };

    const result = await aws(['cloudformation', 'describe-stacks', '--stack-name', 'x'], 'us-east-1', exec, delay);

    expect(result).toEqual({ ok: true });
    expect(calls).toBe(3);
    expect(delays).toEqual([2000, 5000]);
  });

  it('gives up after five retries and rethrows the last error', async () => {
    let calls = 0;
    const exec = async () => {
      calls++;
      throw cliError(throttlingError);
    };

    await expect(
      aws(['cloudformation', 'describe-stacks'], 'us-east-1', exec, async () => {}),
    ).rejects.toThrow('aws cloudformation describe-stacks failed');
    // One initial attempt plus five retries.
    expect(calls).toBe(6);
  });

  it('never retries a non-transient failure', async () => {
    let calls = 0;
    const exec = async () => {
      calls++;
      throw cliError(accessDeniedError);
    };
    const delay = async () => {
      throw new Error('should not delay for a non-transient error');
    };

    await expect(aws(['cloudformation', 'describe-stacks'], 'us-east-1', exec, delay)).rejects.toThrow(
      'aws cloudformation describe-stacks failed',
    );
    expect(calls).toBe(1);
  });
});

describe('createBootstrapStack client-request-token', () => {
  // A retried create-stack after a lost response (ECONNRESET/getaddrinfo)
  // must not mint a second stack or throw AlreadyExistsException — a
  // deterministic token makes CloudFormation dedupe it and hand back the
  // original StackId instead.
  it('sanitizes to CloudFormation\'s token pattern, and is a no-op for a name that already fits', () => {
    expect(clientRequestTokenFor('deployz-bootstrap-app-12345678')).toBe('deployz-bootstrap-app-12345678');
    expect(clientRequestTokenFor('deployz.bootstrap_app/12345678')).toBe('deployz-bootstrap-app-12345678');
    expect(clientRequestTokenFor('-leading-dash')).toBe('leading-dash');
    expect(clientRequestTokenFor('x'.repeat(200))).toHaveLength(128);
  });

  it('passes the sanitized stack name as --client-request-token to the executor', async () => {
    let capturedArgs: string[] = [];
    const exec = async (_command: string, args: string[]) => {
      capturedArgs = args;
      return { stdout: '{"StackId":"arn:aws:cloudformation:us-east-1:151955775369:stack/x/abc"}' };
    };

    const stackId = await createBootstrapStack(
      'us-east-1',
      {
        stackName: 'deployz-bootstrap-app-12345678',
        templateUrl: 'https://b.s3.us-east-1.amazonaws.com/bootstrap/v1/bootstrap-template-v1.json',
        parameters: {},
        runId: 'run-1',
      },
      exec,
      async () => {},
    );

    expect(stackId).toBe('arn:aws:cloudformation:us-east-1:151955775369:stack/x/abc');
    const tokenIndex = capturedArgs.indexOf('--client-request-token');
    expect(tokenIndex).toBeGreaterThan(-1);
    expect(capturedArgs[tokenIndex + 1]).toBe(clientRequestTokenFor('deployz-bootstrap-app-12345678'));
    expect(capturedArgs[tokenIndex + 1]).toBe('deployz-bootstrap-app-12345678');
  });
});
