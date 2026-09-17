// Plan-driven presentation for the customer-facing install surfaces (the
// install page and the hosted deploy-link page). Both surfaces render the
// same `DeploymentPlan` the API derives from the deployment's frozen
// manifest — the UI never derives infrastructure intent itself (see
// docs/ui-system.md).

import { INFRASTRUCTURE_COMPONENT_DISPLAY, REGION_LABELS, type DeploymentPlan, type Region } from '@deployz/contracts';

/** One row of the customer "Deployz will create" table. */
export interface InstallPlanRow {
  kind: string;
  name: string;
  whatHappens: string;
}

// A missing/invalid stored manifest never guesses resources into existence —
// the API sends `plan: null` in that case. The install page still needs
// something to show, so it falls back to the one component every
// deployment has.
const FALLBACK_ROWS: InstallPlanRow[] = [
  {
    kind: 'application',
    name: INFRASTRUCTURE_COMPONENT_DISPLAY.application.name,
    whatHappens: INFRASTRUCTURE_COMPONENT_DISPLAY.application.purpose,
  },
];

/** The install plan's CREATE components, in catalog order, as table rows. */
export function installPlanRows(plan: DeploymentPlan | null): InstallPlanRow[] {
  if (!plan) return FALLBACK_ROWS;
  return plan.components
    .filter((component) => component.action === 'CREATE')
    .map((component) => ({
      kind: component.kind,
      name: component.name,
      whatHappens: INFRASTRUCTURE_COMPONENT_DISPLAY[component.kind].purpose,
    }));
}

function joinNames(names: string[]): string {
  if (names.length === 1) return names[0]!;
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(', ')}, and ${names[names.length - 1]}`;
}

/**
 * "When this deployment is removed, Database and Storage stay in your AWS
 * account." Null when the plan is unavailable or nothing is retained — a
 * fully stateless deployment has nothing to disclose here.
 */
export function installPlanRetentionNote(plan: DeploymentPlan | null): string | null {
  if (!plan) return null;
  const retainedNames = plan.components
    .filter((component) => component.lifecycle === 'retain')
    .map((component) => component.name);
  if (retainedNames.length === 0) return null;
  return `When this deployment is removed, ${joinNames(retainedNames)} stay in your AWS account.`;
}

/**
 * The region label for the install/deploy pages ("US East (N. Virginia)").
 * Null for a region Deployz does not recognize — the page hides the region
 * line rather than showing a raw AWS region code.
 */
export function installPlanRegionLabel(region: string): string | null {
  return REGION_LABELS[region as Region] ?? null;
}
