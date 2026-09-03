import { and, asc, count, desc, eq, gte, ilike, inArray, isNotNull, like, lt, lte, max, ne, notInArray, or, sql } from 'drizzle-orm';

import {
  ACTIVE_JOB_STATES,
  aggregateInfrastructureComponents,
  isJobStuck,
  RELAY_STALE_AFTER_MS,
  type InfrastructureComponentStatus,
} from '@deployz/contracts';
import { normalizeErrorText, redactSecrets } from '@deployz/analysis';
import type { RuntimeDb } from '@deployz/db';
import * as schema from '@deployz/db/schema';

import { deriveDeploymentStatus, toVendorDeploymentStatus } from '../deployment-status.js';
import { parseDefaultHttps } from '../default-https.js';
import { findActiveDomain } from '../domains.js';
import { resolveAppUrl, toFleetRow } from '../fleet-row.js';

// Team Admin read models (docs/admin/team-admin.md): thin queries/aggregation
// over the canonical tables, deliberately cross-tenant (every caller must be
// gated by requireTeamAdmin — see admin/routes.ts). Kept out of server.ts so
// admin code never imports the module that registers it (a cycle).

const LIST_CAP = 200;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

type DeploymentRow = typeof schema.deployments.$inferSelect;
type JobRow = typeof schema.deploymentJobs.$inferSelect;

// ── Shared joins ────────────────────────────────────────────────────────────

/** Every deployment joined with its owning org/customer/application/current
 *  release — the base row every deployment-shaped admin endpoint composes
 *  from, mirroring the vendor fleet query's join set (server.ts). */
function deploymentJoinBase(db: RuntimeDb) {
  return db
    .select({
      deployment: schema.deployments,
      organizationId: schema.deployments.organizationId,
      organizationName: schema.organization.name,
      customerId: schema.customers.id,
      customerName: schema.customers.name,
      customerEmail: schema.customers.email,
      applicationId: schema.applications.id,
      applicationName: schema.applications.name,
      applicationRepoFullName: schema.applications.repoFullName,
      databaseRequired: schema.applications.databaseRequired,
      storageRequired: schema.applications.storageRequired,
      redisRequired: schema.applications.redisRequired,
      version: schema.releases.version,
    })
    .from(schema.deployments)
    .innerJoin(schema.organization, eq(schema.deployments.organizationId, schema.organization.id))
    .innerJoin(schema.customers, eq(schema.deployments.customerId, schema.customers.id))
    .innerJoin(schema.applications, eq(schema.deployments.applicationId, schema.applications.id))
    .leftJoin(schema.releases, eq(schema.deployments.currentReleaseId, schema.releases.id));
}
type DeploymentJoinRow = Awaited<ReturnType<typeof deploymentJoinBase>>[number];

/** Every job joined with its deployment's owning org/customer/application. */
function jobJoinBase(db: RuntimeDb) {
  return db
    .select({
      job: schema.deploymentJobs,
      deploymentId: schema.deployments.id,
      organizationId: schema.deployments.organizationId,
      organizationName: schema.organization.name,
      customerName: schema.customers.name,
      applicationName: schema.applications.name,
    })
    .from(schema.deploymentJobs)
    .innerJoin(schema.deployments, eq(schema.deploymentJobs.deploymentId, schema.deployments.id))
    .innerJoin(schema.organization, eq(schema.deployments.organizationId, schema.organization.id))
    .innerJoin(schema.customers, eq(schema.deployments.customerId, schema.customers.id))
    .innerJoin(schema.applications, eq(schema.deployments.applicationId, schema.applications.id));
}
type JobJoinRow = Awaited<ReturnType<typeof jobJoinBase>>[number];

function deploymentSummary(row: DeploymentJoinRow) {
  return {
    id: row.deployment.id,
    organizationId: row.organizationId,
    organizationName: row.organizationName,
    applicationName: row.applicationName,
    customerName: row.customerName,
    awsAccountId: row.deployment.awsAccountId,
    region: row.deployment.region,
    version: row.version,
    state: row.deployment.state,
    healthStatus: row.deployment.healthStatus,
    relayStatus: row.deployment.relayStatus,
    updatedAt: row.deployment.updatedAt,
  };
}

/** Key names whose string values must never leave a job payload/result:
 *  buildInstallParameters stores REAL per-deployment secrets under camelCase
 *  keys (paramNextauthSecret, paramEncryptionKey, …) that the regex rules in
 *  @deployz/analysis's redactSecrets — written for UPPER_SNAKE env text — do
 *  not match, so structured payloads get a structural walk instead. */
const SECRET_KEY_PATTERN = /secret|password|token|credential|private|key/i;

/** Deep-redacts a payload/result object: string values under secret-shaped
 *  keys become [REDACTED]; every other string still passes through
 *  redactSecrets (catching URL credentials and env-style text). */
function redactStructured(value: unknown, keyHint?: string): unknown {
  if (typeof value === 'string') {
    return keyHint !== undefined && SECRET_KEY_PATTERN.test(keyHint) ? '[REDACTED]' : redactSecrets(value);
  }
  if (Array.isArray(value)) return value.map((entry) => redactStructured(entry));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, redactStructured(entry, key)]),
    );
  }
  return value;
}

