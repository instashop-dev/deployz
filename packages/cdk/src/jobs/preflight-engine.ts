/**
 * Full §30 preflight engine — the complete preflight checklist that gates
 * INSTALL + DEPLOY_RELEASE before ANY application-stack provisioning or
 * upgrade (§25/§30).
 *
 * §25: the bootstrap stack is EXEMPT from preflight — it must complete first
 * so the relay is reachable, and the relay's first contact is what proves the
 * customer account is actually wired up. Only AFTER that contact does the full
 * checklist run (todo 13's `preflight.ts` is the minimal Wave-2 subset; this
 * is the full engine the plan's todo 28 calls for).
 *
 * The seven checks, in order:
 *   1. Region allowlist      — pure, reuses `validateRegion` (§32)
 *   2. SCP blocks            — pure, reuses `checkScpBlocks` (PENDING-AWS stub)
 *   3. Service quotas        — injectable `QuotaChecker` seam (PENDING-AWS)
 *   4. Config validity       — pure, reuses `validateConfigKeys` (§31)
 *   5. Migration command     — pure (present + well-formed, §26)
 *   6. Image health          — injectable `ImageHealthChecker` seam (PENDING-AWS)
 *   7. Relay connected       — pure, reuses `assertRelayContact`
 *
 * The engine runs ALL checks and collects EVERY failure (not just the first)
 * into `failures`. `passed` is true only when there are zero failures. Each
 * failed check carries a stable failure code + reason. The WORKFLOWS (INSTALL /
 * DEPLOY_RELEASE) are responsible for throwing `PreflightError` when `passed`
 * is false — the engine itself only reports, it never throws.
 *
 * Failure-code provenance (nothing here invents a new §61 code):
 *   REGION_NOT_SUPPORTED, AWS_SCP_BLOCKED, QUOTA_EXCEEDED,
 *   IMAGE_HEALTH_CHECK_FAILED, MIGRATION_FAILED, RELAY_DISCONNECTED are the
 *   §61 codes (packages/db failureCodeEnum) that apply to preflight.
 *   INVALID_CONFIG is the §31 config-domain code reused from
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
  | 'QUOTA_EXCEEDED'
  | 'INVALID_CONFIG'
  | 'MIGRATION_FAILED'
  | 'IMAGE_HEALTH_CHECK_FAILED'
  | 'RELAY_DISCONNECTED';

/** A single full-preflight check result. */
export type PreflightCheck =
  | { readonly check: string; readonly passed: true }
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

/** Dependencies injected into the full preflight engine. */
export interface PreflightEngineDeps {
  readonly quotaChecker: QuotaChecker;
  readonly imageHealthChecker: ImageHealthChecker;
  /** §31 allowed config keys (vendor defaults + customer overrides). */
  readonly allowedConfigKeys: readonly string[];
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

// ── Engine ────────────────────────────────────────────────────────────────

/**
 * Run the full §30 preflight checklist.
 *
 * Executes all seven checks and collects EVERY failure into `failures`.
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
    // 2. SCP blocks — pure stub (PENDING-AWS real check).
    checkScpBlocks(),
    // 3. Service quotas — injectable seam (PENDING-AWS).
    await checkQuota(input.region, deps.quotaChecker),
    // 4. Config validity (§31) — pure.
    checkConfigValidity(input.configEntries ?? [], deps.allowedConfigKeys),
    // 5. Migration command (§26) — pure.
    checkMigrationCommand(input.migrationCommand, input.migrationRequired ?? false),
    // 6. Image health — injectable seam (PENDING-AWS).
    await checkImageHealth(input.imageDigest, deps.imageHealthChecker),
    // 7. Relay connected — pure (the first-contact payload).
    assertRelayContact(input.relayContact, input.installationId),
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
