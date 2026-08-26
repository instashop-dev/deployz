import { describe, expect, it } from 'vitest';

import { createAuthState, type FetchFn } from './auth.js';
import { IdempotencyStore, type CommandExecutor } from './commands.js';
import { pollOnce, type PollDependencies } from './poll.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeExecutors(): Record<string, CommandExecutor> {
  const noop: CommandExecutor = async (cmd) => ({
    commandId: cmd.id,
    idempotencyKey: cmd.idempotencyKey,
    success: true,
    output: { executed: true },
  });
  return {
    INSTALL: noop,
    REPORT_HEALTH: noop,
    DEPLOY_RELEASE: noop,
    ROLLBACK: noop,
    CONFIG_UPDATE: noop,
    DESTROY: noop,
    MIGRATE: noop,
    REFRESH_METADATA: noop,
  };
}

interface MockFetchOptions {
  registerStatus?: number;
  commandsStatus?: number;
  commandsBody?: unknown;
  resultReportStatus?: number;
  healthReportStatus?: number;
  newTokenHeader?: string | null;
}

function makeMockFetch(opts: MockFetchOptions = {}): {
  fetchFn: FetchFn;
  getRequests: () => Array<{ url: string; method?: string; body?: string }>;
} {
  const requests: Array<{ url: string; method?: string; body?: string }> = [];

  const fetchFn: FetchFn = async (url, init) => {
    requests.push({ url, method: init?.method, body: init?.body });

    if (url.includes('/api/relay/register')) {
      return {
        status: opts.registerStatus ?? 200,
        headers: { get: () => opts.newTokenHeader ?? null },
        json: async () => ({}),
      };
    }

    if (url.includes('/api/relay/commands')) {
      return {
        status: opts.commandsStatus ?? 200,
        headers: { get: () => opts.newTokenHeader ?? null },
        json: async () => opts.commandsBody ?? { commands: [] },
      };
    }

    if (url.includes('/result')) {
      return {
        status: opts.resultReportStatus ?? 200,
        headers: { get: () => null },
        json: async () => ({}),
      };
    }

    if (url.includes('/api/relay/health')) {
      return {
        status: opts.healthReportStatus ?? 200,
        headers: { get: () => null },
        json: async () => ({}),
      };
    }

    return { status: 404, headers: { get: () => null }, json: async () => ({}) };
  };

  return { fetchFn, getRequests: () => requests };
}

function makeDeps(overrides: Partial<PollDependencies> = {}): PollDependencies {
  return {
    fetchFn: async () => ({ status: 200, headers: { get: () => null }, json: async () => ({ commands: [] }) }),
    controlPlaneUrl: 'https://api.deployz.dev',
    installationId: 'inst-test',
    enrollmentCode: 'code-test',
    executors: makeExecutors(),
    idempotency: new IdempotencyStore(),
    ...overrides,
  };
}

// ── Registration ─────────────────────────────────────────────────────────────

describe('pollOnce — registration', () => {
  it('registers on first poll when authState.registered is false', async () => {
    const { fetchFn, getRequests } = makeMockFetch({ registerStatus: 200 });
    const deps = makeDeps({ fetchFn });
    const authState = createAuthState('inst-test', 'tok-123');

    const result = await pollOnce(deps, authState);

    expect(result.ok).toBe(true);
    expect(authState.registered).toBe(true);

    const registerReq = getRequests().find((r) => r.url.includes('/api/relay/register'));
    expect(registerReq).toBeDefined();
    expect(registerReq?.method).toBe('POST');
  });

  it('returns a retryable error when enrollment fails transiently', async () => {
    const { fetchFn } = makeMockFetch({ registerStatus: 401 });
    const deps = makeDeps({ fetchFn });
    const authState = createAuthState('inst-test', 'tok-bad');

    const result = await pollOnce(deps, authState);

    expect(result.ok).toBe(false);
    expect(result.error).toContain('try again');
    expect(result.fatal).toBeUndefined();
    expect(authState.registered).toBe(false);
  });

  // The enrollment code is single use. A 409 means another relay already
  // spent it, so this one must stop rather than retry forever — and say
  // something the customer can act on.
  it('stops on a rejected enrollment rather than retrying', async () => {
    const { fetchFn } = makeMockFetch({ registerStatus: 409 });
    const deps = makeDeps({ fetchFn });
    const authState = createAuthState('inst-test', 'tok-late');

    const result = await pollOnce(deps, authState);

    expect(result.ok).toBe(false);
    expect(result.fatal).toBe(true);
    expect(result.error).toContain('already connected');
    expect(authState.registered).toBe(false);
  });

  it('sends the enrollment code with the registration', async () => {
    const { fetchFn, getRequests } = makeMockFetch();
    const deps = makeDeps({ fetchFn, enrollmentCode: 'code-xyz' });

    await pollOnce(deps, createAuthState('inst-test', 'tok'));

    const registerReq = getRequests().find((r) => r.url.includes('/api/relay/register'));
    expect(JSON.parse(registerReq?.body ?? '{}')).toMatchObject({ enrollmentCode: 'code-xyz' });
  });

  it('skips registration when already registered', async () => {
    const { fetchFn, getRequests } = makeMockFetch();
    const deps = makeDeps({ fetchFn });
    const authState = createAuthState('inst-test', 'tok-123');
    authState.registered = true;

    await pollOnce(deps, authState);

    const registerReqs = getRequests().filter((r) => r.url.includes('/api/relay/register'));
    expect(registerReqs).toHaveLength(0);
  });
});

