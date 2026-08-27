import { describe, expect, it, vi } from 'vitest';

import type { ScheduledEvent } from 'aws-lambda';

import { type FetchFn, type SecretsClient } from './auth.js';
import { IdempotencyStore, type CommandExecutor } from './commands.js';
import {
  createInstallExecutor,
  createInstallResumer,
  createRelayHandler,
  createVerifyingExecutor,
  readInstallParametersFromPayload,
  readVerifyOptionsFromPayload,
  type InstallExecutorDeps,
} from './index.js';
import { memoryPendingStore } from './pending.js';
import type { VerificationResult } from './verify.js';

// Fast stub for the §59 observe hook — the default falls back to a real
// CloudFormationReader, which would otherwise reach out to AWS on every
// poll cycle these integration tests run. No test in this file exercises
// `observe` behavior itself, so a fixed "verified" result is fine everywhere.
const stubObserve = async (): Promise<VerificationResult> => ({
  verified: true,
  checks: [],
});

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeScheduledEvent(time?: string): ScheduledEvent {
  return {
    version: '0',
    id: 'event-id',
    'detail-type': 'Scheduled Event',
    source: 'aws.events',
    account: '123456789012',
    time: time ?? new Date().toISOString(),
    region: 'us-east-1',
    resources: ['arn:aws:events:us-east-1:123456789012:rule/relay-schedule'],
    detail: {},
  };
}

function makeSecretsClient(token: string): SecretsClient {
  return {
    async getSecretValue() {
      return { SecretString: JSON.stringify({ token }) };
    },
  };
}

function makeFetchFn(
  registerStatus = 200,
  commandsBody: unknown = { commands: [] },
): FetchFn {
  return async (url, init) => {
    void init;
    if (url.includes('/api/relay/register')) {
      return {
        status: registerStatus,
        headers: { get: () => null },
        json: async () => ({}),
      };
    }
    if (url.includes('/api/relay/commands')) {
      return {
        status: 200,
        headers: { get: () => null },
        json: async () => commandsBody,
      };
    }
    if (url.includes('/result')) {
      return { status: 200, headers: { get: () => null }, json: async () => ({}) };
    }
    if (url.includes('/api/relay/health')) {
      return { status: 200, headers: { get: () => null }, json: async () => ({}) };
    }
    return { status: 404, headers: { get: () => null }, json: async () => ({}) };
  };
}

