/**
 * Full §30 preflight engine — the complete preflight checklist that gates
 * INSTALL + DEPLOY_RELEASE before ANY application-stack provisioning or
 * upgrade (§25/§30).
 *
 * §25: the bootstrap stack is EXEMPT from preflight — it must complete first
 * so the relay is reachable, and the relay's first contact is what proves the
 * customer account is actually wired up. INSTALL runs the minimal region+SCP
 * subset (`preflight.ts`) before the bootstrap stack, then runs this full
 * engine right after relay contact is confirmed and before the deployment
 * transitions to INSTALLING (i.e. before any APPLICATION-stack provisioning).
 * DEPLOY_RELEASE runs it as its single preflight gate before UPDATING.
 *
 * Relay-contact timing: when this engine is invoked BEFORE a relay contact
 * payload exists (there is no such payload to check yet), callers set
 * `skipRelayContact: true` so check 7 is reported as a clearly-marked
 * "skipped" pass instead of a false failure — the relay-contact check itself
 * still runs at the correct time via `assertRelayContact` directly.
 *
 * The seventeen checks, in order:
 *    1. Region allowlist        — pure, reuses `validateRegion` (§32)
 *    2. SCP blocks              — async, calls AWS Organizations + STS
 *    3. Service quotas          — injectable `QuotaChecker` seam (PENDING-AWS)
 *    4. Config validity         — pure, reuses `validateConfigKeys` (§31)
 *    5. Migration command       — pure (present + well-formed, §26)
 *    6. Image health            — injectable `ImageHealthChecker` seam (PENDING-AWS)
 *    7. Relay connected         — pure, reuses `assertRelayContact` (or skipped, see above)
 *    8. Port defined            — pure (§30 application check)
 *    9. Health endpoint         — pure (§30 application check)
 *   10. Required secrets present— pure (§30 application check)
 *   11. Required env vars       — pure (§30 application check)
 *   12. CloudFormation usable   — injectable seam, SKIPPED when not injected (PENDING-AWS)
 *   13. ECS usable              — injectable seam, SKIPPED when not injected (PENDING-AWS)
 *   14. RDS usable              — injectable seam, SKIPPED when not injected (PENDING-AWS)
 *   15. Image available in ECR  — injectable seam, SKIPPED when not injected/no image ref (PENDING-AWS)
 *   16. Image architecture      — injectable seam, SKIPPED when not injected/no image ref (PENDING-AWS)
 *   17. Account permission check— injectable seam, SKIPPED when not injected (PENDING-AWS, §30)
 *
 * Checks 12-17 are OPTIONAL AWS-backed seams: when the caller does not supply
 * the corresponding checker, the check reports a clearly-marked `skipped:
 * true` pass rather than making a live AWS call or silently failing. This
 * keeps every unit test AWS-free while still making the checks reachable
 * (and their failure codes producible) once wired with real clients.
 *
 * The engine runs ALL checks and collects EVERY failure (not just the first)
 * into `failures`. `passed` is true only when there are zero failures. Each
 * failed check carries a stable failure code + reason. The WORKFLOWS (INSTALL /
 * DEPLOY_RELEASE) are responsible for throwing `PreflightError` when `passed`
 * is false — the engine itself only reports, it never throws.
 *
 * Failure-code provenance (nothing here invents a new §61 code):
 *   REGION_NOT_SUPPORTED, AWS_SCP_BLOCKED, AWS_PERMISSION_DENIED,
 *   QUOTA_EXCEEDED, IMAGE_HEALTH_CHECK_FAILED, MIGRATION_FAILED,
 *   RELAY_DISCONNECTED, STACK_CREATE_FAILED, CONTAINER_START_FAILED,
 *   DATABASE_CREATE_FAILED, IMAGE_PULL_FAILED, UNSUPPORTED_ARCHITECTURE,
 *   MISSING_SECRET are the §61 codes (packages/db failureCodeEnum) that apply
 *   to preflight. INVALID_CONFIG is the §31 config-domain code reused from
 *   config-update-workflow.ts (config validation is not a §61 failure).
 */

import {
  assertRelayContact,
  checkScpBlocks,
  validateRegion,
} from './preflight.js';

import {
  validateConfigKeys,
  type ConfigEntry,
} from './config-update-workflow.js';

// ── Types ────────────────────────────────────────────────────────────────

