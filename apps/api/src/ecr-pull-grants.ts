/**
 * ECR pull-grant lifecycle for one installation, control-plane side.
 *
 * The vendor's private ECR repository lives in the control-plane account;
 * the customer's deployment stack runs in the customer's account. The relay
 * cannot touch the repository policy (no cross-account IAM in that direction),
 * and the customer account id is only known to the control plane — so the
 * grant/revoke calls happen here, next to the job lifecycle that owns them:
 *
 *   INSTALL requested → grantPullToCustomer (idempotent, retry-safe)
 *   DESTROY / PURGE  → revokePullFromCustomer (idempotent, safe when absent)
 *
 * Both are best-effort by design: a grant the control plane cannot apply
 * surfaces later as the customer task's honest IMAGE_PULL_FAILED, and a
 * revoke that cannot land leaves an over-broad-but-owner-known grant, never a
 * broken caller. Neither helper throws.
 */

import { env } from './env.js';
import { createRealEcrClient, grantPull, revokePull, type EcrClient } from './ecr-grants.js';

export interface EcrPullGrantDeps {
  readonly ecr: EcrClient;
  readonly repositoryName: string;
}

/** Production wiring; tests inject their own `ecr` client. */
export function createEcrPullGrantDeps(ecr?: EcrClient): EcrPullGrantDeps {
  return { ecr: ecr ?? createRealEcrClient(), repositoryName: env.ecrRepositoryName };
}

/**
 * Grants the deployment's customer account pull access for its installation.
 * Idempotent (an existing Sid is replaced in place) and never throws.
 */
export async function grantPullToCustomer(
  deps: EcrPullGrantDeps,
  installationId: string,
  customerAccountId: string,
): Promise<void> {
  try {
    const result = await grantPull(deps.ecr, deps.repositoryName, installationId, customerAccountId);
    console.log(
      JSON.stringify({ event: 'ecr:pull-granted', installationId, customerAccountId, ...result }),
    );
  } catch (error) {
    console.error(
      JSON.stringify({
        event: 'ecr:pull-grant-failed',
        installationId,
        customerAccountId,
        error: String(error),
      }),
    );
  }
}

/**
 * Revokes the same grant. Idempotent (no grant for this Sid is success) and
 * never throws.
 */
export async function revokePullFromCustomer(
  deps: EcrPullGrantDeps,
  installationId: string,
): Promise<void> {
  try {
    const result = await revokePull(deps.ecr, deps.repositoryName, installationId);
    console.log(
      JSON.stringify({ event: 'ecr:pull-revoked', installationId, ...result }),
    );
  } catch (error) {
    console.error(
      JSON.stringify({ event: 'ecr:pull-revoke-failed', installationId, error: String(error) }),
    );
  }
}