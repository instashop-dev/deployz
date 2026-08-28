/**
 * §61 + §65 remediation guidance engine (todo 31).
 *
 * Maps every deterministic failure code to advisory, jargon-free fix
 * suggestions. The remediation is PURELY DETERMINISTIC: `getRemediation()`
 * is a pure function (same code → same guidance). The `automatic` field is
 * always `false` by design — no automatic remediation execution.
 *
 * This layer is ADVISORY: it tells the vendor what to do, but never does
 * it automatically (unsafe to auto-modify customer infrastructure).
 */

import type { StructuredEvent } from './failure-codes.js';
import { type FailureCode } from './failure-codes.js';

// ── Remediation type ─────────────────────────────────────────────────────────

/**
 * Advisory remediation for a deterministic failure code.
 *
 * The `automatic` field is ALWAYS `false` — no automatic remediation
 * execution (by design). The remediation is advisory: it tells the vendor
 * what to do, but never does it automatically.
 *
 * §65 requires a structural split between plain-language guidance and raw
 * AWS detail: `summary`/`steps` are the jargon-free top level (safe to show
 * by default), and `technicalDetail` carries the AWS-specific instructions
 * (console names, service names) behind an expandable section. No content is
 * dropped — the technical instructions live in `technicalDetail` rather than
 * being deleted.
 */
export interface Remediation {
  /** The §61 failure code this remediation addresses. */
  code: FailureCode;
  /** One-line summary of what needs to happen. §65 jargon-free. */
  summary: string;
  /** Step-by-step guidance (1-3 steps), §65 jargon-free — safe to show by default. */
  steps: string[];
  /**
   * AWS-specific technical detail (console names, service names) for the
   * same failure. §65: expandable, never shown at the top level. Empty when
   * the plain-language `steps` already carry everything needed.
   */
  technicalDetail: string[];
  /** Whether this requires manual intervention. */
  requiresManual: boolean;
  /** Whether the fix can be applied automatically (this is always FALSE by design). */
  automatic: false; // never true — no automatic remediation execution
}

// ── Region allowlist (from §32, mirrored from packages/db/src/enums.ts) ──────

/** The 17 supported AWS regions (§32). */
const SUPPORTED_REGIONS = [
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
];

// ── Remediation table ────────────────────────────────────────────────────────

/**
 * The deterministic remediation table — one entry per §61 failure code.
 * Pure function: same code → same guidance, always.
 */
