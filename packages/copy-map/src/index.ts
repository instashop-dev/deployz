/**
 * @deployz/copy-map — single source of truth for product vocabulary.
 *
 * Every user-facing label, badge variant, and copy string flows from this
 * module. Pages import from here (or from a web-local re-export that mirrors
 * these values) — never hardcode status strings, failure labels, or verdict
 * copy. §46: raw CFN/ECS statuses must be UNREACHABLE at the UI edge; this
 * module is the gate.
 *
 * §65 copy principles (documented below as §65_RULES) govern every label:
 * jargon-free top level, expandable technical detail, no raw AWS/CFN/ECS/IAM
 * terms at the top level.
 */

// ── §65 copy principles ─────────────────────────────────────────────────────

/**
 * The §65 copy rules that govern every user-facing string in Deployz.
 *
 * 1. **Jargon-free top level** — the first thing a user reads must be plain
 *    English. No "CloudFormation", "ECS", "RDS", "IAM", "ALB", "Lambda", "VPC",
 *    or "CFN" at the top level.
 *
 * 2. **Expandable technical detail** — raw service names, exact permission
 *    ARNs, and infrastructure identifiers live behind expandable sections
 *    (`<details>`, collapsible cards, "Technical detail" headings). The user
 *    chooses to see them.
 *
 * 3. **No raw AWS terms at top level** — even when the underlying system is
 *    AWS, the copy describes WHAT happens, not WHICH service does it.
 *    "Deployment failed" not "ECS deployment failed"; "Database unreachable"
 *    not "RDS unavailable".
 *
 * 4. **Honest trust story** — never claim permissions are "tiny" or
 *    "minimal" when they are substantial. Describe the boundary honestly.
 *
 * 5. **Masked secrets** — secrets are write-only. The UI shows "***" or a
 *    masked placeholder; plaintext never appears in API responses, event
 *    payloads, or serialized state.
 */
export const COPY_RULES_65 = {
  JARGON_FREE_TOP_LEVEL: true,
  EXPANDABLE_TECHNICAL_DETAIL: true,
  NO_RAW_AWS_TERMS_AT_TOP_LEVEL: true,
  HONEST_TRUST_STORY: true,
  MASKED_SECRETS: true,
} as const;

/** Regex matching raw AWS/CFN/ECS/IAM terms that must not appear at the top level. */
export const JARGON_PATTERN = /\b(CloudFormation|IAM|ECS|ALB|Lambda|VPC|CFN|RDS)\b/i;

// ── §46 deployment states ───────────────────────────────────────────────────

/** The 9 product-vocabulary deployment states (§46). */
export const DEPLOYMENT_STATES = [
  'NOT_INSTALLED',
  'INSTALLING',
  'HEALTHY',
  'UPDATING',
  'UPDATE_AVAILABLE',
  'FAILED',
  'DISCONNECTED',
  'DELETING',
  'DELETED',
] as const;

export type DeploymentState = (typeof DEPLOYMENT_STATES)[number];

/** Human-readable §46 labels — the only user-facing status wording. */
export const DEPLOYMENT_STATE_LABELS: Record<DeploymentState, string> = {
  NOT_INSTALLED: 'Not installed',
  INSTALLING: 'Installing',
  HEALTHY: 'Healthy',
  UPDATING: 'Updating',
  UPDATE_AVAILABLE: 'Update available',
  FAILED: 'Failed',
  DISCONNECTED: 'Disconnected',
  DELETING: 'Deleting',
  DELETED: 'Deleted',
};

/** Badge variant per state (maps to shadcn/ui Badge variants). */
export type DeploymentBadgeVariant = 'default' | 'secondary' | 'destructive' | 'outline';

