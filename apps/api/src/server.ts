import cors from '@fastify/cors';
import { setupFastifyErrorHandler } from '@sentry/node';
import { fromNodeHeaders } from 'better-auth/node';
import { and, desc, eq, inArray, ne } from 'drizzle-orm';
import Fastify, {
  type FastifyBaseLogger,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from 'fastify';
import { z } from 'zod';

import {
  createAiGateway,
  normalizeErrorText,
  type AiGateway,
  type StructuredEvent,
} from '@deployz/analysis';
import {
  buildBootstrapQuickCreateUrl,
  failureCodeSchema,
  healthComponentsSchema,
  healthStatusSchema,
  relayCapabilitiesSchema,
} from '@deployz/contracts';
import { FAILURE_REMEDIATION, type FailureCode } from '@deployz/copy-map';
import type { RuntimeDb } from '@deployz/db';
import * as schema from '@deployz/db/schema';

import type { Auth } from './auth.js';
import { resolveExplanation } from './ai-explanation.js';
import {
  createAnalysisRunner,
  readVendorOverrides,
  type AnalysisRunner,
  type AttentionCheck,
  type ReadyCheck,
  type UnsupportedCheck,
} from './analysis.js';
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
import { buildInstallParameters } from './install-parameters.js';
import { createOrReuseJob } from './jobs.js';
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
} from './domains.js';
import { deriveHealthStatus, deriveRelayStatus } from './relay-liveness.js';
import {
  hashRelayToken,
  mintEnrollmentCode,
  verifyRelayToken,
  verifyRelayTokenWithRotation,
} from './relay-store.js';
import { createRequireAuth, requireRole, type OrganizationRow } from './require-auth.js';

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
type DeploymentRow = typeof schema.deployments.$inferSelect;
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
  [key: string]: unknown;
}

