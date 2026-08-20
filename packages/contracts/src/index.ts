import { z } from 'zod';

// Shared Zod contracts between api and web. Shapes mirror the Drizzle schema
// in @deployz/db (packages/db/src/schema/*.ts) exactly — the db stays the
// source of truth; these are the WIRE forms (timestamptz -> ISO datetime
// strings, date -> ISO date strings, jsonb -> record). Parity with the live
// pgEnums is locked by index.test.ts.
//
// Enum values cite the plan sections (`.omo/plans/deployz-mvp.md`) whose
// vocabulary they implement. Copy values verbatim from packages/db/src/enums.ts.

export const PACKAGE_NAME = '@deployz/contracts';

// ---------------------------------------------------------------------------
// Enums (parity-tested against @deployz/db pgEnums)
// ---------------------------------------------------------------------------

// applications.analysis_status — repository analysis lifecycle (§18/§19).
export const analysisStatusSchema = z.enum(['PENDING', 'ANALYZING', 'COMPLETE', 'FAILED']);
export type AnalysisStatus = z.infer<typeof analysisStatusSchema>;

// applications.compatibility_status — persisted §19 verdict.
export const compatibilityStatusSchema = z.enum(['READY', 'NEEDS_ATTENTION', 'NOT_COMPATIBLE']);
export type CompatibilityStatus = z.infer<typeof compatibilityStatusSchema>;

// releases.release_status — image build lifecycle.
export const releaseStatusSchema = z.enum(['BUILDING', 'READY', 'FAILED']);
export type ReleaseStatus = z.infer<typeof releaseStatusSchema>;