export const DEPLOYMENT_STATE_BADGE: Record<DeploymentState, DeploymentBadgeVariant> = {
  NOT_INSTALLED: 'secondary',
  INSTALLING: 'outline',
  HEALTHY: 'default',
  UPDATING: 'outline',
  UPDATE_AVAILABLE: 'secondary',
  FAILED: 'destructive',
  DISCONNECTED: 'destructive',
  DELETING: 'outline',
  DELETED: 'secondary',
};

/** Look up a human-readable label for a deployment state string. */
export function deploymentStateLabel(state: string): string {
  return DEPLOYMENT_STATE_LABELS[state as DeploymentState] ?? state;
}

// ── §40 event families ──────────────────────────────────────────────────────

/** The §40 event families (§65): install/deploy/rollback/config/destroy/health/relay/redis. */
export const EVENT_FAMILIES = [
  'install',
  'deploy',
  'rollback',
  'config',
  'destroy',
  'health',
  'relay',
  'redis',
] as const;

export type EventFamily = (typeof EVENT_FAMILIES)[number];

/** First dot-segment of an event type, if it is one of the 6 families. */
export function eventFamily(eventType: string): EventFamily | null {
  const family = eventType.split('.')[0];
  if (!family) return null;
  return (EVENT_FAMILIES as readonly string[]).includes(family)
    ? (family as EventFamily)
    : null;
}

const FAMILY_LABELS: Record<EventFamily, string> = {
  install: 'Installation',
  deploy: 'Update',
  rollback: 'Rollback',
  config: 'Configuration',
  destroy: 'Teardown',
  health: 'Health',
  relay: 'Helper',
  redis: 'Cache',
};

/**
 * Specific human-readable labels for the event types emitted by the durable
 * workflows. Unknown types fall back to the family label (§65: jargon-free,
 * never raw).
 */
const EVENT_TYPE_LABELS: Record<string, string> = {
  'install.preflight.region': 'Region check',
  'install.preflight.scp': 'Account policy check',
  'install.relay.contact': 'First check-in from the helper',
  'install.state.installing': 'Installation started',
  'install.relay.health': 'First health report',
  'install.state.healthy': 'Installed and healthy',

  'deploy.preflight': 'Pre-deployment checks',
  'deploy.state.updating': 'Update started',
  'deploy.migration': 'Database migration',
  'deploy.ecs-update': 'New version deployed',
  'deploy.infra-upgrade': 'Infrastructure upgrade',
  'deploy.health': 'Health check after update',
  'deploy.state.healthy': 'Update complete',
  'deploy.state.update-available': 'Update available',

  'rollback.state.updating': 'Rollback started',
  'rollback.disclosure': 'Rollback scope',
  'rollback.restore': 'Previous version restored',
  'rollback.health': 'Health check after rollback',
  'rollback.state.healthy': 'Rolled back and healthy',

  // The vocabulary the API emits at its own transition points. The entries
  // below this block are the durable workflows' finer-grained vocabulary,
  // kept because those events are still the intended shape once the workflow
  // layer runs.
  'install.requested': 'Installation started',
  'install.completed': 'Installed and healthy',
  'install.failed': 'Installation failed',
  'install.enrollment.rejected': 'Another helper tried to connect',
  'deploy.requested': 'Update started',
  'deploy.completed': 'Update complete',
  'deploy.failed': 'Update failed',
  'rollback.requested': 'Rollback started',
  'rollback.completed': 'Rolled back',
  'rollback.failed': 'Rollback failed',
  'destroy.requested': 'Removal started',
  'destroy.completed': 'Deployment removed',
  'destroy.failed': 'Removal failed',
  'config.updated': 'Configuration updated',
  'health.reported': 'Health reported',
  'health.degraded': 'Health degraded',
  'health.recovered': 'Back to healthy',
  'relay.reenrollment.requested': 'Reconnect requested',

  'config.validate': 'Configuration checked',
  'config.write': 'Configuration updated',
  'config.health': 'Health check after configuration change',
  'config.state.healthy': 'Configuration applied',

  'redis.provision.started': 'Setting up cache',
  'redis.provision.succeeded': 'Cache ready',
  'redis.provision.failed': 'Cache setup failed',
};

