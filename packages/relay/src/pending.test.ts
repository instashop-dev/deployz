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
