// Billing correctness rules — pure functions that decide whether a
// deployment is billable. Deployz displays prices but does no money math;
// the billing provider is the source of truth for charges and invoices.

export const PLATFORM_PRICE_DOLLARS = 49; // base platform price, display only
export const DEPLOYMENT_PRICE_DOLLARS = 19; // price per billable deployment, display only

// ── Deployment state snapshot (subset of the full deployment row) ───────────

export interface DeploymentBillingState {
  state: string;
  isTestDeployment: boolean;
}

// ── Billing gate ─────────────────────────────────────────────────────────

/**
 * Returns true ONLY when the deployment is HEALTHY or UPDATE_AVAILABLE (both
 * are live serving states — UPDATE_AVAILABLE just means a newer release
 * exists, which does not affect billing) and NOT a test deployment.
 */
export function shouldBillForDeployment(deployment: DeploymentBillingState): boolean {
  return (
    (deployment.state === 'HEALTHY' || deployment.state === 'UPDATE_AVAILABLE') &&
    !deployment.isTestDeployment
  );
}