async function requireDeployableRelease(
  db: RuntimeDb,
  releaseId: string,
  applicationId: string,
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
  return { releaseId: release.id, version: release.version, imageRepository, imageDigest };
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

// §24 AWS accounts are shown, never in full — the control plane still stores
// the real id, but nothing outside it should ever see more than a hint of it.
function maskAwsAccountId(awsAccountId: string | null): string | null {
  if (!awsAccountId) return null;
  if (awsAccountId.length <= 4) return '•'.repeat(awsAccountId.length);
  return `${awsAccountId.slice(0, 4)}${'•'.repeat(awsAccountId.length - 4)}`;
}

// §23/§24 fleet row shape: the raw deployments row plus the display fields
// the UI needs (customer/application name, current version) that only exist
// via a join.
function toFleetRow(row: {
  deployment: DeploymentRow;
  customerName: string;
  applicationName: string;
  version: string | null;
  /** Whether the application requires a managed Redis cache. */
  redisRequired?: boolean | null;
}) {
  // §28 liveness and health are derived here, not read raw, so every screen
  // that renders a deployment agrees about whether the relay is still there.
  const relayStatus = deriveRelayStatus(
    row.deployment.relayStatus,
    row.deployment.lastHealthAt,
    new Date(),
  );
  // §24 per-component health, reported by the relay. Absent until it has
  // reported at least once — the detail page renders nothing rather than
  // inventing four healthy rows out of one column default.
  const observedComponents = (row.deployment.observedState as { components?: Record<string, unknown> } | null)
    ?.components;
  // Redis is the one component the API itself knows to expect (from the
  // application's `redisRequired`, not just what the relay happened to
  // report) — mirroring `database`'s always-present-when-required shape, but
  // synthesized here rather than merely passed through, since a redis-
  // requiring deployment that has never reported health would otherwise omit
  // the row entirely instead of showing it as unknown.
  const components = row.redisRequired
    ? { ...(observedComponents ?? {}), redis: (observedComponents?.['redis'] as string | undefined) ?? 'UNKNOWN' }
    : (observedComponents ?? null);
  // Relay enrollment material never crosses into a dashboard response: the
  // enrollment code re-opens enrollment and the token hash is a credential.
  const { enrollmentCode: _enrollmentCode, relayTokenHash: _relayTokenHash, ...deployment } = row.deployment;
  return {
    ...deployment,
    awsAccountId: maskAwsAccountId(row.deployment.awsAccountId),
    relayStatus,
    healthStatus: deriveHealthStatus(row.deployment.healthStatus, relayStatus),
    components,
    // The digest the relay last observed running in ECS, raw. Null when the
    // relay could not observe it — never a guess from the release pointer.
    runningImageDigest:
      (row.deployment.observedState as { runningImageDigest?: string | null } | null)
        ?.runningImageDigest ?? null,
    customerName: row.customerName,
    applicationName: row.applicationName,
    version: row.version,
  };
}


// §19 readiness derivation. The analyser (out of scope here) is expected to
// persist its findings on `applications.detected_metadata` as:
//   { checks: { ready: [{label}], needsAttention: [{title,detail,suggestedFix?}], unsupported: [{title,reason}] } }
// Score is the ratio of satisfied checks (ready / total), never a hardcoded
// constant. Older/partial rows (compatibilityStatus set, no detectedMetadata
// checks yet) degrade gracefully into a single derived check bucket.
function computeReadiness(app: {
  analysisStatus: string;
  compatibilityStatus: string | null;
  compatibilityReason: string | null;
  detectedMetadata: Record<string, unknown> | null;
}): {
  analysisStatus: string;
  verdict: string | null;
  score: number | null;
  changesRequired: number | null;
  /** Why a FAILED analysis failed. Null in every other state. */
  failureReason: string | null;
  ready: ReadyCheck[];
  needsAttention: AttentionCheck[];
  unsupported: UnsupportedCheck[];
} {
  if (app.analysisStatus !== 'COMPLETE') {
    return {
      analysisStatus: app.analysisStatus,
      verdict: null,
      score: null,
      changesRequired: null,
      // A FAILED analysis used to look exactly like a still-running one on
      // the wire, so the page showed "Analysing your app" for ever and
      // Re-analyse appeared to do nothing. The reason is on the row either
      // way (analysis.ts persists it) — it just was never sent.
      failureReason: app.analysisStatus === 'FAILED' ? app.compatibilityReason : null,
      ready: [],
      needsAttention: [],
      unsupported: [],
    };
  }

  const rawChecks = app.detectedMetadata?.checks as
    | { ready?: ReadyCheck[]; needsAttention?: AttentionCheck[]; unsupported?: UnsupportedCheck[] }
    | undefined;

  const ready = rawChecks?.ready ?? [];
  const needsAttention =
    rawChecks?.needsAttention ??
    (app.compatibilityStatus === 'NEEDS_ATTENTION' && app.compatibilityReason
      ? [{ title: 'Attention required', detail: app.compatibilityReason, suggestedFix: null }]
      : []);
  const unsupported =
    rawChecks?.unsupported ??
    (app.compatibilityStatus === 'NOT_COMPATIBLE' && app.compatibilityReason
      ? [{ title: 'Not compatible', reason: app.compatibilityReason }]
      : []);

  const total = ready.length + needsAttention.length + unsupported.length;
  const score =
    total > 0 ? Math.round((ready.length / total) * 100) : app.compatibilityStatus === 'READY' ? 100 : 0;

  return {
    analysisStatus: app.analysisStatus,
    verdict: app.compatibilityStatus ?? 'NEEDS_ATTENTION',
    score,
    changesRequired: needsAttention.length,
    failureReason: null,
    ready,
    needsAttention,
    unsupported,
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
  'DELETING',
  'DELETED',
]);

// An in-flight INSTALL older than this is dead: the relay polls every 5
// minutes and a single executor pass fits well inside it, so six missed
// cycles mean the invocation is never coming back (crashed Lambda, expired
// container). Only then may retry-install supersede the job.
const INSTALL_JOB_STALE_AFTER_MS = 30 * 60 * 1000;

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
 */
const JOB_SUCCESS_STATE: Partial<Record<JobType, DeploymentRow['state']>> = {
  INSTALL: 'HEALTHY',
  DEPLOY_RELEASE: 'HEALTHY',
  ROLLBACK: 'HEALTHY',
  RESTART: 'HEALTHY',
  DESTROY: 'DELETED',
};

/** Job types that carry a release pointer forward on success (§38). */
const RELEASE_ADVANCING_JOBS = new Set<JobType>(['DEPLOY_RELEASE', 'ROLLBACK']);

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
  githubFetch: injectedGithubFetch,
  githubAppId: injectedGithubAppId,
  githubAppPrivateKey: injectedGithubAppPrivateKey,
  aiGateway = createAiGateway(env.aiGateway),
  domainCheckDeps = env.domainFixtureMode ? createFixtureDomainCheckDeps() : createRealDomainCheckDeps(),
  loggerInstance,
}: ServerDeps): Promise<FastifyInstance> {
  // `logger: false` meant a 500 left NO trace anywhere: not in CloudWatch, not
  // in the response (the envelope is deliberately generic), nowhere. Three
  // production failures in a row could only be diagnosed by reading
  // configuration and guessing. `warn` keeps the per-request info lines off
  // while letting the error handler below say what actually broke.
  const app = Fastify(
    loggerInstance ? { loggerInstance } : { logger: { level: 'warn' } },
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

  app.get('/health', () => ({ ok: true }));

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

  const requireAuth = createRequireAuth({ auth, db });

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
  }));

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
  app.get('/api/install/:installLinkId', async (request) => {
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
      // The Quick Create link is built HERE, not in the web app: only the
      // control plane knows which template is currently published, which
      // region this customer's deployment targets, and this deployment's
      // single-use enrollment code. The link carries no credential — the
      // relay's is minted by CloudFormation inside the customer's account.
      //
      // Spent codes get no link. The page renders its "already set up" state
      // in that case and never follows the URL, so building one only hands
      // the enrollment code to whoever replays the link out of a mailbox.
      quickCreateUrl:
        env.bootstrapTemplateUrl && !alreadyInstalled
          ? buildBootstrapQuickCreateUrl({
              region: row.region,
              templateUrl: env.bootstrapTemplateUrl,
              controlPlaneUrl: env.apiUrl,
              enrollmentCode: row.enrollmentCode,
            })
          : null,
      alreadyInstalled,
    };
  });

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
    region: z.enum([
      'us-east-1', 'us-east-2', 'us-west-1', 'us-west-2',
      'ca-central-1', 'sa-east-1',
      'eu-west-1', 'eu-west-2', 'eu-west-3', 'eu-central-1', 'eu-north-1',
      'ap-northeast-1', 'ap-northeast-2', 'ap-northeast-3',
      'ap-south-1', 'ap-southeast-1', 'ap-southeast-2',
    ]),
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
    if (Object.keys(set).length === 0) return existing;
    // The details form re-submits every field on every save, so only a value
    // that actually differs counts as the vendor claiming that field.
    const claimed = CONTRACT_FIELDS.filter(
      (field) => set[field] !== undefined && set[field] !== existing[field],
    );
    if (claimed.length > 0) {
      const overrides = new Set([...readVendorOverrides(existing.detectedMetadata), ...claimed]);
      set.detectedMetadata = { ...(existing.detectedMetadata ?? {}), vendorOverrides: [...overrides] };
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
    const organizationId = resolveWriteOrganizationId(request, body.organizationId);
    // 404 on a non-existent/other-org applicationId or customerId — otherwise
    // the INSERT below hits a foreign-key violation and surfaces as a 500.
    await loadOwnedApplication(db, body.applicationId, organizationId);
    await loadOwnedCustomer(db, body.customerId, organizationId);
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
        enrollmentCode: mintEnrollmentCode(),
        isTestDeployment: body.isTestDeployment ?? false,
        createdBy: request.user?.id ?? null,
        updatedBy: request.user?.id ?? null,
      })
      .returning();
    return reply.code(201).send(row);
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
        redisRequired: schema.applications.redisRequired,
      })
      .from(schema.deployments)
      .innerJoin(schema.customers, eq(schema.deployments.customerId, schema.customers.id))
      .innerJoin(schema.applications, eq(schema.deployments.applicationId, schema.applications.id))
      .leftJoin(schema.releases, eq(schema.deployments.currentReleaseId, schema.releases.id))
      .where(and(...conditions));
    return { deployments: rows.map(toFleetRow) };
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
        redisRequired: schema.applications.redisRequired,
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
    return { ...toFleetRow(rows[0]!), jobs, customDomain };
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
      await enqueue({ type: 'BUILD_RELEASE', releaseId: row.id });
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


  // POST /api/deployments/:id/deploy — Trigger (or reuse) a DEPLOY_RELEASE job
  app.post('/api/deployments/:id/deploy', { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const organizationId = requireSessionOrganizationId(request);
    const deployment = await loadOwnedDeployment(db, id, organizationId);
    const body = deployBodySchema.parse(request.body);
    const payload = await requireDeployableRelease(db, body.releaseId, deployment.applicationId);
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
      const { job, created } = await createOrReuseJob(db, {
        deploymentId: deployment.id,
        type: 'DEPLOY_RELEASE',
        idempotencyKey,
        payload,
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

  // POST /api/deployments/:id/rollback — Trigger (or reuse) a ROLLBACK job
  app.post('/api/deployments/:id/rollback', { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const organizationId = requireSessionOrganizationId(request);
    const deployment = await loadOwnedDeployment(db, id, organizationId);
    const body = rollbackBodySchema.parse(request.body);
    await requireDeployableState(db, deployment);
    const payload = await requireDeployableRelease(db, body.releaseId, deployment.applicationId);
    const idempotencyKey =
      firstHeaderValue(request.headers['idempotency-key']) ??
      (await retryAwareIdempotencyKey(
        db,
        deployment.id,
        'ROLLBACK',
        `${deployment.id}:ROLLBACK:${body.releaseId}`,
      ));
    await requireDeploymentIdle(db, deployment.id, idempotencyKey);
    const { job, created } = await createOrReuseJob(db, {
      deploymentId: deployment.id,
      type: 'ROLLBACK',
      idempotencyKey,
      payload,
      requestedBy: request.user?.id ?? null,
    });
    if (created) {
      await markJobRequested({
        deployment,
        jobId: job.id,
        inFlightState: BULK_DEPLOYABLE_STATES.has(deployment.state) ? 'UPDATING' : null,
        eventType: 'rollback.requested',
        actorId: request.user?.id ?? null,
        releaseId: body.releaseId,
      });
    }
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
    if (deployment.state === 'NOT_INSTALLED') {
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

  // POST /api/deployments/:id/relay/reset — §14 re-enrollment.
  //
  // The recovery path for a lost credential, a rebuilt bootstrap stack, or a
  // rejected enrollment. Without it a 409 from /api/relay/register would be
  // unrecoverable: the binding is single-use by design, so something has to
  // be able to clear it, and that something is a deliberate vendor action.
  app.post('/api/deployments/:id/relay/reset', { preHandler: requireAuth }, async (request) => {
    const { id } = request.params as { id: string };
    const organizationId = requireSessionOrganizationId(request);
    const deployment = await loadOwnedDeployment(db, id, organizationId);
    const enrollmentCode = mintEnrollmentCode();

    await db.transaction(async (tx) => {
      await tx
        .update(schema.deployments)
        .set({
          enrollmentCode,
          enrollmentUsedAt: null,
          installationId: null,
          relayTokenHash: null,
          relayBoundAt: null,
          relayStatus: 'UNKNOWN',
          updatedBy: request.user?.id ?? null,
        })
        .where(eq(schema.deployments.id, deployment.id));
      await recordEvent(tx, {
        organizationId: deployment.organizationId,
        eventType: 'relay.reenrollment.requested',
        actorType: 'user',
        actorId: request.user?.id ?? 'system',
        deploymentId: deployment.id,
        customerId: deployment.customerId,
        previousState: deployment.state,
      });
    });

    return { installLinkId: deployment.installLinkId };
  });

  // POST /api/deployments/:id/retry-install — recovery for a failed FIRST
  // install.
  //
  // A terminal-failed application stack (ROLLBACK_COMPLETE, DELETE_FAILED…)
  // cannot be updated, and its retained RDS/S3 resources block manual
  // deletion — without this route a failed first install bricks the
  // deployment until someone cleans the AWS account by hand. The retry
  // queues a fresh INSTALL job whose payload tells the relay this
  // deployment never installed successfully, authorizing it to delete the
  // failed stack and its orphaned blockers before recreating (recovery runs
  // inside the command; one vendor action, no separate cleanup step).
  app.post('/api/deployments/:id/retry-install', { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const organizationId = requireSessionOrganizationId(request);
    const deployment = await loadOwnedDeployment(db, id, organizationId);

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
        return reply.code(200).send({ jobId: inFlight.id, state: inFlight.state });
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
      },
      requestedBy: request.user?.id ?? null,
    });

    if (created) {
      await db.transaction(async (tx) => {
        if (inFlight) {
          // Superseded (stale RUNNING from a dead relay invocation, or a
          // queued job the FAILED state outran) — close it so the job list
          // does not show two live installs.
          await tx
            .update(schema.deploymentJobs)
            .set({ state: 'CANCELLED', finishedAt: new Date() })
            .where(eq(schema.deploymentJobs.id, inFlight.id));
        }
        await tx
          .update(schema.deployments)
          .set({ state: 'INSTALLING', updatedBy: request.user?.id ?? null })
          .where(eq(schema.deployments.id, deployment.id));
        await recordEvent(tx, {
          organizationId: deployment.organizationId,
          eventType: 'install.retry.requested',
          actorType: 'user',
          actorId: request.user?.id ?? 'system',
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

    return reply.code(created ? 202 : 200).send({ jobId: job.id, state: job.state });
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
  // Read-only trigger; runDomainCheck's own interval floor is the rate limit.
  app.post('/api/install/:installLinkId/domain/check', async (request) => {
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
  });

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

  // GET /api/deployments/:id/diagnostics — Diagnostics (§29)
  app.get('/api/deployments/:id/diagnostics', { preHandler: requireAuth }, async (request) => {
    const { id } = request.params as { id: string };
    const organizationId = requireSessionOrganizationId(request);
    const deployment = await loadOwnedDeployment(db, id, organizationId);
    if (deployment.state !== 'FAILED') {
      return { failureCode: null, what: null, why: null, fix: null, events: [] };
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
      what: explanation.what,
      why: explanation.why,
      fix: explanation.fix,
      technicalDetail: jobResult?.error ?? null,
      events,
    };
  });

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

  async function reconcileRunningDigest(
    deployment: DeploymentRow,
    runningImageDigest: string | null,
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
    // deployment can ever progress past NOT_INSTALLED. We create it here
    // (first relay registration) rather than at deployment-creation time —
    // the deployment row can legitimately exist before any relay has called
    // home, and this is the first point where we know the relay is alive.
    const installJob =
      deployment.state === 'NOT_INSTALLED'
        ? (
            await createOrReuseJob(db, {
              deploymentId: deployment.id,
              type: 'INSTALL',
              idempotencyKey: `${deployment.id}:INSTALL`,
              payload: { parameters: await buildInstallParameters(db, deployment.id) },
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
          ...(deployment.state === 'NOT_INSTALLED' ? { state: 'INSTALLING' as const } : {}),
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

    const jobs = await db
      .select()
      .from(schema.deploymentJobs)
      .where(
        and(
          eq(schema.deploymentJobs.deploymentId, deployment.id),
          inArray(schema.deploymentJobs.state, ['REQUESTED', 'QUEUED']),
        ),
      )
      .orderBy(schema.deploymentJobs.createdAt);

    if (jobs.length > 0) {
      await db
        .update(schema.deploymentJobs)
        .set({ state: 'RUNNING', startedAt: new Date(), lastProgressAt: new Date() })
        .where(
          inArray(
            schema.deploymentJobs.id,
            jobs.map((job) => job.id),
          ),
        );
    }

    return {
      commands: jobs.map((job) => ({
        id: job.id,
        deploymentId: deployment.id,
        type: job.type,
        idempotencyKey: job.idempotencyKey,
        payload: job.payload,
      })),
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

    // A finished job is what advances the deployment's own §46 state.
    // Domain jobs manage the custom_domains row, never the deployment
    // lifecycle — a failed cert request must not mark the deployment FAILED.
    const nextState = isDomainJobType(job.type)
      ? undefined
      : state === 'FAILED'
        ? 'FAILED'
        : JOB_SUCCESS_STATE[job.type];
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
          ...(failureCodeParsed?.success ? { failureCode: failureCodeParsed.data } : {}),
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
            ...(releaseId
              ? { currentReleaseId: releaseId, previousReleaseId: deployment.currentReleaseId }
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
            ...(failureCodeParsed?.success ? { failureCode: failureCodeParsed.data } : {}),
            ...(unrecognisedFailureCode ? { unrecognisedFailureCode } : {}),
          },
        });
      }
    });

    return reply.code(200).send({ received: true });
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
    // Observed state wins over a stale FAILED: a failed day-2 operation
    // marks the deployment FAILED, but the previously installed application
    // keeps serving — a healthy heartbeat from it is the ground truth that
    // the deployment is running. A failed FIRST install (no release ever
    // deployed) has nothing running and stays FAILED until retried.
    // ...but not when what failed was a DESTROY: the app still serving is
    // exactly the problem then, and flipping back to HEALTHY would hide the
    // stuck teardown the vendor explicitly asked for.
    const stateRecovered =
      nextHealth === 'HEALTHY' &&
      deployment.state === 'FAILED' &&
      deployment.currentReleaseId !== null &&
      !(await latestJobIsDestroy(db, deployment.id));

    await db.transaction(async (tx) => {
      await tx
        .update(schema.deployments)
        .set({
          observedState,
          relayStatus: 'CONNECTED',
          lastHealthAt: new Date(),
          ...(stateRecovered ? { state: 'HEALTHY' as const } : {}),
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

    // Runtime truth wins: reconcile the deployment's release pointer to
    // whatever the relay observed actually running. Failures here must not
    // fail the heartbeat itself.
    try {
      await reconcileRunningDigest(deployment, body?.runningImageDigest ?? null);
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
