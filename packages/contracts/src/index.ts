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
  'PREFLIGHT',
  'HEALTH_CHECK',
  'CONFIGURE_DOMAIN',
  'REMOVE_DOMAIN',
]);
export type JobType = z.infer<typeof jobTypeSchema>;

// §39 job states. WAITING semantics: the job is waiting on customer approval
// OR on relay pickup — the payload/result disambiguates which.
export const jobStateSchema = z.enum([
  'REQUESTED',
  'QUEUED',
  'WAITING',
  'RUNNING',
  'SUCCEEDED',
  'SUCCESS',
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
]);
export type FailureCode = z.infer<typeof failureCodeSchema>;

export const relayStatusSchema = z.enum(['CONNECTED', 'DISCONNECTED', 'UNKNOWN']);
export type RelayStatus = z.infer<typeof relayStatusSchema>;

// UNKNOWN first: a deployment that has never checked in has no observed
// health, and the column defaults to it. Reporting UNKNOWN is a relay saying
// "I cannot tell", which is different from saying nothing at all.
export const healthStatusSchema = z.enum(['UNKNOWN', 'HEALTHY', 'DEGRADED', 'UNHEALTHY']);

/**
 * §24 per-component health. Every field optional — the relay reports only the
 * components a deployment actually has, so an application with no database
 * simply omits it rather than claiming one is healthy.
 */
export const healthComponentsSchema = z
  .object({
    application: healthStatusSchema.optional(),
    database: healthStatusSchema.optional(),
    storage: healthStatusSchema.optional(),
    loadBalancer: healthStatusSchema.optional(),
  })
  .strict();
export type HealthComponents = z.infer<typeof healthComponentsSchema>;
export type HealthStatus = z.infer<typeof healthStatusSchema>;

export const orgPlanSchema = z.enum(['FREE', 'STARTER', 'PRO']);
export type OrgPlan = z.infer<typeof orgPlanSchema>;

export const buildStatusSchema = z.enum(['PENDING', 'BUILDING', 'SUCCEEDED', 'FAILED']);
export type BuildStatus = z.infer<typeof buildStatusSchema>;

// subscriptions.status — Stripe subscription lifecycle subset we persist.
export const subscriptionStatusSchema = z.enum([
  'ACTIVE',
  'TRIALING',
  'PAST_DUE',
  'CANCELED',
  'INCOMPLETE',
]);
export type SubscriptionStatus = z.infer<typeof subscriptionStatusSchema>;

export const customDomainStatusSchema = z.enum([
  'PENDING',
  'WAITING_FOR_DNS',
  'CONFIGURING',
  'ACTIVE',
  'ERROR',
  'REMOVING',
]);
export type CustomDomainStatus = z.infer<typeof customDomainStatusSchema>;

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
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  logo: z.string().nullable(),
  metadata: z.string().nullable(),
  stripeCustomerId: z.string().nullable(),
  plan: orgPlanSchema,
  createdAt: z.iso.datetime(),
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

// Membership roles. Exactly one owner per organization — ownership moves by
// transfer, never by a plain role change (apps/api/src/organizations.ts).
export const organizationRoleSchema = z.enum(['owner', 'admin', 'member']);
export type OrganizationRole = z.infer<typeof organizationRoleSchema>;

// Roles an invitation may carry — never 'owner'.
export const invitableRoleSchema = z.enum(['admin', 'member']);
export type InvitableRole = z.infer<typeof invitableRoleSchema>;

export const invitationStatusSchema = z.enum(['pending', 'accepted', 'rejected', 'canceled']);
export type InvitationStatus = z.infer<typeof invitationStatusSchema>;

export const memberSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  userId: z.string(),
  role: organizationRoleSchema,
  createdAt: z.iso.datetime(),
});
export type Member = z.infer<typeof memberSchema>;