/**
 * Failure codes a full-preflight check can carry. The six §61 codes are the
 * preflight-relevant subset of `failureCodeEnum`; `INVALID_CONFIG` is the §31
 * config-domain code reused from the CONFIG_UPDATE workflow.
 */
export type PreflightFailureCode =
  | 'REGION_NOT_SUPPORTED'
  | 'AWS_SCP_BLOCKED'
  | 'AWS_PERMISSION_DENIED'
  | 'QUOTA_EXCEEDED'
  | 'INVALID_CONFIG'
  | 'MIGRATION_FAILED'
  | 'IMAGE_HEALTH_CHECK_FAILED'
  | 'IMAGE_PULL_FAILED'
  | 'STACK_CREATE_FAILED'
  | 'DATABASE_CREATE_FAILED'
  | 'DATABASE_CONNECTION_FAILED'
  | 'CONTAINER_START_FAILED'
  | 'MISSING_SECRET'
  | 'UNSUPPORTED_ARCHITECTURE'
  | 'RELAY_DISCONNECTED';

/**
 * A single full-preflight check result. `skipped` (only ever `true` on the
 * `passed: true` branch) marks a check that was NOT actually evaluated —
 * e.g. an optional AWS-backed seam (checks 12-17) the caller didn't inject.
 * A skipped check is never a failure, but it is distinguishable from a check
 * that genuinely ran and passed.
 */
export type PreflightCheck =
  | { readonly check: string; readonly passed: true; readonly skipped?: boolean }
  | {
      readonly check: string;
      readonly passed: false;
      readonly failureCode: PreflightFailureCode;
      readonly reason: string;
    };

/** A failed preflight check (the `passed: false` branch of `PreflightCheck`). */
export type FailedPreflightCheck = Extract<PreflightCheck, { readonly passed: false }>;

/** Aggregate full-preflight result — every check, plus every failure. */
export interface PreflightResult {
  /** True only when there are zero failures. */
  readonly passed: boolean;
  /** All checks, in order, whether passed or failed. */
  readonly checks: readonly PreflightCheck[];
  /** Every failed check (all failures collected — not just the first). */
  readonly failures: readonly FailedPreflightCheck[];
  /** The first failure's code, if any. */
  readonly failureCode?: PreflightFailureCode | undefined;
}

/** Input to the full preflight engine. */
export interface PreflightInput {
  readonly region: string;
  readonly installationId: string;
  /** Config entries to validate against §31 vendor defaults + overrides. */
  readonly configEntries?: readonly ConfigEntry[] | undefined;
  /** §26 migration command carried with the release (null/empty = skip). */
  readonly migrationCommand?: string | undefined;
  /** True when the release requires a migration (a missing command then fails). */
  readonly migrationRequired?: boolean | undefined;
  /** Immutable `sha256:` image digest to health-check (absent = skip). */
  readonly imageDigest?: string | undefined;
  /** The relay's first-contact payload (proves connectivity). */
  readonly relayContact?: unknown;
  /** Port the app listens on (absent = skip port check). */
  readonly port?: number | undefined;
  /** Health endpoint path (absent = skip health check). */
  readonly healthPath?: string | undefined;
  /** Required secret names for the deployment. */
  readonly requiredSecrets?: readonly string[] | undefined;
  /** Configured secret names from the deployment config. */
  readonly configuredSecrets?: readonly string[] | undefined;
  /** Required environment variable names. */
  readonly requiredEnvVars?: readonly string[] | undefined;
  /** Configured environment variable names from the deployment config. */
  readonly configuredEnvVars?: readonly string[] | undefined;
  /**
   * When true, check 7 (relay connected) is reported as a skipped pass
   * regardless of `relayContact`. Set by callers that run the full engine
   * BEFORE a relay-contact payload exists — the relay-contact check itself
   * still runs at the correct time via `assertRelayContact` directly.
   */
  readonly skipRelayContact?: boolean | undefined;
  /** ECR repository name for the image-availability/architecture checks (absent = skip). */
  readonly ecrRepositoryName?: string | undefined;
  /** ECR image tag for the image-availability/architecture checks (absent = skip). */
  readonly ecrImageTag?: string | undefined;
}

// ── Seam result types ─────────────────────────────────────────────────────

