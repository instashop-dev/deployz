import { describe, expect, it, vi } from 'vitest';

import { memoryPendingStore, toPendingStore, type PendingCommand } from './pending.js';

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

describe('toPendingStore', () => {
  it('writes the pending command as a parameter under the installation', async () => {
    const send = vi.fn().mockResolvedValue({});

    await toPendingStore({ send }, '/deployz/inst-1/pending-command').write(PENDING);

    const input = (send.mock.calls[0]![0] as { input: Record<string, unknown> }).input;
    expect(input).toMatchObject({
      Name: '/deployz/inst-1/pending-command',
      Type: 'String',
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

  it('treats clearing an absent parameter as done', async () => {
    const error = new Error('not found');
    error.name = 'ParameterNotFound';
    const send = vi.fn().mockRejectedValue(error);

    await expect(toPendingStore({ send }, '/p').clear()).resolves.toBe(true);
  });

  it('reports a failed clear so the caller does not assume it is gone', async () => {
    const send = vi.fn().mockRejectedValue(new Error('AccessDeniedException'));

    await expect(toPendingStore({ send }, '/p').clear()).resolves.toBe(false);
  });
});