/** result.error, redacted + truncated — the only free-text slot a job result carries. */
function jobErrorDetail(job: JobRow): string | null {
  const result = job.result as { error?: unknown } | null;
  const error = result?.error;
  return typeof error === 'string' && error.length > 0 ? normalizeErrorText(error, { maxLength: 1000 }) : null;
}

/** finished-started, or now-started while still running; null with no start yet. */
function jobDurationMs(job: JobRow, now: Date): number | null {
  if (job.finishedAt) return job.finishedAt.getTime() - (job.startedAt ?? job.createdAt).getTime();
  if (job.startedAt) return now.getTime() - job.startedAt.getTime();
  return null;
}

function jobListRow(row: JobJoinRow, now: Date) {
  const job = row.job;
  return {
    id: job.id,
    deploymentId: row.deploymentId,
    organizationId: row.organizationId,
    organizationName: row.organizationName,
    customerName: row.customerName,
    applicationName: row.applicationName,
    type: job.type,
    state: job.state,
    stuck: isJobStuck(job, now),
    failureCode: job.failureCode,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    durationMs: jobDurationMs(job, now),
    retries: null as number | null,
    errorDetail: jobErrorDetail(job),
  };
}

// ── Overview ────────────────────────────────────────────────────────────────

const UNHEALTHY_STATUSES = ['DEGRADED', 'UNHEALTHY'] as const;
const IN_PROGRESS_STATES = ['INSTALLING', 'UPDATING', 'WAITING_FOR_RELAY', 'DELETING'] as const;

export async function getOverview(db: RuntimeDb, now: Date = new Date()) {
  const failedRows = await deploymentJoinBase(db)
    .where(eq(schema.deployments.state, 'FAILED'))
    .orderBy(desc(schema.deployments.updatedAt))
    .limit(LIST_CAP);

  const unhealthyRows = await deploymentJoinBase(db)
    .where(and(inArray(schema.deployments.healthStatus, [...UNHEALTHY_STATUSES]), ne(schema.deployments.state, 'DELETED')))
    .limit(LIST_CAP);

  const inProgressRows = await deploymentJoinBase(db)
    .where(inArray(schema.deployments.state, [...IN_PROGRESS_STATES]))
    .limit(LIST_CAP);

  const disconnectedRows = await deploymentJoinBase(db)
    .where(
      and(
        eq(schema.deployments.relayStatus, 'DISCONNECTED'),
        notInArray(schema.deployments.state, ['DELETED', 'NOT_INSTALLED']),
      ),
    )
    .orderBy(desc(schema.deployments.updatedAt))
    .limit(LIST_CAP);

  const activeJobRows = await jobJoinBase(db)
    .where(inArray(schema.deploymentJobs.state, [...ACTIVE_JOB_STATES]))
    .orderBy(desc(schema.deploymentJobs.createdAt))
    .limit(LIST_CAP);
  const stuckJobRows = activeJobRows.filter((row) => isJobStuck(row.job, now));

  return {
    counts: {
      failedDeployments: failedRows.length,
      unhealthyDeployments: unhealthyRows.length,
      stuckJobs: stuckJobRows.length,
      disconnectedRelays: disconnectedRows.length,
      inProgressDeployments: inProgressRows.length,
    },
    recentFailures: failedRows.slice(0, 10).map(deploymentSummary),
    stuckJobs: stuckJobRows.slice(0, 10).map((row) => jobListRow(row, now)),
    disconnectedConnections: disconnectedRows.slice(0, 10).map(deploymentSummary),
  };
}

// ── Vendors ─────────────────────────────────────────────────────────────────

export type VendorConnection = 'CONNECTED' | 'DISCONNECTED' | 'NONE' | 'UNKNOWN';

const CONNECTION_PRIORITY: readonly VendorConnection[] = ['DISCONNECTED', 'UNKNOWN', 'CONNECTED'];

