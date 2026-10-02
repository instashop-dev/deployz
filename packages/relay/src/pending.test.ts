import { describe, expect, it, vi } from 'vitest';

import {
  memoryPendingStore,
  toPendingStore,
  PENDING_MARKER_MAX_LENGTH,
  type PendingCommand,
} from './pending.js';

const PENDING: PendingCommand = {
  commandId: 'cmd-1',
  idempotencyKey: 'dep-1:INSTALL',
  type: 'INSTALL',
  stackName: 'deployz-app',
  startedAt: '2026-08-26T12:00:00.000Z',
  payload: { redisRequired: true },
};

/**
 * A fake SSM that stores one parameter value in memory. GetParameter is
 * identified by `WithDecryption`, PutParameter by `Overwrite`, and anything
 * else is treated as DeleteParameter — matching the commands this module
 * actually sends.
 */
function makeSsmFake(initial?: string): {
  send: ReturnType<typeof vi.fn>;
  read: () => string | undefined;
} {
  let stored = initial;
  const send = vi.fn(async (command: { input: Record<string, unknown> }) => {
    const input = command.input;
    if ('WithDecryption' in input) {
      if (stored === undefined) {
        const error = new Error('not found');
        error.name = 'ParameterNotFound';
        throw error;
      }
      return { Parameter: { Value: stored } };
    }
    if ('Overwrite' in input) {
      stored = input['Value'] as string;
      return {};
    }
    if (stored === undefined) {
      const error = new Error('not found');
      error.name = 'ParameterNotFound';
      throw error;
    }
    stored = undefined;
    return {};
  });
  return { send, read: () => stored };
}

