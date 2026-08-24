import { createHmac, createVerify, generateKeyPairSync } from 'node:crypto';

import { PGlite } from '@electric-sql/pglite';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { applyMigrations, createDb, type Db } from '@deployz/db';

import { createAuth, type Auth } from './auth.js';
import { errorEnvelopeSchema } from '@deployz/contracts';
import { buildServer } from './server.js';
import {
  buildAppJwt,
  buildFileTreeForAnalysis,
  createAppJwt,
  createGithubStore,
  createInstallationToken,
  fetchRepositoryTreeEntries,
  getFileTreeForAnalysis,
  GITHUB_FIXTURE_FILE_TREES,
  GITHUB_FIXTURE_INSTALLATIONS,
  GITHUB_SCOPED_PERMISSIONS,
  handleInstallationWebhook,
  listInstallations,
  listRepositories,
  mintInstallationToken,
  parseRepoFullName,
  verifyWebhookSignature,
  type AppJwtSigner,
  type FetchFn,
  type GithubWebhookEvent,
} from './github.js';

// Todo 15 — GitHub App handlers. Real App install / token fetch / webhook
// delivery are BLOCKED (no credentials, no network), so the JWT signing and
// token exchange are driven with injectable signer/fetch seams and the S4
// permission scope is locked verbatim.

const WEBHOOK_SECRET = 'github_webhook_test_secret';
const TEST_APP_ID = '123456';

function signPayload(payload: string, secret: string = WEBHOOK_SECRET): string {
  return `sha256=${createHmac('sha256', secret).update(payload).digest('hex')}`;
}

function decodeJwtSegment(segment: string): unknown {
  return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8')) as unknown;
}

function makeFetchResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): ReturnType<FetchFn> {
  return Promise.resolve({
    status,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    json: async () => body,
  });
}

describe('github — webhook signature verification', () => {
  it('accepts a valid HMAC-SHA256 signature', () => {
    const payload = JSON.stringify({ action: 'created', installation: { id: 1 } });
    expect(verifyWebhookSignature(payload, signPayload(payload), WEBHOOK_SECRET)).toBe(true);
  });

  it('accepts a valid signature over a Buffer body', () => {
    const payload = Buffer.from(JSON.stringify({ action: 'deleted', installation: { id: 1 } }));
    expect(verifyWebhookSignature(payload, signPayload(payload.toString()), WEBHOOK_SECRET)).toBe(true);
  });

  it('rejects a tampered payload', () => {
    const payload = JSON.stringify({ action: 'created', installation: { id: 1 } });
    const tampered = JSON.stringify({ action: 'created', installation: { id: 9999 } });
    expect(verifyWebhookSignature(tampered, signPayload(payload), WEBHOOK_SECRET)).toBe(false);
  });

  it('rejects a signature made with the wrong secret', () => {
    const payload = JSON.stringify({ action: 'created', installation: { id: 1 } });
    expect(verifyWebhookSignature(payload, signPayload(payload, 'wrong-secret'), WEBHOOK_SECRET)).toBe(false);
  });

  it('rejects a missing signature header', () => {
    expect(verifyWebhookSignature('{}', undefined, WEBHOOK_SECRET)).toBe(false);
  });

  it('rejects a header without the sha256= prefix', () => {
    expect(verifyWebhookSignature('{}', 'not-a-signature', WEBHOOK_SECRET)).toBe(false);
  });
});

