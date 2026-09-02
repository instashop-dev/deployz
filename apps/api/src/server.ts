import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { setupFastifyErrorHandler } from '@sentry/node';
import { fromNodeHeaders } from 'better-auth/node';
import { and, desc, eq, inArray, isNull, ne, notInArray } from 'drizzle-orm';
import Fastify, {
  type FastifyBaseLogger,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from 'fastify';
import { z } from 'zod';

import {
  FIX_INSTRUCTIONS_TIMEOUT_MS,
  createAiGateway,
  evaluateManifestReadiness,
  generateFixInstructions,
  normalizeDeploymentManifest,
  normalizeErrorText,
  redactSecrets,
  type AiGateway,
  type PassedCheck,
  type ReadinessFinding,
  type ReadinessState,
  type StructuredEvent,
} from '@deployz/analysis';
import {
  DESTROY_PENDING_STALE_AFTER_MS,
  DOCUMENSO_PARAMETERS,
  REGION_LABELS,
  RELAY_STALE_AFTER_MS,
  SUPPORTED_AWS_REGIONS,
  aggregateInfrastructureComponents,
  bootstrapStackName,
  buildBootstrapQuickCreateUrl,
  deploymentStateAfterFailedJob,
  failureCodeSchema,
  healthComponentsSchema,
  healthStatusSchema,
  httpProbeSchema,
  infrastructureResponseSchema,
  regionSchema,
  relayCapabilitiesSchema,
  relayCommandProgressSchema,
  resolveBootstrapTemplate,
  type InfrastructureComponentStatus,
  type InfrastructureSummaryStatus,
  type VendorStackEvent,
} from '@deployz/contracts';
import { FAILURE_REMEDIATION, failureRecoverability, type FailureCode } from '@deployz/copy-map';
// Deep import so the Lambda bundle never touches @deployz/db's package root:
// the root re-exports client.ts, whose PGlite dev fallback is external in the
// Lambda bundle and crashes cold start with Runtime.ImportModuleError.
import {
  persistDeploymentResourceSnapshot,
  type ObservedStackResource,
} from '@deployz/db/deployment-resources-persist';
import type { RuntimeDb } from '@deployz/db';
import * as schema from '@deployz/db/schema';

import type { Auth } from './auth.js';
import { resolveExplanation } from './ai-explanation.js';
import { createFixtureAiGateway } from './ai-fixture.js';
import {
  createAnalysisRunner,
  readVendorOverrides,
  type AnalysisRunner,
  type AttentionCheck,
  type ReadyCheck,
  type UnsupportedCheck,
} from './analysis.js';
import { buildFixInstructionsContext, readReadinessReport } from './fix-instructions.js';
import {
  createCheckoutSession,
  createStripe,
  handleWebhookEvent,
  constructWebhookEvent,
  isBillable,
  BASE_PRICE_CENTS,
  METERED_PRICE_CENTS,
} from './billing.js';
import {
  createConfigStore,
  createRelaySecretWriter,
  getConfig,
  SECRET_MASK,
  setConfig,
  setConfigBodySchema,
} from './config.js';
import { env } from './env.js';
import { ApiError, NotFoundError, UnauthorizedError, toErrorEnvelope } from './errors.js';
import {
  createAppJwt,
  createGithubStore,
  fetchInstallationAccount,
  handleInstallationWebhook,
  listInstallations,
  listRepositories,
  mintInstallationToken,
  verifyWebhookSignature,
  type FetchFn,
  type GithubWebhookEvent,
} from './github.js';
import { createEmailSender, type EmailSender } from './email.js';
import type { EcrClient } from './ecr-grants.js';
import {
  createEcrPullGrantDeps,
  grantPullToCustomer,
  revokePullFromCustomer,
  type EcrPullGrantDeps,
} from './ecr-pull-grants.js';
import { refineFailureCode } from './failure-classification.js';
import { buildInstallParameters, readRedisRequired } from './install-parameters.js';
import { createOrReuseJob, newerReadyReleaseExists } from './jobs.js';
import { applicationToManifestOverrides, readStoredManifest, requireReadyManifest } from './manifest.js';
import { enqueue } from './queue.js';
import {
  acceptInvitation,
  activateOrganization,
  createInvitation,
  createOrganization,
  createOrganizationBodySchema,
  deleteAccount,
  deleteAccountBodySchema,
  deleteOrganization,
  deleteOrganizationBodySchema,
  inviteMemberBodySchema,
  getPublicInvitation,
  leaveOrganization,
  listInvitations,
  listInvitationsForEmail,
  listMembers,
  listOrganizations,
  rejectInvitation,
  removeMember,
  resendInvitation,
  revokeInvitation,
  transferOwnership,
  transferOwnershipBodySchema,
  updateMemberRole,
  updateMemberRoleBodySchema,
  updateOrganization,
  updateOrganizationBodySchema,
  type Actor,
  type OrganizationDeps,
} from './organizations.js';
import { recordEvent, type DeploymentEventType } from './events.js';
import { createFixtureDomainCheckDeps, createRealDomainCheckDeps, type DomainCheckDeps } from './domain-check.js';
import {
  applyDomainJobResult,
  createCustomDomain,
  findActiveDomain,
  isDomainJobType,
  removeCustomDomain,
  runDomainCheck,
  toDomainView,
  type CustomDomainRow,
} from './domains.js';
import {
  deriveDeploymentStatus,
  mergeComponentState,
  toCustomerDeploymentStatus,
  toVendorDeploymentStatus,
} from './deployment-status.js';
import {
  albEndpointFromResult,
  resolveAppUrl,
  toFleetRow,
  type DeploymentJobRow,
  type DeploymentRow,
} from './fleet-row.js';
import { advanceStepTimings } from './step-timings.js';
import {
  hashRelayToken,
  mintEnrollmentCode,
  verifyRelayToken,
  verifyRelayTokenWithRotation,
} from './relay-store.js';
import { summarizeStackEvents, type StoredStackEvent } from './stack-event-progress.js';
import { createRequireAuth, requireRole, type OrganizationRow } from './require-auth.js';
import { createRequireTeamAdmin, isTeamAdmin } from './admin/auth.js';
import { registerAdminRoutes } from './admin/routes.js';

export interface ServerDeps {
  auth: Auth;
  db: RuntimeDb;
  // Injectable GitHub seams for tests (the real values come from env). The
  // webhook secret is required to verify signatures; fixtureMode flips the
  // repo/installations routes to the fixture store.
  githubWebhookSecret?: string | undefined;
  githubFixtureMode?: boolean | undefined;
  // The App install URL offered by the "Connect GitHub" empty state. An empty
  // string means "not configured" (same as the webhook secret), which is what
  // lets a test assert the unconfigured screen on a machine that has a .env.
  githubAppInstallUrl?: string | undefined;
  // Injectable §18/§19 analysis runner for POST /:id/analyse (real
  // implementation hits GitHub; tests can supply a fake instead). Defaults
  // to analysis.ts's createAnalysisRunner wired to env/fixture GitHub deps.
  analysisRunner?: AnalysisRunner | undefined;
  // Injectable transactional-email seam (invitations, membership changes).
  // Defaults to email.ts's env-driven sender; tests supply a recorder.
  emailSender?: EmailSender | undefined;
  // Injectable fetch for the GitHub App calls (token minting, installation
  // lookup). Defaults to global fetch; tests supply a stub so no request
  // ever leaves the machine.
  githubFetch?: FetchFn | undefined;
  // The App's own credentials. Default to env; injectable so the App routes
  // are testable on a machine (or a CI runner) with no .env.
  githubAppId?: string | undefined;
  githubAppPrivateKey?: string | undefined;
  // Injectable logger, so a test can read back what a failing request
  // reported. Production uses the default below.
  loggerInstance?: FastifyBaseLogger | undefined;
  // Injectable §16/§29 AI gateway for diagnostic explanations. Defaults to the
  // env-configured Cloudflare AI Gateway, which degrades to a throwing stub
  // when unconfigured so diagnostics fall back to deterministic remediation.
  aiGateway?: AiGateway | undefined;
  // Injectable custom-domains MVP DNS/HTTPS-probe seam (runDomainCheck).
  // Defaults to env.domainFixtureMode's real-vs-fixture split; tests inject a
  // fake so no real DNS lookup or HTTPS probe ever leaves the machine.
  domainCheckDeps?: DomainCheckDeps | undefined;
  // Injectable Team Admin identity (docs/admin/team-admin.md). Defaults to
  // env; tests override to enable env-grants without a Lambda-shaped env.
  teamAdminEmails?: string[] | undefined;
  teamAdminEnvGrantsEnabled?: boolean | undefined;
  // Injectable ECR repository-policy seam for the Phase 1.1 install-grant /
  // destroy-revoke lifecycle. Defaults to the real SDK client; tests inject a
  // recorder so no ECR call ever leaves the machine.
  ecrClient?: EcrClient | undefined;
}

// §48 billing-summary line amounts, in whole dollars. Derived from the
// canonical cent constants so the summary can never drift from what Stripe
// is actually charging.
const BASE_PRICE_DOLLARS = BASE_PRICE_CENTS / 100;
const METERED_PRICE_DOLLARS = METERED_PRICE_CENTS / 100;

// application/deployment/release ids are uuid-keyed columns. A non-uuid id
// would raise a Postgres "invalid input syntax for type uuid" error and
// surface as a 500, so non-uuid ids map to 404 instead.
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Route-level rate limit for the three unauthenticated /api/install/:id
// routes (registered with @fastify/rate-limit's `global: false` above, so
// nothing else is capped by default). Keyed by IP (trustProxy makes that the
// real client behind the Lightsail balancer); 300/min is an order of
// magnitude over the install page's 5s poll cadence (12/min) — several tabs,
// "Check now" clicks, and NAT'd offices all fit — while still bounding an
// anonymous caller who has nothing but a guessable-length uuid to try.
const PUBLIC_INSTALL_RATE_LIMIT = { max: 300, timeWindow: '1 minute' } as const;

// The §35 contract fields the analyser auto-detects and the vendor can take
// ownership of by editing them (see PATCH /api/applications/:id). `name` is
// not one — the analyser never writes it.
const CONTRACT_FIELDS = [
  'containerPort',
  'healthPath',
  'migrationCommand',
  'workerCommand',
  'databaseRequired',
  'storageRequired',
  'redisRequired',
] as const;

/**
 * The manifest-only vendor overrides (Phase 2) — no applications column backs
 * them, so they live on `detected_metadata.manifestOverrides` instead of being
 * recorded as claimed column fields. `redisRequired` IS column-backed and stays
 * in CONTRACT_FIELDS above.
 */
const MANIFEST_OVERRIDE_FIELDS = [
  'appRoot',
  'dockerfilePath',
  'buildContext',
  'buildCommand',
  'startCommand',
] as const;

function requireUuidId(id: string): void {
  if (!UUID_PATTERN.test(id)) {
    throw new NotFoundError('Resource not found');
  }
}

/**
 * Reject a malformed uuid in a QUERY parameter with a 400, not a 404: an
 * absent filter is legitimate, a malformed one is a bad request. Unchecked,
 * the value reached the uuid column and Postgres raised, which surfaced as a
 * bare 500 with no error envelope.
 */
function requireUuidQueryParam(value: string | undefined, field: string): void {
  if (value !== undefined && !UUID_PATTERN.test(value)) {
    throw new ApiError(400, 'VALIDATION_ERROR', `${field} must be a valid identifier.`);
  }
}

// Resolves the organization id from the AUTHENTICATED SESSION ONLY (§S1: the
// client can never assert its own org). Earlier this also accepted an
// `organizationId` query param, which let any signed-in user read another
// org's data by passing `?organizationId=<other-org>` — that fallback is
// gone; the session's active organization is the sole source of truth.
function organizationIdFromRequest(request: { organization?: { id: string } | undefined }): string {
  return request.organization?.id ?? '';
}

/** Session org, or 401 when the request has none. Every authed route needs this. */
function requireSessionOrganizationId(request: { organization?: { id: string } | undefined }): string {
  const organizationId = organizationIdFromRequest(request);
  if (!organizationId) {
    throw new ApiError(401, 'UNAUTHORIZED', 'An organization is required');
  }
  return organizationId;
}

/** Session organization row, or 401 when the request has none. */
function requireSessionOrganization(request: FastifyRequest): OrganizationRow {
  const organization = request.organization;
  if (!organization) {
    throw new ApiError(401, 'UNAUTHORIZED', 'An organization is required');
  }
  return organization;
}

/** The signed-in user as an audit/email actor. */
function requireActor(request: FastifyRequest): Actor {
  const user = request.user;
  if (!user) {
    throw new UnauthorizedError();
  }
  return { id: user.id, name: user.name, email: user.email };
}

/** The caller's session row id — the tenant pointer writes target it. */
function requireSessionId(request: FastifyRequest): string {
  const sessionId = request.sessionId;
  if (!sessionId) {
    throw new UnauthorizedError();
  }
  return sessionId;
}

/**
 * Resolves the org to write into a create body: always the session org.
 * Some clients may still send a body `organizationId` (legacy payload
 * shape) — if they do, and it disagrees with the session, that is either a
 * bug or an attempted cross-org write, so it is rejected outright rather
 * than silently overridden.
 */
function resolveWriteOrganizationId(
  request: { organization?: { id: string } | undefined },
  bodyOrganizationId: string | undefined,
): string {
  const organizationId = requireSessionOrganizationId(request);
  if (bodyOrganizationId !== undefined && bodyOrganizationId !== organizationId) {
    throw new ApiError(
      403,
      'ORGANIZATION_MISMATCH',
      'organizationId does not match the authenticated session organization',
    );
  }
  return organizationId;
}

function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

// ── Ownership-scoped loaders (IDOR guards) ──────────────────────────────────
//
// Every :id route below MUST resolve its resource through one of these
// instead of a bare `where(eq(table.id, id))` lookup — an id-only lookup lets
// any authenticated user reach any org's rows just by knowing (or guessing)
// a UUID. On a mismatch these throw NotFoundError (404), not 403: whether the
// resource exists at all must not leak to a caller who cannot see it.

type ApplicationRow = typeof schema.applications.$inferSelect;
type CustomerRow = typeof schema.customers.$inferSelect;
type JobType = (typeof schema.deploymentJobs.$inferSelect)['type'];

async function loadOwnedApplication(
  db: RuntimeDb,
  id: string,
  organizationId: string,
): Promise<ApplicationRow> {
  requireUuidId(id);
  const rows = await db
    .select()
    .from(schema.applications)
    .where(and(eq(schema.applications.id, id), eq(schema.applications.organizationId, organizationId)))
    .limit(1);
  if (rows.length === 0) {
    throw new NotFoundError('Application not found');
  }
  return rows[0]!;
}

async function loadOwnedDeployment(
  db: RuntimeDb,
  id: string,
  organizationId: string,
): Promise<DeploymentRow> {
  requireUuidId(id);
  const rows = await db
    .select()
    .from(schema.deployments)
    .where(and(eq(schema.deployments.id, id), eq(schema.deployments.organizationId, organizationId)))
    .limit(1);
  if (rows.length === 0) {
    throw new NotFoundError('Deployment not found');
  }
  return rows[0]!;
}

async function loadOwnedCustomer(
  db: RuntimeDb,
  id: string,
  organizationId: string,
): Promise<CustomerRow> {
  requireUuidId(id);
  const rows = await db
    .select()
    .from(schema.customers)
    .where(and(eq(schema.customers.id, id), eq(schema.customers.organizationId, organizationId)))
    .limit(1);
  if (rows.length === 0) {
    throw new NotFoundError('Customer not found');
  }
  return rows[0]!;
}

/**
 * Resolve the config scope from a request's customer id: an absent/empty id
 * is the vendor scope, otherwise the customer is loaded to get its NAME.
 * The config screen names the customer — a raw customer id is an internal
 * identifier that means nothing to the vendor (§65) — and loading it here
 * also keeps the scope org-owned: a customer of another organization 404s.
 */
async function resolveConfigScope(
  db: RuntimeDb,
  customerId: string | null | undefined,
  organizationId: string,
): Promise<{ customerId: string | null; customerName: string | null }> {
  if (customerId === null || customerId === undefined || customerId.length === 0) {
    return { customerId: null, customerName: null };
  }
  const customer = await loadOwnedCustomer(db, customerId, organizationId);
  return { customerId: customer.id, customerName: customer.name };
}

/**
 * The deploy/rollback payload contract — everything the relay needs to roll
 * an immutable image out, derived SERVER-side from the READY release. The
 * browser only ever names a releaseId; repository and digest are never
 * client-supplied.
 */
interface DeployPayload {
  releaseId: string;
  version: string;
  imageRepository: string;
  imageDigest: string;
  /** Present only when a migration command resolves — see requireDeployableRelease. */
  migrationCommand?: string;
  [key: string]: unknown;
}

// BUILD_FIXTURE_MODE: a deterministic fake `repository@sha256:…` digest so
// the E2E lifecycle scenarios can drive deploy/rollback without a live
// CodeBuild/ECR — same shape any real IMAGE_DIGEST has (see the regex below).
// Reuses hashRelayToken's sha256-hex helper rather than adding a new one;
// different release ids (one per version) hash to different digests.
const FIXTURE_IMAGE_REPOSITORY = '123456789012.dkr.ecr.us-east-1.amazonaws.com/deployz-fixture';
function fixtureImageDigest(releaseId: string): string {
  return `${FIXTURE_IMAGE_REPOSITORY}@sha256:${hashRelayToken(releaseId)}`;
}

async function requireDeployableRelease(
  db: RuntimeDb,
  releaseId: string,
  applicationId: string,
  deployment?: DeploymentRow,
): Promise<DeployPayload> {
  requireUuidId(releaseId);
  const rows = await db
    .select()
    .from(schema.releases)
    .where(and(eq(schema.releases.id, releaseId), eq(schema.releases.applicationId, applicationId)))
    .limit(1);
  const release = rows[0];
  if (!release) {
    throw new NotFoundError('Release not found');
  }
  // The image digest arrives from CodeBuild in RepoDigests form
  // (`repository@sha256:…`); the wire contract wants the two parts apart,
  // with the digest matching the strict immutable form.
  const at = release.imageDigest?.lastIndexOf('@') ?? -1;
  const imageRepository = at > 0 ? release.imageDigest!.slice(0, at) : null;
  const imageDigest = at > 0 ? release.imageDigest!.slice(at + 1) : null;
  if (
    release.releaseStatus !== 'READY' ||
    imageRepository === null ||
    imageDigest === null ||
    !/^sha256:[0-9a-f]{64}$/.test(imageDigest)
  ) {
    throw new ApiError(
      409,
      'RELEASE_NOT_READY',
      `Version ${release.version} has no deployable image yet. Wait for the build to finish or pick another release.`,
    );
  }
  const payload: DeployPayload = {
    releaseId: release.id,
    version: release.version,
    imageRepository,
    imageDigest,
  };
  // Phase 4: the migration command, stored-manifest first (the canonical
  // snapshot the deployment was created with), else the release's own
  // override. Absent → the key is omitted so a no-migration deploy carries
  // byte-for-byte the payload it always did. A bulk deploy resolves the
  // manifest half per target (each target has its own stored manifest).
  const manifestCommand = deployment ? (readStoredManifest(deployment.desiredState)?.migration.command ?? null) : null;
  const migrationCommand = manifestCommand ?? release.migrationCommand ?? null;
  if (migrationCommand !== null && migrationCommand.trim().length > 0) {
    payload.migrationCommand = migrationCommand.trim();
  }
  return payload;
}

/**
 * One mutating operation per deployment: before creating any mutating job,
 * refuse if another is still active. Concurrency here means two executors
 * racing the same ECS service/stack, with no honest way to report either
 * outcome. A retry of the SAME command (same idempotency key) is not
 * concurrency — it reuses its existing job.
 */
async function requireDeploymentIdle(
  db: RuntimeDb,
  deploymentId: string,
  sameKeyIdempotencyKey?: string,
): Promise<void> {
  const active = await db
    .select({ id: schema.deploymentJobs.id })
    .from(schema.deploymentJobs)
    .where(
      and(
        eq(schema.deploymentJobs.deploymentId, deploymentId),
        inArray(schema.deploymentJobs.state, ['REQUESTED', 'QUEUED', 'WAITING', 'RUNNING']),
        inArray(schema.deploymentJobs.type, [
          'INSTALL',
          'DEPLOY_RELEASE',
          'ROLLBACK',
          'RESTART',
          'CONFIG_UPDATE',
          'DESTROY',
          'MIGRATION',
          'INFRA_UPGRADE',
        ]),
        ...(sameKeyIdempotencyKey
          ? [ne(schema.deploymentJobs.idempotencyKey, sameKeyIdempotencyKey)]
          : []),
      ),
    )
    .limit(1);
  if (active.length > 0) {
    throw new ApiError(
      409,
      'DEPLOYMENT_BUSY',
      'Another deployment operation is already in progress.',
    );
  }
}

/**
 * Derived idempotency key that a FAILED prior attempt does not poison. The
 * fixed derived keys exist to absorb double-clicks and replays, but
 * createOrReuseJob hands the same row back regardless of state — so once an
 * attempt failed, every later user-initiated retry silently received the
 * dead job and nothing ran (observed live on a deploy retry). When the
 * newest attempt under this base key is FAILED, mint an attempt-scoped key;
 * otherwise the base key keeps its replay-absorbing behavior.
 */
async function retryAwareIdempotencyKey(
  db: RuntimeDb,
  deploymentId: string,
  type: JobType,
  baseKey: string,
): Promise<string> {
  const attempts = (
    await db
      .select({
        state: schema.deploymentJobs.state,
        idempotencyKey: schema.deploymentJobs.idempotencyKey,
        createdAt: schema.deploymentJobs.createdAt,
      })
      .from(schema.deploymentJobs)
      .where(
        and(
          eq(schema.deploymentJobs.deploymentId, deploymentId),
          eq(schema.deploymentJobs.type, type),
        ),
      )
  ).filter(
    (job) => job.idempotencyKey === baseKey || job.idempotencyKey.startsWith(`${baseKey}:RETRY:`),
  );
  const newest = attempts.sort(
    (a, b) =>
      b.createdAt.getTime() - a.createdAt.getTime() ||
      b.idempotencyKey.localeCompare(a.idempotencyKey),
  )[0];
  return newest?.state === 'FAILED' ? `${baseKey}:RETRY:${attempts.length}` : baseKey;
}

// maskAwsAccountId/toFleetRow live in ./fleet-row.js — shared with Team
// Admin's cross-tenant deployment queries (apps/api/src/admin/queries.ts)
// without admin code importing this file (which registers admin routes).


// §19 semantic readiness derivation. Analyses persist the full semantic
// report on `applications.detected_metadata.readiness` (analysis.ts) — this
// puts it on the wire, adding the state derived from `analysisStatus`
// (ANALYSIS_INCOMPLETE while pending/failed — never a fabricated result).
// Rows analysed before the report existed degrade into equivalent findings
// built from the legacy `checks` shape. No percentages, ever.

/** The `GET /api/applications/:id/readiness` wire shape. */
interface ReadinessResponse {
  analysisStatus: string;
  state: ReadinessState;
  requiredCount: number;
  recommendedCount: number;
  /** One short explanation of the state. Null while analysis is incomplete. */
  summary: string | null;
  /** Why a FAILED analysis failed. Null in every other state. */
  failureReason: string | null;
  findings: ReadinessFinding[];
  passed: PassedCheck[];
  /** The commit the analysis ran against, when known. */
  analyzedCommitSha: string | null;
}

/** Legacy-row bridge: rebuild findings from the pre-report `checks` shape. */
function legacyReadiness(app: {
  compatibilityStatus: string | null;
  compatibilityReason: string | null;
  detectedMetadata: Record<string, unknown> | null;
}): Pick<ReadinessResponse, 'state' | 'requiredCount' | 'recommendedCount' | 'summary' | 'findings' | 'passed'> {
  const rawChecks = app.detectedMetadata?.checks as
    | { ready?: ReadyCheck[]; needsAttention?: AttentionCheck[]; unsupported?: UnsupportedCheck[] }
    | undefined;

  const toFinding = (
    entry: { title: string; detail?: string; reason?: string; suggestedFix?: string | null },
    blocking: boolean,
    index: number,
  ): ReadinessFinding => ({
    id: `legacy-${blocking ? 'blocking' : 'required'}-${index}`,
    category: 'legacy',
    title: entry.title,
    severity: 'required',
    blocking,
    plainEnglishExplanation: entry.detail ?? entry.reason ?? entry.title,
    whyItMatters: '',
    technicalEvidence: entry.detail ?? entry.reason ?? '',
    suggestedOutcome: entry.suggestedFix ?? '',
    confidence: 'confirmed',
  });

  const unsupported = (rawChecks?.unsupported ?? []).map((entry, i) => toFinding(entry, true, i));
  const attention = (rawChecks?.needsAttention ?? []).map((entry, i) => toFinding(entry, false, i));
  const findings = [...unsupported, ...attention];
  // A COMPLETE row with no verdict at all is treated like NEEDS_ATTENTION
  // (the old endpoint's fallback) — never READY by omission.
  const state: ReadinessState =
    app.compatibilityStatus === 'NOT_COMPATIBLE'
      ? 'NEEDS_CHANGES'
      : app.compatibilityStatus === 'READY'
        ? 'READY'
        : 'ALMOST_READY';

  return {
    state,
    requiredCount: findings.length,
    recommendedCount: 0,
    summary: app.compatibilityReason,
    findings,
    passed: (rawChecks?.ready ?? []).map((entry, i) => ({ id: `legacy-passed-${i}`, label: entry.label })),
  };
}

function computeReadiness(app: {
  analysisStatus: string;
  compatibilityStatus: string | null;
  compatibilityReason: string | null;
  detectedMetadata: Record<string, unknown> | null;
}): ReadinessResponse {
  if (app.analysisStatus !== 'COMPLETE') {
    return {
      analysisStatus: app.analysisStatus,
      state: 'ANALYSIS_INCOMPLETE',
      requiredCount: 0,
      recommendedCount: 0,
      summary: null,
      // A FAILED analysis used to look exactly like a still-running one on
      // the wire, so the page showed "Analysing your app" for ever and
      // Re-analyse appeared to do nothing. The reason is on the row either
      // way (analysis.ts persists it) — it just was never sent.
      failureReason: app.analysisStatus === 'FAILED' ? app.compatibilityReason : null,
      findings: [],
      passed: [],
      analyzedCommitSha: null,
    };
  }

  const analyzedCommitSha =
    typeof app.detectedMetadata?.['analysisCommitSha'] === 'string'
      ? (app.detectedMetadata['analysisCommitSha'] as string)
      : null;
  const report = readReadinessReport(app.detectedMetadata);
  const body = report
    ? {
        state: report.state as ReadinessState,
        requiredCount: report.requiredCount,
        recommendedCount: report.recommendedCount,
        summary: report.summary,
        findings: report.findings,
        passed: report.passed,
      }
    : legacyReadiness(app);

  return {
    analysisStatus: app.analysisStatus,
    ...body,
    failureReason: null,
    analyzedCommitSha,
  };
}

// §25 "deploy to all compatible customers" — deployable means the fleet
// member is in a state where a new release can be rolled out. Deployments
// that are still installing, mid-transition, or gone are skipped rather than
// silently targeted.
const BULK_DEPLOYABLE_STATES = new Set<DeploymentRow['state']>(['HEALTHY', 'UPDATE_AVAILABLE']);

// States where a deploy or rollback has nothing to act on: no relay has ever
// enrolled, or the deployment is gone. Wider than BULK_DEPLOYABLE_STATES on
// purpose — that set answers "which customers does a fan-out include", while
// this one answers "can this one deployment be deployed at all", so an
// in-flight UPDATING retry still reaches the idempotent job path.
const UNDEPLOYABLE_STATES = new Set<DeploymentRow['state']>([
  'NOT_INSTALLED',
  'WAITING_FOR_RELAY',
  'DELETING',
  'DELETED',
]);

// An in-flight INSTALL older than this is dead: the relay polls every 5
// minutes and a single executor pass fits well inside it, so six missed
// cycles mean the invocation is never coming back (crashed Lambda, expired
// container). Only then may retry-install supersede the job.
const INSTALL_JOB_STALE_AFTER_MS = 30 * 60 * 1000;

// §9.4 force-complete on a LIVE relay: how many consecutive FAILED DESTROY
// jobs must accumulate before the escape hatch opens even though the relay
// still reads online. One failure is retryable by the vendor; two failures
// on a connected relay mean the delete itself is wedged.
const REPEATED_DESTROY_FAILURES_REQUIRED = 2;

/** 409s a deploy/rollback/restart aimed at a deployment that has nothing to
 *  deploy into — the single-deployment mirror of the skip reason deploy-bulk
 *  gives. A FAILED deployment that never completed a first successful
 *  INSTALL is still effectively uninstalled: there is no relay-managed
 *  infrastructure for these commands to act on, only retry-install (and
 *  destroy) may touch it. The same check retry-install itself uses. */
async function requireDeployableState(db: RuntimeDb, deployment: DeploymentRow): Promise<void> {
  if (UNDEPLOYABLE_STATES.has(deployment.state)) {
    throw new ApiError(
      409,
      'DEPLOYMENT_NOT_DEPLOYABLE',
      `Deployment is ${deployment.state}, not deployable`,
    );
  }
  if (deployment.state === 'FAILED' && !(await hasSucceededInstall(db, deployment.id))) {
    throw new ApiError(
      409,
      'DEPLOYMENT_NOT_DEPLOYABLE',
      'This deployment never completed its first install; use Retry install instead.',
    );
  }
  // §9.5 relay-liveness gates, mirroring retry-install's refusals: a job
  // queued for a relay that is not (or no longer) connected would sit
  // REQUESTED until the watchdog fails it an hour later, which the vendor
  // just watched happen. The fix for a dead relay is re-enrollment
  // (relay/reset), not another doomed job — refuse so the UI points there.
  if (!deployment.installationId) {
    throw new ApiError(
      409,
      'RELAY_NOT_CONNECTED',
      'No relay is connected to this deployment. Reconnect it before deploying.',
    );
  }
  if (deployment.relayStatus === 'DISCONNECTED') {
    throw new ApiError(
      409,
      'RELAY_DISCONNECTED',
      'The relay for this deployment is disconnected. Reconnect it before deploying.',
    );
  }
}

/** Whether the deployment's most recent job is a DESTROY. */
async function latestJobIsDestroy(db: RuntimeDb, deploymentId: string): Promise<boolean> {
  const [latest] = await db
    .select({ type: schema.deploymentJobs.type })
    .from(schema.deploymentJobs)
    .where(eq(schema.deploymentJobs.deploymentId, deploymentId))
    .orderBy(desc(schema.deploymentJobs.createdAt))
    .limit(1);
  return latest?.type === 'DESTROY';
}

/** Whether any INSTALL job for this deployment ever finished successfully. */
async function hasSucceededInstall(db: RuntimeDb, deploymentId: string): Promise<boolean> {
  const installJobs = await db
    .select({ state: schema.deploymentJobs.state })
    .from(schema.deploymentJobs)
    .where(
      and(
        eq(schema.deploymentJobs.deploymentId, deploymentId),
        eq(schema.deploymentJobs.type, 'INSTALL'),
      ),
    );
  return installJobs.some((j) => j.state === 'SUCCEEDED' || j.state === 'SUCCESS');
}

// resolveAppUrl now lives in ./fleet-row.js, alongside toFleetRow.

/** The health path the application template checks by default. */
const DEFAULT_HEALTH_PATH = '/health';

/**
 * §10.2 the URL the relay probes once per poll: the latest successful
 * INSTALL's ALB endpoint plus the application's configured health path. The
 * control plane knows both (the stack's outputs and the manifest-derived
 * path) and hands the full URL to the relay in each poll's deployment meta,
 * so the relay never has to resolve either inside the customer account. Null
 * until an INSTALL produced an endpoint — the relay then omits the probe.
 * `jobs` must be ascending by createdAt.
 */
function resolveProbeUrl(
  jobs: ReadonlyArray<Pick<DeploymentJobRow, 'type' | 'state' | 'result'>>,
  healthPath: string | null,
): string | null {
  const installs = jobs.filter(
    (j) => j.type === 'INSTALL' && (j.state === 'SUCCEEDED' || j.state === 'SUCCESS'),
  );
  const endpoint = albEndpointFromResult(installs[installs.length - 1]?.result ?? null);
  if (!endpoint) return null;
  const base = endpoint.startsWith('http://') || endpoint.startsWith('https://')
    ? endpoint.replace(/\/+$/, '')
    : `http://${endpoint.replace(/\/+$/, '')}`;
  const trimmed = healthPath?.trim() ?? '';
  const path = trimmed.length > 0 ? trimmed : DEFAULT_HEALTH_PATH;
  return `${base}${path.startsWith('/') ? path : `/${path}`}`;
}

/**
 * Step-timings follow-up shared by both relay-authenticated write paths
 * (POST /api/relay/health and the job-result handler below): re-derive the
 * deployment's status from the values THEY just wrote (not the stale
 * pre-transaction row — deriveDeploymentStatus is read-time, so a stale row
 * would compute yesterday's step), advance the persisted `step_timings`
 * against it, and record one `deployment.step_completed` event per step that
 * newly finished.
 *
 * Best-effort by design, same idiom as reconcileRunningDigest's call site
 * below: a relay heartbeat or job result must never fail because this
 * observational side channel had a bad day. Callers wrap this in try/catch
 * and log rather than propagate.
 *
 * `knownDomain` lets a caller that already looked up the active domain this
 * request (the health handler does, further down, for its own DNS
 * auto-check) hand it over instead of paying for a second identical query;
 * omit it and this fetches its own.
 */
async function advanceStepTimingsAfterWrite(
  db: RuntimeDb,
  freshDeployment: DeploymentRow,
  knownDomain?: CustomDomainRow | null,
): Promise<void> {
  const applicationRows = await db
    .select({
      databaseRequired: schema.applications.databaseRequired,
      storageRequired: schema.applications.storageRequired,
      redisRequired: schema.applications.redisRequired,
      migrationCommand: schema.applications.migrationCommand,
    })
    .from(schema.applications)
    .where(eq(schema.applications.id, freshDeployment.applicationId))
    .limit(1);
  const application = applicationRows[0] ?? {};

  const jobs = await db
    .select()
    .from(schema.deploymentJobs)
    .where(eq(schema.deploymentJobs.deploymentId, freshDeployment.id))
    .orderBy(schema.deploymentJobs.createdAt);
  const domain = knownDomain !== undefined ? knownDomain : await findActiveDomain(db, freshDeployment.id);
  const appUrl = resolveAppUrl(jobs, domain);

  const derived = deriveDeploymentStatus({ deployment: freshDeployment, application, jobs, domain, appUrl });
  const { next, changed, completedSteps } = advanceStepTimings(freshDeployment.stepTimings, derived, new Date());
  if (!changed) return;

  await db.transaction(async (tx) => {
    await tx
      .update(schema.deployments)
      .set({ stepTimings: next })
      .where(eq(schema.deployments.id, freshDeployment.id));
    for (const completed of completedSteps) {
      await recordEvent(tx, {
        organizationId: freshDeployment.organizationId,
        eventType: 'deployment.step_completed',
        actorType: 'relay',
        actorId: freshDeployment.installationId ?? freshDeployment.id,
        deploymentId: freshDeployment.id,
        customerId: freshDeployment.customerId,
        payload: {
          step: completed.step,
          startedAt: completed.startedAt,
          completedAt: completed.completedAt,
          durationSeconds: completed.durationSeconds,
        },
      });
    }
  });
}

/**
 * §46 deployment state a finished job leaves behind. The relay reporting a
 * command result is what actually moves a deployment through its lifecycle —
 * without this the fleet is stuck in INSTALLING forever, which silently
 * disables §25 bulk deploy (needs HEALTHY/UPDATE_AVAILABLE), §29 diagnostics
 * (needs FAILED) and §48 metered billing (bills only HEALTHY deployments).
 *
 * Mirrors the transitions the packages/cdk job workflows already model. A job
 * type absent from this map leaves the state alone — CONFIG_UPDATE is
 * non-disruptive (§31), so a config write must not disturb the lifecycle.
 *
 * INSTALL is deliberately absent: a CloudFormation CREATE_COMPLETE does not
 * prove the application is running. The deployment stays in INSTALLING until
 * the relay's runtime health verification reports HEALTHY (see the
 * /api/relay/health handler, which advances INSTALLING → HEALTHY), so a
 * "healthy" state always means observed-healthy, never just stack-complete.
 */
const JOB_SUCCESS_STATE: Partial<Record<JobType, DeploymentRow['state']>> = {
  DEPLOY_RELEASE: 'HEALTHY',
  ROLLBACK: 'HEALTHY',
  RESTART: 'HEALTHY',
  DESTROY: 'DELETED',
};

/**
 * Job types whose SUCCESS names a release in the audit event. §10.3: these no
 * longer advance the release pointer at result time — the heartbeat's digest
 * reconciliation does, once the HTTP probe and every ECS/ALB gate pass. This
 * set now only decides which jobs carry a releaseId on their event.
 */
const RELEASE_ADVANCING_JOBS = new Set<JobType>(['DEPLOY_RELEASE', 'ROLLBACK']);

/**
 * Documenso preset parameters the control plane GENERATES at install time
 * (or that carry SMTP credentials) — their values are secrets. `redactClaimedPayload`
 * scrubs these from the INSTALL job payload once the relay has claimed it,
 * so generated install secrets do not sit in `deployment_jobs.payload`
 * indefinitely (§31 "stop storing generated install secrets unnecessarily
 * in job payloads").
 */
const INSTALL_SECRET_PARAMETER_IDS = new Set<string>([
  DOCUMENSO_PARAMETERS.nextauthSecret,
  DOCUMENSO_PARAMETERS.encryptionKey,
  DOCUMENSO_PARAMETERS.encryptionSecondaryKey,
  DOCUMENSO_PARAMETERS.smtpUsername,
  DOCUMENSO_PARAMETERS.smtpPassword,
]);

/**
 * The relay receives a command's payload exactly once, at claim time
 * (`GET /api/relay/commands`). After that response the stored row never
 * needs the plaintext again, so the claim handler scrubs it in the same
 * request that serves it:
 *  - CONFIG_UPDATE: newly-entered secret VALUES (transport-only) become
 *    key stubs — the DB keeps key names, never values.
 *  - INSTALL: generated secret parameter values become SECRET_MASK; plain
 *    parameters (publicUrl, healthPath) survive untouched.
 */
export function redactClaimedPayload(job: {
  readonly type: string;
  readonly payload: Record<string, unknown> | null;
}): Record<string, unknown> | null {
  const payload = job.payload;
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return payload;

  if (job.type === 'CONFIG_UPDATE' && Array.isArray(payload['secrets'])) {
    return {
      ...payload,
      secrets: (payload['secrets'] as { key?: unknown }[]).map((entry) => ({
        key: typeof entry.key === 'string' ? entry.key : '',
      })),
    };
  }

  if (job.type === 'INSTALL' && typeof payload['parameters'] === 'object' && payload['parameters'] !== null) {
    const parameters = payload['parameters'] as Record<string, unknown>;
    const redacted: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(parameters)) {
      redacted[key] = INSTALL_SECRET_PARAMETER_IDS.has(key) ? SECRET_MASK : value;
    }
    return { ...payload, parameters: redacted };
  }

  return payload;
}

