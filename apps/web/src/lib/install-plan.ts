// Plan-driven presentation for the customer-facing install surfaces (the
// install page and the hosted deploy-link page). Both surfaces render the
// same `DeploymentPlan` the API derives from the deployment's frozen
// manifest — the UI never derives infrastructure intent itself (see
// docs/ui-system.md).

import {
  AWS_RESOURCE_GROUP_DISPLAY,
  AWS_RESOURCE_GROUP_ORDER,
  CONNECTOR_RESOURCES,
  INFRASTRUCTURE_COMPONENT_DISPLAY,
  REGION_LABELS,
  type AwsResourceGroup,
  type DeploymentPlan,
  type DeploymentPlanAwsResource,
  type Region,
} from '@deployz/contracts';

/** "Database: not provisioned here, now required" / the reverse — one line per
 *  requirement-drift entry (Phase 4's `DeploymentPlan['requirementDrift']`
 *  and the application-page drift notice). Shared so the wording never
 *  diverges. */
export function requirementDriftLine(entry: {
  kind: 'database' | 'cache' | 'storage';
  deployed: boolean;
  desired: boolean;
}): string {
  const name = INFRASTRUCTURE_COMPONENT_DISPLAY[entry.kind].name;
  return entry.desired && !entry.deployed
    ? `${name}: not provisioned here, now required`
    : `${name}: provisioned here, no longer required`;
}

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
 * The plan's retained components, in plan order — the single source both the
 * retention note and the deploy page's collapsed "Data retention" section
 * read from, so the two can never name different components.
 */
export function installPlanRetainedComponents(plan: DeploymentPlan | null): DeploymentPlan['components'] {
  if (!plan) return [];
  return plan.components.filter((component) => component.lifecycle === 'retain');
}

/**
 * "When this deployment is removed, Database and Storage stay in your AWS
 * account." Null when the plan is unavailable or nothing is retained — a
 * fully stateless deployment has nothing to disclose here.
 */
export function installPlanRetentionNote(plan: DeploymentPlan | null): string | null {
  const retainedNames = installPlanRetainedComponents(plan).map((component) => component.name);
  if (retainedNames.length === 0) return null;
  const verb = retainedNames.length === 1 ? 'stays' : 'stay';
  return `When this deployment is removed, ${joinNames(retainedNames)} ${verb} in your AWS account.`;
}

/**
 * The region label for the install/deploy pages ("US East (N. Virginia)").
 * Null for a region Deployz does not recognize — the page hides the region
 * line rather than showing a raw AWS region code.
 */
export function installPlanRegionLabel(region: string): string | null {
  return REGION_LABELS[region as Region] ?? null;
}

/** "Deleted" / "Kept in your AWS account" — the only two removal labels the
 *  "AWS infrastructure details" table shows for a resource's lifecycle. */
export function awsResourceRemovalLabel(lifecycle: DeploymentPlanAwsResource['lifecycle']): string {
  return lifecycle === 'retain' ? 'Kept in your AWS account' : 'Deleted';
}

/** One heading group of the "AWS infrastructure details" table. */
export interface AwsResourceGroupRows {
  group: AwsResourceGroup;
  label: string;
  resources: DeploymentPlanAwsResource[];
}

/**
 * The plan's AWS resources, grouped and ordered for display (Compute &
 * Networking, Data, Security & Operations); empty groups are omitted.
 */
export function awsResourceGroups(plan: DeploymentPlan | null): AwsResourceGroupRows[] {
  if (!plan) return [];
  return AWS_RESOURCE_GROUP_ORDER.map((group) => ({
    group,
    label: AWS_RESOURCE_GROUP_DISPLAY[group],
    resources: plan.awsResources.filter((resource) => resource.group === group),
  })).filter((entry) => entry.resources.length > 0);
}

/** The only two removal labels the install page's infrastructure table shows. */
export const INSTALL_RESOURCE_REMOVAL_LABEL = {
  delete: 'Removed automatically',
  retain: 'Retained in your AWS account',
} as const;

/** One row of the install page's single infrastructure table. */
export interface InstallResourceRow {
  id: string;
  name: string;
  /** The AWS service plus exact sizing/configuration where the footprint has it. */
  serviceAndConfiguration: string;
  purpose: string;
  onRemoval: string;
}

/** One heading group of the install page's single infrastructure table. */
export interface InstallResourceGroupRows {
  group: AwsResourceGroup;
  label: string;
  rows: InstallResourceRow[];
}

/**
 * The install page's ONE infrastructure table: the Deployz connector's
 * resources first, then the application's — grouped by the shared catalog
 * order, with exact sizing read from the plan's deployment footprint where the
 * footprint provides it. Never invents a size: a row without a footprint match
 * shows its service name only.
 */
export function installPlanResourceGroups(plan: DeploymentPlan | null): InstallResourceGroupRows[] {
  const footprint = plan?.footprint ?? null;
  const workload = footprint?.workloads?.[0] ?? null;
  const resourceByRole = new Map((footprint?.resources ?? []).map((resource) => [resource.role, resource]));

  const sizingFor = (kind: DeploymentPlanAwsResource['componentKind']): string | null => {
    if (kind === 'application' && workload) {
      return `${workload.quantity} × ${workload.compute.sizeLabel} · ${workload.compute.cpuUnits / 1024} vCPU · ${workload.compute.memoryMiB} MB`;
    }
    const resource = resourceByRole.get(kind);
    if (!resource) return null;
    return resource.quantity > 1 ? `${resource.quantity} × ${resource.label}` : resource.label;
  };

  const rows: InstallResourceRow[] = [
    ...CONNECTOR_RESOURCES.map((resource) => ({
      id: resource.id,
      name: resource.name,
      serviceAndConfiguration: resource.name,
      purpose: resource.purpose,
      onRemoval: INSTALL_RESOURCE_REMOVAL_LABEL[resource.lifecycle],
    })),
    ...(plan?.awsResources ?? []).map((resource) => {
      const sizing = sizingFor(resource.componentKind);
      return {
        id: resource.id,
        name: resource.name,
        serviceAndConfiguration: sizing ? `${resource.name} · ${sizing}` : resource.name,
        purpose: resource.purpose,
        onRemoval: INSTALL_RESOURCE_REMOVAL_LABEL[resource.lifecycle],
      };
    }),
  ];

  return AWS_RESOURCE_GROUP_ORDER.map((group) => ({
    group,
    label: AWS_RESOURCE_GROUP_DISPLAY[group],
    rows: rows.filter((row) => {
      if (group === 'connector') return CONNECTOR_RESOURCES.some((resource) => resource.id === row.id);
      return (plan?.awsResources ?? []).some(
        (resource) => resource.id === row.id && resource.group === group,
      );
    }),
  })).filter((entry) => entry.rows.length > 0);
}
