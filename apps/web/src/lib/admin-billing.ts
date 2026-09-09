/**
 * Pure, client-safe preview math for the "included production deployments"
 * allowance editor (VendorBillingSection in app/admin/vendors/[id]/page.tsx).
 * Mirrors the API's own max(active - included, 0) formula
 * (AdminVendorBilling.billableDeploymentQuantity) so the confirmation dialog
 * can show the billable-quantity effect before the request is sent.
 */

export interface IncludedDeploymentsPreview {
  previousBillable: number;
  nextBillable: number;
  direction: 'increase' | 'decrease' | 'unchanged';
}

export function previewIncludedDeploymentsChange({
  activeProductionDeployments,
  currentIncluded,
  nextIncluded,
}: {
  activeProductionDeployments: number;
  currentIncluded: number;
  nextIncluded: number;
}): IncludedDeploymentsPreview {
  const previousBillable = Math.max(activeProductionDeployments - currentIncluded, 0);
  const nextBillable = Math.max(activeProductionDeployments - nextIncluded, 0);
  const direction =
    nextIncluded > currentIncluded ? 'increase' : nextIncluded < currentIncluded ? 'decrease' : 'unchanged';
  return { previousBillable, nextBillable, direction };
}
