import { describe, expect, it, vi } from 'vitest';

import type { ScheduledEvent } from 'aws-lambda';

import { type FetchFn, type SecretsClient } from './auth.js';
import { IdempotencyStore, type CommandExecutor } from './commands.js';
import { createRelayHandler } from './index.js';

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

      const handler = createRelayHandler({ secretsClient, fetchFn });
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

      const handler = createRelayHandler({ secretsClient, fetchFn });

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

      const handler = createRelayHandler({ secretsClient, fetchFn, executors, idempotency });

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