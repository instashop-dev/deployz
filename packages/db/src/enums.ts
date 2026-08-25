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

// §46 deployment states — product vocabulary. Customers never see raw
// CFN/ECS internals; these nine states are the whole user-facing model.
export const deploymentStateEnum = pgEnum('deployment_state', [
  'NOT_INSTALLED',
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
  'CONFIG_UPDATE',
  'DESTROY',
  'MIGRATION',
  'INFRA_UPGRADE',
  'HEALTH_REPORT',
  'PREFLIGHT',
  'HEALTH_CHECK',
]);

// §39 job states. WAITING semantics: the job is waiting on customer approval
// OR on relay pickup — the payload/result disambiguates which.
// QUEUED and SUCCESS are the brief's original names (§39).
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
  'DATABASE_CREATE_FAILED',
  'DATABASE_CONNECTION_FAILED',
  'IMAGE_PULL_FAILED',
  'CONTAINER_START_FAILED',
  'MISSING_SECRET',
  'UNSUPPORTED_ARCHITECTURE',
  'UNKNOWN',
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
