import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import { failureCodeEnum } from '@deployz/db';

import {
  DurableRuntime,
  InMemoryStateStore,
  type DurableWorkflow,
} from '../src/durable/durable-runtime.js';

import {
  EventEmitter,
  InMemoryEventStore,
} from '../src/jobs/event-emitter.js';

import {
  createInstallWorkflow,
  InMemoryDeploymentStateStore,
  PreflightError,
  type InstallInput,
  type InstallOutput,
} from '../src/jobs/install-workflow.js';

import {
  createDeployReleaseWorkflow,
  type DeployReleaseInput,
  type DeployReleaseOutput,
  type EcsUpdateResult,
  type InfraUpgradeResult,
  type MigrationResult,
} from '../src/jobs/deploy-release-workflow.js';

import type { ConfigEntry } from '../src/jobs/config-update-workflow.js';

import {
  runFullPreflight,
  checkConfigValidity,
  checkMigrationCommand,
  MIGRATION_COMMAND_MAX_LENGTH,
  type AwsApiCheckResult,
  type AwsUsabilityChecker,
  type EcrImageCheckResult,
  type EcrImageChecker,
  type FailedPreflightCheck,
  type ImageArchitectureCheckResult,
  type ImageHealthCheckResult,
  type PermissionCheckResult,
  type PermissionChecker,
  type PreflightEngineDeps,
  type PreflightInput,
  type PreflightResult,
  type QuotaCheckResult,
} from '../src/jobs/preflight-engine.js';

// ── Fixtures ─────────────────────────────────────────────────────────────

const FIXED_NOW = new Date('2026-08-20T00:00:00.000Z');
const DIGEST =
  'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

const ALLOWED_KEYS = ['DATABASE_URL', 'LOG_LEVEL', 'API_KEY'] as const;

function makeInput(overrides: Partial<PreflightInput> = {}): PreflightInput {
  return {
    region: 'us-east-1',
    installationId: 'install-1',
    relayContact: { installationId: 'install-1' },
    port: 3000,
    healthPath: '/health',
    requiredSecrets: [],
    configuredSecrets: [],
    requiredEnvVars: [],
    configuredEnvVars: [],
    ...overrides,
  };
}

interface EngineHarness {
  deps: PreflightEngineDeps;
  checkQuotas: Mock<(region: string) => Promise<QuotaCheckResult>>;
  checkHealth: Mock<(digest: string) => Promise<ImageHealthCheckResult>>;
}

function makeDeps(
  config: { quotaResult?: QuotaCheckResult; imageResult?: ImageHealthCheckResult } = {},
): EngineHarness {
  const checkQuotas = vi
    .fn<(region: string) => Promise<QuotaCheckResult>>()
    .mockResolvedValue(config.quotaResult ?? { ok: true });
  const checkHealth = vi
    .fn<(digest: string) => Promise<ImageHealthCheckResult>>()
    .mockResolvedValue(config.imageResult ?? { ok: true, digest: DIGEST });

  const deps: PreflightEngineDeps = {
    quotaChecker: { checkQuotas },
    imageHealthChecker: { checkHealth },
    allowedConfigKeys: [...ALLOWED_KEYS],
  };

  return { deps, checkQuotas, checkHealth };
}

/** Find a failed check by name, asserting it exists. */
function failedCheck(result: PreflightResult, name: string): FailedPreflightCheck {
  const found = result.failures.find((c) => c.check === name);
  expect(found, `expected a failure for check "${name}"`).toBeDefined();
  return found as FailedPreflightCheck;
}

// ── §61 provenance (documentation guard) ─────────────────────────────────

describe('§61 failure-code provenance', () => {
  it('every §61 code the engine emits exists in failureCodeEnum', () => {
    const engineCodes = [
      'REGION_NOT_SUPPORTED',
      'AWS_SCP_BLOCKED',
      'AWS_PERMISSION_DENIED',
      'QUOTA_EXCEEDED',
      'IMAGE_HEALTH_CHECK_FAILED',
      'MIGRATION_FAILED',
      'RELAY_DISCONNECTED',
      'STACK_CREATE_FAILED',
      'CONTAINER_START_FAILED',
      'DATABASE_CREATE_FAILED',
      'IMAGE_PULL_FAILED',
      'UNSUPPORTED_ARCHITECTURE',
      'MISSING_SECRET',
    ];
    for (const code of engineCodes) {
      expect((failureCodeEnum.enumValues as readonly string[]).includes(code)).toBe(true);
    }
  });

  it('INVALID_CONFIG is the §31 config-domain code (not a §61 code)', () => {
    expect((failureCodeEnum.enumValues as readonly string[]).includes('INVALID_CONFIG')).toBe(
      false,
    );
  });
});