describe('github — App JWT (RS256)', () => {
  it('builds a well-formed JWT header/payload and uses the injected signer', () => {
    const signer: AppJwtSigner = { sign: (input) => `sig-of-${input.length}` };
    const nowMs = 1_700_000_000_000;
    const jwt = buildAppJwt(TEST_APP_ID, signer, nowMs);
    const [header, payload, signature] = jwt.split('.');

    expect(decodeJwtSegment(header!)).toStrictEqual({ alg: 'RS256', typ: 'JWT' });
    const claims = decodeJwtSegment(payload!) as { iat: number; exp: number; iss: string };
    expect(claims.iat).toBe(1_700_000_000);
    expect(claims.exp).toBe(1_700_000_600); // iat + 10 minutes (GitHub max)
    expect(claims.iss).toBe(TEST_APP_ID);
    expect(signature).toBe(`sig-of-${`${header}.${payload}`.length}`);
  });

  it('createAppJwt produces an RS256 signature verifiable with the public key', () => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const jwt = createAppJwt(TEST_APP_ID, privateKey, 1_700_000_000_000);
    const [header, payload, signature] = jwt.split('.');
    const verifier = createVerify('RSA-SHA256');
    verifier.update(`${header}.${payload}`);
    verifier.end();
    expect(verifier.verify(publicKey, Buffer.from(signature!, 'base64url'))).toBe(true);
    expect(decodeJwtSegment(header!)).toMatchObject({ alg: 'RS256' });
  });
});

describe('github — installation token vending + S4 permission scope', () => {
  it('locks the S4 scope to metadata:read + contents:read ONLY', () => {
    expect(Object.keys(GITHUB_SCOPED_PERMISSIONS).sort()).toEqual(['contents', 'metadata']);
    expect(GITHUB_SCOPED_PERMISSIONS).toStrictEqual({ contents: 'read', metadata: 'read' });
  });

  it('POSTs to the access-token endpoint with the JWT and the S4-scoped permissions', async () => {
    let capturedUrl = '';
    let capturedInit: { method?: string; headers?: Record<string, string>; body?: string } | undefined;
    const fetchFn: FetchFn = async (url, init) => {
      capturedUrl = url;
      capturedInit = init;
      return makeFetchResponse(201, { token: 'ghs_test_token', expires_at: '2026-08-20T12:00:00Z' });
    };

    const result = await createInstallationToken('999', 'header.payload.sig', fetchFn);

    expect(capturedUrl).toBe('https://api.github.com/app/installations/999/access_tokens');
    expect(capturedInit?.method).toBe('POST');
    expect(capturedInit?.headers?.['Authorization']).toBe('Bearer header.payload.sig');
    expect(capturedInit?.headers?.['Accept']).toBe('application/vnd.github+json');

    const body = JSON.parse(capturedInit?.body ?? '{}') as { permissions: Record<string, string> };
    expect(Object.keys(body.permissions).sort()).toEqual(['contents', 'metadata']);
    expect(body.permissions).toStrictEqual({ contents: 'read', metadata: 'read' });

    expect(result.token).toBe('ghs_test_token');
    expect(result.expiresAt).toBe('2026-08-20T12:00:00Z');
  });

  it('throws a structured 502 on a failed exchange', async () => {
    const fetchFn: FetchFn = async () => makeFetchResponse(403, { message: 'forbidden' });
    await expect(createInstallationToken('999', 'header.payload.sig', fetchFn)).rejects.toMatchObject({
      statusCode: 502,
      code: 'GITHUB_TOKEN_FETCH_FAILED',
    });
  });

  it('mintInstallationToken signs a real JWT and exchanges it', async () => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    let capturedAuth = '';
    const fetchFn: FetchFn = async (_url, init) => {
      capturedAuth = init?.headers?.['Authorization'] ?? '';
      return makeFetchResponse(201, { token: 'ghs_minted', expires_at: '2026-08-20T12:00:00Z' });
    };
    const result = await mintInstallationToken('42', TEST_APP_ID, privateKey, 1_700_000_000_000, fetchFn);
    expect(capturedAuth).toMatch(/^Bearer .+\..+\..+$/);
    expect(result.token).toBe('ghs_minted');
  });
});