// ── Command fetching ─────────────────────────────────────────────────────────

describe('pollOnce — command fetching', () => {
  it('fetches commands from the control plane', async () => {
    const { fetchFn, getRequests } = makeMockFetch({
      commandsBody: { commands: [] },
    });
    const deps = makeDeps({ fetchFn });
    const authState = createAuthState('inst-test', 'tok-123');
    authState.registered = true;

    await pollOnce(deps, authState);

    const cmdReq = getRequests().find((r) => r.url.includes('/api/relay/commands'));
    expect(cmdReq).toBeDefined();
    expect(cmdReq?.url).toContain('installationId=inst-test');
  });

  it('returns error when commands fetch fails with non-200', async () => {
    const { fetchFn } = makeMockFetch({ commandsStatus: 500 });
    const deps = makeDeps({ fetchFn });
    const authState = createAuthState('inst-test', 'tok-123');
    authState.registered = true;

    const result = await pollOnce(deps, authState);

    expect(result.ok).toBe(false);
    expect(result.error).toContain('HTTP 500');
  });

  it('returns ok with zero commands when list is empty', async () => {
    const { fetchFn } = makeMockFetch({ commandsBody: { commands: [] } });
    const deps = makeDeps({ fetchFn });
    const authState = createAuthState('inst-test', 'tok-123');
    authState.registered = true;

    const result = await pollOnce(deps, authState);

    expect(result.ok).toBe(true);
    expect(result.fetched).toBe(0);
    expect(result.executed).toBe(0);
  });

  it('handles network errors gracefully', async () => {
    const fetchFn: FetchFn = async () => {
      throw new Error('Network error');
    };
    const deps = makeDeps({ fetchFn });
    const authState = createAuthState('inst-test', 'tok-123');
    authState.registered = true;

    const result = await pollOnce(deps, authState);

    expect(result.ok).toBe(false);
    expect(result.error).toContain('Failed to fetch commands');
    expect(result.error).toContain('Network error');
  });
});

// ── Command execution ────────────────────────────────────────────────────────

describe('pollOnce — command execution', () => {
  it('executes pending commands and reports results', async () => {
    const { fetchFn, getRequests } = makeMockFetch({
      commandsBody: {
        commands: [
          {
            id: 'job-001',
            deploymentId: 'dep-001',
            type: 'INSTALL',
            idempotencyKey: 'ik-001',
            payload: { releaseId: 'rel-001' },
          },
          {
            id: 'job-002',
            deploymentId: 'dep-001',
            type: 'DEPLOY_RELEASE',
            idempotencyKey: 'ik-002',
            payload: { releaseId: 'rel-002' },
          },
        ],
      },
    });
    const deps = makeDeps({ fetchFn });
    const authState = createAuthState('inst-test', 'tok-123');
    authState.registered = true;

    const result = await pollOnce(deps, authState);

    expect(result.ok).toBe(true);
    expect(result.fetched).toBe(2);
    expect(result.executed).toBe(2);
    expect(result.succeeded).toBe(2);
    expect(result.failed).toBe(0);

    // Verify result reports were sent.
    const resultReqs = getRequests().filter((r) => r.url.includes('/result'));
    expect(resultReqs).toHaveLength(2);
  });

  it('counts failures correctly', async () => {
    const executors = makeExecutors();
    executors.INSTALL = async (cmd) => ({
      commandId: cmd.id,
      idempotencyKey: cmd.idempotencyKey,
      success: false,
      error: 'Install failed',
    });

    const { fetchFn } = makeMockFetch({
      commandsBody: {
        commands: [
          {
            id: 'job-001',
            deploymentId: 'dep-001',
            type: 'INSTALL',
            idempotencyKey: 'ik-001',
            payload: {},
          },
        ],
      },
    });
    const deps = makeDeps({ fetchFn, executors });
    const authState = createAuthState('inst-test', 'tok-123');
    authState.registered = true;

    const result = await pollOnce(deps, authState);

    expect(result.succeeded).toBe(0);
    expect(result.failed).toBe(1);
  });

  it('reports health after command execution (§59)', async () => {
    const { fetchFn, getRequests } = makeMockFetch({
      commandsBody: {
        commands: [
          {
            id: 'job-001',
            deploymentId: 'dep-001',
            type: 'INSTALL',
            idempotencyKey: 'ik-001',
            payload: {},
          },
        ],
      },
    });
    const deps = makeDeps({ fetchFn });
    const authState = createAuthState('inst-test', 'tok-123');
    authState.registered = true;

    await pollOnce(deps, authState);

    const healthReqs = getRequests().filter((r) => r.url.includes('/api/relay/health'));
    expect(healthReqs).toHaveLength(1);
    const healthBody = JSON.parse(healthReqs[0]?.body ?? '{}');
    expect(healthBody.installationId).toBe('inst-test');
    expect(healthBody.observedState).toBeDefined();
    expect(healthBody.observedState.runningVersion).toBeNull();
    expect(healthBody.observedState.observedConfig).toBeNull();
    expect(healthBody.observedState.infraHealth).toBeNull();
    expect(healthBody.observedState.idempotencyKeysTracked).toBeTypeOf('number');
    expect(healthBody.observedState.lastPoll).toBeTypeOf('string');
  });
});