// ── Full pass ────────────────────────────────────────────────────────────

describe('runFullPreflight — happy path', () => {
  it('passes with zero failures on a fully valid input', async () => {
    const { deps } = makeDeps();
    const result = await runFullPreflight(makeInput(), deps);

    expect(result.passed).toBe(true);
    expect(result.failures).toEqual([]);
    expect(result.failureCode).toBeUndefined();
    expect(result.checks.map((c) => c.check)).toEqual([
      'region',
      'scp',
      'quota',
      'config',
      'migration-command',
      'image-health',
      'relay-contact',
      'port',
      'health-endpoint',
      'secrets',
      'env-vars',
      'cloudformation-usable',
      'ecs-usable',
      'rds-usable',
      'image-available',
      'image-architecture',
      'aws-permission',
    ]);
    // Checks 12-17 are OPTIONAL AWS seams — makeDeps() injects none of them,
    // so they must all report as skipped passes, never failures.
    for (const name of [
      'cloudformation-usable',
      'ecs-usable',
      'rds-usable',
      'image-available',
      'image-architecture',
      'aws-permission',
    ]) {
      const check = result.checks.find((c) => c.check === name);
      expect(check).toEqual({ check: name, passed: true, skipped: true });
    }
  });

  it('calls the quota + image-health seams with the exact inputs', async () => {
    const harness = makeDeps();
    await runFullPreflight(
      makeInput({ imageDigest: DIGEST }),
      harness.deps,
    );

    expect(harness.checkQuotas).toHaveBeenCalledWith('us-east-1');
    expect(harness.checkHealth).toHaveBeenCalledWith(DIGEST);
  });
});

// ── Check 1: Region allowlist ────────────────────────────────────────────

describe('check 1 — region allowlist (§32)', () => {
  it('passes for an allowed region', async () => {
    const { deps } = makeDeps();
    const result = await runFullPreflight(makeInput({ region: 'eu-west-1' }), deps);
    expect(result.checks[0]).toEqual({ check: 'region', passed: true });
  });

  it('fails with REGION_NOT_SUPPORTED for a disallowed region', async () => {
    const { deps } = makeDeps();
    const result = await runFullPreflight(makeInput({ region: 'ap-southeast-3' }), deps);

    expect(result.passed).toBe(false);
    expect(result.failureCode).toBe('REGION_NOT_SUPPORTED');
    expect(failedCheck(result, 'region').failureCode).toBe('REGION_NOT_SUPPORTED');
  });
});

// ── Check 2: SCP blocks ──────────────────────────────────────────────────

describe('check 2 — SCP blocks (PENDING-AWS stub)', () => {
  it('the stub always passes and is present in the result', async () => {
    const { deps } = makeDeps();
    const result = await runFullPreflight(makeInput(), deps);
    expect(result.checks[1]).toEqual({ check: 'scp', passed: true });
  });

  it('a failed SCP check can never block a deploy until the real checker lands (PENDING-AWS)', async () => {
    // The stub returns a plain pass with no failureCode branch. This guards the
    // contract: until AWS Organizations/STS is wired (todo 14 harness), the SCP
    // check is a safe no-op — it does NOT fabricate a failure.
    const { deps } = makeDeps();
    const result = await runFullPreflight(makeInput(), deps);
    expect(result.failures.map((c) => c.check)).not.toContain('scp');
  });
});

// ── Check 3: Quotas ──────────────────────────────────────────────────────

