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

/** What the NEXT production deployment does to the counts once it is live. */
export interface NextProductionDeploymentImpact {
  activeAfter: number;
  included: number;
  billedAfter: number;
  /** True when the billed quantity rises — i.e. the deployment is beyond the allowance. */
  addsCharge: boolean;
}

export function nextProductionDeploymentImpact(
  counts: ProductionDeploymentCounts,
): NextProductionDeploymentImpact {
  const activeAfter = counts.active + 1;
  const billedAfter = Math.max(activeAfter - counts.included, 0);
  return { activeAfter, included: counts.included, billedAfter, addsCharge: billedAfter > counts.billable };
}

/**
 * The sentence shown on the create page before the vendor commits. `counts`
 * is null while unknown: the fallback names the price without claiming a
 * count, because showing the wrong number for a moment is worse than none.
 */
export function nextProductionDeploymentCopy(
  subscribed: boolean,
  counts: ProductionDeploymentCounts | null,
): string {
  const price = `$${DEPLOYMENT_PRICE_DOLLARS}/month`;
  if (!subscribed) {
    const base = `This is your first customer deployment, so it starts your subscription: $${PLATFORM_PRICE_DOLLARS}/month for the platform, plus ${price} for each customer deployment once it is live.`;
    if (!counts || counts.included === 0) return base;
    const impact = nextProductionDeploymentImpact(counts);
    if (impact.addsCharge) return base;
    return `${base} ${counts.included} production ${counts.included === 1 ? 'deployment is' : 'deployments are'} included with your account, so this deployment adds no deployment charge once it goes live. Starting monthly rate: $${PLATFORM_PRICE_DOLLARS}/month.`;
  }
  if (!counts || counts.included === 0) {
    return `This adds ${price} once the deployment is live.`;
  }
  const impact = nextProductionDeploymentImpact(counts);
  const after = `After this deployment goes live: ${impact.activeAfter} active, ${impact.included} included, ${impact.billedAfter} billed`;
  return impact.addsCharge
    ? `${after} at ${price}. This deployment counts toward your production deployment total once it is live.`
    : `${after}. This deployment is covered by your included allowance and adds no deployment charge.`;
}
