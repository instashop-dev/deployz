import { createHmac, createVerify, generateKeyPairSync } from 'node:crypto';

import { PGlite } from '@electric-sql/pglite';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { applyMigrations, createDb, type Db } from '@deployz/db';

import { createAuth, type Auth } from './auth.js';
import { errorEnvelopeSchema } from '@deployz/contracts';
import { buildServer } from './server.js';
import {
  ANALYSIS_MAX_FILES,
  buildAppJwt,
  buildFileTreeForAnalysis,
  createAppJwt,
  InMemoryGithubInstallationStore,
  createInstallationToken,
  fetchHeadSha,
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
    // Backdated by the 60s skew margin, expiring 60s inside GitHub's 10-minute
    // ceiling: GitHub compares both claims against ITS clock, so issuing at
    // exactly now + 600 is rejected whenever our clock runs a moment fast.
    expect(claims.iat).toBe(1_699_999_940);
    expect(claims.exp).toBe(1_700_000_420);
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

  // The PEM reaches us through `.env` (double-quoted, backslash-n escapes) and
  // through a GitHub Actions secret, and only the .env parser decodes those
  // escapes. A key that arrives with them intact used to be handed to
  // node:crypto verbatim, which threw a bare Error — rendered to the vendor as
  // a 500 INTERNAL_ERROR with nothing in the logs to explain it.
  it('accepts a private key whose newlines arrived as escapes', () => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const pem = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
    const escaped = pem.split('\n').join(String.raw`\n`);
    expect(escaped.includes('\n')).toBe(false);

    const jwt = createAppJwt(TEST_APP_ID, escaped, 1_700_000_000_000);
    const [header, payload, signature] = jwt.split('.');
    const verifier = createVerify('RSA-SHA256');
    verifier.update(`${header}.${payload}`);
    verifier.end();
    expect(verifier.verify(publicKey, Buffer.from(signature!, 'base64url'))).toBe(true);
  });

  // Exactly how production broke: a real multi-line PEM whose FIRST and LAST
  // line breaks alone were re-escaped on the way into the Actions secret.
  it('accepts a key with only some of its line breaks escaped', () => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const lines = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString().trimEnd().split('\n');
    const mixed = [lines[0], lines.slice(1, -1).join('\n'), lines.at(-1)].join(String.raw`\n`);

    const jwt = createAppJwt(TEST_APP_ID, mixed, 1_700_000_000_000);
    const [header, payload, signature] = jwt.split('.');
    const verifier = createVerify('RSA-SHA256');
    verifier.update(`${header}.${payload}`);
    verifier.end();
    expect(verifier.verify(publicKey, Buffer.from(signature!, 'base64url'))).toBe(true);
  });

  // A key that is simply unusable has to name itself as a GitHub configuration
  // problem. An anonymous 500 is what made this cost an afternoon.
  it('reports an unusable key as a configuration error rather than a bare crash', () => {
    expect(() => createAppJwt(TEST_APP_ID, 'not-a-pem', 1_700_000_000_000)).toThrow(
      expect.objectContaining({ code: 'GITHUB_APP_KEY_INVALID', statusCode: 503 }),
    );
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

describe('github — installation deleted handling', () => {
  it('removes the installation on installation.deleted', async () => {
    const store = new InMemoryGithubInstallationStore();
    await store.set({ id: '77', organizationId: 'org-1', accountLogin: 'acme', accountType: 'Organization' });
    const event: GithubWebhookEvent = { type: 'installation', action: 'deleted', installation: { id: 77 } };
    const result = await handleInstallationWebhook(store, event);
    expect(result).toBe('removed');
    expect(await store.listByOrganization('org-1')).toEqual([]);
  });

  it('ignores non-installation events', async () => {
    const store = new InMemoryGithubInstallationStore();
    const event: GithubWebhookEvent = { type: 'push' };
    expect(await handleInstallationWebhook(store, event)).toBe('ignored');
  });

  // installation.created carries a GitHub account, not a Deployz tenant —
  // the binding is made by GET /api/github/setup, where the vendor's session
  // is present.
  it('ignores installation.created', async () => {
    const store = new InMemoryGithubInstallationStore();
    const event: GithubWebhookEvent = {
      type: 'installation',
      action: 'created',
      installation: { id: 77, account: { login: 'acme', type: 'Organization' } },
    };
    expect(await handleInstallationWebhook(store, event)).toBe('ignored');
    expect(await store.listByOrganization('org-1')).toEqual([]);
  });
});

describe('github — fixture-backed list helpers', () => {
  it('lists fixture installations in fixture mode', async () => {
    const installations = await listInstallations(new InMemoryGithubInstallationStore(), 'org-1', {
      fixtureMode: true,
    });
    expect(installations).toEqual([
      { id: 'fixture-install-1', accountLogin: 'deployz-demo', accountType: 'Organization' },
    ]);
  });

  it('lists fixture repositories for a known installation', async () => {
    const repos = await listRepositories('fixture-install-1', { fixtureMode: true });
    expect(repos.map((r) => r.name)).toEqual([
      'express-api',
      'legacy-redis',
      'bullmq-worker',
      'static-api',
      'nextjs-prisma',
      'monorepo',
    ]);
    expect(repos[0]?.fullName).toBe('deployz-demo/express-api');
  });

  it('404s for an unknown fixture installation', async () => {
    await expect(listRepositories('nope', { fixtureMode: true })).rejects.toMatchObject({
      statusCode: 404,
      code: 'GITHUB_INSTALLATION_NOT_FOUND',
    });
  });

  it('is empty when not in fixture mode and the store is empty', async () => {
    const installations = await listInstallations(new InMemoryGithubInstallationStore(), 'org-1', {
      fixtureMode: false,
    });
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

  it('fetches deployment descriptors the cloud checks read (COMP-033)', async () => {
    const calls: string[] = [];
    const fetchFn: FetchFn = async (url) => {
      calls.push(url);
      if (url.includes('/git/trees/')) {
        return makeFetchResponse(200, {
          tree: [
            { path: 'package.json', type: 'blob', sha: 'sha-pkg', size: 10 },
            { path: 'manifests/kustomization.yaml', type: 'blob', sha: 'sha-kustomize', size: 10 },
            { path: 'charts/app/Chart.yaml', type: 'blob', sha: 'sha-chart', size: 10 },
            { path: 'infra/main.tf', type: 'blob', sha: 'sha-tf', size: 10 },
            { path: 'infra/main.bicep', type: 'blob', sha: 'sha-bicep', size: 10 },
            { path: 'README.md', type: 'blob', sha: 'sha-readme', size: 10 }, // still irrelevant
          ],
        });
      }
      const sha = url.split('/').pop();
      return makeFetchResponse(200, {
        content: Buffer.from(`content-${sha}`).toString('base64'),
        encoding: 'base64',
      });
    };

    const tree = await buildFileTreeForAnalysis(REF, 'tok', fetchFn);

    expect(Object.keys(tree).sort()).toEqual([
      'charts/app/Chart.yaml',
      'infra/main.bicep',
      'infra/main.tf',
      'manifests/kustomization.yaml',
      'package.json',
    ]);
  });

  it('fetches the additional manifest/compose/env-sample/source shapes Redis detection needs (§7 of the Redis MVP)', async () => {
    const calls: string[] = [];
    const fetchFn: FetchFn = async (url) => {
      calls.push(url);
      if (url.includes('/git/trees/')) {
        return makeFetchResponse(200, {
          tree: [
            { path: 'requirements.txt', type: 'blob', sha: 'sha-reqs', size: 10 },
            { path: 'services/worker/pyproject.toml', type: 'blob', sha: 'sha-pyproject', size: 10 },
            { path: 'Gemfile', type: 'blob', sha: 'sha-gemfile', size: 10 },
            { path: 'go.mod', type: 'blob', sha: 'sha-gomod', size: 10 },
            { path: 'composer.json', type: 'blob', sha: 'sha-composer', size: 10 },
            { path: 'docker-compose.yml', type: 'blob', sha: 'sha-compose-root', size: 10 },
            { path: 'deploy/compose.prod.yml', type: 'blob', sha: 'sha-compose-nested', size: 10 },
            { path: 'services/worker/docker-compose.override.yaml', type: 'blob', sha: 'sha-compose-override', size: 10 },
            { path: '.env.example', type: 'blob', sha: 'sha-env-root', size: 10 },
            { path: 'services/worker/.env.sample', type: 'blob', sha: 'sha-env-nested', size: 10 },
            { path: 'services/worker/.env.template', type: 'blob', sha: 'sha-env-template', size: 10 },
            { path: 'worker.py', type: 'blob', sha: 'sha-py', size: 10 },
            { path: 'app.rb', type: 'blob', sha: 'sha-rb', size: 10 },
            { path: 'irrelevant.txt', type: 'blob', sha: 'sha-irrelevant', size: 10 }, // still not relevant
          ],
        });
      }
      const sha = url.split('/').pop();
      return makeFetchResponse(200, {
        content: Buffer.from(`content-${sha}`).toString('base64'),
        encoding: 'base64',
      });
    };

    const tree = await buildFileTreeForAnalysis(REF, 'tok', fetchFn);

    expect(Object.keys(tree).sort()).toEqual(
      [
        'requirements.txt',
        'services/worker/pyproject.toml',
        'Gemfile',
        'go.mod',
        'composer.json',
        'docker-compose.yml',
        'deploy/compose.prod.yml',
        'services/worker/docker-compose.override.yaml',
        '.env.example',
        'services/worker/.env.sample',
        'services/worker/.env.template',
        'worker.py',
        'app.rb',
      ].sort(),
    );
    expect(tree).not.toHaveProperty('irrelevant.txt');
  });

  it('never lets a flood of generic root-level source files crowd a named nested signal file out of the ANALYSIS_MAX_FILES cap', async () => {
    // More unnamed root-level relevant files (plain .py scripts, no
    // manifest/compose/env-sample name of their own) than the cap alone,
    // listed BEFORE the two named nested files below — so a naive stable
    // sort that treated "any root file" and "a named signal file" as the
    // same priority would let these fill every slot and drop the nested
    // docker-compose.yml/.env.example the Redis detectors actually need.
    const rootScripts = Array.from({ length: ANALYSIS_MAX_FILES + 5 }, (_, i) => ({
      path: `script${i}.py`,
      type: 'blob' as const,
      sha: `sha-script-${i}`,
      size: 10,
    }));
    const fetchFn: FetchFn = async (url) => {
      if (url.includes('/git/trees/')) {
        return makeFetchResponse(200, {
          tree: [
            ...rootScripts,
            { path: 'nested/docker-compose.yml', type: 'blob', sha: 'sha-compose', size: 10 },
            { path: 'nested/.env.example', type: 'blob', sha: 'sha-env', size: 10 },
          ],
        });
      }
      const sha = url.split('/').pop();
      return makeFetchResponse(200, {
        content: Buffer.from(`content-${sha}`).toString('base64'),
        encoding: 'base64',
      });
    };

    const tree = await buildFileTreeForAnalysis(REF, 'tok', fetchFn);

    expect(Object.keys(tree)).toHaveLength(ANALYSIS_MAX_FILES);
    expect(tree).toHaveProperty('nested/docker-compose.yml');
    expect(tree).toHaveProperty('nested/.env.example');
  });

  it('ranks specs, fixtures and tool configs last so application source survives the cap (COMP-018)', async () => {
    // Enough cypress specs and root tool configs to fill the cap on their own,
    // listed BEFORE the application files — a large repository's source must
    // not lose its slots to files the detectors never read.
    const specs = Array.from({ length: ANALYSIS_MAX_FILES }, (_, i) => ({
      path: `frontend/cypress/e2e/case${i}.spec.ts`,
      type: 'blob' as const,
      sha: `sha-spec-${i}`,
      size: 10,
    }));
    const fetchFn: FetchFn = async (url) => {
      if (url.includes('/git/trees/')) {
        return makeFetchResponse(200, {
          tree: [
            { path: 'vitest.config.ts', type: 'blob', sha: 'sha-vitest', size: 10 },
            { path: '.husky/update-openapi.js', type: 'blob', sha: 'sha-husky', size: 10 },
            { path: 'scripts/build-geo.js', type: 'blob', sha: 'sha-script', size: 10 },
            { path: 'docs/api/generate.js', type: 'blob', sha: 'sha-docs', size: 10 },
            ...specs,
            { path: 'src/lib/features/deep/nested/handler.ts', type: 'blob', sha: 'sha-deep', size: 10 },
            { path: 'src/lib/routes/health-check.ts', type: 'blob', sha: 'sha-health', size: 10 },
            { path: 'src/server.ts', type: 'blob', sha: 'sha-server', size: 10 },
          ],
        });
      }
      const sha = url.split('/').pop();
      return makeFetchResponse(200, {
        content: Buffer.from(`content-${sha}`).toString('base64'),
        encoding: 'base64',
      });
    };

    const tree = await buildFileTreeForAnalysis(REF, 'tok', fetchFn);

    expect(Object.keys(tree)).toHaveLength(ANALYSIS_MAX_FILES);
    expect(tree).toHaveProperty('src/server.ts');
    expect(tree).toHaveProperty('src/lib/routes/health-check.ts');
    expect(tree).toHaveProperty('src/lib/features/deep/nested/handler.ts');
    // The three application files took their slots first; specs, scripts,
    // docs and tool configs share the last tier and fill whatever remains,
    // in tree order.
    expect(Object.keys(tree).filter((path) => path.endsWith('.spec.ts'))).toHaveLength(ANALYSIS_MAX_FILES - 7);
  });

  it('fetches Dockerfiles and Compose files before workspace manifests, and test manifests last (COMP-038)', async () => {
    // A workspace with more package.json files than the cap, most of them
    // under e2e-tests/, listed before the production Dockerfile.
    const manifests = Array.from({ length: ANALYSIS_MAX_FILES }, (_, i) => ({
      path: i < 40 ? `webapp/platform/pkg${i}/package.json` : `e2e-tests/case${i}/package.json`,
      type: 'blob' as const,
      sha: `sha-pkg-${i}`,
      size: 10,
    }));
    const fetchFn: FetchFn = async (url) => {
      if (url.includes('/git/trees/')) {
        return makeFetchResponse(200, {
          tree: [
            { path: '.cursor/Dockerfile', type: 'blob', sha: 'sha-cursor', size: 10 },
            ...manifests,
            { path: 'server/build/Dockerfile', type: 'blob', sha: 'sha-dockerfile', size: 10 },
            { path: 'server/build/docker-compose.yml', type: 'blob', sha: 'sha-compose', size: 10 },
            { path: 'webapp/channels/package.json', type: 'blob', sha: 'sha-channels', size: 10 },
          ],
        });
      }
      const sha = url.split('/').pop();
      return makeFetchResponse(200, {
        content: Buffer.from(`content-${sha}`).toString('base64'),
        encoding: 'base64',
      });
    };

    const tree = await buildFileTreeForAnalysis(REF, 'tok', fetchFn);

    expect(Object.keys(tree)).toHaveLength(ANALYSIS_MAX_FILES);
    expect(tree).toHaveProperty('server/build/Dockerfile');
    expect(tree).toHaveProperty('server/build/docker-compose.yml');
    expect(tree).toHaveProperty('webapp/channels/package.json');
    expect(tree).toHaveProperty('webapp/platform/pkg0/package.json');
    expect(Object.keys(tree).filter((path) => path.startsWith('e2e-tests/'))).toHaveLength(ANALYSIS_MAX_FILES - 44);
  });

  it('fetches entry, routing and configuration files before other source on a large tree (COMP-018)', async () => {
    // A Go tree with more plain source files than the cap, all shallower
    // than the routes file — the routes file still wins a slot because it
    // is where the health path and port are declared.
    const plain = Array.from({ length: ANALYSIS_MAX_FILES + 20 }, (_, i) => ({
      path: `internal/reader/parser${i}.go`,
      type: 'blob' as const,
      sha: `sha-plain-${i}`,
      size: 10,
    }));
    const fetchFn: FetchFn = async (url) => {
      if (url.includes('/git/trees/')) {
        return makeFetchResponse(200, {
          tree: [
            ...plain,
            { path: 'internal/http/server/routes.go', type: 'blob', sha: 'sha-routes', size: 10 },
            { path: 'internal/config/options.go', type: 'blob', sha: 'sha-options', size: 10 },
            { path: 'main.go', type: 'blob', sha: 'sha-main', size: 10 },
          ],
        });
      }
      const sha = url.split('/').pop();
      return makeFetchResponse(200, {
        content: Buffer.from(`content-${sha}`).toString('base64'),
        encoding: 'base64',
      });
    };

    const tree = await buildFileTreeForAnalysis(REF, 'tok', fetchFn);

    expect(Object.keys(tree)).toHaveLength(ANALYSIS_MAX_FILES);
    expect(tree).toHaveProperty('main.go');
    expect(tree).toHaveProperty('internal/http/server/routes.go');
    expect(tree).toHaveProperty('internal/config/options.go');
  });

  it('includes a lockfile as an empty-content entry without fetching its blob (§18 package-manager detection)', async () => {
    const calls: string[] = [];
    const fetchFn: FetchFn = async (url) => {
      calls.push(url);
      if (url.includes('/git/trees/')) {
        return makeFetchResponse(200, {
          tree: [
            { path: 'package.json', type: 'blob', sha: 'sha-pkg', size: 20 },
            // Deliberately over ANALYSIS_MAX_FILE_BYTES — the point of the
            // empty-content entry is that this content is NEVER fetched.
            { path: 'pnpm-lock.yaml', type: 'blob', sha: 'sha-lock', size: 500_000 },
          ],
        });
      }
      return makeFetchResponse(200, {
        content: Buffer.from('{}').toString('base64'),
        encoding: 'base64',
      });
    };

    const tree = await buildFileTreeForAnalysis(REF, 'tok', fetchFn);

    expect(tree).toEqual({ 'package.json': '{}', 'pnpm-lock.yaml': '' });
    // One tree call + one blob call for package.json only — the lockfile's
    // sha is never requested.
    expect(calls).toHaveLength(2);
    expect(calls.some((u) => u.includes('sha-lock'))).toBe(false);
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

  it('drops a file whose blob content fetch THROWS rather than failing the whole analysis', async () => {
    // A fetch seam that rejects — a network drop, or the benchmark snapshot
    // fetch refusing an offline cache miss for one blob — must degrade to
    // "file not present" exactly like an HTTP error does, not abort the tree
    // build (repo-084 NangoHQ/nango offline crash).
    const fetchFn: FetchFn = async (url) => {
      if (url.includes('/git/trees/')) {
        return makeFetchResponse(200, {
          tree: [
            { path: 'package.json', type: 'blob', sha: 'sha-a', size: 10 },
            { path: 'src/server.ts', type: 'blob', sha: 'sha-b', size: 10 },
          ],
        });
      }
      if (url.includes('/git/blobs/sha-a')) {
        throw new Error('snapshot cache miss for acme/widgets blob sha-a (offline)');
      }
      return makeFetchResponse(200, {
        content: Buffer.from('content-b').toString('base64'),
        encoding: 'base64',
      });
    };
    const tree = await buildFileTreeForAnalysis(REF, 'tok', fetchFn);
    expect(tree).toEqual({ 'src/server.ts': 'content-b' });
  });
});

// Task 6: commit-SHA analysis cache — resolves the branch head sha so
// runApplicationAnalysis can decide whether a re-analysis is redundant.
// Best-effort by design: any non-200 degrades to `undefined` rather than
// throwing, since a broken cache lookup must never become a failure reason.
describe('github — fetchHeadSha (commit-SHA analysis cache)', () => {
  const REF = { owner: 'acme', repo: 'widgets', branch: 'main' };

  it('returns the sha from a recorded 200', async () => {
    let capturedUrl = '';
    const fetchFn: FetchFn = async (url) => {
      capturedUrl = url;
      return makeFetchResponse(200, { sha: 'abc123' });
    };
    const sha = await fetchHeadSha(REF, 'tok', fetchFn);
    expect(capturedUrl).toBe('https://api.github.com/repos/acme/widgets/commits/main');
    expect(sha).toBe('abc123');
  });

  it('returns undefined on a 404', async () => {
    const fetchFn: FetchFn = async () => makeFetchResponse(404, { message: 'Not Found' });
    const sha = await fetchHeadSha(REF, 'tok', fetchFn);
    expect(sha).toBeUndefined();
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
    expect(body.repositories.map((r) => r.name)).toEqual([
      'express-api',
      'legacy-redis',
      'bullmq-worker',
      'static-api',
      'nextjs-prisma',
      'monorepo',
    ]);
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

// Keep the fixture shape honest for the E2E: the fixture org has the six
// §216 repos (ready with Postgres, needs attention, ready with Redis,
// ready with no database, ready with Next.js + Prisma, and a monorepo).
it('fixture installation exposes the §216 six-repo shape', () => {
  expect(GITHUB_FIXTURE_INSTALLATIONS).toHaveLength(1);
  expect(GITHUB_FIXTURE_INSTALLATIONS[0]?.repositories.map((r) => r.name)).toEqual([
    'express-api',
    'legacy-redis',
    'bullmq-worker',
    'static-api',
    'nextjs-prisma',
    'monorepo',
  ]);
});