describe('check 3 — service quotas (injectable seam)', () => {
  it('passes when the quota checker reports ok', async () => {
    const { deps } = makeDeps({ quotaResult: { ok: true } });
    const result = await runFullPreflight(makeInput(), deps);
    expect(result.checks.find((c) => c.check === 'quota')).toEqual({
      check: 'quota',
      passed: true,
    });
  });

  it('fails with QUOTA_EXCEEDED when a quota is exceeded', async () => {
    const { deps } = makeDeps({
      quotaResult: {
        ok: false,
        failureCode: 'QUOTA_EXCEEDED',
        reason: 'vCPU quota for Fargate exceeded',
        exceededQuotas: ['vCPU'],
      },
    });
    const result = await runFullPreflight(makeInput(), deps);

    expect(result.passed).toBe(false);
    const failure = failedCheck(result, 'quota');
    expect(failure.failureCode).toBe('QUOTA_EXCEEDED');
    expect(failure.reason).toContain('quota');
  });
});

// ── Check 4: Config validity ─────────────────────────────────────────────

describe('check 4 — config validity (§31)', () => {
  it('passes for valid config keys (pure checkConfigValidity)', () => {
    const entries: readonly ConfigEntry[] = [
      { key: 'DATABASE_URL', value: 'postgres://x', isSecret: false },
      { key: 'API_KEY', value: 'secret', isSecret: true },
    ];
    expect(checkConfigValidity(entries, [...ALLOWED_KEYS])).toEqual({
      check: 'config',
      passed: true,
    });
  });

  it('fails with INVALID_CONFIG for an unknown key (pure checkConfigValidity)', () => {
    const entries: readonly ConfigEntry[] = [
      { key: 'NOT_A_REAL_KEY', value: 'x', isSecret: false },
    ];
    const result = checkConfigValidity(entries, [...ALLOWED_KEYS]);
    expect(result.passed).toBe(false);
    if (!result.passed) {
      expect(result.failureCode).toBe('INVALID_CONFIG');
      expect(result.reason).toContain('NOT_A_REAL_KEY');
    }
  });

  it('fails the whole preflight when config entries are invalid', async () => {
    const { deps } = makeDeps();
    const result = await runFullPreflight(
      makeInput({
        configEntries: [{ key: 'BOGUS_KEY', value: 'x', isSecret: false }],
      }),
      deps,
    );

    expect(result.passed).toBe(false);
    expect(failedCheck(result, 'config').failureCode).toBe('INVALID_CONFIG');
  });
});

// ── Check 5: Migration command ───────────────────────────────────────────

describe('check 5 — migration command (§26)', () => {
  it('passes for a well-formed command (required or not)', () => {
    expect(checkMigrationCommand('node migrate.js up', true)).toEqual({
      check: 'migration-command',
      passed: true,
    });
    expect(checkMigrationCommand('node migrate.js up', false)).toEqual({
      check: 'migration-command',
      passed: true,
    });
  });

  it('passes when no migration is provided and none is required', () => {
    expect(checkMigrationCommand(undefined, false)).toEqual({
      check: 'migration-command',
      passed: true,
    });
  });

  it('fails with MIGRATION_FAILED when a migration is required but missing', () => {
    const result = checkMigrationCommand(undefined, true);
    expect(result.passed).toBe(false);
    if (!result.passed) {
      expect(result.failureCode).toBe('MIGRATION_FAILED');
      expect(result.reason).toContain('required');
    }
  });

  it('fails with MIGRATION_FAILED for a whitespace-only command (missing when required)', () => {
    const result = checkMigrationCommand('   ', true);
    expect(result.passed).toBe(false);
  });

  it('fails with MIGRATION_FAILED for a command with control characters', () => {
    const result = checkMigrationCommand('node migrate.js\u0000up', false);
    expect(result.passed).toBe(false);
    if (!result.passed) {
      expect(result.failureCode).toBe('MIGRATION_FAILED');
    }
  });

  it('fails with MIGRATION_FAILED for an over-length command', () => {
    const result = checkMigrationCommand('x'.repeat(MIGRATION_COMMAND_MAX_LENGTH + 1), false);
    expect(result.passed).toBe(false);
    if (!result.passed) {
      expect(result.failureCode).toBe('MIGRATION_FAILED');
    }
  });

  it('fails the whole preflight when a required migration is missing', async () => {
    const { deps } = makeDeps();
    const result = await runFullPreflight(
      makeInput({ migrationRequired: true, migrationCommand: undefined }),
      deps,
    );

    expect(result.passed).toBe(false);
    expect(failedCheck(result, 'migration-command').failureCode).toBe('MIGRATION_FAILED');
  });
});