describe('github — installation created/deleted handling', () => {
  it('stores the installation on installation.created (resolver returns an org)', async () => {
    const store = createGithubStore();
    const event: GithubWebhookEvent = {
      type: 'installation',
      action: 'created',
      installation: { id: 77, account: { login: 'acme', type: 'Organization' } },
    };
    const result = await handleInstallationWebhook(store, event, async () => 'org-1');
    expect(result).toBe('stored');
    expect(store.listByOrganization('org-1')).toEqual([
      { id: '77', organizationId: 'org-1', accountLogin: 'acme', accountType: 'Organization' },
    ]);
  });

  it('removes the installation on installation.deleted', async () => {
    const store = createGithubStore();
    store.set({ id: '77', organizationId: 'org-1', accountLogin: 'acme', accountType: 'Organization' });
    const event: GithubWebhookEvent = { type: 'installation', action: 'deleted', installation: { id: 77 } };
    const result = await handleInstallationWebhook(store, event, async () => 'org-1');
    expect(result).toBe('removed');
    expect(store.listByOrganization('org-1')).toEqual([]);
  });

  it('ignores non-installation events', async () => {
    const store = createGithubStore();
    const event: GithubWebhookEvent = { type: 'push' };
    expect(await handleInstallationWebhook(store, event, async () => 'org-1')).toBe('ignored');
  });

  it('ignores installation.created when the account has no resolvable org', async () => {
    const store = createGithubStore();
    const event: GithubWebhookEvent = {
      type: 'installation',
      action: 'created',
      installation: { id: 77, account: { login: 'acme' } },
    };
    expect(await handleInstallationWebhook(store, event, async () => null)).toBe('ignored');
    expect(store.listByOrganization('org-1')).toEqual([]);
  });
});

describe('github — fixture-backed list helpers', () => {
  it('lists fixture installations in fixture mode', async () => {
    const installations = await listInstallations(createGithubStore(), 'org-1', { fixtureMode: true });
    expect(installations).toEqual([
      { id: 'fixture-install-1', accountLogin: 'deployz-demo', accountType: 'Organization' },
    ]);
  });

  it('lists fixture repositories for a known installation', async () => {
    const repos = await listRepositories('fixture-install-1', { fixtureMode: true });
    expect(repos.map((r) => r.name)).toEqual(['express-api', 'legacy-redis']);
    expect(repos[0]?.fullName).toBe('deployz-demo/express-api');
  });

  it('404s for an unknown fixture installation', async () => {
    await expect(listRepositories('nope', { fixtureMode: true })).rejects.toMatchObject({
      statusCode: 404,
      code: 'GITHUB_INSTALLATION_NOT_FOUND',
    });
  });

  it('is empty when not in fixture mode and the store is empty', async () => {
    const installations = await listInstallations(createGithubStore(), 'org-1', { fixtureMode: false });
    expect(installations).toEqual([]);
  });
});

describe('github — parseRepoFullName', () => {
  it('splits a well-formed "owner/repo" name', () => {
    expect(parseRepoFullName('deployz-demo/express-api')).toEqual({
      owner: 'deployz-demo',
      repo: 'express-api',
    });
  });

  it('rejects a name with no slash', () => {
    expect(() => parseRepoFullName('express-api')).toThrow(
      expect.objectContaining({ statusCode: 400, code: 'GITHUB_REPO_FULL_NAME_INVALID' }),
    );
  });

  it('rejects a name with more than one slash', () => {
    expect(() => parseRepoFullName('a/b/c')).toThrow(
      expect.objectContaining({ statusCode: 400, code: 'GITHUB_REPO_FULL_NAME_INVALID' }),
    );
  });
});

