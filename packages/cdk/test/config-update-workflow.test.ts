import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

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
  InMemoryDeploymentStateStore,
  PreflightError,
} from '../src/jobs/install-workflow.js';

import {
  createConfigUpdateWorkflow,
  ConfigUpdateError,
  maskSecrets,
  SECRET_MASK,
  validateConfigKeys,
  type ConfigEntry,
  type ConfigUpdateInput,
  type ConfigUpdateOutput,
  type ConfigValidationResult,
  type ConfigWriteResult,
} from '../src/jobs/config-update-workflow.js';

// ── Fixtures ─────────────────────────────────────────────────────────────

const FIXED_NOW = new Date('2026-08-20T00:00:00.000Z');

/** A secret value that must NEVER appear in events or output. */
const PLAINTEXT_SECRET = 'sk_live_never_leak_this_0123456789';

const ENTRIES: readonly ConfigEntry[] = [
  { key: 'LOG_LEVEL', value: 'info', isSecret: false },
  { key: 'API_KEY', value: PLAINTEXT_SECRET, isSecret: true },
];

const SECRET_ARN = 'arn:aws:secretsmanager:us-east-1:123456789012:secret:deployz/app-1-API_KEY-abc123';

function makeInput(overrides: Partial<ConfigUpdateInput> = {}): ConfigUpdateInput {
  return {
    deploymentId: 'deployment-1',
    customerId: 'customer-1',
    organizationId: 'org-1',
    jobId: 'job-1',
    installationId: 'install-1',
    entries: ENTRIES,
    ...overrides,
  };
}

interface WorkflowHarness {
  workflow: DurableWorkflow<ConfigUpdateInput, ConfigUpdateOutput>;
  runtime: DurableRuntime;
  eventStore: InMemoryEventStore;
  deploymentStore: InMemoryDeploymentStateStore;
  validate: Mock<() => Promise<ConfigValidationResult>>;
  write: Mock<() => Promise<ConfigWriteResult>>;
}

function makeHarness(
  config: { validationResult?: ConfigValidationResult; writeResult?: ConfigWriteResult } = {},
): WorkflowHarness {
  const eventStore = new InMemoryEventStore();
  const emitter = new EventEmitter(eventStore, () => FIXED_NOW);
  const deploymentStore = new InMemoryDeploymentStateStore();

  const validate = vi
    .fn<() => Promise<ConfigValidationResult>>()
    .mockResolvedValue(config.validationResult ?? { ok: true });
  const write = vi
    .fn<() => Promise<ConfigWriteResult>>()
    .mockResolvedValue(config.writeResult ?? { ok: true, secretArns: [SECRET_ARN] });

  const workflow = createConfigUpdateWorkflow({
    emitter,
    deploymentStore,
    configValidator: { validate },
    configWriter: { write },
  });
  const runtime = new DurableRuntime(new InMemoryStateStore());

  return { workflow, runtime, eventStore, deploymentStore, validate, write };
}

/** Seed the deployment in HEALTHY (a CONFIG_UPDATE precondition). */
async function seedHealthy(deploymentStore: InMemoryDeploymentStateStore): Promise<void> {
  await deploymentStore.set('deployment-1', 'HEALTHY');
}

/** Assert that a plaintext secret never appears in a value (deep string check). */
function expectNoPlaintext(value: unknown): void {
  expect(JSON.stringify(value)).not.toContain(PLAINTEXT_SECRET);
}

// ── Secret masking (§31) ─────────────────────────────────────────────────

describe('maskSecrets (§31 write-only)', () => {
  it('masks secret values and leaves non-secrets untouched', () => {
    const masked = maskSecrets(ENTRIES);
    expect(masked).toEqual([
      { key: 'LOG_LEVEL', value: 'info', isSecret: false },
      { key: 'API_KEY', value: SECRET_MASK, isSecret: true },
    ]);
  });

  it('never returns the plaintext secret value', () => {
    expect(JSON.stringify(maskSecrets(ENTRIES))).not.toContain(PLAINTEXT_SECRET);
  });
});

