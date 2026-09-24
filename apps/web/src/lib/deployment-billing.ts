import type { DeploymentBillingState, DeploymentType } from '@deployz/contracts';

// Paddle migration Phase 11 — what a vendor is told a deployment costs.
// Kept apart from deployments.ts (which reads `next/headers`) so a client
// component can import a label without pulling server-only code into the
// browser bundle. Same split as deployment-vocabulary.ts.
//
// Included production deployments: the allowance is pooled across the
// organization, so no individual deployment is ever "free" or "$19". A
// deployment counts toward the production deployment total once live; what
// the organization pays is max(active − included, 0) × the deployment price.
//
// The customer never sees any of this: pricing is between Deployz and the
// vendor, and the install/deploy-link pages must stay free of it.

/** The price of one billed production deployment, in whole dollars. */
export const DEPLOYMENT_PRICE_DOLLARS = 19;

/** The platform subscription, in whole dollars. */
export const PLATFORM_PRICE_DOLLARS = 49;

/** The subset of a deployment these labels need. */
export interface BillingLabelSource {
  deploymentType: DeploymentType;
  billingState: DeploymentBillingState;
}

/** Live production deployments, the included allowance, and what is billed. */
export interface ProductionDeploymentCounts {
  active: number;
  included: number;
  /** max(active − included, 0). */
  billable: number;
}

/**
 * The one-line answer to "what does this deployment mean for my bill?".
 *
 * Reads the deployment's own billing state, never its health: a deployment
 * that is temporarily unhealthy still counts, and one that never came up
 * never did. That is the whole point of billing_state being separate from
 * §46 state. Never a per-deployment price — see the pooled rule above.
 */
export function deploymentBillingLabel(deployment: BillingLabelSource): string {
  if (deployment.deploymentType === 'TEST') return 'Free test deployment';
  switch (deployment.billingState) {
    case 'ACTIVE':
      return 'Counts toward your production deployment total';
    case 'STOPPED':
      return 'No longer counts toward your production deployment total';
    default:
      return 'Counts toward your production deployment total once live';
  }
}

/** True for a vendor-owned test deployment, which is always free. */
export function isTestDeployment(deployment: BillingLabelSource): boolean {
  return deployment.deploymentType === 'TEST';
}
