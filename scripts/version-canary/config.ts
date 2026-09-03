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

export interface CanaryConfig {
  readonly runId: string;
  readonly apiUrl: string;
  /** The dashboard origin, sent as the Origin header (the API only accepts auth calls from it). */
  readonly webUrl: string;
  readonly region: string;
  readonly expectedAccountId: string;
  readonly githubInstallationId: string;
  readonly fixtureRepo: string;
  readonly resultsDir: string;
  /** Skip the destroy/purge/teardown at the end (debugging only). */
  readonly keep: boolean;
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

export function loadConfig(
  env: NodeJS.ProcessEnv,
  overrides: Partial<Pick<CanaryConfig, 'runId' | 'keep'>> = {},
): CanaryConfig {
  return {
    runId: overrides.runId ?? env['DEPLOYZ_CANARY_RUN_ID'] ?? mintRunId(),
    apiUrl: (env['DEPLOYZ_CANARY_API_URL'] ?? 'https://api.deployz.dev').replace(/\/$/, ''),
    webUrl: (env['DEPLOYZ_CANARY_WEB_URL'] ?? 'https://app.deployz.dev').replace(/\/$/, ''),
    region: env['AWS_REGION'] ?? 'us-east-1',
    expectedAccountId: env['DEPLOYZ_CANARY_EXPECTED_ACCOUNT'] ?? '151955775369',
    githubInstallationId: env['DEPLOYZ_CANARY_GITHUB_INSTALLATION_ID'] ?? '156387233',
    fixtureRepo: env['DEPLOYZ_CANARY_FIXTURE_REPO'] ?? 'instashop-dev/deployz-canary-app',
    resultsDir: resolve(env['DEPLOYZ_CANARY_RESULTS_DIR'] ?? 'canary-results'),
    keep: overrides.keep ?? false,
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