// ── Config validation (pure) ─────────────────────────────────────────────

describe('validateConfigKeys (§31 vendor defaults + customer overrides)', () => {
  const allowedKeys = ['LOG_LEVEL', 'API_KEY', 'TIMEOUT_MS'];

  it('accepts entries whose keys are all in the allowed set', () => {
    expect(validateConfigKeys(ENTRIES, allowedKeys)).toEqual({ ok: true });
  });

  it('rejects a key outside vendor defaults + customer overrides', () => {
    const result = validateConfigKeys(
      [{ key: 'UNKNOWN_KEY', value: 'x', isSecret: false }],
      allowedKeys,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failureCode).toBe('INVALID_CONFIG');
      expect(result.invalidKeys).toEqual(['UNKNOWN_KEY']);
    }
  });

  it('rejects an empty key', () => {
    const result = validateConfigKeys([{ key: '', value: 'x', isSecret: false }], allowedKeys);
    expect(result.ok).toBe(false);
  });

  it('rejects duplicate keys', () => {
    const result = validateConfigKeys(
      [
        { key: 'LOG_LEVEL', value: 'info', isSecret: false },
        { key: 'LOG_LEVEL', value: 'debug', isSecret: false },
      ],
      allowedKeys,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.invalidKeys).toEqual(['LOG_LEVEL']);
    }
  });
});

// ── CONFIG_UPDATE workflow ───────────────────────────────────────────────

