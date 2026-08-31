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
export type DeploymentState = z.infer<typeof deploymentStateSchema>;

// §39 job types. MIGRATION is the §26 internal gated step; INFRA_UPGRADE is
// §60; HEALTH_REPORT carries relay REPORT_HEALTH payloads.
export const jobTypeSchema = z.enum([
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
  'STACK_DELETE_FAILED',
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

/**
 * What a relay can actually execute. Reported at enrollment and on every
 * heartbeat; absent (null) for relays built before capabilities existed,
 * which the UI must treat as "nothing supported".
 */
export const relayCapabilitiesSchema = z
  .object({
    deployRelease: z.boolean(),
    rollback: z.boolean(),
    restart: z.boolean(),
    configUpdate: z.boolean(),
    destroy: z.boolean(),
    domainManagement: z.boolean(),
  })
  .strict();
export type RelayCapabilities = z.infer<typeof relayCapabilitiesSchema>;

/** Relay identity block sent with registration and heartbeats. */
export const relayIdentitySchema = z
  .object({
    awsAccountId: z.string().regex(/^\d{12}$/),
    region: z.string(),
    relayVersion: z.string(),
    bootstrapVersion: z.string().nullable(),
    capabilities: relayCapabilitiesSchema,
  })
  .strict();
export type RelayIdentity = z.infer<typeof relayIdentitySchema>;

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
    redis: healthStatusSchema.optional(),
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

export const cleanupStateSchema = z.enum(['SKIPPED_RELAY_OFFLINE', 'COMPLETE']);
export type CleanupState = z.infer<typeof cleanupStateSchema>;

// ---------------------------------------------------------------------------
// Unified deployment status — a read-time derivation, not a persisted state.
//
// Customers (the public install page) and vendors (the fleet/detail screens)
// both need "where is this deployment right now", but today that answer is
// scattered across deployments.state, deployments.healthStatus,
// deployments.relayStatus, the newest deployment_jobs row, and custom_domains
// — four sources a page would otherwise have to reconcile itself, and
// disagree if two pages reconcile them differently. deriveDeploymentStatus
// (apps/api/src/deployment-status.ts) collapses all four into ONE of six
// stages, at read time, from data that already exists; nothing new is
// written to the database for this feature. The two schemas below are the
// only shapes that ever leave the derivation: customerDeploymentStatusSchema
// for the unauthenticated install-status endpoint (never relay/job/AWS
// internals), vendorDeploymentStatusSchema for the authenticated fleet/detail
// endpoints (full operational detail). Both are produced from the same
// internal derived object, so their `stage` can never disagree.
// ---------------------------------------------------------------------------

/**
 * The six-stage lifecycle every deployment's progress collapses into.
 * WAITING_FOR_AWS: the customer has not started the CloudFormation Quick
 * Create yet. CONNECTING: AWS setup ran and the relay is registering.
 * PROVISIONING: the INSTALL job is actively creating infrastructure.
 * VERIFYING: infrastructure exists, health/HTTPS are not both confirmed yet.
 * READY: healthy and reachable over HTTPS. FAILED: the deployment failed
 * (state === 'FAILED') — a relay outage never lands here, only a terminal
 * job failure does.
 */
export const deploymentStageSchema = z.enum([
  'WAITING_FOR_AWS',
  'CONNECTING',
  'PROVISIONING',
  'VERIFYING',
  'READY',
  'FAILED',
]);
export type DeploymentStage = z.infer<typeof deploymentStageSchema>;

/**
 * Per-component progress status. Deliberately NOT the same vocabulary as
 * healthStatusSchema: a component can be "not required" or "pending" before
 * it has ever reported health at all, states healthStatusSchema has no room
 * for.
 */
export const componentProgressStatusSchema = z.enum([
  'PENDING',
  'IN_PROGRESS',
  'READY',
  'FAILED',
  'NOT_REQUIRED',
]);
export type ComponentProgressStatus = z.infer<typeof componentProgressStatusSchema>;

/** One step in the progress list — runtime, database, storage, redis, https. */
export const componentProgressSchema = z
  .object({
    key: z.string(),
    label: z.string(),
    status: componentProgressStatusSchema,
  })
  .strict();
export type ComponentProgress = z.infer<typeof componentProgressSchema>;

/**
 * The public install-status wire shape (GET /api/install/:installLinkId/
 * status). Unauthenticated by design, so this is the ONLY place deployment
 * progress reaches an anonymous caller — no relay identity, no job payloads,
 * no raw AWS/CFN status beyond the single word failure.technical.awsStatus
 * allows, no NOT_REQUIRED components (nothing to show for a component the
 * app never asked for).
 */
export const customerDeploymentStatusSchema = z
  .object({
    stage: deploymentStageSchema,
    updatedAt: z.iso.datetime(),
    currentActivity: z.string(),
    removed: z.boolean(),
    statusUpdatesUnavailable: z.boolean(),
    needsDomainSetup: z.boolean(),
    components: z.array(componentProgressSchema),
    url: z.string().nullable(),
    failure: z
      .object({
        customerMessage: z.string(),
        component: z.string().nullable(),
        reference: z.string(),
        technical: z
          .object({
            stage: z.string(),
            component: z.string().nullable(),
            awsStatus: z.string().nullable(),
          })
          .strict()
          .nullable(),
      })
      .strict()
      .nullable(),
  })
  .strict();
export type CustomerDeploymentStatus = z.infer<typeof customerDeploymentStatusSchema>;

/**
 * The vendor wire shape (GET /api/deployments, GET /api/deployments/:id —
 * one `deploymentStatus` field per row). Full operational detail: relay
 * liveness, the latest job, the raw CFN stack status, NOT_REQUIRED
 * components included. `removed` is not repeated here — the surrounding
 * fleet row already carries `state` (DELETING/DELETED), which is where the
 * vendor screens have always read it from.
 */
export const vendorDeploymentStatusSchema = z
  .object({
    stage: deploymentStageSchema,
    updatedAt: z.iso.datetime(),
    currentActivity: z.string(),
    statusUpdatesUnavailable: z.boolean(),
    needsDomainSetup: z.boolean(),
    components: z.array(componentProgressSchema),
    relay: z
      .object({
        connected: z.boolean(),
        lastSeenAt: z.iso.datetime().nullable(),
      })
      .strict(),
    job: z
      .object({
        type: jobTypeSchema,
        status: jobStateSchema,
      })
      .strict()
      .nullable(),
    aws: z.object({ stackStatus: z.string().nullable() }).strict(),
    health: z.object({ status: healthStatusSchema }).strict(),
    url: z.string().nullable(),
    failure: z
      .object({
        code: failureCodeSchema.nullable(),
        component: z.string().nullable(),
        reference: z.string(),
        message: z.string(),
        awsStatus: z.string().nullable(),
      })
      .strict()
      .nullable(),
  })
  .strict();
export type VendorDeploymentStatus = z.infer<typeof vendorDeploymentStatusSchema>;

/**
 * How long a relay may stay silent (three missed five-minute polls) before it
 * counts as DISCONNECTED. Shared by the API's liveness module and the worker's
 * scheduled sweep — the sweep persists it, every read afterwards trusts the
 * persisted column, so the two must agree on the threshold.
 */
export const RELAY_STALE_AFTER_MS = 15 * 60 * 1000;

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
  cleanupState: cleanupStateSchema.nullable(),
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
 * How long a DESTROY job may stay pending before the dashboard offers
 * "Complete disconnect anyway" — and the API accepts it — when the relay is
 * persistently DISCONNECTED. The value the stuck-job watchdog historically
 * allowed a DESTROY before failing it; the sweep now leaves DESTROY to this
 * path instead, because a watchdog FAILED would strand the deployment with
 * no disconnect left. Shared so the API gate and the UI prompt cannot
 * disagree about when the escape hatch opens.
 */
export const DESTROY_PENDING_STALE_AFTER_MS = 60 * 60 * 1000;

/**
 * CloudFormation stack name for a customer's application stack.
 *
 * Pinned here rather than at a call site because two independent components
 * must agree on it: whatever creates the stack, and the verifier that looks it
 * up afterwards. A disagreement between them reads exactly like a failed
 * install.
 *
 * No production code creates this stack yet — `INSTALL` is still a stub.
 * This constant is the name whoever implements it must use for
 * `CreateStack`'s `StackName`, since `verifyInstallation()` already looks up
 * `DEFAULT_APPLICATION_STACK_NAME` by default. It is NOT pinned by the ECS
 * `serviceName` in `packages/cdk/src/application/application-stack.ts:512` —
 * a service name and a stack name are different namespaces, so treating that
 * as a match would present an unpinned contract as a pinned one. The test
 * harness currently configures the application stack name as the different
 * literal `'deployz-application'` (consumed by
 * `packages/cdk/test/golden-path-e2e.test.ts` and `integration-harness.test.ts`
 * via `packages/cdk/src/integration/runner.ts`); reconcile that with this
 * constant when `INSTALL` lands.
 */
export const DEFAULT_APPLICATION_STACK_NAME = 'deployz-app';

/**
 * Per-deployment bootstrap stack names. A fixed `deployz-bootstrap` makes
 * the second deployment into the same AWS account/region fail with "stack
 * already exists"; deriving the name from the deployment identity (plus an
 * attempt suffix on retry) keeps attempts isolated and readable.
 */
export interface BootstrapStackNameParts {
  /** Customer-facing application name — contributes the readable slug. */
  readonly appName: string;
  /** Deployment id (uuid) — the uniqueness carrier. */
  readonly deploymentId: string;
  /** Install attempt number; 0 (default) is the first attempt. */
  readonly attempt?: number;
}

function slugify(value: string, maxLength: number): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLength)
    .replace(/-+$/g, '');
}

