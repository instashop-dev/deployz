import { randomUUID } from 'node:crypto';

import type { RuntimeDb } from '@deployz/db';
import * as schema from '@deployz/db/schema';
import { eq } from 'drizzle-orm';

import { recordEvent } from './events.js';
import { hashRelayToken, mintEnrollmentCode, mintRelayCredential } from './relay-store.js';

/** How long a freshly issued invitation stays valid. */
export const INSTALL_LINK_TTL_DAYS = 30;

/** The expiry a newly issued (or rotated) invitation gets. */
export function installLinkExpiryFrom(now: Date): Date {
  return new Date(now.getTime() + INSTALL_LINK_TTL_DAYS * 24 * 60 * 60 * 1000);
}

/**
 * Vendor revocation of an unused invitation. Idempotent: revoking an already
 * revoked link returns the existing timestamp unchanged. A link whose install
 * has already started keeps serving the customer's progress view — the gate in
 * server.ts only blocks *starting* — so revocation never hides live work.
 */
export async function revokeInstallLink(
  db: RuntimeDb,
  deployment: {
    id: string;
    organizationId: string;
    customerId: string;
    installLinkId: string;
    installLinkRevokedAt: Date | null;
  },
  actorId: string,
  now: Date = new Date(),
): Promise<{ revokedAt: Date }> {
  const revokedAt = deployment.installLinkRevokedAt ?? now;
  if (deployment.installLinkRevokedAt === null) {
    await db
      .update(schema.deployments)
      .set({ installLinkRevokedAt: revokedAt, updatedAt: now })
      .where(eq(schema.deployments.id, deployment.id));
    await recordEvent(db, {
      organizationId: deployment.organizationId,
      eventType: 'install_link.revoked',
      actorType: 'user',
      actorId,
      deploymentId: deployment.id,
      customerId: deployment.customerId,
      payload: { schemaVersion: 1, installLinkId: deployment.installLinkId },
    });
  }
  return { revokedAt };
}

/**
 * Vendor replacement of an invitation (rotate). Mints a new link id, a fresh
 * single-use enrollment code and a fresh relay credential, so anything derived
 * from the old URL — including a leaked enrollment code — stops working, and
 * clears any prior revocation. The old link 404s immediately. Refused once an
 * install has started: the running installation keeps its own link and its
 * progress view.
 */
export async function rotateInstallLink(
  db: RuntimeDb,
  deployment: { id: string; organizationId: string; customerId: string; enrollmentUsedAt: Date | null },
  actorId: string,
  now: Date = new Date(),
): Promise<{ installLinkId: string; expiresAt: Date } | { refused: 'INSTALL_ALREADY_STARTED' }> {
  if (deployment.enrollmentUsedAt !== null) {
    return { refused: 'INSTALL_ALREADY_STARTED' };
  }
  const installLinkId = randomUUID();
  const enrollmentCode = mintEnrollmentCode();
  const relayCredential = mintRelayCredential();
  const expiresAt = installLinkExpiryFrom(now);
  await db
    .update(schema.deployments)
    .set({
      installLinkId,
      enrollmentCode,
      relayCredential,
      relayTokenHash: hashRelayToken(relayCredential),
      installLinkExpiresAt: expiresAt,
      installLinkRevokedAt: null,
      updatedAt: now,
    })
    .where(eq(schema.deployments.id, deployment.id));
  await recordEvent(db, {
    organizationId: deployment.organizationId,
    eventType: 'install_link.rotated',
    actorType: 'user',
    actorId,
    deploymentId: deployment.id,
    customerId: deployment.customerId,
    payload: { schemaVersion: 1, expiresAt: expiresAt.toISOString() },
  });
  return { installLinkId, expiresAt };
}
