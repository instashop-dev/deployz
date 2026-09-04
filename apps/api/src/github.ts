import { createHmac, createSign, timingSafeEqual } from 'node:crypto';

import { eq } from 'drizzle-orm';

import { isRuntimeSourcePath, type FileTree } from '@deployz/analysis';
import type { RuntimeDb } from '@deployz/db';
import * as schema from '@deployz/db/schema';

import { ApiError } from './errors.js';

// ---------------------------------------------------------------------------
// GitHub App integration — server-side control-plane surface (§15/§17).
//
// The control plane holds the App's private key and vends SHORT-LIVED
// installation access tokens on demand (never stored). Webhook events arrive
// FROM GitHub to /api/github/webhook and are signature-verified against the
// App's webhook secret. The S4 guardrail caps every request at metadata:read
// + contents:read — no PRs, no checks, no admin (§17: those are "optional /
// later", and AI code modification is Not-MVP §20).
//
// Real App install / token fetch / webhook delivery from GitHub are BLOCKED in
// this environment (no App credentials, no network) — so the JWT signing and
// token exchange are built with injectable fetch/key seams, and repo listing
// degrades to a fixture store in test mode. Same graceful-degradation pattern
// as todo 6 (createStripe -> null) and todo 12 (FetchFn / SecretsClient).

export const GITHUB_API_BASE = 'https://api.github.com';

// S4 guardrail: the ONLY permissions the App ever requests. Asserted verbatim
// in github.test.ts — adding anything here is a guardrail violation.
export const GITHUB_SCOPED_PERMISSIONS = {
  contents: 'read',
  metadata: 'read',
} as const;

// The scope reduced for a single installation token. GitHub allows narrowing
// an App's granted permissions on the token request; we always narrow to the
// two read scopes even if the App's manifest somehow granted more.
const TOKEN_REQUEST_PERMISSIONS: Record<string, string> = {
  contents: 'read',
  metadata: 'read',
};

// ---------------------------------------------------------------------------
// Fetch seam (mirrors the relay's FetchFn — a minimal structural type so mocks
// are trivial and no DOM globals are required).
// ---------------------------------------------------------------------------

export interface FetchFn {
  (url: string, init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  }): Promise<{
    status: number;
    headers: { get(name: string): string | null };
    json(): Promise<unknown>;
  }>;
}

// ---------------------------------------------------------------------------
// Webhook signature verification
// ---------------------------------------------------------------------------

// Verifies the `X-Hub-Signature-256` header (HMAC-SHA256 over the RAW body
// using the App webhook secret) with a constant-time comparison. Returns a
// boolean; the route maps `false` to a structured 400 envelope.
export function verifyWebhookSignature(
  rawBody: string | Buffer,
  signatureHeader: string | undefined,
  secret: string,
): boolean {
  if (!signatureHeader) {
    return false;
  }
  const prefix = 'sha256=';
  if (!signatureHeader.startsWith(prefix)) {
    return false;
  }
  const provided = signatureHeader.slice(prefix.length);
  const computed = createHmac('sha256', secret).update(rawBody).digest('hex');
  const providedBuf = Buffer.from(provided, 'utf8');
  const computedBuf = Buffer.from(computed, 'utf8');
  if (providedBuf.length !== computedBuf.length) {
    return false;
  }
  return timingSafeEqual(providedBuf, computedBuf);
}

// ---------------------------------------------------------------------------
// GitHub App JWT (RS256, iat/exp claims)
// ---------------------------------------------------------------------------

// Signs the JWT signing input and returns the base64url signature. The real
// signer uses the App's RSA private key (RS256); tests inject a stub signer so
// no key material is required to assert JWT structure.
export interface AppJwtSigner {
  sign(input: string): string;
}

function base64Url(input: string | Buffer): string {
  const buf = typeof input === 'string' ? Buffer.from(input, 'utf8') : input;
  return buf.toString('base64url');
}

// The App's private key reaches this process as one environment variable, and
// it collects escapes on the way: the repo-root `.env` stores the PEM
// double-quoted with `\n` escapes (which the .env parser decodes), while a
// GitHub Actions secret is copied through verbatim (nothing decodes it). So a
// key can arrive fully escaped, or — as production did — with only its first
// and last line breaks still written as two characters. node:crypto sees a
// PEM with no header line and throws `DECODER routines::unsupported`.
//
// Decoding the escapes here is safe: `\n` cannot occur inside base64 or inside
// the PEM armour, so there is nothing legitimate to corrupt.
// Anything that is not a PEM string (a KeyObject, as the tests pass) is
// already structured and goes through untouched.
export function normalizeAppPrivateKey<T>(privateKey: T): T | string {
  if (typeof privateKey !== 'string') return privateKey;
  return privateKey
    .split(String.raw`\r\n`)
    .join('\n')
    .split(String.raw`\n`)
    .join('\n')
    .replace(/\r/g, '');
}

// RS256 signer backed by the App's private key.
export function createRsaSigner(privateKey: string): AppJwtSigner {
  const key = normalizeAppPrivateKey(privateKey);
  return {
    sign(input: string): string {
      const signer = createSign('RSA-SHA256');
      signer.update(input);
      signer.end();
      try {
        return signer.sign(key).toString('base64url');
      } catch {
        // A key we cannot sign with is a GitHub configuration problem, and it
        // has to say so. Left bare, node:crypto's error is not an ApiError, so
        // the error funnel renders it as an anonymous 500 INTERNAL_ERROR —
        // which is how a mangled key once looked exactly like a broken API.
        throw new ApiError(
          503,
          'GITHUB_APP_KEY_INVALID',
          'The GitHub App private key could not be read',
        );
      }
    },
  };
}

// Clock-skew margin. GitHub rejects a JWT whose `exp` is more than 10 minutes
// ahead of GITHUB's clock, so issuing at exactly iat + 600 fails whenever our
// clock runs even a second fast ("'Expiration time' claim ('exp') is too far
// in the future"). Backdating `iat` and shortening the lifetime, as GitHub's
// own documentation recommends, leaves a minute of slack at both ends.
const JWT_CLOCK_SKEW_SECONDS = 60;