describe('compareAndSet', () => {
  it('writes when the stored marker still belongs to the expected command', async () => {
    const store = toPendingStore(makeSsmFake(JSON.stringify(PENDING)), '/p');
    const settled: PendingCommand = {
      ...PENDING,
      phase: 'settled',
      result: { success: true, output: { executed: true } },
      settledAt: '2026-08-26T12:05:00.000Z',
    };

    await expect(store.compareAndSet('cmd-1', settled)).resolves.toBe(true);
    await expect(store.read()).resolves.toEqual(settled);
  });

  it('refuses to overwrite a newer command marker', async () => {
    const store = toPendingStore(makeSsmFake(JSON.stringify({ ...PENDING, commandId: 'cmd-2' })), '/p');
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(store.compareAndSet('cmd-1', null)).resolves.toBe(false);
    await expect(store.read()).resolves.toMatchObject({ commandId: 'cmd-2' });
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('relay:pending-cas-refused'));
    errorSpy.mockRestore();
  });

  it('clears when the stored marker belongs to the expected command', async () => {
    const store = toPendingStore(makeSsmFake(JSON.stringify(PENDING)), '/p');

    await expect(store.compareAndSet('cmd-1', null)).resolves.toBe(true);
    await expect(store.read()).resolves.toBeNull();
  });

  it('treats clearing an absent marker as done', async () => {
    const store = toPendingStore(makeSsmFake(), '/p');

    await expect(store.compareAndSet('cmd-1', null)).resolves.toBe(true);
  });

  it('refuses to create a marker when none exists', async () => {
    const store = toPendingStore(makeSsmFake(), '/p');
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(store.compareAndSet('cmd-1', PENDING)).resolves.toBe(false);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('relay:pending-cas-refused'));
    errorSpy.mockRestore();
  });

  it('reports false when the underlying write fails', async () => {
    const send = vi.fn(async (command: { input: Record<string, unknown> }) => {
      if ('WithDecryption' in command.input) {
        return { Parameter: { Value: JSON.stringify(PENDING) } };
      }
      throw new Error('AccessDeniedException');
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(
      toPendingStore({ send }, '/p').compareAndSet('cmd-1', { ...PENDING, phase: 'settled' }),
    ).resolves.toBe(false);
    errorSpy.mockRestore();
  });

  it('reports false when the underlying clear fails', async () => {
    const send = vi.fn(async (command: { input: Record<string, unknown> }) => {
      if ('WithDecryption' in command.input) {
        return { Parameter: { Value: JSON.stringify(PENDING) } };
      }
      throw new Error('AccessDeniedException');
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(toPendingStore({ send }, '/p').compareAndSet('cmd-1', null)).resolves.toBe(false);
    errorSpy.mockRestore();
  });

  it('memoryPendingStore writes, clears, refuses a newer marker, and treats absent as cleared', async () => {
    const store = memoryPendingStore();

    // Creating while absent is refused.
    await expect(store.compareAndSet('cmd-1', PENDING)).resolves.toBe(false);

    await store.write(PENDING);
    const settled: PendingCommand = { ...PENDING, phase: 'settled', result: { success: true } };
    await expect(store.compareAndSet('cmd-1', settled)).resolves.toBe(true);
    await expect(store.read()).resolves.toEqual(settled);

    await expect(store.compareAndSet('cmd-2', null)).resolves.toBe(false);
    await expect(store.compareAndSet('cmd-1', null)).resolves.toBe(true);
    await expect(store.read()).resolves.toBeNull();
    await expect(store.compareAndSet('cmd-1', null)).resolves.toBe(true);
  });
});

describe('settled marker fields', () => {
  it('round-trips phase, result and settledAt', async () => {
    const store = toPendingStore(makeSsmFake(), '/p');
    const settled: PendingCommand = {
      ...PENDING,
      phase: 'settled',
      result: {
        success: false,
        error: 'boom',
        failureCode: 'STACK_CREATE_FAILED',
        output: { stackStatus: 'ROLLBACK_COMPLETE' },
        evidence: {
          container: { exitCode: 1, stopCode: 'x', stoppedReason: 'y', stoppedTaskCount: 1 },
        },
      },
      settledAt: '2026-08-26T12:05:00.000Z',
    };

    await store.write(settled);

    await expect(store.read()).resolves.toEqual(settled);
  });

  it('parses a legacy marker with none of them as running', async () => {
    const send = vi.fn().mockResolvedValue({ Parameter: { Value: JSON.stringify(PENDING) } });

    const parsed = await toPendingStore({ send }, '/p').read();

    expect(parsed).toEqual(PENDING);
    expect(parsed).not.toHaveProperty('phase');
    expect(parsed).not.toHaveProperty('result');
    expect(parsed).not.toHaveProperty('settledAt');
  });

  it('drops a malformed result, an unknown phase and a non-string settledAt', async () => {
    const send = vi.fn().mockResolvedValue({
      Parameter: {
        Value: JSON.stringify({
          ...PENDING,
          phase: 'bogus',
          result: { success: 'yes' },
          settledAt: 42,
        }),
      },
    });

    const parsed = await toPendingStore({ send }, '/p').read();

    expect(parsed).toEqual(PENDING);
    expect(parsed).not.toHaveProperty('phase');
    expect(parsed).not.toHaveProperty('result');
    expect(parsed).not.toHaveProperty('settledAt');
  });

  it('keeps a result with only a success boolean and drops its malformed optional fields', async () => {
    const send = vi.fn().mockResolvedValue({
      Parameter: {
        Value: JSON.stringify({
          ...PENDING,
          phase: 'settled',
          result: { success: true, output: 'nope', error: 7, evidence: [] },
          settledAt: '2026-08-26T12:05:00.000Z',
        }),
      },
    });

    const parsed = await toPendingStore({ send }, '/p').read();

    expect(parsed).toMatchObject({ phase: 'settled', result: { success: true } });
    expect(parsed?.result).not.toHaveProperty('output');
    expect(parsed?.result).not.toHaveProperty('error');
    expect(parsed?.result).not.toHaveProperty('evidence');
  });
});


describe('memoryPendingStore', () => {
  it('round-trips a pending command', async () => {
    const store = memoryPendingStore();

    expect(await store.read()).toBeNull();
    expect(await store.write(PENDING)).toBe(true);
    expect(await store.read()).toEqual(PENDING);
    expect(await store.clear()).toBe(true);
    expect(await store.read()).toBeNull();
  });
});

describe('stackEventsCursor', () => {
  it('round-trips a marker that carries a stack-events cursor', async () => {
    let stored: string | undefined;
    const send = vi.fn().mockImplementation((command: { input: { Value?: string } }) => {
      if (command.input.Value !== undefined) stored = command.input.Value;
      return Promise.resolve({ Parameter: { Value: stored } });
    });
    const withCursor: PendingCommand = {
      ...PENDING,
      stackEventsCursor: { lastEventAt: '2026-08-26T12:03:00.000Z' },
    };

    const store = toPendingStore({ send }, '/p');
    await store.write(withCursor);

    await expect(store.read()).resolves.toEqual(withCursor);
  });

  it('round-trips a marker that carries deploy migration state', async () => {
    let stored: string | undefined;
    const send = vi.fn().mockImplementation((command: { input: { Value?: string } }) => {
      if (command.input.Value !== undefined) stored = command.input.Value;
      return Promise.resolve({ Parameter: { Value: stored } });
    });
    const withMigration: PendingCommand = {
      ...PENDING,
      migration: {
        taskArn: 'arn:aws:ecs:us-east-1:151955775369:task/app-cluster/migration-1',
        registeredArn: 'arn:aws:ecs:us-east-1:151955775369:task-definition/app:1',
        completedAt: '2026-08-26T12:05:00.000Z',
      },
    };

    const store = toPendingStore({ send }, '/p');
    await store.write(withMigration);

    await expect(store.read()).resolves.toEqual(withMigration);
  });

  it('tolerates a legacy marker JSON with no stackEventsCursor field', async () => {
    const send = vi.fn().mockResolvedValue({ Parameter: { Value: JSON.stringify(PENDING) } });

    const parsed = await toPendingStore({ send }, '/p').read();

    expect(parsed).toEqual(PENDING);
    expect(parsed).not.toHaveProperty('stackEventsCursor');
  });

  it('drops a malformed stackEventsCursor rather than rejecting the whole record', async () => {
    const send = vi.fn().mockResolvedValue({
      Parameter: { Value: JSON.stringify({ ...PENDING, stackEventsCursor: { lastEventAt: 42 } }) },
    });

    const parsed = await toPendingStore({ send }, '/p').read();

    expect(parsed).toEqual(PENDING);
    expect(parsed).not.toHaveProperty('stackEventsCursor');
  });
});

describe('toPendingStore', () => {
  it('writes the pending command as a parameter under the installation', async () => {
    const send = vi.fn().mockResolvedValue({});

    await toPendingStore({ send }, '/deployz/inst-1/pending-command').write(PENDING);

    const input = (send.mock.calls[0]![0] as { input: Record<string, unknown> }).input;
    expect(input).toMatchObject({
      Name: '/deployz/inst-1/pending-command',
      Type: 'SecureString',
      Overwrite: true,
      Value: JSON.stringify(PENDING),
    });
  });

  it('reads a previously written pending command back', async () => {
    const send = vi.fn().mockResolvedValue({
      Parameter: { Value: JSON.stringify(PENDING) },
    });

    await expect(toPendingStore({ send }, '/p').read()).resolves.toEqual(PENDING);
  });

  it('reads the SecureString marker with decryption — SSM returns ciphertext otherwise (CANARY-011)', async () => {
    // A fake that behaves like SSM: the plaintext only comes back when the
    // read asks for decryption; a plain read gets the KMS ciphertext.
    const send = vi.fn(async (command: { input: Record<string, unknown> }) => ({
      Parameter: {
        Type: 'SecureString',
        Value: command.input['WithDecryption'] === true ? JSON.stringify(PENDING) : 'AQICAHhMYO+ciphertext',
      },
    }));

    await expect(toPendingStore({ send }, '/p').read()).resolves.toEqual(PENDING);
    const input = (send.mock.calls[0]![0] as { input: Record<string, unknown> }).input;
    expect(input).toMatchObject({ Name: '/p', WithDecryption: true });
  });

  it('logs and reports nothing pending when the stored marker cannot be parsed', async () => {
    const send = vi.fn().mockResolvedValue({ Parameter: { Value: 'AQICAHhMYO+ciphertext' } });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(toPendingStore({ send }, '/p').read()).resolves.toBeNull();

    expect(errorSpy).toHaveBeenCalledWith(
      JSON.stringify({ event: 'relay:pending-marker-unreadable', parameterName: '/p' }),
    );
    errorSpy.mockRestore();
  });

  it('reports no pending command when the parameter has never been written', async () => {
    const error = new Error('not found');
    error.name = 'ParameterNotFound';
    const send = vi.fn().mockRejectedValue(error);

    await expect(toPendingStore({ send }, '/p').read()).resolves.toBeNull();
  });

  it('reports no pending command rather than throwing when the read is refused', async () => {
    const send = vi.fn().mockRejectedValue(new Error('AccessDeniedException'));

    await expect(toPendingStore({ send }, '/p').read()).resolves.toBeNull();
  });

  it('defaults a missing payload to an empty one rather than rejecting the record', async () => {
    const withoutPayload = {
      commandId: PENDING.commandId,
      idempotencyKey: PENDING.idempotencyKey,
      type: PENDING.type,
      stackName: PENDING.stackName,
      startedAt: PENDING.startedAt,
    };
    const send = vi.fn().mockResolvedValue({
      Parameter: { Value: JSON.stringify(withoutPayload) },
    });

    await expect(toPendingStore({ send }, '/p').read()).resolves.toEqual({
      ...withoutPayload,
      payload: {},
    });
  });

  it('reports no pending command when the stored value is not a command', async () => {
    const send = vi.fn().mockResolvedValue({ Parameter: { Value: 'not json' } });

    await expect(toPendingStore({ send }, '/p').read()).resolves.toBeNull();
  });

  it('reports a failed write instead of throwing', async () => {
    const send = vi.fn().mockRejectedValue(new Error('AccessDeniedException'));

    await expect(toPendingStore({ send }, '/p').write(PENDING)).resolves.toBe(false);
  });

  it('logs the swallowed error when the write is refused', async () => {
    const error = new Error('User is not authorized to perform ssm:PutParameter');
    error.name = 'AccessDeniedException';
    const send = vi.fn().mockRejectedValue(error);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(toPendingStore({ send }, '/p').write(PENDING)).resolves.toBe(false);

    expect(errorSpy).toHaveBeenCalledWith(
      JSON.stringify({
        event: 'relay:pending-write-failed',
        parameterName: '/p',
        error: { name: 'AccessDeniedException', message: error.message },
      }),
    );
    errorSpy.mockRestore();
  });

  it('refuses an oversized marker without calling SSM', async () => {
    const send = vi.fn();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const oversized: PendingCommand = {
      ...PENDING,
      payload: { blob: 'x'.repeat(PENDING_MARKER_MAX_LENGTH) },
    };

    await expect(toPendingStore({ send }, '/p').write(oversized)).resolves.toBe(false);

    expect(send).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('"event":"relay:pending-marker-too-large"'),
    );
    errorSpy.mockRestore();
  });

  it('treats clearing an absent parameter as done', async () => {
    const error = new Error('not found');
    error.name = 'ParameterNotFound';
    const send = vi.fn().mockRejectedValue(error);

    await expect(toPendingStore({ send }, '/p').clear()).resolves.toBe(true);
  });

  it('logs the swallowed error when a clear is refused for a reason other than already-gone', async () => {
    const send = vi.fn().mockRejectedValue(new Error('AccessDeniedException'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(toPendingStore({ send }, '/p').clear()).resolves.toBe(false);

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('"event":"relay:pending-clear-failed"'),
    );
    errorSpy.mockRestore();
  });

  it('reports a failed clear so the caller does not assume it is gone', async () => {
    const send = vi.fn().mockRejectedValue(new Error('AccessDeniedException'));

    await expect(toPendingStore({ send }, '/p').clear()).resolves.toBe(false);
  });
});