// §32 region allowlist — EXACTLY these 17 AWS regions, nothing else.
export const regionSchema = z.enum([
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
export type Region = z.infer<typeof regionSchema>;

// §46 deployment states — product vocabulary. Customers never see raw
// CFN/ECS internals; these nine states are the whole user-facing model.
export const deploymentStateSchema = z.enum([
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
export type DeploymentState = z.infer<typeof deploymentStateSchema>;

// §39 job types. MIGRATION is the §26 internal gated step; INFRA_UPGRADE is
// §60; HEALTH_REPORT carries relay REPORT_HEALTH payloads.
export const jobTypeSchema = z.enum([
  'INSTALL',
  'DEPLOY_RELEASE',
  'ROLLBACK',
  'CONFIG_UPDATE',
  'DESTROY',
  'MIGRATION',
  'INFRA_UPGRADE',
  'HEALTH_REPORT',
]);
export type JobType = z.infer<typeof jobTypeSchema>;

// §39 job states. WAITING semantics: the job is waiting on customer approval
// OR on relay pickup — the payload/result disambiguates which.
export const jobStateSchema = z.enum([
  'REQUESTED',
  'WAITING',
  'RUNNING',
  'SUCCEEDED',
  'FAILED',
  'CANCELLED',
]);
export type JobState = z.infer<typeof jobStateSchema>;

// §61 failure codes — stable taxonomy from day one. Todo 27 (classifier
// pipeline) may extend this set; nothing else may invent codes.
export const failureCodeSchema = z.enum([
  'AWS_SCP_BLOCKED',
  'PORT_MISMATCH',
  'REGION_NOT_SUPPORTED',
  'QUOTA_EXCEEDED',
  'IMAGE_HEALTH_CHECK_FAILED',
  'MIGRATION_FAILED',
  'RELAY_DISCONNECTED',
  'ECS_DEPLOYMENT_FAILED',
  'RDS_UNAVAILABLE',
  'UNKNOWN',
]);
export type FailureCode = z.infer<typeof failureCodeSchema>;

// subscriptions.status — Stripe subscription lifecycle subset we persist.
export const subscriptionStatusSchema = z.enum([
  'ACTIVE',
  'TRIALING',
  'PAST_DUE',
  'CANCELED',
  'INCOMPLETE',
]);
export type SubscriptionStatus = z.infer<typeof subscriptionStatusSchema>;

// ---------------------------------------------------------------------------
// Shared column groups
// ---------------------------------------------------------------------------

const jsonRecord = z.record(z.string(), z.unknown());

// §62 audit fields on every infra-changing record (Better Auth text user id;
// nullable — relay/system actors are not users).
const auditColumns = {
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  createdBy: z.string().nullable(),
  updatedBy: z.string().nullable(),
} as const;

// ---------------------------------------------------------------------------
// Core objects (§33–§40) — shapes mirror packages/db/src/schema/*.ts
// ---------------------------------------------------------------------------

// Better Auth organization plugin shape + Deployz Stripe linkage (§48).
export const organizationSchema = z.object({
  id: z.string(), // Better Auth text pk
  name: z.string(),
  slug: z.string(),
  logo: z.string().nullable(),
  metadata: z.string().nullable(),
  stripeCustomerId: z.string().nullable(),
  createdAt: z.iso.datetime(),
  // Plugin declares updatedAt optional — nullable by design.
  updatedAt: z.iso.datetime().nullable(),
});
export type Organization = z.infer<typeof organizationSchema>;

// Better Auth core user shape.
export const userSchema = z.object({
  id: z.string(), // Better Auth text pk
  name: z.string(),
  email: z.email(),
  emailVerified: z.boolean(),
  image: z.string().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type User = z.infer<typeof userSchema>;

export const applicationSchema = z.object({
  id: z.uuid(),
  organizationId: z.string(),
  name: z.string(),
  githubInstallationId: z.string().nullable(),
  repoFullName: z.string(),
  repoUrl: z.string(),
  defaultBranch: z.string(),
  analysisStatus: analysisStatusSchema,
  // §19 verdict persistence: status + human-readable reason.
  compatibilityStatus: compatibilityStatusSchema.nullable(),
  compatibilityReason: z.string().nullable(),
  // §18 detector output (deterministic analyser result blob).
  detectedMetadata: jsonRecord.nullable(),
  ...auditColumns,
});
export type Application = z.infer<typeof applicationSchema>;

export const releaseSchema = z.object({
  id: z.uuid(),
  applicationId: z.uuid(),
  version: z.string(),
  gitSha: z.string(),
  // Immutable sha256: digest, set once the image build completes.
  imageDigest: z.string().nullable(),
  // §26 migration command carried with the release.
  migrationCommand: z.string().nullable(),
  releaseStatus: releaseStatusSchema,
  ...auditColumns,
});
export type Release = z.infer<typeof releaseSchema>;

// §37: MINIMAL on purpose — Deployz is not a CRM. No extra fields.
export const customerSchema = z.object({
  id: z.uuid(),
  organizationId: z.string(),
  name: z.string(),
  email: z.email(),
  company: z.string().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type Customer = z.infer<typeof customerSchema>;

export const deploymentSchema = z.object({
  id: z.uuid(),
  customerId: z.uuid(),
  applicationId: z.uuid(),
  organizationId: z.string(),
  // §32 region allowlist (enum enforces the exact 17).
  region: regionSchema,
  // §46 product-vocabulary state machine.
  state: deploymentStateSchema,
  // §59 desired/observed state model.
  desiredState: jsonRecord,
  observedState: jsonRecord.nullable(),
  // §60 infra version marker — INFRA_UPGRADE jobs move this forward.
  infraVersion: z.string(),
  // Install identifier handed to the customer/relay.
  installationId: z.string(),
  // §7 free test deployment flag.
  isTestDeployment: z.boolean(),
  lastHealthAt: z.iso.datetime().nullable(),
  ...auditColumns,
});
export type Deployment = z.infer<typeof deploymentSchema>;

// §39 DeploymentJob — the unit of work the relay executes.
export const deploymentJobSchema = z.object({
  id: z.uuid(),
  deploymentId: z.uuid(),
  type: jobTypeSchema,
  state: jobStateSchema,
  // §39 idempotency: retries with the same key must not double-execute.
  idempotencyKey: z.string(),
  payload: jsonRecord,
  result: jsonRecord.nullable(),
  // §61 stable failure code, set only on FAILED.
  failureCode: failureCodeSchema.nullable(),
  // Better Auth text user id. No FK by design: job history must outlive
  // user deletion.
  requestedBy: z.string().nullable(),
  startedAt: z.iso.datetime().nullable(),
  finishedAt: z.iso.datetime().nullable(),
  ...auditColumns,
});
export type DeploymentJob = z.infer<typeof deploymentJobSchema>;

// §40 EventLog — the APPEND-ONLY audit stream. No created_at/updated_at by
// design: append-only rows never update.
export const eventLogSchema = z.object({
  id: z.number().int(), // bigserial
  occurredAt: z.iso.datetime(),
  actorType: z.string(),
  actorId: z.string(),
  organizationId: z.string(),
  customerId: z.uuid().nullable(),
  deploymentId: z.uuid().nullable(),
  jobId: z.uuid().nullable(),
  releaseId: z.uuid().nullable(),
  eventType: z.string(),
  previousState: z.string().nullable(),
  requestedState: z.string().nullable(),
  result: z.string().nullable(),
  payload: jsonRecord,
});
export type EventLog = z.infer<typeof eventLogSchema>;

// §48 billing: one subscription per organization.
export const subscriptionSchema = z.object({
  id: z.uuid(),
  organizationId: z.string(),
  stripeSubscriptionId: z.string(),
  stripeBasePriceId: z.string(),
  stripeMeteredPriceId: z.string(),
  status: subscriptionStatusSchema,
  currentPeriodStart: z.iso.datetime().nullable(),
  currentPeriodEnd: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type Subscription = z.infer<typeof subscriptionSchema>;

// §48/U8 day-proration shape: ONE record per deployment per day.
export const usageRecordSchema = z.object({
  id: z.uuid(),
  deploymentId: z.uuid(),
  usageDate: z.iso.date(),
  quantity: z.number().int(),
  stripeUsageRecordId: z.string().nullable(),
  reportedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type UsageRecord = z.infer<typeof usageRecordSchema>;

// ---------------------------------------------------------------------------
// Structured error envelope — the single error wire shape for the API.
// ---------------------------------------------------------------------------

export const errorEnvelopeSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
  }),
});
export type ErrorEnvelope = z.infer<typeof errorEnvelopeSchema>;
