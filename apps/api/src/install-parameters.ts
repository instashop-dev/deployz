import { randomBytes } from 'node:crypto';

import { and, desc, eq, isNotNull, isNull } from 'drizzle-orm';

import { DOCUMENSO_PARAMETERS, IMAGE_REFERENCE_PARAMETER } from '@deployz/contracts';
import type { RuntimeDb } from '@deployz/db';
import * as schema from '@deployz/db/schema';

import { parseDefaultHttps } from './default-https.js';
import { findActiveDomain } from './domains.js';
import { readStoredManifest } from './manifest.js';

function generateSecret(): string {
  return randomBytes(32).toString('base64url');
}

/** CFN logical id of the template's task-count parameter (CDK strips the underscore from `param_DesiredCount`). */
export const DESIRED_COUNT_PARAMETER = 'paramDesiredCount';

/**
 * Builds the CloudFormation parameter values for an INSTALL job (§31).
 * Phase 1: the runtime-v1 template is Documenso-shaped, so every install
 * receives these; unrelated images simply ignore the injected env vars.
 * - imageReference (DEPLOY-001) is the deployment's application's newest
 *   READY release with a known image (`imageUnavailableAt` null); when no
 *   such release exists the key is omitted and the template falls back to
 *   its publish-time default image. `releaseId` names the selected release
 *   (for the deployment identity tags) or null when none was.
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
  options: {
    /**
     * DEPLOY-009: configuration must reach the task before it first starts.
     * With a release to run, the service is created with zero tasks and the
     * first deploy after the post-install configuration pass starts it;
     * without one, nothing could start anyway and the key is omitted.
     */
    startAfterConfig?: boolean;
  } = {},
): Promise<{ parameters: Record<string, string>; releaseId: string | null }> {
  const rows = await db
    .select({
      applicationId: schema.deployments.applicationId,
      desiredState: schema.deployments.desiredState,
      defaultHttps: schema.deployments.defaultHttps,
    })
    .from(schema.deployments)
    .where(eq(schema.deployments.id, deploymentId))
    .limit(1);
  const domain = await findActiveDomain(db, deploymentId);
  const defaultHttps = parseDefaultHttps(rows[0]?.defaultHttps ?? null);
  const manifest = readStoredManifest(rows[0]?.desiredState ?? null);
  const parameters: Record<string, string> = {
    [DOCUMENSO_PARAMETERS.nextauthSecret]: generateSecret(),
    [DOCUMENSO_PARAMETERS.encryptionKey]: generateSecret(),
    [DOCUMENSO_PARAMETERS.encryptionSecondaryKey]: generateSecret(),
  };
  let releaseId: string | null = null;
  if (manifest) {
    // The canonical, manifest-resolved health path (Phase 2) — the same
    // value the ALB target group and container health checks probe via the
    // template's param_HealthCheckPath parameter (CDK strips the
    // underscore). Never the live `applications.healthPath` column, which
    // can drift from what this deployment was actually created with.
    parameters['paramHealthCheckPath'] = manifest.health.path;
  }
  if (rows[0]?.applicationId) {
    // DEPLOY-001 — a fresh install must run the application's own release,
    // not the image the template happened to be published with. Same
    // selection as autoDeploySelectedRelease (READY, image not known
    // unavailable), newest first; no such release leaves the key absent so
    // the template's publish-time default applies.
    const releaseRows = await db
      .select({ id: schema.releases.id, imageDigest: schema.releases.imageDigest })
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
      releaseId = releaseRows[0]?.id ?? null;
      if (options.startAfterConfig === true) {
        parameters[DESIRED_COUNT_PARAMETER] = '0';
      }
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
  return { parameters, releaseId };
}
