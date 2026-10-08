import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import type { AiGateway } from '@deployz/analysis';

import {
  AI_OFF_RECORD,
  buildSessionGateway,
  classifyAiError,
  countAi,
  instrumentGateway,
  parseAiMode,
  sanitizeAiError,
  type SessionGateway,
} from './ai-mode.js';
import { openAnalysisSession } from './analyse.js';
import { parseRunArgs } from './index.js';
import { writeRunFiles, type RunResult } from './report.js';

const KEY = 'sk-planted-provider-key-0123456789abcdef0123456789';
const TOKEN = 'planted-gateway-token-abcdefghijklmnop';
const LIVE_ENV = {
  AI_GATEWAY_BASE_URL: 'https://gateway.example.test/v1/acct/gw/compat',
  AI_PROVIDER_API_KEY: KEY,
  AI_GATEWAY_TOKEN: TOKEN,
  AI_MODEL: 'test/model',
};

function fakeSession(generate: AiGateway['generate']): SessionGateway {
  return { gateway: { generate }, mode: 'live', model: 'test/model', secrets: [KEY, TOKEN] };
}

class StatusError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
    this.name = 'AI_APICallError';
  }
}

function named(name: string, message = 'boom'): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

describe('AI mode selection', () => {
  it('defaults to off and accepts only off or live', () => {
    expect(parseAiMode(undefined)).toBe('off');
    expect(parseAiMode('off')).toBe('off');
    expect(parseAiMode('live')).toBe('live');
    expect(() => parseAiMode('on')).toThrow('--ai must be "off" or "live"');
  });

  it('is off by default in the Stage A arguments and live with --ai live', () => {
    expect(parseRunArgs([]).ai).toBe('off');
    expect(parseRunArgs(['--ai', 'live']).ai).toBe('live');
    expect(() => parseRunArgs(['--ai', 'maybe'])).toThrow('--ai must be');
  });

  it('builds an unconfigured gateway in off mode, whatever the environment holds', async () => {
    const session = buildSessionGateway('off', LIVE_ENV);
    expect(session).toMatchObject({ mode: 'off', model: null, secrets: [] });
    await expect(session.gateway.generate('p', z.object({}))).rejects.toThrow('not configured');
  });

  it('builds the production gateway in live mode and reports the configured model', () => {
    expect(buildSessionGateway('live', LIVE_ENV)).toMatchObject({ mode: 'live', model: 'test/model', secrets: [KEY, TOKEN] });
    expect(buildSessionGateway('live', { ...LIVE_ENV, AI_MODEL: undefined, AI_GATEWAY_TOKEN: undefined }).model).toBe(
      'workers-ai/@cf/deepseek-ai/deepseek-v4-flash-0731',
    );
  });
});

