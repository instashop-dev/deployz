import { and, desc, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';

import { generatedEnvKeys } from '@deployz/analysis';
import {
  REGION_LABELS,
  SUPPORTED_AWS_REGIONS,
  buildInstallPlan,
  type DeploymentManifest,
  type EnvVariableClassification,
  type Region,
} from '@deployz/contracts';
import type { RuntimeDb } from '@deployz/db';
import * as schema from '@deployz/db/schema';

import { createConfigStore, createRelaySecretWriter, setConfig } from './config.js';
import { assertProductionDeploymentAllowed } from './billing-entitlements.js';
import { createDeploymentRecord } from './deploy-links.js';
import { env } from './env.js';
import { ApiError, NotFoundError } from './errors.js';
import { recordEvent } from './events.js';
import { requirePreflightReady, runApplicationPreflight } from './preflight.js';

// Public Install Links — the customer-side installation review surface. A
// link is vendor-published and credential-free: anyone holding the opaque
// uuid may review the offer (GET) and confirm an installation (POST), so the
// vendor stops that by disabling or revoking the link, never by hiding the id.
//
// The resolve projection is deliberately small: application name, publisher
// name, the newest published release, the deployable regions, the inputs the
// customer may/must supply, and the same INSTALL plan the install page
// serves. No secrets, no manifest JSON, no template URLs, no CloudFormation
// parameters, and no internal ids — the opaque link id is the only
// identifier this surface ever sees or returns (the confirm response's
// installLinkId excepted: it is the customer's own handle into the existing
// /install flow, which owns everything after this point).

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type PublicInstallLinkRow = typeof schema.publicInstallLinks.$inferSelect;
type ApplicationRow = typeof schema.applications.$inferSelect;

/** One input the confirm body may (optional) or must (required) supply. */
export interface PublicInstallInput {
  readonly key: string;
  readonly required: boolean;
  readonly secret: boolean;
  readonly classification?: EnvVariableClassification;
  readonly purpose?: 'internal_secret' | 'external_credential' | 'infrastructure_binding' | 'optional_configuration' | 'unknown';
}

// The confirm body — strict at every level so hostile keys (databaseRequired
// and friends) are rejected by validation instead of ever reaching the
// manifest or profile. Query parameters are never read on this surface.
export const publicInstallConfirmBodySchema = z
  .object({
    idempotencyKey: z.string().uuid(),
    region: z.string().min(1),
    customer: z
      .object({
        name: z.string().trim().min(1),
        email: z.string().trim().email(),
      })
      .strict(),
    config: z
      .array(
        z
          .object({
            key: z.string().min(1),
            value: z.string(),
            isSecret: z.boolean(),
          })
          .strict(),
      )
      .max(200),
  })
  .strict();
export type PublicInstallConfirmBody = z.infer<typeof publicInstallConfirmBodySchema>;

/** A non-uuid id would raise a Postgres error and surface as a 500 — map to 404 instead. */
function requireUuidId(id: string): void {
  if (!UUID_PATTERN.test(id)) {
    throw new NotFoundError('Resource not found');
  }
}

interface ActivePublicInstallLink {
  link: PublicInstallLinkRow;
  application: ApplicationRow;
  publisherName: string;
}

/**
 * Resolve the link and enforce its lifecycle: unknown/malformed ids 404, a
 * revoked link 410, a disabled link 410 with its own code (so the page can
 * say the vendor turned it off rather than guess at a broken URL).
 */
async function loadActiveLink(db: RuntimeDb, linkId: string): Promise<ActivePublicInstallLink> {
  requireUuidId(linkId);
  const rows = await db
    .select({
      link: schema.publicInstallLinks,
      application: schema.applications,
      publisherName: schema.organization.name,
    })
    .from(schema.publicInstallLinks)
    .innerJoin(schema.applications, eq(schema.publicInstallLinks.applicationId, schema.applications.id))
    .innerJoin(schema.organization, eq(schema.publicInstallLinks.organizationId, schema.organization.id))
    .where(eq(schema.publicInstallLinks.id, linkId))
    .limit(1);
  if (rows.length === 0) {
    throw new NotFoundError('Install link not found');
  }
  const row = rows[0]!;
  if (row.link.revokedAt !== null) {
    throw new ApiError(410, 'PUBLIC_INSTALL_LINK_REVOKED', 'This installation link has been revoked.');
  }
  if (!row.link.enabled) {
    throw new ApiError(
      410,
      'PUBLIC_INSTALL_LINK_DISABLED',
      'This application is not currently available for installation.',
    );
  }
  return row;
}

/**
 * The newest published release: READY (built, digest recorded by the
 * pipeline) and not known-unavailable. The same selection the post-install
 * auto-deploy uses — null means nothing is published yet, which refuses the
 * whole surface with 410 rather than offering an install that cannot run.
 */
async function newestPublishedRelease(
  db: RuntimeDb,
  applicationId: string,
): Promise<{ version: string; createdAt: Date } | null> {
  const rows = await db
    .select({ version: schema.releases.version, createdAt: schema.releases.createdAt })
    .from(schema.releases)
    .where(
      and(
        eq(schema.releases.applicationId, applicationId),
        eq(schema.releases.releaseStatus, 'READY'),
        isNull(schema.releases.imageUnavailableAt),
      ),
    )
    .orderBy(desc(schema.releases.createdAt))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * The inputs the customer supplies at confirm time: required non-secret
 * values, required secrets, and optional values. Generated/internal keys are
 * EXCLUDED — the relay mints them inside the customer's account (the same
 * mintable rule install-config.ts applies), so asking for them would both
 * leak the mechanism and produce a value nothing reads.
 */
export function publicInstallInputs(manifest: DeploymentManifest): PublicInstallInput[] {
  const mintable = new Set<string>(generatedEnvKeys(manifest));
  for (const variable of manifest.environment.variables) {
    if (variable.secret === true && variable.purpose === 'internal_secret') mintable.add(variable.key);
  }
  return manifest.environment.variables
    .filter(
      (variable) =>
        variable.classification !== 'deployz_managed' &&
        variable.classification !== 'deployz_generated' &&
        !mintable.has(variable.key),
    )
    .map((variable) => ({
      key: variable.key,
      // The same predicate the preflight's required-customer-variables check
      // uses, so the form and the gate can never disagree.
      required:
        variable.classification === 'customer_required' ||
        (variable.classification === undefined && variable.required),
      secret: variable.secret,
      ...(variable.classification !== undefined ? { classification: variable.classification } : {}),
      ...(variable.purpose !== undefined ? { purpose: variable.purpose } : {}),
    }));
}

/**
 * GET /api/public-install/:linkId — the review projection. The manifest is
 * the same effective construction the readiness/plan endpoints serve
 * (runApplicationPreflight), so the public page can never disagree with the
 * vendor surfaces about what an install creates.
 */
export async function resolvePublicInstall(db: RuntimeDb, linkId: string) {
  const { application, publisherName, link } = await loadActiveLink(db, linkId);
  const release = await newestPublishedRelease(db, link.applicationId);
  if (release === null) {
    throw new ApiError(410, 'RELEASE_NOT_PUBLISHED', 'This application has no published release yet.');
  }
  const { manifest } = await runApplicationPreflight(db, application, null);
  return {
    application: { name: application.name },
    publisher: { name: publisherName },
    release: { version: release.version, createdAt: release.createdAt },
    regions: SUPPORTED_AWS_REGIONS.filter((region) => env.deployableAwsRegions.includes(region)).map(
      (region) => ({ value: region, label: REGION_LABELS[region] }),
    ),
    requiredInputs: publicInstallInputs(manifest),
    plan: buildInstallPlan({ manifest, region: null }),
  };
}

async function findConfirmedInstallLinkId(
  db: RuntimeDb,
  linkId: string,
  confirmKey: string,
): Promise<string | null> {
  const rows = await db
    .select({ installLinkId: schema.deployments.installLinkId })
    .from(schema.deployments)
    .where(
      and(eq(schema.deployments.publicInstallLinkId, linkId), eq(schema.deployments.confirmKey, confirmKey)),
    )
    .limit(1);
  return rows[0]?.installLinkId ?? null;
}

/** Whether an error is the confirm-idempotency unique violation (the insert race). */
function isConfirmKeyViolation(error: unknown): boolean {
  for (let cause: unknown = error; cause; cause = (cause as { cause?: unknown }).cause) {
    const c = cause as { code?: string; constraint?: string };
    if (c.code === '23505') {
      return c.constraint === 'deployments_public_install_confirm_uidx';
    }
  }
  return false;
}

/**
 * POST /api/public-install/:linkId/confirm — turn an accepted review into
 * exactly one deployment plus one customer row per (link, idempotency key).
 * Gates run in order: link active (404/410 as resolve), region deployable
 * (422 REGION_NOT_SUPPORTED), preflight ready against the effective manifest
 * with the submitted keys counted as provided (422 MANIFEST_NOT_COMPATIBLE
 * / MANIFEST_NEEDS_CONFIGURATION), then the submitted config itself (422
 * with the offending keys), then the PRODUCTION subscription gate (402
 * SUBSCRIPTION_REQUIRED — the same gate POST /api/deployments and
 * createDeployLink run; replays of an already-confirmed key return the
 * existing deployment before the gate so a lapsed subscription cannot
 * strand a customer mid-flow).
 *
 * Config capture rides the SAME §31 path as vendor-entered customer
 * configuration (setConfig): non-secret values persist as plaintext
 * customer-scoped rows; secret values persist only as SECRET_MASK — the
 * plaintext never touches the control-plane DB, and the relay write-through
 * seam carries it exactly as for a vendor-typed secret on a customer whose
 * relay is not connected yet. Creates no job and touches no relay state:
 * the existing /install flow owns everything after this point.
 */
export async function confirmPublicInstall(
  db: RuntimeDb,
  linkId: string,
  body: PublicInstallConfirmBody,
): Promise<{ installLinkId: string; created: boolean }> {
  const { application, link } = await loadActiveLink(db, linkId);
  const release = await newestPublishedRelease(db, link.applicationId);
  if (release === null) {
    throw new ApiError(410, 'RELEASE_NOT_PUBLISHED', 'This application has no published release yet.');
  }
  if (!env.deployableAwsRegions.includes(body.region)) {
    throw new ApiError(
      422,
      'REGION_NOT_SUPPORTED',
      `Region ${body.region} is not available for installation yet.`,
    );
  }
  const bodyKeys = [...new Set(body.config.map((entry) => entry.key))];
  const { manifest, result } = await runApplicationPreflight(db, application, null, bodyKeys);
  requirePreflightReady(result);
  const inputs = publicInstallInputs(manifest);
  const inputKeys = new Set(inputs.map((input) => input.key));
  const bodyKeySet = new Set(bodyKeys);
  const missing = inputs.filter((input) => input.required && !bodyKeySet.has(input.key)).map((input) => input.key);
  const unexpected = bodyKeys.filter((key) => !inputKeys.has(key));
  if (missing.length > 0 || unexpected.length > 0) {
    const sentences: string[] = [];
    if (missing.length > 0) sentences.push(`These values are required but missing: ${missing.join(', ')}.`);
    if (unexpected.length > 0) sentences.push(`These keys are not part of this application: ${unexpected.join(', ')}.`);
    throw new ApiError(422, 'PUBLIC_INSTALL_CONFIG_INVALID', sentences.join(' '), {
      ...(missing.length > 0 ? { missing } : {}),
      ...(unexpected.length > 0 ? { unexpected } : {}),
    });
  }

  const existing = await findConfirmedInstallLinkId(db, link.id, body.idempotencyKey);
  if (existing !== null) {
    return { installLinkId: existing, created: false };
  }

  // PRODUCTION deployments require an ACTIVE subscription — the same gate as
  // POST /api/deployments and createDeployLink, run before any row is created.
  await assertProductionDeploymentAllowed(db, link.organizationId, env.billingEnforcementPaused);

  const actorId = `public-install:${link.id}`;
  try {
    const deployment = await db.transaction(async (tx) => {
      const [customer] = await tx
        .insert(schema.customers)
        .values({
          organizationId: link.organizationId,
          name: body.customer.name,
          email: body.customer.email,
        })
        .returning();
      await recordEvent(tx, {
        organizationId: link.organizationId,
        eventType: 'customer.created',
        actorType: 'system',
        actorId,
        customerId: customer!.id,
        payload: { schemaVersion: 1, customerId: customer!.id },
      });
      await setConfig(link.applicationId, customer!.id, body.config, {
        store: createConfigStore(tx),
        secretWriter: createRelaySecretWriter(),
      });
      const { deployment } = await createDeploymentRecord(tx, {
        organizationId: link.organizationId,
        applicationId: link.applicationId,
        customerId: customer!.id,
        region: body.region as Region,
        deploymentType: 'PRODUCTION',
        createdBy: null,
        updatedBy: null,
        source: 'public_link',
        publicInstallLinkId: link.id,
        confirmKey: body.idempotencyKey,
      });
      return deployment;
    });
    return { installLinkId: deployment.installLinkId, created: true };
  } catch (error) {
    // Two concurrent confirms with the same key can both pass the pre-check;
    // the partial unique index admits exactly one. The loser returns the
    // winner's deployment instead of erroring.
    if (isConfirmKeyViolation(error)) {
      const winner = await findConfirmedInstallLinkId(db, link.id, body.idempotencyKey);
      if (winner !== null) {
        return { installLinkId: winner, created: false };
      }
    }
    throw error;
  }
}