const REMEDIATION_TABLE: Record<FailureCode, Omit<Remediation, 'code'>> = {
  // 1. AWS_SCP_BLOCKED
  AWS_SCP_BLOCKED: {
    summary: 'Your cloud account has a policy that prevents this action.',
    steps: [
      'Check service control policies in your account.',
      'Remove or modify the policy blocking the required action.',
      'Contact your cloud administrator.',
    ],
    technicalDetail: [],
    requiresManual: true,
    automatic: false,
  },

  // 2. PORT_MISMATCH
  PORT_MISMATCH: {
    summary: "Your app listens on a different port than what's set up.",
    steps: [
      'Check what port your app actually listens on (from the PORT env var or app code).',
      'Update the deployment configuration to match.',
    ],
    technicalDetail: [],
    requiresManual: true,
    automatic: false,
  },

  // 3. REGION_NOT_SUPPORTED
  REGION_NOT_SUPPORTED: {
    summary: 'The selected region is not yet supported.',
    steps: [
      `Choose one of the supported regions: ${SUPPORTED_REGIONS.join(', ')}.`,
      'Re-create the deployment in the supported region.',
    ],
    technicalDetail: [],
    requiresManual: true,
    automatic: false,
  },

  // 4. QUOTA_EXCEEDED
  QUOTA_EXCEEDED: {
    summary: 'Your cloud account has hit a resource limit.',
    steps: [
      "Check your account's service quotas.",
      'Request a quota increase if needed.',
      'Retry the deployment.',
    ],
    technicalDetail: [],
    requiresManual: true,
    automatic: false,
  },

  // 5. IMAGE_HEALTH_CHECK_FAILED
  IMAGE_HEALTH_CHECK_FAILED: {
    summary: "The container image didn't pass its health check.",
    steps: [
      'Verify your app responds to GET /health on the configured port within 30 seconds of startup.',
      'Check the application logs for startup errors.',
      'Rebuild and redeploy.',
    ],
    technicalDetail: [],
    requiresManual: true,
    automatic: false,
  },

  // 6. MIGRATION_FAILED
  MIGRATION_FAILED: {
    summary: "The database migration didn't complete.",
    steps: [
      'Check the migration command output for errors.',
      'Fix the migration and re-run it manually if needed.',
      'Retry the deployment.',
    ],
    technicalDetail: [],
    requiresManual: true,
    automatic: false,
  },

  // 7. RELAY_DISCONNECTED
  RELAY_DISCONNECTED: {
    summary: "The helper that runs in your cloud account can't reach Deployz.",
    steps: [
      "Check your cloud account's network settings and internet connectivity.",
      "Verify the relay Lambda is still deployed and hasn't been removed.",
      'If the issue persists, re-create the bootstrap stack from your install link.',
    ],
    technicalDetail: [],
    requiresManual: true,
    automatic: false,
  },

  // 8. ECS_DEPLOYMENT_FAILED
  ECS_DEPLOYMENT_FAILED: {
    summary: 'The container service failed to start or update.',
    steps: [
      'Check your application logs for startup errors.',
      'Verify your container image is valid and complete.',
      'Retry the deployment.',
    ],
    technicalDetail: [],
    requiresManual: true,
    automatic: false,
  },

  // 9. RDS_UNAVAILABLE
  RDS_UNAVAILABLE: {
    summary: "The database isn't responding.",
    steps: [
      'Wait a few minutes — databases sometimes restart for maintenance.',
      "Check your cloud account's database status.",
      'Contact support if the issue persists.',
    ],
    technicalDetail: [],
    requiresManual: true,
    automatic: false,
  },

  // 10. UNKNOWN
  UNKNOWN: {
    summary: "This issue isn't one we've seen before.",
    steps: [
      "Check the deployment's health signals for more detail.",
      'Contact Deployz support with your deployment ID.',
    ],
    technicalDetail: [],
    requiresManual: true,
    automatic: false,
  },

  // 11. AWS_PERMISSION_DENIED
  AWS_PERMISSION_DENIED: {
    summary: 'Your cloud account does not have permission for this action.',
    steps: [
      'Check the permissions attached to your cloud account for this deployment.',
      'Add the missing permission to the policy.',
      'Contact your cloud administrator if the policy is managed externally.',
    ],
    // §65: expandable technical detail — the AWS-specific instruction moved
    // here rather than being deleted.
    technicalDetail: ['Check the IAM role or user policy attached to the deployment.'],
    requiresManual: true,
    automatic: false,
  },

  // 12. STACK_CREATE_FAILED
  STACK_CREATE_FAILED: {
    summary: 'The infrastructure setup could not complete.',
    steps: [
      'Check which part of the setup failed and why.',
      'Fix the underlying issue (e.g. missing permissions, invalid parameters).',
      'Retry the deployment.',
    ],
    technicalDetail: [
      'Check the CloudFormation console for the specific resource that failed.',
    ],
    requiresManual: true,
    automatic: false,
  },

  // STACK_DELETE_FAILED
  STACK_DELETE_FAILED: {
    summary: 'The disconnect could not complete. Your data is safe.',
    steps: [
      'Check which resource could not be removed.',
      'The database and stored files are retained by design.',
      'Retry the disconnect.',
    ],
    technicalDetail: [
      'Check the CloudFormation console for the specific resource that failed to delete.',
    ],
    requiresManual: true,
    automatic: false,
  },

  // 13. DATABASE_CREATE_FAILED
  DATABASE_CREATE_FAILED: {
    summary: 'The database could not be created.',
    steps: [
      'Check the failure reason for the new database.',
      'Verify your account has enough capacity for a new database instance.',
      'Retry the deployment.',
    ],
    technicalDetail: ['Check the RDS console for the creation failure reason.'],
    requiresManual: true,
    automatic: false,
  },

  // 14. DATABASE_CONNECTION_FAILED
  DATABASE_CONNECTION_FAILED: {
    summary: "The app can't reach the database.",
    steps: [
      'Check that the database is running and reachable.',
      'Verify the connection string and security group rules.',
      'Wait a few minutes and try again — databases sometimes restart.',
    ],
    technicalDetail: [],
    requiresManual: true,
    automatic: false,
  },

  // 15. IMAGE_PULL_FAILED
  IMAGE_PULL_FAILED: {
    summary: 'The container image could not be downloaded.',
    steps: [
      'Verify the app image exists and is accessible.',
      'Check that the registry permissions allow pulling the image.',
      'Make sure the image tag or digest is correct.',
    ],
    technicalDetail: ['Verify the image exists in the container registry.'],
    requiresManual: true,
    automatic: false,
  },

  // 16. CONTAINER_START_FAILED
  CONTAINER_START_FAILED: {
    summary: 'The container stopped unexpectedly during startup.',
    steps: [
      'Check the container logs for startup errors.',
      'Verify the startup command is correct.',
      'Make sure all required environment variables and secrets are set.',
    ],
    technicalDetail: [],
    requiresManual: true,
    automatic: false,
  },

  // 17. MISSING_SECRET
  MISSING_SECRET: {
    summary: 'A required secret is missing or not accessible.',
    steps: [
      'Check that all required secrets are configured for this deployment.',
      'Verify the deployment has permission to read the secrets.',
      'Add any missing secrets and retry.',
    ],
    technicalDetail: ['Check that all required secrets exist in the secrets manager.'],
    requiresManual: true,
    automatic: false,
  },

  // 18. UNSUPPORTED_ARCHITECTURE
  UNSUPPORTED_ARCHITECTURE: {
    summary: 'The container image uses an unsupported processor architecture.',
    steps: [
      'Rebuild your container image for the x86-64 architecture.',
      'Update your Dockerfile or build command to target linux/amd64.',
      'Push the rebuilt image and retry the deployment.',
    ],
    technicalDetail: [],
    requiresManual: true,
    automatic: false,
  },

  // 19. REDIS_PROVISIONING_FAILED
  REDIS_PROVISIONING_FAILED: {
    summary: "Your app's Redis cache could not be created.",
    steps: [
      'Verify your account has enough capacity for a new cache instance.',
      'Check the failure reason for the new cache.',
      'Retry the deployment.',
    ],
    technicalDetail: [],
    requiresManual: true,
    automatic: false,
  },

  // 20. REDIS_CONNECTION_FAILED
  REDIS_CONNECTION_FAILED: {
    summary: "The app can't reach its Redis cache.",
    steps: [
      'Check that the cache is running and reachable.',
      'Verify the connection details and security group rules.',
      'Wait a few minutes and try again — caches sometimes restart.',
    ],
    technicalDetail: [],
    requiresManual: true,
    automatic: false,
  },
};

// ── The engine ───────────────────────────────────────────────────────────────

/**
 * Return deterministic, advisory remediation guidance for a failure code.
 *
 * This is a **pure function** — same code + event always produces the same
 * remediation. The `event` parameter is advisory only (future-proofing for
 * event-contextual steps) and does not change the output.
 *
 * @param failureCode  The deterministic §61 failure code.
 * @param _event       Optional structured event (advisory only, does not change output).
 * @returns A fixed `Remediation` with `automatic` always `false`.
 */
export function getRemediation(
  failureCode: FailureCode,
  event?: StructuredEvent,
): Remediation {
  void event; // advisory-only parameter — kept for future event-contextual steps
  const entry = REMEDIATION_TABLE[failureCode];
  return { code: failureCode, ...entry };
}