import { createHmac, createSign, timingSafeEqual } from 'node:crypto';

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

// RS256 signer backed by the App's private key.
export function createRsaSigner(privateKey: string): AppJwtSigner {
  return {
    sign(input: string): string {
      const signer = createSign('RSA-SHA256');
      signer.update(input);
      signer.end();
      return signer.sign(privateKey).toString('base64url');
    },
  };
}

// Builds the App JWT from an injectable signer. `iat` = floor(nowMs / 1000),
// `exp` = iat + 10 minutes (GitHub's maximum token lifetime).
export function buildAppJwt(appId: string, signer: AppJwtSigner, nowMs: number): string {
  const header = { alg: 'RS256', typ: 'JWT' };
  const iat = Math.floor(nowMs / 1000);
  const payload = { iat, exp: iat + 600, iss: String(appId) };
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
// Installation store (in-memory — there is no installations table yet, and
// packages/db is guarded; the applications.github_installation_id column is
// the durable pointer once a repo is selected in todo 25).
// ---------------------------------------------------------------------------

export interface GithubInstallationRecord {
  id: string;
  organizationId: string;
  accountLogin: string;
  accountType: 'Organization' | 'User';
}

export interface GithubInstallationStore {
  set(installation: GithubInstallationRecord): void;
  delete(installationId: string): void;
  listByOrganization(organizationId: string): GithubInstallationRecord[];
}

export class InMemoryGithubInstallationStore implements GithubInstallationStore {
  private byId = new Map<string, GithubInstallationRecord>();

  set(installation: GithubInstallationRecord): void {
    this.byId.set(installation.id, installation);
  }

  delete(installationId: string): void {
    this.byId.delete(installationId);
  }

  listByOrganization(organizationId: string): GithubInstallationRecord[] {
    return [...this.byId.values()].filter((record) => record.organizationId === organizationId);
  }
}

export function createGithubStore(): GithubInstallationStore {
  return new InMemoryGithubInstallationStore();
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

// Maps a GitHub account login to a Deployz organization id. The real mapping
// (vendor installs the App on their GitHub org while signed in) is BLOCKED —
// no account->org table exists yet, so the default resolver returns null and
// the handler degrades to a no-op. Tests inject a resolver returning a known
// org id.
export type ResolveOrganization = (accountLogin: string) => Promise<string | null>;

export type InstallationWebhookResult = 'stored' | 'removed' | 'ignored';

// Handles installation.created (store the installation id against the org) and
// installation.deleted (remove it). Any other action/type is ignored.
export async function handleInstallationWebhook(
  store: GithubInstallationStore,
  event: GithubWebhookEvent,
  resolveOrganization: ResolveOrganization,
): Promise<InstallationWebhookResult> {
  if (event.type !== 'installation') {
    return 'ignored';
  }
  const installation = event.installation;
  if (!installation) {
    return 'ignored';
  }

  if (event.action === 'deleted') {
    store.delete(String(installation.id));
    return 'removed';
  }

  if (event.action === 'created') {
    const accountLogin = installation.account?.login;
    if (!accountLogin) {
      return 'ignored';
    }
    const organizationId = await resolveOrganization(accountLogin);
    if (!organizationId) {
      return 'ignored';
    }
    store.set({
      id: String(installation.id),
      organizationId,
      accountLogin,
      accountType: installation.account?.type === 'User' ? 'User' : 'Organization',
    });
    return 'stored';
  }

  return 'ignored';
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

// §216: a fixture GitHub org with two fixture repos — one ready (health check +
// Postgres), one that needs attention (Redis dependency). Used ONLY when
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
  return store.listByOrganization(organizationId).map((record) => ({
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
