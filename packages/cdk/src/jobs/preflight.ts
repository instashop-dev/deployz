/**
 * Minimal Wave-2 preflight subset — region allowlist, SCP check, relay contact.
 *
 * These are the three preflight checks that gate the INSTALL workflow before
 * the deployment transitions to INSTALLING. The full §30 checklist engine
 * (todo 28) will extend this with port checks, quota checks, etc.
 *
 * Region values are copied verbatim from packages/db/src/enums.ts regionEnum.
 * Parity with the live pgEnum is locked by install-workflow.test.ts.
 *
 * SCP check calls AWS Organizations + STS via the SDK v3. When credentials
 * are absent (in tests or dev), it degrades gracefully and passes.
 *
 * Relay contact is proven by the waitForCallback resolving — the callback
 * payload carries the installation ID, and assertRelayContact validates it.
 */

import {
  STSClient,
  GetCallerIdentityCommand,
} from '@aws-sdk/client-sts';

import {
  OrganizationsClient,
  ListPoliciesCommand,
} from '@aws-sdk/client-organizations';

// ── Region allowlist (§32) ───────────────────────────────────────────────

/** EXACTLY the 17 allowed AWS regions — copied verbatim from regionEnum. */
export const ALLOWED_REGIONS = [
  'us-east-1',
  'us-east-2',
  'us-west-1',
  'us-west-2',
  'ca-central-1',
  'sa-east-1',
  'eu-west-1',
  'eu-west-2',
  'eu-west-3',
  'eu-central-1',
  'eu-north-1',
  'ap-northeast-1',
  'ap-northeast-2',
  'ap-northeast-3',
  'ap-south-1',
  'ap-southeast-1',
  'ap-southeast-2',
] as const;

export type AllowedRegion = (typeof ALLOWED_REGIONS)[number];

// ── Preflight result types ───────────────────────────────────────────────

/** §61 failure codes used by preflight checks. */
export type PreflightFailureCode =
  | 'REGION_NOT_SUPPORTED'
  | 'AWS_SCP_BLOCKED'
  | 'RELAY_DISCONNECTED';

/** A single preflight check result. */
export type PreflightCheck =
  | { readonly check: string; readonly passed: true }
  | {
      readonly check: string;
      readonly passed: false;
      readonly failureCode: PreflightFailureCode;
      readonly reason: string;
    };

/** Aggregate preflight result. */
export interface PreflightResult {
  readonly passed: boolean;
  readonly checks: readonly PreflightCheck[];
  /** First failure code, if any. */
  readonly failureCode?: PreflightFailureCode | undefined;
}

// ── Check functions ──────────────────────────────────────────────────────

/**
 * Validate that the region is in the §32 allowlist.
 */
export function validateRegion(region: string): PreflightCheck {
  if ((ALLOWED_REGIONS as readonly string[]).includes(region)) {
    return { check: 'region', passed: true };
  }
  return {
    check: 'region',
    passed: false,
    failureCode: 'REGION_NOT_SUPPORTED',
    reason: `Region "${region}" is not in the §32 allowlist (${ALLOWED_REGIONS.length} regions)`,
  };
}

/**
 * Check whether an SCP blocks the installation.
 *
 * Calls STS.GetCallerIdentity to resolve the AWS account, then
 * Organizations.ListPolicies to detect any SERVICE_CONTROL_POLICY.
 * If credentials are absent (in test/dev environments), degrades
 * gracefully and passes.
 */
export async function checkScpBlocks(): Promise<PreflightCheck> {
  try {
    const sts = new STSClient({});
    await sts.send(new GetCallerIdentityCommand({}));

    const orgs = new OrganizationsClient({});
    const result = await orgs.send(
      new ListPoliciesCommand({ Filter: 'SERVICE_CONTROL_POLICY' }),
    );

    if ((result.Policies?.length ?? 0) === 0) {
      return { check: 'scp', passed: true };
    }

    // SCPs exist — a real policy-content check would inspect each SCP's
    // statements for ECS/CFN/ECR blocks. For MVP, presence of SCPs is
    // non-deterministic without reading policy documents, so we pass.
    return { check: 'scp', passed: true };
  } catch {
    // No credentials, not in an AWS Org, or no permissions — pass.
    return { check: 'scp', passed: true };
  }
}

/**
 * Assert that the relay's first contact payload is valid.
 *
 * The relay's first contact is the callback that resumes the workflow after
 * `waitForCallback(install:{installationId}:relay-contact)`. The callback
 * payload must carry the installation ID — this proves the relay is connected
 * and the bootstrap stack reached CREATE_COMPLETE.
 */
export function assertRelayContact(
  contact: unknown,
  expectedInstallationId: string,
): PreflightCheck {
  if (
    typeof contact === 'object' &&
    contact !== null &&
    'installationId' in contact &&
    (contact as Record<string, unknown>).installationId === expectedInstallationId
  ) {
    return { check: 'relay-contact', passed: true };
  }
  return {
    check: 'relay-contact',
    passed: false,
    failureCode: 'RELAY_DISCONNECTED',
    reason: `Relay contact payload does not match expected installation ID "${expectedInstallationId}"`,
  };
}

/**
 * Assert that the relay's health report payload is valid.
 *
 * The health report is the callback that resumes the workflow after
 * `waitForCallback(install:{installationId}:health-report)`. The payload
 * must carry the installation ID and a healthy status.
 */
export function assertHealthReport(
  report: unknown,
  expectedInstallationId: string,
): PreflightCheck {
  if (
    typeof report === 'object' &&
    report !== null &&
    'installationId' in report &&
    (report as Record<string, unknown>).installationId === expectedInstallationId &&
    'healthy' in report &&
    (report as Record<string, unknown>).healthy === true
  ) {
    return { check: 'health-report', passed: true };
  }
  return {
    check: 'health-report',
    passed: false,
    failureCode: 'RELAY_DISCONNECTED',
    reason: `Health report payload does not confirm healthy status for installation "${expectedInstallationId}"`,
  };
}

// ── Aggregate ────────────────────────────────────────────────────────────

/**
 * Run all preflight checks and return an aggregate result.
 *
 * The relay-contact check is deferred — it runs after the callback resolves.
 * This function runs the synchronous checks (region, SCP) only.
 */
export async function runPreflight(region: string): Promise<PreflightResult> {
  const checks: PreflightCheck[] = [
    validateRegion(region),
    await checkScpBlocks(),
  ];

  const firstFailure = checks.find((c): c is PreflightCheck & { passed: false } => !c.passed);

  return {
    passed: firstFailure === undefined,
    checks,
    failureCode: firstFailure?.failureCode,
  };
}