/**
 * `deployz-bootstrap-<slug>-<shortId>` (`-r<n>` from attempt 1 on). Pure
 * and deterministic — the Quick Create URL, the `bootstrap_stack_name`
 * column, and the install page all derive the same name from the same
 * deployment row.
 */
export function bootstrapStackName(parts: BootstrapStackNameParts): string {
  const slug = slugify(parts.appName, 24);
  const shortId = parts.deploymentId.slice(0, 8).toLowerCase();
  const attempt = parts.attempt ?? 0;
  return [
    'deployz-bootstrap',
    ...(slug !== '' ? [slug] : []),
    shortId,
    ...(attempt > 0 ? [`r${attempt}`] : []),
  ].join('-');
}

/**
 * `deployz-app-<shortInstallationId>` — unique per attempt without
 * control-plane state, because the installation identifier is minted per
 * bootstrap stack. Falls back to the fixed default when no installation
 * identifier is known (tests, pre-enrollment).
 */
export function applicationStackNameForInstallation(installationId: string): string {
  const short = installationId.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8);
  return short !== '' ? `deployz-app-${short}` : DEFAULT_APPLICATION_STACK_NAME;
}

/**
 * Final path segment (S3 object key suffix) of the published application
 * template — the one the bootstrap stack bakes into the relay as
 * `DEPLOYZ_APPLICATION_TEMPLATE_URL`.
 *
 * Shared between the publisher (which writes the object under this name) and
 * the relay (which recognizes it to derive the Redis variant's URL), so the
 * two cannot drift apart.
 */