// §18 analysis input: the repository tree fetch. These cases never touch
// real GitHub — each drives fetchRepositoryTreeEntries /
// buildFileTreeForAnalysis through the injected FetchFn seam.
describe('github — repository tree fetch (§18 analysis input)', () => {
  const REF = { owner: 'acme', repo: 'widgets', branch: 'main' };

  it('fetches the recursive tree listing with the installation token', async () => {
    let capturedUrl = '';
    const fetchFn: FetchFn = async (url) => {
      capturedUrl = url;
      return makeFetchResponse(200, {
        tree: [{ path: 'package.json', type: 'blob', sha: 'abc', size: 42 }],
      });
    };
    const entries = await fetchRepositoryTreeEntries(REF, 'tok', fetchFn);
    expect(capturedUrl).toBe('https://api.github.com/repos/acme/widgets/git/trees/main?recursive=1');
    expect(entries).toEqual([{ path: 'package.json', type: 'blob', sha: 'abc', size: 42 }]);
  });

  it('maps a 404 with no "empty" message to GITHUB_REPO_NOT_FOUND', async () => {
    const fetchFn: FetchFn = async () => makeFetchResponse(404, { message: 'Not Found' });
    await expect(fetchRepositoryTreeEntries(REF, 'tok', fetchFn)).rejects.toMatchObject({
      statusCode: 404,
      code: 'GITHUB_REPO_NOT_FOUND',
    });
  });

  it('maps a 404 with an "empty" message to GITHUB_REPO_EMPTY', async () => {
    const fetchFn: FetchFn = async () =>
      makeFetchResponse(404, { message: 'Git Repository is empty.' });
    await expect(fetchRepositoryTreeEntries(REF, 'tok', fetchFn)).rejects.toMatchObject({
      statusCode: 422,
      code: 'GITHUB_REPO_EMPTY',
    });
  });

  it('maps a 409 to GITHUB_REPO_EMPTY', async () => {
    const fetchFn: FetchFn = async () => makeFetchResponse(409, { message: 'conflict' });
    await expect(fetchRepositoryTreeEntries(REF, 'tok', fetchFn)).rejects.toMatchObject({
      statusCode: 422,
      code: 'GITHUB_REPO_EMPTY',
    });
  });

  it('maps a 429 to GITHUB_RATE_LIMITED', async () => {
    const fetchFn: FetchFn = async () => makeFetchResponse(429, { message: 'rate limited' });
    await expect(fetchRepositoryTreeEntries(REF, 'tok', fetchFn)).rejects.toMatchObject({
      statusCode: 429,
      code: 'GITHUB_RATE_LIMITED',
    });
  });

  it('maps a 403 with x-ratelimit-remaining: 0 to GITHUB_RATE_LIMITED', async () => {
    const fetchFn: FetchFn = async () =>
      makeFetchResponse(403, { message: 'forbidden' }, { 'x-ratelimit-remaining': '0' });
    await expect(fetchRepositoryTreeEntries(REF, 'tok', fetchFn)).rejects.toMatchObject({
      statusCode: 429,
      code: 'GITHUB_RATE_LIMITED',
    });
  });

  it('maps an unrelated 403 to the generic GITHUB_TREE_FETCH_FAILED', async () => {
    const fetchFn: FetchFn = async () => makeFetchResponse(403, { message: 'forbidden' });
    await expect(fetchRepositoryTreeEntries(REF, 'tok', fetchFn)).rejects.toMatchObject({
      statusCode: 502,
      code: 'GITHUB_TREE_FETCH_FAILED',
    });
  });

  it('builds a FileTree from only the relevant, capped set of files', async () => {
    const calls: string[] = [];
    const fetchFn: FetchFn = async (url) => {
      calls.push(url);
      if (url.includes('/git/trees/')) {
        return makeFetchResponse(200, {
          tree: [
            { path: 'package.json', type: 'blob', sha: 'sha-pkg', size: 100 },
            { path: 'Dockerfile', type: 'blob', sha: 'sha-docker', size: 50 },
            { path: 'src/index.ts', type: 'blob', sha: 'sha-src', size: 60 },
            { path: 'README.md', type: 'blob', sha: 'sha-readme', size: 20 }, // irrelevant extension
            { path: 'node_modules/x/index.js', type: 'blob', sha: 'sha-nm', size: 10 }, // ignored dir
            { path: 'src', type: 'tree', sha: 'sha-dir' }, // a directory, not a blob
          ],
        });
      }
      const sha = url.split('/').pop();
      const content = { 'sha-pkg': '{}', 'sha-docker': 'FROM node', 'sha-src': 'export {}' }[sha!];
      return makeFetchResponse(200, {
        content: Buffer.from(content ?? '').toString('base64'),
        encoding: 'base64',
      });
    };

    const tree = await buildFileTreeForAnalysis(REF, 'tok', fetchFn);

    expect(tree).toEqual({
      'package.json': '{}',
      'Dockerfile': 'FROM node',
      'src/index.ts': 'export {}',
    });
    // One tree call + one blob call per relevant file (3) — never touches
    // README.md, node_modules/**, or the directory entry.
    expect(calls).toHaveLength(4);
  });

  it('skips a file whose size exceeds ANALYSIS_MAX_FILE_BYTES', async () => {
    const fetchFn: FetchFn = async (url) => {
      if (url.includes('/git/trees/')) {
        return makeFetchResponse(200, {
          tree: [{ path: 'package.json', type: 'blob', sha: 'sha-huge', size: 10_000_000 }],
        });
      }
      throw new Error('blob content should never be fetched for an oversized file');
    };
    const tree = await buildFileTreeForAnalysis(REF, 'tok', fetchFn);
    expect(tree).toEqual({});
  });

  it('drops a file whose blob content fetch fails rather than failing the whole analysis', async () => {
    const fetchFn: FetchFn = async (url) => {
      if (url.includes('/git/trees/')) {
        return makeFetchResponse(200, {
          tree: [{ path: 'package.json', type: 'blob', sha: 'sha-x', size: 10 }],
        });
      }
      return makeFetchResponse(500, { message: 'server error' });
    };
    const tree = await buildFileTreeForAnalysis(REF, 'tok', fetchFn);
    expect(tree).toEqual({});
  });
});