export async function listVendors(db: RuntimeDb, params: { q?: string | undefined; filter?: string | undefined } = {}) {
  const orgs = await db.select().from(schema.organization).limit(LIST_CAP);
  if (orgs.length === 0) return [];
  const orgIds = orgs.map((org) => org.id);

  const owners = await db
    .select({ organizationId: schema.member.organizationId, name: schema.user.name, email: schema.user.email })
    .from(schema.member)
    .innerJoin(schema.user, eq(schema.member.userId, schema.user.id))
    .where(and(inArray(schema.member.organizationId, orgIds), eq(schema.member.role, 'owner')));
  const ownerByOrg = new Map(owners.map((owner) => [owner.organizationId, owner]));

  const appCountRows = await db
    .select({ organizationId: schema.applications.organizationId, value: count() })
    .from(schema.applications)
    .where(inArray(schema.applications.organizationId, orgIds))
    .groupBy(schema.applications.organizationId);
  const appCountByOrg = new Map(appCountRows.map((row) => [row.organizationId, row.value]));

  const deploymentCountRows = await db
    .select({ organizationId: schema.deployments.organizationId, value: count() })
    .from(schema.deployments)
    .where(inArray(schema.deployments.organizationId, orgIds))
    .groupBy(schema.deployments.organizationId);
  const deploymentCountByOrg = new Map(deploymentCountRows.map((row) => [row.organizationId, row.value]));

  const failedOrgIds = new Set(
    (
      await db
        .select({ organizationId: schema.deployments.organizationId })
        .from(schema.deployments)
        .where(and(inArray(schema.deployments.organizationId, orgIds), eq(schema.deployments.state, 'FAILED')))
    ).map((row) => row.organizationId),
  );

  const relayRows = await db
    .select({ organizationId: schema.deployments.organizationId, relayStatus: schema.deployments.relayStatus })
    .from(schema.deployments)
    .where(
      and(
        inArray(schema.deployments.organizationId, orgIds),
        notInArray(schema.deployments.state, ['NOT_INSTALLED', 'DELETED']),
      ),
    );
  const relayByOrg = new Map<string, Set<string>>();
  for (const row of relayRows) {
    const set = relayByOrg.get(row.organizationId) ?? new Set<string>();
    set.add(row.relayStatus);
    relayByOrg.set(row.organizationId, set);
  }

  const activityRows = await db
    .select({ organizationId: schema.eventLogs.organizationId, lastActivityAt: max(schema.eventLogs.occurredAt) })
    .from(schema.eventLogs)
    .where(inArray(schema.eventLogs.organizationId, orgIds))
    .groupBy(schema.eventLogs.organizationId);
  const activityByOrg = new Map(activityRows.map((row) => [row.organizationId, row.lastActivityAt]));

  let rows = orgs.map((org) => {
    const owner = ownerByOrg.get(org.id);
    const relaySet = relayByOrg.get(org.id);
    const connection: VendorConnection =
      relaySet === undefined || relaySet.size === 0
        ? 'NONE'
        : (CONNECTION_PRIORITY.find((candidate) => relaySet.has(candidate)) ?? 'UNKNOWN');
    return {
      organizationId: org.id,
      name: org.name,
      slug: org.slug,
      plan: org.plan,
      createdAt: org.createdAt,
      ownerEmail: owner?.email ?? null,
      ownerName: owner?.name ?? null,
      applicationCount: appCountByOrg.get(org.id) ?? 0,
      deploymentCount: deploymentCountByOrg.get(org.id) ?? 0,
      connection,
      hasFailedDeployment: failedOrgIds.has(org.id),
      lastActivityAt: activityByOrg.get(org.id) ?? null,
    };
  });

  if (params.filter === 'failed') rows = rows.filter((row) => row.hasFailedDeployment);
  if (params.filter === 'disconnected') rows = rows.filter((row) => row.connection === 'DISCONNECTED');

  const q = params.q?.trim().toLowerCase();
  if (q) {
    rows = rows.filter(
      (row) =>
        row.name.toLowerCase().includes(q) ||
        row.slug.toLowerCase().includes(q) ||
        (row.ownerEmail?.toLowerCase().includes(q) ?? false),
    );
  }

  return rows;
}

export async function getVendorDetail(db: RuntimeDb, organizationId: string) {
  const [organization] = await db
    .select()
    .from(schema.organization)
    .where(eq(schema.organization.id, organizationId))
    .limit(1);
  if (!organization) return null;

  const members = await db
    .select({ userId: schema.user.id, name: schema.user.name, email: schema.user.email, role: schema.member.role })
    .from(schema.member)
    .innerJoin(schema.user, eq(schema.member.userId, schema.user.id))
    .where(eq(schema.member.organizationId, organizationId));

  const applicationRows = await db
    .select()
    .from(schema.applications)
    .where(eq(schema.applications.organizationId, organizationId));
  const applicationIds = applicationRows.map((app) => app.id);

  const releaseRows = applicationIds.length
    ? await db
        .select()
        .from(schema.releases)
        .where(inArray(schema.releases.applicationId, applicationIds))
        .orderBy(desc(schema.releases.createdAt))
    : [];
  const latestReleaseByApp = new Map<string, (typeof releaseRows)[number]>();
  for (const release of releaseRows) {
    if (!latestReleaseByApp.has(release.applicationId)) latestReleaseByApp.set(release.applicationId, release);
  }

  const deploymentCountByApp = new Map<string, number>();
  if (applicationIds.length) {
    const deploymentAppIds = await db
      .select({ applicationId: schema.deployments.applicationId })
      .from(schema.deployments)
      .where(inArray(schema.deployments.applicationId, applicationIds));
    for (const row of deploymentAppIds) {
      deploymentCountByApp.set(row.applicationId, (deploymentCountByApp.get(row.applicationId) ?? 0) + 1);
    }
  }

  const applications = applicationRows.map((app) => {
    const latest = latestReleaseByApp.get(app.id);
    return {
      id: app.id,
      name: app.name,
      repoFullName: app.repoFullName,
      analysisStatus: app.analysisStatus,
      compatibilityStatus: app.compatibilityStatus,
      latestRelease: latest ? { id: latest.id, version: latest.version, releaseStatus: latest.releaseStatus } : null,
      deploymentCount: deploymentCountByApp.get(app.id) ?? 0,
    };
  });

  const deploymentJoinRows = await deploymentJoinBase(db)
    .where(eq(schema.deployments.organizationId, organizationId))
    .orderBy(desc(schema.deployments.updatedAt))
    .limit(LIST_CAP);
  const deploymentIds = deploymentJoinRows.map((row) => row.deployment.id);
  const domainRows = deploymentIds.length
    ? await db
        .select()
        .from(schema.customDomains)
        .where(and(inArray(schema.customDomains.deploymentId, deploymentIds), sql`${schema.customDomains.removedAt} is null`))
    : [];
  const domainByDeployment = new Map(domainRows.map((domain) => [domain.deploymentId, domain]));

  const deployments = deploymentJoinRows.map((row) => {
    const domain = domainByDeployment.get(row.deployment.id) ?? null;
    const defaultHttps = parseDefaultHttps(row.deployment.defaultHttps);
    const https = domain?.status === 'ACTIVE'
      ? `https://${domain.hostname}`
      : defaultHttps?.status === 'ACTIVE'
        ? `https://${defaultHttps.hostname}`
        : null;
    return {
      id: row.deployment.id,
      customerName: row.customerName,
      applicationName: row.applicationName,
      version: row.version,
      region: row.deployment.region,
      state: row.deployment.state,
      healthStatus: row.deployment.healthStatus,
      relayStatus: row.deployment.relayStatus,
      appUrl: https,
      domain: domain?.hostname ?? null,
      updatedAt: row.deployment.updatedAt,
    };
  });

  const connections = deploymentJoinRows
    .filter((row) => row.deployment.state !== 'NOT_INSTALLED')
    .map((row) => ({
      deploymentId: row.deployment.id,
      customerName: row.customerName,
      awsAccountId: row.deployment.awsAccountId,
      region: row.deployment.region,
      relayStatus: row.deployment.relayStatus,
      lastHealthAt: row.deployment.lastHealthAt,
      relayVersion: row.deployment.relayVersion,
      bootstrapVersion: row.deployment.bootstrapVersion,
      state: row.deployment.state,
    }));

  const recentEvents = await db
    .select()
    .from(schema.eventLogs)
    .where(eq(schema.eventLogs.organizationId, organizationId))
    .orderBy(desc(schema.eventLogs.occurredAt))
    .limit(30);

  return {
    organization: {
      id: organization.id,
      name: organization.name,
      slug: organization.slug,
      plan: organization.plan,
      createdAt: organization.createdAt,
    },
    members,
    applications,
    deployments,
    connections,
    recentEvents,
  };
}