// ── Check 6: Image health ────────────────────────────────────────────────

describe('check 6 — image health (injectable seam)', () => {
  it('passes when the image health checker reports ok', async () => {
    const { deps } = makeDeps({ imageResult: { ok: true, digest: DIGEST } });
    const result = await runFullPreflight(makeInput({ imageDigest: DIGEST }), deps);
    expect(result.checks.find((c) => c.check === 'image-health')).toEqual({
      check: 'image-health',
      passed: true,
    });
  });

  it('fails with IMAGE_HEALTH_CHECK_FAILED for an unhealthy image', async () => {
    const { deps } = makeDeps({
      imageResult: {
        ok: false,
        failureCode: 'IMAGE_HEALTH_CHECK_FAILED',
        reason: 'health probe returned 503',
      },
    });
    const result = await runFullPreflight(makeInput({ imageDigest: DIGEST }), deps);

    expect(result.passed).toBe(false);
    const failure = failedCheck(result, 'image-health');
    expect(failure.failureCode).toBe('IMAGE_HEALTH_CHECK_FAILED');
  });

  it('passes (skips) when no image digest is provided', async () => {
    const harness = makeDeps();
    const result = await runFullPreflight(makeInput({ imageDigest: undefined }), harness.deps);
    expect(result.checks.find((c) => c.check === 'image-health')).toEqual({
      check: 'image-health',
      passed: true,
    });
    expect(harness.checkHealth).not.toHaveBeenCalled();
  });
});

// ── Check 7: Relay connected ─────────────────────────────────────────────

describe('check 7 — relay connected', () => {
  it('passes when the relay contact matches the installation ID', async () => {
    const { deps } = makeDeps();
    const result = await runFullPreflight(
      makeInput({ relayContact: { installationId: 'install-1' } }),
      deps,
    );
    expect(result.checks.find((c) => c.check === 'relay-contact')).toEqual({
      check: 'relay-contact',
      passed: true,
    });
  });

  it('fails with RELAY_DISCONNECTED for a mismatched contact', async () => {
    const { deps } = makeDeps();
    const result = await runFullPreflight(
      makeInput({ relayContact: { installationId: 'install-999' } }),
      deps,
    );

    expect(result.passed).toBe(false);
    expect(failedCheck(result, 'relay-contact').failureCode).toBe('RELAY_DISCONNECTED');
  });

  it('fails with RELAY_DISCONNECTED when no contact has arrived', async () => {
    const { deps } = makeDeps();
    const result = await runFullPreflight(makeInput({ relayContact: undefined }), deps);

    expect(result.passed).toBe(false);
    expect(failedCheck(result, 'relay-contact').failureCode).toBe('RELAY_DISCONNECTED');
  });

  it('skipRelayContact reports a skipped pass regardless of relayContact', async () => {
    const { deps } = makeDeps();
    const result = await runFullPreflight(
      makeInput({ relayContact: undefined, skipRelayContact: true }),
      deps,
    );

    expect(result.passed).toBe(true);
    expect(result.checks.find((c) => c.check === 'relay-contact')).toEqual({
      check: 'relay-contact',
      passed: true,
      skipped: true,
    });
  });
});

// ── Checks 12-17: optional AWS-backed seams (items 2/3) ──────────────────

