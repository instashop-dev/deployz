import type { DeploymentBillingState, DeploymentType } from '@deployz/contracts';

// Paddle migration Phase 11 — what a vendor is told a deployment costs.
// Kept apart from deployments.ts (which reads `next/headers`) so a client
// component can import a label without pulling server-only code into the
// browser bundle. Same split as deployment-vocabulary.ts.
//
// The customer never sees any of this: pricing is between Deployz and the
// vendor, and the install/deploy-link pages must stay free of it.

/** The price of one live customer deployment, in whole dollars. */
export const DEPLOYMENT_PRICE_DOLLARS = 19;

/** The subset of a deployment these labels need. */
export interface BillingLabelSource {
  deploymentType: DeploymentType;
  billingState: DeploymentBillingState;
}

/**
 * The one-line answer to "what does this deployment cost me?".
 *
 * Reads the deployment's own billing state, never its health: a deployment
 * that is temporarily unhealthy is still billed, and one that never came up
 * never was. That is the whole point of billing_state being separate from
 * §46 state.
 */
export function deploymentBillingLabel(deployment: BillingLabelSource): string {
  if (deployment.deploymentType === 'TEST') return 'Free test deployment';
  switch (deployment.billingState) {
    case 'ACTIVE':
      return `$${DEPLOYMENT_PRICE_DOLLARS}/month`;
    case 'STOPPED':
      return 'Billing stopped';
    default:
      return `Not billed until live — then $${DEPLOYMENT_PRICE_DOLLARS}/month`;
  }
}

/** True for a vendor-owned test deployment, which is always free. */
export function isTestDeployment(deployment: BillingLabelSource): boolean {
  return deployment.deploymentType === 'TEST';
}
