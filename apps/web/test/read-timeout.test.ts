import { afterEach, describe, expect, it, vi } from 'vitest';

import { apiRequest, READ_TIMEOUT_MS } from '../src/lib/api-client';
import { actionErrorMessage, DeploymentActionError, fetchDeployment } from '../src/lib/deployments';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function stubFetchAbortableBySignal(): { calls: RequestInit[] } {
  const calls: RequestInit[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((_url: string, init: RequestInit) => {
      calls.push(init);
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      });
    }),
  );
  return { calls };
}

describe('read timeout', () => {
  it('bounds GET reads with an abort signal that fires after READ_TIMEOUT_MS', async () => {
    const controller = new AbortController();
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
    const { calls } = stubFetchAbortableBySignal();

    const pending = apiRequest('/api/things');
    const settled = expect(pending).rejects.toBeDefined();
    controller.abort(new DOMException('timed out', 'TimeoutError'));
    await settled;

    expect(timeout).toHaveBeenCalledWith(READ_TIMEOUT_MS);
    expect(calls[0]?.signal).toBe(controller.signal);
  });

  it('bounds the deployment reads that do not use apiRequest', async () => {
    const controller = new AbortController();
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
    stubFetchAbortableBySignal();

    const pending = fetchDeployment('dep-1');
    const settled = expect(pending).rejects.toBeDefined();
    controller.abort(new DOMException('timed out', 'TimeoutError'));
    await settled;
  });

  it('never times out a mutation, so a slow response is not cut short and retried', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await apiRequest('/api/things', { method: 'POST', body: {} });

    expect(timeout).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls[0]?.[1]).not.toHaveProperty('signal');
  });
});

describe('an action whose response is lost', () => {
  it('says the outcome is unknown instead of inviting a retry', () => {
    const message = actionErrorMessage(new TypeError('Failed to fetch'), "Couldn't start this update. Try again.");
    expect(message).toContain("couldn't confirm");
    expect(message).not.toBe("Couldn't start this update. Try again.");
  });

  it('keeps the fallback copy for an answered failure', () => {
    expect(actionErrorMessage(new DeploymentActionError(500, 'REQUEST_FAILED'), 'Fallback.')).toBe('Fallback.');
  });
});
