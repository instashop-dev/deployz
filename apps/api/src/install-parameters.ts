import { randomBytes } from 'node:crypto';

import { eq } from 'drizzle-orm';

import { DOCUMENSO_PARAMETERS } from '@deployz/contracts';
import type { RuntimeDb } from '@deployz/db';
import * as schema from '@deployz/db/schema';

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
 * - publicUrl comes from the deployment's custom domain when one exists
 *   before INSTALL. When no domain exists the key is omitted and the
 *   template falls back to the load balancer's own URL (see
 *   SecretParameterSpec.fallbackToLoadBalancerUrl), so a domain-less
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
  const domain = await findActiveDomain(db, deploymentId);
  const parameters: Record<string, string> = {
    [DOCUMENSO_PARAMETERS.nextauthSecret]: generateSecret(),
    [DOCUMENSO_PARAMETERS.encryptionKey]: generateSecret(),
    [DOCUMENSO_PARAMETERS.encryptionSecondaryKey]: generateSecret(),
  };
  if (domain) {
    parameters[DOCUMENSO_PARAMETERS.publicUrl] = `https://${domain.hostname}`;
  }
  return parameters;
}