// ── Token rotation during poll ───────────────────────────────────────────────

describe('pollOnce — token rotation', () => {
  it('processes rotation header from command response', async () => {
    const { fetchFn } = makeMockFetch({
      commandsBody: { commands: [] },
      newTokenHeader: 'tok-rotated',
    });
    const deps = makeDeps({ fetchFn });
    const authState = createAuthState('inst-test', 'tok-original');
    authState.registered = true;

    await pollOnce(deps, authState);

    expect(authState.token).toBe('tok-rotated');
    expect(authState.oldToken).toBe('tok-original');
    // pollOnce calls decrementGrace at the end, so grace is 2 after one poll.
    expect(authState.gracePollsRemaining).toBe(2);
  });

  it('decrements grace after each poll', async () => {
    const { fetchFn } = makeMockFetch({ commandsBody: { commands: [] } });
    const deps = makeDeps({ fetchFn });
    const authState = createAuthState('inst-test', 'tok-new');
    authState.registered = true;
    authState.oldToken = 'tok-old';
    authState.gracePollsRemaining = 2;

    await pollOnce(deps, authState);
    expect(authState.gracePollsRemaining).toBe(1);

    await pollOnce(deps, authState);
    expect(authState.gracePollsRemaining).toBe(0);
    expect(authState.oldToken).toBeUndefined();
  });
});

// ── Observed state (§59) ─────────────────────────────────────────────────────

/**
 * Run one poll and return the body the relay POSTed to /api/relay/health.
 */
async function runPollCapturingHealth(
  extra: Partial<PollDependencies>,
): Promise<{ observedState: Record<string, unknown> }> {
  const { fetchFn, getRequests } = makeMockFetch();

  const deps: PollDependencies = {
    fetchFn,
    controlPlaneUrl: 'https://api.example.test',
    installationId: 'install-1',
    enrollmentCode: 'code-1',
    executors: makeExecutors(),
    idempotency: new IdempotencyStore(),
    ...extra,
  };

  await pollOnce(deps, createAuthState('install-1', 'token-1'));

  const health = getRequests().find((request) => request.url.includes('/api/relay/health'));
  if (!health?.body) throw new Error('no health report was sent');
  return JSON.parse(health.body) as { observedState: Record<string, unknown> };
}

describe('observed state', () => {
  it('sends infraHealth null when no observer is supplied', async () => {
    const payload = await runPollCapturingHealth({});
    expect(payload.observedState['infraHealth']).toBeNull();
  });

  it('sends the observation when one is supplied', async () => {
    const payload = await runPollCapturingHealth({
      observe: async () => ({
        verified: false,
        checks: [{ name: 'stack-exists', passed: false, detail: 'missing' }],
        reason: 'missing',
      }),
    });

    expect(payload.observedState['infraHealth']).toMatchObject({
      verified: false,
      reason: 'missing',
    });
  });

  it('sends infraHealth null when the observer throws', async () => {
    const payload = await runPollCapturingHealth({
      observe: async () => {
        throw new Error('boom');
      },
    });

    expect(payload.observedState['infraHealth']).toBeNull();
  });
});