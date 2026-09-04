import { pgEnum } from 'drizzle-orm/pg-core';

// All Postgres enum types for the Deployz control plane. Each enum cites the
// plan section (`.omo/plans/deployz-mvp.md`) whose vocabulary it implements.

// applications.analysis_status — repository analysis lifecycle (§18/§19).
export const analysisStatusEnum = pgEnum('analysis_status', [
  'PENDING',
  'ANALYZING',
  'COMPLETE',
  'FAILED',
]);

// applications.compatibility_status — persisted §19 verdict.
export const compatibilityStatusEnum = pgEnum('compatibility_status', [
  'READY',
  'NEEDS_ATTENTION',
  'NOT_COMPATIBLE',
]);

// releases.release_status — image build lifecycle.
export const releaseStatusEnum = pgEnum('release_status', [
  'BUILDING',
  'READY',
  'FAILED',
]);

// §32 region allowlist — EXACTLY these 17 AWS regions, nothing else.
export const regionEnum = pgEnum('region', [
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
]);

// deployments.source — origin attribution of a deployment row.
export const deploymentSourceEnum = pgEnum('deployment_source', ['manual', 'deploy_link']);

// §46 deployment states — product vocabulary. Customers never see raw
// CFN/ECS internals; these ten states are the whole user-facing model.
export const deploymentStateEnum = pgEnum('deployment_state', [
  'NOT_INSTALLED',
  'WAITING_FOR_RELAY',
  'INSTALLING',
  'HEALTHY',
  'UPDATING',
  'UPDATE_AVAILABLE',
  'FAILED',
  'DISCONNECTED',
  'DELETING',
  'DELETED',
]);

// §39 job types. MIGRATION is the §26 internal gated step; INFRA_UPGRADE is
// §60; HEALTH_REPORT carries relay REPORT_HEALTH payloads. PREFLIGHT and
// HEALTH_CHECK are the brief's original names (§39), added for completeness.
export const jobTypeEnum = pgEnum('job_type', [
  'INSTALL',
  'DEPLOY_RELEASE',
  'ROLLBACK',
  'RESTART',
  'CONFIG_UPDATE',
  'DESTROY',
  'MIGRATION',
  'INFRA_UPGRADE',
  'HEALTH_REPORT',
  'PREFLIGHT',
  'HEALTH_CHECK',
  'CONFIGURE_DOMAIN',
  'REMOVE_DOMAIN',
  'PURGE',
]);

// §39 job states. WAITING semantics: the job is waiting on customer approval
// OR on relay pickup — the payload/result disambiguates which.
// QUEUED and SUCCESS are the brief's original names (§39). SUCCESS is
// legacy: rows recorded before the CANARY fixes wrote it, so every reader
// accepts SUCCEEDED and SUCCESS alike. New writes always use SUCCEEDED; do
// not drop SUCCESS from the enum without a data migration first.
export const jobStateEnum = pgEnum('job_state', [
  'REQUESTED',
  'QUEUED',
  'WAITING',
  'RUNNING',
  'SUCCEEDED',
  'SUCCESS',
  'FAILED',
  'CANCELLED',
]);

// §61 failure codes — stable taxonomy from day one.
export const failureCodeEnum = pgEnum('failure_code', [
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
  'STACK_DELETE_FAILED',
  'DATABASE_CREATE_FAILED',
  'DATABASE_CONNECTION_FAILED',
  'IMAGE_PULL_FAILED',
  'CONTAINER_START_FAILED',
  'MISSING_SECRET',
  'UNSUPPORTED_ARCHITECTURE',
  'UNKNOWN',
  // Redis MVP: provisioning the managed cache (ElastiCache Valkey) failed,
  // vs. the app failing to reach an already-provisioned cache at runtime.
  'REDIS_PROVISIONING_FAILED',
  'REDIS_CONNECTION_FAILED',
  // Watchdog (Phase 5): a CONFIGURE_DOMAIN/REMOVE_DOMAIN job that outlived
  // its generous window is marked FAILED with this code; the domain row's
  // lastError keeps the visible record and the next cycle retries.
  'DOMAIN_OPERATION_TIMEOUT',
  // CANARY-006: the relay's own failure to persist its deferral marker —
  // a Deployz-side fault, distinct from any customer resource failure.
  'RELAY_STATE_WRITE_FAILED',
]);