/** Human-readable label for an event type (§65). */
export function eventTypeLabel(eventType: string): string {
  const specific = EVENT_TYPE_LABELS[eventType];
  if (specific) return specific;
  const family = eventFamily(eventType);
  if (family) return FAMILY_LABELS[family];
  return titleCase(eventType);
}

function titleCase(value: string): string {
  const last = value.split('.').pop() ?? value;
  return last
    .replace(/[-_]/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

// ── §62 event result labels ─────────────────────────────────────────────────

/**
 * Human-readable label for an event `result` value. The raw result (which may
 * carry a §61 failure code referencing a service) stays behind the expandable
 * payload layer; the top level shows only this jargon-free label (§65).
 */
export function eventResultLabel(result: string | null): string | null {
  if (result === null) return null;
  if (result === 'ok' || result === 'passed') return 'Succeeded';
  if (result === 'skipped') return 'Skipped';
  if (result.startsWith('failed')) return 'Failed';
  return result;
}

// ── §61 failure codes ───────────────────────────────────────────────────────

/** The twenty §61 stable failure codes. */
export const FAILURE_CODES = [
  'AWS_SCP_BLOCKED',
  'PORT_MISMATCH',
  'REGION_NOT_SUPPORTED',
  'QUOTA_EXCEEDED',
  'IMAGE_HEALTH_CHECK_FAILED',
  'MIGRATION_FAILED',
  'RELAY_DISCONNECTED',
  'ECS_DEPLOYMENT_FAILED',
  'RDS_UNAVAILABLE',
  'AWS_PERMISSION_DENIED',
  'STACK_CREATE_FAILED',
  'DATABASE_CREATE_FAILED',
  'DATABASE_CONNECTION_FAILED',
  'IMAGE_PULL_FAILED',
  'CONTAINER_START_FAILED',
  'MISSING_SECRET',
  'UNSUPPORTED_ARCHITECTURE',
  'UNKNOWN',
  'REDIS_PROVISIONING_FAILED',
  'REDIS_CONNECTION_FAILED',
] as const;

/** A §61 failure code — exactly the twenty values in `FAILURE_CODES`. */
export type FailureCode = (typeof FAILURE_CODES)[number];

/** Severity drives the color-coded badge: critical (destructive) vs warning. */
export type FailureSeverity = 'critical' | 'warning';

/** The §65 top-level copy for one failure code. */
export interface FailureCopy {
  /** Short, jargon-free label (e.g. "Cloud policy blocks this"). */
  label: string;
  /** One jargon-free sentence summarizing the failure. */
  description: string;
  /** Color-coded severity. */
  severity: FailureSeverity;
}

/**
 * Human-readable §65 copy for every §61 failure code. The label + description
 * are plain English — never raw AWS service names at the top level (§65).
 * The raw code lives behind the expandable technical-detail layer.
 */
export const FAILURE_CODE_COPY: Record<FailureCode, FailureCopy> = {
  AWS_SCP_BLOCKED: {
    label: 'Cloud policy blocks this',
    description: "A policy in your organization's cloud account is blocking the setup.",
    severity: 'critical',
  },
  PORT_MISMATCH: {
    label: 'Port conflict',
    description: 'Your app listens on one port, but the service expects another.',
    severity: 'warning',
  },
  REGION_NOT_SUPPORTED: {
    label: 'Region not supported',
    description: "The chosen region isn't one we can deploy to yet.",
    severity: 'warning',
  },
  QUOTA_EXCEEDED: {
    label: 'Account limit reached',
    description: 'Your cloud account has hit a resource limit.',
    severity: 'warning',
  },
  IMAGE_HEALTH_CHECK_FAILED: {
    label: 'Health check failing',
    description: "The app started, but its health check isn't passing.",
    severity: 'warning',
  },
  MIGRATION_FAILED: {
    label: 'Migration failed',
    description: "A database migration step didn't finish successfully.",
    severity: 'critical',
  },
  RELAY_DISCONNECTED: {
    label: 'Helper disconnected',
    description: 'The helper in your cloud account is no longer checking in.',
    severity: 'critical',
  },
  ECS_DEPLOYMENT_FAILED: {
    label: 'Deployment failed',
    description: "The new version couldn't be rolled out.",
    severity: 'critical',
  },
  RDS_UNAVAILABLE: {
    label: 'Database unreachable',
    description: "The database isn't reachable right now.",
    severity: 'critical',
  },
  AWS_PERMISSION_DENIED: {
    label: 'Permission denied',
    description: "Your cloud account doesn't allow this action.",
    severity: 'critical',
  },
  STACK_CREATE_FAILED: {
    label: 'Setup failed',
    description: "The initial setup couldn't complete.",
    severity: 'critical',
  },
  DATABASE_CREATE_FAILED: {
    label: 'Database setup failed',
    description: "The database couldn't be created.",
    severity: 'critical',
  },
  DATABASE_CONNECTION_FAILED: {
    label: 'Database connection failed',
    description: "The app can't reach the database.",
    severity: 'critical',
  },
  IMAGE_PULL_FAILED: {
    label: 'Image pull failed',
    description: "The app image couldn't be loaded.",
    severity: 'critical',
  },
  CONTAINER_START_FAILED: {
    label: 'App failed to start',
    description: "The app container started but didn't stay running.",
    severity: 'critical',
  },
  MISSING_SECRET: {
    label: 'Missing secret',
    description: 'A required secret is not configured.',
    severity: 'warning',
  },
  UNSUPPORTED_ARCHITECTURE: {
    label: 'Unsupported architecture',
    description: "This app's architecture isn't supported yet.",
    severity: 'warning',
  },
  UNKNOWN: {
    label: 'Unknown issue',
    description: "Something failed and we couldn't pin down the cause.",
    severity: 'critical',
  },
  REDIS_PROVISIONING_FAILED: {
    label: 'Cache setup failed',
    description: "The cache this application needs couldn't be set up.",
    severity: 'critical',
  },
  REDIS_CONNECTION_FAILED: {
    label: "App can't reach its cache",
    description: "The app started, but it can't reach its cache.",
    severity: 'critical',
  },
};

/** §29 what happened / why / how to fix, per failure code. */
export interface FailureRemediation {
  /** What happened, in the vendor's terms. */
  what: string;
  /** Why it happened. */
  why: string;
  /** The next action the vendor (or their customer) can actually take. */
  fix: string;
}

/**
 * §29 remediation per §61 failure code.
 *
 * The diagnostics endpoint used to answer every failure with the same three
 * hardcoded sentences — "Deployment failed / The deployment did not reach a
 * healthy state / Check the event log for details and retry the deployment" —
 * regardless of what the relay reported. That last line also pointed at an
 * event log the vendor had no way to see. These are per-code, and every fix
 * names something the reader can do.
 *
 * §65 applies as strictly here as anywhere: no CloudFormation, IAM, ECS, ALB,
 * VPC or RDS in this copy. The raw code and the relay's own message sit
 * behind the "Technical detail" disclosure for anyone who wants them.
 */
export const FAILURE_REMEDIATION: Record<FailureCode, FailureRemediation> = {
  AWS_SCP_BLOCKED: {
    what: 'Setup was blocked by a policy in your customer’s cloud organization.',
    why: 'Their organization restricts what can be created in this account or region.',
    fix: 'Ask your customer to allow the Deployz setup in this account, or to choose an account without that restriction, then run the install link again.',
  },
  PORT_MISMATCH: {
    what: 'The application started but nothing answered on the expected port.',
    why: 'The port Deployz was told to route traffic to is not the port the app listens on.',
    fix: 'Check the port on the application’s settings screen against the one your app binds, correct it, and deploy again.',
  },
  REGION_NOT_SUPPORTED: {
    what: 'This deployment cannot run in the region it was created for.',
    why: 'Deployz does not support that region yet.',
    fix: 'Remove this deployment and create it again in a supported region.',
  },
  QUOTA_EXCEEDED: {
    what: 'Your customer’s cloud account hit a resource limit during setup.',
    why: 'The account has reached the maximum it is allowed for one of the resources this deployment needs.',
    fix: 'Ask your customer to request a limit increase from their cloud provider, then deploy again.',
  },
  IMAGE_HEALTH_CHECK_FAILED: {
    what: 'The application started but never reported itself healthy.',
    why: 'The health check endpoint did not return a success response within the startup window.',
    fix: 'Confirm the health check path on the application’s settings screen returns a 200 once the app is ready, then deploy again.',
  },
  MIGRATION_FAILED: {
    what: 'The database migration step failed, so the new version was not started.',
    why: 'The migration command exited with an error.',
    fix: 'Fix the migration in your repository, publish a new release, and deploy it. The previous version is still running.',
  },
  RELAY_DISCONNECTED: {
    what: 'The helper running in your customer’s cloud account stopped checking in.',
    why: 'It was removed, it lost its credential, or the account can no longer reach Deployz.',
    fix: 'Use Reconnect relay on this deployment and ask your customer to run the install link again.',
  },
  ECS_DEPLOYMENT_FAILED: {
    what: 'The new version could not be rolled out.',
    why: 'The updated application did not reach a running state, so the rollout was stopped.',
    fix: 'Open Technical detail for the reported error, fix it in a new release, and deploy again. The previous version keeps serving traffic.',
  },
  RDS_UNAVAILABLE: {
    what: 'The database was not reachable during the deployment.',
    why: 'The managed database was still starting, or is unavailable in your customer’s account.',
    fix: 'Wait for the database to finish starting and deploy again. If it keeps failing, ask your customer to check the database in their account.',
  },
  AWS_PERMISSION_DENIED: {
    what: 'The helper was refused permission for something this deployment needs.',
    why: 'The permissions granted at install time do not cover this action.',
    fix: 'Ask your customer to re-run the install link so the setup can grant the current permissions.',
  },
  STACK_CREATE_FAILED: {
    what: 'The initial setup in your customer’s account did not complete.',
    why: 'One of the resources being created failed, so the whole setup was rolled back.',
    fix: 'Open Technical detail for the failing resource, then ask your customer to run the install link again.',
  },
  DATABASE_CREATE_FAILED: {
    what: 'The database could not be created.',
    why: 'The account rejected the database this application requires.',
    fix: 'Check whether your customer’s account limits databases in this region, then run the install link again.',
  },
  DATABASE_CONNECTION_FAILED: {
    what: 'The application started but could not reach its database.',
    why: 'The connection was refused or timed out.',
    fix: 'Confirm the application reads its database settings from the environment Deployz provides, then deploy again.',
  },
  IMAGE_PULL_FAILED: {
    what: 'The application image could not be downloaded into your customer’s account.',
    why: 'The image is missing, or the account is not allowed to download it.',
    fix: 'Publish the release again, then deploy it. If it keeps failing, remove and re-create the deployment.',
  },
  CONTAINER_START_FAILED: {
    what: 'The application started and then stopped.',
    why: 'It exited during startup — usually a missing setting or an error before it began serving.',
    fix: 'Check the required values on the Configuration screen are all set, then deploy again.',
  },
  MISSING_SECRET: {
    what: 'A required secret has no value for this customer.',
    why: 'The application asks for a secret that is not set as a default or an override.',
    fix: 'Set the missing value on the Configuration screen, then deploy again.',
  },
  UNSUPPORTED_ARCHITECTURE: {
    what: 'This application cannot be deployed as it is built.',
    why: 'It uses something Deployz does not support yet.',
    fix: 'Open the application’s readiness screen for the specific change needed, make it, and publish a new release.',
  },
  UNKNOWN: {
    what: 'The deployment failed.',
    why: 'The helper reported a failure without a cause Deployz recognises.',
    fix: 'Open Technical detail for the reported error, then deploy again. If it keeps failing, remove the deployment and create it again.',
  },
  REDIS_PROVISIONING_FAILED: {
    what: 'The cache this application needs could not be set up.',
    why: 'A limit was hit, or the resource was rejected, in your customer’s cloud account while the cache was being created.',
    fix: 'Retry the deployment. If it keeps failing, ask your customer to check their cloud account’s service limits for caches in this region.',
  },
  REDIS_CONNECTION_FAILED: {
    what: 'The application started but could not reach its cache.',
    why: 'The connection was refused or timed out.',
    fix: 'Redeploy the application. If it keeps failing, contact Deployz support.',
  },
};

/** Badge variant for a severity (maps to shadcn/ui Badge variants). */
export type FailureBadgeVariant = 'destructive' | 'secondary';

export const FAILURE_SEVERITY_BADGE: Record<FailureSeverity, FailureBadgeVariant> = {
  critical: 'destructive',
  warning: 'secondary',
};

/** Status dot tone class for a severity. */
export const FAILURE_SEVERITY_DOT: Record<FailureSeverity, string> = {
  critical: 'bg-destructive',
  warning: 'bg-muted-foreground',
};

/**
 * Generic fallback for the why/fix sections when the AI explanation isn't
 * available yet (still §65 jargon-free — never fabricated detail).
 */
export const EXPLANATION_FALLBACK = {
  why: 'The cause is still being narrowed down. The technical detail below shows the signals we have.',
  fix: "If the cause isn't clear from the detail below, contact Deployz support.",
} as const;

/** §65 lookup for a failure code — falls back safely to UNKNOWN copy. */
export function failureCodeCopy(code: string): FailureCopy {
  return FAILURE_CODE_COPY[code as FailureCode] ?? FAILURE_CODE_COPY.UNKNOWN;
}

// ── §19 readiness verdicts ──────────────────────────────────────────────────

/** §19 verdict vocabulary: READY / NEEDS_ATTENTION / NOT_COMPATIBLE. */
export const COMPATIBILITY_VERDICTS = [
  'READY',
  'NEEDS_ATTENTION',
  'NOT_COMPATIBLE',
] as const;

export type CompatibilityVerdict = (typeof COMPATIBILITY_VERDICTS)[number];

export interface VerdictPresentation {
  /** The verdict headline (§65 copy). */
  heading: string;
  /** Short badge label. */
  label: string;
  /** Visual tone — READY is green (§19). */
  tone: 'ready' | 'attention' | 'incompatible';
}

export const VERDICT_PRESENTATION: Record<CompatibilityVerdict, VerdictPresentation> = {
  READY: { heading: 'Your app is ready to deploy.', label: 'Ready', tone: 'ready' },
  NEEDS_ATTENTION: { heading: 'Needs attention', label: 'Needs attention', tone: 'attention' },
  NOT_COMPATIBLE: {
    heading: 'Not currently compatible',
    label: 'Not currently compatible',
    tone: 'incompatible',
  },
};

// ── §42 onboarding steps ────────────────────────────────────────────────────

/** The six §42 onboarding steps, in exact order. Success = readiness (§5). */
export const ONBOARDING_STEPS = [
  'Connect GitHub',
  'Choose repository',
  'Analyse',
  'Fix compatibility issues',
  'Create test deployment',
  'Ready for customer deployment',
] as const;

// ── §31 secret mask ─────────────────────────────────────────────────────────

/** The value used to mask secrets in API responses and event payloads (§31). */
export const SECRET_MASK = '***';