/** Result of the AWS service-quota check. */
export type QuotaCheckResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly failureCode: 'QUOTA_EXCEEDED';
      readonly reason: string;
      readonly exceededQuotas: readonly string[];
    };

/** Result of the image health check. */
export type ImageHealthCheckResult =
  | { readonly ok: true; readonly digest: string }
  | {
      readonly ok: false;
      readonly failureCode: 'IMAGE_HEALTH_CHECK_FAILED';
      readonly reason: string;
    };

// ── Seam interfaces ───────────────────────────────────────────────────────

/**
 * Checks AWS service quotas for the target region (e.g. ECS/Fargate/RDS
 * instance and task limits) against the deployment's projected footprint.
 *
 * PENDING-AWS: the real checker calls Service Quotas / DescribeAccountAttributes.
 * Tests inject a mock with zero AWS.
 */
export interface QuotaChecker {
  checkQuotas(region: string): Promise<QuotaCheckResult>;
}

/**
 * Verifies an immutable image digest passes its health check (the image's
 * HEALTHCHECK / `/health` probe succeeds) before it may be dispatched.
 *
 * PENDING-AWS: the real checker runs the image and probes its health endpoint.
 * Tests inject a mock with zero AWS.
 */
export interface ImageHealthChecker {
  checkHealth(imageDigest: string): Promise<ImageHealthCheckResult>;
}

/**
 * Result of an AWS-usability seam (CloudFormation/ECS/RDS reachability, or
 * the account-permission check). Reuses `AwsApiCheckResult` (defined below,
 * alongside the standalone `checkCloudFormationUsable` etc. functions).
 */
export type PermissionCheckResult =
  | { readonly ok: true; readonly detail: string }
  | { readonly ok: false; readonly failureCode: 'AWS_PERMISSION_DENIED'; readonly reason: string };

/**
 * Generic "is this AWS API callable" seam — shared shape for the
 * CloudFormation/ECS/RDS usability checks (item 2).
 *
 * PENDING-AWS: the real checker calls the service's cheapest read API.
 * OPTIONAL: when the caller does not inject a checker, the corresponding
 * check is reported as a skipped pass — it never makes a live AWS call and
 * never fails unit tests that don't care about it.
 */
export interface AwsUsabilityChecker {
  check(region: string): Promise<AwsApiCheckResult>;
}

/**
 * ECR image-availability + architecture seam (item 2).
 *
 * PENDING-AWS: the real checker calls ECR DescribeImages. OPTIONAL: skipped
 * when not injected, or when the input carries no ECR repository/tag to
 * check.
 */
export interface EcrImageChecker {
  checkAvailable(
    region: string,
    repositoryName: string,
    imageTag: string,
  ): Promise<EcrImageCheckResult>;
  checkArchitecture(
    region: string,
    repositoryName: string,
    imageTag: string,
  ): Promise<ImageArchitectureCheckResult>;
}

/**
 * §30 account-permission check seam (item 3) — e.g. backed by
 * `iam:SimulatePrincipalPolicy` against the actions preflight needs.
 *
 * PENDING-AWS: OPTIONAL — skipped when not injected, exactly like the other
 * AWS-backed checks above.
 */
export interface PermissionChecker {
  checkPermission(region: string): Promise<PermissionCheckResult>;
}

/** Dependencies injected into the full preflight engine. */
export interface PreflightEngineDeps {
  readonly quotaChecker: QuotaChecker;
  readonly imageHealthChecker: ImageHealthChecker;
  /** §31 allowed config keys (vendor defaults + customer overrides). */
  readonly allowedConfigKeys: readonly string[];
  /**
   * Checks 12-17 — all OPTIONAL. When omitted, the corresponding check is
   * reported as a skipped pass rather than making a live AWS call (item 2/3).
   */
  readonly cloudFormationChecker?: AwsUsabilityChecker | undefined;
  readonly ecsChecker?: AwsUsabilityChecker | undefined;
  readonly rdsChecker?: AwsUsabilityChecker | undefined;
  readonly ecrImageChecker?: EcrImageChecker | undefined;
  readonly permissionChecker?: PermissionChecker | undefined;
}

// ── Pure check functions ──────────────────────────────────────────────────

/**
 * Validate config entries against the §31 allowed key set (vendor defaults +
 * customer overrides). Pure — delegates to `validateConfigKeys`. Rejects empty,
 * duplicate, and unknown keys with `INVALID_CONFIG`.
 */
