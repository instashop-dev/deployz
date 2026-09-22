/**
 * Configuration for the version/rollback canary — everything that
 * identifies WHICH control plane, WHICH AWS account and WHICH run this is.
 *
 * Hard rules (docs/testing/version-rollback-canary.md):
 * - the AWS account must equal the expected test account, or nothing runs;
 * - every run has a unique run id that names its evidence directory, its
 *   release versions and its resource tags;
 * - real AWS is opt-in (`DEPLOYZ_E2E_ALLOW_REAL_AWS=1`), checked before any
 *   AWS or control-plane call.
 */
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';

export const CANARY_TAGS = {
  canary: 'DeployzCanary',
  run: 'DeployzCanaryRun',
  testMode: 'DeployzTestMode',
  environment: 'DeployzEnvironment',
} as const;

export type CanaryProfileName = 'pg' | 'stateless' | 'redis';

/** One certifiable infrastructure profile: the requirements the application
 * manifest must carry. Storage stays on in every profile. Every profile runs
 * the default fixture repository — a real GitHub repo with the v1…v4 tag
 * ladder the preflight asserts — and the requirements are forced through the
 * platform's vendor-override path; the fixture app is stateless-safe (its
 * /health never depends on the database), so the same image certifies every
 * profile. */
export interface CanaryProfile {
  readonly name: CanaryProfileName;
  readonly postgres: boolean;
  readonly redis: boolean;
  readonly fixtureRepo: string;
}

const DEFAULT_FIXTURE_REPO = 'instashop-dev/deployz-canary-app';

const CANARY_PROFILES: Readonly<Record<CanaryProfileName, Omit<CanaryProfile, 'name'>>> = {
  pg: { postgres: true, redis: false, fixtureRepo: DEFAULT_FIXTURE_REPO },
  stateless: { postgres: false, redis: false, fixtureRepo: DEFAULT_FIXTURE_REPO },
  redis: { postgres: false, redis: true, fixtureRepo: DEFAULT_FIXTURE_REPO },
};

export interface CanaryConfig {
  readonly runId: string;
  readonly apiUrl: string;
  /** The dashboard origin, sent as the Origin header (the API only accepts auth calls from it). */
  readonly webUrl: string;
  readonly region: string;
  /**
   * Where the control-plane-side resources live — the `deployz-images` ECR
   * repository and the `Deployz-TemplateBucket` export — which only exist in
   * us-east-1. `region` is the install (customer) region and can differ from
   * this when a run targets another region (env `DEPLOYZ_CONTROL_PLANE_REGION`
   * or `--region` in Stage B). Every customer-side read/write stays on
   * `region`; only ECR and the template bucket route through this one.
   */
  readonly controlPlaneRegion: string;
  readonly expectedAccountId: string;
  readonly githubInstallationId: string;
  readonly fixtureRepo: string;
  readonly resultsDir: string;
  /** Skip the destroy/purge/teardown at the end (debugging only). */
  readonly keep: boolean;
  /**
   * When set, skip CodeBuild/GitHub-source rebuilds and use this digest
   * for every release version.  Format: `sha256:[0-9a-f]{64}`.
   * Set via `--existing-image` or env `DEPLOYZ_E2E_EXISTING_IMAGE_DIGEST`.
   */
  readonly existingImageDigest: string | null;
  /**
   * When true, reuse a standing stack tagged DeployzPersistent=true +
   * DeployzTestMode=canary instead of creating one. Skips bootstrap/stack
   * creation and final infrastructure teardown.
   * Set via `--reuse-stack`.
   */
  readonly reuseStack: boolean;
  /**
   * The infrastructure profile this run certifies (env DEPLOYZ_CANARY_PROFILE
   * or `--profile`): the requirements the application must carry and the
   * fixture repo that supplies it. `null` — the default — keeps the legacy
   * core-ladder behaviour: databaseRequired true, redisRequired left to
   * analysis, default fixture repo.
   */
  readonly profile: CanaryProfile | null;
  /**
   * Reuse an existing customer instead of creating a throwaway one — the
   * second-deployment scenario (docs/https-regional-certificates.md
   * Verification plan, scenario B: same customer and region, same regional
   * certificate). Set via `--customer-id <uuid>`, or `--reuse-customer-from
   * <runId>` resolved against a prior run's evidence (index.ts). `null` —
   * the default — keeps the legacy behaviour: every run creates its own
   * customer.
   */
  readonly customerId: string | null;
  /**
   * Whether the leak audit should treat a retained regional certificate
   * (tagged `deployz:customer-scope`) as a leak. Default false: a shared
   * wildcard certificate is correctly retained after a single
   * Disconnect/Purge while sibling deployments still exist in the scope
   * (docs/https-regional-certificates.md decision 5). Set only for a run
   * that purged the last deployment in its scope. Set via
   * `--expect-regional-cert-removed`.
   */
  readonly expectRegionalCertRemoved: boolean;
}