// Builds the App JWT from an injectable signer. `iat` = floor(nowMs / 1000)
// backdated by the skew margin, `exp` = iat + 9 minutes (inside GitHub's
// 10-minute maximum even when our clock is a minute fast).
export function buildAppJwt(appId: string, signer: AppJwtSigner, nowMs: number): string {
  const header = { alg: 'RS256', typ: 'JWT' };
  const iat = Math.floor(nowMs / 1000) - JWT_CLOCK_SKEW_SECONDS;
  const payload = { iat, exp: iat + 600 - 2 * JWT_CLOCK_SKEW_SECONDS, iss: String(appId) };
  const headerB64 = base64Url(JSON.stringify(header));
  const payloadB64 = base64Url(JSON.stringify(payload));
  const signature = signer.sign(`${headerB64}.${payloadB64}`);
  return `${headerB64}.${payloadB64}.${signature}`;
}

// The "real" entry point: RS256-signed with the App's private key.
export function createAppJwt(appId: string, privateKey: string, nowMs: number): string {
  return buildAppJwt(appId, createRsaSigner(privateKey), nowMs);
}

// ---------------------------------------------------------------------------
// Installation token vending
// ---------------------------------------------------------------------------

// Exchanges an installation id for a short-lived installation access token.
// POSTs to /app/installations/{id}/access_tokens with the App JWT; the request
// body narrows the token's permissions to contents:read + metadata:read (S4).
export async function createInstallationToken(
  installationId: string,
  jwt: string,
  fetchFn: FetchFn,
): Promise<{ token: string; expiresAt: string }> {
  const url = `${GITHUB_API_BASE}/app/installations/${installationId}/access_tokens`;
  const response = await fetchFn(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${jwt}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ permissions: TOKEN_REQUEST_PERMISSIONS }),
  });
  if (response.status < 200 || response.status >= 300) {
    throw new ApiError(502, 'GITHUB_TOKEN_FETCH_FAILED', 'Failed to mint a GitHub installation token');
  }
  const data = (await response.json()) as { token: string; expires_at: string };
  return { token: data.token, expiresAt: data.expires_at };
}

// Convenience: build the App JWT and exchange it in one call.
export async function mintInstallationToken(
  installationId: string,
  appId: string,
  privateKey: string,
  nowMs: number,
  fetchFn: FetchFn,
): Promise<{ token: string; expiresAt: string }> {
  const jwt = createAppJwt(appId, privateKey, nowMs);
  return createInstallationToken(installationId, jwt, fetchFn);
}

// ---------------------------------------------------------------------------
// Repo listing (GET /installation/repositories with the installation token)
// ---------------------------------------------------------------------------

export interface GithubRepository {
  id: string;
  name: string;
  fullName: string;
  description: string | null;
  private: boolean;
  defaultBranch: string;
}