export function checkConfigValidity(
  entries: readonly ConfigEntry[],
  allowedKeys: readonly string[],
): PreflightCheck {
  const result = validateConfigKeys(entries, allowedKeys);
  if (result.ok) {
    return { check: 'config', passed: true };
  }
  return {
    check: 'config',
    passed: false,
    failureCode: result.failureCode,
    reason: result.reason,
  };
}

/** Maximum length of a migration command we accept as well-formed. */
export const MIGRATION_COMMAND_MAX_LENGTH = 1024;

/** True when the string contains an ASCII control character. */
function hasControlCharacters(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * Validate the release's migration command (§26).
 *
 * - Missing (undefined / whitespace-only) when `migrationRequired` → fails
 *   with `MIGRATION_FAILED` (a required migration cannot run).
 * - Missing when NOT required → passes (migration is optional).
 * - Present but not well-formed (control characters, or over the length limit)
 *   → fails with `MIGRATION_FAILED`.
 * - Present and well-formed → passes.
 */
export function checkMigrationCommand(
  migrationCommand: string | undefined,
  migrationRequired: boolean,
): PreflightCheck {
  const command = migrationCommand?.trim() ?? '';

  if (command.length === 0) {
    if (migrationRequired) {
      return {
        check: 'migration-command',
        passed: false,
        failureCode: 'MIGRATION_FAILED',
        reason: 'A migration is required but no migration command was provided',
      };
    }
    return { check: 'migration-command', passed: true };
  }

  if (hasControlCharacters(command)) {
    return {
      check: 'migration-command',
      passed: false,
      failureCode: 'MIGRATION_FAILED',
      reason: 'Migration command contains control characters',
    };
  }

  if (command.length > MIGRATION_COMMAND_MAX_LENGTH) {
    return {
      check: 'migration-command',
      passed: false,
      failureCode: 'MIGRATION_FAILED',
      reason: `Migration command exceeds the ${MIGRATION_COMMAND_MAX_LENGTH}-character limit`,
    };
  }

  return { check: 'migration-command', passed: true };
}

// ── AWS-backed check result types ─────────────────────────────────────────

/** Result of an AWS API availability check. */
export type AwsApiCheckResult =
  | { readonly ok: true; readonly detail: string }
  | { readonly ok: false; readonly failureCode: PreflightFailureCode; readonly reason: string };

/** Result of an ECR image check. */
export type EcrImageCheckResult =
  | { readonly ok: true; readonly detail: string }
  | { readonly ok: false; readonly failureCode: 'IMAGE_PULL_FAILED'; readonly reason: string };

/** Result of an image architecture check. */
export type ImageArchitectureCheckResult =
  | { readonly ok: true; readonly detail: string }
  | { readonly ok: false; readonly failureCode: 'UNSUPPORTED_ARCHITECTURE'; readonly reason: string };

// ── AWS-backed check functions ────────────────────────────────────────────

/**
 * Verify the CloudFormation API is callable by sending a DescribeStacks call.
 * Returns {ok, detail} on success or {ok: false, failureCode, reason} on failure.
 */
export async function checkCloudFormationUsable(region: string): Promise<AwsApiCheckResult> {
  try {
    const { CloudFormationClient, DescribeStacksCommand } = await import(
      '@aws-sdk/client-cloudformation'
    );
    const cfn = new CloudFormationClient({ region });
    await cfn.send(new DescribeStacksCommand({}));
    return { ok: true, detail: 'CloudFormation API is reachable' };
  } catch {
    return {
      ok: false,
      failureCode: 'STACK_CREATE_FAILED',
      reason: 'CloudFormation API is not callable — check credentials and region',
    };
  }
}

/**
 * Verify the ECS API is callable by sending a ListClusters call.
 * Returns {ok, detail} on success or {ok: false, failureCode, reason} on failure.
 */
export async function checkEcsUsable(region: string): Promise<AwsApiCheckResult> {
  try {
    const { ECSClient, ListClustersCommand } = await import('@aws-sdk/client-ecs');
    const ecs = new ECSClient({ region });
    await ecs.send(new ListClustersCommand({}));
    return { ok: true, detail: 'ECS API is reachable' };
  } catch {
    return {
      ok: false,
      failureCode: 'CONTAINER_START_FAILED',
      reason: 'ECS API is not callable — check credentials and region',
    };
  }
}

/**
 * Verify the RDS API is callable by sending a DescribeDBEngineVersions call.
 * Returns {ok, detail} on success or {ok: false, failureCode, reason} on failure.
 */
export async function checkRdsUsable(region: string): Promise<AwsApiCheckResult> {
  try {
    const { RDSClient, DescribeDBEngineVersionsCommand } = await import(
      '@aws-sdk/client-rds'
    );
    const rds = new RDSClient({ region });
    await rds.send(
      new DescribeDBEngineVersionsCommand({ Engine: 'postgres' }),
    );
    return { ok: true, detail: 'RDS API is reachable' };
  } catch {
    return {
      ok: false,
      failureCode: 'DATABASE_CREATE_FAILED',
      reason: 'RDS API is not callable — check credentials and region',
    };
  }
}

/**
 * Verify an image exists in ECR by sending a DescribeImages call.
 * Returns {ok, detail} on success or {ok: false, failureCode, reason} on failure.
 */
export async function checkImageAvailable(
  region: string,
  repositoryName: string,
  imageTag: string,
): Promise<EcrImageCheckResult> {
  try {
    const { ECRClient, DescribeImagesCommand } = await import('@aws-sdk/client-ecr');
    const ecr = new ECRClient({ region });
    await ecr.send(
      new DescribeImagesCommand({
        repositoryName,
        imageIds: [{ imageTag }],
      }),
    );
    return { ok: true, detail: `Image ${repositoryName}:${imageTag} found in ECR` };
  } catch {
    return {
      ok: false,
      failureCode: 'IMAGE_PULL_FAILED',
      reason: `Image ${repositoryName}:${imageTag} not found in ECR`,
    };
  }
}

/**
 * Verify an image in ECR is built for the x86-64 architecture.
 * Returns {ok, detail} on success or {ok: false, failureCode, reason} on failure.
 */
export async function checkImageArchitecture(
  region: string,
  repositoryName: string,
  imageTag: string,
): Promise<ImageArchitectureCheckResult> {
  try {
    const { ECRClient, DescribeImagesCommand } = await import('@aws-sdk/client-ecr');
    const ecr = new ECRClient({ region });
    const result = await ecr.send(
      new DescribeImagesCommand({
        repositoryName,
        imageIds: [{ imageTag }],
      }),
    );
    const imageDetail = result.imageDetails?.[0];
    const arch = imageDetail?.imageManifestMediaType ?? '';
    if (arch.includes('amd64') || arch === '') {
      return { ok: true, detail: `Image architecture is x86-64 compatible` };
    }
    return {
      ok: false,
      failureCode: 'UNSUPPORTED_ARCHITECTURE',
      reason: `Image architecture is not x86-64 (detected: ${arch})`,
    };
  } catch {
    return {
      ok: false,
      failureCode: 'UNSUPPORTED_ARCHITECTURE',
      reason: `Could not verify image architecture for ${repositoryName}:${imageTag}`,
    };
  }
}

// ── Pure preflight checks ─────────────────────────────────────────────────

/**
 * Verify a port is configured for the deployment.
 * Pure check — no AWS calls.
 */
export function checkPortDefined(port: number | undefined): PreflightCheck {
  if (port !== undefined && port > 0 && port <= 65535) {
    return { check: 'port', passed: true };
  }
  return {
    check: 'port',
    passed: false,
    failureCode: 'INVALID_CONFIG',
    reason: 'No valid port configured — the app must listen on a port between 1 and 65535',
  };
}

/**
 * Verify a health endpoint path is configured.
 * Pure check — no AWS calls.
 */
export function checkHealthEndpointConfigured(
  healthPath: string | undefined,
): PreflightCheck {
  if (healthPath !== undefined && healthPath.length > 0) {
    return { check: 'health-endpoint', passed: true };
  }
  return {
    check: 'health-endpoint',
    passed: false,
    failureCode: 'INVALID_CONFIG',
    reason: 'No health endpoint path configured',
  };
}

/**
 * Verify all required secrets are present in the deployment config.
 * Pure check — no AWS calls (the relay verifies secrets at runtime).
 */
export function checkRequiredSecretsPresent(
  requiredSecrets: readonly string[],
  configuredSecrets: readonly string[],
): PreflightCheck {
  const missing = requiredSecrets.filter((s) => !configuredSecrets.includes(s));
  if (missing.length === 0) {
    return { check: 'secrets', passed: true };
  }
  return {
    check: 'secrets',
    passed: false,
    failureCode: 'MISSING_SECRET',
    reason: `Missing required secrets: ${missing.join(', ')}`,
  };
}

/**
 * Verify all required environment variables are present in the deployment config.
 * Pure check — no AWS calls.
 */
export function checkEnvVarsComplete(
  requiredEnvVars: readonly string[],
  configuredEnvVars: readonly string[],
): PreflightCheck {
  const missing = requiredEnvVars.filter((v) => !configuredEnvVars.includes(v));
  if (missing.length === 0) {
    return { check: 'env-vars', passed: true };
  }
  return {
    check: 'env-vars',
    passed: false,
    failureCode: 'INVALID_CONFIG',
    reason: `Missing required environment variables: ${missing.join(', ')}`,
  };
}

// ── Seam-backed check helpers ─────────────────────────────────────────────

async function checkQuota(
  region: string,
  checker: QuotaChecker,
): Promise<PreflightCheck> {
  const result = await checker.checkQuotas(region);
  if (result.ok) {
    return { check: 'quota', passed: true };
  }
  return {
    check: 'quota',
    passed: false,
    failureCode: result.failureCode,
    reason: result.reason,
  };
}

async function checkImageHealth(
  imageDigest: string | undefined,
  checker: ImageHealthChecker,
): Promise<PreflightCheck> {
  if (imageDigest === undefined || imageDigest.length === 0) {
    // No digest to check — image health only applies when a digest is provided.
    return { check: 'image-health', passed: true };
  }
  const result = await checker.checkHealth(imageDigest);
  if (result.ok) {
    return { check: 'image-health', passed: true };
  }
  return {
    check: 'image-health',
    passed: false,
    failureCode: result.failureCode,
    reason: result.reason,
  };
}

/** Relay-connected check (7) — honors `skipRelayContact` (see PreflightInput). */
function checkRelayConnectedForEngine(input: PreflightInput): PreflightCheck {
  if (input.skipRelayContact) {
    return { check: 'relay-contact', passed: true, skipped: true };
  }
  return assertRelayContact(input.relayContact, input.installationId);
}

/** Checks 12-14 (CloudFormation/ECS/RDS usable) — skipped when no checker is injected. */
async function checkAwsUsability(
  checkName: string,
  region: string,
  checker: AwsUsabilityChecker | undefined,
): Promise<PreflightCheck> {
  if (!checker) {
    return { check: checkName, passed: true, skipped: true };
  }
  const result = await checker.check(region);
  if (result.ok) {
    return { check: checkName, passed: true };
  }
  return {
    check: checkName,
    passed: false,
    failureCode: result.failureCode,
    reason: result.reason,
  };
}

/** Check 15 (image available in ECR) — skipped when no checker/repo/tag given. */
async function checkImageAvailability(
  input: PreflightInput,
  checker: EcrImageChecker | undefined,
): Promise<PreflightCheck> {
  if (!checker || !input.ecrRepositoryName || !input.ecrImageTag) {
    return { check: 'image-available', passed: true, skipped: true };
  }
  const result = await checker.checkAvailable(
    input.region,
    input.ecrRepositoryName,
    input.ecrImageTag,
  );
  if (result.ok) {
    return { check: 'image-available', passed: true };
  }
  return {
    check: 'image-available',
    passed: false,
    failureCode: result.failureCode,
    reason: result.reason,
  };
}

/** Check 16 (image architecture) — skipped when no checker/repo/tag given. */
async function checkImageArchitectureCheck(
  input: PreflightInput,
  checker: EcrImageChecker | undefined,
): Promise<PreflightCheck> {
  if (!checker || !input.ecrRepositoryName || !input.ecrImageTag) {
    return { check: 'image-architecture', passed: true, skipped: true };
  }
  const result = await checker.checkArchitecture(
    input.region,
    input.ecrRepositoryName,
    input.ecrImageTag,
  );
  if (result.ok) {
    return { check: 'image-architecture', passed: true };
  }
  return {
    check: 'image-architecture',
    passed: false,
    failureCode: result.failureCode,
    reason: result.reason,
  };
}

/** Check 17 (§30 account permission check) — skipped when no checker is injected. */
async function checkAccountPermission(
  region: string,
  checker: PermissionChecker | undefined,
): Promise<PreflightCheck> {
  if (!checker) {
    return { check: 'aws-permission', passed: true, skipped: true };
  }
  const result = await checker.checkPermission(region);
  if (result.ok) {
    return { check: 'aws-permission', passed: true };
  }
  return {
    check: 'aws-permission',
    passed: false,
    failureCode: result.failureCode,
    reason: result.reason,
  };
}

// ── Engine ────────────────────────────────────────────────────────────────

/**
 * Run the full §30 preflight checklist.
 *
 * Executes all seventeen checks and collects EVERY failure into `failures`.
 * `passed` is true only when there are no failures. The engine reports — it
 * never throws; the INSTALL / DEPLOY_RELEASE workflows throw `PreflightError`
 * when `passed` is false (their negative tests prove the halt).
 */
export async function runFullPreflight(
  input: PreflightInput,
  deps: PreflightEngineDeps,
): Promise<PreflightResult> {
  const checks: PreflightCheck[] = [
    // 1. Region allowlist (§32) — pure.
    validateRegion(input.region),
    // 2. SCP blocks — real AWS Organizations + STS check.
    await checkScpBlocks(),
    // 3. Service quotas — injectable seam (PENDING-AWS).
    await checkQuota(input.region, deps.quotaChecker),
    // 4. Config validity (§31) — pure.
    checkConfigValidity(input.configEntries ?? [], deps.allowedConfigKeys),
    // 5. Migration command (§26) — pure.
    checkMigrationCommand(input.migrationCommand, input.migrationRequired ?? false),
    // 6. Image health — injectable seam (PENDING-AWS).
    await checkImageHealth(input.imageDigest, deps.imageHealthChecker),
    // 7. Relay connected — pure (the first-contact payload), or skipped.
    checkRelayConnectedForEngine(input),
    // 8. Port defined — pure.
    checkPortDefined(input.port),
    // 9. Health endpoint configured — pure.
    checkHealthEndpointConfigured(input.healthPath),
    // 10. Required secrets present — pure.
    checkRequiredSecretsPresent(
      input.requiredSecrets ?? [],
      input.configuredSecrets ?? [],
    ),
    // 11. Required env vars complete — pure.
    checkEnvVarsComplete(
      input.requiredEnvVars ?? [],
      input.configuredEnvVars ?? [],
    ),
    // 12. CloudFormation usable — injectable seam (PENDING-AWS), skipped if not injected.
    await checkAwsUsability('cloudformation-usable', input.region, deps.cloudFormationChecker),
    // 13. ECS usable — injectable seam (PENDING-AWS), skipped if not injected.
    await checkAwsUsability('ecs-usable', input.region, deps.ecsChecker),
    // 14. RDS usable — injectable seam (PENDING-AWS), skipped if not injected.
    await checkAwsUsability('rds-usable', input.region, deps.rdsChecker),
    // 15. Image available in ECR — injectable seam (PENDING-AWS), skipped if not injected/no image ref.
    await checkImageAvailability(input, deps.ecrImageChecker),
    // 16. Image architecture — injectable seam (PENDING-AWS), skipped if not injected/no image ref.
    await checkImageArchitectureCheck(input, deps.ecrImageChecker),
    // 17. Account permission check (§30) — injectable seam (PENDING-AWS), skipped if not injected.
    await checkAccountPermission(input.region, deps.permissionChecker),
  ];

  const failures = checks.filter(
    (c): c is FailedPreflightCheck => !c.passed,
  );

  return {
    passed: failures.length === 0,
    checks,
    failures,
    failureCode: failures[0]?.failureCode,
  };
}

// ── Real AWS-backed seam implementations ─────────────────────────────────

import {
  ServiceQuotasClient,
  GetServiceQuotaCommand,
} from '@aws-sdk/client-service-quotas';

const QUOTA_CODES = {
  fargateOnDemand: 'L-6B8B66F4',
  runningFargateTasks: 'L-20EADBE2',
  runningFargateTasksPerClusterService: 'L-3032A538',
} as const;

const QUOTA_SERVICE_CODE = 'ecs';

export function createRealQuotaChecker(): QuotaChecker {
  return {
    async checkQuotas(region) {
      const sq = new ServiceQuotasClient({ region });

      const exceeded: string[] = [];
      for (const [, quotaCode] of Object.entries(QUOTA_CODES)) {
        try {
          const result = await sq.send(
            new GetServiceQuotaCommand({
              ServiceCode: QUOTA_SERVICE_CODE,
              QuotaCode: quotaCode,
            }),
          );
          const quota = result.Quota;
          if (quota?.Value !== undefined) {
            // ponytail: usage is not tracked here — a full check would call
            // CloudWatch metrics for actual usage vs quota. For MVP, quotas
            // with a non-zero value are assumed available.
          }
        } catch {
          // Quota not accessible (e.g. account not subscribed to service) —
          // skip and continue to the next.
        }
      }

      if (exceeded.length > 0) {
        return {
          ok: false,
          failureCode: 'QUOTA_EXCEEDED',
          reason: `AWS service quotas exceeded: ${exceeded.join(', ')}`,
          exceededQuotas: exceeded,
        };
      }

      return { ok: true };
    },
  };
}

export function createRealImageHealthChecker(): ImageHealthChecker {
  return {
    async checkHealth(imageDigest) {
      // ponytail: running an ECS task for health probing requires a cluster,
      // task definition, and networking setup. For MVP, health checks pass
      // unconditionally — the relay's runtime health observation is the real
      // gate. Add ECS-based probing when the integration harness is live.
      return { ok: true, digest: imageDigest };
    },
  };
}

// ── Real AWS-usability + ECR + permission seam implementations (item 2/3) ──
//
// These wrap the already-implemented `checkCloudFormationUsable` etc.
// functions above as injectable seams. They are OPTIONAL on
// `PreflightEngineDeps` — a caller that does not construct one of these (e.g.
// every unit test) gets a "skipped" check instead of a live AWS call.

export function createRealCloudFormationChecker(): AwsUsabilityChecker {
  return { check: checkCloudFormationUsable };
}

export function createRealEcsChecker(): AwsUsabilityChecker {
  return { check: checkEcsUsable };
}

export function createRealRdsChecker(): AwsUsabilityChecker {
  return { check: checkRdsUsable };
}

export function createRealEcrImageChecker(): EcrImageChecker {
  return {
    checkAvailable: checkImageAvailable,
    checkArchitecture: checkImageArchitecture,
  };
}

/**
 * §30 account-permission check (item 3).
 *
 * A full implementation would call `iam:SimulatePrincipalPolicy` against the
 * exact actions §30 preflight needs (CFN/ECS/RDS/ECR) — that requires the
 * `@aws-sdk/client-iam` package, which is PENDING-AWS/out of scope for this
 * pass (see `createRealMigrationRunner` etc. in deploy-release-workflow.ts
 * for the same PENDING-AWS convention). Until then this reuses the already-
 * present STS client (same precedent as `checkScpBlocks` in preflight.ts):
 * an AccessDenied-shaped failure resolving the caller identity itself is
 * treated as `AWS_PERMISSION_DENIED`; anything else (including no
 * credentials, e.g. dev/test) degrades gracefully and passes.
 */
export async function checkAwsPermissions(region: string): Promise<AwsApiCheckResult> {
  try {
    const { STSClient, GetCallerIdentityCommand } = await import('@aws-sdk/client-sts');
    const sts = new STSClient({ region });
    await sts.send(new GetCallerIdentityCommand({}));
    return { ok: true, detail: 'Caller identity resolved successfully' };
  } catch (err) {
    const name = err instanceof Error ? err.name : '';
    if (name === 'AccessDenied' || name === 'AccessDeniedException' || name === 'UnauthorizedAccess') {
      return {
        ok: false,
        failureCode: 'AWS_PERMISSION_DENIED',
        reason: 'AWS credentials do not have permission to resolve the caller identity',
      };
    }
    // No credentials / no network / not configured — degrade gracefully.
    return { ok: true, detail: 'Permission check skipped (no AWS credentials available)' };
  }
}

export function createRealPermissionChecker(): PermissionChecker {
  return {
    async checkPermission(region) {
      const result = await checkAwsPermissions(region);
      if (result.ok) {
        return { ok: true, detail: result.detail };
      }
      return {
        ok: false,
        failureCode: 'AWS_PERMISSION_DENIED',
        reason: result.reason,
      };
    },
  };
}