export function mintRunId(now: Date = new Date()): string {
  const stamp = now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, '')
    .replace('T', '-');
  return `${stamp}-${randomBytes(2).toString('hex')}`;
}

export function requireRealAwsOptIn(env: NodeJS.ProcessEnv): void {
  if (env['DEPLOYZ_E2E_ALLOW_REAL_AWS'] !== '1') {
    throw new Error(
      'Real AWS E2E is disabled.\nSet DEPLOYZ_E2E_ALLOW_REAL_AWS=1\nonly when intentionally running AWS-backed E2E tests.',
    );
  }
}

const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;

/** Validates a digest string, returning it or throwing on bad format. */
export function validateDigest(digest: string | null | undefined): string | null {
  if (digest == null || digest === '') return null;
  if (!DIGEST_RE.test(digest)) {
    throw new Error(
      `Invalid image digest: "${digest}". Expected format: sha256: followed by exactly 64 hex characters.`,
    );
  }
  return digest;
}

/**
 * The infrastructure profile for this run. Unset or empty keeps the legacy
 * behaviour; an unknown value fails fast — a typo would otherwise certify
 * the wrong profile silently.
 */
function loadProfile(env: NodeJS.ProcessEnv, overrideName?: string): CanaryProfile | null {
  const name = (overrideName ?? env['DEPLOYZ_CANARY_PROFILE'] ?? '').trim();
  if (name === '') return null;
  const shape = CANARY_PROFILES[name as CanaryProfileName];
  if (!shape) {
    throw new Error(
      `Unknown canary profile "${name}". Use pg (PostgreSQL only), stateless (neither) or redis (Redis only), ` +
        `or leave DEPLOYZ_CANARY_PROFILE unset for the legacy PostgreSQL+Redis ladder.`,
    );
  }
  return { name: name as CanaryProfileName, ...shape };
}

export function loadConfig(
  env: NodeJS.ProcessEnv,
  overrides: Partial<
    Pick<CanaryConfig, 'runId' | 'keep' | 'existingImageDigest' | 'reuseStack' | 'customerId' | 'expectRegionalCertRemoved'>
  > & {
    /** The profile name from `--profile`; wins over DEPLOYZ_CANARY_PROFILE. */
    profileName?: string;
  } = {},
): CanaryConfig {
  const profile = loadProfile(env, overrides.profileName);
  return {
    // Empty strings mint a run id: a workflow can pass an optional run-id
    // input straight through as an env var.
    runId: overrides.runId || env['DEPLOYZ_CANARY_RUN_ID'] || mintRunId(),
    apiUrl: (env['DEPLOYZ_CANARY_API_URL'] ?? 'https://api.deployz.dev').replace(/\/$/, ''),
    webUrl: (env['DEPLOYZ_CANARY_WEB_URL'] ?? 'https://app.deployz.dev').replace(/\/$/, ''),
    region: env['AWS_REGION'] ?? 'us-east-1',
    controlPlaneRegion: env['DEPLOYZ_CONTROL_PLANE_REGION'] ?? 'us-east-1',
    expectedAccountId: env['DEPLOYZ_CANARY_EXPECTED_ACCOUNT'] ?? '151955775369',
    githubInstallationId: env['DEPLOYZ_CANARY_GITHUB_INSTALLATION_ID'] ?? '156387233',
    // An explicit fixture repo always wins over the profile's default.
    fixtureRepo: env['DEPLOYZ_CANARY_FIXTURE_REPO'] ?? profile?.fixtureRepo ?? DEFAULT_FIXTURE_REPO,
    resultsDir: resolve(env['DEPLOYZ_CANARY_RESULTS_DIR'] ?? 'canary-results'),
    keep: overrides.keep ?? false,
    existingImageDigest: validateDigest(overrides.existingImageDigest ?? env['DEPLOYZ_E2E_EXISTING_IMAGE_DIGEST'] ?? null),
    reuseStack: overrides.reuseStack ?? false,
    profile,
    customerId: overrides.customerId || env['DEPLOYZ_CANARY_CUSTOMER_ID'] || null,
    expectRegionalCertRemoved: overrides.expectRegionalCertRemoved ?? false,
  };
}

/** The tags stamped on every resource the canary itself creates. */
export function canaryTags(runId: string): Record<string, string> {
  return {
    [CANARY_TAGS.canary]: 'true',
    [CANARY_TAGS.run]: runId,
    [CANARY_TAGS.testMode]: 'canary',
    [CANARY_TAGS.environment]: 'e2e',
  };
}

/**
 * Release versions are per run: the shared ECR repository has immutable
 * tags and the version becomes the image tag, so `v1` alone would collide
 * with any other application's `v1`. The fixture tag stays the artifact's
 * identity (`/version` answers `v1`); the Deployz release name carries the
 * run.
 */
export function releaseVersionFor(runId: string, fixtureTag: string): string {
  return `${fixtureTag}-${runId}`;
}