describe('github — getFileTreeForAnalysis (fixture + real branching)', () => {
  it('returns the fixture tree by repoFullName in fixture mode', async () => {
    const tree = await getFileTreeForAnalysis('deployz-demo/express-api', { fixtureMode: true });
    expect(tree).toEqual(GITHUB_FIXTURE_FILE_TREES['deployz-demo/express-api']);
    expect(tree['Dockerfile']).toContain('HEALTHCHECK');
  });

  it('404s for an unknown repoFullName in fixture mode', async () => {
    await expect(
      getFileTreeForAnalysis('nope/nope', { fixtureMode: true }),
    ).rejects.toMatchObject({ statusCode: 404, code: 'GITHUB_REPO_NOT_FOUND' });
  });

  it('is GITHUB_DISABLED in real mode when the token/fetchFn/branch are not supplied', async () => {
    await expect(
      getFileTreeForAnalysis('acme/widgets', { fixtureMode: false }),
    ).rejects.toMatchObject({ statusCode: 503, code: 'GITHUB_DISABLED' });
  });

  it('delegates to buildFileTreeForAnalysis in real mode', async () => {
    const fetchFn: FetchFn = async (url) => {
      if (url.includes('/git/trees/')) {
        return makeFetchResponse(200, {
          tree: [{ path: 'package.json', type: 'blob', sha: 'sha-x', size: 5 }],
        });
      }
      return makeFetchResponse(200, {
        content: Buffer.from('{}').toString('base64'),
        encoding: 'base64',
      });
    };
    const tree = await getFileTreeForAnalysis('acme/widgets', {
      fixtureMode: false,
      branch: 'main',
      installationToken: 'tok',
      fetchFn,
    });
    expect(tree).toEqual({ 'package.json': '{}' });
  });
});