// ── Deployments ─────────────────────────────────────────────────────────────

const ACTIVE_DEPLOYMENT_STATES = ['INSTALLING', 'UPDATING', 'WAITING_FOR_RELAY'] as const;

async function stuckDeploymentIds(db: RuntimeDb, deploymentIds: string[], now: Date): Promise<Set<string>> {
  if (deploymentIds.length === 0) return new Set();
  const jobs = await db
    .select()
    .from(schema.deploymentJobs)
    .where(
      and(
        inArray(schema.deploymentJobs.deploymentId, deploymentIds),
        inArray(schema.deploymentJobs.state, [...ACTIVE_JOB_STATES]),
      ),
    );
  return new Set(jobs.filter((job) => isJobStuck(job, now)).map((job) => job.deploymentId));
}

export async function listDeployments(db: RuntimeDb, params: { q?: string | undefined; filter?: string | undefined } = {}, now: Date = new Date()) {
  const rows = await deploymentJoinBase(db).orderBy(desc(schema.deployments.updatedAt)).limit(LIST_CAP);
  const stuckIds = await stuckDeploymentIds(
    db,
    rows.map((row) => row.deployment.id),
    now,
  );

  let results = rows.map((row) => ({
    ...deploymentSummary(row),
    stuck: stuckIds.has(row.deployment.id),
  }));

  switch (params.filter) {
    case 'active':
      results = results.filter((row) => (ACTIVE_DEPLOYMENT_STATES as readonly string[]).includes(row.state));
      break;
    case 'failed':
      results = results.filter((row) => row.state === 'FAILED');
      break;
    case 'unhealthy':
      results = results.filter((row) => (UNHEALTHY_STATUSES as readonly string[]).includes(row.healthStatus));
      break;
    case 'stuck':
      results = results.filter((row) => row.stuck);
      break;
    case 'deleting':
      results = results.filter((row) => row.state === 'DELETING');
      break;
    case 'disconnected':
      results = results.filter((row) => row.relayStatus === 'DISCONNECTED' || row.state === 'DISCONNECTED');
      break;
    default:
      break;
  }

  const q = params.q?.trim().toLowerCase();
  if (q) {
    results = results.filter(
      (row) =>
        row.customerName.toLowerCase().includes(q) ||
        row.applicationName.toLowerCase().includes(q) ||
        row.organizationName.toLowerCase().includes(q) ||
        (row.awsAccountId?.toLowerCase().includes(q) ?? false) ||
        row.region.toLowerCase().includes(q),
    );
  }

  return results;
}

/** Same connectionState ladder as GET /api/admin/connections (below). */
function deriveConnectionState(
  deployment: Pick<DeploymentRow, 'relayStatus' | 'lastHealthAt' | 'installationId' | 'state'>,
  now: Date,
): 'CONNECTED' | 'DEGRADED' | 'DISCONNECTED' | 'BOOTSTRAP_INCOMPLETE' | 'UNKNOWN' {
  if (deployment.relayStatus === 'DISCONNECTED') return 'DISCONNECTED';
  if (deployment.relayStatus === 'CONNECTED') {
    const fresh =
      deployment.lastHealthAt !== null && now.getTime() - deployment.lastHealthAt.getTime() <= RELAY_STALE_AFTER_MS;
    return fresh ? 'CONNECTED' : 'DEGRADED';
  }
  if (deployment.installationId === null || deployment.state === 'WAITING_FOR_RELAY') return 'BOOTSTRAP_INCOMPLETE';
  return 'UNKNOWN';
}