describe('checks 12-17 — optional AWS-backed seams', () => {
  function passingAwsResult(): AwsApiCheckResult {
    return { ok: true, detail: 'reachable' };
  }

  it('cloudformation-usable, ecs-usable, rds-usable pass when their checkers report ok', async () => {
    const { deps } = makeDeps();
    const cfnCheck = vi.fn<(region: string) => Promise<AwsApiCheckResult>>().mockResolvedValue(passingAwsResult());
    const ecsCheck = vi.fn<(region: string) => Promise<AwsApiCheckResult>>().mockResolvedValue(passingAwsResult());
    const rdsCheck = vi.fn<(region: string) => Promise<AwsApiCheckResult>>().mockResolvedValue(passingAwsResult());

    const result = await runFullPreflight(makeInput(), {
      ...deps,
      cloudFormationChecker: { check: cfnCheck },
      ecsChecker: { check: ecsCheck },
      rdsChecker: { check: rdsCheck },
    });

    expect(result.passed).toBe(true);
    expect(cfnCheck).toHaveBeenCalledWith('us-east-1');
    expect(ecsCheck).toHaveBeenCalledWith('us-east-1');
    expect(rdsCheck).toHaveBeenCalledWith('us-east-1');
    for (const name of ['cloudformation-usable', 'ecs-usable', 'rds-usable']) {
      expect(result.checks.find((c) => c.check === name)).toEqual({ check: name, passed: true });
    }
  });

  it('fails with the injected failure code when an AWS-usability checker reports not-ok', async () => {
    const { deps } = makeDeps();
    const cfnCheck: AwsUsabilityChecker = {
      check: vi.fn().mockResolvedValue({
        ok: false,
        failureCode: 'STACK_CREATE_FAILED',
        reason: 'CloudFormation API is not callable',
      }),
    };

    const result = await runFullPreflight(makeInput(), { ...deps, cloudFormationChecker: cfnCheck });

    expect(result.passed).toBe(false);
    expect(failedCheck(result, 'cloudformation-usable').failureCode).toBe('STACK_CREATE_FAILED');
  });

  it('image-available + image-architecture are skipped when no checker is injected', async () => {
    const { deps } = makeDeps();
    const result = await runFullPreflight(
      makeInput({ ecrRepositoryName: 'my-app', ecrImageTag: 'v1' }),
      deps,
    );

    expect(result.checks.find((c) => c.check === 'image-available')).toEqual({
      check: 'image-available',
      passed: true,
      skipped: true,
    });
    expect(result.checks.find((c) => c.check === 'image-architecture')).toEqual({
      check: 'image-architecture',
      passed: true,
      skipped: true,
    });
  });

  it('image-available + image-architecture are skipped when a checker is injected but no repo/tag given', async () => {
    const { deps } = makeDeps();
    const checkAvailable = vi.fn<() => Promise<EcrImageCheckResult>>();
    const checkArchitecture = vi.fn<() => Promise<ImageArchitectureCheckResult>>();
    const ecrImageChecker: EcrImageChecker = { checkAvailable, checkArchitecture };

    const result = await runFullPreflight(makeInput(), { ...deps, ecrImageChecker });

    expect(result.checks.find((c) => c.check === 'image-available')?.['skipped']).toBe(true);
    expect(checkAvailable).not.toHaveBeenCalled();
    expect(checkArchitecture).not.toHaveBeenCalled();
  });

  it('calls the ECR image checker with the exact repo/tag/region when both are provided', async () => {
    const { deps } = makeDeps();
    const checkAvailable = vi
      .fn<() => Promise<EcrImageCheckResult>>()
      .mockResolvedValue({ ok: true, detail: 'found' });
    const checkArchitecture = vi
      .fn<() => Promise<ImageArchitectureCheckResult>>()
      .mockResolvedValue({ ok: true, detail: 'x86-64' });

    const result = await runFullPreflight(
      makeInput({ ecrRepositoryName: 'my-app', ecrImageTag: 'v1' }),
      { ...deps, ecrImageChecker: { checkAvailable, checkArchitecture } },
    );

    expect(result.passed).toBe(true);
    expect(checkAvailable).toHaveBeenCalledWith('us-east-1', 'my-app', 'v1');
    expect(checkArchitecture).toHaveBeenCalledWith('us-east-1', 'my-app', 'v1');
  });

  it('fails with IMAGE_PULL_FAILED / UNSUPPORTED_ARCHITECTURE when the ECR checker reports not-ok', async () => {
    const { deps } = makeDeps();
    const checkAvailable = vi.fn<() => Promise<EcrImageCheckResult>>().mockResolvedValue({
      ok: false,
      failureCode: 'IMAGE_PULL_FAILED',
      reason: 'not found in ECR',
    });
    const checkArchitecture = vi.fn<() => Promise<ImageArchitectureCheckResult>>().mockResolvedValue({
      ok: false,
      failureCode: 'UNSUPPORTED_ARCHITECTURE',
      reason: 'arm64 not supported',
    });

    const result = await runFullPreflight(
      makeInput({ ecrRepositoryName: 'my-app', ecrImageTag: 'v1' }),
      { ...deps, ecrImageChecker: { checkAvailable, checkArchitecture } },
    );

    expect(result.passed).toBe(false);
    expect(failedCheck(result, 'image-available').failureCode).toBe('IMAGE_PULL_FAILED');
    expect(failedCheck(result, 'image-architecture').failureCode).toBe('UNSUPPORTED_ARCHITECTURE');
  });

  it('aws-permission is skipped when no permission checker is injected', async () => {
    const { deps } = makeDeps();
    const result = await runFullPreflight(makeInput(), deps);
    expect(result.checks.find((c) => c.check === 'aws-permission')).toEqual({
      check: 'aws-permission',
      passed: true,
      skipped: true,
    });
  });

  it('fails with AWS_PERMISSION_DENIED when the permission checker reports not-ok (item 3)', async () => {
    const { deps } = makeDeps();
    const checkPermission = vi
      .fn<(region: string) => Promise<PermissionCheckResult>>()
      .mockResolvedValue({
        ok: false,
        failureCode: 'AWS_PERMISSION_DENIED',
        reason: 'missing cloudformation:CreateStack',
      });
    const permissionChecker: PermissionChecker = { checkPermission };

    const result = await runFullPreflight(makeInput(), { ...deps, permissionChecker });

    expect(result.passed).toBe(false);
    expect(checkPermission).toHaveBeenCalledWith('us-east-1');
    expect(failedCheck(result, 'aws-permission').failureCode).toBe('AWS_PERMISSION_DENIED');
  });

  it('passes when the permission checker reports ok', async () => {
    const { deps } = makeDeps();
    const permissionChecker: PermissionChecker = {
      checkPermission: vi.fn().mockResolvedValue({ ok: true, detail: 'allowed' }),
    };

    const result = await runFullPreflight(makeInput(), { ...deps, permissionChecker });

    expect(result.checks.find((c) => c.check === 'aws-permission')).toEqual({
      check: 'aws-permission',
      passed: true,
    });
  });
});

