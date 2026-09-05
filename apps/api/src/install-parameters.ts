import { randomBytes } from 'node:crypto';

import { and, desc, eq, isNotNull, isNull } from 'drizzle-orm';

import { DOCUMENSO_PARAMETERS, IMAGE_REFERENCE_PARAMETER } from '@deployz/contracts';
import type { RuntimeDb } from '@deployz/db';
import * as schema from '@deployz/db/schema';

import { parseDefaultHttps } from './default-https.js';
import { findActiveDomain } from './domains.js';

function generateSecret(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * Whether the deployment's application needs a Redis cache provisioned. The
 * INSTALL executor reads this as a top-level payload field (not one of the
 * CloudFormation parameters above), so it is looked up separately rather
 * than folded into buildInstallParameters.
 */
export async function readRedisRequired(db: RuntimeDb, applicationId: string): Promise<boolean> {
  const rows = await db
    .select({ redisRequired: schema.applications.redisRequired })
    .from(schema.applications)
    .where(eq(schema.applications.id, applicationId))
    .limit(1);
  return rows[0]?.redisRequired ?? false;
}

/**
 * Builds the CloudFormation parameter values for an INSTALL job (§31).
 * Phase 1: the runtime-v1 template is Documenso-shaped, so every install
 * receives these; unrelated images simply ignore the injected env vars.
 * - imageReference (DEPLOY-001) is the deployment's application's newest
 *   READY release with a known image (`imageUnavailableAt` null); when no
 *   such release exists the key is omitted and the template falls back to
 *   its publish-time default image.
 * - publicUrl follows the preferred-URL model (Phase 7): an ACTIVE custom
 *   domain, else the ACTIVE default-HTTPS hostname, else a pre-created custom
 *   domain's hostname (legacy install-time behavior). When no URL applies the
 *   key is omitted and the template falls back to the load balancer's own URL
 *   (see SecretParameterSpec.fallbackToLoadBalancerUrl), so a domain-less
 *   install still boots with a usable URL.
 * - Auth/encryption secrets are generated per install and travel only
 *   through the job payload into NoEcho parameters and Secrets Manager.
 * - SMTP parameters are declared in the template but not yet populated —
 *   vendor config supplies them in a later phase.
 */
export async function buildInstallParameters(
  db: RuntimeDb,
  deploymentId: string,
): Promise<Record<string, string>> {
  const rows = await db
    .select({
      applicationId: schema.deployments.applicationId,
      healthPath: schema.applications.healthPath,
      defaultHttps: schema.deployments.defaultHttps,
    })
    .from(schema.deployments)
    .innerJoin(schema.applications, eq(schema.deployments.applicationId, schema.applications.id))
    .where(eq(schema.deployments.id, deploymentId))
    .limit(1);
  const domain = await findActiveDomain(db, deploymentId);
  const defaultHttps = parseDefaultHttps(rows[0]?.defaultHttps ?? null);
  const parameters: Record<string, string> = {
    [DOCUMENSO_PARAMETERS.nextauthSecret]: generateSecret(),
    [DOCUMENSO_PARAMETERS.encryptionKey]: generateSecret(),
    [DOCUMENSO_PARAMETERS.encryptionSecondaryKey]: generateSecret(),
  };
  if (rows[0]?.healthPath) {
    // The canonical, analysis-resolved health path — the same value the ALB
    // target group and container health checks probe via the template's
    // param_HealthCheckPath parameter (CDK strips the underscore).
    parameters['paramHealthCheckPath'] = rows[0].healthPath;
  }
  if (rows[0]?.applicationId) {
    // DEPLOY-001 — a fresh install must run the application's own release,
    // not the image the template happened to be published with. Same
    // selection as autoDeploySelectedRelease (READY, image not known
    // unavailable), newest first; no such release leaves the key absent so
    // the template's publish-time default applies.
    const releaseRows = await db
      .select({ imageDigest: schema.releases.imageDigest })
      .from(schema.releases)
      .where(
        and(
          eq(schema.releases.applicationId, rows[0].applicationId),
          eq(schema.releases.releaseStatus, 'READY'),
          isNull(schema.releases.imageUnavailableAt),
          isNotNull(schema.releases.imageDigest),
        ),
      )
      .orderBy(desc(schema.releases.createdAt))
      .limit(1);
    const imageDigest = releaseRows[0]?.imageDigest;
    if (imageDigest) {
      parameters[IMAGE_REFERENCE_PARAMETER] = imageDigest;
    }
  }
  // Phase 7 — publicUrl follows the plan's preferred-URL model so a (re)install
  // configures the app with the address that will actually serve it: an ACTIVE
  // custom domain, else the permanent default-HTTPS hostname once IT is ACTIVE.
  // A default URL that is only PENDING/CONFIGURING/ERROR is never handed to the
  // app (it does not serve yet) — that falls back to the pre-existing behavior:
  // a pre-created custom domain's hostname, else no publicUrl at all (the
  // template then falls back to the load balancer's own URL).
  let publicUrl: string | null = null;
  if (domain?.status === 'ACTIVE') {
    publicUrl = `https://${domain.hostname}`;
  } else if (defaultHttps?.status === 'ACTIVE') {
    publicUrl = `https://${defaultHttps.hostname}`;
  } else if (domain) {
    publicUrl = `https://${domain.hostname}`;
  }
  if (publicUrl) {
    parameters[DOCUMENSO_PARAMETERS.publicUrl] = publicUrl;
  }
  return parameters;
}