/** Same composition as GET /api/deployments/:id/infrastructure (server.ts),
 *  reimplemented here rather than imported so admin code never imports
 *  server.ts (which registers these admin routes — a cycle). */
function buildInfrastructureBlock(
  deployment: DeploymentRow,
  resources: (typeof schema.deploymentResources.$inferSelect)[],
  now: Date,
) {
  const nowMs = now.getTime();
  const lastHealthAt = deployment.lastHealthAt;
  const connected =
    deployment.relayStatus === 'CONNECTED' && lastHealthAt !== null && nowMs - lastHealthAt.getTime() <= RELAY_STALE_AFTER_MS;

  let lastUpdatedAt: Date | null = null;
  for (const row of resources) {
    if (lastUpdatedAt === null || row.lastUpdatedAt.getTime() > lastUpdatedAt.getTime()) lastUpdatedAt = row.lastUpdatedAt;
  }

  const snapshotState: 'fresh' | 'stale' | 'none' =
    resources.length === 0
      ? 'none'
      : lastUpdatedAt !== null && nowMs - lastUpdatedAt.getTime() <= RELAY_STALE_AFTER_MS
        ? 'fresh'
        : 'stale';

  const observed = deployment.observedState as
    | { infraHealth?: { provisioning?: { stackStatus?: unknown } } }
    | null
    | undefined;
  const rawStackStatus = observed?.infraHealth?.provisioning?.stackStatus;

  const aggregate = aggregateInfrastructureComponents(
    resources.map((row) => ({ ...row, resourceStatus: row.resourceStatus as InfrastructureComponentStatus })),
    { deploymentState: deployment.state, region: deployment.region },
  );
  const summaryStatus = aggregate.summaryStatus === 'ready' ? 'healthy' : aggregate.summaryStatus;
  const lastUpdatedAtIso = lastUpdatedAt?.toISOString() ?? null;

  return {
    provider: 'aws' as const,
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
      !connected && snapshotState !== 'none' && lastUpdatedAt !== null ? { lastVerifiedAt: lastUpdatedAtIso } : null,
  };
}

const RELEASE_JOB_TYPES = ['DEPLOY_RELEASE', 'ROLLBACK', 'INSTALL'] as const;

/** Best-effort release info off a job payload — installs/deploys carry
 *  releaseId/version, a rollback may carry a target releaseId only. */
function releaseInfoFromPayload(payload: Record<string, unknown> | null): { releaseId: string | null; version: string | null } {
  const releaseId = typeof payload?.releaseId === 'string' ? payload.releaseId : null;
  const version = typeof payload?.version === 'string' ? payload.version : null;
  return { releaseId, version };
}

export async function getDeploymentDetail(db: RuntimeDb, id: string, now: Date = new Date()) {
  const rows = await deploymentJoinBase(db).where(eq(schema.deployments.id, id)).limit(1);
  const row = rows[0];
  if (!row) return null;

  const jobs = await db
    .select()
    .from(schema.deploymentJobs)
    .where(eq(schema.deploymentJobs.deploymentId, id))
    .orderBy(asc(schema.deploymentJobs.createdAt));
  const domain = await findActiveDomain(db, id);
  const defaultHttps = parseDefaultHttps(row.deployment.defaultHttps);
  const appUrl = resolveAppUrl(jobs, domain, defaultHttps);
  const application = {
    databaseRequired: row.databaseRequired,
    storageRequired: row.storageRequired,
    redisRequired: row.redisRequired,
  };
  const derived = deriveDeploymentStatus({
    deployment: row.deployment,
    application,
    jobs,
    domain,
    defaultHttps,
    appUrl,
    now,
  });

  const fleetRow = toFleetRow({
    deployment: row.deployment,
    customerName: row.customerName,
    applicationName: row.applicationName,
    version: row.version,
    ...application,
  });

  const releases = await db
    .select()
    .from(schema.releases)
    .where(eq(schema.releases.applicationId, row.applicationId))
    .orderBy(desc(schema.releases.createdAt));

  const releaseHistory = jobs
    .filter((job) => (RELEASE_JOB_TYPES as readonly string[]).includes(job.type))
    .map((job) => ({
      id: job.id,
      type: job.type,
      state: job.state,
      createdAt: job.createdAt,
      finishedAt: job.finishedAt,
      failureCode: job.failureCode,
      release: releaseInfoFromPayload(job.payload),
    }));

  const resources = await db
    .select()
    .from(schema.deploymentResources)
    .where(eq(schema.deploymentResources.deploymentId, id))
    .orderBy(schema.deploymentResources.componentKind, schema.deploymentResources.logicalResourceId);
  const infrastructure = buildInfrastructureBlock(row.deployment, resources, now);

  const jobsWithMeta = jobs.map((job) => ({
    ...job,
    // Job payloads carry real per-deployment secrets (install parameters) —
    // never hand them to the dashboard un-redacted, even for admins.
    payload: redactStructured(job.payload),
    result: redactStructured(job.result),
    stuck: isJobStuck(job, now),
    normalizedError: job.failureCode,
    errorDetail: jobErrorDetail(job),
  }));

  const recentEvents = await db
    .select()
    .from(schema.eventLogs)
    .where(eq(schema.eventLogs.deploymentId, id))
    .orderBy(desc(schema.eventLogs.occurredAt))
    .limit(50);
  const recentStackEvents = await db
    .select()
    .from(schema.deploymentStackEvents)
    .where(eq(schema.deploymentStackEvents.deploymentId, id))
    .orderBy(desc(schema.deploymentStackEvents.eventAt))
    .limit(50);

  const communicationPossible =
    row.deployment.relayStatus === 'CONNECTED' &&
    row.deployment.lastHealthAt !== null &&
    now.getTime() - row.deployment.lastHealthAt.getTime() <= RELAY_STALE_AFTER_MS;

  return {
    ...fleetRow,
    jobs: jobsWithMeta,
    customDomain: domain ? { hostname: domain.hostname, status: domain.status } : null,
    appUrl,
    deploymentStatus: toVendorDeploymentStatus(derived),
    vendor: { organizationId: row.organizationId, name: row.organizationName },
    customer: { id: row.customerId, name: row.customerName, email: row.customerEmail },
    application: { id: row.applicationId, name: row.applicationName, repoFullName: row.applicationRepoFullName },
    releases,
    releaseHistory,
    infrastructure,
    recentEvents,
    recentStackEvents,
    connection: {
      awsAccountId: row.deployment.awsAccountId,
      region: row.deployment.region,
      relayStatus: row.deployment.relayStatus,
      lastHealthAt: row.deployment.lastHealthAt,
      relayVersion: row.deployment.relayVersion,
      bootstrapVersion: row.deployment.bootstrapVersion,
      bootstrapStackName: row.deployment.bootstrapStackName,
      installationId: row.deployment.installationId,
      attemptNumber: row.deployment.attemptNumber,
      cleanupState: row.deployment.cleanupState,
      state: row.deployment.state,
      communicationPossible,
    },
  };
}