export const invitationSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  email: z.email(),
  role: invitableRoleSchema,
  status: invitationStatusSchema,
  expiresAt: z.iso.datetime(),
  inviterId: z.string(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type Invitation = z.infer<typeof invitationSchema>;

export const applicationSchema = z.object({
  id: z.uuid(),
  organizationId: z.string(),
  name: z.string(),
  githubInstallationId: z.string().nullable(),
  repoFullName: z.string(),
  repoUrl: z.string(),
  defaultBranch: z.string(),
  containerPort: z.number().int().nullable(),
  healthPath: z.string().nullable(),
  // §35 vendor-default migration command; releases.migrationCommand overrides.
  migrationCommand: z.string().nullable(),
  workerCommand: z.string().nullable(),
  databaseRequired: z.boolean(),
  storageRequired: z.boolean(),
  redisRequired: z.boolean(),
  analysisStatus: analysisStatusSchema,
  compatibilityStatus: compatibilityStatusSchema.nullable(),
  compatibilityReason: z.string().nullable(),
  detectedMetadata: jsonRecord.nullable(),
  ...auditColumns,
});
export type Application = z.infer<typeof applicationSchema>;

export const releaseSchema = z.object({
  id: z.uuid(),
  applicationId: z.uuid(),
  version: z.string(),
  gitSha: z.string(),
  imageDigest: z.string().nullable(),
  migrationCommand: z.string().nullable(),
  buildStatus: buildStatusSchema,
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
  externalReference: z.string().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type Customer = z.infer<typeof customerSchema>;

export const deploymentSchema = z.object({
  id: z.uuid(),
  customerId: z.uuid(),
  applicationId: z.uuid(),
  organizationId: z.string(),
  region: regionSchema,
  state: deploymentStateSchema,
  awsAccountId: z.string().nullable(),
  currentReleaseId: z.uuid().nullable(),
  previousReleaseId: z.uuid().nullable(),
  relayStatus: relayStatusSchema,
  healthStatus: healthStatusSchema,
  desiredState: jsonRecord,
  observedState: jsonRecord.nullable(),
  infraVersion: z.string(),
  installationId: z.string(),
  isTestDeployment: z.boolean(),
  lastHealthAt: z.iso.datetime().nullable(),
  deletedAt: z.iso.datetime().nullable(),
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

// ---------------------------------------------------------------------------
// CloudFormation Quick Create install link.
//
// Shared because three sides build or check the same URL: the API returns it
// on GET /api/install/:installationId, the publisher (packages/cdk) reports
// it after uploading a template, and the tests assert the exact format. One
// implementation, so the three can never drift.
//
// The URL carries NO credential and NO secret: only the non-secret
// `ControlPlaneUrl` template parameter. The bootstrap-generated credential
// and the minted installation identifier are produced at deploy time inside
// the customer's account and never appear in a URL.
// ---------------------------------------------------------------------------

/** Default CloudFormation stack name for the customer bootstrap stack. */
export const DEFAULT_BOOTSTRAP_STACK_NAME = 'deployz-bootstrap';

/**
 * CloudFormation stack name for a customer's application stack.
 *
 * Pinned here rather than at a call site because two independent components
 * must agree on it: whatever creates the stack, and the verifier that looks it
 * up afterwards. A disagreement between them reads exactly like a failed
 * install. Matches the ECS `serviceName` in
 * `packages/cdk/src/application/application-stack.ts:512`.
 */
export const DEFAULT_APPLICATION_STACK_NAME = 'deployz-app';

/** The bootstrap stack's non-secret control-plane parameter. */
export const CONTROL_PLANE_URL_PARAMETER = 'ControlPlaneUrl';

/** The bootstrap stack's single-use enrollment parameter. */
export const ENROLLMENT_CODE_PARAMETER = 'EnrollmentCode';

export interface BootstrapQuickCreateOptions {
  /** AWS region the console deep-link targets. */
  readonly region: string;
  /** Public HTTPS URL of the published bootstrap template. */
  readonly templateUrl: string;
  /** Base URL of the Deployz control plane the relay polls (non-secret). */
  readonly controlPlaneUrl: string;
  /**
   * Single-use enrollment code from the install link.
   *
   * Optional because the template publisher builds a URL for the PUBLISHED
   * template itself, before any deployment exists and so before any code has
   * been minted. Omitting it leaves the stack's EnrollmentCode parameter at
   * its empty default, which the relay then refuses to enrol with — the
   * customer-facing URL always comes from the install page, which has the
   * code for their specific deployment.
   */
  readonly enrollmentCode?: string | undefined;
  /** CloudFormation stack name. Defaults to `deployz-bootstrap`. */
  readonly stackName?: string | undefined;
}

/**
 * Builds the deterministic CloudFormation Quick Create deep-link:
 *
 *   https://{region}.console.aws.amazon.com/cloudformation/home?region={region}
 *     #/stacks/create/review
 *     ?templateURL={url-encoded templateUrl}
 *     &stackName={stackName}
 *     &param_ControlPlaneUrl={controlPlaneUrl}
 *     &param_EnrollmentCode={enrollmentCode}
 *
 * The relay's communication credential is never here — CloudFormation mints
 * it inside the customer's account. The enrollment code is not that
 * credential: it is single use, it is spent the moment the relay binds, and
 * it exists because the installation identifier is minted in the customer's
 * account too, so nothing else ties this stack to a deployment.
 *
 * Pure — same inputs, same URL. `URLSearchParams` keeps the parameter order
 * deterministic (templateURL, stackName, then params).
 */
export function buildBootstrapQuickCreateUrl(options: BootstrapQuickCreateOptions): string {
  const base =
    `https://${options.region}.console.aws.amazon.com/cloudformation/home` +
    `?region=${encodeURIComponent(options.region)}` +
    `#/stacks/create/review`;

  const query = new URLSearchParams();
  query.set('templateURL', options.templateUrl);
  query.set('stackName', options.stackName ?? DEFAULT_BOOTSTRAP_STACK_NAME);
  query.set(`param_${CONTROL_PLANE_URL_PARAMETER}`, options.controlPlaneUrl);
  if (options.enrollmentCode !== undefined) {
    query.set(`param_${ENROLLMENT_CODE_PARAMETER}`, options.enrollmentCode);
  }

  return `${base}?${query.toString()}`;
}