function setEnv(vars: Record<string, string | undefined>): () => void {
  const prev: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(vars)) {
    prev[key] = process.env[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  return () => {
    for (const [key] of Object.entries(vars)) {
      if (prev[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = prev[key];
      }
    }
  };
}

// ── Handler integration tests ────────────────────────────────────────────────

describe('relay handler (integration)', () => {
  it('completes a full poll cycle: register → fetch → execute → report', async () => {
    const restore = setEnv({
      DEPLOYZ_INSTALLATION_ID: 'inst-int',
      DEPLOYZ_CREDENTIAL_SECRET_ARN: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:test',
      DEPLOYZ_CONTROL_PLANE_URL: 'https://api.deployz.dev',
      DEPLOYZ_ENROLLMENT_CODE: 'code-int',
    });

    try {
      const secretsClient = makeSecretsClient('tok-integration');
      const fetchFn = makeFetchFn(200, {
        commands: [
          {
            id: 'job-int-001',
            deploymentId: 'dep-int-001',
            type: 'INSTALL',
            idempotencyKey: 'ik-int-001',
            payload: { releaseId: 'rel-int-001' },
          },
        ],
      });

      // Inject a fake INSTALL executor so this test exercises the poll
      // cycle (register → fetch → execute → report) without reaching AWS —
      // the default executors call the real CloudFormationReader.
      const executors: Record<string, CommandExecutor> = {
        INSTALL: async (cmd) => ({
          commandId: cmd.id,
          idempotencyKey: cmd.idempotencyKey,
          success: true,
          output: { executed: true, type: cmd.type },
        }),
      };

      const handler = createRelayHandler({ secretsClient, fetchFn, executors, observe: stubObserve });
      const event = makeScheduledEvent();

      // Should not throw.
      await handler(event);
    } finally {
      restore();
    }
  });

  it('logs error when env vars are missing', async () => {
    const restore = setEnv({
      DEPLOYZ_INSTALLATION_ID: undefined,
      DEPLOYZ_CREDENTIAL_SECRET_ARN: undefined,
      DEPLOYZ_CONTROL_PLANE_URL: undefined,
      DEPLOYZ_ENROLLMENT_CODE: undefined,
    });

    try {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const secretsClient = makeSecretsClient('tok');
      const fetchFn = makeFetchFn(200);

      const handler = createRelayHandler({ secretsClient, fetchFn });
      await handler(makeScheduledEvent());

      expect(consoleSpy).toHaveBeenCalled();
      const call = consoleSpy.mock.calls[0]?.[0];
      expect(call).toContain('relay:missing-config');

      consoleSpy.mockRestore();
    } finally {
      restore();
    }
  });

  it('logs error when credential read fails', async () => {
    const restore = setEnv({
      DEPLOYZ_INSTALLATION_ID: 'inst-err',
      DEPLOYZ_CREDENTIAL_SECRET_ARN: 'arn:...',
      DEPLOYZ_CONTROL_PLANE_URL: 'https://api.deployz.dev',
      DEPLOYZ_ENROLLMENT_CODE: 'code-int',
    });

    try {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const secretsClient: SecretsClient = {
        async getSecretValue() {
          throw new Error('AccessDenied');
        },
      };
      const fetchFn = makeFetchFn(200);

      const handler = createRelayHandler({ secretsClient, fetchFn });
      await handler(makeScheduledEvent());

      expect(consoleSpy).toHaveBeenCalled();
      const call = consoleSpy.mock.calls[0]?.[0];
      expect(call).toContain('relay:credential-read-failed');

      consoleSpy.mockRestore();
    } finally {
      restore();
    }
  });

  it('reuses auth state across invocations (warm container)', async () => {
    const restore = setEnv({
      DEPLOYZ_INSTALLATION_ID: 'inst-warm',
      DEPLOYZ_CREDENTIAL_SECRET_ARN: 'arn:...',
      DEPLOYZ_CONTROL_PLANE_URL: 'https://api.deployz.dev',
      DEPLOYZ_ENROLLMENT_CODE: 'code-int',
    });

    try {
      let secretCallCount = 0;
      const secretsClient: SecretsClient = {
        async getSecretValue() {
          secretCallCount += 1;
          return { SecretString: JSON.stringify({ token: 'tok-warm' }) };
        },
      };

      const fetchFn = makeFetchFn(200, { commands: [] });

      const handler = createRelayHandler({ secretsClient, fetchFn, observe: stubObserve });

      // First invocation — should read the secret.
      await handler(makeScheduledEvent());
      expect(secretCallCount).toBe(1);

      // Second invocation — should reuse cached auth state.
      await handler(makeScheduledEvent());
      expect(secretCallCount).toBe(1); // still 1, not re-read
    } finally {
      restore();
    }
  });

  it('executes commands with idempotency across invocations', async () => {
    const restore = setEnv({
      DEPLOYZ_INSTALLATION_ID: 'inst-idem',
      DEPLOYZ_CREDENTIAL_SECRET_ARN: 'arn:...',
      DEPLOYZ_CONTROL_PLANE_URL: 'https://api.deployz.dev',
      DEPLOYZ_ENROLLMENT_CODE: 'code-int',
    });

    try {
      const secretsClient = makeSecretsClient('tok-idem');
      const idempotency = new IdempotencyStore();

      let callCount = 0;
      const executors: Record<string, CommandExecutor> = {
        INSTALL: async (cmd) => {
          callCount += 1;
          return {
            commandId: cmd.id,
            idempotencyKey: cmd.idempotencyKey,
            success: true,
          };
        },
        REPORT_HEALTH: async (cmd) => ({
          commandId: cmd.id,
          idempotencyKey: cmd.idempotencyKey,
          success: true,
        }),
        DEPLOY_RELEASE: async (cmd) => ({
          commandId: cmd.id,
          idempotencyKey: cmd.idempotencyKey,
          success: true,
        }),
        ROLLBACK: async (cmd) => ({
          commandId: cmd.id,
          idempotencyKey: cmd.idempotencyKey,
          success: true,
        }),
        CONFIG_UPDATE: async (cmd) => ({
          commandId: cmd.id,
          idempotencyKey: cmd.idempotencyKey,
          success: true,
        }),
        DESTROY: async (cmd) => ({
          commandId: cmd.id,
          idempotencyKey: cmd.idempotencyKey,
          success: true,
        }),
      };

      const command = {
        id: 'job-idem',
        deploymentId: 'dep-idem',
        type: 'INSTALL' as const,
        idempotencyKey: 'ik-idem',
        payload: {},
      };

      const fetchFn = makeFetchFn(200, { commands: [command] });

      const handler = createRelayHandler({ secretsClient, fetchFn, executors, idempotency, observe: stubObserve });

      // First invocation — executes the command.
      await handler(makeScheduledEvent());
      expect(callCount).toBe(1);

      // Second invocation with same command — idempotent, no re-execution.
      await handler(makeScheduledEvent());
      expect(callCount).toBe(1); // still 1
    } finally {
      restore();
    }
  });
});

describe('INSTALL verification gate', () => {
  const command = {
    id: 'cmd-1',
    deploymentId: 'dep-1',
    type: 'INSTALL' as const,
    idempotencyKey: 'dep-1:INSTALL',
    payload: {},
  };

  it('fails the install when the account cannot be verified', async () => {
    const executor = createVerifyingExecutor(async () => ({
      verified: false,
      checks: [{ name: 'stack-exists', passed: false, detail: 'No CloudFormation stack named "deployz-app"' }],
      reason: 'No CloudFormation stack named "deployz-app"',
    }));

    const result = await executor(command);

    expect(result.success).toBe(false);
    expect(result.failureCode).toBe('STACK_CREATE_FAILED');
    expect(result.error).toContain('deployz-app');
    expect(result.output).toMatchObject({ checks: expect.any(Array) });
  });

  it('succeeds when the account verifies', async () => {
    const executor = createVerifyingExecutor(async () => ({
      verified: true,
      checks: [{ name: 'stack-exists', passed: true, detail: 'Stack "deployz-app" found' }],
    }));

    const result = await executor(command);

    expect(result.success).toBe(true);
    expect(result.failureCode).toBeUndefined();
  });

  it('fails the install when verification itself throws', async () => {
    const executor = createVerifyingExecutor(async () => {
      throw new Error('boom');
    });

    const result = await executor(command);

    expect(result.success).toBe(false);
    expect(result.failureCode).toBe('STACK_CREATE_FAILED');
  });
});

// The gate closes the same hole for DEPLOY_RELEASE and ROLLBACK: both mapped
// to the stub `noop` executor before this fix, so a vendor clicking "Deploy
// Update" after a correctly-gated INSTALL failure could still walk straight
// past the gate to a billable Healthy state over an empty account.
describe('DEPLOY_RELEASE / ROLLBACK verification gate', () => {
  it.each(['DEPLOY_RELEASE', 'ROLLBACK'] as const)(
    'fails %s when the account cannot be verified',
    async (type) => {
      const command = {
        id: `cmd-${type}`,
        deploymentId: 'dep-1',
        type,
        idempotencyKey: `dep-1:${type}`,
        payload: {},
      };

      const executor = createVerifyingExecutor(async () => ({
        verified: false,
        checks: [{ name: 'stack-exists', passed: false, detail: 'No CloudFormation stack named "deployz-app"' }],
        reason: 'No CloudFormation stack named "deployz-app"',
      }));

      const result = await executor(command);

      expect(result.success).toBe(false);
      expect(result.failureCode).toBe('STACK_CREATE_FAILED');
    },
  );

  it.each(['DEPLOY_RELEASE', 'ROLLBACK'] as const)('succeeds %s when the account verifies', async (type) => {
    const command = {
      id: `cmd-${type}`,
      deploymentId: 'dep-1',
      type,
      idempotencyKey: `dep-1:${type}`,
      payload: {},
    };

    const executor = createVerifyingExecutor(async () => ({
      verified: true,
      checks: [{ name: 'stack-exists', passed: true, detail: 'Stack "deployz-app" found' }],
    }));

    const result = await executor(command);

    expect(result.success).toBe(true);
    expect(result.failureCode).toBeUndefined();
  });
});

// The relay has command.payload in hand and, before this fix, ignored it —
// verifyInstallation always defaulted redisRequired to false. That let a
// deployment which genuinely requires Redis pass the relay gate over an
// account with no ElastiCache cluster, disagreeing with the operator CLI's
// `--redis` flag about the same installation.
describe('createVerifyingExecutor passes the command through to verify()', () => {
  it('hands the full command to the verify callback, not just the installation id', async () => {
    const command = {
      id: 'cmd-payload',
      deploymentId: 'dep-1',
      type: 'INSTALL' as const,
      idempotencyKey: 'dep-1:INSTALL',
      payload: { redisRequired: true, stackName: 'custom-stack' },
    };

    let seenCommand: typeof command | undefined;
    const executor = createVerifyingExecutor(async (_installationId, cmd) => {
      seenCommand = cmd as typeof command;
      return { verified: true, checks: [] };
    });

    await executor(command);

    expect(seenCommand?.payload).toEqual({ redisRequired: true, stackName: 'custom-stack' });
  });
});

describe('readVerifyOptionsFromPayload', () => {
  it('reads redisRequired and stackName when both are present and well-typed', () => {
    expect(readVerifyOptionsFromPayload({ redisRequired: true, stackName: 'deployz-app-custom' })).toEqual({
      redisRequired: true,
      stackName: 'deployz-app-custom',
    });
  });

  it('returns an empty object when the payload has neither field', () => {
    expect(readVerifyOptionsFromPayload({})).toEqual({});
  });

  it('ignores a non-boolean redisRequired rather than trusting it', () => {
    expect(readVerifyOptionsFromPayload({ redisRequired: 'true' })).toEqual({});
    expect(readVerifyOptionsFromPayload({ redisRequired: 1 })).toEqual({});
  });

  it('ignores a non-string or empty stackName rather than trusting it', () => {
    expect(readVerifyOptionsFromPayload({ stackName: 42 })).toEqual({});
    expect(readVerifyOptionsFromPayload({ stackName: '' })).toEqual({});
  });

  it('reads redisRequired: false explicitly, not just truthy values', () => {
    expect(readVerifyOptionsFromPayload({ redisRequired: false })).toEqual({ redisRequired: false });
  });
});

// ── The real INSTALL executor: provision, then prove it ──────────────────────

describe('createInstallExecutor', () => {
  const command = {
    id: 'cmd-1',
    deploymentId: 'dep-1',
    type: 'INSTALL' as const,
    idempotencyKey: 'dep-1:INSTALL',
    payload: {},
  };

  const verified: VerificationResult = {
    verified: true,
    checks: [{ name: 'stack-exists', passed: true, detail: 'Stack "deployz-app" found' }],
  };

  function makeInstallDeps(overrides: Partial<InstallExecutorDeps> = {}): InstallExecutorDeps {
    return {
      installationId: 'inst-1',
      templateUrl: 'https://example.com/application-template-v1.json',
      install: async () => ({ state: 'succeeded', status: 'CREATE_COMPLETE', outputs: {} }),
      verify: async () => verified,
      pending: memoryPendingStore(),
      now: () => '2026-08-26T12:00:00.000Z',
      ...overrides,
    };
  }

  it('creates the stack and reports success once verification agrees', async () => {
    const install = vi.fn(async () => ({
      state: 'succeeded' as const,
      status: 'CREATE_COMPLETE',
      outputs: { 'deployz-app-PublicEndpoint': 'app.example.com' },
    }));

    const result = await createInstallExecutor(makeInstallDeps({ install }))(command);

    expect(install).toHaveBeenCalledOnce();
    expect(result.success).toBe(true);
    expect(result.output).toMatchObject({
      stackStatus: 'CREATE_COMPLETE',
      outputs: { 'deployz-app-PublicEndpoint': 'app.example.com' },
      checks: expect.any(Array),
    });
  });

  it('passes the template URL, execution role and installation to the installer', async () => {
    const install = vi.fn(async () => ({
      state: 'succeeded' as const,
      status: 'CREATE_COMPLETE',
      outputs: {},
    }));

    await createInstallExecutor(
      makeInstallDeps({ install, executionRoleArn: 'arn:aws:iam::1:role/deployz/exec' }),
    )(command);

    expect(install.mock.calls[0]![0]).toMatchObject({
      installationId: 'inst-1',
      templateUrl: 'https://example.com/application-template-v1.json',
      executionRoleArn: 'arn:aws:iam::1:role/deployz/exec',
      stackName: 'deployz-app',
    });
  });

  it('reports the CloudFormation failure, and does not verify a stack that rolled back', async () => {
    const verify = vi.fn(async () => verified);
    const result = await createInstallExecutor(
      makeInstallDeps({
        verify,
        install: async () => ({
          state: 'failed',
          status: 'ROLLBACK_COMPLETE',
          reason: 'Stack "deployz-app" finished in ROLLBACK_COMPLETE - image pull failed',
          outputs: {},
        }),
      }),
    )(command);

    expect(result.success).toBe(false);
    expect(result.failureCode).toBe('STACK_CREATE_FAILED');
    expect(result.error).toContain('image pull failed');
    expect(verify).not.toHaveBeenCalled();
  });

  it('fails when CloudFormation says complete but verification disagrees', async () => {
    const result = await createInstallExecutor(
      makeInstallDeps({
        verify: async () => ({
          verified: false,
          checks: [{ name: 'compute', passed: false, detail: 'No complete ECS service' }],
          reason: 'No complete ECS service',
        }),
      }),
    )(command);

    expect(result.success).toBe(false);
    expect(result.failureCode).toBe('STACK_CREATE_FAILED');
    expect(result.error).toContain('ECS service');
  });

  it('defers - reporting nothing - while the stack is still creating', async () => {
    const result = await createInstallExecutor(
      makeInstallDeps({
        install: async () => ({ state: 'in-progress', status: 'CREATE_IN_PROGRESS' }),
      }),
    )(command);

    expect(result.deferred).toBe(true);
    expect(result.success).toBe(false);
    expect(result.failureCode).toBeUndefined();
  });

  it('records what it owes an answer to before deferring', async () => {
    const pending = memoryPendingStore();

    await createInstallExecutor(
      makeInstallDeps({
        pending,
        install: async () => ({ state: 'in-progress', status: 'CREATE_IN_PROGRESS' }),
      }),
    )({ ...command, payload: { redisRequired: true } });

    expect(await pending.read()).toEqual({
      commandId: 'cmd-1',
      idempotencyKey: 'dep-1:INSTALL',
      type: 'INSTALL',
      stackName: 'deployz-app',
      startedAt: '2026-08-26T12:00:00.000Z',
      payload: { redisRequired: true },
    });
  });

  it('fails rather than defers when the marker cannot be persisted', async () => {
    const pending = memoryPendingStore();
    pending.write = async () => false;

    const result = await createInstallExecutor(
      makeInstallDeps({
        pending,
        install: async () => ({ state: 'in-progress', status: 'CREATE_IN_PROGRESS' }),
      }),
    )(command);

    // Deferring without a durable marker would strand the job in RUNNING
    // forever - nothing would ever come back to report on it.
    expect(result.deferred).toBeUndefined();
    expect(result.success).toBe(false);
    expect(result.failureCode).toBe('STACK_CREATE_FAILED');
  });

  it('honours a stack name override from the payload', async () => {
    const install = vi.fn(async () => ({
      state: 'succeeded' as const,
      status: 'CREATE_COMPLETE',
      outputs: {},
    }));

    await createInstallExecutor(makeInstallDeps({ install }))({
      ...command,
      payload: { stackName: 'deployz-app-staging' },
    });

    expect(install.mock.calls[0]![0]).toMatchObject({ stackName: 'deployz-app-staging' });
  });

  it('refuses to install without a published template URL', async () => {
    const install = vi.fn();

    const result = await createInstallExecutor(
      makeInstallDeps({ install, templateUrl: '' }),
    )(command);

    expect(install).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(result.failureCode).toBe('STACK_CREATE_FAILED');
    expect(result.error).toMatch(/template/i);
  });
});

describe('createInstallResumer', () => {
  const pendingRecord = {
    commandId: 'cmd-1',
    idempotencyKey: 'dep-1:INSTALL',
    type: 'INSTALL',
    stackName: 'deployz-app',
    startedAt: '2026-08-26T12:00:00.000Z',
    payload: {},
  };

  function makeResumeDeps(overrides: Partial<InstallExecutorDeps> = {}): InstallExecutorDeps {
    return {
      installationId: 'inst-1',
      templateUrl: 'https://example.com/app.json',
      install: async () => ({ state: 'succeeded', status: 'CREATE_COMPLETE', outputs: {} }),
      verify: async () => ({ verified: true, checks: [] }),
      pending: memoryPendingStore(),
      now: () => '2026-08-26T12:05:00.000Z',
      ...overrides,
    };
  }

  it('reports nothing when no command is owed', async () => {
    await expect(createInstallResumer(makeResumeDeps())()).resolves.toEqual([]);
  });

  it('reports the finished result against the original command id', async () => {
    const pending = memoryPendingStore();
    await pending.write(pendingRecord);

    const results = await createInstallResumer(makeResumeDeps({ pending }))();

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      commandId: 'cmd-1',
      idempotencyKey: 'dep-1:INSTALL',
      success: true,
    });
  });

  it('clears the marker once the result has been produced', async () => {
    const pending = memoryPendingStore();
    await pending.write(pendingRecord);

    await createInstallResumer(makeResumeDeps({ pending }))();

    expect(await pending.read()).toBeNull();
  });

  it('keeps waiting, and keeps the marker, while the stack is still creating', async () => {
    const pending = memoryPendingStore();
    await pending.write(pendingRecord);

    const results = await createInstallResumer(
      makeResumeDeps({
        pending,
        install: async () => ({ state: 'in-progress', status: 'CREATE_IN_PROGRESS' }),
      }),
    )();

    expect(results).toEqual([]);
    expect(await pending.read()).toEqual(pendingRecord);
  });

  it('resumes against the stack the original command targeted', async () => {
    const pending = memoryPendingStore();
    await pending.write({ ...pendingRecord, stackName: 'deployz-app-staging' });
    const install = vi.fn(async () => ({
      state: 'succeeded' as const,
      status: 'CREATE_COMPLETE',
      outputs: {},
    }));

    await createInstallResumer(makeResumeDeps({ pending, install }))();

    expect(install.mock.calls[0]![0]).toMatchObject({ stackName: 'deployz-app-staging' });
  });

  it('carries the original payload into the resumed verification', async () => {
    const pending = memoryPendingStore();
    await pending.write({ ...pendingRecord, payload: { redisRequired: true } });
    const verify = vi.fn(async () => ({ verified: true, checks: [] }));

    await createInstallResumer(makeResumeDeps({ pending, verify }))();

    expect(verify.mock.calls[0]![0]).toMatchObject({ redisRequired: true });
  });

  it('reports a failed stack against the original command id', async () => {
    const pending = memoryPendingStore();
    await pending.write(pendingRecord);

    const results = await createInstallResumer(
      makeResumeDeps({
        pending,
        install: async () => ({
          state: 'failed',
          status: 'ROLLBACK_COMPLETE',
          reason: 'rolled back',
          outputs: {},
        }),
      }),
    )();

    expect(results[0]).toMatchObject({
      commandId: 'cmd-1',
      success: false,
      failureCode: 'STACK_CREATE_FAILED',
    });
  });
});

describe('readInstallParametersFromPayload', () => {
  it('forwards string parameters the control plane supplied', () => {
    expect(
      readInstallParametersFromPayload({
        parameters: { paramAppApiKey: 'k', paramAppSigningSecret: 's' },
      }),
    ).toEqual({ paramAppApiKey: 'k', paramAppSigningSecret: 's' });
  });

  it('is empty when the payload carries no parameters', () => {
    expect(readInstallParametersFromPayload({})).toEqual({});
  });

  it('drops non-string values rather than sending them to CloudFormation', () => {
    // Every CloudFormation parameter value is a string. A number or an
    // object here is a control-plane bug, and passing it through would
    // surface as an opaque ValidationError mid-install.
    expect(
      readInstallParametersFromPayload({ parameters: { a: 'ok', b: 7, c: null } }),
    ).toEqual({ a: 'ok' });
  });

  it('ignores a parameters field that is not an object', () => {
    expect(readInstallParametersFromPayload({ parameters: 'nope' })).toEqual({});
  });
});