describe('github — server routes over PGlite', () => {
  let client: PGlite | undefined;
  let db: Db;
  let auth: Auth;
  let app: FastifyInstance;
  let cookie: string;

  beforeAll(async () => {
    client = new PGlite();
    await applyMigrations(client);
    db = createDb(client);
    auth = createAuth(db);
    const signin = await auth.api.signUpEmail({
      body: { email: 'github@example.com', password: 'super-secret-1', name: 'GitHub' },
    });
    void signin;
    const response = await auth.api.signInEmail({
      body: { email: 'github@example.com', password: 'super-secret-1' },
      asResponse: true,
    });
    cookie = response.headers.get('set-cookie')!;

    app = await buildServer({
      auth,
      db,
      githubWebhookSecret: WEBHOOK_SECRET,
      githubFixtureMode: true,
      // Empty = no App install URL. Without saying so, this suite passed only
      // on a machine with no .env and failed wherever one was present.
      githubAppInstallUrl: '',
    });
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await client?.close();
  });

  it('rejects unauthenticated installations listing', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/github/installations' });
    expect(response.statusCode).toBe(401);
    expect(errorEnvelopeSchema.parse(response.json()).error.code).toBe('UNAUTHORIZED');
  });

  it('lists fixture installations for an authenticated org', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/github/installations',
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { installations: unknown[]; connectUrl: string | null };
    expect(body.installations).toHaveLength(1);
    expect(body.installations[0]).toMatchObject({ id: 'fixture-install-1', accountLogin: 'deployz-demo' });
    expect(body.connectUrl).toBeNull();
  });

  it('lists fixture repositories for an installation', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/github/repos?installationId=fixture-install-1',
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { repositories: Array<{ name: string }> };
    expect(body.repositories.map((r) => r.name)).toEqual(['express-api', 'legacy-redis']);
  });

  it('requires an installationId on the repos route', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/github/repos', headers: { cookie } });
    expect(response.statusCode).toBe(400);
    expect(errorEnvelopeSchema.parse(response.json()).error.code).toBe('INSTALLATION_ID_REQUIRED');
  });

  it('rejects a webhook with an invalid signature as a structured 400 envelope (no stack)', async () => {
    const payload = JSON.stringify({ action: 'created', installation: { id: 1 } });
    const response = await app.inject({
      method: 'POST',
      url: '/api/github/webhook',
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'installation',
        'x-hub-signature-256': 'sha256=deadbeef',
      },
      payload,
    });
    expect(response.statusCode).toBe(400);
    const envelope = errorEnvelopeSchema.parse(response.json());
    expect(envelope.error.code).toBe('WEBHOOK_SIGNATURE_INVALID');
    expect(JSON.stringify(response.json())).not.toContain('at ');
  });

  it('accepts a signature-verified webhook', async () => {
    const payload = JSON.stringify({ action: 'created', installation: { id: 1, account: { login: 'acme' } } });
    const response = await app.inject({
      method: 'POST',
      url: '/api/github/webhook',
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'installation',
        'x-hub-signature-256': signPayload(payload),
      },
      payload,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { received: boolean; handled: string };
    expect(body.received).toBe(true);
    expect(body.handled).toBe('ignored'); // resolver is BLOCKED -> no-op, but signature passed
  });

  it('returns 503 for the webhook when no secret is configured', async () => {
    const bareApp = await buildServer({
      auth,
      db,
      githubFixtureMode: true,
      githubWebhookSecret: '', // explicitly unconfigured, never "whatever .env has"
    });
    const payload = JSON.stringify({ action: 'created', installation: { id: 1 } });
    const response = await bareApp.inject({
      method: 'POST',
      url: '/api/github/webhook',
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': 'sha256=deadbeef' },
      payload,
    });
    expect(response.statusCode).toBe(503);
    expect(errorEnvelopeSchema.parse(response.json()).error.code).toBe('GITHUB_DISABLED');
    await bareApp.close();
  });
});

// Keep the fixture shape honest for the E2E: the fixture org has the two §216
// repos (one ready, one needs attention).
it('fixture installation exposes the §216 two-repo shape', () => {
  expect(GITHUB_FIXTURE_INSTALLATIONS).toHaveLength(1);
  expect(GITHUB_FIXTURE_INSTALLATIONS[0]?.repositories.map((r) => r.name)).toEqual([
    'express-api',
    'legacy-redis',
  ]);
});