// ── Jobs ─────────────────────────────────────────────────────────────────

export async function listJobs(db: RuntimeDb, params: { q?: string | undefined; filter?: string | undefined } = {}, now: Date = new Date()) {
  const rows = await jobJoinBase(db).orderBy(desc(schema.deploymentJobs.createdAt)).limit(LIST_CAP);
  let results = rows.map((row) => jobListRow(row, now));

  switch (params.filter) {
    case 'queued':
      results = results.filter((row) => row.state === 'REQUESTED' || row.state === 'QUEUED');
      break;
    case 'running':
      results = results.filter((row) => row.state === 'RUNNING' || row.state === 'WAITING');
      break;
    case 'failed':
      results = results.filter((row) => row.state === 'FAILED');
      break;
    case 'stuck':
      results = results.filter((row) => row.stuck);
      break;
    default:
      break;
  }

  const q = params.q?.trim().toLowerCase();
  if (q) {
    results = results.filter(
      (row) =>
        row.id.toLowerCase().includes(q) ||
        row.deploymentId.toLowerCase().includes(q) ||
        row.organizationName.toLowerCase().includes(q) ||
        row.applicationName.toLowerCase().includes(q) ||
        row.customerName.toLowerCase().includes(q) ||
        row.type.toLowerCase().includes(q),
    );
  }

  return results;
}

interface JobTimelineEntry {
  at: string;
  type: 'job' | 'event';
  label: string;
  result?: string | null;
}

export async function getJobDetail(db: RuntimeDb, id: string, now: Date = new Date()) {
  const rows = await jobJoinBase(db).where(eq(schema.deploymentJobs.id, id)).limit(1);
  const row = rows[0];
  if (!row) return null;
  const job = row.job;

  const [deployment] = await db.select().from(schema.deployments).where(eq(schema.deployments.id, row.deploymentId)).limit(1);
  const [applicationRow] = deployment
    ? await db.select().from(schema.applications).where(eq(schema.applications.id, deployment.applicationId)).limit(1)
    : [undefined];
  const [customerRow] = deployment
    ? await db.select().from(schema.customers).where(eq(schema.customers.id, deployment.customerId)).limit(1)
    : [undefined];

  const payload = redactStructured(job.payload ?? {});

  const eventRows = await db
    .select()
    .from(schema.eventLogs)
    .where(eq(schema.eventLogs.jobId, id))
    .orderBy(asc(schema.eventLogs.occurredAt));
  const stackEventRows = await db
    .select()
    .from(schema.deploymentStackEvents)
    .where(eq(schema.deploymentStackEvents.jobId, id))
    .orderBy(asc(schema.deploymentStackEvents.eventAt));

  const jobMilestones: { at: Date | null; label: string }[] = [
    { at: job.createdAt, label: 'created' },
    { at: job.startedAt, label: 'relay_pickup' },
    { at: job.finishedAt, label: job.state === 'FAILED' ? 'failed' : 'finished' },
  ];
  const timeline: JobTimelineEntry[] = [
    ...jobMilestones
      .filter((entry): entry is { at: Date; label: string } => entry.at !== null)
      .map((entry) => ({ at: entry.at.toISOString(), type: 'job' as const, label: entry.label })),
    ...eventRows.map((event) => ({
      at: event.occurredAt.toISOString(),
      type: 'event' as const,
      label: event.eventType,
      result: event.result,
    })),
  ].sort((a, b) => a.at.localeCompare(b.at));

  const stackEvents =
    stackEventRows.length > 0
      ? {
          firstEventAt: stackEventRows[0]!.eventAt.toISOString(),
          lastEventAt: stackEventRows[stackEventRows.length - 1]!.eventAt.toISOString(),
          count: stackEventRows.length,
          recent: stackEventRows.slice(-20),
        }
      : { firstEventAt: null, lastEventAt: null, count: 0, recent: [] as (typeof stackEventRows)[number][] };

  return {
    id: job.id,
    deploymentId: row.deploymentId,
    type: job.type,
    state: job.state,
    stuck: isJobStuck(job, now),
    failureCode: job.failureCode,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    errorDetail: jobErrorDetail(job),
    payload,
    vendor: { organizationId: row.organizationId, name: row.organizationName },
    customer: customerRow ? { id: customerRow.id, name: customerRow.name, email: customerRow.email } : null,
    application: applicationRow
      ? { id: applicationRow.id, name: applicationRow.name, repoFullName: applicationRow.repoFullName }
      : null,
    deployment: deployment ? { id: deployment.id, state: deployment.state, relayStatus: deployment.relayStatus } : null,
    timeline,
    stackEvents,
  };
}