// ── Aggregation ──────────────────────────────────────────────────────────

describe('aggregation — every failure collected, passed flag correct', () => {
  it('collects ALL failures (not just the first)', async () => {
    const { deps } = makeDeps({
      quotaResult: {
        ok: false,
        failureCode: 'QUOTA_EXCEEDED',
        reason: 'quota exceeded',
        exceededQuotas: ['vCPU'],
      },
      imageResult: {
        ok: false,
        failureCode: 'IMAGE_HEALTH_CHECK_FAILED',
        reason: 'unhealthy image',
      },
    });

    const result = await runFullPreflight(
      makeInput({
        region: 'ap-southeast-3',
        configEntries: [{ key: 'BOGUS', value: 'x', isSecret: false }],
        migrationRequired: true,
        migrationCommand: undefined,
        imageDigest: DIGEST,
        relayContact: undefined,
      }),
      deps,
    );

    expect(result.passed).toBe(false);
    // SCP is the only always-passing check, so 6 of 7 fail.
    expect(result.failures).toHaveLength(6);
    expect(result.failureCode).toBe('REGION_NOT_SUPPORTED');

    const codes = result.failures.map((c) => c.failureCode).sort();
    expect(codes).toEqual([
      'IMAGE_HEALTH_CHECK_FAILED',
      'INVALID_CONFIG',
      'MIGRATION_FAILED',
      'QUOTA_EXCEEDED',
      'REGION_NOT_SUPPORTED',
      'RELAY_DISCONNECTED',
    ]);
  });

  it('a single failure still sets passed=false with exactly one collected failure', async () => {
    const { deps } = makeDeps();
    const result = await runFullPreflight(makeInput({ region: 'moon-1' }), deps);

    expect(result.passed).toBe(false);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.failureCode).toBe('REGION_NOT_SUPPORTED');
  });
});

// ── Negative invariant: deployment never starts on failed preflight ──────

