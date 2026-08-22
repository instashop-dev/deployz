import cors from '@fastify/cors';
import { setupFastifyErrorHandler } from '@sentry/node';
import { fromNodeHeaders } from 'better-auth/node';
import { and, eq } from 'drizzle-orm';
import crypto from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';

import type { RuntimeDb } from '@deployz/db';
import * as schema from '@deployz/db/schema';

import type { Auth } from './auth.js';
import { createCheckoutSession, createStripe, handleWebhookEvent, constructWebhookEvent } from './billing.js';
import {
  createConfigStore,
  createRelaySecretWriter,
  getConfig,
  setConfig,
  setConfigBodySchema,
} from './config.js';
import { env } from './env.js';
import { ApiError, NotFoundError, toErrorEnvelope } from './errors.js';
import {
  createGithubStore,
  handleInstallationWebhook,
  listInstallations,
  listRepositories,
  mintInstallationToken,
  verifyWebhookSignature,
  type FetchFn,
  type GithubWebhookEvent,
  type ResolveOrganization,
} from './github.js';
import { createRequireAuth } from './require-auth.js';

export interface ServerDeps {
  auth: Auth;
  db: RuntimeDb;
  // Injectable GitHub seams for tests (the real values come from env). The
  // webhook secret is required to verify signatures; fixtureMode flips the
  // repo/installations routes to the fixture store.
  githubWebhookSecret?: string | undefined;
  githubFixtureMode?: boolean | undefined;
}

// application/deployment/release ids are uuid-keyed columns. A non-uuid id
// (e.g. the fixture repo ids the UI uses for the demo) would raise a Postgres
// "invalid input syntax for type uuid" error and surface as a 500; the UI
// clients fall back to fixture data on 404, so non-uuid ids map to 404.
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function requireUuidId(id: string): void {
  if (!UUID_PATTERN.test(id)) {
    throw new NotFoundError('Resource not found');
  }
}

// Resolves the organization id from the query string, falling back to the
// authenticated session's active organization. Client pages do not always know
// the org id, so the session is the source of truth when it is absent.
function organizationIdFromRequest(request: {
  query: unknown;
  organization?: { id: string } | undefined;
}): string {
  const { organizationId } = request.query as { organizationId?: string };
  return organizationId ?? request.organization?.id ?? '';
}