// ── Connections ─────────────────────────────────────────────────────────────

export async function listConnections(db: RuntimeDb, params: { q?: string | undefined; filter?: string | undefined } = {}, now: Date = new Date()) {
  const rows = await deploymentJoinBase(db)
    .where(or(ne(schema.deployments.state, 'NOT_INSTALLED'), isNotNull(schema.deployments.installationId)))
    .orderBy(desc(schema.deployments.updatedAt))
    .limit(LIST_CAP);

  const accountCounts = new Map<string, number>();
  for (const row of rows) {
    const awsAccountId = row.deployment.awsAccountId;
    if (!awsAccountId || row.deployment.state === 'DELETED') continue;
    accountCounts.set(awsAccountId, (accountCounts.get(awsAccountId) ?? 0) + 1);
  }

  let results = rows.map((row) => {
    const deployment = row.deployment;
    const connectionState = deriveConnectionState(deployment, now);
    const awsAccountId = deployment.awsAccountId;
    const accountDeploymentCount =
      awsAccountId && deployment.state !== 'DELETED' ? Math.max(0, (accountCounts.get(awsAccountId) ?? 1) - 1) : 0;
    return {
      deploymentId: deployment.id,
      organizationId: row.organizationId,
      organizationName: row.organizationName,
      customerName: row.customerName,
      awsAccountId,
      region: deployment.region,
      connectionState,
      relayStatus: deployment.relayStatus,
      lastHealthAt: deployment.lastHealthAt,
      relayVersion: deployment.relayVersion,
      bootstrapVersion: deployment.bootstrapVersion,
      state: deployment.state,
      accountDeploymentCount,
    };
  });

  if (params.filter) {
    const filter = params.filter.toLowerCase();
    results = results.filter((row) => row.connectionState.toLowerCase() === filter);
  }

  const q = params.q?.trim().toLowerCase();
  if (q) {
    results = results.filter(
      (row) =>
        row.customerName.toLowerCase().includes(q) ||
        row.organizationName.toLowerCase().includes(q) ||
        (row.awsAccountId?.toLowerCase().includes(q) ?? false) ||
        row.region.toLowerCase().includes(q),
    );
  }

  return results;
}

export async function getConnectionDetail(db: RuntimeDb, id: string, now: Date = new Date()) {
  const rows = await deploymentJoinBase(db).where(eq(schema.deployments.id, id)).limit(1);
  const row = rows[0];
  if (!row) return null;
  const deployment = row.deployment;

  const jobs = await db
    .select()
    .from(schema.deploymentJobs)
    .where(eq(schema.deploymentJobs.deploymentId, id))
    .orderBy(desc(schema.deploymentJobs.createdAt))
    .limit(10);

  const communicationPossible =
    deployment.relayStatus === 'CONNECTED' &&
    deployment.lastHealthAt !== null &&
    now.getTime() - deployment.lastHealthAt.getTime() <= RELAY_STALE_AFTER_MS;

  return {
    deployment: {
      id: deployment.id,
      organizationId: row.organizationId,
      organizationName: row.organizationName,
      customerName: row.customerName,
      applicationName: row.applicationName,
      state: deployment.state,
      healthStatus: deployment.healthStatus,
    },
    connection: {
      awsAccountId: deployment.awsAccountId,
      region: deployment.region,
      relayStatus: deployment.relayStatus,
      lastHealthAt: deployment.lastHealthAt,
      relayVersion: deployment.relayVersion,
      bootstrapVersion: deployment.bootstrapVersion,
      bootstrapStackName: deployment.bootstrapStackName,
      installationId: deployment.installationId,
      attemptNumber: deployment.attemptNumber,
      cleanupState: deployment.cleanupState,
      state: deployment.state,
      communicationPossible,
    },
    jobs: jobs.map((job) => ({
      id: job.id,
      type: job.type,
      state: job.state,
      stuck: isJobStuck(job, now),
      createdAt: job.createdAt,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
    })),
  };
}

// ── Search ───────────────────────────────────────────────────────────────

