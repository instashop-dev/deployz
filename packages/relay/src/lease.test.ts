import { afterEach, describe, expect, it, vi } from 'vitest';

import { LEASE_MARGIN_MS, createLease, leaseParameterName, withLease } from './lease.js';

const NAME = leaseParameterName('inst-1');

function awsError(name: string): Error {
  const error = new Error(name);
  error.name = name;
  return error;
}

/** A fake SSM holding one parameter. PutParameter honours Overwrite=false. */
function makeSsmFake(initial?: string, failReads = false) {
  let stored = initial;
  const client = {
    send: vi.fn(async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
      const kind = command.constructor.name;
      if (kind === 'GetParameterCommand') {
        if (failReads) throw awsError('InternalServerError');
        if (stored === undefined) throw awsError('ParameterNotFound');
        return { Parameter: { Value: stored } };
      }
      if (kind === 'DeleteParameterCommand') {
        if (stored === undefined) throw awsError('ParameterNotFound');
        stored = undefined;
        return {};
      }
      if (stored !== undefined && command.input['Overwrite'] === false) {
        throw awsError('ParameterAlreadyExists');
      }
      stored = command.input['Value'] as string;
      return {};
    }),
  };
  return { client, read: () => stored };
}

const record = (invocationId: string, expiresAt: number) =>
  JSON.stringify({ invocationId, expiresAt });

describe('createLease', () => {
  it('acquires a free lease and records the owner and expiry', async () => {
    const ssm = makeSsmFake();
    const lease = createLease({
      client: ssm.client,
      parameterName: NAME,
      invocationId: 'a',
      runMs: 1000,
      now: () => 10_000,
    });
    expect(await lease.acquire()).toBe(true);
    expect(JSON.parse(ssm.read()!)).toEqual({
      invocationId: 'a',
      expiresAt: 10_000 + 1000 + LEASE_MARGIN_MS,
    });
  });

  it('skips the invocation while another lease is live', async () => {
    const ssm = makeSsmFake(record('other', 50_000));
    const lease = createLease({
      client: ssm.client,
      parameterName: NAME,
      invocationId: 'a',
      now: () => 10_000,
    });
    expect(await lease.acquire()).toBe(false);
    expect(JSON.parse(ssm.read()!).invocationId).toBe('other');
  });

  it('takes over an expired lease', async () => {
    const ssm = makeSsmFake(record('other', 5_000));
    const lease = createLease({
      client: ssm.client,
      parameterName: NAME,
      invocationId: 'a',
      now: () => 10_000,
    });
    expect(await lease.acquire()).toBe(true);
    expect(JSON.parse(ssm.read()!).invocationId).toBe('a');
  });

  it('takes over an unreadable lease record', async () => {
    const ssm = makeSsmFake('not json');
    const lease = createLease({ client: ssm.client, parameterName: NAME, invocationId: 'a' });
    expect(await lease.acquire()).toBe(true);
  });

  it('skips the invocation when the lease cannot be read', async () => {
    const ssm = makeSsmFake(record('other', 5_000), true);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const lease = createLease({
      client: ssm.client,
      parameterName: NAME,
      invocationId: 'a',
      now: () => 10_000,
    });
    expect(await lease.acquire()).toBe(false);
    expect(JSON.parse(ssm.read()!).invocationId).toBe('other');
  });

  it('releases only its own lease', async () => {
    const own = makeSsmFake();
    const ownLease = createLease({ client: own.client, parameterName: NAME, invocationId: 'a' });
    await ownLease.acquire();
    await ownLease.release();
    expect(own.read()).toBeUndefined();

    const foreign = makeSsmFake(record('other', 99_999_999_999_999));
    const foreignLease = createLease({
      client: foreign.client,
      parameterName: NAME,
      invocationId: 'a',
    });
    await foreignLease.release();
    expect(JSON.parse(foreign.read()!).invocationId).toBe('other');
  });
});

describe('withLease', () => {
  afterEach(() => {
    delete process.env['DEPLOYZ_INSTALLATION_ID'];
    vi.restoreAllMocks();
  });

  it('runs the invocation under the lease and releases it', async () => {
    process.env['DEPLOYZ_INSTALLATION_ID'] = 'inst-1';
    const ssm = makeSsmFake();
    const run = vi.fn(async () => {
      expect(ssm.read()).toBeDefined();
    });
    await withLease(run, () => ssm.client)({}, { awsRequestId: 'req-1' });
    expect(run).toHaveBeenCalledOnce();
    expect(ssm.read()).toBeUndefined();
  });

  it('does not run the invocation while the lease is held', async () => {
    process.env['DEPLOYZ_INSTALLATION_ID'] = 'inst-1';
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const ssm = makeSsmFake(record('other', Date.now() + 60_000));
    const run = vi.fn(async () => undefined);
    await withLease(run, () => ssm.client)({}, { awsRequestId: 'req-1' });
    expect(run).not.toHaveBeenCalled();
  });

  it('releases the lease when the invocation throws', async () => {
    process.env['DEPLOYZ_INSTALLATION_ID'] = 'inst-1';
    const ssm = makeSsmFake();
    const run = vi.fn(async () => {
      throw new Error('boom');
    });
    await expect(withLease(run, () => ssm.client)({}, { awsRequestId: 'req-1' })).rejects.toThrow(
      'boom',
    );
    expect(ssm.read()).toBeUndefined();
  });
});