// subscriptions.status — Stripe subscription lifecycle subset we persist.
export const subscriptionStatusEnum = pgEnum('subscription_status', [
  'ACTIVE',
  'TRIALING',
  'PAST_DUE',
  'CANCELED',
  'INCOMPLETE',
]);

export const relayStatusEnum = pgEnum('relay_status', [
  'CONNECTED',
  'DISCONNECTED',
  'UNKNOWN',
]);

export const healthStatusEnum = pgEnum('health_status', [
  'UNKNOWN',
  'HEALTHY',
  'DEGRADED',
  'UNHEALTHY',
]);

export const orgPlanEnum = pgEnum('org_plan', [
  'FREE',
  'STARTER',
  'PRO',
]);

export const buildStatusEnum = pgEnum('build_status', [
  'PENDING',
  'BUILDING',
  'SUCCEEDED',
  'FAILED',
]);

// Lifecycle of the cached AI explanation on a deployment attempt. Deliberately
// SEPARATE from jobState: a failed explanation says nothing about the job, and
// must never be mistaken for a failed deployment.
//   PENDING    — never attempted
//   GENERATING — claimed by one request; others must not call the model
//   READY      — text is cached and served from the database
//   FAILED     — generation failed; retryable on a later diagnostics request
export const aiExplanationStateEnum = pgEnum('ai_explanation_state', [
  'PENDING',
  'GENERATING',
  'READY',
  'FAILED',
]);

// Custom-domain lifecycle (custom-domains MVP). Six states; the UI maps
// them 1:1 (Setting up / Waiting for DNS / Connecting / Active / Needs
// attention / Removing). Deliberately separate from deployment_state: a
// domain failure must never look like a deployment failure.
export const customDomainStatusEnum = pgEnum('custom_domain_status', [
  'PENDING',
  'WAITING_FOR_DNS',
  'CONFIGURING',
  'ACTIVE',
  'ERROR',
  'REMOVING',
]);

// deployments.cleanup_state — what happened to AWS resources at disconnect.
//   SKIPPED_RELAY_OFFLINE — force-completed while the relay was offline; the
//                          customer account may still hold Deployz resources.
//   PURGE_FAILED          — a PURGE attempt failed (permission, wedge); the
//                          deployment stays DELETED, the retained resources
//                          remain, and the purge is retryable from here.
//   COMPLETE              — a later PURGE removed every retained resource.
// Null on every normal disconnect: the relay deleted the resources itself.
export const cleanupStateEnum = pgEnum('cleanup_state', [
  'SKIPPED_RELAY_OFFLINE',
  'PURGE_FAILED',
  'COMPLETE',
]);

// Infrastructure resource inventory — how the control plane classifies every
// CloudFormation resource the relay observes. Values mirror the contracts
// unions (packages/contracts/src/infrastructure.ts) exactly; the parity test
// locks them.
export const infrastructureComponentKindEnum = pgEnum('infrastructure_component_kind', [
  'application',
  'database',
  'storage',
  'cache',
  'endpoint',
  'network',
  'monitoring',
  'container_registry',
  'other',
]);

export const infrastructureResourceRoleEnum = pgEnum('infrastructure_resource_role', [
  'primary',
  'supporting',
]);

export const infrastructureLifecycleEnum = pgEnum('infrastructure_lifecycle', [
  'delete',
  'retain',
  'snapshot',
  'conditional',
]);

export const infrastructureComponentStatusEnum = pgEnum('infrastructure_component_status', [
  'pending',
  'provisioning',
  'ready',
  'updating',
  'deleting',
  'failed',
  'retained',
  'removed',
  'unknown',
]);