// Lists the repos visible to an installation using the short-lived token.
// BLOCKED against real GitHub in this environment — testable via mock fetch.
export async function listInstallationRepositories(
  installationToken: string,
  fetchFn: FetchFn,
): Promise<GithubRepository[]> {
  const response = await fetchFn(`${GITHUB_API_BASE}/installation/repositories`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${installationToken}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (response.status < 200 || response.status >= 300) {
    throw new ApiError(502, 'GITHUB_REPO_LIST_FAILED', 'Failed to list repositories');
  }
  const data = (await response.json()) as {
    repositories: Array<{
      id: number;
      name: string;
      full_name: string;
      description: string | null;
      private: boolean;
      default_branch: string;
    }>;
  };
  return data.repositories.map((repo) => ({
    id: String(repo.id),
    name: repo.name,
    fullName: repo.full_name,
    description: repo.description,
    private: repo.private,
    defaultBranch: repo.default_branch,
  }));
}

// ---------------------------------------------------------------------------
// Installation store (Postgres — github_installations).
//
// Durable because the control plane runs as a Lambda: an in-memory map is
// empty on the next cold start and invisible to every other concurrent
// execution environment, so a vendor who connected GitHub would find the
// connection gone on the next request.
// ---------------------------------------------------------------------------

export interface GithubInstallationRecord {
  id: string;
  organizationId: string;
  accountLogin: string;
  accountType: 'Organization' | 'User';
}

export interface GithubInstallationStore {
  set(installation: GithubInstallationRecord): Promise<void>;
  delete(installationId: string): Promise<void>;
  get(installationId: string): Promise<GithubInstallationRecord | null>;
  listByOrganization(organizationId: string): Promise<GithubInstallationRecord[]>;
}

function toRecord(row: {
  id: string;
  organizationId: string;
  accountLogin: string;
  accountType: string;
}): GithubInstallationRecord {
  return {
    id: row.id,
    organizationId: row.organizationId,
    accountLogin: row.accountLogin,
    accountType: row.accountType === 'User' ? 'User' : 'Organization',
  };
}

export function createGithubStore(db: RuntimeDb): GithubInstallationStore {
  return {
    async set(installation) {
      await db
        .insert(schema.githubInstallations)
        .values(installation)
        .onConflictDoUpdate({
          target: schema.githubInstallations.id,
          set: {
            organizationId: installation.organizationId,
            accountLogin: installation.accountLogin,
            accountType: installation.accountType,
            updatedAt: new Date(),
          },
        });
    },

    async delete(installationId) {
      await db
        .delete(schema.githubInstallations)
        .where(eq(schema.githubInstallations.id, installationId));
    },

    async get(installationId) {
      const rows = await db
        .select()
        .from(schema.githubInstallations)
        .where(eq(schema.githubInstallations.id, installationId))
        .limit(1);
      const row = rows[0];
      return row ? toRecord(row) : null;
    },

    async listByOrganization(organizationId) {
      const rows = await db
        .select()
        .from(schema.githubInstallations)
        .where(eq(schema.githubInstallations.organizationId, organizationId));
      return rows.map(toRecord);
    },
  };
}

/** In-memory store — tests only; production always uses `createGithubStore`. */
export class InMemoryGithubInstallationStore implements GithubInstallationStore {
  private byId = new Map<string, GithubInstallationRecord>();

  async set(installation: GithubInstallationRecord): Promise<void> {
    this.byId.set(installation.id, installation);
  }

  async delete(installationId: string): Promise<void> {
    this.byId.delete(installationId);
  }

  async get(installationId: string): Promise<GithubInstallationRecord | null> {
    return this.byId.get(installationId) ?? null;
  }

  async listByOrganization(organizationId: string): Promise<GithubInstallationRecord[]> {
    return [...this.byId.values()].filter((record) => record.organizationId === organizationId);
  }
}

// ---------------------------------------------------------------------------
// Installation webhook handling
// ---------------------------------------------------------------------------

export interface GithubWebhookInstallation {
  id: number;
  account?: { login: string; type?: string } | undefined;
}

export interface GithubWebhookEvent {
  type: string;
  action?: string | undefined;
  installation?: GithubWebhookInstallation | undefined;
  sender?: { login: string } | undefined;
}

export type InstallationWebhookResult = 'removed' | 'ignored';

// Handles installation.deleted (drop the installation) — the ONLY installation
// event that carries enough information to act on.
//
// A webhook cannot bind an installation to a Deployz organization: the payload
// names a GitHub account, and nothing in it identifies the vendor's tenant.
// Matching the GitHub login against an organization slug cannot work either —
// `organizationSlug` always appends a random seed, so no slug ever equals a
// GitHub login. The binding therefore happens where the vendor's session is
// present: GET /api/github/setup, the App's Setup URL, which GitHub redirects
// the installing user to with `installation_id` in the query.
export async function handleInstallationWebhook(
  store: GithubInstallationStore,
  event: GithubWebhookEvent,
): Promise<InstallationWebhookResult> {
  if (event.type !== 'installation') {
    return 'ignored';
  }
  const installation = event.installation;
  if (!installation) {
    return 'ignored';
  }

  if (event.action === 'deleted') {
    await store.delete(String(installation.id));
    return 'removed';
  }

  return 'ignored';
}

// Reads an installation's own account (login + type) with the App JWT, so the
// setup route can record who the installation belongs to without trusting
// anything the browser sent beyond the installation id itself.
export async function fetchInstallationAccount(
  installationId: string,
  jwt: string,
  fetchFn: FetchFn,
): Promise<{ accountLogin: string; accountType: 'Organization' | 'User' }> {
  const response = await fetchFn(`${GITHUB_API_BASE}/app/installations/${installationId}`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${jwt}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (response.status < 200 || response.status >= 300) {
    throw new ApiError(502, 'GITHUB_INSTALLATION_FETCH_FAILED', 'Failed to read the GitHub installation');
  }
  const data = (await response.json()) as {
    account?: { login?: string; type?: string } | undefined;
  };
  const accountLogin = data.account?.login;
  if (!accountLogin) {
    throw new ApiError(502, 'GITHUB_INSTALLATION_FETCH_FAILED', 'GitHub installation has no account');
  }
  return {
    accountLogin,
    accountType: data.account?.type === 'User' ? 'User' : 'Organization',
  };
}

// ---------------------------------------------------------------------------
// Fixtures (test mode) + list helpers
// ---------------------------------------------------------------------------

export interface GithubInstallation {
  id: string;
  accountLogin: string;
  accountType: string;
}

interface GithubFixtureInstallation extends GithubInstallation {
  repositories: GithubRepository[];
}

// §216: a fixture GitHub org with three fixture repos — one ready (health
// check + Postgres), one that needs a managed Redis cache (also ready), and
// one that needs attention (an unsupported Redis setup). Used ONLY when
// GITHUB_FIXTURE_MODE is set (tests / local dev); never fabricated in prod.
export const GITHUB_FIXTURE_INSTALLATIONS: readonly GithubFixtureInstallation[] = [
  {
    id: 'fixture-install-1',
    accountLogin: 'deployz-demo',
    accountType: 'Organization',
    repositories: [
      {
        id: 'fixture-repo-1',
        name: 'express-api',
        fullName: 'deployz-demo/express-api',
        description: "Ready to deploy — includes a health check and database config.",
        private: false,
        defaultBranch: 'main',
      },
      {
        id: 'fixture-repo-2',
        name: 'legacy-redis',
        fullName: 'deployz-demo/legacy-redis',
        description: "Depends on a service Deployz doesn't support yet.",
        private: false,
        defaultBranch: 'main',
      },
      {
        id: 'fixture-repo-3',
        name: 'bullmq-worker',
        fullName: 'deployz-demo/bullmq-worker',
        description: 'Node worker app using BullMQ — Redis managed automatically.',
        private: false,
        defaultBranch: 'main',
      },
      {
        id: 'fixture-repo-4',
        name: 'static-api',
        fullName: 'deployz-demo/static-api',
        description: 'Stateless API with no database — deploys without DB resources.',
        private: false,
        defaultBranch: 'main',
      },
      {
        id: 'fixture-repo-5',
        name: 'nextjs-prisma',
        fullName: 'deployz-demo/nextjs-prisma',
        description: 'Next.js app with Prisma and a required PostgreSQL database.',
        private: false,
        defaultBranch: 'main',
      },
      {
        id: 'fixture-repo-6',
        name: 'monorepo',
        fullName: 'deployz-demo/monorepo',
        description: 'pnpm workspace monorepo — the API app is nested under apps/api.',
        private: false,
        defaultBranch: 'main',
      },
    ],
  },
];

export async function listInstallations(
  store: GithubInstallationStore,
  organizationId: string,
  opts: { fixtureMode: boolean },
): Promise<GithubInstallation[]> {
  if (opts.fixtureMode) {
    return GITHUB_FIXTURE_INSTALLATIONS.map((installation) => ({
      id: installation.id,
      accountLogin: installation.accountLogin,
      accountType: installation.accountType,
    }));
  }
  const records = await store.listByOrganization(organizationId);
  return records.map((record) => ({
    id: record.id,
    accountLogin: record.accountLogin,
    accountType: record.accountType,
  }));
}

export async function listRepositories(
  installationId: string,
  opts: {
    fixtureMode: boolean;
    installationToken?: string | undefined;
    fetchFn?: FetchFn | undefined;
  },
): Promise<GithubRepository[]> {
  if (opts.fixtureMode) {
    const fixture = GITHUB_FIXTURE_INSTALLATIONS.find(
      (installation) => installation.id === installationId,
    );
    if (!fixture) {
      throw new ApiError(404, 'GITHUB_INSTALLATION_NOT_FOUND', 'GitHub installation not found');
    }
    return [...fixture.repositories];
  }
  if (!opts.installationToken || !opts.fetchFn) {
    throw new ApiError(503, 'GITHUB_DISABLED', 'GitHub App is not configured');
  }
  return listInstallationRepositories(opts.installationToken, opts.fetchFn);
}

// ---------------------------------------------------------------------------
// Repository tree fetch (§18 analysis input)
//
// GET /repos/{owner}/{repo}/git/trees/{branch}?recursive=1 lists every
// tracked path (no content), then we fetch the CONTENT of only the files the
// §18 detectors actually read (packages/analysis/src/detectors.ts) via the
// git blobs API. BLOCKED against real GitHub in this environment — testable
// via mock fetch, same seam as everything above. Same S4 permission scope
// (contents:read + metadata:read) as the rest of this file — no writes, no
// PRs, no checks.
// ---------------------------------------------------------------------------

/** A single entry from the GitHub git-trees API (recursive listing). */
interface GitTreeEntry {
  path: string;
  type: string; // 'blob' | 'tree' | 'commit'
  sha: string;
  size?: number | undefined;
}

// Caps on what we will ever download for one analysis run. A repository can
// have thousands of files; the §18 detectors only read a small, well-known
// set (Dockerfile, package.json, .env*, docker-compose.yml, **/schema.prisma,
// and source files by extension for env-var / port / health / fs / worker /
// external-service pattern matching — see isRelevantPath below). These caps
// bound both the number of GitHub API calls (one per fetched file) and the
// memory/time cost of running the detectors themselves.
export const ANALYSIS_MAX_FILES = 200;
export const ANALYSIS_MAX_FILE_BYTES = 200_000; // 200 KB per file
// Parallel blob reads. GitHub's secondary rate limits allow ~100 concurrent
// requests per installation; 12 keeps a comfortable margin while turning a
// minutes-long serial fetch into a few seconds.
export const ANALYSIS_FETCH_CONCURRENCY = 12;

// Directories the §18 detectors never need and that would otherwise blow the
// file cap on repos that (unusually) commit build output or vendored deps.
const IGNORED_DIR_SEGMENTS = new Set([
  'node_modules',
  'dist',
  'build',
  '.next',
  'out',
  'coverage',
  '.turbo',
  'cdk.out',
  'vendor',
  '.git',
]);

// Go joins the source set with the Stage A detectors that read Go route
// registrations and configuration literals (COMP-005, COMP-013).
const SOURCE_EXTENSION_REGEX = /\.(ts|js|mjs|cjs|jsx|tsx|py|rb|go)$/i;
// A manifest, a Dockerfile or a Prisma schema anywhere in the tree — a
// workspace repository keeps all three outside the root, and the detectors
// read every one of them (packages/analysis/src/detectors.ts).
const MANIFEST_REGEX = /(?:^|\/)package\.json$/i;
// Either naming order (`Dockerfile.prod`, `prod.Dockerfile`, `Dockerfile-build`) —
// the same shape packages/analysis/src/detectors.ts selects from (COMP-027).
const DOCKERFILE_REGEX = /(?:^|\/)(?:dockerfile(?:[.-][\w.-]+)?|[\w.-]+\.dockerfile)$/i;
const PRISMA_SCHEMA_REGEX = /schema\.prisma$/i;
// Non-npm manifests the §7 Redis detectors (and, for the other languages,
// the rest of the analyser) read — requirements.txt/pyproject.toml (Python),
// Gemfile (Ruby), go.mod (Go), composer.json (PHP), pom.xml/build.gradle
// (JVM), *.csproj (.NET), Cargo.toml (Rust), mix.exs (Elixir). Any depth,
// same as package.json — a workspace/monorepo keeps these outside the root
// too (COMP-029).
const OTHER_MANIFEST_REGEX =
  /(?:^|\/)(?:requirements\.txt|pyproject\.toml|Gemfile|go\.mod|composer\.json|pom\.xml|build\.gradle(?:\.kts)?|settings\.gradle(?:\.kts)?|libs\.versions\.toml|[\w.-]+\.csproj|Directory\.Packages\.props|Cargo\.toml|mix\.exs)$/i;
// docker-compose.yml/.yaml or compose.yml/.yaml, with an optional
// `.<name>` infix (`compose.prod.yml`, `docker-compose.override.yaml`), at
// any depth — the very-high-signal Redis/Valkey compose-image check reads
// these wherever they live, not just the repo root.
const COMPOSE_REGEX = /(?:^|\/)(?:docker-)?compose(?:\.[\w.-]+)?\.ya?ml$/i;
// .env.example/.env.template/.env.sample at any depth — the checked-in env
// samples vendors actually commit (never a real `.env`, which is gitignored).
const ENV_SAMPLE_REGEX = /(?:^|\/)\.env\.(?:example|template|sample)$/i;
// File-based health routes — the same shape detectHealthEndpoint matches on
// the path rather than on the file's contents.
const HEALTH_ROUTE_FILE_REGEX =
  /(?:^|\/)(?:health|healthz|healthcheck|heartbeat)(?:\.[jt]sx?|\/(?:route|index|\+server)\.[jt]sx?)$/i;
// Lockfiles the §18 package-manager detector needs — matched by BASENAME
// only (not `isRelevantPath`'s path-prefix shapes): their presence is the
// signal, never their content, so they are never blob-fetched and never
// count against ANALYSIS_MAX_FILES (see the lockfile loop in
// buildFileTreeForAnalysis below).
const LOCKFILE_BASENAME_REGEX =
  /^(?:pnpm-lock\.yaml|yarn\.lock|package-lock\.json|bun\.lockb?|bun\.lock)$/;

function isIgnoredPath(path: string): boolean {
  return path.split('/').some((segment) => IGNORED_DIR_SEGMENTS.has(segment));
}

// Mirrors exactly what packages/analysis/src/detectors.ts, rejection.ts and
// redis.ts read from the file tree — see those files for the authoritative
// patterns. Keep this in sync if a detector starts reading a new file shape.
function isRelevantPath(path: string): boolean {
  if (isIgnoredPath(path)) return false;
  if (MANIFEST_REGEX.test(path)) return true;
  if (OTHER_MANIFEST_REGEX.test(path)) return true;
  if (DOCKERFILE_REGEX.test(path)) return true;
  if (PRISMA_SCHEMA_REGEX.test(path)) return true;
  if (COMPOSE_REGEX.test(path)) return true;
  if (ENV_SAMPLE_REGEX.test(path)) return true;
  const isRoot = !path.includes('/');
  if (isRoot) {
    if (/^\.env(\.\w+)?$/i.test(path)) return true;
  }
  if (SOURCE_EXTENSION_REGEX.test(path)) return true;
  return false;
}

/** A lockfile at any depth, matched by basename — see LOCKFILE_BASENAME_REGEX. */
function isLockfilePath(path: string): boolean {
  if (isIgnoredPath(path)) return false;
  const basename = path.split('/').pop() ?? path;
  return LOCKFILE_BASENAME_REGEX.test(basename);
}

// Priority order for trimming to ANALYSIS_MAX_FILES when a repo has more
// relevant files than the cap: the small, high-signal config files always
// win a slot before the (potentially numerous) source files. A health-route
// file ranks above ordinary source because it is the only evidence of a
// health endpoint in a file-routed application.
//
// The generic "any relevant file sitting at the repo root" bucket is
// DELIBERATELY one tier below the named-pattern group (tier 0), not merged
// into it: an ordinary root-level script that happens to be relevant only
// because of its extension (app.py, manage.py, main.rb — no manifest/
// compose/env-sample name of its own) must never be able to outrank, and so
// crowd out of the ANALYSIS_MAX_FILES cap, a *named* signal file like a
// nested `docker-compose.yml` or `.env.example` that the Redis detectors
// specifically look for. Named patterns are checked (and returned) before
// this generic root check ever runs, so this bucket only ever catches
// unnamed root files.
//
// Tests, specs, fixtures, scripts, docs and tool configuration rank LAST
// (tier 6): the detectors ignore them (`isRuntimeSourcePath`, the same rule
// the analyser applies), and on a large repository they are numerous enough
// to push every application source file out of the cap (Stage A COMP-018).
// Within the application-source tiers, shallower files come first —
// `src/server.ts` before `src/features/x/y/z.ts`.
//
// Files where an application declares how it starts, listens and routes —
// the ones the port/health/env detectors need most on a repository with far
// more source files than the cap (a Go or Django tree can carry hundreds).
const ENTRY_FILE_REGEX =
  /(?:^|\/)(?:main|server|app|index|routes?|router|handlers?|config|settings|urls|options|env)\.[a-z]+$|(?:^|\/)(?:routes?|server|config|http)\//i;

function relevancePriority(path: string): number {
  if (MANIFEST_REGEX.test(path)) return 0;
  if (OTHER_MANIFEST_REGEX.test(path)) return 0;
  if (DOCKERFILE_REGEX.test(path)) return 0;
  if (COMPOSE_REGEX.test(path)) return 0;
  if (ENV_SAMPLE_REGEX.test(path)) return 0;
  if (!isRuntimeSourcePath(path)) return 6; // tests, specs, fixtures, scripts, docs, tool configs
  if (!path.includes('/')) return 1; // generic (unnamed) root files
  if (PRISMA_SCHEMA_REGEX.test(path)) return 2;
  if (HEALTH_ROUTE_FILE_REGEX.test(path)) return 3;
  if (ENTRY_FILE_REGEX.test(path)) return 4; // entry, routing and configuration source
  return 5; // other source files
}

function compareRelevance(a: string, b: string): number {
  const priorityDiff = relevancePriority(a) - relevancePriority(b);
  if (priorityDiff !== 0) return priorityDiff;
  return relevancePriority(a) >= 4 ? a.split('/').length - b.split('/').length : 0;
}

export interface RepositoryRef {
  owner: string;
  repo: string;
  branch: string;
}

// Splits an "owner/repo" full name into its parts. Throws a structured error
// on malformed input rather than producing a broken API URL.
export function parseRepoFullName(fullName: string): { owner: string; repo: string } {
  const parts = fullName.split('/');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new ApiError(
      400,
      'GITHUB_REPO_FULL_NAME_INVALID',
      `Malformed repository full name: ${fullName}`,
    );
  }
  return { owner: parts[0], repo: parts[1] };
}

async function readErrorMessage(response: { json(): Promise<unknown> }): Promise<string> {
  try {
    const body = (await response.json()) as { message?: string } | undefined;
    return body?.message ?? '';
  } catch {
    return '';
  }
}

// Fetches the full recursive file listing for a branch (paths + blob shas +
// sizes, no content). Handles the shared failure modes — repo/branch not
// found, empty repo (no commits => no tree), and GitHub rate limiting — by
// mapping each to a distinct structured ApiError so the analysis runner
// (apps/api/src/analysis.ts) can fail cleanly instead of throwing an
// unhandled error.
export async function fetchRepositoryTreeEntries(
  ref: RepositoryRef,
  installationToken: string,
  fetchFn: FetchFn,
): Promise<GitTreeEntry[]> {
  const url = `${GITHUB_API_BASE}/repos/${ref.owner}/${ref.repo}/git/trees/${encodeURIComponent(ref.branch)}?recursive=1`;
  const response = await fetchFn(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${installationToken}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });

  if (response.status === 429) {
    throw new ApiError(429, 'GITHUB_RATE_LIMITED', 'GitHub API rate limit exceeded');
  }
  if (response.status === 403 && response.headers.get('x-ratelimit-remaining') === '0') {
    throw new ApiError(429, 'GITHUB_RATE_LIMITED', 'GitHub API rate limit exceeded');
  }
  if (response.status === 404) {
    const message = await readErrorMessage(response);
    if (/empty/i.test(message)) {
      throw new ApiError(422, 'GITHUB_REPO_EMPTY', 'Repository has no commits to analyze');
    }
    throw new ApiError(404, 'GITHUB_REPO_NOT_FOUND', 'Repository or branch not found');
  }
  if (response.status === 409) {
    throw new ApiError(422, 'GITHUB_REPO_EMPTY', 'Repository has no commits to analyze');
  }
  if (response.status < 200 || response.status >= 300) {
    throw new ApiError(502, 'GITHUB_TREE_FETCH_FAILED', 'Failed to fetch repository tree');
  }

  const data = (await response.json()) as { tree?: GitTreeEntry[]; truncated?: boolean };
  return data.tree ?? [];
}