describe('live mode configuration', () => {
  it('fails fast and names the missing variables, never a value', () => {
    expect(() => buildSessionGateway('live', {})).toThrow('AI_GATEWAY_BASE_URL, AI_PROVIDER_API_KEY');
    expect(() => buildSessionGateway('live', { AI_PROVIDER_API_KEY: KEY })).toThrow(/missing environment variable\(s\): AI_GATEWAY_BASE_URL$/);
    let message = '';
    try {
      buildSessionGateway('live', { AI_GATEWAY_BASE_URL: 'https://x.example.test', AI_GATEWAY_TOKEN: TOKEN });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('AI_PROVIDER_API_KEY');
    expect(message).not.toContain(TOKEN);
  });

  it('refuses a reused secret without printing it', () => {
    let message = '';
    try {
      buildSessionGateway('live', { ...LIVE_ENV, AI_GATEWAY_TOKEN: KEY });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('must differ');
    expect(message).not.toContain(KEY);
  });

  it('fails before any entry is analysed when a session opens in live mode without configuration', async () => {
    await expect(openAnalysisSession(async () => new Response('{}'), { ai: 'live', env: {} })).rejects.toThrow('AI_GATEWAY_BASE_URL');
  });
});

describe('outcome recording with a fake gateway', () => {
  const schema = z.object({});
  const answer = { object: {}, usage: { promptTokens: 1, completionTokens: 1 } };

  async function run(generate: AiGateway['generate'], rejectedAnswer = false) {
    const instrumented = instrumentGateway(fakeSession(generate));
    instrumented.begin();
    try {
      await instrumented.gateway.generate('prompt', schema);
    } catch {
      // the analysis catches gateway errors; the record keeps them
    }
    return instrumented.finish({ rejectedAnswer });
  }

  it('records no request when the analysis asked nothing', () => {
    const instrumented = instrumentGateway(fakeSession(async () => answer));
    instrumented.begin();
    expect(instrumented.finish({ rejectedAnswer: false })).toEqual({
      mode: 'live',
      model: 'test/model',
      requests: 0,
      outcome: 'not-requested',
      error: null,
    });
  });

  it('records a completed request', async () => {
    expect(await run(async () => answer)).toEqual({ mode: 'live', model: 'test/model', requests: 1, outcome: 'completed', error: null });
  });

  it('records an answer the analysis rejected as a parse error', async () => {
    expect(await run(async () => answer, true)).toMatchObject({ requests: 1, outcome: 'parse-error' });
  });

  it.each([
    ['timeout', named('AbortError', 'The operation was aborted.')],
    ['auth-error', new StatusError('Unauthorized', 401)],
    ['auth-error', new StatusError('Forbidden', 403)],
    ['routing-error', new StatusError('Not Found', 404)],
    ['routing-error', new Error('model xyz does not exist')],
    ['parse-error', named('AI_NoObjectGeneratedError', 'No object generated')],
    ['parse-error', named('ZodError')],
    ['fallback', new StatusError('Bad Gateway', 502)],
    ['fallback', new Error('connection reset')],
  ])('classifies %s', async (outcome, error) => {
    expect(classifyAiError(error)).toBe(outcome);
    const record = await run(async () => {
      throw error;
    });
    expect(record).toMatchObject({ mode: 'live', requests: 1, outcome });
    expect(record.error).toBeTruthy();
  });

  it('counts every request of one entry and resets on begin', async () => {
    const instrumented = instrumentGateway(fakeSession(async () => answer));
    instrumented.begin();
    await instrumented.gateway.generate('a', schema);
    await instrumented.gateway.generate('b', schema);
    expect(instrumented.finish({ rejectedAnswer: false }).requests).toBe(2);
    instrumented.begin();
    expect(instrumented.finish({ rejectedAnswer: false }).requests).toBe(0);
  });

  it('counts records by mode and outcome', () => {
    expect(countAi([AI_OFF_RECORD, AI_OFF_RECORD, { ...AI_OFF_RECORD, mode: 'live', outcome: 'completed' }])).toEqual({
      byMode: { live: 1, off: 2 },
      byOutcome: { completed: 1, 'not-requested': 2 },
    });
  });
});

describe('error sanitizing', () => {
  const error = new Error(
    `401 from https://user:pass@gateway.example.test/v1/acct/gw/compat/chat/completions?key=abc: Authorization: Bearer ${KEY} cf-aig-authorization=${TOKEN} raw ${TOKEN} ${'z'.repeat(40)}`,
  );

  it('removes a planted key, a planted token, a bearer token, URLs and long tokens', () => {
    const text = sanitizeAiError(error, [KEY, TOKEN]);
    for (const secret of [KEY, TOKEN, 'user:pass', 'gateway.example.test', 'key=abc', 'z'.repeat(40)]) expect(text).not.toContain(secret);
    expect(text).toContain('[url]');
  });

  it('keeps secrets out of a recorded outcome', async () => {
    const instrumented = instrumentGateway(
      fakeSession(async () => {
        throw error;
      }),
    );
    instrumented.begin();
    await instrumented.gateway.generate('p', z.object({})).catch(() => {});
    const record = JSON.stringify(instrumented.finish({ rejectedAnswer: false }));
    expect(record).not.toContain(KEY);
    expect(record).not.toContain(TOKEN);
  });

  it('bounds the length', () => {
    expect(sanitizeAiError(new Error('word '.repeat(200))).length).toBeLessThanOrEqual(300);
  });
});

describe('one runs directory never mixes modes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'compat-ai-mode-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const result = (id: string, mode: 'off' | 'live') => ({ id, ai: { ...AI_OFF_RECORD, mode } }) as unknown as RunResult;

  it('replaces a result of the same mode and refuses one of another mode', () => {
    writeRunFiles(dir, [result('repo-001', 'off')]);
    writeRunFiles(dir, [result('repo-001', 'off')]);
    expect(() => writeRunFiles(dir, [result('repo-001', 'live')])).toThrow(
      /repo-001\.json was written with --ai off; refusing to replace it with --ai live/,
    );
    expect(JSON.parse(readFileSync(join(dir, 'repo-001.json'), 'utf8')).ai.mode).toBe('off');
  });

  it('treats a result file without an ai block as off and writes nothing when one file conflicts', () => {
    writeFileSync(join(dir, 'repo-002.json'), '{"id":"repo-002"}\n');
    expect(() => writeRunFiles(dir, [result('repo-003', 'live'), result('repo-002', 'live')])).toThrow();
    expect(existsSync(join(dir, 'repo-003.json'))).toBe(false);
    writeRunFiles(dir, [result('repo-002', 'off')]);
  });
});
