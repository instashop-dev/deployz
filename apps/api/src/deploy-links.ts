import crypto from 'node:crypto';

import { and, desc, eq } from 'drizzle-orm';

import type { Region } from '@deployz/contracts';
import type { RuntimeDb } from '@deployz/db';
import * as schema from '@deployz/db/schema';

import { env } from './env.js';
import { ApiError, NotFoundError } from './errors.js';
import { recordEvent } from './events.js';
import { requirePreflightReady, runApplicationPreflight } from './preflight.js';
import { hashRelayToken, mintEnrollmentCode, verifyRelayToken } from './relay-store.js';

// Deploy Links — a vendor-generated, tokenized entry point. Each link pre-
// creates one deployment (deployments.source = 'deploy_link') through the
// SAME creation logic as the vendor manual flow (createDeploymentRecord, also
// called by POST /api/deployments), then records a deploy_links row keyed to
// it. The customer presents the link's public uuid + secret token (header
// `x-deployz-token`) at the public resolve route; the token authorizes only
// this one deployment flow and never becomes a session.

/** How long a freshly minted (or regenerated) link stays valid. */
export const DEFAULT_DEPLOY_LINK_TTL_DAYS = 30;

// Re-using the install-page throttle window: an 'opened' write per open would
// flood event_logs on a polling page, but a 60s cadence still records each
// visit that is more than a minute apart.
const LAST_USED_THROTTLE_MS = 60_000;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type DeployLinkRow = typeof schema.deployLinks.$inferSelect;
type ApplicationRow = typeof schema.applications.$inferSelect;
type CustomerRow = typeof schema.customers.$inferSelect;
type DeploymentRow = typeof schema.deployments.$inferSelect;
type DeploymentSource = (typeof schema.deployments.$inferInsert)['source'];

/** A fresh 32-byte hex secret. Stored only as its sha256 (see tokenHash). */
export function mintDeployLinkToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

function linkExpiry(now: Date = new Date()): Date {
  return new Date(now.getTime() + DEFAULT_DEPLOY_LINK_TTL_DAYS * 24 * 60 * 60 * 1000);
}

/** A non-uuid id would raise a Postgres error and surface as a 500 — map to 404 instead. */
function requireUuidId(id: string): void {
  if (!UUID_PATTERN.test(id)) {
    throw new NotFoundError('Resource not found');
  }
}

// ── Ownership-scoped loaders (IDOR guards) ──────────────────────────────────
// Same rules as server.ts: a link/deployment/customer of another org 404s,
// never 403s, so cross-tenant existence never leaks.

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