export async function adminSearch(db: RuntimeDb, rawQuery: string) {
  const query = rawQuery.trim();
  if (query.length < 2) {
    return { vendors: [], applications: [], customers: [], deployments: [], jobs: [] };
  }
  const like = `%${query}%`;

  const orgByNameRows = await db
    .select()
    .from(schema.organization)
    .where(or(ilike(schema.organization.name, like), ilike(schema.organization.slug, like)))
    .limit(10);
  const emailMatchOrgIds = await db
    .select({ organizationId: schema.member.organizationId })
    .from(schema.member)
    .innerJoin(schema.user, eq(schema.member.userId, schema.user.id))
    .where(ilike(schema.user.email, like))
    .limit(10);
  const knownOrgIds = new Set(orgByNameRows.map((org) => org.id));
  const extraOrgIds = emailMatchOrgIds.map((row) => row.organizationId).filter((orgId) => !knownOrgIds.has(orgId));
  const extraOrgRows = extraOrgIds.length
    ? await db.select().from(schema.organization).where(inArray(schema.organization.id, extraOrgIds)).limit(10)
    : [];
  const vendors = [...orgByNameRows, ...extraOrgRows]
    .slice(0, 10)
    .map((org) => ({ id: org.id, name: org.name, slug: org.slug }));

  const applicationRows = await db
    .select({
      id: schema.applications.id,
      name: schema.applications.name,
      repoFullName: schema.applications.repoFullName,
      organizationId: schema.applications.organizationId,
      organizationName: schema.organization.name,
    })
    .from(schema.applications)
    .innerJoin(schema.organization, eq(schema.applications.organizationId, schema.organization.id))
    .where(or(ilike(schema.applications.name, like), ilike(schema.applications.repoFullName, like)))
    .limit(10);

  const customerRows = await db
    .select({
      id: schema.customers.id,
      name: schema.customers.name,
      email: schema.customers.email,
      organizationId: schema.customers.organizationId,
      organizationName: schema.organization.name,
    })
    .from(schema.customers)
    .innerJoin(schema.organization, eq(schema.customers.organizationId, schema.organization.id))
    .where(
      or(
        ilike(schema.customers.name, like),
        ilike(schema.customers.email, like),
        ilike(schema.customers.company, like),
      ),
    )
    .limit(10);

  const deploymentConditions = [
    eq(schema.deployments.installationId, query),
    eq(schema.deployments.awsAccountId, query),
    ilike(schema.deployments.bootstrapStackName, like),
  ];
  if (isUuid(query)) {
    deploymentConditions.push(eq(schema.deployments.id, query));
    deploymentConditions.push(eq(schema.deployments.installLinkId, query));
  }
  let deploymentRows = await deploymentJoinBase(db).where(or(...deploymentConditions)).limit(10);

  const knownDeploymentIds = new Set(deploymentRows.map((row) => row.deployment.id));
  const domainMatches = await db
    .select()
    .from(schema.customDomains)
    .where(ilike(schema.customDomains.hostname, like))
    .limit(10);
  const domainDeploymentIds = domainMatches
    .map((domain) => domain.deploymentId)
    .filter((deploymentId) => !knownDeploymentIds.has(deploymentId));
  if (domainDeploymentIds.length) {
    const more = await deploymentJoinBase(db).where(inArray(schema.deployments.id, domainDeploymentIds)).limit(10);
    deploymentRows = [...deploymentRows, ...more];
  }
  const deployments = deploymentRows.slice(0, 10).map((row) => ({
    id: row.deployment.id,
    organizationId: row.organizationId,
    organizationName: row.organizationName,
    applicationName: row.applicationName,
    customerName: row.customerName,
    awsAccountId: row.deployment.awsAccountId,
    state: row.deployment.state,
  }));

  const jobRows = isUuid(query) ? await jobJoinBase(db).where(eq(schema.deploymentJobs.id, query)).limit(10) : [];
  const jobs = jobRows.map((row) => ({
    id: row.job.id,
    type: row.job.type,
    state: row.job.state,
    deploymentId: row.deploymentId,
    organizationId: row.organizationId,
    organizationName: row.organizationName,
  }));

  return { vendors, applications: applicationRows, customers: customerRows, deployments, jobs };
}

// ── Audit log ───────────────────────────────────────────────────────────────

export interface AuditLogParams {
  actor?: string | undefined;
  action?: string | undefined;
  targetType?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
  limit?: number | undefined;
  before?: number | undefined;
}

export async function getAuditLog(db: RuntimeDb, params: AuditLogParams) {
  const limit = Math.min(Math.max(params.limit ?? 50, 1), 200);
  const conditions = [like(schema.eventLogs.eventType, 'admin.%')];

  if (params.action) {
    conditions.push(
      or(eq(schema.eventLogs.eventType, params.action), like(schema.eventLogs.eventType, `${params.action}.%`))!,
    );
  }
  if (params.actor) {
    conditions.push(
      or(
        eq(schema.eventLogs.actorId, params.actor),
        sql`${schema.eventLogs.payload}->>'adminEmail' ilike ${`%${params.actor}%`}`,
      )!,
    );
  }
  if (params.targetType) {
    conditions.push(sql`${schema.eventLogs.payload}->>'targetType' = ${params.targetType}`);
  }
  if (params.from) {
    conditions.push(gte(schema.eventLogs.occurredAt, new Date(params.from)));
  }
  if (params.to) {
    conditions.push(lte(schema.eventLogs.occurredAt, new Date(params.to)));
  }
  if (params.before !== undefined) {
    conditions.push(lt(schema.eventLogs.id, params.before));
  }

  const rows = await db
    .select()
    .from(schema.eventLogs)
    .where(and(...conditions))
    .orderBy(desc(schema.eventLogs.id))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const events = rows.slice(0, limit);
  const nextBefore = hasMore ? events[events.length - 1]!.id : null;

  return { events, nextBefore };
}