// Control-plane surface: /health, /api/me, /api/auth/*.
// Errors cross the boundary as structured envelopes via toErrorEnvelope;
// Sentry capture lives in its onError hook (never in the render path).
export async function buildServer({
  auth,
  db,
  githubWebhookSecret,
  githubFixtureMode,
}: ServerDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

  // Sentry owns capture via the onError hook this registers. Capture filter:
  // ApiError 4xx are expected client errors — not reportable; everything else
  // (5xx ApiError, unknown throws) is. Do NOT captureException in the custom
  // error handler below — that would double-report.
  setupFastifyErrorHandler(app, {
    shouldHandleError: (error) => !(error instanceof ApiError) || error.statusCode >= 500,
  });

  // Single render path for every thrown error: structured envelope, no stack
  // traces, no internal messages.
  app.setErrorHandler((error, _request, reply) => {
    const { statusCode, body } = toErrorEnvelope(error);
    return reply.code(statusCode).send(body);
  });

  // Browser origin differs by port; cookies are host-scoped, so credentialed
  // CORS + trustedOrigins is the whole cookie story.
  await app.register(cors, { origin: [env.webUrl], credentials: true });

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
  const githubStore = createGithubStore();
  const githubFetch: FetchFn = globalThis.fetch.bind(globalThis);
  const resolveGithubOrganization: ResolveOrganization = async (accountLogin) => {
    const rows = await db
      .select({ id: schema.organization.id })
      .from(schema.organization)
      .where(eq(schema.organization.slug, accountLogin))
      .limit(1);
    return rows[0]?.id ?? null;
  };

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
    const handled = await handleInstallationWebhook(githubStore, event, resolveGithubOrganization);
    return reply.code(200).send({ received: true, handled });
  });

  const requireAuth = createRequireAuth({ auth, db });

  app.get('/api/me', { preHandler: requireAuth }, async (request) => ({
    user: request.user ?? null,
    organization: request.organization ?? null,
  }));

  // §31 application configuration surface (auth-gated). Vendor defaults are
  // customer_id NULL rows; customer overrides are scoped by ?customerId.
  // Secrets are write-only: GET masks them (value: null, never plaintext) and
  // PUT writes them through the relay to the customer's Secrets Manager
  // before persisting the masked placeholder in the control plane.
  const configStore = createConfigStore(db);
  const configSecretWriter = createRelaySecretWriter();

  app.get('/api/applications/:id/config', { preHandler: requireAuth }, async (request) => {
    const { id } = request.params as { id: string };
    const { customerId } = request.query as { customerId?: string | undefined };
    return getConfig(id, customerId ?? null, configStore);
  });

  app.put('/api/applications/:id/config', { preHandler: requireAuth }, async (request) => {
    const { id } = request.params as { id: string };
    const body = setConfigBodySchema.parse(request.body);
    return setConfig(id, body.customerId ?? null, body.entries, {
      store: configStore,
      secretWriter: configSecretWriter,
    });
  });

  // GitHub repo-selection surface (auth-gated). Fixture mode serves the
  // fixture org/repos so the dashboard renders test data without a real App;
  // otherwise the installation store (populated by the webhook) is the source
  // of truth, and repo listing needs a minted installation token.
  app.get('/api/github/installations', { preHandler: requireAuth }, async (request) => {
    const organizationId = request.organization?.id;
    if (!organizationId) {
      throw new ApiError(401, 'UNAUTHORIZED', 'An organization is required');
    }
    const fixtureMode = githubFixtureMode ?? env.githubFixtureMode;
    const installations = await listInstallations(githubStore, organizationId, { fixtureMode });
    return {
      installations,
      connectUrl: env.githubAppInstallUrl ?? null,
    };
  });

  app.get('/api/github/repos', { preHandler: requireAuth }, async (request) => {
    const { installationId } = request.query as { installationId?: string | undefined };
    if (!installationId) {
      throw new ApiError(400, 'INSTALLATION_ID_REQUIRED', 'installationId query parameter is required');
    }
    const fixtureMode = githubFixtureMode ?? env.githubFixtureMode;
    if (fixtureMode) {
      const repositories = await listRepositories(installationId, { fixtureMode: true });
      return { repositories };
    }
    const appId = env.githubAppId;
    const privateKey = env.githubAppPrivateKey;
    if (!appId || !privateKey) {
      throw new ApiError(503, 'GITHUB_DISABLED', 'GitHub App is not configured');
    }
    const { token } = await mintInstallationToken(installationId, appId, privateKey, Date.now(), githubFetch);
    const repositories = await listRepositories(installationId, {
      fixtureMode: false,
      installationToken: token,
      fetchFn: githubFetch,
    });
    return { repositories };
  });

  // ── Request schemas (route boundary validation) ─────────────────────────

  const createApplicationBodySchema = z.object({
    organizationId: z.string().min(1),
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

  const createCustomerBodySchema = z.object({
    organizationId: z.string().min(1),
    name: z.string().min(1),
    email: z.string().email(),
    company: z.string().nullish(),
    externalReference: z.string().nullish(),
  });

  const createDeploymentBodySchema = z.object({
    applicationId: z.string().uuid(),
    customerId: z.string().uuid(),
    organizationId: z.string().min(1),
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

  const rollbackBodySchema = z.object({
    releaseId: z.string().uuid(),
  });

  const destroyBodySchema = z.object({
    finalSnapshot: z.boolean().nullish(),
  });

  const checkoutBodySchema = z.object({
    organizationId: z.string().min(1),
  });

  // ── Applications (§17–§19) ──────────────────────────────────────────────

  // POST /api/applications — Create application from GitHub repo selection
  app.post('/api/applications', { preHandler: requireAuth }, async (request, reply) => {
    const body = createApplicationBodySchema.parse(request.body);
    const [row] = await db
      .insert(schema.applications)
      .values({
        organizationId: body.organizationId,
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
    const organizationId = organizationIdFromRequest(request);
    if (!organizationId) {
      throw new ApiError(401, 'UNAUTHORIZED', 'An organization is required');
    }
    const rows = await db
      .select()
      .from(schema.applications)
      .where(eq(schema.applications.organizationId, organizationId));
    return { applications: rows };
  });

  // GET /api/applications/:id — Get single application
  app.get('/api/applications/:id', { preHandler: requireAuth }, async (request) => {
    const { id } = request.params as { id: string };
    requireUuidId(id);
    const rows = await db
      .select()
      .from(schema.applications)
      .where(eq(schema.applications.id, id))
      .limit(1);
    if (rows.length === 0) {
      throw new NotFoundError('Application not found');
    }
    return rows[0];
  });

  // POST /api/applications/:id/analyse — Trigger analysis
  app.post('/api/applications/:id/analyse', { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    requireUuidId(id);
    const rows = await db
      .select({ id: schema.applications.id })
      .from(schema.applications)
      .where(eq(schema.applications.id, id))
      .limit(1);
    if (rows.length === 0) {
      throw new NotFoundError('Application not found');
    }
    await db
      .update(schema.applications)
      .set({ analysisStatus: 'ANALYZING', updatedBy: request.user?.id ?? null })
      .where(eq(schema.applications.id, id));
    return reply.code(202).send({ status: 'ANALYZING' });
  });

  // GET /api/applications/:id/readiness — Get compatibility result (§19)
  app.get('/api/applications/:id/readiness', { preHandler: requireAuth }, async (request) => {
    const { id } = request.params as { id: string };
    requireUuidId(id);
    const rows = await db
      .select()
      .from(schema.applications)
      .where(eq(schema.applications.id, id))
      .limit(1);
    if (rows.length === 0) {
      throw new NotFoundError('Application not found');
    }
    const app = rows[0]!;
    return {
      verdict: app.compatibilityStatus ?? 'READY',
      score: app.compatibilityStatus === 'READY' ? 100 : app.compatibilityStatus === 'NEEDS_ATTENTION' ? 60 : 0,
      issues: app.compatibilityReason ? [{ message: app.compatibilityReason }] : [],
      readyList: app.compatibilityStatus === 'READY' ? ['container', 'port', 'healthcheck'] : [],
      rejections: app.compatibilityStatus === 'NOT_COMPATIBLE' ? [app.compatibilityReason ?? 'Unknown'] : [],
    };
  });

  // ── Customers (§37) ─────────────────────────────────────────────────────

  // POST /api/customers — Create customer
  app.post('/api/customers', { preHandler: requireAuth }, async (request, reply) => {
    const body = createCustomerBodySchema.parse(request.body);
    const [row] = await db
      .insert(schema.customers)
      .values({
        organizationId: body.organizationId,
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
    const organizationId = organizationIdFromRequest(request);
    if (!organizationId) {
      throw new ApiError(401, 'UNAUTHORIZED', 'An organization is required');
    }
    const rows = await db
      .select()
      .from(schema.customers)
      .where(eq(schema.customers.organizationId, organizationId));
    return { customers: rows };
  });

  // ── Deployments (§12, §23–§24, §38) ────────────────────────────────────

  // POST /api/deployments — Create deployment
  app.post('/api/deployments', { preHandler: requireAuth }, async (request, reply) => {
    const body = createDeploymentBodySchema.parse(request.body);
    const installationId = crypto.randomUUID();
    const [row] = await db
      .insert(schema.deployments)
      .values({
        customerId: body.customerId,
        applicationId: body.applicationId,
        organizationId: body.organizationId,
        region: body.region,
        state: 'NOT_INSTALLED',
        installationId,
        isTestDeployment: body.isTestDeployment ?? false,
        createdBy: request.user?.id ?? null,
        updatedBy: request.user?.id ?? null,
      })
      .returning();
    return reply.code(201).send(row);
  });

  // GET /api/deployments — Fleet dashboard (§23)
  app.get('/api/deployments', { preHandler: requireAuth }, async (request) => {
    const { customerId, applicationId } = request.query as {
      customerId?: string;
      applicationId?: string;
    };
    const organizationId = organizationIdFromRequest(request);
    if (!organizationId) {
      throw new ApiError(401, 'UNAUTHORIZED', 'An organization is required');
    }
    const conditions = [eq(schema.deployments.organizationId, organizationId)];
    if (customerId) {
      conditions.push(eq(schema.deployments.customerId, customerId));
    }
    if (applicationId) {
      conditions.push(eq(schema.deployments.applicationId, applicationId));
    }
    const rows = await db
      .select()
      .from(schema.deployments)
      .where(and(...conditions));
    return { deployments: rows };
  });

  // GET /api/deployments/:id — Deployment detail (§24)
  app.get('/api/deployments/:id', { preHandler: requireAuth }, async (request) => {
    const { id } = request.params as { id: string };
    requireUuidId(id);
    const rows = await db
      .select()
      .from(schema.deployments)
      .where(eq(schema.deployments.id, id))
      .limit(1);
    if (rows.length === 0) {
      throw new NotFoundError('Deployment not found');
    }
    const deployment = rows[0];
    const jobs = await db
      .select()
      .from(schema.deploymentJobs)
      .where(eq(schema.deploymentJobs.deploymentId, id))
      .orderBy(schema.deploymentJobs.createdAt);
    return { ...deployment, jobs };
  });

  // ── Releases (§22) ──────────────────────────────────────────────────────

  // POST /api/applications/:id/releases — Create release
  app.post('/api/applications/:id/releases', { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = createReleaseBodySchema.parse(request.body);
    const appRows = await db
      .select({ id: schema.applications.id })
      .from(schema.applications)
      .where(eq(schema.applications.id, id))
      .limit(1);
    if (appRows.length === 0) {
      throw new NotFoundError('Application not found');
    }
    const [row] = await db
      .insert(schema.releases)
      .values({
        applicationId: id,
        version: body.version,
        gitSha: body.gitSha,
        migrationCommand: body.migrationCommand ?? null,
        buildStatus: 'PENDING',
        releaseStatus: 'BUILDING',
        createdBy: request.user?.id ?? null,
        updatedBy: request.user?.id ?? null,
      })
      .returning();
    return reply.code(201).send(row);
  });

  // GET /api/applications/:id/releases — List releases
  app.get('/api/applications/:id/releases', { preHandler: requireAuth }, async (request) => {
    const { id } = request.params as { id: string };
    requireUuidId(id);
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
        createdAt: row.createdAt,
      })),
    };
  });

  // ── Job triggers (§25, §27, §63) ────────────────────────────────────────

  // POST /api/deployments/:id/deploy — Trigger DEPLOY_RELEASE job
  app.post('/api/deployments/:id/deploy', { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    requireUuidId(id);
    const body = deployBodySchema.parse(request.body);
    const depRows = await db
      .select({ id: schema.deployments.id })
      .from(schema.deployments)
      .where(eq(schema.deployments.id, id))
      .limit(1);
    if (depRows.length === 0) {
      throw new NotFoundError('Deployment not found');
    }
    const idempotencyKey = `${id}:DEPLOY_RELEASE:${Date.now()}`;
    const [job] = await db
      .insert(schema.deploymentJobs)
      .values({
        deploymentId: id,
        type: 'DEPLOY_RELEASE',
        state: 'REQUESTED',
        idempotencyKey,
        payload: { releaseId: body.releaseId },
        requestedBy: request.user?.id ?? null,
      })
      .returning();
    return reply.code(202).send({ jobId: job!.id, state: 'REQUESTED' });
  });

  // POST /api/deployments/:id/rollback — Trigger ROLLBACK job
  app.post('/api/deployments/:id/rollback', { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    requireUuidId(id);
    const body = rollbackBodySchema.parse(request.body);
    const depRows = await db
      .select({ id: schema.deployments.id })
      .from(schema.deployments)
      .where(eq(schema.deployments.id, id))
      .limit(1);
    if (depRows.length === 0) {
      throw new NotFoundError('Deployment not found');
    }
    const idempotencyKey = `${id}:ROLLBACK:${Date.now()}`;
    const [job] = await db
      .insert(schema.deploymentJobs)
      .values({
        deploymentId: id,
        type: 'ROLLBACK',
        state: 'REQUESTED',
        idempotencyKey,
        payload: { releaseId: body.releaseId },
        requestedBy: request.user?.id ?? null,
      })
      .returning();
    return reply.code(202).send({ jobId: job!.id, state: 'REQUESTED' });
  });

  // POST /api/deployments/:id/destroy — Trigger DESTROY job
  app.post('/api/deployments/:id/destroy', { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    requireUuidId(id);
    const body = destroyBodySchema.parse(request.body);
    const depRows = await db
      .select({ id: schema.deployments.id })
      .from(schema.deployments)
      .where(eq(schema.deployments.id, id))
      .limit(1);
    if (depRows.length === 0) {
      throw new NotFoundError('Deployment not found');
    }
    const idempotencyKey = `${id}:DESTROY:${Date.now()}`;
    const [job] = await db
      .insert(schema.deploymentJobs)
      .values({
        deploymentId: id,
        type: 'DESTROY',
        state: 'REQUESTED',
        idempotencyKey,
        payload: { finalSnapshot: body.finalSnapshot ?? false },
        requestedBy: request.user?.id ?? null,
      })
      .returning();
    return reply.code(202).send({ jobId: job!.id, state: 'REQUESTED' });
  });

  // ── Events & diagnostics (§24, §29, §40) ────────────────────────────────

  // GET /api/deployments/:id/events — Event log
  app.get('/api/deployments/:id/events', { preHandler: requireAuth }, async (request) => {
    const { id } = request.params as { id: string };
    requireUuidId(id);
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
    requireUuidId(id);
    const depRows = await db
      .select({ id: schema.deployments.id, state: schema.deployments.state })
      .from(schema.deployments)
      .where(eq(schema.deployments.id, id))
      .limit(1);
    if (depRows.length === 0) {
      throw new NotFoundError('Deployment not found');
    }
    const deployment = depRows[0]!;
    if (deployment!.state !== 'FAILED') {
      return { failureCode: null, what: null, why: null, fix: null, events: [] };
    }
    const events = await db
      .select()
      .from(schema.eventLogs)
      .where(eq(schema.eventLogs.deploymentId, id))
      .orderBy(schema.eventLogs.occurredAt)
      .limit(10);
    return {
      failureCode: 'UNKNOWN',
      what: 'Deployment failed',
      why: 'The deployment did not reach a healthy state',
      fix: 'Check the event log for details and retry the deployment',
      events,
    };
  });

  // ── Billing (§48) ───────────────────────────────────────────────────────

  // POST /api/billing/checkout — Create Stripe checkout session
  app.post('/api/billing/checkout', { preHandler: requireAuth }, async (request) => {
    const body = checkoutBodySchema.parse(request.body);
    const { url } = await createCheckoutSession(
      { db, stripe },
      { organizationId: body.organizationId, customerEmail: request.user?.email },
    );
    return { url };
  });

  // GET /api/billing/summary — Billing summary
  app.get('/api/billing/summary', { preHandler: requireAuth }, async (request) => {
    const organizationId = organizationIdFromRequest(request);
    if (!organizationId) {
      throw new ApiError(401, 'UNAUTHORIZED', 'An organization is required');
    }
    const deployments = await db
      .select({
        name: schema.applications.name,
        state: schema.deployments.state,
        isTestDeployment: schema.deployments.isTestDeployment,
      })
      .from(schema.deployments)
      .innerJoin(schema.applications, eq(schema.deployments.applicationId, schema.applications.id))
      .where(eq(schema.deployments.organizationId, organizationId));
    const billableDeployments = deployments.filter(
      (d) => d.state === 'HEALTHY' && !d.isTestDeployment,
    );
    const deploymentItems = billableDeployments.map((d) => ({
      name: d.name,
      amount: 19,
    }));
    const total = 49 + deploymentItems.length * 19;
    return { base: 49, deployments: deploymentItems, total };
  });

  // ── Onboarding (§42) ────────────────────────────────────────────────────

  // GET /api/onboarding — Onboarding state
  app.get('/api/onboarding', { preHandler: requireAuth }, async (request) => {
    const organizationId = organizationIdFromRequest(request);
    if (!organizationId) {
      throw new ApiError(401, 'UNAUTHORIZED', 'An organization is required');
    }
    const appCount = await db
      .select({ count: schema.applications.id })
      .from(schema.applications)
      .where(eq(schema.applications.organizationId, organizationId));
    const depCount = await db
      .select({ count: schema.deployments.id })
      .from(schema.deployments)
      .where(eq(schema.deployments.organizationId, organizationId));
    const hasApps = Number(appCount[0]?.count ?? 0) > 0;
    const hasDeployments = Number(depCount[0]?.count ?? 0) > 0;
    return {
      steps: [
        { step: 'connect_github', completed: hasApps },
        { step: 'create_application', completed: hasApps },
        { step: 'add_customer', completed: hasDeployments },
        { step: 'create_deployment', completed: hasDeployments },
        { step: 'first_deploy', completed: false },
      ],
    };
  });

  // Better Auth over Fastify: construct a Fetch Request, call auth.handler,
  // forward status/headers/body. Official recipe from the docs.
  app.route({
    method: ['GET', 'POST'],
    url: '/api/auth/*',
    handler: async (request, reply) => {
      const url = new URL(request.url, `http://${request.headers.host}`);
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

  const relayStore = createRelayStore();

  app.post('/api/relay/register', async (request, reply) => {
    const auth = request.headers.authorization;
    if (!auth?.startsWith('Bearer ')) {
      throw new ApiError(401, 'UNAUTHORIZED', 'Missing bearer token');
    }
    const token = auth.slice(7);
    const body = request.body as { installationId?: string };
    if (!body?.installationId) {
      throw new ApiError(400, 'INVALID_REQUEST', 'installationId is required');
    }
    relayStore.register(body.installationId, token);
    return reply.code(200).send({ registered: true });
  });

  app.get('/api/relay/commands', async (request) => {
    const auth = request.headers.authorization;
    if (!auth?.startsWith('Bearer ')) {
      throw new ApiError(401, 'UNAUTHORIZED', 'Missing bearer token');
    }
    const { installationId } = request.query as { installationId?: string };
    if (!installationId) {
      throw new ApiError(400, 'INSTALLATION_ID_REQUIRED', 'installationId query parameter is required');
    }
    return { commands: relayStore.getPendingCommands(installationId) };
  });

  app.post('/api/relay/commands/:id/result', async (request, reply) => {
    const auth = request.headers.authorization;
    if (!auth?.startsWith('Bearer ')) {
      throw new ApiError(401, 'UNAUTHORIZED', 'Missing bearer token');
    }
    const { id } = request.params as { id: string };
    const body = request.body as { success?: boolean; error?: string; output?: Record<string, unknown> };
    relayStore.reportResult(id, body);
    return reply.code(200).send({ received: true });
  });

  app.post('/api/relay/health', async (request, reply) => {
    const auth = request.headers.authorization;
    if (!auth?.startsWith('Bearer ')) {
      throw new ApiError(401, 'UNAUTHORIZED', 'Missing bearer token');
    }
    return reply.code(200).send({ received: true });
  });

  return app;
}

// ── Relay store (in-memory, same pattern as githubStore) ────────────────

interface RelayInstallation {
  id: string;
  token: string;
}

interface PendingCommand {
  id: string;
  deploymentId: string;
  type: string;
  idempotencyKey: string;
  payload: Record<string, unknown>;
}

function createRelayStore() {
  const installations = new Map<string, RelayInstallation>();
  const commands = new Map<string, PendingCommand[]>();

  return {
    register(installationId: string, token: string) {
      installations.set(installationId, { id: installationId, token });
      if (!commands.has(installationId)) {
        commands.set(installationId, []);
      }
    },
    getPendingCommands(installationId: string): PendingCommand[] {
      const pending = commands.get(installationId) ?? [];
      commands.set(installationId, []);
      return pending;
    },
    reportResult(commandId: string, result: { success?: boolean; error?: string; output?: Record<string, unknown> }) {
      void commandId; void result;
    },
  };
}