async function loadOwnedCustomer(db: RuntimeDb, id: string, organizationId: string): Promise<CustomerRow> {
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

async function loadOwnedLink(db: RuntimeDb, id: string, organizationId: string): Promise<DeployLinkRow> {
  requireUuidId(id);
  const rows = await db
    .select()
    .from(schema.deployLinks)
    .where(and(eq(schema.deployLinks.id, id), eq(schema.deployLinks.organizationId, organizationId)))
    .limit(1);
  if (rows.length === 0) {
    throw new NotFoundError('Deploy link not found');
  }
  return rows[0]!;
}

// ── Shared deployment creation (also used by POST /api/deployments) ────────

export interface CreateDeploymentParams {
  organizationId: string;
  applicationId: string;
  customerId: string;
  region: Region;
  isTestDeployment: boolean;
  createdBy: string | null;
  updatedBy: string | null;
  source: DeploymentSource;
}

export interface CreatedDeployment {
  deployment: DeploymentRow;
  application: ApplicationRow;
}

/**
 * The POST /api/deployments creation body, extracted so the manual route and
 * the deploy-link flow run ONE implementation: org-scoped 404s, the manifest
 * readiness gates, and the insert (state NOT_INSTALLED, fresh enrollment
 * code, final manifest as desiredState). The deployable-region gate stays in
 * the callers because each route must keep its own pre-load ordering.
 */
export async function createDeploymentRecord(
  db: RuntimeDb,
  params: CreateDeploymentParams,
): Promise<CreatedDeployment> {
  const application = await loadOwnedApplication(db, params.applicationId, params.organizationId);
  await loadOwnedCustomer(db, params.customerId, params.organizationId);
  // The one preflight every path into provisioning runs — the manifest gate
  // against THIS customer's configuration plus the readiness report's
  // remaining findings. Generated secrets are never minted on the control
  // plane (#186): the relay mints them inside the customer's account after
  // install, and the preflight counts them as auto-provided.
  const { manifest, result } = await runApplicationPreflight(db, application, params.customerId);
  const actor =
    params.createdBy !== null
      ? { actorType: 'user' as const, actorId: params.createdBy }
      : { actorType: 'system' as const, actorId: 'deployment-creation' };
  // The preflight gate itself is the funnel event (result: pass|blocked).
  // A blocked evaluation writes nothing and the caller throws — for the
  // deploy-link flow that happens inside its tx, which rolls this event back
  // (no deployment exists to attach it to); the manual flow persists it.
  if (!result.ready) {
    await recordEvent(db, {
      organizationId: params.organizationId,
      eventType: 'application.preflight_evaluated',
      ...actor,
      customerId: params.customerId,
      payload: {
        schemaVersion: 1,
        applicationId: params.applicationId,
        result: 'blocked',
        blockingCount: result.blockers.length,
        warningCount: result.warnings.length,
      },
    });
  }
  requirePreflightReady(result);
  const [row] = await db
    .insert(schema.deployments)
    .values({
      customerId: params.customerId,
      applicationId: params.applicationId,
      organizationId: params.organizationId,
      region: params.region,
      state: 'NOT_INSTALLED',
      source: params.source,
      desiredState: { manifest },
      enrollmentCode: mintEnrollmentCode(),
      isTestDeployment: params.isTestDeployment,
      createdBy: params.createdBy,
      updatedBy: params.updatedBy,
    })
    .returning();
  await recordEvent(db, {
    organizationId: params.organizationId,
    eventType: 'application.preflight_evaluated',
    ...actor,
    deploymentId: row!.id,
    customerId: params.customerId,
    payload: {
      schemaVersion: 1,
      applicationId: params.applicationId,
      result: 'pass',
      blockingCount: result.blockers.length,
      warningCount: result.warnings.length,
    },
  });
  return { deployment: row!, application };
}

// ── Link lifecycle ──────────────────────────────────────────────────────────

export interface CreateDeployLinkParams {
  organizationId: string;
  userId: string;
  customerId: string;
  applicationId: string;
  region: Region;
}

export async function createDeployLink(
  db: RuntimeDb,
  params: CreateDeployLinkParams,
): Promise<{ link: DeployLinkRow; deployment: DeploymentRow; application: ApplicationRow; token: string }> {
  // Same fail-closed gate as POST /api/deployments: a link may only target a
  // region whose bootstrap artifacts are CONFIRMED published.
  if (!env.deployableAwsRegions.includes(params.region)) {
    throw new ApiError(
      422,
      'REGION_NOT_SUPPORTED',
      `Region ${params.region} is not available for installation yet.`,
    );
  }
  const token = mintDeployLinkToken();
  const result = await db.transaction(async (tx) => {
    const { deployment, application } = await createDeploymentRecord(tx, {
      organizationId: params.organizationId,
      customerId: params.customerId,
      applicationId: params.applicationId,
      region: params.region,
      isTestDeployment: false,
      createdBy: params.userId,
      updatedBy: params.userId,
      source: 'deploy_link',
    });
    const [link] = await tx
      .insert(schema.deployLinks)
      .values({
        organizationId: params.organizationId,
        customerId: deployment.customerId,
        applicationId: deployment.applicationId,
        deploymentId: deployment.id,
        tokenHash: hashRelayToken(token),
        expiresAt: linkExpiry(),
        createdBy: params.userId,
      })
      .returning();
    await recordEvent(tx, {
      organizationId: params.organizationId,
      eventType: 'deploy_link.created',
      actorType: 'user',
      actorId: params.userId,
      deploymentId: deployment.id,
      customerId: deployment.customerId,
      payload: { applicationId: deployment.applicationId, linkId: link!.id },
    });
    return { link: link!, deployment, application };
  });
  return { ...result, token };
}

export async function revokeDeployLink(
  db: RuntimeDb,
  params: { organizationId: string; userId: string; linkId: string },
): Promise<DeployLinkRow> {
  const link = await loadOwnedLink(db, params.linkId, params.organizationId);
  // Idempotent: revoking an already-revoked link returns its current state.
  if (link.revokedAt !== null) {
    return link;
  }
  const [updated] = await db
    .update(schema.deployLinks)
    .set({ revokedAt: new Date() })
    .where(and(eq(schema.deployLinks.id, params.linkId), eq(schema.deployLinks.organizationId, params.organizationId)))
    .returning();
  await recordEvent(db, {
    organizationId: params.organizationId,
    eventType: 'deploy_link.revoked',
    actorType: 'user',
    actorId: params.userId,
    deploymentId: link.deploymentId,
    customerId: link.customerId,
  });
  return updated!;
}

export async function regenerateDeployLink(
  db: RuntimeDb,
  params: { organizationId: string; userId: string; linkId: string },
): Promise<{ link: DeployLinkRow; token: string }> {
  const link = await loadOwnedLink(db, params.linkId, params.organizationId);
  const deployments = await db
    .select({ state: schema.deployments.state })
    .from(schema.deployments)
    .where(eq(schema.deployments.id, link.deploymentId))
    .limit(1);
  if (deployments.length === 0 || deployments[0]!.state !== 'NOT_INSTALLED') {
    throw new ApiError(
      409,
      'DEPLOYMENT_ALREADY_STARTED',
      'This deploy link can no longer be regenerated because its deployment has already started.',
    );
  }
  const token = mintDeployLinkToken();
  const [updated] = await db
    .update(schema.deployLinks)
    .set({
      tokenHash: hashRelayToken(token),
      // Regeneration revives the link: a fresh secret, a fresh expiry, and a
      // clean usage history (revokedAt cleared so a revoked link is reusable).
      expiresAt: linkExpiry(),
      lastUsedAt: null,
      revokedAt: null,
    })
    .where(and(eq(schema.deployLinks.id, params.linkId), eq(schema.deployLinks.organizationId, params.organizationId)))
    .returning();
  await recordEvent(db, {
    organizationId: params.organizationId,
    eventType: 'deploy_link.regenerated',
    actorType: 'user',
    actorId: params.userId,
    deploymentId: link.deploymentId,
    customerId: link.customerId,
  });
  return { link: updated!, token };
}

export interface ResolvedDeployLink {
  link: DeployLinkRow;
  deployment: DeploymentRow;
  application: ApplicationRow;
  customer: CustomerRow;
}

/**
 * Resolve the public link: verify the secret token against the stored hash
 * and return what the customer page needs. Malformed/unknown id and a
 * missing/mismatched token are all the same 404 — the caller can never learn
 * which of the three failed.
 */
export async function resolveDeployLink(
  db: RuntimeDb,
  publicId: string,
  token: string | undefined,
): Promise<ResolvedDeployLink> {
  requireUuidId(publicId);
  const rows = await db
    .select({
      link: schema.deployLinks,
      deployment: schema.deployments,
      application: schema.applications,
      customer: schema.customers,
    })
    .from(schema.deployLinks)
    .innerJoin(schema.deployments, eq(schema.deployLinks.deploymentId, schema.deployments.id))
    .innerJoin(schema.applications, eq(schema.deployLinks.applicationId, schema.applications.id))
    .innerJoin(schema.customers, eq(schema.deployLinks.customerId, schema.customers.id))
    .where(eq(schema.deployLinks.id, publicId))
    .limit(1);
  if (rows.length === 0) {
    throw new NotFoundError('Deploy link not found');
  }
  const row = rows[0]!;
  if (token === undefined || !verifyRelayToken(row.link.tokenHash, token)) {
    throw new NotFoundError('Deploy link not found');
  }
  if (row.link.revokedAt !== null) {
    throw new ApiError(410, 'DEPLOY_LINK_REVOKED', 'This deploy link has been revoked.');
  }
  if (row.link.expiresAt.getTime() < Date.now()) {
    throw new ApiError(410, 'DEPLOY_LINK_EXPIRED', 'This deploy link has expired.');
  }
  if (row.deployment.state === 'DELETED') {
    throw new NotFoundError('Deploy link not found');
  }
  // The opened marker/event is throttled: a page that polls (or a tab that
  // reloads) within the window does not rewrite last_used_at or spam the log.
  const lastUsedAt = row.link.lastUsedAt;
  if (lastUsedAt === null || Date.now() - lastUsedAt.getTime() >= LAST_USED_THROTTLE_MS) {
    await db
      .update(schema.deployLinks)
      .set({ lastUsedAt: new Date() })
      .where(eq(schema.deployLinks.id, row.link.id));
    await recordEvent(db, {
      organizationId: row.link.organizationId,
      eventType: 'deploy_link.opened',
      actorType: 'system',
      actorId: `deploy-link:${publicId}`,
      deploymentId: row.deployment.id,
      customerId: row.customer.id,
    });
  }
  return row;
}

export async function listDeployLinks(
  db: RuntimeDb,
  organizationId: string,
  customerId: string,
): Promise<{ link: DeployLinkRow; deployment: DeploymentRow; application: ApplicationRow }[]> {
  return db
    .select({
      link: schema.deployLinks,
      deployment: schema.deployments,
      application: schema.applications,
    })
    .from(schema.deployLinks)
    .innerJoin(schema.deployments, eq(schema.deployLinks.deploymentId, schema.deployments.id))
    .innerJoin(schema.applications, eq(schema.deployLinks.applicationId, schema.applications.id))
    .where(
      and(eq(schema.deployLinks.organizationId, organizationId), eq(schema.deployLinks.customerId, customerId)),
    )
    .orderBy(desc(schema.deployLinks.createdAt));
}