// Resolves a branch's current head commit sha — the Task 6 commit-SHA
// analysis cache uses this to decide whether a re-analysis would produce the
// same result as the one already stored. Best-effort: any non-200 (branch
// not found, rate limited, transient error) degrades to `undefined` rather
// than throwing, since a broken cache lookup must never become a failure
// reason for the analysis itself.
export async function fetchHeadSha(
  ref: RepositoryRef,
  installationToken: string,
  fetchFn: FetchFn,
): Promise<string | undefined> {
  const url = `${GITHUB_API_BASE}/repos/${ref.owner}/${ref.repo}/commits/${encodeURIComponent(ref.branch)}`;
  const response = await fetchFn(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${installationToken}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (response.status < 200 || response.status >= 300) {
    return undefined;
  }
  const data = (await response.json()) as { sha?: string };
  return data.sha;
}

// Fetches a single blob's content (base64-decoded to a UTF-8 string) by its
// git object sha — one call per relevant file, capped by ANALYSIS_MAX_FILES /
// ANALYSIS_MAX_FILE_BYTES in `buildFileTreeForAnalysis` below.
async function fetchBlobContent(
  ref: RepositoryRef,
  sha: string,
  installationToken: string,
  fetchFn: FetchFn,
): Promise<string | null> {
  const url = `${GITHUB_API_BASE}/repos/${ref.owner}/${ref.repo}/git/blobs/${sha}`;
  const response = await fetchFn(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${installationToken}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (response.status < 200 || response.status >= 300) {
    // A single unreadable file should not fail the whole analysis — the
    // detectors treat a missing key as "not present", which is the correct
    // degraded behaviour here too.
    return null;
  }
  const data = (await response.json()) as { content?: string; encoding?: string };
  if (!data.content) return null;
  if (data.encoding && data.encoding !== 'base64') return null;
  try {
    return Buffer.from(data.content, 'base64').toString('utf8');
  } catch {
    return null;
  }
}

// Builds the FileTree the §18 detectors expect: a small, capped subset of
// the repository's files, selected by `isRelevantPath` and bounded by
// ANALYSIS_MAX_FILES / ANALYSIS_MAX_FILE_BYTES. Fetches content for each
// selected file individually via the blob API (one GitHub API call per
// file) — acceptable at this scale because the cap keeps the call count
// bounded regardless of repository size.
export async function buildFileTreeForAnalysis(
  ref: RepositoryRef,
  installationToken: string,
  fetchFn: FetchFn,
): Promise<FileTree> {
  const entries = await fetchRepositoryTreeEntries(ref, installationToken, fetchFn);

  const candidates = entries
    .filter((entry) => entry.type === 'blob' && isRelevantPath(entry.path))
    .filter((entry) => entry.size === undefined || entry.size <= ANALYSIS_MAX_FILE_BYTES)
    .sort((a, b) => compareRelevance(a.path, b.path))
    .slice(0, ANALYSIS_MAX_FILES);

  // Fetched ANALYSIS_FETCH_CONCURRENCY at a time. One-at-a-time turns 200
  // independent blob reads into 200 round trips in series, which is minutes
  // of wall clock on a real repository — far longer than any request or
  // Lambda invocation lives.
  const tree: FileTree = {};
  let next = 0;
  const workers = Array.from(
    { length: Math.min(ANALYSIS_FETCH_CONCURRENCY, candidates.length) },
    async () => {
      while (next < candidates.length) {
        const entry = candidates[next++];
        if (!entry) break;
        const content = await fetchBlobContent(ref, entry.sha, installationToken, fetchFn);
        if (content !== null) {
          tree[entry.path] = content;
        }
      }
    },
  );
  await Promise.all(workers);

  // Lockfiles can exceed ANALYSIS_MAX_FILE_BYTES and their content is never
  // read — only their presence is the §18 package-manager detection signal.
  // Added as empty-content entries, independent of isRelevantPath's size cap
  // and ANALYSIS_MAX_FILES (a repo's lockfile must never lose a slot to an
  // unrelated source file).
  for (const entry of entries) {
    if (entry.type === 'blob' && isLockfilePath(entry.path)) {
      tree[entry.path] = '';
    }
  }

  return tree;
}

// §216 fixture file trees, keyed by the fixture repo's `fullName` (the same
// string `applications.repo_full_name` holds once a fixture repo is
// "selected" — there is no separate repo-id column on the row). Mirrors the
// six-repo shape in GITHUB_FIXTURE_INSTALLATIONS: express-api is fully
// compatible (Dockerfile + HEALTHCHECK + /health + Postgres + migration
// script); legacy-redis has an unsupported Redis setup (Redis Stack modules)
// so it reliably exercises the NOT_COMPATIBLE path end-to-end without real
// GitHub credentials; bullmq-worker is the same otherwise-READY shape as
// express-api plus a supported, high-confidence Redis requirement,
// exercising the "Redis — managed automatically" ready path end-to-end;
// nextjs-prisma (spec Fixture 1) is a Next.js + Prisma app whose PostgreSQL
// requirement is backed by both a Prisma `postgresql` provider and a
// DATABASE_URL reference — the required-vs-present evidence gating from the
// postgres provisioning task; monorepo (spec Fixture 4) is a pnpm workspace
// whose only application (and only Dockerfile) lives under apps/api, with no
// root start script — it exercises Dockerfile-candidate ranking across
// nested paths and the §15 'monorepo-target' unresolved question.
// Phase 14 adds three fixture trees that only ever appear as
// repoFullName-driven analysis targets (NOT in GITHUB_FIXTURE_INSTALLATIONS,
// so the repo picker never offers them): config-required-app is
// express-api's shape plus a genuine required env var (SESSION_SECRET read
// with no fallback) — the §11.2 missing-required-config gate fires at
// deployment creation until the vendor enters a value; mongodb-app is the
// same READY shape plus a mongoose dependency, so its only blocker is the
// unsupported database (§10); local-fs-app is the same READY shape plus a
// persistent local filesystem write, so its only blocker is the local-disk
// storage finding (§11.4).
export const GITHUB_FIXTURE_FILE_TREES: Readonly<Record<string, FileTree>> = {
  'deployz-demo/express-api': {
    'Dockerfile': [
      'FROM node:20-alpine',
      'WORKDIR /app',
      'COPY package*.json ./',
      'RUN npm ci --omit=dev',
      'COPY . .',
      'EXPOSE 3000',
      'HEALTHCHECK --interval=30s --timeout=3s CMD curl -f http://localhost:3000/health || exit 1',
      'CMD ["node", "dist/index.js"]',
    ].join('\n'),
    'package.json': JSON.stringify({
      name: 'express-api',
      scripts: { start: 'node dist/index.js', 'db:migrate': 'npx drizzle-kit push' },
      dependencies: { express: '^4.18.0', pg: '^8.12.0' },
    }),
    'src/index.ts': [
      "import express from 'express';",
      'const app = express();',
      "app.get('/health', (_req, res) => res.json({ ok: true }));",
      'app.listen(process.env.PORT || 3000);',
      '',
    ].join('\n'),
    '.env.example': 'DATABASE_URL=\n',
  },
  'deployz-demo/legacy-redis': {
    'package.json': JSON.stringify({
      name: 'legacy-redis',
      scripts: { start: 'node index.js' },
      // ioredis alone is a plain, SUPPORTED Redis client — @redis/json is
      // what actually makes this repo unsupported (Redis Stack modules,
      // §4 of the Redis MVP spec). Both stay: without a normal client
      // dependency too, `assessRedis` has no non-Stack evidence to report
      // and the rejection can't be attributed to Redis at all (a known
      // detection gap — see packages/analysis/src/redis.ts).
      dependencies: { express: '^4.18.0', ioredis: '^5.4.0', '@redis/json': '^1.0.6' },
    }),
    'index.js': [
      "const express = require('express');",
      'const app = express();',
      'app.listen(process.env.PORT || 3000);',
      '',
    ].join('\n'),
  },
  // Otherwise READY-shaped (same Dockerfile/health/Postgres/migration shape
  // as express-api above) but with a direct `bullmq` dependency and a
  // REDIS_URL sample — a supported, high-confidence Redis requirement that
  // exercises the "Redis — managed automatically" ready path end-to-end.
  'deployz-demo/bullmq-worker': {
    'Dockerfile': [
      'FROM node:20-alpine',
      'WORKDIR /app',
      'COPY package*.json ./',
      'RUN npm ci --omit=dev',
      'COPY . .',
      'EXPOSE 3000',
      'HEALTHCHECK --interval=30s --timeout=3s CMD curl -f http://localhost:3000/health || exit 1',
      'CMD ["node", "dist/index.js"]',
    ].join('\n'),
    'package.json': JSON.stringify({
      name: 'bullmq-worker',
      scripts: { start: 'node dist/index.js', 'db:migrate': 'npx drizzle-kit push' },
      dependencies: { express: '^4.18.0', pg: '^8.12.0', bullmq: '^5.7.0' },
    }),
    'src/index.ts': [
      "import express from 'express';",
      'const app = express();',
      "app.get('/health', (_req, res) => res.json({ ok: true }));",
      'app.listen(process.env.PORT || 3000);',
      '',
    ].join('\n'),
    '.env.example': ['DATABASE_URL=', 'REDIS_URL=', ''].join('\n'),
  },
  // A stateless API with no database: Dockerfile + HEALTHCHECK + /health +
  // a migration script, but no PostgreSQL driver. Analysis resolves to
  // databaseState 'none' and databaseRequired stays false — the app deploys
  // without RDS resources or DATABASE_* env vars.
  'deployz-demo/static-api': {
    'Dockerfile': [
      'FROM node:20-alpine',
      'WORKDIR /app',
      'COPY package*.json ./',
      'RUN npm ci --omit=dev',
      'COPY . .',
      'EXPOSE 3000',
      'HEALTHCHECK --interval=30s --timeout=3s CMD curl -f http://localhost:3000/health || exit 1',
      'CMD ["node", "dist/index.js"]',
    ].join('\n'),
    'package.json': JSON.stringify({
      name: 'static-api',
      scripts: { start: 'node dist/index.js', 'db:migrate': 'npx migrate up' },
      dependencies: { express: '^4.18.0' },
    }),
    'src/index.ts': [
      "import express from 'express';",
      'const app = express();',
      "app.get('/health', (_req, res) => res.json({ ok: true }));",
      'app.listen(process.env.PORT || 3000);',
      '',
    ].join('\n'),
  },
  // Next.js + Prisma, spec Fixture 1: a Prisma `postgresql` provider AND a
  // DATABASE_URL reference — the two independent signals `assessPostgres`
  // requires alongside the `@prisma/client` dependency for
  // `postgres.required: true` (RDS provisioning). Otherwise READY-shaped
  // (Dockerfile + HEALTHCHECK + a file-routed /health endpoint + a migration
  // script), and package-manager/build-command detection via the root
  // `packageManager` pin and `scripts.build`.
  'deployz-demo/nextjs-prisma': {
    'Dockerfile': [
      'FROM node:20-alpine',
      'WORKDIR /app',
      'COPY package*.json ./',
      'RUN npm ci --omit=dev',
      'COPY . .',
      'RUN npm run build',
      'EXPOSE 3000',
      'HEALTHCHECK --interval=30s --timeout=3s CMD curl -f http://localhost:3000/health || exit 1',
      'CMD ["npm", "start"]',
    ].join('\n'),
    'package.json': JSON.stringify({
      name: 'nextjs-prisma',
      packageManager: 'pnpm@9.0.0',
      scripts: { build: 'next build', start: 'next start', 'db:migrate': 'prisma migrate deploy' },
      dependencies: { next: '^14.2.0', '@prisma/client': '^5.14.0' },
      devDependencies: { prisma: '^5.14.0' },
    }),
    'prisma/schema.prisma': [
      'datasource db {',
      '  provider = "postgresql"',
      '  url      = env("DATABASE_URL")',
      '}',
      '',
    ].join('\n'),
    '.env.example': ['DATABASE_URL=', 'NEXTAUTH_SECRET=', ''].join('\n'),
    'app/api/health/route.ts': [
      "export async function GET() {",
      '  return Response.json({ ok: true });',
      '}',
      '',
    ].join('\n'),
  },
  // Monorepo, spec Fixture 4: a pnpm workspace whose only application (and
  // only Dockerfile) lives under apps/api — exercises `detectDockerfile`'s
  // shallower-wins ranking across nested paths (there is only one candidate
  // here, but it is two levels deep, not at the root) and the §15
  // 'monorepo-target' unresolved question (>=3 package.json files, no root
  // start script, no root Dockerfile).
  'deployz-demo/monorepo': {
    'pnpm-workspace.yaml': ['packages:', '  - apps/*', ''].join('\n'),
    'pnpm-lock.yaml': '',
    'package.json': JSON.stringify({
      name: 'monorepo',
      private: true,
      packageManager: 'pnpm@9',
    }),
    'apps/web/package.json': JSON.stringify({
      name: 'web',
      scripts: { build: 'next build', dev: 'next dev' },
      dependencies: { next: '^14.2.0' },
    }),
    'apps/api/package.json': JSON.stringify({
      name: 'api',
      scripts: { start: 'node src/index.js' },
      dependencies: { express: '^4.18.0' },
    }),
    'apps/api/Dockerfile': [
      'FROM node:20-alpine',
      'WORKDIR /app',
      'COPY apps/api/package.json ./',
      'RUN npm ci --omit=dev',
      'COPY apps/api/src ./src',
      'EXPOSE 3000',
      'CMD ["node", "src/index.js"]',
    ].join('\n'),
    'apps/api/src/index.js': [
      "const express = require('express');",
      'const app = express();',
      'app.listen(process.env.PORT || 3000);',
      '',
    ].join('\n'),
  },
  // Express-api's exact READY shape (Dockerfile + HEALTHCHECK + /health +
  // Postgres + migration script) plus one genuine required env var: the code
  // READS SESSION_SECRET with no fallback and no guard, and the sample file
  // only declares it (no usable default). Analysis-level readiness stays READY
  // (required env values are unknowable to the analyser); the §11.2
  // deployment-creation gate refuses MANIFEST_NEEDS_CONFIGURATION until the
  // vendor enters a value on the Configuration screen.
  'deployz-demo/config-required-app': {
    'Dockerfile': [
      'FROM node:20-alpine',
      'WORKDIR /app',
      'COPY package*.json ./',
      'RUN npm ci --omit=dev',
      'COPY . .',
      'EXPOSE 3000',
      'HEALTHCHECK --interval=30s --timeout=3s CMD curl -f http://localhost:3000/health || exit 1',
      'CMD ["node", "dist/index.js"]',
    ].join('\n'),
    'package.json': JSON.stringify({
      name: 'config-required-app',
      scripts: { start: 'node dist/index.js', 'db:migrate': 'npx drizzle-kit push' },
      dependencies: { express: '^4.18.0', pg: '^8.12.0' },
    }),
    'src/index.ts': [
      "import express from 'express';",
      "import crypto from 'node:crypto';",
      'const app = express();',
      // A required read: no `??`/`||` fallback, no presence guard. The app
      // cannot start without a signing secret, so the var is genuinely
      // required (detectEnvVarModel's narrow rule).
      'const signingKey = process.env.SESSION_SECRET;',
      'function sign(value: string): string {',
      '  return crypto.createHmac("sha256", signingKey).update(value).digest("hex");',
      '}',
      "app.get('/health', (_req, res) => res.json({ ok: true, tag: sign('health') }));",
      'app.listen(process.env.PORT || 3000);',
      '',
    ].join('\n'),
    '.env.example': 'DATABASE_URL=\nSESSION_SECRET=\n',
  },
  // The same otherwise-READY express-api shape with a mongoose dependency —
  // a MongoDB app whose ONLY blocker is the unsupported database. Used by
  // the Phase 14 scenario-matrix spec to prove an unsupported repo is
  // refused at deployment creation with NO AWS provisioning.
  'deployz-demo/mongodb-app': {
    'Dockerfile': [
      'FROM node:20-alpine',
      'WORKDIR /app',
      'COPY package*.json ./',
      'RUN npm ci --omit=dev',
      'COPY . .',
      'EXPOSE 3000',
      'HEALTHCHECK --interval=30s --timeout=3s CMD curl -f http://localhost:3000/health || exit 1',
      'CMD ["node", "dist/index.js"]',
    ].join('\n'),
    'package.json': JSON.stringify({
      name: 'mongodb-app',
      scripts: { start: 'node dist/index.js' },
      dependencies: { express: '^4.18.0', mongoose: '^8.0.0' },
    }),
    'src/index.ts': [
      "import express from 'express';",
      'const app = express();',
      "app.get('/health', (_req, res) => res.json({ ok: true }));",
      'app.listen(process.env.PORT || 3000);',
      '',
    ].join('\n'),
  },
  // The same otherwise-READY express-api shape plus one persistent local
  // filesystem write — an app whose ONLY blocker is the ephemeral-disk
  // storage finding. Used by the Phase 14 scenario-matrix spec to prove a
  // repairable repo is refused at deployment creation with the repair
  // guidance surfaced (fix-instructions).
  'deployz-demo/local-fs-app': {
    'Dockerfile': [
      'FROM node:20-alpine',
      'WORKDIR /app',
      'COPY package*.json ./',
      'RUN npm ci --omit=dev',
      'COPY . .',
      'EXPOSE 3000',
      'HEALTHCHECK --interval=30s --timeout=3s CMD curl -f http://localhost:3000/health || exit 1',
      'CMD ["node", "dist/index.js"]',
    ].join('\n'),
    'package.json': JSON.stringify({
      name: 'local-fs-app',
      scripts: { start: 'node dist/index.js' },
      dependencies: { express: '^4.18.0' },
    }),
    'src/storage.ts': [
      "import fs from 'node:fs';",
      '// Persistent state written to the local disk — unsupported in',
      '// Deployz\u2019s ephemeral container model (wipe-on-every-deploy).',
      'export function saveUpload(file: Buffer): string {',
      "  const path = '/data/' + Date.now();",
      '  fs.writeFileSync(path, file);',
      '  return path;',
      '}',
      '',
    ].join('\n'),
    'src/index.ts': [
      "import express from 'express';",
      'const app = express();',
      "app.get('/health', (_req, res) => res.json({ ok: true }));",
      'app.listen(process.env.PORT || 3000);',
      '',
    ].join('\n'),
  },
};

// Builds the analysis FileTree for one application's repository, branching
// on fixture vs real GitHub exactly like `listRepositories` above. In
// fixture mode, the tree is looked up by `repoFullName` — no network call,
// no installation token. In real mode, an installation token and branch are
// required (the caller mints the token the same way the /api/github/repos
// route does) and the repository name is split + fetched from GitHub.
export async function getFileTreeForAnalysis(
  repoFullName: string,
  opts: {
    fixtureMode: boolean;
    branch?: string | undefined;
    installationToken?: string | undefined;
    fetchFn?: FetchFn | undefined;
  },
): Promise<FileTree> {
  if (opts.fixtureMode) {
    const fixtureTree = GITHUB_FIXTURE_FILE_TREES[repoFullName];
    if (!fixtureTree) {
      throw new ApiError(404, 'GITHUB_REPO_NOT_FOUND', 'Repository not found');
    }
    return { ...fixtureTree };
  }
  if (!opts.installationToken || !opts.fetchFn || !opts.branch) {
    throw new ApiError(503, 'GITHUB_DISABLED', 'GitHub App is not configured');
  }
  const { owner, repo } = parseRepoFullName(repoFullName);
  return buildFileTreeForAnalysis(
    { owner, repo, branch: opts.branch },
    opts.installationToken,
    opts.fetchFn,
  );
}