/** §40 event type per job outcome. Job types with no vendor-visible event are absent. */
  const JOB_RESULT_EVENT: Partial<
    Record<JobType, { completed: DeploymentEventType; failed: DeploymentEventType }>
  > = {
  INSTALL: { completed: 'install.completed', failed: 'install.failed' },
  DEPLOY_RELEASE: { completed: 'deploy.completed', failed: 'deploy.failed' },
  ROLLBACK: { completed: 'rollback.completed', failed: 'rollback.failed' },
  RESTART: { completed: 'restart.completed', failed: 'restart.failed' },
  DESTROY: { completed: 'destroy.completed', failed: 'destroy.failed' },
  // Without these, a CONFIG_UPDATE result vanished: the job row held the
  // relay's error but nothing reached the activity feed (verified live).
  CONFIG_UPDATE: { completed: 'config.updated', failed: 'config.failed' },
  PURGE: { completed: 'purge.completed', failed: 'purge.failed' },
};

// Control-plane surface: /health, /api/me, /api/auth/*.
// Errors cross the boundary as structured envelopes via toErrorEnvelope;
// Sentry capture lives in its onError hook (never in the render path).
export async function buildServer({
  auth,
  db,
  githubWebhookSecret,
  githubFixtureMode,
  githubAppInstallUrl,
  analysisRunner,
  emailSender,
  ecrClient,
  githubFetch: injectedGithubFetch,
  githubAppId: injectedGithubAppId,
  githubAppPrivateKey: injectedGithubAppPrivateKey,
  aiGateway = env.aiFixtureMode ? createFixtureAiGateway() : createAiGateway(env.aiGateway),
  domainCheckDeps = env.domainFixtureMode ? createFixtureDomainCheckDeps() : createRealDomainCheckDeps(),
  teamAdminEmails = env.teamAdminEmails,
  teamAdminEnvGrantsEnabled = env.teamAdminEnvGrantsEnabled,
  loggerInstance,
}: ServerDeps): Promise<FastifyInstance> {
  // Phase 1.1: the ECR grant lifecycle. Best-effort by design — a failing
  // grant must not fail the install request that owns it (see ecr-pull-grants.ts).
  const ecrGrantDeps: EcrPullGrantDeps = createEcrPullGrantDeps(ecrClient);
  // `logger: false` meant a 500 left NO trace anywhere: not in CloudWatch, not
  // in the response (the envelope is deliberately generic), nowhere. Three
  // production failures in a row could only be diagnosed by reading
  // configuration and guessing. `warn` keeps the per-request info lines off
  // while letting the error handler below say what actually broke.
  // trustProxy: production runs behind the Lightsail container service's
  // load balancer, so request.ip is the balancer unless X-Forwarded-For is
  // honored — and the per-IP rate limit on the public install routes would
  // otherwise pool every customer into the balancer's single bucket. The
  // container is only reachable through that balancer, so the header is
  // trustworthy here.
  const app = Fastify(
    loggerInstance
      ? { loggerInstance, trustProxy: true }
      : { logger: { level: 'warn' }, trustProxy: true },
  );

  // Sentry owns capture via the onError hook this registers. Capture filter:
  // ApiError 4xx are expected client errors — not reportable; everything else
  // (5xx ApiError, unknown throws) is. Do NOT captureException in the custom
  // error handler below — that would double-report.
  setupFastifyErrorHandler(app, {
    shouldHandleError: (error) => !(error instanceof ApiError) || error.statusCode >= 500,
  });

  // Single render path for every thrown error: structured envelope, no stack
  // traces, no internal messages.
  app.setErrorHandler((error, request, reply) => {
    const { statusCode, body } = toErrorEnvelope(error);
    // The envelope a 5xx returns is generic on purpose — it must not leak
    // internals to the caller. That makes the log the ONLY place the real
    // cause survives, so write it there.
    if (statusCode >= 500) {
      request.log.error(
        { err: error, method: request.method, url: request.url, code: body.error.code },
        'request failed',
      );
    }
    return reply.code(statusCode).send(body);
  });

  // Browser origin differs by port; cookies are host-scoped, so credentialed
  // CORS + trustedOrigins is the whole cookie story. `methods` must be listed
  // explicitly: the default is GET,HEAD,POST, which fails the preflight for
  // the config PUT and the organization PATCH.
  await app.register(cors, {
    origin: [...env.webOrigins],
    credentials: true,
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  });

  // §12/§44 the three public install-link routes take no auth at all, so
  // they are the one surface an anonymous caller could hammer. `global:
  // false` means registering this plugin does nothing by itself — every
  // other route (authenticated or relay-token-authenticated) stays
  // unaffected; only the routes below that opt in with `config.rateLimit`
  // are capped. 120/min per IP is generous headroom over the install page's
  // own 5s status-poll cadence (12/min) while still bounding abuse.
  await app.register(rateLimit, { global: false });

  app.get('/health', () => ({ ok: true }));

  // Stable, minimal readiness probe for external monitors: no internal or
  // customer detail crosses this boundary — reachability is the whole answer.
  app.get('/api/health', () => ({ status: 'ok' }));

  // Webhook signature verification (Stripe + GitHub) needs the RAW body, so
  // register a raw-json parser for those routes before the JSON parser
  // consumes it. A bad signature -> 400 structured envelope.
  const stripe = createStripe();
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'string', bodyLimit: 1048576 },
    (request, body, done) => {
      const rawWebhook =
        request.raw.url?.startsWith('/api/billing/webhook') ||
        request.raw.url?.startsWith('/api/github/webhook');
      if (rawWebhook) {
        done(null, body);
        return;
      }
      try {
        done(null, JSON.parse(body as string));
      } catch (error) {
        done(error as Error);
      }
    },
  );
  app.post('/api/billing/webhook', async (request, reply) => {
    const signature = request.headers['stripe-signature'];
    const event = constructWebhookEvent(
      stripe,
      request.body as string,
      Array.isArray(signature) ? signature[0] : signature,
    );
    const handled = await handleWebhookEvent({ db, stripe }, event);
    return reply.code(200).send({ received: true, handled });
  });

  // GitHub App webhook: signature-verified via X-Hub-Signature-256 over the
  // raw body. The account->org resolver (#13) matches the GitHub login to
  // the organization slug — sufficient for the MVP since vendor orgs are
  // created with their GitHub org name as the slug.
  const githubStore = createGithubStore(db);
  const githubFetch: FetchFn = injectedGithubFetch ?? globalThis.fetch.bind(globalThis);
  const githubAppId = injectedGithubAppId ?? env.githubAppId;
  const githubAppPrivateKey = injectedGithubAppPrivateKey ?? env.githubAppPrivateKey;
  // §18/§19: real GitHub-backed analysis by default; tests inject a fake
  // via ServerDeps.analysisRunner instead of hitting GitHub.
  const runAnalysis: AnalysisRunner =
    analysisRunner ??
    createAnalysisRunner({
      db,
      fetchFn: githubFetch,
      githubAppId,
      githubAppPrivateKey,
      githubFixtureMode: githubFixtureMode ?? env.githubFixtureMode,
      aiGateway,
    });
  app.post('/api/github/webhook', async (request, reply) => {
    const webhookSecret = githubWebhookSecret ?? env.githubWebhookSecret;
    if (!webhookSecret) {
      throw new ApiError(503, 'GITHUB_DISABLED', 'GitHub App is not configured');
    }
    const signature = request.headers['x-hub-signature-256'];
    const rawBody = request.body as string;
    if (!verifyWebhookSignature(rawBody, Array.isArray(signature) ? signature[0] : signature, webhookSecret)) {
      throw new ApiError(400, 'WEBHOOK_SIGNATURE_INVALID', 'Webhook signature verification failed');
    }
    const body = JSON.parse(rawBody) as {
      action?: string | undefined;
      installation?: { id: number; account?: { login: string; type?: string } | undefined } | undefined;
      sender?: { login: string } | undefined;
    };
    const event: GithubWebhookEvent = {
      type: String(request.headers['x-github-event'] ?? ''),
      action: body.action,
      installation: body.installation,
      sender: body.sender,
    };
    const handled = await handleInstallationWebhook(githubStore, event);
    return reply.code(200).send({ received: true, handled });
  });

  const requireAuth = createRequireAuth({
    auth,
    db,
    teamAdminEmails,
    envGrantsEnabled: teamAdminEnvGrantsEnabled,
  });
  const requireTeamAdmin = createRequireTeamAdmin({
    requireAuth,
    teamAdminEmails,
    envGrantsEnabled: teamAdminEnvGrantsEnabled,
  });

  const organizationDeps: OrganizationDeps = {
    db,
    emailSender: emailSender ?? createEmailSender(),
    webUrl: env.webUrl,
  };

  app.get('/api/me', { preHandler: requireAuth }, async (request) => ({
    user: request.user ?? null,
    organization: request.organization ?? null,
    role: request.member?.role ?? null,
    organizations: request.user ? await listOrganizations(db, request.user.id) : [],
    isTeamAdmin: request.user
      ? isTeamAdmin(request.user, teamAdminEmails, teamAdminEnvGrantsEnabled)
      : false,
    supportMode:
      request.supportMode && request.organization
        ? { organizationId: request.organization.id, organizationName: request.organization.name }
        : null,
  }));

  registerAdminRoutes(app, {
    db,
    requireTeamAdmin,
    performRetryInstall,
    performRollback,
    performForceCompleteDestroy,
    performRelayReset,
  });

  // ── Organizations ───────────────────────────────────────────────

  // Every organization the caller belongs to — the tenant switcher's data.
  app.get('/api/organizations', { preHandler: requireAuth }, async (request) => ({
    organizations: await listOrganizations(db, requireActor(request).id),
  }));

  app.post('/api/organizations', { preHandler: requireAuth }, async (request, reply) => {
    const body = createOrganizationBodySchema.parse(request.body);
    const created = await createOrganization(
      db,
      requireActor(request),
      requireSessionId(request),
      body,
    );
    return reply.code(201).send(created);
  });

  // Switch the active tenant. Membership is re-checked here, so an id the
  // caller does not belong to is a 404, not a switch.
  app.post('/api/organizations/:id/activate', { preHandler: requireAuth }, async (request) => {
    const { id } = request.params as { id: string };
    return activateOrganization(db, requireActor(request), requireSessionId(request), id);
  });

  // §41 screen 18 organization settings.
  app.get('/api/organization', { preHandler: requireAuth }, async (request) => {
    const organization = requireSessionOrganization(request);
    const members = await listMembers(db, organization.id);
    return {
      id: organization.id,
      name: organization.name,
      slug: organization.slug,
      plan: organization.plan,
      createdAt: organization.createdAt,
      role: requireRole(request),
      memberCount: members.length,
    };
  });

  app.patch('/api/organization', { preHandler: requireAuth }, async (request) => {
    const organizationId = requireSessionOrganizationId(request);
    const body = updateOrganizationBodySchema.parse(request.body);
    const row = await updateOrganization(
      db,
      requireActor(request),
      organizationId,
      requireRole(request),
      body,
    );
    return { id: row.id, name: row.name, slug: row.slug, plan: row.plan, createdAt: row.createdAt };
  });

  app.delete('/api/organization', { preHandler: requireAuth }, async (request, reply) => {
    const organizationId = requireSessionOrganizationId(request);
    const body = deleteOrganizationBodySchema.parse(request.body);
    await deleteOrganization(
      db,
      organizationDeps,
      requireActor(request),
      organizationId,
      requireRole(request),
      body,
    );
    return reply.code(204).send();
  });

  // ── Members ────────────────────────────────────────────────────

  app.get('/api/organization/members', { preHandler: requireAuth }, async (request) => ({
    members: await listMembers(db, requireSessionOrganizationId(request)),
  }));

  app.patch(
    '/api/organization/members/:memberId',
    { preHandler: requireAuth },
    async (request) => {
      const { memberId } = request.params as { memberId: string };
      const body = updateMemberRoleBodySchema.parse(request.body);
      return updateMemberRole(
        db,
        organizationDeps,
        requireActor(request),
        requireSessionOrganizationId(request),
        requireRole(request),
        memberId,
        body,
      );
    },
  );

  app.delete(
    '/api/organization/members/:memberId',
    { preHandler: requireAuth },
    async (request, reply) => {
      const { memberId } = request.params as { memberId: string };
      await removeMember(
        db,
        organizationDeps,
        requireActor(request),
        requireSessionOrganizationId(request),
        requireRole(request),
        memberId,
      );
      return reply.code(204).send();
    },
  );

  app.post('/api/organization/leave', { preHandler: requireAuth }, async (request, reply) => {
    await leaveOrganization(
      db,
      requireActor(request),
      requireSessionOrganizationId(request),
      requireRole(request),
    );
    return reply.code(204).send();
  });

  app.post(
    '/api/organization/transfer-ownership',
    { preHandler: requireAuth },
    async (request, reply) => {
      const body = transferOwnershipBodySchema.parse(request.body);
      await transferOwnership(
        db,
        organizationDeps,
        requireActor(request),
        requireSessionOrganizationId(request),
        requireRole(request),
        body,
      );
      return reply.code(204).send();
    },
  );

  // ── Invitations ─────────────────────────────────────────────

  app.get('/api/organization/invitations', { preHandler: requireAuth }, async (request) => ({
    invitations: await listInvitations(db, requireSessionOrganizationId(request)),
  }));

  app.post(
    '/api/organization/invitations',
    { preHandler: requireAuth },
    async (request, reply) => {
      const body = inviteMemberBodySchema.parse(request.body);
      const created = await createInvitation(
        organizationDeps,
        requireActor(request),
        requireSessionOrganizationId(request),
        requireRole(request),
        body,
      );
      return reply.code(201).send(created);
    },
  );

  app.post(
    '/api/organization/invitations/:invitationId/resend',
    { preHandler: requireAuth },
    async (request) => {
      const { invitationId } = request.params as { invitationId: string };
      return resendInvitation(
        organizationDeps,
        requireActor(request),
        requireSessionOrganizationId(request),
        requireRole(request),
        invitationId,
      );
    },
  );

  app.delete(
    '/api/organization/invitations/:invitationId',
    { preHandler: requireAuth },
    async (request, reply) => {
      const { invitationId } = request.params as { invitationId: string };
      await revokeInvitation(
        db,
        requireActor(request),
        requireSessionOrganizationId(request),
        requireRole(request),
        invitationId,
      );
      return reply.code(204).send();
    },
  );

  // Pending invitations addressed to the caller, across every tenant.
  app.get('/api/invitations', { preHandler: requireAuth }, async (request) => ({
    invitations: await listInvitationsForEmail(db, requireActor(request).email),
  }));

  // UNAUTHENTICATED by design — the invitee may not have an account yet, and
  // the accept screen has to name the organization before they sign in. Only
  // non-sensitive display fields: no member list, no tenant internals.
  app.get('/api/invitations/:invitationId', async (request) => {
    const { invitationId } = request.params as { invitationId: string };
    return getPublicInvitation(db, invitationId);
  });

  app.post(
    '/api/invitations/:invitationId/accept',
    { preHandler: requireAuth },
    async (request) => {
      const { invitationId } = request.params as { invitationId: string };
      return acceptInvitation(
        organizationDeps,
        requireActor(request),
        requireSessionId(request),
        invitationId,
      );
    },
  );

  app.post(
    '/api/invitations/:invitationId/reject',
    { preHandler: requireAuth },
    async (request, reply) => {
      const { invitationId } = request.params as { invitationId: string };
      await rejectInvitation(db, requireActor(request), invitationId);
      return reply.code(204).send();
    },
  );

  // ── Account ────────────────────────────────────────────────────

  app.delete('/api/account', { preHandler: requireAuth }, async (request, reply) => {
    const body = deleteAccountBodySchema.parse(request.body);
    await deleteAccount(db, organizationDeps, requireActor(request), body);
    return reply.code(204).send();
  });

  // §12/§44 public customer installation page. UNAUTHENTICATED by design —
  // the customer has no Deployz account. Only non-sensitive display fields:
  // never AWS account ids, tokens, config values, or internal db ids.
  // The public install page. Keyed on install_link_id, NOT on the relay's
  // installation id: the link is emailed to a customer and lives in browser
  // history, so it must not double as the identifier that authenticates a
  // relay. The enrollment code it returns is single-use and is what the
  // customer's bootstrap stack carries.
  app.get(
    '/api/install/:installLinkId',
    { config: { rateLimit: PUBLIC_INSTALL_RATE_LIMIT } },
    async (request) => {
    const { installLinkId } = request.params as { installLinkId: string };
    requireUuidId(installLinkId);
    const rows = await db
      .select({
        applicationName: schema.applications.name,
        publisherName: schema.organization.name,
        customerName: schema.customers.name,
        region: schema.deployments.region,
        databaseRequired: schema.applications.databaseRequired,
        storageRequired: schema.applications.storageRequired,
        redisRequired: schema.applications.redisRequired,
        enrollmentCode: schema.deployments.enrollmentCode,
        enrollmentUsedAt: schema.deployments.enrollmentUsedAt,
        deploymentId: schema.deployments.id,
        deploymentState: schema.deployments.state,
        attemptNumber: schema.deployments.attemptNumber,
        bootstrapStackName: schema.deployments.bootstrapStackName,
        installStartedAt: schema.deployments.installStartedAt,
        observedState: schema.deployments.observedState,
      })
      .from(schema.deployments)
      .innerJoin(schema.applications, eq(schema.deployments.applicationId, schema.applications.id))
      .innerJoin(schema.organization, eq(schema.deployments.organizationId, schema.organization.id))
      .innerJoin(schema.customers, eq(schema.deployments.customerId, schema.customers.id))
      .where(eq(schema.deployments.installLinkId, installLinkId))
      .limit(1);
    if (rows.length === 0) {
      throw new NotFoundError('Installation not found');
    }
    const row = rows[0]!;
    // Spent codes are of no use to the install page — it renders the "already
    // set up" state instead — so stop handing the credential to anyone who
    // replays the link out of a mailbox or browser history.
    const alreadyInstalled = row.enrollmentUsedAt !== null;
    const resourcesCreated = ['Application runtime'];
    if (row.databaseRequired) resourcesCreated.push('PostgreSQL database');
    if (row.storageRequired) resourcesCreated.push('Storage');
    if (row.redisRequired) resourcesCreated.push('Redis cache');
    resourcesCreated.push('Networking', 'Monitoring');
    // The expected bootstrap stack name: the persisted one once an attempt
    // has launched (a record of what the customer was told), otherwise the
    // name the link below will prefill. Derived from deployment identity so
    // two deployments into the same AWS account/region never collide.
    const stackName =
      row.bootstrapStackName ??
      bootstrapStackName({
        appName: row.applicationName,
        deploymentId: row.deploymentId,
        attempt: row.attemptNumber,
      });
    const waitingForRelay = row.deploymentState === 'WAITING_FOR_RELAY';
    // The relay enrolling is the only way out of WAITING_FOR_RELAY. Past one
    // relay-staleness window with no enrollment the page shows guidance
    // instead of a failure — the bootstrap stack may still be creating, or
    // may have failed before the connector ever started.
    const relayStuck =
      waitingForRelay &&
      row.installStartedAt !== null &&
      Date.now() - row.installStartedAt.getTime() > RELAY_STALE_AFTER_MS;
    // The install link already identifies exactly this deployment, so its
    // own id/state/domain are within the scope the link already grants —
    // this is not a tenant-boundary crossing, just more detail about the
    // one deployment the link names.
    const domain = await findActiveDomain(db, row.deploymentId);
    return {
      applicationName: row.applicationName,
      publisherName: row.publisherName,
      customerName: row.customerName,
      region: row.region,
      resourcesCreated,
      deploymentId: row.deploymentId,
      deploymentState: row.deploymentState,
      domain: domain ? toDomainView(domain) : null,
      routingTarget: domain?.routingTarget ?? null,
      // Same §24 derivation the fleet row uses — one progress model for the
      // install page and the dashboard, so the two cannot disagree. Only
      // offered once a relay enrolled; before that there is nothing to
      // observe.
      components: alreadyInstalled ? mergeComponentState(row.observedState, row) : null,
      bootstrapStackName: stackName,
      waitingForRelay,
      relayStuck,
      // The Quick Create link is built HERE, not in the web app: only the
      // control plane knows which template is currently published, which
      // region this customer's deployment targets, and this deployment's
      // single-use enrollment code. The link carries no credential — the
      // relay's is minted by CloudFormation inside the customer's account.
      //
      // Spent codes get no link. The page renders its "already set up" state
      // in that case and never follows the URL, so building one only hands
      // the enrollment code to whoever replays the link out of a mailbox.
      //
      // The template is resolved for THIS deployment's region, never for a
      // bucket in another region: a Lambda must read its code from a bucket
      // in the function's own region, and a cross-region reference fails
      // stack creation with an S3 PermanentRedirect (verified in
      // production). resolveBootstrapTemplate fails closed — an unsupported
      // or unpublished region yields no URL, and no cross-region link is
      // ever generated.
      quickCreateUrl:
        !alreadyInstalled
          ? (() => {
              const templateUrl = resolveBootstrapTemplate(row.region, {
                ...(env.bootstrapTemplateUrl
                  ? { legacyUrl: env.bootstrapTemplateUrl }
                  : {}),
                deployableRegions: env.deployableAwsRegions,
              });
              return templateUrl
                ? buildBootstrapQuickCreateUrl({
                    region: row.region,
                    templateUrl,
                    controlPlaneUrl: env.apiUrl,
                    enrollmentCode: row.enrollmentCode,
                    stackName,
                  })
                : null;
            })()
          : null,
      alreadyInstalled,
    };
    },
  );

  // §12/§44 the unified deployment-status derivation (apps/api/src/
  // deployment-status.ts), scoped exactly like the route above: the
  // install-link id, not the relay's own installation id. UNAUTHENTICATED by
  // design, so this returns ONLY the customer projection — never relay
  // identity, job payloads, or raw AWS/stack detail (see
  // customerDeploymentStatusSchema in @deployz/contracts).
  app.get(
    '/api/install/:installLinkId/status',
    { config: { rateLimit: PUBLIC_INSTALL_RATE_LIMIT } },
    async (request) => {
      const { installLinkId } = request.params as { installLinkId: string };
      requireUuidId(installLinkId);
      const rows = await db
        .select({
          deployment: schema.deployments,
          databaseRequired: schema.applications.databaseRequired,
          storageRequired: schema.applications.storageRequired,
          redisRequired: schema.applications.redisRequired,
          migrationCommand: schema.applications.migrationCommand,
        })
        .from(schema.deployments)
        .innerJoin(schema.applications, eq(schema.deployments.applicationId, schema.applications.id))
        .where(eq(schema.deployments.installLinkId, installLinkId))
        .limit(1);
      if (rows.length === 0) {
        throw new NotFoundError('Installation not found');
      }
      const row = rows[0]!;
      const jobs = await db
        .select()
        .from(schema.deploymentJobs)
        .where(eq(schema.deploymentJobs.deploymentId, row.deployment.id))
        .orderBy(schema.deploymentJobs.createdAt);
      const domain = await findActiveDomain(db, row.deployment.id);
      const appUrl = resolveAppUrl(jobs, domain);
      const derived = deriveDeploymentStatus({
        deployment: row.deployment,
        application: row,
        jobs,
        domain,
        appUrl,
      });
      return toCustomerDeploymentStatus(derived);
    },
  );

  // Pre-relay launch signal: the install page reports the customer pressing
  // "Deploy to AWS" so the deployment can show an explicit waiting state
  // (and, if no relay ever enrolls, guidance instead of a false failure).
  // Public for the same reason GET above is: keyed on the install link,
  // which is the only credential the customer holds. Idempotent — reopening
  // the CloudFormation console page is not a new attempt.
  app.post(
    '/api/install/:installLinkId/launched',
    { config: { rateLimit: PUBLIC_INSTALL_RATE_LIMIT } },
    async (request, reply) => {
    const { installLinkId } = request.params as { installLinkId: string };
    requireUuidId(installLinkId);
    const rows = await db
      .select({ deployment: schema.deployments, applicationName: schema.applications.name })
      .from(schema.deployments)
      .innerJoin(schema.applications, eq(schema.deployments.applicationId, schema.applications.id))
      .where(eq(schema.deployments.installLinkId, installLinkId))
      .limit(1);
    if (rows.length === 0) {
      throw new NotFoundError('Installation not found');
    }
    const { deployment, applicationName } = rows[0]!;
    // Phase 3 readiness gate: the install link is a second boundary where a
    // non-READY manifest must be stopped before any AWS provisioning.
    requireReadyManifest(deployment.desiredState);
    if (deployment.state !== 'NOT_INSTALLED') {
      return reply.code(200).send({ state: deployment.state });
    }
    await db.transaction(async (tx) => {
      await tx
        .update(schema.deployments)
        .set({
          state: 'WAITING_FOR_RELAY',
          installStartedAt: new Date(),
          bootstrapStackName: bootstrapStackName({
            appName: applicationName,
            deploymentId: deployment.id,
            attempt: deployment.attemptNumber,
          }),
        })
        .where(eq(schema.deployments.id, deployment.id));
      await recordEvent(tx, {
        organizationId: deployment.organizationId,
        eventType: 'install.launched',
        actorType: 'system',
        actorId: `install-link:${deployment.installLinkId}`,
        deploymentId: deployment.id,
        customerId: deployment.customerId,
        previousState: deployment.state,
        requestedState: 'WAITING_FOR_RELAY',
      });
    });
    return { state: 'WAITING_FOR_RELAY' };
    },
  );

  // Customer-facing retry for an install that never connected. Fresh
  // attempt: new enrollment code, bumped attempt number (so the Quick
  // Create link prefill moves to a stack name no ROLLBACK_COMPLETE
  // remnant of the failed attempt can block), spent in-flight INSTALL
  // jobs cancelled. The failed attempt's stack is NOT deleted here —
  // cleanup stays on the separate purge path. Guarded like retry-install:
  // a deployment that was ever healthy must not be reset from the public
  // page.
  app.post(
    '/api/install/:installLinkId/retry',
    { config: { rateLimit: PUBLIC_INSTALL_RATE_LIMIT } },
    async (request, reply) => {
    const { installLinkId } = request.params as { installLinkId: string };
    requireUuidId(installLinkId);
    const rows = await db
      .select({ deployment: schema.deployments, applicationName: schema.applications.name })
      .from(schema.deployments)
      .innerJoin(schema.applications, eq(schema.deployments.applicationId, schema.applications.id))
      .where(eq(schema.deployments.installLinkId, installLinkId))
      .limit(1);
    if (rows.length === 0) {
      throw new NotFoundError('Installation not found');
    }
    const { deployment, applicationName } = rows[0]!;
    if (await hasSucceededInstall(db, deployment.id)) {
      throw new ApiError(
        409,
        'INSTALL_ALREADY_SUCCEEDED',
        'This deployment installed successfully before; contact the vendor to make changes.',
      );
    }
    const nextAttempt = deployment.attemptNumber + 1;
    const stackName = bootstrapStackName({
      appName: applicationName,
      deploymentId: deployment.id,
      attempt: nextAttempt,
    });
    const enrollmentCode = mintEnrollmentCode();
    await db.transaction(async (tx) => {
      await tx
        .update(schema.deploymentJobs)
        .set({ state: 'CANCELLED', finishedAt: new Date() })
        .where(
          and(
            eq(schema.deploymentJobs.deploymentId, deployment.id),
            eq(schema.deploymentJobs.type, 'INSTALL'),
            inArray(schema.deploymentJobs.state, ['REQUESTED', 'QUEUED', 'RUNNING', 'WAITING']),
          ),
        );
      await tx
        .update(schema.deployments)
        .set({
          state: 'NOT_INSTALLED',
          enrollmentCode,
          enrollmentUsedAt: null,
          installationId: null,
          relayTokenHash: null,
          relayBoundAt: null,
          relayStatus: 'UNKNOWN',
          attemptNumber: nextAttempt,
          bootstrapStackName: stackName,
          installStartedAt: null,
        })
        .where(eq(schema.deployments.id, deployment.id));
      await recordEvent(tx, {
        organizationId: deployment.organizationId,
        eventType: 'install.retry.requested',
        actorType: 'system',
        actorId: `install-link:${deployment.installLinkId}`,
        deploymentId: deployment.id,
        customerId: deployment.customerId,
        previousState: deployment.state,
        requestedState: 'NOT_INSTALLED',
        payload: { attempt: nextAttempt, bootstrapStackName: stackName },
      });
    });
    return reply.code(200).send({
      state: 'NOT_INSTALLED',
      attemptNumber: nextAttempt,
      bootstrapStackName: stackName,
      quickCreateUrl:
        env.bootstrapTemplateUrl
          ? buildBootstrapQuickCreateUrl({
              region: deployment.region,
              templateUrl: env.bootstrapTemplateUrl,
              controlPlaneUrl: env.apiUrl,
              enrollmentCode,
              stackName,
            })
          : null,
    });
    },
  );

  // §31 application configuration surface (auth-gated). Vendor defaults are
  // customer_id NULL rows; customer overrides are scoped by ?customerId.
  // Secrets are write-only: GET masks them (value: null, never plaintext) and
  // PUT writes them through the relay to the customer's Secrets Manager
  // before persisting the masked placeholder in the control plane.
  const configStore = createConfigStore(db);
  const configSecretWriter = createRelaySecretWriter();

  app.get('/api/applications/:id/config', { preHandler: requireAuth }, async (request) => {
    const { id } = request.params as { id: string };
    const organizationId = requireSessionOrganizationId(request);
    await loadOwnedApplication(db, id, organizationId); // 404s on cross-org access
    const { customerId } = request.query as { customerId?: string | undefined };
    const scope = await resolveConfigScope(db, customerId, organizationId);
    return { ...(await getConfig(id, scope.customerId, configStore)), customerName: scope.customerName };
  });

  app.put('/api/applications/:id/config', { preHandler: requireAuth }, async (request) => {
    const { id } = request.params as { id: string };
    const organizationId = requireSessionOrganizationId(request);
    await loadOwnedApplication(db, id, organizationId); // 404s on cross-org access
    const body = setConfigBodySchema.parse(request.body);
    const scope = await resolveConfigScope(db, body.customerId, organizationId);
    // §9.5 relay-liveness gate for config-update, mirroring the deploy gate:
    // the worker fans CONFIG_UPDATE jobs out to this app's deployments, and a
    // disconnected relay never claims its share. Refuse the whole write so the
    // vendor reconnects first instead of watching doomed jobs accumulate.
    // Scope matches the worker's fan-out exactly (customer-scoped; a null
    // customer fan-out is empty and needs no gate).
    if (scope.customerId !== null) {
      const deadRelay = await db
        .select({ id: schema.deployments.id })
        .from(schema.deployments)
        .where(
          and(
            eq(schema.deployments.applicationId, id),
            eq(schema.deployments.customerId, scope.customerId),
            notInArray(schema.deployments.state, [
              'NOT_INSTALLED',
              'WAITING_FOR_RELAY',
              'DELETING',
              'DELETED',
            ]),
            eq(schema.deployments.relayStatus, 'DISCONNECTED'),
          ),
        )
        .limit(1);
      if (deadRelay.length > 0) {
        throw new ApiError(
          409,
          'RELAY_DISCONNECTED',
          'A deployment relay for this configuration is disconnected. Reconnect it before changing configuration.',
        );
      }
    }
    const view = await setConfig(
      id,
      scope.customerId,
      body.entries,
      { store: configStore, secretWriter: configSecretWriter },
      body.deletes ?? [],
    );
    return { ...view, customerName: scope.customerName };
  });

  // The GitHub App's Setup URL. GitHub sends the vendor here right after they
  // install (or reconfigure) the App, with `installation_id` in the query —
  // this is the one moment where the GitHub installation and the vendor's
  // Deployz session are both present, so it is where the two get bound.
  //
  // The redirect is a top-level GET navigation, so the Lax session cookie is
  // sent. A vendor who installed the App while signed out has no cookie to
  // send, though, and a JSON 401 would strand them on an error page with the
  // installation unbound — so that case goes to sign-in instead, carrying the
  // installation id back to the web setup page. The callback is RELATIVE
  // because the sign-in page rejects absolute URLs as open redirects.
  const redirectSignedOutToSignIn = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> => {
    try {
      await requireAuth(request);
    } catch (error) {
      // Only a missing session redirects. Anything else (a database failure
      // resolving the tenant, say) must surface as itself rather than be
      // disguised as "please sign in".
      if (!(error instanceof UnauthorizedError)) throw error;
      const { installation_id: installationId } = request.query as {
        installation_id?: string | undefined;
      };
      const target = installationId
        ? `/github/setup?installation_id=${encodeURIComponent(installationId)}`
        : '/github/setup';
      return reply.redirect(`${env.webUrl}/sign-in?callbackUrl=${encodeURIComponent(target)}`);
    }
  };
  app.get('/api/github/setup', { preHandler: redirectSignedOutToSignIn }, async (request, reply) => {
    const { installation_id: installationId } = request.query as {
      installation_id?: string | undefined;
    };
    const organizationId = requireSessionOrganizationId(request);
    const dashboardUrl = `${env.webUrl}/dashboard/applications`;
    if (!installationId) {
      return reply.redirect(`${dashboardUrl}?github=missing_installation`);
    }

    if (!githubAppId || !githubAppPrivateKey) {
      throw new ApiError(503, 'GITHUB_DISABLED', 'GitHub App is not configured');
    }
    // GitHub sends a *browser* to this URL, so a thrown error would render the
    // JSON envelope at the vendor and strand them there — the same dead end
    // the signed-out redirect above exists to avoid. Whatever goes wrong
    // (GitHub unreachable, an installation this App does not own, a private
    // key it cannot sign with), put them back on the dashboard, which reports
    // the state it can actually see.
    try {
      const jwt = createAppJwt(githubAppId, githubAppPrivateKey, Date.now());
      const account = await fetchInstallationAccount(installationId, jwt, githubFetch);

      await githubStore.set({
        id: installationId,
        organizationId,
        accountLogin: account.accountLogin,
        accountType: account.accountType,
      });
    } catch (error) {
      request.log.error({ err: error, installationId }, 'github setup binding failed');
      return reply.redirect(`${dashboardUrl}?github=failed`);
    }

    return reply.redirect(`${dashboardUrl}?github=connected`);
  });

  // GitHub repo-selection surface (auth-gated). Fixture mode serves the
  // fixture org/repos so the dashboard renders test data without a real App;
  // otherwise the installation store (written by /api/github/setup) is the
  // source of truth, and repo listing needs a minted installation token.
  app.get('/api/github/installations', { preHandler: requireAuth }, async (request) => {
    const organizationId = request.organization?.id;
    if (!organizationId) {
      throw new ApiError(401, 'UNAUTHORIZED', 'An organization is required');
    }
    const fixtureMode = githubFixtureMode ?? env.githubFixtureMode;
    const installations = await listInstallations(githubStore, organizationId, { fixtureMode });
    return {
      installations,
      connectUrl: (githubAppInstallUrl ?? env.githubAppInstallUrl) || null,
    };
  });

  app.get('/api/github/repos', { preHandler: requireAuth }, async (request) => {
    const { installationId } = request.query as { installationId?: string | undefined };
    if (!installationId) {
      throw new ApiError(400, 'INSTALLATION_ID_REQUIRED', 'installationId query parameter is required');
    }
    const organizationId = requireSessionOrganizationId(request);
    const fixtureMode = githubFixtureMode ?? env.githubFixtureMode;
    if (fixtureMode) {
      const repositories = await listRepositories(installationId, { fixtureMode: true });
      return { repositories };
    }
    // An installation id is a guessable integer, and the token minted below
    // can read every repository in it — so the caller must own it.
    const record = await githubStore.get(installationId);
    if (!record || record.organizationId !== organizationId) {
      throw new NotFoundError('GitHub installation not found');
    }
    if (!githubAppId || !githubAppPrivateKey) {
      throw new ApiError(503, 'GITHUB_DISABLED', 'GitHub App is not configured');
    }
    const { token } = await mintInstallationToken(
      installationId,
      githubAppId,
      githubAppPrivateKey,
      Date.now(),
      githubFetch,
    );
    const repositories = await listRepositories(installationId, {
      fixtureMode: false,
      installationToken: token,
      fetchFn: githubFetch,
    });
    return { repositories };
  });

  // ── Request schemas (route boundary validation) ─────────────────────────

  // organizationId is optional and, when present, is validated (not
  // trusted) against the session — see resolveWriteOrganizationId. It is
  // NEVER the source of truth for which org a row is written into.
  const createApplicationBodySchema = z.object({
    organizationId: z.string().min(1).optional(),
    name: z.string().min(1),
    githubInstallationId: z.string().min(1),
    repoFullName: z.string().min(1),
    repoUrl: z.string().min(1),
    defaultBranch: z.string().min(1),
    containerPort: z.number().int().nullish(),
    healthPath: z.string().nullish(),
    workerCommand: z.string().nullish(),
    databaseRequired: z.boolean().nullish(),
    storageRequired: z.boolean().nullish(),
    redisRequired: z.boolean().nullish(),
  });

  // §36 PATCH-only — mirrors POST but all-optional. `nullish` fields let the
  // client clear a currently-set value by sending `null`; boolean columns are
  // NOT NULL in the DB so they use `.optional()` (never null).
  const patchApplicationBodySchema = z.object({
    name: z.string().min(1).optional(),
    containerPort: z.number().int().nullish(),
    healthPath: z.string().nullish(),
    migrationCommand: z.string().nullish(),
    workerCommand: z.string().nullish(),
    databaseRequired: z.boolean().optional(),
    storageRequired: z.boolean().optional(),
    redisRequired: z.boolean().optional(),
    // Phase 2 manifest overrides — stored on detected_metadata.manifestOverrides.
    appRoot: z.string().nullish(),
    dockerfilePath: z.string().nullish(),
    buildContext: z.string().nullish(),
    buildCommand: z.string().nullish(),
    startCommand: z.string().nullish(),
  });

  const createCustomerBodySchema = z.object({
    organizationId: z.string().min(1).optional(),
    name: z.string().min(1),
    email: z.string().email(),
    company: z.string().nullish(),
    externalReference: z.string().nullish(),
  });

  const createDeploymentBodySchema = z.object({
    applicationId: z.string().uuid(),
    customerId: z.string().uuid(),
    organizationId: z.string().min(1).optional(),
    // The canonical supported set from @deployz/contracts — never a
    // hand-maintained duplicate.
    region: regionSchema,
    isTestDeployment: z.boolean().nullish(),
  });

  const createReleaseBodySchema = z.object({
    version: z.string().min(1),
    gitSha: z.string().min(1),
    migrationCommand: z.string().nullish(),
  });

  const deployBodySchema = z.object({
    releaseId: z.string().uuid(),
  });

  const deployBulkBodySchema = z.object({
    releaseId: z.string().uuid(),
    deploymentIds: z.array(z.string().uuid()).nullish(),
  });

  const rollbackBodySchema = z.object({
    releaseId: z.string().uuid(),
  });

  const destroyBodySchema = z.object({
    finalSnapshot: z.boolean().nullish(),
  });

  const checkoutBodySchema = z.object({
    organizationId: z.string().min(1).optional(),
  });

  const addDomainBodySchema = z.object({ hostname: z.string() });

  // ── Applications (§17–§19) ──────────────────────────────────────────────

  // POST /api/applications — Create application from GitHub repo selection
  app.post('/api/applications', { preHandler: requireAuth }, async (request, reply) => {
    const body = createApplicationBodySchema.parse(request.body);
    const organizationId = resolveWriteOrganizationId(request, body.organizationId);
    // The installation id is what analysis later mints a repo-read token
    // from, so an application may only point at an installation this
    // organization connected.
    if (!(githubFixtureMode ?? env.githubFixtureMode)) {
      const record = await githubStore.get(body.githubInstallationId);
      if (!record || record.organizationId !== organizationId) {
        throw new NotFoundError('GitHub installation not found');
      }
    }

    // One application per repository per organization. Choosing the same repo
    // twice used to create a second application with its own releases and
    // deployments, and the repo list went on offering "Choose" as though it
    // were not already connected. The id comes back so the client can send
    // the vendor to the application they already have.
    const existing = await db
      .select({ id: schema.applications.id })
      .from(schema.applications)
      .where(
        and(
          eq(schema.applications.organizationId, organizationId),
          eq(schema.applications.repoFullName, body.repoFullName),
        ),
      )
      .limit(1);
    if (existing.length > 0) {
      throw new ApiError(
        409,
        'APPLICATION_ALREADY_CONNECTED',
        'This repository is already connected. Open it from your applications list.',
        { applicationId: existing[0]!.id },
      );
    }

    const [row] = await db
      .insert(schema.applications)
      .values({
        organizationId,
        name: body.name,
        githubInstallationId: body.githubInstallationId,
        repoFullName: body.repoFullName,
        repoUrl: body.repoUrl,
        defaultBranch: body.defaultBranch,
        containerPort: body.containerPort ?? null,
        healthPath: body.healthPath ?? null,
        workerCommand: body.workerCommand ?? null,
        databaseRequired: body.databaseRequired ?? false,
        storageRequired: body.storageRequired ?? false,
        redisRequired: body.redisRequired ?? false,
        analysisStatus: 'PENDING',
        createdBy: request.user?.id ?? null,
        updatedBy: request.user?.id ?? null,
      })
      .returning();
    return reply.code(201).send(row);
  });

  // GET /api/applications — List applications for current org
  app.get('/api/applications', { preHandler: requireAuth }, async (request) => {
    const organizationId = requireSessionOrganizationId(request);
    const rows = await db
      .select()
      .from(schema.applications)
      .where(eq(schema.applications.organizationId, organizationId));
    return { applications: rows };
  });

  // GET /api/applications/:id — Get single application
  app.get('/api/applications/:id', { preHandler: requireAuth }, async (request) => {
    const { id } = request.params as { id: string };
    const organizationId = requireSessionOrganizationId(request);
    return loadOwnedApplication(db, id, organizationId);
  });

  // PATCH /api/applications/:id — Update deployability fields
  // A field the vendor actually CHANGES here becomes vendor-owned: it is
  // recorded on detected_metadata.vendorOverrides and analysis.ts never
  // auto-detects it again (§35 provenance). Everything else stays
  // auto-detected, so a re-analysis keeps tracking the repository.
  // ⚠️ Race with the fire-and-forget analysis run: a PATCH that lands while
  // an analysis is in flight can still be overwritten by that run's write —
  // the override is recorded, but the analysis loaded the row before it. The
  // UI warns against editing mid-analysis; re-saving after it settles wins.
  app.patch('/api/applications/:id', { preHandler: requireAuth }, async (request) => {
    const { id } = request.params as { id: string };
    const organizationId = requireSessionOrganizationId(request);
    const existing = await loadOwnedApplication(db, id, organizationId);
    const body = patchApplicationBodySchema.parse(request.body);
    const set: Record<string, unknown> = {};
    if (body.name !== undefined) set.name = body.name;
    if (body.containerPort !== undefined) set.containerPort = body.containerPort ?? null;
    if (body.healthPath !== undefined) set.healthPath = body.healthPath ?? null;
    if (body.migrationCommand !== undefined) set.migrationCommand = body.migrationCommand ?? null;
    if (body.workerCommand !== undefined) set.workerCommand = body.workerCommand ?? null;
    if (body.databaseRequired !== undefined) set.databaseRequired = body.databaseRequired;
    if (body.storageRequired !== undefined) set.storageRequired = body.storageRequired;
    if (body.redisRequired !== undefined) set.redisRequired = body.redisRequired;

    // Phase 2 manifest-only overrides (app root, Dockerfile, build
    // context/command, start command) have no applications column; they live
    // on detected_metadata.manifestOverrides. A null clears that key.
    let nextMetadata = existing.detectedMetadata ?? {};
    const storedManifestOverrides = (nextMetadata['manifestOverrides'] ?? {}) as Record<string, unknown>;
    const nextManifestOverrides = { ...storedManifestOverrides };
    let manifestOnlyChanged = false;
    for (const field of MANIFEST_OVERRIDE_FIELDS) {
      const value = body[field];
      if (value === undefined) continue;
      manifestOnlyChanged = true;
      if (value === null) {
        delete nextManifestOverrides[field];
      } else {
        nextManifestOverrides[field] = value;
      }
    }
    if (manifestOnlyChanged) {
      nextMetadata = { ...nextMetadata, manifestOverrides: nextManifestOverrides };
    }

    if (Object.keys(set).length === 0 && !manifestOnlyChanged) return existing;
    // The details form re-submits every field on every save, so only a value
    // that actually differs counts as the vendor claiming that field.
    const claimed = CONTRACT_FIELDS.filter(
      (field) => set[field] !== undefined && set[field] !== existing[field],
    );
    if (claimed.length > 0 || manifestOnlyChanged) {
      if (claimed.length > 0) {
        const overrides = new Set([...readVendorOverrides(existing.detectedMetadata), ...claimed]);
        nextMetadata = { ...nextMetadata, vendorOverrides: [...overrides] };
      }
      set.detectedMetadata = nextMetadata;
    }
    set.updatedBy = request.user?.id ?? null;
    const [row] = await db
      .update(schema.applications)
      .set(set)
      .where(eq(schema.applications.id, id))
      .returning();
    if (!row) {
      throw new NotFoundError('Application not found');
    }
    return row;
  });

  // DELETE /api/applications/:id — Remove an application (only if it has zero deployments)
  app.delete('/api/applications/:id', { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const organizationId = requireSessionOrganizationId(request);
    const app = await loadOwnedApplication(db, id, organizationId);
    const deployments = await db
      .select({ id: schema.deployments.id })
      .from(schema.deployments)
      .where(eq(schema.deployments.applicationId, id))
      .limit(1);
    if (deployments.length > 0) {
      throw new ApiError(
        409,
        'APPLICATION_HAS_DEPLOYMENTS',
        'This application has deployment history and cannot be removed. Applications can only be removed before their first deployment.',
      );
    }
    await db.transaction(async (tx) => {
      await tx.insert(schema.eventLogs).values({
        actorType: 'user',
        actorId: request.user!.id,
        organizationId,
        eventType: 'APPLICATION_DELETED',
        payload: { applicationId: id, applicationName: app.name, repoFullName: app.repoFullName },
      });
      await tx.delete(schema.applicationConfigs).where(eq(schema.applicationConfigs.applicationId, id));
      await tx.delete(schema.releases).where(eq(schema.releases.applicationId, id));
      await tx.delete(schema.applications).where(eq(schema.applications.id, id));
    });
    return reply.code(204).send();
  });

  // POST /api/applications/:id/analyse — Trigger analysis
  app.post('/api/applications/:id/analyse', { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const organizationId = requireSessionOrganizationId(request);
    await loadOwnedApplication(db, id, organizationId);
    // Task 6 commit-SHA analysis cache: `force` bypasses it (the vendor's
    // explicit "Re-analyse" action) — an auto-trigger sends no body and
    // lets the cache decide.
    const body = request.body as { force?: boolean } | undefined;
    const force = body?.force === true;
    await db
      .update(schema.applications)
      .set({ analysisStatus: 'ANALYZING', updatedBy: request.user?.id ?? null })
      .where(eq(schema.applications.id, id));
    // The §18/§19 pipeline runs on the worker, not after this response.
    // Detaching it here with `void runAnalysis(id)` works on a long-lived
    // server and silently does nothing on Lambda, which freezes the
    // execution environment as soon as the reply is sent — the application
    // would sit at ANALYZING for ever. Without a queue (local dev) the
    // long-lived server can and does run it inline.
    const queued = await enqueue({ type: 'ANALYSE_APPLICATION', applicationId: id, force });
    if (!queued) {
      // runAnalysis catches every internal failure and persists FAILED
      // rather than throwing; the `.catch` is a second net so a rejected
      // promise can never surface as an unhandled rejection.
      await runAnalysis(id, { force }).catch(() => {});
    }
    return reply.code(202).send({ status: 'ANALYZING' });
  });

  // GET /api/applications/:id/readiness — Get compatibility result (§19)
  app.get('/api/applications/:id/readiness', { preHandler: requireAuth }, async (request) => {
    const { id } = request.params as { id: string };
    const organizationId = requireSessionOrganizationId(request);
    const app = await loadOwnedApplication(db, id, organizationId);
    return computeReadiness(app);
  });

  // POST /api/applications/:id/fix-instructions — Generate the consolidated
  // coding-agent prompt for the unresolved readiness findings. Read-only with
  // respect to the analysis: generation never changes findings, readiness
  // state, or the repository. Any AI failure maps to a retryable 503 — the
  // analysis stays fully usable without it.
  app.post(
    '/api/applications/:id/fix-instructions',
    { preHandler: requireAuth },
    async (request) => {
      const { id } = request.params as { id: string };
      const organizationId = requireSessionOrganizationId(request);
      const application = await loadOwnedApplication(db, id, organizationId);

      if (application.analysisStatus !== 'COMPLETE') {
        throw new ApiError(
          409,
          'ANALYSIS_NOT_COMPLETE',
          'Run the analysis before generating fix instructions.',
        );
      }
      const context = buildFixInstructionsContext(application);
      if (!context) {
        throw new ApiError(
          409,
          'NO_UNRESOLVED_FINDINGS',
          'There are no unresolved findings to generate instructions for.',
        );
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), FIX_INSTRUCTIONS_TIMEOUT_MS);
      try {
        const instructions = await generateFixInstructions(context, aiGateway, {
          abortSignal: controller.signal,
        });
        return { instructions, generatedAt: new Date().toISOString() };
      } catch (error) {
        // Every AI failure (unconfigured gateway, timeout, malformed output,
        // spend limit) is the same retryable condition to the vendor.
        request.log.warn({ err: error }, 'fix-instructions generation failed');
        throw new ApiError(
          503,
          'FIX_INSTRUCTIONS_UNAVAILABLE',
          "We couldn't generate the instructions right now. Try again in a moment.",
        );
      } finally {
        clearTimeout(timer);
      }
    },
  );

  // ── Customers (§37) ─────────────────────────────────────────────────────

  // POST /api/customers — Create customer
  app.post('/api/customers', { preHandler: requireAuth }, async (request, reply) => {
    const body = createCustomerBodySchema.parse(request.body);
    const organizationId = resolveWriteOrganizationId(request, body.organizationId);
    const [row] = await db
      .insert(schema.customers)
      .values({
        organizationId,
        name: body.name,
        email: body.email,
        company: body.company ?? null,
        externalReference: body.externalReference ?? null,
      })
      .returning();
    return reply.code(201).send(row);
  });

  // GET /api/customers — List customers for org
  app.get('/api/customers', { preHandler: requireAuth }, async (request) => {
    const organizationId = requireSessionOrganizationId(request);
    const rows = await db
      .select()
      .from(schema.customers)
      .where(eq(schema.customers.organizationId, organizationId));
    return { customers: rows };
  });

  // ── Deployments (§12, §23–§24, §38) ────────────────────────────────────

  // POST /api/deployments — Create deployment. Stays NOT_INSTALLED until the
  // relay first registers (see /api/relay/register, §6/§39) — that is where
  // the INSTALL job actually gets created, since the deployment record can
  // legitimately exist before any relay has ever called home.
  app.post('/api/deployments', { preHandler: requireAuth }, async (request, reply) => {
    const body = createDeploymentBodySchema.parse(request.body);
    // Fail closed: a deployment may only target a region whose bootstrap
    // artifacts are CONFIRMED published. Selecting a supported-but-unpublished
    // region would produce an install link whose Lambda code cannot be fetched
    // in that region — the exact PermanentRedirect failure this guard exists
    // to prevent. The region must be in the canonical deployable set, not just
    // the supported enum.
    if (!env.deployableAwsRegions.includes(body.region)) {
      throw new ApiError(
        422,
        'REGION_NOT_SUPPORTED',
        `Region ${body.region} is not available for installation yet.`,
      );
    }
    const organizationId = resolveWriteOrganizationId(request, body.organizationId);
    // 404 on a non-existent/other-org applicationId or customerId — otherwise
    // the INSERT below hits a foreign-key violation and surfaces as a 500.
    const application = await loadOwnedApplication(db, body.applicationId, organizationId);
    await loadOwnedCustomer(db, body.customerId, organizationId);
    // Phase 2 readiness gate — block incompatible/missing-config deployments
    // BEFORE any AWS provisioning can start. The evaluator runs from the FINAL
    // manifest (detector output + vendor overrides), so a vendor-corrected
    // config passes even when the stored analysis report is stale.
    const manifest = normalizeDeploymentManifest(
      { metadata: application.detectedMetadata ?? {} },
      applicationToManifestOverrides(application),
    );
    const readiness = evaluateManifestReadiness(manifest);
    if (readiness.state === 'NOT_COMPATIBLE') {
      throw new ApiError(
        422,
        'MANIFEST_NOT_COMPATIBLE',
        'This application cannot be deployed with Deployz as configured.',
        { findings: readiness.findings },
      );
    }
    if (readiness.state === 'NEEDS_CONFIGURATION') {
      throw new ApiError(
        422,
        'MANIFEST_NEEDS_CONFIGURATION',
        'This application is missing configuration required for deployment. Run analysis or correct it in the application settings first.',
        { findings: readiness.findings },
      );
    }
    // The relay mints its own installationId inside the customer's account, so
    // it is unknown until enrollment. What the control plane mints here is the
    // single-use enrollment code the bootstrap stack carries, plus the public
    // install-link id — deliberately a different value, so the link a customer
    // is emailed is not also the credential that identifies their relay.
    const [row] = await db
      .insert(schema.deployments)
      .values({
        customerId: body.customerId,
        applicationId: body.applicationId,
        organizationId,
        region: body.region,
        state: 'NOT_INSTALLED',
        // The final manifest is the deployment's desired state — the canonical
        // config this deployment was created with, kept for rollback/deploy
        // even if application analysis or overrides change afterwards.
        desiredState: { manifest },
        enrollmentCode: mintEnrollmentCode(),
        isTestDeployment: body.isTestDeployment ?? false,
        createdBy: request.user?.id ?? null,
        updatedBy: request.user?.id ?? null,
      })
      .returning();
    return reply.code(201).send(row);
  });

  // GET /api/regions — the region options for the "Create customer
  // deployment" screen. Served by the control plane (not hardcoded in the
  // web app) so the UI can never offer a region that is not actually
  // deployable: only regions whose regional bootstrap artifacts are confirmed
  // published appear here. Derived from the canonical SUPPORTED_AWS_REGIONS /
  // REGION_LABELS in @deployz/contracts, intersected with
  // env.deployableAwsRegions.
  app.get('/api/regions', { preHandler: requireAuth }, async () => {
    return {
      regions: SUPPORTED_AWS_REGIONS.filter((region) => env.deployableAwsRegions.includes(region)).map(
        (region) => ({ value: region, label: REGION_LABELS[region] }),
      ),
    };
  });

  // GET /api/deployments — Fleet dashboard (§23). Joined with customers +
  // applications + the current release so the UI gets Customer / Version /
  // Region / Status (and application name / masked AWS account / created
  // date for §24) without a second round trip per row.
  app.get('/api/deployments', { preHandler: requireAuth }, async (request) => {
    const { customerId, applicationId, includeDeleted } = request.query as {
      customerId?: string;
      applicationId?: string;
      includeDeleted?: string;
    };
    const organizationId = requireSessionOrganizationId(request);
    // These reach a uuid column directly. Unvalidated, a hand-typed URL made
    // Postgres raise and the request 500 with no error envelope.
    requireUuidQueryParam(customerId, 'customerId');
    requireUuidQueryParam(applicationId, 'applicationId');
    const conditions = [eq(schema.deployments.organizationId, organizationId)];
    if (customerId) {
      conditions.push(eq(schema.deployments.customerId, customerId));
    }
    if (applicationId) {
      conditions.push(eq(schema.deployments.applicationId, applicationId));
    }
    // §63 a removed deployment stays in the audit trail but leaves the fleet:
    // the homepage already excluded it and this list did not, so the two
    // screens disagreed about what the fleet was.
    if (includeDeleted !== 'true') {
      conditions.push(ne(schema.deployments.state, 'DELETED'));
    }
    const rows = await db
      .select({
        deployment: schema.deployments,
        customerName: schema.customers.name,
        applicationName: schema.applications.name,
        version: schema.releases.version,
        databaseRequired: schema.applications.databaseRequired,
        storageRequired: schema.applications.storageRequired,
        redisRequired: schema.applications.redisRequired,
        migrationCommand: schema.applications.migrationCommand,
      })
      .from(schema.deployments)
      .innerJoin(schema.customers, eq(schema.deployments.customerId, schema.customers.id))
      .innerJoin(schema.applications, eq(schema.deployments.applicationId, schema.applications.id))
      .leftJoin(schema.releases, eq(schema.deployments.currentReleaseId, schema.releases.id))
      .where(and(...conditions));

    // Batched so the list stays one round trip per table regardless of fleet
    // size: N per-row queries here previously would have meant N+1 queries
    // (jobs) and another N+1 (domains) on top of the row query above.
    const ids = rows.map((row) => row.deployment.id);
    const jobRows =
      ids.length > 0
        ? await db
            .select()
            .from(schema.deploymentJobs)
            .where(inArray(schema.deploymentJobs.deploymentId, ids))
            .orderBy(schema.deploymentJobs.createdAt)
        : [];
    const jobsByDeployment = new Map<string, DeploymentJobRow[]>();
    for (const job of jobRows) {
      const list = jobsByDeployment.get(job.deploymentId);
      if (list) {
        list.push(job);
      } else {
        jobsByDeployment.set(job.deploymentId, [job]);
      }
    }
    // The partial unique index on (deployment_id) WHERE removed_at IS NULL
    // guarantees at most one row per deployment here, so no per-deployment
    // "latest" reduction is needed the way findActiveDomain does for a
    // single deployment.
    const domainRows =
      ids.length > 0
        ? await db
            .select()
            .from(schema.customDomains)
            .where(and(inArray(schema.customDomains.deploymentId, ids), isNull(schema.customDomains.removedAt)))
        : [];
    const domainByDeployment = new Map(domainRows.map((domain) => [domain.deploymentId, domain]));

    return {
      deployments: rows.map((row) => {
        const jobs = jobsByDeployment.get(row.deployment.id) ?? [];
        const domain = domainByDeployment.get(row.deployment.id) ?? null;
        const appUrl = resolveAppUrl(jobs, domain);
        const derived = deriveDeploymentStatus({ deployment: row.deployment, application: row, jobs, domain, appUrl });
        return { ...toFleetRow(row), deploymentStatus: toVendorDeploymentStatus(derived) };
      }),
    };
  });

  // GET /api/deployments/:id — Deployment detail (§24)
  app.get('/api/deployments/:id', { preHandler: requireAuth }, async (request) => {
    const { id } = request.params as { id: string };
    const organizationId = requireSessionOrganizationId(request);
    requireUuidId(id);
    const rows = await db
      .select({
        deployment: schema.deployments,
        customerName: schema.customers.name,
        applicationName: schema.applications.name,
        version: schema.releases.version,
        databaseRequired: schema.applications.databaseRequired,
        storageRequired: schema.applications.storageRequired,
        redisRequired: schema.applications.redisRequired,
        migrationCommand: schema.applications.migrationCommand,
      })
      .from(schema.deployments)
      .innerJoin(schema.customers, eq(schema.deployments.customerId, schema.customers.id))
      .innerJoin(schema.applications, eq(schema.deployments.applicationId, schema.applications.id))
      .leftJoin(schema.releases, eq(schema.deployments.currentReleaseId, schema.releases.id))
      .where(and(eq(schema.deployments.id, id), eq(schema.deployments.organizationId, organizationId)))
      .limit(1);
    if (rows.length === 0) {
      throw new NotFoundError('Deployment not found');
    }
    const jobs = await db
      .select()
      .from(schema.deploymentJobs)
      .where(eq(schema.deploymentJobs.deploymentId, id))
      .orderBy(schema.deploymentJobs.createdAt);
    // Task 11: a compact status/reference for the internal detail page —
    // attached here rather than inside toFleetRow so the fleet LIST endpoint
    // doesn't pick up an extra per-row domain query.
    const domain = await findActiveDomain(db, rows[0]!.deployment.id);
    const customDomain = domain ? { hostname: domain.hostname, status: domain.status.toLowerCase() } : null;
    const appUrl = resolveAppUrl(jobs, domain);
    const derived = deriveDeploymentStatus({
      deployment: rows[0]!.deployment,
      application: rows[0]!,
      jobs,
      domain,
      appUrl,
    });
    return {
      ...toFleetRow(rows[0]!),
      jobs,
      customDomain,
      appUrl,
      deploymentStatus: toVendorDeploymentStatus(derived),
    };
  });

  // ── Releases (§22) ──────────────────────────────────────────────────────

  // POST /api/applications/:id/releases — Create release
  app.post('/api/applications/:id/releases', { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const organizationId = requireSessionOrganizationId(request);
    await loadOwnedApplication(db, id, organizationId);
    const body = createReleaseBodySchema.parse(request.body);

    // §36 one immutable record per version. Two releases called 1.0.0 make
    // "deploy 1.0.0" ambiguous, so the unique index refuses the second and
    // this turns it into a message a person can act on.
    const duplicate = await db
      .select({ id: schema.releases.id })
      .from(schema.releases)
      .where(and(eq(schema.releases.applicationId, id), eq(schema.releases.version, body.version)))
      .limit(1);
    if (duplicate.length > 0) {
      throw new ApiError(
        409,
        'RELEASE_VERSION_EXISTS',
        `Version ${body.version} already exists for this application. Use a different version number.`,
      );
    }

    const [row] = await db
      .insert(schema.releases)
      .values({
        applicationId: id,
        version: body.version,
        gitSha: body.gitSha,
        migrationCommand: body.migrationCommand ?? null,
        buildStatus: 'PENDING',
        createdBy: request.user?.id ?? null,
        updatedBy: request.user?.id ?? null,
      })
      .returning();
    // A release with no build is a release that can never deploy: the
    // §21 image digest only exists once CodeBuild has pushed the image.
    // The worker fetches the repository source and starts that build.
    if (row) {
      if (env.buildFixtureMode) {
        // BUILD_FIXTURE_MODE: locally JOB_QUEUE_URL is never configured, so
        // enqueue() no-ops and the release could never reach READY — every
        // deploy/rollback would 409 forever. Skip the queue and mark the
        // release built immediately, so E2E lifecycle scenarios can exercise
        // the real deploy/rollback/destroy routes end-to-end.
        await db
          .update(schema.releases)
          .set({
            imageDigest: fixtureImageDigest(row.id),
            buildStatus: 'SUCCEEDED',
            releaseStatus: 'READY',
          })
          .where(eq(schema.releases.id, row.id));
      } else {
        await enqueue({ type: 'BUILD_RELEASE', releaseId: row.id });
      }
    }

    // §22/§25: every live deployment of this application is now behind. The
    // state existed and was read by the billing rule and the bulk-deploy
    // gate, but nothing ever wrote it, so the fleet could never show who
    // needed updating.
    await db
      .update(schema.deployments)
      .set({ state: 'UPDATE_AVAILABLE' })
      .where(
        and(
          eq(schema.deployments.applicationId, id),
          eq(schema.deployments.state, 'HEALTHY'),
        ),
      );

    return reply.code(201).send(row);
  });

  // GET /api/applications/:id/releases — List releases
  app.get('/api/applications/:id/releases', { preHandler: requireAuth }, async (request) => {
    const { id } = request.params as { id: string };
    const organizationId = requireSessionOrganizationId(request);
    await loadOwnedApplication(db, id, organizationId);
    const rows = await db
      .select()
      .from(schema.releases)
      .where(eq(schema.releases.applicationId, id))
      .orderBy(schema.releases.createdAt);
    return {
      releases: rows.map((row) => ({
        id: row.id,
        version: row.version,
        status: row.releaseStatus,
        failureReason: row.failureReason,
        createdAt: row.createdAt,
      })),
    };
  });

  // ── Job triggers (§25, §27, §63) ────────────────────────────────────────

  /**
   * Record a vendor-initiated job: move the deployment into its §46 in-flight
   * state and append the §40 event, atomically.
   *
   * Both used to be missing. The deployment stayed on HEALTHY from the moment
   * a deploy was requested until the relay answered, so a vendor who clicked
   * "Deploy Update" watched the page return to exactly the state it was in —
   * and no row was ever written to the event log, so "Recent activity" stayed
   * empty through a deployment's entire life.
   */
  async function markJobRequested(params: {
    deployment: DeploymentRow;
    jobId: string;
    inFlightState: DeploymentRow['state'] | null;
    eventType: DeploymentEventType;
    actorId: string | null;
    releaseId?: string | undefined;
  }): Promise<void> {
    await db.transaction(async (tx) => {
      if (params.inFlightState) {
        await tx
          .update(schema.deployments)
          .set({ state: params.inFlightState, updatedBy: params.actorId })
          .where(eq(schema.deployments.id, params.deployment.id));
      }
      await recordEvent(tx, {
        organizationId: params.deployment.organizationId,
        eventType: params.eventType,
        actorType: 'user',
        actorId: params.actorId ?? 'system',
        deploymentId: params.deployment.id,
        customerId: params.deployment.customerId,
        jobId: params.jobId,
        releaseId: params.releaseId,
        previousState: params.deployment.state,
        requestedState: params.inFlightState,
        result: 'pending',
      });
    });
  }

  /**
   * Phase 1.1: after a successful INSTALL the stack runs the template's pinned
   * image — roll the newest READY release of the application immediately so a
   * fresh installation serves real traffic without a manual deploy step.
   *
   * Best-effort: no READY release (nothing built yet) or a payload that stops
   * validating simply skips. The job uses the SAME idempotency key as the
   * manual deploy route (`${deployment.id}:DEPLOY_RELEASE:<releaseId>`), so a
   * vendor-driven deploy of the same release reuses it instead of racing it.
   *
   * The deployment state is deliberately NOT advanced (`inFlightState: null`):
   * the INSTALLING → HEALTHY transition belongs to the relay's runtime-health
   * verification, and an auto-queued deploy must not make the deployment look
   * healthier than it is. The relay picks the job up on its next poll and the
   * DEPLOY_RELEASE result handler settles the state as usual.
   */
  async function autoDeploySelectedRelease(deployment: DeploymentRow): Promise<void> {
    const newestReady = await db
      .select({ id: schema.releases.id })
      .from(schema.releases)
      .where(
        and(
          eq(schema.releases.applicationId, deployment.applicationId),
          eq(schema.releases.releaseStatus, 'READY'),
        ),
      )
      .orderBy(desc(schema.releases.createdAt))
      .limit(1);
    const release = newestReady[0];
    if (!release) return;

    const payload = await requireDeployableRelease(db, release.id, deployment.applicationId, deployment);
    const { job, created } = await createOrReuseJob(db, {
      deploymentId: deployment.id,
      type: 'DEPLOY_RELEASE',
      idempotencyKey: `${deployment.id}:DEPLOY_RELEASE:${release.id}`,
      payload,
      requestedBy: null,
    });
    if (created) {
      await markJobRequested({
        deployment,
        jobId: job.id,
        inFlightState: null,
        eventType: 'deploy.requested',
        actorId: null,
        releaseId: release.id,
      });
    }
  }


  // POST /api/deployments/:id/deploy — Trigger (or reuse) a DEPLOY_RELEASE job
  app.post('/api/deployments/:id/deploy', { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const organizationId = requireSessionOrganizationId(request);
    const deployment = await loadOwnedDeployment(db, id, organizationId);
    const body = deployBodySchema.parse(request.body);
    const payload = await requireDeployableRelease(db, body.releaseId, deployment.applicationId, deployment);
    // The same rule deploy-bulk applies. Without it this route accepted a
    // deploy for a NOT_INSTALLED deployment — 202, a queued job, and nothing
    // in the customer's account to ever run it.
    await requireDeployableState(db, deployment);
    const idempotencyKey =
      firstHeaderValue(request.headers['idempotency-key']) ??
      (await retryAwareIdempotencyKey(
        db,
        deployment.id,
        'DEPLOY_RELEASE',
        `${deployment.id}:DEPLOY_RELEASE:${body.releaseId}`,
      ));
    await requireDeploymentIdle(db, deployment.id, idempotencyKey);
    const { job, created } = await createOrReuseJob(db, {
      deploymentId: deployment.id,
      type: 'DEPLOY_RELEASE',
      idempotencyKey,
      payload,
      requestedBy: request.user?.id ?? null,
    });
    if (created) {
      await markJobRequested({
        deployment,
        jobId: job.id,
        inFlightState: BULK_DEPLOYABLE_STATES.has(deployment.state) ? 'UPDATING' : null,
        eventType: 'deploy.requested',
        actorId: request.user?.id ?? null,
        releaseId: body.releaseId,
      });
    }
    return reply.code(created ? 202 : 200).send({ jobId: job.id, state: job.state });
  });

  // POST /api/applications/:id/deploy-bulk — §25 "one / selected / all
  // compatible customers". Fans out into individual per-deployment
  // DEPLOY_RELEASE jobs via the exact same idempotent path as the
  // single-deploy route above — never one aggregate job.
  app.post('/api/applications/:id/deploy-bulk', { preHandler: requireAuth }, async (request) => {
    const { id } = request.params as { id: string };
    const organizationId = requireSessionOrganizationId(request);
    await loadOwnedApplication(db, id, organizationId);
    const body = deployBulkBodySchema.parse(request.body);
    const payload = await requireDeployableRelease(db, body.releaseId, id);

    const conditions = [
      eq(schema.deployments.applicationId, id),
      eq(schema.deployments.organizationId, organizationId),
    ];
    if (body.deploymentIds && body.deploymentIds.length > 0) {
      conditions.push(inArray(schema.deployments.id, body.deploymentIds));
    }
    const targets = await db
      .select()
      .from(schema.deployments)
      .where(and(...conditions));

    const results: Array<{
      deploymentId: string;
      status: 'REQUESTED' | 'ALREADY_REQUESTED' | 'SKIPPED';
      jobId?: string;
      reason?: string;
    }> = [];

    for (const deployment of targets) {
      if (!BULK_DEPLOYABLE_STATES.has(deployment.state)) {
        results.push({
          deploymentId: deployment.id,
          status: 'SKIPPED',
          reason: `Deployment is ${deployment.state}, not deployable`,
        });
        continue;
      }
      // Same §9.5 gate as the single-deploy route: a dead relay never claims
      // the job, and the watchdog would fail it later — skip with a reason.
      if (deployment.relayStatus === 'DISCONNECTED') {
        results.push({
          deploymentId: deployment.id,
          status: 'SKIPPED',
          reason: 'The relay for this deployment is disconnected — reconnect it before deploying.',
        });
        continue;
      }
      const idempotencyKey = await retryAwareIdempotencyKey(
        db,
        deployment.id,
        'DEPLOY_RELEASE',
        `${deployment.id}:DEPLOY_RELEASE:${body.releaseId}`,
      );
      const busy = await db
        .select({ id: schema.deploymentJobs.id })
        .from(schema.deploymentJobs)
        .where(
          and(
            eq(schema.deploymentJobs.deploymentId, deployment.id),
            inArray(schema.deploymentJobs.state, ['REQUESTED', 'QUEUED', 'WAITING', 'RUNNING']),
            inArray(schema.deploymentJobs.type, [
              'INSTALL',
              'DEPLOY_RELEASE',
              'ROLLBACK',
              'RESTART',
              'CONFIG_UPDATE',
              'DESTROY',
              'MIGRATION',
              'INFRA_UPGRADE',
            ]),
            // A retry of this same release deploy reuses its job; only a
            // DIFFERENT active operation skips this deployment.
            ne(schema.deploymentJobs.idempotencyKey, idempotencyKey),
          ),
        )
        .limit(1);
      if (busy.length > 0) {
        results.push({
          deploymentId: deployment.id,
          status: 'SKIPPED',
          reason: 'Another deployment operation is already in progress.',
        });
        continue;
      }
      // Phase 4: each target resolves its own migration command — the shared
      // `payload` carries the release-level command; a target's stored
      // manifest command overrides it (same precedence as single deploys).
      let targetPayload = payload;
      const manifestCommand = readStoredManifest(deployment.desiredState)?.migration.command ?? null;
      if (manifestCommand !== null && manifestCommand !== payload['migrationCommand']) {
        targetPayload = { ...payload, migrationCommand: manifestCommand };
      }
      const { job, created } = await createOrReuseJob(db, {
        deploymentId: deployment.id,
        type: 'DEPLOY_RELEASE',
        idempotencyKey,
        payload: targetPayload,
        requestedBy: request.user?.id ?? null,
      });
      results.push({
        deploymentId: deployment.id,
        status: created ? 'REQUESTED' : 'ALREADY_REQUESTED',
        jobId: job.id,
      });
    }

    return { results };
  });

  // Trigger (or reuse) a ROLLBACK job for an already-loaded, already-owned
  // deployment. Shared by the vendor rollback route and the admin recovery
  // action — never mutate state independently of this.
  async function performRollback(
    deployment: DeploymentRow,
    actorId: string | null,
    releaseId: string,
    idempotencyKeyHeader: string | undefined,
  ): Promise<{ job: DeploymentJobRow; created: boolean }> {
    await requireDeployableState(db, deployment);
    const payload = await requireDeployableRelease(db, releaseId, deployment.applicationId);
    const idempotencyKey =
      idempotencyKeyHeader ??
      (await retryAwareIdempotencyKey(
        db,
        deployment.id,
        'ROLLBACK',
        `${deployment.id}:ROLLBACK:${releaseId}`,
      ));
    await requireDeploymentIdle(db, deployment.id, idempotencyKey);
    const { job, created } = await createOrReuseJob(db, {
      deploymentId: deployment.id,
      type: 'ROLLBACK',
      idempotencyKey,
      payload,
      requestedBy: actorId,
    });
    if (created) {
      await markJobRequested({
        deployment,
        jobId: job.id,
        inFlightState: BULK_DEPLOYABLE_STATES.has(deployment.state) ? 'UPDATING' : null,
        eventType: 'rollback.requested',
        actorId,
        releaseId,
      });
    }
    return { job, created };
  }

  // POST /api/deployments/:id/rollback — Trigger (or reuse) a ROLLBACK job
  app.post('/api/deployments/:id/rollback', { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const organizationId = requireSessionOrganizationId(request);
    const deployment = await loadOwnedDeployment(db, id, organizationId);
    const body = rollbackBodySchema.parse(request.body);
    const { job, created } = await performRollback(
      deployment,
      request.user?.id ?? null,
      body.releaseId,
      firstHeaderValue(request.headers['idempotency-key']),
    );
    return reply.code(created ? 202 : 200).send({ jobId: job.id, state: job.state });
  });

  // POST /api/deployments/:id/restart — Restart the running application.
  // Same image, no release pointer change: a fresh ECS deployment of the
  // current task definition.
  app.post('/api/deployments/:id/restart', { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const organizationId = requireSessionOrganizationId(request);
    const deployment = await loadOwnedDeployment(db, id, organizationId);
    await requireDeployableState(db, deployment);
    const idempotencyKey =
      firstHeaderValue(request.headers['idempotency-key']) ??
      (await retryAwareIdempotencyKey(db, deployment.id, 'RESTART', `${deployment.id}:RESTART`));
    await requireDeploymentIdle(db, deployment.id, idempotencyKey);
    const { job, created } = await createOrReuseJob(db, {
      deploymentId: deployment.id,
      type: 'RESTART',
      idempotencyKey,
      payload: {},
      requestedBy: request.user?.id ?? null,
    });
    if (created) {
      await markJobRequested({
        deployment,
        jobId: job.id,
        inFlightState: BULK_DEPLOYABLE_STATES.has(deployment.state) ? 'UPDATING' : null,
        eventType: 'restart.requested',
        actorId: request.user?.id ?? null,
      });
    }
    return reply.code(created ? 202 : 200).send({ jobId: job.id, state: job.state });
  });

  // POST /api/deployments/:id/destroy — Trigger (or reuse) a DESTROY job
  app.post('/api/deployments/:id/destroy', { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const organizationId = requireSessionOrganizationId(request);
    const deployment = await loadOwnedDeployment(db, id, organizationId);
    const body = destroyBodySchema.parse(request.body);

    if (deployment.state === 'DELETED') {
      throw new ApiError(
        409,
        'DEPLOYMENT_ALREADY_REMOVED',
        'This deployment has already been removed.',
      );
    }

    // Nothing was ever installed, so there is nothing in the customer's
    // account to remove and no relay to ask. Queuing a DESTROY job here left
    // the deployment sitting at "Not installed" forever while the vendor
    // watched a confirmation dialog close and nothing happen.
    if (deployment.state === 'NOT_INSTALLED' || deployment.state === 'WAITING_FOR_RELAY') {
      await db.transaction(async (tx) => {
        await tx
          .update(schema.deployments)
          .set({ state: 'DELETED', deletedAt: new Date(), updatedBy: request.user?.id ?? null })
          .where(eq(schema.deployments.id, deployment.id));
        await recordEvent(tx, {
          organizationId: deployment.organizationId,
          eventType: 'destroy.completed',
          actorType: 'user',
          actorId: request.user?.id ?? 'system',
          deploymentId: deployment.id,
          customerId: deployment.customerId,
          previousState: deployment.state,
          requestedState: 'DELETED',
          payload: { reason: 'never installed — removed without a relay job' },
        });
      });
      return reply.code(200).send({ jobId: null, state: 'DELETED' });
    }

    // A pending DESTROY blocks every other mutating command: accepting a
    // deploy against a stack that is about to be deleted can only produce a
    // job whose subject disappears underneath it.
    const idempotencyKey =
      firstHeaderValue(request.headers['idempotency-key']) ??
      (await retryAwareIdempotencyKey(db, deployment.id, 'DESTROY', `${deployment.id}:DESTROY`));
    await requireDeploymentIdle(db, deployment.id, idempotencyKey);
    // Data deletion during a wedged destroy is authorized ONLY for a
    // deployment that never completed an install — its retained database is
    // an empty artifact of a failed create, not customer data. Anything
    // that ever ran keeps the data-preserving destroy path (the relay
    // finishes the stack delete RETAINING what it cannot remove).
    const neverInstalled = !(await hasSucceededInstall(db, deployment.id));
    const { job, created } = await createOrReuseJob(db, {
      deploymentId: deployment.id,
      type: 'DESTROY',
      idempotencyKey,
      payload: {
        finalSnapshot: body.finalSnapshot ?? false,
        dataDeletionAuthorized: neverInstalled,
      },
      requestedBy: request.user?.id ?? null,
    });
    if (created) {
      await markJobRequested({
        deployment,
        jobId: job.id,
        inFlightState: 'DELETING',
        eventType: 'destroy.requested',
        actorId: request.user?.id ?? null,
      });
    }

    // The stack is coming down — start tearing down any custom domain
    // alongside it rather than leaving it dangling once the deployment is
    // gone. The DESTROY-success handler below is the safety net if this
    // REMOVE_DOMAIN job never finishes.
    const activeDomain = await findActiveDomain(db, deployment.id);
    if (activeDomain) {
      await removeCustomDomain(db, deployment, activeDomain);
    }

    return reply.code(created ? 202 : 200).send({ jobId: job.id, state: job.state });
  });

  // Settle a DESTROY whose relay went offline mid-delete, OR whose delete
  // keeps FAILING on a relay that is still online, for an already-loaded,
  // already-owned deployment. Shared by the vendor disconnect/force-complete
  // route and the admin recovery action.
  //
  // This completes the CONTROL-PLANE disconnect only. It never claims the
  // customer's AWS resources were removed: cleanupState records
  // SKIPPED_RELAY_OFFLINE, the warning stays visible until a PURGE runs, and
  // the stuck DESTROY job is cancelled rather than failed so the deployment
  // does not land in FAILED with no way out.
  async function performForceCompleteDestroy(
    deployment: DeploymentRow,
    actorId: string | null,
  ): Promise<{ state: 'DELETED'; cleanupState: 'SKIPPED_RELAY_OFFLINE'; jobId: string }> {
    // Two escape paths, discriminated by whether a DESTROY is still in
    // flight:
    //   1. DELETING + a pending (REQUESTED..RUNNING) DESTROY — the relay
    //      went offline mid-delete (relayStatus DISCONNECTED required).
    //   2. DELETING or FAILED + NO pending DESTROY, but REPEATED FAILED
    //      DESTROY jobs whose latest is the deployment's newest job — the
    //      delete itself is wedged on a relay that keeps reporting failure
    //      (even while technically connected).
    const destroys = await db
      .select()
      .from(schema.deploymentJobs)
      .where(
        and(
          eq(schema.deploymentJobs.deploymentId, deployment.id),
          eq(schema.deploymentJobs.type, 'DESTROY'),
        ),
      )
      .orderBy(desc(schema.deploymentJobs.createdAt))
      .limit(10);
    const job = destroys.find((j) =>
      ['REQUESTED', 'QUEUED', 'WAITING', 'RUNNING'].includes(j.state),
    );

    if (job) {
      // Path 1 — offline relay mid-delete.
      if (deployment.state !== 'DELETING') {
        throw new ApiError(
          409,
          'NOT_DELETING',
          'Only a disconnect that is still in progress can be completed this way.',
        );
      }
      // Persisted liveness is the gate: the worker sweep only writes
      // DISCONNECTED after the relay missed its check-in window, so this
      // cannot fire on a relay that is merely between polls.
      if (deployment.relayStatus !== 'DISCONNECTED') {
        throw new ApiError(
          409,
          'RELAY_NOT_OFFLINE',
          'The relay for this deployment is not confirmed offline.',
        );
      }
      const lastSignal = job.lastProgressAt ?? job.startedAt ?? job.createdAt;
      if (Date.now() - lastSignal.getTime() < DESTROY_PENDING_STALE_AFTER_MS) {
        throw new ApiError(
          409,
          'DESTROY_NOT_STALE',
          'The disconnect has not been pending long enough to complete it this way.',
        );
      }
    } else {
      // Path 2 — repeated FAILED destroys, no job in flight.
      const latestAny = await db
        .select({ type: schema.deploymentJobs.type, state: schema.deploymentJobs.state })
        .from(schema.deploymentJobs)
        .where(eq(schema.deploymentJobs.deploymentId, deployment.id))
        .orderBy(desc(schema.deploymentJobs.createdAt))
        .limit(1);
      if (
        deployment.state !== 'DELETING' &&
        deployment.state !== 'FAILED'
      ) {
        throw new ApiError(
          409,
          'NOT_DELETING',
          'Only a disconnect that is still in progress can be completed this way.',
        );
      }
      const failedDestroys = destroys.filter((d) => d.state === 'FAILED');
      if (
        failedDestroys.length < REPEATED_DESTROY_FAILURES_REQUIRED ||
        latestAny[0]?.type !== 'DESTROY' ||
        latestAny[0]?.state !== 'FAILED'
      ) {
        throw new ApiError(409, 'NO_PENDING_DESTROY', 'No disconnect is waiting on this deployment.');
      }
      const lastFailedAt = destroys[0]!.finishedAt ?? destroys[0]!.updatedAt ?? destroys[0]!.createdAt;
      if (Date.now() - lastFailedAt.getTime() < DESTROY_PENDING_STALE_AFTER_MS) {
        throw new ApiError(
          409,
          'DESTROY_NOT_STALE',
          'The disconnect has not been pending long enough to complete it this way.',
        );
      }
    }

    const reason = job ? 'RELAY_OFFLINE' : 'REPEATED_DESTROY_FAILURE';
    const settleJobId = job?.id ?? destroys[0]!.id;

    await db.transaction(async (tx) => {
      if (job) {
        await tx
          .update(schema.deploymentJobs)
          .set({
            state: 'CANCELLED',
            finishedAt: new Date(),
            result: { forceCompleted: true, reason },
          })
          .where(eq(schema.deploymentJobs.id, job.id));
      }
      await tx
        .update(schema.deployments)
        .set({
          state: 'DELETED',
          deletedAt: new Date(),
          cleanupState: 'SKIPPED_RELAY_OFFLINE',
          updatedBy: actorId,
        })
        .where(eq(schema.deployments.id, deployment.id));
      // Same safety net as a DESTROY success: the row must not linger as a
      // phantom "removing" domain for a deployment that no longer exists.
      const danglingDomain = await findActiveDomain(tx, deployment.id);
      if (danglingDomain) {
        await tx
          .update(schema.customDomains)
          .set({ removedAt: new Date() })
          .where(eq(schema.customDomains.id, danglingDomain.id));
      }
      await recordEvent(tx, {
        organizationId: deployment.organizationId,
        eventType: 'destroy.force_completed',
        actorType: 'user',
        actorId: actorId ?? 'system',
        deploymentId: deployment.id,
        customerId: deployment.customerId,
        jobId: settleJobId,
        previousState: deployment.state,
        requestedState: 'DELETED',
        result: 'success',
        payload: {
          relayStatus: deployment.relayStatus,
          reason,
          awsResourcesRemoved: false,
          cleanupState: 'SKIPPED_RELAY_OFFLINE',
        },
      });
    });

    return { state: 'DELETED', cleanupState: 'SKIPPED_RELAY_OFFLINE', jobId: settleJobId };
  }

  // POST /api/deployments/:id/disconnect/force-complete — settle a DESTROY
  // whose relay went offline mid-delete, OR whose delete keeps FAILING on a
  // relay that is still online.
  app.post(
    '/api/deployments/:id/disconnect/force-complete',
    { preHandler: requireAuth },
    async (request) => {
      const { id } = request.params as { id: string };
      requireUuidId(id);
      const organizationId = requireSessionOrganizationId(request);
      const deployment = await loadOwnedDeployment(db, id, organizationId);
      const result = await performForceCompleteDestroy(deployment, request.user?.id ?? null);
      return { state: result.state, cleanupState: result.cleanupState };
    },
  );

  // POST /api/deployments/:id/purge — Permanently remove retained AWS
  // resources (P2). Only a force-completed disconnect can carry leftovers:
  // a normal disconnect removed its resources via the relay. The vendor
  // typed the deployment name in the dashboard to confirm; the relay
  // re-verifies ownership of every resource before deleting it.
  app.post('/api/deployments/:id/purge', { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    requireUuidId(id);
    const organizationId = requireSessionOrganizationId(request);
    const deployment = await loadOwnedDeployment(db, id, organizationId);

    if (
      deployment.state !== 'DELETED' ||
      (deployment.cleanupState !== 'SKIPPED_RELAY_OFFLINE' && deployment.cleanupState !== 'PURGE_FAILED')
    ) {
      throw new ApiError(
        409,
        'NOT_PURGE_ELIGIBLE',
        'Only a disconnected deployment with retained resources can be purged.',
      );
    }
    // One mutating operation per deployment: a purge already in flight must
    // not be joined by another.
    const idempotencyKey =
      firstHeaderValue(request.headers['idempotency-key']) ??
      (await retryAwareIdempotencyKey(db, deployment.id, 'PURGE', `${deployment.id}:PURGE`));
    await requireDeploymentIdle(db, deployment.id, idempotencyKey);
    const { job, created } = await createOrReuseJob(db, {
      deploymentId: deployment.id,
      type: 'PURGE',
      idempotencyKey,
      // Phase 5 §9.6: a reset may have LEFT an older installation behind
      // (previous stack/install ids recorded on the row). Carry them so the
      // purge can find and account for that stack's retained resources
      // instead of silently orphaning them.
      payload: {
        ...(deployment.previousInstallationId
          ? { previousInstallationId: deployment.previousInstallationId }
          : {}),
        ...(deployment.previousBootstrapStackName
          ? { previousBootstrapStackName: deployment.previousBootstrapStackName }
          : {}),
      },
      requestedBy: request.user?.id ?? null,
    });
    if (created) {
      await recordEvent(db, {
        organizationId: deployment.organizationId,
        eventType: 'purge.requested',
        actorType: 'user',
        actorId: request.user?.id ?? 'system',
        deploymentId: deployment.id,
        customerId: deployment.customerId,
        jobId: job.id,
        previousState: deployment.state,
        result: 'pending',
        payload: {},
      });
    }
    return reply.code(created ? 202 : 200).send({ jobId: job.id, state: job.state });
  });

  // §14 re-enrollment, for an already-loaded, already-owned deployment.
  // Shared by the vendor relay/reset route and the admin recovery action.
  //
  // The recovery path for a lost credential, a rebuilt bootstrap stack, or a
  // rejected enrollment. Without it a 409 from /api/relay/register would be
  // unrecoverable: the binding is single-use by design, so something has to
  // be able to clear it, and that something is a deliberate vendor action.
  //
  // A reset is also a fresh install attempt when nothing was ever installed:
  // the attempt number bumps (so the next Quick Create link prefills a
  // stack name no ROLLBACK_COMPLETE remnant can block), leftover in-flight
  // INSTALL jobs from the dead attempt are cancelled (they would otherwise
  // be failed by the watchdog and drag the reset deployment back to
  // FAILED), and the deployment returns to NOT_INSTALLED so the dashboard
  // offers the install link again. A deployment that was ever healthy keeps
  // its state — its reset only rotates the credential.
  async function performRelayReset(
    deployment: DeploymentRow,
    actorId: string | null,
  ): Promise<{ installLinkId: string | null; attemptNumber: number }> {
    const enrollmentCode = mintEnrollmentCode();
    const [application] = await db
      .select({ name: schema.applications.name })
      .from(schema.applications)
      .where(eq(schema.applications.id, deployment.applicationId))
      .limit(1);
    const neverInstalled = !(await hasSucceededInstall(db, deployment.id));
    const nextAttempt = deployment.attemptNumber + 1;
    const stackName = bootstrapStackName({
      appName: application?.name ?? '',
      deploymentId: deployment.id,
      attempt: nextAttempt,
    });

    await db.transaction(async (tx) => {
      if (neverInstalled) {
        await tx
          .update(schema.deploymentJobs)
          .set({ state: 'CANCELLED', finishedAt: new Date() })
          .where(
            and(
              eq(schema.deploymentJobs.deploymentId, deployment.id),
              eq(schema.deploymentJobs.type, 'INSTALL'),
              inArray(schema.deploymentJobs.state, ['REQUESTED', 'QUEUED', 'RUNNING', 'WAITING']),
            ),
          );
      }
      await tx
        .update(schema.deployments)
        .set({
          enrollmentCode,
          enrollmentUsedAt: null,
          installationId: null,
          // Phase 5 §9.6: the identifiers this reset replaces stay recorded so
          // a later purge can still find the PREVIOUS stack's retained
          // resources — re-enrollment must not silently orphan them.
          ...(deployment.installationId
            ? { previousInstallationId: deployment.installationId }
            : {}),
          ...(deployment.bootstrapStackName
            ? { previousBootstrapStackName: deployment.bootstrapStackName }
            : {}),
          relayTokenHash: null,
          relayBoundAt: null,
          relayStatus: 'UNKNOWN',
          attemptNumber: nextAttempt,
          bootstrapStackName: neverInstalled ? stackName : deployment.bootstrapStackName,
          installStartedAt: null,
          updatedBy: actorId,
          ...(neverInstalled ? { state: 'NOT_INSTALLED' as const } : {}),
        })
        .where(eq(schema.deployments.id, deployment.id));
      await recordEvent(tx, {
        organizationId: deployment.organizationId,
        eventType: 'relay.reenrollment.requested',
        actorType: 'user',
        actorId: actorId ?? 'system',
        deploymentId: deployment.id,
        customerId: deployment.customerId,
        previousState: deployment.state,
        requestedState: neverInstalled ? 'NOT_INSTALLED' : deployment.state,
        payload: {
          attempt: nextAttempt,
          bootstrapStackName: neverInstalled ? stackName : null,
          ...(deployment.installationId
            ? { previousInstallationId: deployment.installationId }
            : {}),
          ...(deployment.bootstrapStackName
            ? { previousBootstrapStackName: deployment.bootstrapStackName }
            : {}),
        },
      });
    });

    return { installLinkId: deployment.installLinkId, attemptNumber: nextAttempt };
  }

  // POST /api/deployments/:id/relay/reset — §14 re-enrollment.
  app.post('/api/deployments/:id/relay/reset', { preHandler: requireAuth }, async (request) => {
    const { id } = request.params as { id: string };
    const organizationId = requireSessionOrganizationId(request);
    const deployment = await loadOwnedDeployment(db, id, organizationId);
    const result = await performRelayReset(deployment, request.user?.id ?? null);
    return { installLinkId: result.installLinkId };
  });

  // Recovery for a failed FIRST install, for an already-loaded,
  // already-owned deployment. Shared by the vendor retry-install route and
  // the admin recovery action.
  //
  // A terminal-failed application stack (ROLLBACK_COMPLETE, DELETE_FAILED…)
  // cannot be updated, and its retained RDS/S3 resources block manual
  // deletion — without this route a failed first install bricks the
  // deployment until someone cleans the AWS account by hand. The retry
  // queues a fresh INSTALL job whose payload tells the relay this
  // deployment never installed successfully, authorizing it to delete the
  // failed stack and its orphaned blockers before recreating (recovery runs
  // inside the command; one vendor action, no separate cleanup step).
  //
  // The idempotent-replay path (a double-click on a live retry) returns the
  // existing job rather than creating one; callers must map that
  // discriminated result to a 200, and the created-a-new-job path to
  // 202/200 exactly as createOrReuseJob reports.
  async function performRetryInstall(
    deployment: DeploymentRow,
    actorId: string | null,
  ): Promise<
    | { replayed: true; job: DeploymentJobRow }
    | { replayed: false; created: boolean; job: DeploymentJobRow }
  > {
    const installJobs = await db
      .select()
      .from(schema.deploymentJobs)
      .where(
        and(
          eq(schema.deploymentJobs.deploymentId, deployment.id),
          eq(schema.deploymentJobs.type, 'INSTALL'),
        ),
      );
    if (installJobs.some((j) => j.state === 'SUCCEEDED' || j.state === 'SUCCESS')) {
      // A deployment that was ever healthy must never receive destructive
      // recovery — its retained database may hold customer data. A later
      // failure belongs to deploy/rollback, not to first-install retry.
      throw new ApiError(
        409,
        'INSTALL_ALREADY_SUCCEEDED',
        'This deployment installed successfully before; use Deploy or Rollback instead.',
      );
    }

    const inFlight = installJobs.find((j) =>
      ['REQUESTED', 'QUEUED', 'RUNNING', 'WAITING'].includes(j.state),
    );
    const retryKeyPrefix = `${deployment.id}:INSTALL:RETRY`;
    const inFlightIsFresh =
      inFlight !== undefined &&
      (inFlight.startedAt ?? inFlight.createdAt).getTime() > Date.now() - INSTALL_JOB_STALE_AFTER_MS;

    if (inFlight !== undefined && inFlightIsFresh) {
      // A double-click on a live retry is an idempotent replay, not a new
      // attempt — return the queued job rather than a 409.
      if (inFlight.idempotencyKey.startsWith(retryKeyPrefix)) {
        return { replayed: true, job: inFlight };
      }
      throw new ApiError(
        409,
        'INSTALL_NOT_RETRYABLE',
        'The current install attempt is still in progress.',
      );
    }

    const retryable = deployment.state === 'FAILED' || inFlight !== undefined;
    if (!retryable) {
      throw new ApiError(
        409,
        'INSTALL_NOT_RETRYABLE',
        `Deployment is ${deployment.state}, not retryable.`,
      );
    }

    if (!deployment.installationId) {
      throw new ApiError(
        409,
        'RELAY_NOT_CONNECTED',
        'No relay is connected to this deployment. Reconnect it before retrying the install.',
      );
    }

    // A bound-but-disconnected relay never picks the retry job up, and the
    // watchdog would fail it an hour later — re-failing the deployment the
    // vendor just tried to save. The fix for a dead relay is re-enrollment
    // (relay/reset: fresh code + attempt + stack name), not another install
    // job; refuse so the UI points there instead.
    if (deployment.relayStatus === 'DISCONNECTED') {
      throw new ApiError(
        409,
        'RELAY_DISCONNECTED',
        'The relay for this deployment is disconnected. Reconnect it before retrying the install.',
      );
    }

    // Superseded stale attempt (a dead relay invocation's RUNNING job, or a
    // queued job the FAILED state outran) is closed BEFORE the new insert —
    // the one-active-job index refuses a second active INSTALL otherwise.
    if (inFlight) {
      await db
        .update(schema.deploymentJobs)
        .set({ state: 'CANCELLED', finishedAt: new Date() })
        .where(eq(schema.deploymentJobs.id, inFlight.id));
    }

    // Attempt-scoped key: the original `${deployment.id}:INSTALL` row is
    // FAILED and createOrReuseJob would keep returning it. Counting prior
    // attempts keeps the key deterministic, so a double-click reuses the
    // same retry job instead of queuing a second one.
    const idempotencyKey = `${deployment.id}:INSTALL:RETRY:${installJobs.length}`;
    const { job, created } = await createOrReuseJob(db, {
      deploymentId: deployment.id,
      type: 'INSTALL',
      idempotencyKey,
      payload: {
        recovery: { neverInstalled: true },
        parameters: await buildInstallParameters(db, deployment.id),
        redisRequired: await readRedisRequired(db, deployment.applicationId),
        // The canonical manifest this deployment was created with — the relay
        // derives port/health/binding parameters from it (Phase 2).
        manifest: readStoredManifest(deployment.desiredState),
      },
      requestedBy: actorId,
    });

    if (created) {
      await db.transaction(async (tx) => {
        await tx
          .update(schema.deployments)
          .set({ state: 'INSTALLING', updatedBy: actorId })
          .where(eq(schema.deployments.id, deployment.id));
        await recordEvent(tx, {
          organizationId: deployment.organizationId,
          eventType: 'install.retry.requested',
          actorType: 'user',
          actorId: actorId ?? 'system',
          deploymentId: deployment.id,
          customerId: deployment.customerId,
          jobId: job.id,
          previousState: deployment.state,
          requestedState: 'INSTALLING',
          result: 'pending',
          payload: { supersededJobId: inFlight?.id ?? null },
        });
      });
    }

    if (created && deployment.installationId && deployment.awsAccountId) {
      // Phase 1.1: a fresh install attempt re-grants pull access. Idempotent —
      // a replay or an already-granted installation is a no-op policy write.
      await grantPullToCustomer(
        ecrGrantDeps,
        deployment.installationId,
        deployment.awsAccountId,
      );
    }

    return { replayed: false, created, job };
  }

  // POST /api/deployments/:id/retry-install — recovery for a failed FIRST
  // install.
  app.post('/api/deployments/:id/retry-install', { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const organizationId = requireSessionOrganizationId(request);
    const deployment = await loadOwnedDeployment(db, id, organizationId);
    const result = await performRetryInstall(deployment, request.user?.id ?? null);
    if (result.replayed) {
      return reply.code(200).send({ jobId: result.job.id, state: result.job.state });
    }
    return reply.code(result.created ? 202 : 200).send({ jobId: result.job.id, state: result.job.state });
  });

  // ── Custom domain (custom-domains MVP) ────────────────────────────────
  app.post('/api/deployments/:id/domain', { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    requireUuidId(id);
    const organizationId = requireSessionOrganizationId(request);
    const actor = requireActor(request);
    const deployment = await loadOwnedDeployment(db, id, organizationId);
    const body = addDomainBodySchema.parse(request.body);
    const domain = await createCustomDomain(db, deployment, body.hostname, actor.id);
    return reply.code(201).send({ domain: toDomainView(domain) });
  });

  app.get('/api/deployments/:id/domain', { preHandler: requireAuth }, async (request) => {
    const { id } = request.params as { id: string };
    requireUuidId(id);
    const organizationId = requireSessionOrganizationId(request);
    const deployment = await loadOwnedDeployment(db, id, organizationId);
    const domain = await findActiveDomain(db, deployment.id);
    return { domain: domain ? toDomainView(domain) : null };
  });

  app.post('/api/deployments/:id/domain/check', { preHandler: requireAuth }, async (request) => {
    const { id } = request.params as { id: string };
    requireUuidId(id);
    const organizationId = requireSessionOrganizationId(request);
    const deployment = await loadOwnedDeployment(db, id, organizationId);
    const domain = await findActiveDomain(db, deployment.id);
    if (!domain) throw new NotFoundError('Custom domain not found');
    const fresh = await runDomainCheck(db, deployment, domain, domainCheckDeps);
    return { domain: toDomainView(fresh) };
  });

  app.delete('/api/deployments/:id/domain', { preHandler: requireAuth }, async (request) => {
    const { id } = request.params as { id: string };
    requireUuidId(id);
    const organizationId = requireSessionOrganizationId(request);
    const deployment = await loadOwnedDeployment(db, id, organizationId);
    const domain = await findActiveDomain(db, deployment.id);
    if (!domain) throw new NotFoundError('Custom domain not found');
    const fresh = await removeCustomDomain(db, deployment, domain);
    return { domain: toDomainView(fresh) };
  });

  // Customer-facing "Check now" — link-scoped like GET /api/install/:installLinkId.
  // Read-only trigger; runDomainCheck's own interval floor plus the IP-keyed
  // rate limit above are the two guards against hammering it.
  app.post(
    '/api/install/:installLinkId/domain/check',
    { config: { rateLimit: PUBLIC_INSTALL_RATE_LIMIT } },
    async (request) => {
      const { installLinkId } = request.params as { installLinkId: string };
      requireUuidId(installLinkId);
      const rows = await db
        .select()
        .from(schema.deployments)
        .where(eq(schema.deployments.installLinkId, installLinkId))
        .limit(1);
      const deployment = rows[0];
      if (!deployment) throw new NotFoundError('Installation not found');
      const domain = await findActiveDomain(db, deployment.id);
      if (!domain) throw new NotFoundError('Custom domain not found');
      const fresh = await runDomainCheck(db, deployment, domain, domainCheckDeps);
      return { domain: toDomainView(fresh) };
    },
  );

  // ── Events & diagnostics (§24, §29, §40) ────────────────────────────────

  // GET /api/deployments/:id/events — Event log
  app.get('/api/deployments/:id/events', { preHandler: requireAuth }, async (request) => {
    const { id } = request.params as { id: string };
    const organizationId = requireSessionOrganizationId(request);
    await loadOwnedDeployment(db, id, organizationId);
    const { limit, offset } = request.query as { limit?: string; offset?: string };
    const take = Math.min(Number(limit ?? 50), 200);
    const skip = Number(offset ?? 0);
    const rows = await db
      .select()
      .from(schema.eventLogs)
      .where(eq(schema.eventLogs.deploymentId, id))
      .orderBy(schema.eventLogs.occurredAt)
      .limit(take)
      .offset(skip);
    return { events: rows };
  });

  // GET /api/deployments/:id/stack-events — vendor CloudFormation diagnostics
  app.get('/api/deployments/:id/stack-events', { preHandler: requireAuth }, async (request) => {
    const { id } = request.params as { id: string };
    const organizationId = requireSessionOrganizationId(request);
    await loadOwnedDeployment(db, id, organizationId);
    const { limit } = request.query as { limit?: string };
    const take = Math.min(Number(limit ?? 100), 200);
    const rows = await db
      .select()
      .from(schema.deploymentStackEvents)
      .where(eq(schema.deploymentStackEvents.deploymentId, id))
      .orderBy(desc(schema.deploymentStackEvents.eventAt), desc(schema.deploymentStackEvents.id))
      .limit(take);
    const events: VendorStackEvent[] = rows.map((row) => ({
      id: row.id,
      eventAt: row.eventAt.toISOString(),
      logicalResourceId: row.logicalResourceId,
      resourceType: row.resourceType,
      resourceStatus: row.resourceStatus,
      resourceStatusReason: row.resourceStatusReason,
    }));
    return { events };
  });

  // GET /api/deployments/:id/diagnostics — Diagnostics (§29)
  app.get('/api/deployments/:id/diagnostics', { preHandler: requireAuth }, async (request) => {
    const { id } = request.params as { id: string };
    const organizationId = requireSessionOrganizationId(request);
    const deployment = await loadOwnedDeployment(db, id, organizationId);
    // A failed day-2 operation no longer marks the deployment itself FAILED
    // (the previous release keeps serving), but its diagnostics must stay
    // reachable — gate on "the most recent mutating attempt failed", with
    // the deployment state as the legacy fast path.
    const [latestMutating] = await db
      .select({ state: schema.deploymentJobs.state })
      .from(schema.deploymentJobs)
      .where(
        and(
          eq(schema.deploymentJobs.deploymentId, id),
          inArray(schema.deploymentJobs.type, [
            'INSTALL',
            'DEPLOY_RELEASE',
            'ROLLBACK',
            'RESTART',
            'CONFIG_UPDATE',
            'DESTROY',
            'PURGE',
          ]),
        ),
      )
      .orderBy(desc(schema.deploymentJobs.createdAt))
      .limit(1);
    if (deployment.state !== 'FAILED' && latestMutating?.state !== 'FAILED') {
      return { failureCode: null, recoverability: null, what: null, why: null, fix: null, events: [] };
    }
    const events = await db
      .select()
      .from(schema.eventLogs)
      .where(eq(schema.eventLogs.deploymentId, id))
      .orderBy(schema.eventLogs.occurredAt)
      .limit(10);
    // §61: report the code the relay actually gave for the failure. Falling
    // back to UNKNOWN when the job carried no code is honest; hardcoding it
    // when the job DOES carry one throws away the only classification we have.
    const [failedJob] = await db
      .select({
        id: schema.deploymentJobs.id,
        type: schema.deploymentJobs.type,
        failureCode: schema.deploymentJobs.failureCode,
        result: schema.deploymentJobs.result,
      })
      .from(schema.deploymentJobs)
      .where(and(eq(schema.deploymentJobs.deploymentId, id), eq(schema.deploymentJobs.state, 'FAILED')))
      .orderBy(desc(schema.deploymentJobs.finishedAt))
      .limit(1);
    // §29/§61: the remediation is looked up from the code the relay actually
    // reported. These three fields used to be string literals, identical for
    // every failure, and the fix line told the vendor to read an event log
    // that was never written and had no screen.
    const failureCode = failedJob?.failureCode ?? 'UNKNOWN';
    const remediation = FAILURE_REMEDIATION[failureCode as FailureCode] ?? FAILURE_REMEDIATION.UNKNOWN;
    // What the relay said, verbatim. Stored on the job all along and never
    // surfaced, which left "Technical detail" empty on every failure.
    const jobResult = failedJob?.result as { error?: string } | null;

    // §22/§23/§42: a KNOWN failure code is unambiguous — the deterministic
    // §65 copy map is the whole answer and AI is never consulted. Only
    // UNKNOWN, where the deterministic classifier had nothing to go on, is
    // worth spending a model call on.
    let explanation = remediation;
    if (failedJob && failureCode === 'UNKNOWN') {
      // §16: the AI explanation is built from the deterministic code plus
      // STRUCTURED fields only. There is no raw-log field here except this
      // one — `error.message` is the single free-text slot the boundary
      // permits, and it carries only the normalized, redacted, truncated
      // form of the job's error (never the raw text shown to the vendor
      // below).
      const errorMessage =
        typeof jobResult?.error === 'string' && jobResult.error.length > 0
          ? normalizeErrorText(jobResult.error, { maxLength: 500 })
          : undefined;
      const event: StructuredEvent = {
        source: 'deployment',
        ...(failedJob.type ? { action: failedJob.type } : {}),
        ...(errorMessage !== undefined ? { error: { message: errorMessage } } : {}),
        context: { deploymentState: deployment.state },
      };

      // Generated once per attempt and cached; `remediation` is the fallback
      // for every path where AI is unavailable, so the copy map stays the
      // single source of this copy (§65). Never throws, never touches
      // deployment state.
      explanation = await resolveExplanation(
        { db, gateway: aiGateway },
        { jobId: failedJob.id, failureCode, event },
        remediation,
      );
    }

    return {
      failureCode,
      // §61 recoverability — which affordance the UI should lead with
      // (wait/reconcile, fix-then-retry, contact support, or none).
      recoverability: failureRecoverability(failureCode),
      what: explanation.what,
      why: explanation.why,
      fix: explanation.fix,
      technicalDetail: jobResult?.error ?? null,
      events,
    };
  });

  // GET /api/deployments/:id/infrastructure — composed infrastructure
  // inventory (§59). Reads ONLY the persisted relay snapshot — the relay is
  // the single pipeline that observes AWS, so this route never calls it. A
  // stale or absent snapshot keeps the last-known rows; the connection
  // warning, not the statuses, surfaces the relay gap.
  app.get(
    '/api/deployments/:id/infrastructure',
    { preHandler: requireAuth },
    async (request) => {
      const { id } = request.params as { id: string };
      const organizationId = requireSessionOrganizationId(request);
      const deployment = await loadOwnedDeployment(db, id, organizationId);

      const resources = await db
        .select()
        .from(schema.deploymentResources)
        .where(eq(schema.deploymentResources.deploymentId, id))
        .orderBy(
          schema.deploymentResources.componentKind,
          schema.deploymentResources.logicalResourceId,
        );

      const now = Date.now();
      const lastHealthAt = deployment.lastHealthAt;
      const connected =
        deployment.relayStatus === 'CONNECTED' &&
        lastHealthAt !== null &&
        now - lastHealthAt.getTime() <= RELAY_STALE_AFTER_MS;

      let maxUpdatedAt: Date | null = null;
      for (const row of resources) {
        if (maxUpdatedAt === null || row.lastUpdatedAt.getTime() > maxUpdatedAt.getTime()) {
          maxUpdatedAt = row.lastUpdatedAt;
        }
      }
      const lastUpdatedAt = maxUpdatedAt;

      const snapshotState =
        resources.length === 0
          ? 'none'
          : lastUpdatedAt !== null && now - lastUpdatedAt.getTime() <= RELAY_STALE_AFTER_MS
            ? 'fresh'
            : 'stale';

      const observed = deployment.observedState as
        | { infraHealth?: { provisioning?: { stackStatus?: unknown } } }
        | null
        | undefined;
      const rawStackStatus = observed?.infraHealth?.provisioning?.stackStatus;

      const aggregate = aggregateInfrastructureComponents(
        resources.map((row) => ({
          ...row,
          // resource_status is text in the table; the persistence helper
          // only ever writes mapped values (mapResourceStatus in contracts).
          resourceStatus: row.resourceStatus as InfrastructureComponentStatus,
        })),
        { deploymentState: deployment.state, region: deployment.region },
      );

      // The aggregate rolls up to the component vocabulary ('ready'); the
      // wire summary presents it as 'healthy'.
      const summaryStatus: InfrastructureSummaryStatus =
        aggregate.summaryStatus === 'ready'
          ? 'healthy'
          : (aggregate.summaryStatus as InfrastructureSummaryStatus);

      const lastUpdatedAtIso = lastUpdatedAt?.toISOString() ?? null;

      return infrastructureResponseSchema.parse({
        provider: 'aws',
        region: deployment.region,
        stackStatus: typeof rawStackStatus === 'string' ? rawStackStatus : null,
        connectionState: connected ? 'connected' : 'disconnected',
        snapshotState,
        summary: {
          status: summaryStatus,
          componentCount: aggregate.components.length,
          technicalResourceCount: resources.length,
        },
        components: aggregate.components,
        lastUpdatedAt: lastUpdatedAtIso,
        disconnectWarning:
          !connected && snapshotState !== 'none' && lastUpdatedAt !== null
            ? { lastVerifiedAt: lastUpdatedAtIso }
            : null,
      });
    },
  );

  // ── Billing (§48) ───────────────────────────────────────────────────────

  // POST /api/billing/checkout — Create Stripe checkout session
  app.post('/api/billing/checkout', { preHandler: requireAuth }, async (request) => {
    const body = checkoutBodySchema.parse(request.body);
    const organizationId = resolveWriteOrganizationId(request, body.organizationId);
    const { url } = await createCheckoutSession(
      { db, stripe },
      { organizationId, customerEmail: request.user?.email },
    );
    return { url };
  });

  // GET /api/billing/summary — Billing summary
  app.get('/api/billing/summary', { preHandler: requireAuth }, async (request) => {
    const organizationId = requireSessionOrganizationId(request);
    // §48 line items are named by CUSTOMER ("Acme Corp  $19"), not by
    // application — join customers for the label. Billability comes from
    // isBillable (the single §48 rule, which also counts UPDATE_AVAILABLE);
    // re-deriving it inline here is what previously dropped UPDATE_AVAILABLE
    // deployments off the bill.
    const deployments = await db
      .select({
        customerName: schema.customers.name,
        applicationName: schema.applications.name,
        state: schema.deployments.state,
        isTestDeployment: schema.deployments.isTestDeployment,
      })
      .from(schema.deployments)
      .innerJoin(schema.applications, eq(schema.deployments.applicationId, schema.applications.id))
      .innerJoin(schema.customers, eq(schema.deployments.customerId, schema.customers.id))
      .where(eq(schema.deployments.organizationId, organizationId));
    const deploymentItems = deployments.filter(isBillable).map((d) => ({
      name: d.customerName,
      applicationName: d.applicationName,
      amount: METERED_PRICE_DOLLARS,
    }));
    const total = BASE_PRICE_DOLLARS + deploymentItems.length * METERED_PRICE_DOLLARS;

    // The billing screen has to tell "never subscribed" from "subscribed" from
    // "payment failed" — without it the page showed charges for a subscription
    // that may not exist, and offered no way to start one.
    const [subscription] = await db
      .select({
        status: schema.subscriptions.status,
        currentPeriodEnd: schema.subscriptions.currentPeriodEnd,
      })
      .from(schema.subscriptions)
      .where(eq(schema.subscriptions.organizationId, organizationId))
      .limit(1);

    return {
      base: BASE_PRICE_DOLLARS,
      deployments: deploymentItems,
      total,
      subscription: subscription ?? null,
    };
  });

  // ── Onboarding (§42) ────────────────────────────────────────────────────

  // GET /api/onboarding — where the organization stands on the six §42
  // steps. The step KEYS are the wire contract; the labels stay in the copy
  // map (§65) so there is one source of copy, not two.
  //
  // The counts below read row LENGTH, not a `count` alias over a uuid column:
  // the previous shape aliased applications.id as `count` and put it through
  // Number(), which is NaN for a uuid, so every step read as incomplete.
  app.get('/api/onboarding', { preHandler: requireAuth }, async (request) => {
    const organizationId = requireSessionOrganizationId(request);
    const applications = await db
      .select({
        analysisStatus: schema.applications.analysisStatus,
        compatibilityStatus: schema.applications.compatibilityStatus,
      })
      .from(schema.applications)
      .where(eq(schema.applications.organizationId, organizationId));
    const deployments = await db
      .select({ state: schema.deployments.state })
      .from(schema.deployments)
      .where(eq(schema.deployments.organizationId, organizationId));

    const hasApplication = applications.length > 0;
    const analysed = applications.some((row) => row.analysisStatus === 'COMPLETE');
    const compatible = applications.some((row) => row.compatibilityStatus === 'READY');
    const hasDeployment = deployments.length > 0;
    // §5: the success moment is readiness — a deployment that actually runs.
    const ready = compatible && deployments.some((row) => row.state === 'HEALTHY');

    const steps = [
      { step: 'connect_github', completed: hasApplication },
      { step: 'choose_repository', completed: hasApplication },
      { step: 'analyse', completed: analysed },
      { step: 'fix_compatibility', completed: compatible },
      { step: 'create_test_deployment', completed: hasDeployment },
      { step: 'ready_for_customer_deployment', completed: ready },
    ];
    const firstIncomplete = steps.findIndex((step) => !step.completed);
    return { steps, currentStep: firstIncomplete === -1 ? steps.length : firstIncomplete + 1 };
  });

  // Better Auth over Fastify: construct a Fetch Request, call auth.handler,
  // forward status/headers/body. Official recipe from the docs.
  app.route({
    method: ['GET', 'POST'],
    url: '/api/auth/*',
    handler: async (request, reply) => {
      // Resolve against the canonical API origin rather than the request's
      // Host header. Two reasons: API Gateway terminates TLS, so the old
      // hardcoded `http://` handed Better Auth an http origin that failed its
      // own https origin check; and Host is client-controlled, which made this
      // a header-injection surface on the auth endpoint. request.url is a path
      // plus query, so this keeps both and guarantees the origin matches the
      // baseURL Better Auth was configured with.
      const url = new URL(request.url, env.apiUrl);
      const headers = fromNodeHeaders(request.headers);
      const init: RequestInit = {
        method: request.method,
        headers,
        ...(request.body ? { body: JSON.stringify(request.body) } : {}),
      };

      const response = await auth.handler(new Request(url.toString(), init));

      reply.status(response.status);
      // set-cookie must survive as separate header lines (squashing breaks the
      // browser); content-length is recomputed by Fastify.
      response.headers.forEach((value, key) => {
        const lower = key.toLowerCase();
        if (lower !== 'set-cookie' && lower !== 'content-length') {
          reply.header(key, value);
        }
      });
      const setCookies =
        typeof response.headers.getSetCookie === 'function'
          ? response.headers.getSetCookie()
          : [];
      if (setCookies.length > 0) {
        reply.header('set-cookie', setCookies);
      }
      return reply.send(response.body ? await response.text() : null);
    },
  });

  // ── Relay endpoints (bearer-token auth, not session cookie) ─────────
  //
  // The relay authenticates with a bearer token registered at install time
  // (see relay-store.ts). Every route below resolves the calling deployment
  // FROM THE VERIFIED TOKEN, never from a client-supplied id alone — an
  // installationId is public (it's in the install URL), so it cannot be the
  // credential.

  async function requireRelayDeployment(
    installationId: string | undefined,
    token: string,
    oldToken?: string | undefined,
  ): Promise<DeploymentRow> {
    if (!installationId) {
      throw new ApiError(400, 'INSTALLATION_ID_REQUIRED', 'installationId is required');
    }
    const rows = await db
      .select()
      .from(schema.deployments)
      .where(eq(schema.deployments.installationId, installationId))
      .limit(1);
    const deployment = rows[0];
    if (!deployment || !verifyRelayTokenWithRotation(deployment.relayTokenHash, token, oldToken)) {
      throw new ApiError(401, 'UNAUTHORIZED', 'Invalid relay credentials');
    }
    return deployment;
  }

  /** The rotation grace header the relay sends while adopting a new token. */
  function oldRelayToken(request: { headers: Record<string, unknown> }): string | undefined {
    const value = request.headers['x-deployz-old-token'];
    return typeof value === 'string' && value.length > 0 ? value : undefined;
  }

  /** The bearer token the relay presents. */
  function requireBearerToken(request: { headers: Record<string, unknown> }): string {
    const authHeader = request.headers.authorization as string | undefined;
    if (!authHeader?.startsWith('Bearer ')) {
      throw new ApiError(401, 'UNAUTHORIZED', 'Missing bearer token');
    }
    return authHeader.slice(7);
  }

  // ── Runtime digest reconciliation ──────────────────────────────────────
  //
  // The relay reports the sha256 digest actually running in ECS. Reconcile
  // it against releases so a deployment whose pointer drifted (manual AWS
  // change, repaired build, lost update) tells the truth again — but never
  // while a mutating job is in flight, which would make the pointer
  // ambiguous.

  /** Normalizes `repository@sha256:…` and bare `sha256:…` to `sha256:…`. */
  function digestSuffix(imageDigest: string | null): string | null {
    if (!imageDigest) return null;
    const at = imageDigest.lastIndexOf('@');
    return (at >= 0 ? imageDigest.slice(at + 1) : imageDigest).toLowerCase();
  }

  type JobTypeValue = NonNullable<(typeof schema.deploymentJobs.$inferSelect)['type']>;
  type JobStateValue = NonNullable<(typeof schema.deploymentJobs.$inferSelect)['state']>;

  const MUTATING_JOB_TYPES: readonly JobTypeValue[] = [
    'INSTALL',
    'DEPLOY_RELEASE',
    'ROLLBACK',
    'RESTART',
    'CONFIG_UPDATE',
    'DESTROY',
    'MIGRATION',
    'INFRA_UPGRADE',
  ];
  const ACTIVE_JOB_STATES: readonly JobStateValue[] = ['REQUESTED', 'QUEUED', 'WAITING', 'RUNNING'];

  /**
   * §10.3 the promotion gate's observational half: whether ONE heartbeat's
   * observedState shows a fully rolled-out, healthy release. Every layer the
   * relay reported must pass — ECS rollout COMPLETED, expected task count up,
   * no unhealthy/pending/unclassified ALB targets, and a successful HTTP
   * probe. A signal the relay did not report (older relay, unreadable AWS)
   * is not an obstacle, but a reported failure in any layer blocks promotion:
   * a partially-rolled-out service must never become current.
   */
  function releasePromotionGatesPass(observedState: Record<string, unknown> | null | undefined): boolean {
    if (!observedState || typeof observedState !== 'object') return false;

    const rollout = observedState['deploymentRolloutState'];
    if (rollout !== undefined && rollout !== null && rollout !== 'COMPLETED') return false;

    // HTTP probe: when one was taken this poll, only a successful one passes.
    const probe = observedState['httpProbe'] as { ok?: unknown } | null | undefined;
    if (probe !== undefined && probe !== null && probe.ok !== true) return false;

    const desired = observedState['desiredCount'];
    const running = observedState['runningCount'];
    if (typeof desired === 'number' && typeof running === 'number' && desired > 0 && running < desired) {
      return false;
    }
    for (const key of ['unhealthyTargetCount', 'pendingTargetCount', 'unknownTargetCount']) {
      const count = observedState[key];
      if (typeof count === 'number' && count > 0) return false;
    }
    return true;
  }

  async function reconcileRunningDigest(
    deployment: DeploymentRow,
    runningImageDigest: string | null,
    observedState: Record<string, unknown> | null,
  ): Promise<void> {
    const digest = digestSuffix(runningImageDigest);
    if (!digest) return;

    if (deployment.currentReleaseId) {
      const currentRows = await db
        .select({ imageDigest: schema.releases.imageDigest })
        .from(schema.releases)
        .where(eq(schema.releases.id, deployment.currentReleaseId))
        .limit(1);
      if (digestSuffix(currentRows[0]?.imageDigest ?? null) === digest) return; // Already truthful.
    }

    const activeJobs = await db
      .select({ id: schema.deploymentJobs.id })
      .from(schema.deploymentJobs)
      .where(
        and(
          eq(schema.deploymentJobs.deploymentId, deployment.id),
          inArray(schema.deploymentJobs.state, ACTIVE_JOB_STATES),
          inArray(schema.deploymentJobs.type, MUTATING_JOB_TYPES),
        ),
      )
      .limit(1);
    if (activeJobs.length > 0) return; // A job owns the pointer right now.

    const releases = await db
      .select()
      .from(schema.releases)
      .where(eq(schema.releases.applicationId, deployment.applicationId));
    const matches = releases.filter(
      (release) => release.releaseStatus === 'READY' && digestSuffix(release.imageDigest) === digest,
    );
    // Zero matches: the raw digest stays in observedState and the runtime
    // version renders as unknown. More than one: the same image built under
    // two versions — reconciling would be a guess, so it stays as-is.
    if (matches.length !== 1) return;
    const reconciled = matches[0]!;
    if (reconciled.id === deployment.currentReleaseId) return;

    // §10.3 promotion gate: a release only becomes current on the strength of
    // THIS heartbeat's observations, and only when every one of them passes —
    // the ECS rollout completed, the expected task count is up, no ALB target
    // is unhealthy/pending/unknown, and the HTTP probe succeeded. A
    // partially-rolled-out or failing application is never promoted.
    if (!releasePromotionGatesPass(observedState)) return;

    await db.transaction(async (tx) => {
      await tx
        .update(schema.deployments)
        .set({
          currentReleaseId: reconciled.id,
          previousReleaseId: deployment.currentReleaseId,
        })
        .where(eq(schema.deployments.id, deployment.id));
      await recordEvent(tx, {
        organizationId: deployment.organizationId,
        eventType: 'deployment.reconciled',
        actorType: 'relay',
        actorId: deployment.installationId ?? deployment.id,
        deploymentId: deployment.id,
        customerId: deployment.customerId,
        releaseId: reconciled.id,
        previousState: deployment.currentReleaseId,
        requestedState: reconciled.id,
        result: 'success',
        payload: {
          source: 'runtime-observation',
          previousReleaseId: deployment.currentReleaseId,
          reconciledReleaseId: reconciled.id,
          imageDigest: digest,
        },
      });
    });
  }

  app.post('/api/relay/register', async (request, reply) => {
    const token = requireBearerToken(request);
    const body = request.body as {
      enrollmentCode?: string;
      installationId?: string;
      awsAccountId?: string;
      relayVersion?: string;
      bootstrapVersion?: string;
      capabilities?: unknown;
    };
    if (!body?.enrollmentCode || !body?.installationId) {
      throw new ApiError(
        400,
        'INVALID_REQUEST',
        'enrollmentCode and installationId are required',
      );
    }
    const capabilitiesParsed = relayCapabilitiesSchema.safeParse(body.capabilities);

    // The enrollment code — not the installation id — is what identifies the
    // deployment. The id is minted by the customer's own bootstrap stack and
    // is unknown here until this call; the code is minted by the control
    // plane, carried into the stack as a template parameter, and burned on
    // first use. Anything else and there is nothing tying a relay in some AWS
    // account to a deployment a vendor created.
    const rows = await db
      .select()
      .from(schema.deployments)
      .where(eq(schema.deployments.enrollmentCode, body.enrollmentCode))
      .limit(1);
    const deployment = rows[0];
    if (!deployment) {
      throw new NotFoundError('Deployment not found');
    }

    const tokenHash = hashRelayToken(token);

    if (deployment.enrollmentUsedAt !== null) {
      // Already enrolled. A relay cold start or a retry replays this call
      // with the same id and token, which must stay harmless.
      const sameRelay =
        deployment.installationId === body.installationId &&
        verifyRelayToken(deployment.relayTokenHash, token);
      if (sameRelay) {
        return reply.code(200).send({ registered: true });
      }
      // Anything else is a second party trying to take the deployment over.
      // Refusing (rather than rebinding, which is what this route used to do)
      // is what keeps the real relay connected; the vendor recovers with
      // "Reconnect relay", which mints a fresh code.
      await recordEvent(db, {
        organizationId: deployment.organizationId,
        eventType: 'install.enrollment.rejected',
        actorType: 'relay',
        actorId: body.installationId,
        deploymentId: deployment.id,
        customerId: deployment.customerId,
        result: 'failure',
        payload: { reason: 'enrollment code already used by another relay' },
      });
      throw new ApiError(
        409,
        'RELAY_ALREADY_ENROLLED',
        'This installation is already connected. Ask the vendor to reconnect it before installing again.',
      );
    }

    // §6/§39: an INSTALL job must be reachable through the API so a fresh
    // deployment can ever progress past the pre-install states. We create it
    // here (first relay registration) rather than at deployment-creation
    // time — the deployment row can legitimately exist before any relay has
    // called home, and this is the first point where we know the relay is
    // alive. WAITING_FOR_RELAY is the same first-install case with the
    // launch signal already recorded.
    // Phase 3 readiness gate: the relay registering is the final boundary
    // before an INSTALL job is minted. Re-evaluate the stored manifest in case
    // application overrides changed after the deployment was created.
    requireReadyManifest(deployment.desiredState);

    const firstInstall =
      deployment.state === 'NOT_INSTALLED' || deployment.state === 'WAITING_FOR_RELAY';
    const installJob =
      firstInstall
        ? (
            await createOrReuseJob(db, {
              deploymentId: deployment.id,
              type: 'INSTALL',
              idempotencyKey: `${deployment.id}:INSTALL`,
              payload: {
                parameters: await buildInstallParameters(db, deployment.id),
                redisRequired: await readRedisRequired(db, deployment.applicationId),
                // The canonical manifest this deployment was created with — the
                // relay derives port/health/binding parameters from it (Phase 2).
                manifest: readStoredManifest(deployment.desiredState),
              },
              requestedBy: null,
            })
          ).job
        : null;

    await db.transaction(async (tx) => {
      await tx
        .update(schema.deployments)
        .set({
          installationId: body.installationId!,
          relayTokenHash: tokenHash,
          relayBoundAt: new Date(),
          enrollmentUsedAt: new Date(),
          relayStatus: 'CONNECTED',
          // §24 the customer's account id is knowable only from inside their
          // account; the relay is the only thing that can tell us.
          ...(body.awsAccountId ? { awsAccountId: body.awsAccountId } : {}),
          ...(typeof body.relayVersion === 'string' ? { relayVersion: body.relayVersion } : {}),
          ...(typeof body.bootstrapVersion === 'string' ? { bootstrapVersion: body.bootstrapVersion } : {}),
          ...(capabilitiesParsed.success ? { relayCapabilities: capabilitiesParsed.data } : {}),
          ...(deployment.state === 'NOT_INSTALLED' || deployment.state === 'WAITING_FOR_RELAY'
            ? { state: 'INSTALLING' as const }
            : {}),
        })
        .where(eq(schema.deployments.id, deployment.id));

      if (installJob) {
        await recordEvent(tx, {
          organizationId: deployment.organizationId,
          eventType: 'install.requested',
          actorType: 'relay',
          actorId: body.installationId!,
          deploymentId: deployment.id,
          customerId: deployment.customerId,
          jobId: installJob.id,
          previousState: deployment.state,
          requestedState: 'INSTALLING',
          result: 'pending',
        });
      }
    });

    // Phase 1.1: a just-enrolled relay's customer account needs pull access to
    // the vendor ECR before the INSTALL job queued above can ever start a task
    // that pulls the image. Idempotent + best-effort: an already-granted
    // installation (replay) is a no-op policy write, and a grant failure logs
    // and surfaces later as the customer task's IMAGE_PULL_FAILED.
    if (installJob && typeof body.awsAccountId === 'string' && body.awsAccountId.length > 0) {
      await grantPullToCustomer(ecrGrantDeps, body.installationId!, body.awsAccountId);
    }

    return reply.code(200).send({ registered: true });
  });

  // §39 relay command channel, backed by deployment_jobs (not the old
  // write-only in-memory map). Picking up REQUESTED/QUEUED jobs transitions
  // them to RUNNING so a retried poll does not hand out the same command
  // twice while it's in flight.
  app.get('/api/relay/commands', async (request) => {
    const token = requireBearerToken(request);
    const { installationId } = request.query as { installationId?: string };
    const deployment = await requireRelayDeployment(installationId, token);

    // Atomic claim: transition and read in one statement, so two overlapping
    // polls (a client retry racing the original) can never both receive the
    // same command — the second poll's UPDATE matches zero rows. WAITING jobs
    // are claimed back too: the watchdog parks a job there when the relay
    // goes quiet mid-operation, and this poll IS the relay returning.
    const jobs = (
      await db
        .update(schema.deploymentJobs)
        .set({ state: 'RUNNING', startedAt: new Date(), lastProgressAt: new Date() })
        .where(
          and(
            eq(schema.deploymentJobs.deploymentId, deployment.id),
            inArray(schema.deploymentJobs.state, ['REQUESTED', 'QUEUED', 'WAITING']),
          ),
        )
        .returning()
    ).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

    // Payload redaction rides the claim: the relay reads the value ONCE from
    // this response (built from the pre-redaction rows below); the stored row
    // keeps only the shape without plaintext (see `redactClaimedPayload`).
    for (const job of jobs) {
      await db
        .update(schema.deploymentJobs)
        .set({
          // The payload column is NOT NULL; a null redaction (defensive
          // only — the column never stores null) falls back to {}.
          payload: redactClaimedPayload(job) ?? {},
        })
        .where(eq(schema.deploymentJobs.id, job.id));
    }

    // Deployment facts the observe hook needs but no command carries: the
    // heartbeat runs outside any command, so this poll response is the only
    // channel that reaches it.
    const appRows = await db
      .select({ redisRequired: schema.applications.redisRequired, healthPath: schema.applications.healthPath })
      .from(schema.applications)
      .where(eq(schema.applications.id, deployment.applicationId))
      .limit(1);

    // §10.2: the probe URL is built from the stack's PublicEndpoint output
    // (the successful INSTALL's result) plus the configured health path.
    const installJobs = await db
      .select({ result: schema.deploymentJobs.result, state: schema.deploymentJobs.state, type: schema.deploymentJobs.type })
      .from(schema.deploymentJobs)
      .where(eq(schema.deploymentJobs.deploymentId, deployment.id))
      .orderBy(schema.deploymentJobs.createdAt);

    return {
      commands: jobs.map((job) => ({
        id: job.id,
        deploymentId: deployment.id,
        type: job.type,
        idempotencyKey: job.idempotencyKey,
        payload: job.payload,
      })),
      deployment: {
        redisRequired: appRows[0]?.redisRequired ?? false,
        probeUrl: resolveProbeUrl(installJobs, appRows[0]?.healthPath ?? null),
      },
    };
  });

  app.post('/api/relay/commands/:id/result', async (request, reply) => {
    const token = requireBearerToken(request);
    const { id } = request.params as { id: string };
    requireUuidId(id);

    const jobRows = await db.select().from(schema.deploymentJobs).where(eq(schema.deploymentJobs.id, id)).limit(1);
    if (jobRows.length === 0) {
      throw new NotFoundError('Job not found');
    }
    const job = jobRows[0]!;

    const deploymentRows = await db
      .select()
      .from(schema.deployments)
      .where(eq(schema.deployments.id, job.deploymentId))
      .limit(1);
    const deployment = deploymentRows[0];
    if (
      !deployment ||
      !verifyRelayTokenWithRotation(deployment.relayTokenHash, token, oldRelayToken(request))
    ) {
      throw new ApiError(401, 'UNAUTHORIZED', 'Invalid relay credentials');
    }

    // A settled job never reprocesses: a late duplicate result (the relay's
    // earlier report timed out and it retried, or the job was already
    // force-completed/cancelled) must not flip the deployment state again or
    // recompute release pointers against a since-changed deployment row.
    if (!['REQUESTED', 'QUEUED', 'WAITING', 'RUNNING'].includes(job.state)) {
      return reply.code(200).send({ received: true, alreadySettled: true });
    }

    const body = request.body as {
      success?: boolean;
      error?: string;
      output?: Record<string, unknown>;
      failureCode?: string;
    };
    const state = body.success === false ? 'FAILED' : 'SUCCEEDED';
    const failureCodeParsed = state === 'FAILED' ? failureCodeSchema.safeParse(body.failureCode) : undefined;
    // A code the enum does not know used to be dropped on the floor, which
    // left the vendor looking at "Unknown issue" with no trace of what the
    // relay actually said. Keep the raw string in the event payload so a
    // vocabulary drift is visible in the audit trail instead of silent.
    const unrecognisedFailureCode =
      state === 'FAILED' && body.failureCode !== undefined && !failureCodeParsed?.success
        ? body.failureCode
        : undefined;

    // §61 server-side refinement: the relay hardcodes coarse defaults (every
    // INSTALL failure is STACK_CREATE_FAILED, most thrown exceptions become
    // AWS_PERMISSION_DENIED). Sharpen those using the error text and the
    // persisted CloudFormation events for this job, so remediation copy
    // matches the real cause — for every installation, old relays included.
    const reportedFailureCode = failureCodeParsed?.success ? failureCodeParsed.data : null;
    let effectiveFailureCode = reportedFailureCode;
    if (state === 'FAILED') {
      const stackEvents =
        job.type === 'INSTALL' || job.type === 'DESTROY'
          ? await db
              .select({
                resourceType: schema.deploymentStackEvents.resourceType,
                resourceStatus: schema.deploymentStackEvents.resourceStatus,
                resourceStatusReason: schema.deploymentStackEvents.resourceStatusReason,
              })
              .from(schema.deploymentStackEvents)
              .where(
                and(
                  eq(schema.deploymentStackEvents.deploymentId, deployment.id),
                  eq(schema.deploymentStackEvents.jobId, job.id),
                ),
              )
              .orderBy(schema.deploymentStackEvents.eventAt)
          : [];
      effectiveFailureCode = refineFailureCode({
        reported: reportedFailureCode,
        errorText: body.error ?? null,
        stackEvents,
      });
    }

    // A finished job is what advances the deployment's own §46 state.
    // Domain jobs manage the custom_domains row, never the deployment
    // lifecycle — a failed cert request must not mark the deployment FAILED.
    // A failed day-2 operation on a deployment with a running release keeps
    // the deployment in a live state (deploymentStateAfterFailedJob): the
    // previous release is still serving, and the FAILED job itself carries
    // the failure for the status derivation to surface.
    const nextState = isDomainJobType(job.type)
      ? undefined
      : state === 'FAILED'
        ? (deploymentStateAfterFailedJob({
            jobType: job.type,
            hasCurrentRelease: deployment.currentReleaseId !== null,
            newerReadyReleaseExists: await newerReadyReleaseExists(
              db,
              deployment.applicationId,
              deployment.currentReleaseId,
            ),
          }) ?? undefined)
        : JOB_SUCCESS_STATE[job.type];
    // The release this job rolled out, for the audit event only. §10.3: a
    // DEPLOY_RELEASE/ROLLBACK success must NOT advance the release pointers
    // here — the relay has settled ECS (rollout + targets), but promotion
    // also needs the observed HTTP probe healthy, which only arrives on the
    // heartbeat. The heartbeat's digest reconciliation advances the pointer
    // once every gate passes, so a partially-rolled-out service is never
    // promoted on the relay's word alone.
    const releaseId =
      state === 'SUCCEEDED' && RELEASE_ADVANCING_JOBS.has(job.type)
        ? ((job.payload as { releaseId?: string } | null)?.releaseId ?? null)
        : null;

    await db.transaction(async (tx) => {
      await tx
        .update(schema.deploymentJobs)
        .set({
          state,
          result: body as Record<string, unknown>,
          finishedAt: new Date(),
          lastProgressAt: new Date(),
          ...(effectiveFailureCode ? { failureCode: effectiveFailureCode } : {}),
        })
        .where(eq(schema.deploymentJobs.id, id));

      if (isDomainJobType(job.type)) {
        await applyDomainJobResult(tx, deployment, job, body);
      }

      if (nextState) {
        await tx
          .update(schema.deployments)
          .set({
            state: nextState,
            // §10.3 keeps CURRENT-release promotion gated on the heartbeat's
            // digest reconciliation, but the rollback's own bookkeeping is
            // job truth: the release this rollback replaced is the pointer
            // the deployment carried into it. currentReleaseId itself still
            // only moves via the gated reconciliation.
            ...(state === 'SUCCEEDED' && job.type === 'ROLLBACK'
              ? { previousReleaseId: deployment.currentReleaseId }
              : {}),
            ...(nextState === 'DELETED' ? { deletedAt: new Date() } : {}),
          })
          .where(eq(schema.deployments.id, deployment.id));
      }

      // Safety net: a DESTROY success means the whole stack (and with it any
      // custom domain's ALB listener/routing) is gone regardless of whether
      // its own REMOVE_DOMAIN job ever reported back. Force it removed so it
      // never lingers as a phantom "removing" row for a deployment that no
      // longer exists.
      if (job.type === 'DESTROY' && nextState === 'DELETED') {
        const danglingDomain = await findActiveDomain(tx, deployment.id);
        if (danglingDomain) {
          await tx
            .update(schema.customDomains)
            .set({ removedAt: new Date() })
            .where(eq(schema.customDomains.id, danglingDomain.id));
        }
      }

      // A successful PURGE is what clears the retained-resources warning:
      // the relay verified and removed every owned leftover. The deployment
      // state itself never moves — it was already DELETED.
      if (job.type === 'PURGE' && state === 'SUCCEEDED') {
        await tx
          .update(schema.deployments)
          .set({ cleanupState: 'COMPLETE' })
          .where(eq(schema.deployments.id, deployment.id));
      }
      // A failed PURGE must NOT resurrect the deployment (never back to
      // FAILED — deploymentStateAfterFailedJob already returns null for it):
      // the cleanup lifecycle is separate, so the failure records itself on
      // cleanupState instead, keeping the deployment DELETED and the purge
      // retryable from the PURGE_FAILED state.
      if (job.type === 'PURGE' && state === 'FAILED') {
        await tx
          .update(schema.deployments)
          .set({ cleanupState: 'PURGE_FAILED' })
          .where(eq(schema.deployments.id, deployment.id));
      }

      const eventType = JOB_RESULT_EVENT[job.type]?.[state === 'FAILED' ? 'failed' : 'completed'];
      if (eventType) {
        await recordEvent(tx, {
          organizationId: deployment.organizationId,
          eventType,
          actorType: 'relay',
          actorId: deployment.installationId ?? deployment.id,
          deploymentId: deployment.id,
          customerId: deployment.customerId,
          jobId: job.id,
          releaseId: releaseId ?? undefined,
          previousState: deployment.state,
          requestedState: nextState ?? null,
          result: state === 'FAILED' ? 'failure' : 'success',
          payload: {
            ...(body.error ? { error: body.error } : {}),
            ...(effectiveFailureCode ? { failureCode: effectiveFailureCode } : {}),
            // Audit trail: what the relay itself said, when refinement
            // changed it — the classification decision stays traceable.
            ...(reportedFailureCode && reportedFailureCode !== effectiveFailureCode
              ? { reportedFailureCode }
              : {}),
            ...(unrecognisedFailureCode ? { unrecognisedFailureCode } : {}),
          },
        });
      }
    });

    // Best-effort step-timings follow-up (see advanceStepTimingsAfterWrite) —
    // derived from the values THIS request just wrote, not the stale
    // pre-transaction `deployment`. The release pointers are deliberately
    // absent: promotion happens on the heartbeat (§10.3).
    try {
      await advanceStepTimingsAfterWrite(db, {
        ...deployment,
        ...(nextState ? { state: nextState } : {}),
      });
    } catch (error) {
      request.log.warn({ err: error }, 'step-timings advance failed');
    }

    // Phase 1.1 side effects, best-effort after the transaction — neither may
    // fail the /result response:
    //  - INSTALL success auto-queues the deploy of the newest READY release.
    //  - DESTROY/PURGE success revokes the customer's ECR pull grant (both
    //    revocations are idempotent, whichever lands first).
    // A replay of an already-reported result re-runs both: the deploy enqueue
    // reuses its idempotency key and the revoke is a no-op policy read.
    if (job.type === 'INSTALL' && state === 'SUCCEEDED') {
      try {
        await autoDeploySelectedRelease(deployment);
      } catch (error) {
        request.log.warn({ err: error }, 'auto-deploy after install failed');
      }
    }
    if ((job.type === 'DESTROY' || job.type === 'PURGE') && state === 'SUCCEEDED') {
      const installationId = deployment.installationId;
      if (installationId) {
        await revokePullFromCustomer(ecrGrantDeps, installationId);
      }
    }

    return reply.code(200).send({ received: true });
  });

  // Relay stack-event progress ingest: fed by the relay while an INSTALL or
  // DESTROY job is mid-flight, well before /result ever reports. Auth mirrors
  // /health's (installationId travels in the body, not derived from the job)
  // rather than /result's job-first lookup — the job named in :id is
  // cross-checked against the authenticated deployment below, so a relay can
  // never probe another deployment's job ids: it gets the same 404 as an
  // unknown one.
  app.post('/api/relay/commands/:id/progress', async (request, reply) => {
    const token = requireBearerToken(request);
    const { id } = request.params as { id: string };
    requireUuidId(id);

    const rawBody = request.body as { installationId?: string } | undefined;
    const deployment = await requireRelayDeployment(rawBody?.installationId, token, oldRelayToken(request));

    const parsed = relayCommandProgressSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ApiError(400, 'INVALID_REQUEST', 'Invalid progress payload');
    }
    const body = parsed.data;

    const jobRows = await db.select().from(schema.deploymentJobs).where(eq(schema.deploymentJobs.id, id)).limit(1);
    const job = jobRows[0];
    if (!job || job.deploymentId !== deployment.id) {
      throw new NotFoundError('Job not found');
    }
    if (job.type !== 'INSTALL' && job.type !== 'DESTROY') {
      throw new ApiError(409, 'UNSUPPORTED_JOB_TYPE', 'Progress ingest is only supported for INSTALL and DESTROY jobs');
    }

    const now = new Date();
    const insertedRows = await db
      .insert(schema.deploymentStackEvents)
      .values(
        body.events.map((event) => ({
          deploymentId: deployment.id,
          jobId: job.id,
          providerEventId: event.eventId,
          eventAt: new Date(event.timestamp),
          logicalResourceId: event.logicalResourceId,
          resourceType: event.resourceType,
          resourceStatus: event.resourceStatus,
          resourceStatusReason: event.resourceStatusReason
            ? redactSecrets(event.resourceStatusReason).slice(0, 500)
            : null,
        })),
      )
      .onConflictDoNothing({
        target: [schema.deploymentStackEvents.deploymentId, schema.deploymentStackEvents.providerEventId],
      })
      .returning();
    const accepted = insertedRows.length;

    await db
      .update(schema.deploymentJobs)
      .set({ lastProgressAt: now })
      .where(eq(schema.deploymentJobs.id, job.id));

    if (job.type === 'INSTALL' && (job.state === 'RUNNING' || job.state === 'WAITING')) {
      const eventRows = await db
        .select()
        .from(schema.deploymentStackEvents)
        .where(
          and(
            eq(schema.deploymentStackEvents.deploymentId, deployment.id),
            eq(schema.deploymentStackEvents.jobId, job.id),
          ),
        )
        .orderBy(schema.deploymentStackEvents.eventAt, schema.deploymentStackEvents.id);
      const storedEvents: StoredStackEvent[] = eventRows.map((row) => ({
        eventAt: row.eventAt,
        logicalResourceId: row.logicalResourceId,
        resourceType: row.resourceType,
        resourceStatus: row.resourceStatus,
        resourceStatusReason: row.resourceStatusReason,
      }));
      const snapshot = summarizeStackEvents(body.stackName, storedEvents, now.toISOString());
      if (snapshot !== null) {
        const existingObservedState = deployment.observedState;
        const nextObservedState = {
          ...(existingObservedState ?? {}),
          infraHealth: {
            ...((existingObservedState?.['infraHealth'] as Record<string, unknown>) ?? {}),
            provisioning: snapshot,
          },
        };
        await db
          .update(schema.deployments)
          .set({ observedState: nextObservedState })
          .where(eq(schema.deployments.id, deployment.id));

        try {
          await advanceStepTimingsAfterWrite(db, { ...deployment, observedState: nextObservedState });
        } catch (error) {
          request.log.warn({ err: error }, 'step-timings advance failed');
        }
      }
    }

    request.log.info({
      deploymentId: deployment.id,
      jobId: job.id,
      stackName: body.stackName,
      accepted,
      event: 'relay:stack-events-ingested',
    });

    return reply.code(200).send({ accepted });
  });

  app.post('/api/relay/health', async (request, reply) => {
    const token = requireBearerToken(request);
    const body = request.body as {
      installationId?: string;
      observedState?: Record<string, unknown>;
      healthStatus?: string;
      components?: Record<string, unknown>;
      runningImageDigest?: string | null;
      identity?: {
        awsAccountId?: string;
        relayVersion?: string;
        bootstrapVersion?: string;
        capabilities?: unknown;
      };
    };
    const deployment = await requireRelayDeployment(
      body?.installationId,
      token,
      oldRelayToken(request),
    );

    const healthStatusParsed = healthStatusSchema.safeParse(body.healthStatus);
    // Identity rides every heartbeat (token-authenticated), so a deployment
    // enrolled before these columns existed self-repairs its account id,
    // relay version and capabilities without re-enrollment.
    const identity = body?.identity;
    const capabilitiesParsed = identity?.capabilities
      ? relayCapabilitiesSchema.safeParse(identity.capabilities)
      : undefined;
    // §24 per-component health rides in observed_state — the column already
    // exists for exactly this and needs no migration. The relay reports only
    // the components a deployment actually has, which is what lets the detail
    // page stop rendering a Database row for an app with no database.
    const componentsParsed = body.components
      ? healthComponentsSchema.safeParse(body.components)
      : undefined;
    const observedState =
      componentsParsed?.success === true
        ? { ...(body.observedState ?? deployment.observedState ?? {}), components: componentsParsed.data }
        : (body.observedState ?? deployment.observedState);
    // The runtime digest rides observedState too, so the raw truth survives
    // even when it cannot be reconciled to a release.
    if (body?.runningImageDigest !== undefined) {
      (observedState as Record<string, unknown>)['runningImageDigest'] = body.runningImageDigest;
    }

    // §10.2 HTTP probe ingest: the relay reports what it measured this poll
    // (status/latency/time — never a body); the control plane maintains the
    // last-success / last-failed timestamps across heartbeats so the record
    // always answers "when did this app last answer?" as well as "what did it
    // answer just now?". A malformed probe is dropped untouched — an old relay
    // sending none keeps whatever was already stored.
    const rawProbe = (observedState as Record<string, unknown> | null)?.['httpProbe'];
    const probeParsed = rawProbe === undefined ? undefined : httpProbeSchema.safeParse(rawProbe);
    if (probeParsed?.success === true) {
      const previousProbe = (deployment.observedState as { httpProbe?: Record<string, unknown> } | null)
        ?.httpProbe;
      const previousLastSuccessAt =
        typeof previousProbe?.['lastSuccessAt'] === 'string'
          ? (previousProbe['lastSuccessAt'] as string)
          : null;
      const previousLastFailedAt =
        typeof previousProbe?.['lastFailedAt'] === 'string'
          ? (previousProbe['lastFailedAt'] as string)
          : null;
      (observedState as Record<string, unknown>)['httpProbe'] = {
        ok: probeParsed.data.ok,
        statusCode: probeParsed.data.statusCode,
        latencyMs: probeParsed.data.latencyMs,
        checkedAt: probeParsed.data.checkedAt,
        ...(probeParsed.data.error !== undefined ? { error: probeParsed.data.error } : {}),
        lastSuccessAt: probeParsed.data.ok ? probeParsed.data.checkedAt : previousLastSuccessAt,
        lastFailedAt: probeParsed.data.ok ? previousLastFailedAt : probeParsed.data.checkedAt,
      };
    }

    const previousHealth = deployment.healthStatus;
    const nextHealth = healthStatusParsed.success ? healthStatusParsed.data : previousHealth;
    // Edge-triggered: the rollout failure is recorded once per observed
    // failure, not on every heartbeat while it stays failed.
    const previousRolloutState = (
      deployment.observedState as { deploymentRolloutState?: string } | null
    )?.deploymentRolloutState;
    const nextRolloutState = (observedState as Record<string, unknown> | null)?.[
      'deploymentRolloutState'
    ];
    const rolloutNewlyFailed =
      nextRolloutState === 'FAILED' && previousRolloutState !== 'FAILED';
    // Observed state wins over a stale FAILED: a failed day-2 operation no
    // longer marks the deployment FAILED (deploymentStateAfterFailedJob
    // restores a live state), but rows written before that rule — or any
    // edge path that still lands on FAILED with a running release — self-heal
    // here: a healthy heartbeat is the ground truth that the deployment is
    // running. A failed FIRST install (no release ever deployed) has nothing
    // running and stays FAILED until retried.
    // ...but not when what failed was a DESTROY: the app still serving is
    // exactly the problem then, and flipping back to HEALTHY would hide the
    // stuck teardown the vendor explicitly asked for.
    const stateRecovered =
      nextHealth === 'HEALTHY' &&
      deployment.state === 'FAILED' &&
      deployment.currentReleaseId !== null &&
      !(await latestJobIsDestroy(db, deployment.id));
    // INSTALL succeeded (CFN stack complete) but the deployment is still
    // INSTALLING: runtime verification is what earns HEALTHY, and this is the
    // only place it can land. Guarded by the INSTALL job actually having
    // finished — a healthy-looking heartbeat racing ahead of the INSTALL
    // result must not bill or label the deployment before the install settled.
    const installVerifiedHealthy =
      deployment.state === 'INSTALLING' &&
      nextHealth === 'HEALTHY' &&
      (await hasSucceededInstall(db, deployment.id));

    await db.transaction(async (tx) => {
      await tx
        .update(schema.deployments)
        .set({
          observedState,
          relayStatus: 'CONNECTED',
          lastHealthAt: new Date(),
          ...(stateRecovered ? { state: 'HEALTHY' as const } : {}),
          ...(installVerifiedHealthy ? { state: 'HEALTHY' as const } : {}),
          ...(healthStatusParsed.success ? { healthStatus: healthStatusParsed.data } : {}),
          ...(identity?.awsAccountId ? { awsAccountId: identity.awsAccountId } : {}),
          ...(typeof identity?.relayVersion === 'string' ? { relayVersion: identity.relayVersion } : {}),
          ...(typeof identity?.bootstrapVersion === 'string'
            ? { bootstrapVersion: identity.bootstrapVersion }
            : {}),
          ...(capabilitiesParsed?.success ? { relayCapabilities: capabilitiesParsed.data } : {}),
        })
        .where(eq(schema.deployments.id, deployment.id));

      // Only a CHANGE is worth an event — the relay reports on every poll and
      // an append-only log of "still healthy" would bury everything else.
      if (nextHealth !== previousHealth) {
        await recordEvent(tx, {
          organizationId: deployment.organizationId,
          eventType:
            nextHealth === 'HEALTHY' ? 'health.recovered' : nextHealth === 'UNHEALTHY' ? 'health.unhealthy' : 'health.degraded',
          actorType: 'relay',
          actorId: deployment.installationId ?? deployment.id,
          deploymentId: deployment.id,
          customerId: deployment.customerId,
          previousState: previousHealth,
          requestedState: nextHealth,
          result: nextHealth === 'HEALTHY' ? 'success' : 'failure',
          payload: componentsParsed?.success ? { components: componentsParsed.data } : {},
        });
      }

      if (stateRecovered) {
        await recordEvent(tx, {
          organizationId: deployment.organizationId,
          eventType: 'deployment.state_recovered',
          actorType: 'relay',
          actorId: deployment.installationId ?? deployment.id,
          deploymentId: deployment.id,
          customerId: deployment.customerId,
          previousState: 'FAILED',
          requestedState: 'HEALTHY',
          result: 'success',
          payload: {},
        });
      }

      if (rolloutNewlyFailed) {
        await recordEvent(tx, {
          organizationId: deployment.organizationId,
          eventType: 'ecs.rollout_failed',
          actorType: 'relay',
          actorId: deployment.installationId ?? deployment.id,
          deploymentId: deployment.id,
          customerId: deployment.customerId,
          result: 'failure',
          payload: { deploymentRolloutState: 'FAILED' },
        });
      }
    });

    // §59 inventory persistence: the relay is the ONLY pipeline that observes
    // AWS — this stores the raw ListStackResources read it transported.
    // Absent inventory (read failed / stack gone) passes null, a no-op that
    // preserves the last complete snapshot — a partial read must never
    // overwrite a good one. A persistence error never fails the heartbeat.
    try {
      const infraHealth = (observedState as Record<string, unknown> | null)?.['infraHealth'] as
        | { inventory?: { stackId: string; resources: ObservedStackResource[]; observedAt: string } }
        | null
        | undefined;
      const inventory = infraHealth?.inventory ?? null;
      await persistDeploymentResourceSnapshot(db, {
        deploymentId: deployment.id,
        stackId: inventory?.stackId ?? '',
        resources: inventory?.resources ?? null,
        observedAt: inventory?.observedAt ?? new Date().toISOString(),
      });
    } catch (error) {
      request.log.warn({ err: error }, 'infrastructure inventory persistence failed');
    }

    // Runtime truth wins: reconcile the deployment's release pointer to
    // whatever the relay observed actually running — but ONLY once §10.3's
    // promotion gates pass in this very heartbeat (rollout complete, counts
    // full, targets healthy, HTTP probe successful). Failures here must not
    // fail the heartbeat itself.
    try {
      await reconcileRunningDigest(
        deployment,
        body?.runningImageDigest ?? null,
        observedState as Record<string, unknown> | null,
      );
    } catch (error) {
      request.log.warn({ err: error }, 'runtime digest reconciliation failed');
    }

    // A heartbeat is a progress signal for the deployment's active mutating
    // jobs: the relay is alive and still owes their answers, so the watchdog
    // must not time them out on this tick's evidence.
    await db
      .update(schema.deploymentJobs)
      .set({ lastProgressAt: new Date() })
      .where(
        and(
          eq(schema.deploymentJobs.deploymentId, deployment.id),
          inArray(schema.deploymentJobs.state, ['REQUESTED', 'QUEUED', 'WAITING', 'RUNNING']),
        ),
      );

    // Custom-domain auto-check piggybacks on the ~5-minute relay heartbeat —
    // the existing background cadence, no new scheduler. Best-effort: a DNS
    // hiccup must never fail a health report.
    const activeDomain = await findActiveDomain(db, deployment.id);
    if (
      activeDomain &&
      ['PENDING', 'WAITING_FOR_DNS', 'CONFIGURING', 'REMOVING'].includes(activeDomain.status) &&
      (!activeDomain.lastCheckedAt || Date.now() - activeDomain.lastCheckedAt.getTime() > 180_000)
    ) {
      try {
        await runDomainCheck(db, deployment, activeDomain, domainCheckDeps);
      } catch {
        // swallowed — heartbeat must succeed regardless
      }
    }

    // Best-effort step-timings follow-up (see advanceStepTimingsAfterWrite) —
    // derived from the values THIS heartbeat just wrote, not the stale
    // pre-transaction `deployment`. Reuses `activeDomain` above instead of
    // looking it up again.
    try {
      await advanceStepTimingsAfterWrite(
        db,
        {
          ...deployment,
          observedState: observedState as Record<string, unknown> | null,
          relayStatus: 'CONNECTED',
          lastHealthAt: new Date(),
          ...(stateRecovered ? { state: 'HEALTHY' as const } : {}),
          ...(installVerifiedHealthy ? { state: 'HEALTHY' as const } : {}),
          ...(healthStatusParsed.success ? { healthStatus: healthStatusParsed.data } : {}),
        },
        activeDomain,
      );
    } catch (error) {
      request.log.warn({ err: error }, 'step-timings advance failed');
    }

    return reply.code(200).send({ received: true });
  });

  // §31 relay config fetch — the CONFIG_UPDATE executor calls this over its
  // authenticated channel to learn the effective desired configuration
  // before applying it. Plain values travel; secret values do NOT (they are
  // write-only in the control plane and already live in the customer's
  // Secrets Manager — the relay only needs their key names).
  app.get('/api/relay/config', async (request) => {
    const token = requireBearerToken(request);
    const { installationId } = request.query as { installationId?: string };
    const deployment = await requireRelayDeployment(
      installationId,
      token,
      oldRelayToken(request),
    );

    const view = await getConfig(
      deployment.applicationId,
      deployment.customerId,
      configStore,
    );
    return {
      entries: view.effective.map((entry) => ({
        key: entry.key,
        isSecret: entry.isSecret,
        ...(entry.isSecret ? {} : { value: entry.value }),
        source: entry.source,
      })),
    };
  });

  return app;
}