export const APPLICATION_TEMPLATE_KEY = 'application-template-v1.json';

/**
 * Final path segment of the Redis-enabled application template variant —
 * synthesized from the same stack code with `redisRequired: true`, published
 * alongside the base template under the same key prefix.
 */
export const APPLICATION_TEMPLATE_REDIS_KEY = 'application-template-redis-v1.json';

/**
 * Derives the Redis-enabled template variant's URL from the base application
 * template URL the relay is configured with.
 *
 * Returns `undefined` when the base URL does not end in
 * `APPLICATION_TEMPLATE_KEY` — the caller must treat that as "no Redis
 * variant is known to exist", not guess a URL CloudFormation cannot fetch.
 * Pure string derivation (no network): the two templates are always
 * published side by side under the same key prefix.
 */
export function redisApplicationTemplateUrl(baseTemplateUrl: string): string | undefined {
  if (!baseTemplateUrl.endsWith(APPLICATION_TEMPLATE_KEY)) return undefined;
  return (
    baseTemplateUrl.slice(0, baseTemplateUrl.length - APPLICATION_TEMPLATE_KEY.length) +
    APPLICATION_TEMPLATE_REDIS_KEY
  );
}

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

// ---------------------------------------------------------------------------
// Documenso application preset.
// ---------------------------------------------------------------------------

/**
 * CloudFormation parameter logical ids for Documenso runtime config in the
 * published application template. The API install-parameters builder and the
 * CDK Documenso preset must use the same names — CloudFormation rejects a
 * CreateStack call that names a parameter the template does not declare.
 */
export const DOCUMENSO_PARAMETERS = {
  publicUrl: 'paramPublicUrl',
  nextauthSecret: 'paramNextauthSecret',
  encryptionKey: 'paramEncryptionKey',
  encryptionSecondaryKey: 'paramEncryptionSecondaryKey',
  smtpTransport: 'paramSmtpTransport',
  smtpHost: 'paramSmtpHost',
  smtpPort: 'paramSmtpPort',
  smtpUsername: 'paramSmtpUsername',
  smtpPassword: 'paramSmtpPassword',
  smtpFromAddress: 'paramSmtpFromAddress',
  smtpFromName: 'paramSmtpFromName',
} as const;