describe('negative invariant — deployment never starts on failed preflight', () => {
  it('the full engine reports failed for the region the workflows reject', async () => {
    const { deps } = makeDeps();
    const result = await runFullPreflight(makeInput({ region: 'ap-southeast-3' }), deps);
    expect(result.passed).toBe(false);
    expect(result.failureCode).toBe('REGION_NOT_SUPPORTED');
  });

  it('INSTALL workflow throws PreflightError before marking INSTALLING', async () => {
    const eventStore = new InMemoryEventStore();
    const emitter = new EventEmitter(eventStore, () => FIXED_NOW);
    const deploymentStore = new InMemoryDeploymentStateStore();
    const workflow = createInstallWorkflow({ emitter, deploymentStore });
    const runtime = new DurableRuntime(new InMemoryStateStore());

    const input: InstallInput = {
      deploymentId: 'deployment-1',
      customerId: 'customer-1',
      organizationId: 'org-1',
      jobId: 'job-1',
      installationId: 'install-1',
      region: 'ap-southeast-3',
      releaseId: 'release-1',
    };

    await expect(runtime.start(workflow, input, 'exec-install-fail')).rejects.toThrow(
      PreflightError,
    );

    // The downstream seam (deploymentStore.set) never transitioned INSTALLING.
    expect(await deploymentStore.get('deployment-1')).toBe('NOT_INSTALLED');
    // Only the region preflight event was emitted — no state transition.
    expect(eventStore.events.map((e) => e.eventType)).toEqual([
      'install.preflight.region',
    ]);
  });

  it('DEPLOY_RELEASE workflow throws PreflightError before any deploy seam runs', async () => {
    const eventStore = new InMemoryEventStore();
    const emitter = new EventEmitter(eventStore, () => FIXED_NOW);
    const deploymentStore = new InMemoryDeploymentStateStore();
    await deploymentStore.set('deployment-1', 'HEALTHY');

    const runMigration = vi
      .fn<() => Promise<MigrationResult>>()
      .mockResolvedValue({ ok: true });
    const updateService = vi
      .fn<() => Promise<EcsUpdateResult>>()
      .mockResolvedValue({ ok: true, digest: DIGEST });
    const upgradeInfraVersion = vi
      .fn<() => Promise<InfraUpgradeResult>>()
      .mockResolvedValue({ ok: true, version: 'runtime-v2' });
    const hasPendingRelease = vi.fn<() => Promise<boolean>>().mockResolvedValue(false);

    const workflow = createDeployReleaseWorkflow({
      emitter,
      deploymentStore,
      migrationRunner: { runMigration },
      ecsUpdater: { updateService },
      infraUpgrader: { upgradeInfraVersion },
      pendingReleaseChecker: { hasPendingRelease },
    });
    const runtime = new DurableRuntime(new InMemoryStateStore());

    const input: DeployReleaseInput = {
      deploymentId: 'deployment-1',
      customerId: 'customer-1',
      organizationId: 'org-1',
      jobId: 'job-1',
      installationId: 'install-1',
      region: 'ap-southeast-3',
      releaseId: 'release-2',
      releaseVersion: 'v2',
      imageDigest: DIGEST,
      migrationCommand: 'node migrate.js up',
      fromInfraVersion: 'runtime-v1',
      toInfraVersion: 'runtime-v2',
    };

    await expect(runtime.start(workflow, input, 'exec-deploy-fail')).rejects.toThrow(
      PreflightError,
    );

    // The downstream deploy seams were NEVER called.
    expect(runMigration).not.toHaveBeenCalled();
    expect(updateService).not.toHaveBeenCalled();
    expect(upgradeInfraVersion).not.toHaveBeenCalled();
    expect(hasPendingRelease).not.toHaveBeenCalled();

    // The deployment never left HEALTHY (no UPDATING transition).
    expect(await deploymentStore.get('deployment-1')).toBe('HEALTHY');

    // Only the preflight event was emitted, with a failure result.
    expect(eventStore.events.map((e) => e.eventType)).toEqual(['deploy.preflight']);
    expect(eventStore.events[0]?.result).toBe('failed:REGION_NOT_SUPPORTED');
  });
});