describe('CONFIG_UPDATE workflow', () => {
  let harness: WorkflowHarness;

  beforeEach(() => {
    harness = makeHarness();
  });

  it('validates config, writes via relay, then suspends on health', async () => {
    await seedHealthy(harness.deploymentStore);

    const state = await harness.runtime.start(harness.workflow, makeInput(), 'exec-1');

    expect(state.status).toBe('WAITING_CALLBACK');
    expect(state.callbackToken).toBe('config:install-1:health-report');
    expect(state.history.map((h) => h.name)).toEqual(['validate-config', 'write-config']);

    // Config validated before writing.
    expect(harness.validate).toHaveBeenCalledTimes(1);
    expect(harness.validate).toHaveBeenCalledWith(ENTRIES);
    expect(harness.write).toHaveBeenCalledTimes(1);

    // Deployment stays HEALTHY (config update is non-disruptive).
    expect(await harness.deploymentStore.get('deployment-1')).toBe('HEALTHY');
  });

  it('WRITE-THROUGH: writes to the customer Secrets Manager via the relay with full entries', async () => {
    await seedHealthy(harness.deploymentStore);

    await harness.runtime.start(harness.workflow, makeInput(), 'exec-2');

    // The writer receives the deployment + installation ids and the FULL
    // entries (including the plaintext secret — the writer needs it to write
    // to the customer's Secrets Manager; only events/output mask it).
    expect(harness.write).toHaveBeenCalledWith('deployment-1', 'install-1', ENTRIES);
  });

  it('SECRET MASKING: never emits or returns the plaintext secret value', async () => {
    await seedHealthy(harness.deploymentStore);

    await harness.runtime.start(harness.workflow, makeInput(), 'exec-3');
    const completed = await harness.runtime.resume(
      harness.workflow,
      'exec-3',
      { installationId: 'install-1', healthy: true },
    );

    // No event carries the plaintext secret.
    for (const event of harness.eventStore.events) {
      expectNoPlaintext(event.payload);
      expectNoPlaintext(event.result);
    }

    // The output masks the secret value too (only the ARN surfaces).
    const output = completed.output as ConfigUpdateOutput;
    expectNoPlaintext(output);
    expect(output.appliedEntries).toContainEqual({
      key: 'API_KEY',
      value: SECRET_MASK,
      isSecret: true,
    });
    expect(output.secretArns).toEqual([SECRET_ARN]);
  });

  it('completes end-to-end to HEALTHY with masked entries + secret ARNs', async () => {
    await seedHealthy(harness.deploymentStore);

    await harness.runtime.start(harness.workflow, makeInput(), 'exec-4');
    const completed = await harness.runtime.resume(
      harness.workflow,
      'exec-4',
      { installationId: 'install-1', healthy: true },
    );

    expect(completed.status).toBe('COMPLETED');
    expect(completed.output).toEqual({
      status: 'HEALTHY',
      deploymentId: 'deployment-1',
      appliedEntries: [
        { key: 'LOG_LEVEL', value: 'info', isSecret: false },
        { key: 'API_KEY', value: SECRET_MASK, isSecret: true },
      ],
      secretArns: [SECRET_ARN],
    });
    expect(completed.history.map((h) => h.name)).toEqual([
      'validate-config',
      'write-config',
      'observe-health',
    ]);
    expect(await harness.deploymentStore.get('deployment-1')).toBe('HEALTHY');
  });

  it('emits every §62 event in order (happy path)', async () => {
    await seedHealthy(harness.deploymentStore);

    await harness.runtime.start(harness.workflow, makeInput(), 'exec-5');
    await harness.runtime.resume(
      harness.workflow,
      'exec-5',
      { installationId: 'install-1', healthy: true },
    );

    expect(harness.eventStore.events.map((e) => e.eventType)).toEqual([
      'config.validate',
      'config.write',
      'config.health',
      'config.state.healthy',
    ]);
  });

  it('rejects invalid config with INVALID_CONFIG and never writes', async () => {
    await seedHealthy(harness.deploymentStore);
    harness.validate.mockResolvedValue({
      ok: false,
      failureCode: 'INVALID_CONFIG',
      reason: 'config key "UNKNOWN_KEY" is not in vendor defaults or customer overrides',
      invalidKeys: ['UNKNOWN_KEY'],
    });

    await expect(
      harness.runtime.start(harness.workflow, makeInput(), 'exec-6'),
    ).rejects.toThrow(ConfigUpdateError);

    // The writer is never called after a failed validation.
    expect(harness.write).not.toHaveBeenCalled();

    const validateEvent = harness.eventStore.events.find(
      (e) => e.eventType === 'config.validate',
    );
    expect(validateEvent?.result).toBe('failed:INVALID_CONFIG');
  });

  it('fails with CONFIG_WRITE_FAILED when the relay write fails', async () => {
    await seedHealthy(harness.deploymentStore);
    harness.write.mockResolvedValue({
      ok: false,
      failureCode: 'CONFIG_WRITE_FAILED',
      reason: 'relay unreachable',
    });

    await expect(
      harness.runtime.start(harness.workflow, makeInput(), 'exec-7'),
    ).rejects.toThrow(ConfigUpdateError);

    const writeEvent = harness.eventStore.events.find(
      (e) => e.eventType === 'config.write',
    );
    expect(writeEvent?.result).toBe('failed:CONFIG_WRITE_FAILED');
  });

  it('rejects an unhealthy report and never confirms HEALTHY', async () => {
    await seedHealthy(harness.deploymentStore);

    await harness.runtime.start(harness.workflow, makeInput(), 'exec-8');

    await expect(
      harness.runtime.resume(
        harness.workflow,
        'exec-8',
        { installationId: 'install-1', healthy: false },
      ),
    ).rejects.toThrow(PreflightError);

    expect(harness.eventStore.events.some((e) => e.eventType === 'config.health')).toBe(true);
    expect(
      harness.eventStore.events.some((e) => e.eventType === 'config.state.healthy'),
    ).toBe(false);
  });

  it('is idempotent on re-resume of a completed workflow', async () => {
    await seedHealthy(harness.deploymentStore);

    await harness.runtime.start(harness.workflow, makeInput(), 'exec-9');
    const first = await harness.runtime.resume(
      harness.workflow,
      'exec-9',
      { installationId: 'install-1', healthy: true },
    );
    const second = await harness.runtime.resume(
      harness.workflow,
      'exec-9',
      { installationId: 'install-1', healthy: true },
    );

    expect(second.status).toBe('COMPLETED');
    expect(second).toEqual(first);
    expect(harness.eventStore.count).toBe(4);
    expect(harness.write).toHaveBeenCalledTimes(1);
  });
});
