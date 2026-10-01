// Pure mappers for the customer install page's canonical AWS resources
// table. The page already receives the deployment plan (and only the plan)
// from the public install endpoint; everything here derives from that
// shape so the visible inventory is identical to the plan the API serves
// for installation. Never invents prices, never invents descriptions.

import {
  AWS_RESOURCE_GROUP_DISPLAY,
  AWS_RESOURCE_GROUP_ORDER,
  type AwsResourceGroup,
  type DeploymentPlan,
  type DeploymentPlanAwsResource,
  type FootprintCostEstimate,
  type FootprintCostItem,
} from '@deployz/contracts';

export type ResourceCostStatus =
  | { kind: 'estimated'; label: string }
  | { kind: 'usage_based'; label: 'Usage-based' }
  | { kind: 'included'; label: 'Included' }
  | { kind: 'unpriced'; label: 'Pricing unavailable' };

/** One row of the customer AWS resources table. */
export interface AwsResourceRow {
  id: string;
  name: string;
  purpose: string;
  group: AwsResourceGroup;
  /** null when the resource has no meaningful direct cost — the cell renders "—" per task brief. */
  cost: ResourceCostStatus | null;
  /** Plain-language configuration ("Persistent · retained", "Internet-facing HTTPS"). */
  configuration: string;
}

/** One grouped section of the AWS resources table, with stable labels and order. */
export interface AwsResourceGroupSection {
  group: AwsResourceGroup;
  label: string;
  rows: AwsResourceRow[];
}

function formatRange(min: number, max: number): string {
  if (min === max) return `~$${Math.round(min)}/mo`;
  return `~$${Math.round(min)}\u2013${Math.round(max)}/mo`;
}

/** Per-resource cost lookup built from the plan's cost estimate. */
export interface CostItemLookup {
  byId: Map<string, FootprintCostItem>;
  /** True when at least one item was billed by usage only. */
  hasUsageBased: boolean;
}

export function buildCostLookup(estimate: FootprintCostEstimate | null | undefined): CostItemLookup {
  const byId = new Map<string, FootprintCostItem>();
  let hasUsageBased = false;
  if (estimate) {
    for (const item of estimate.items) {
      byId.set(item.resourceId, item);
      if (item.pricingStatus === 'usage_based') hasUsageBased = true;
    }
  }
  return { byId, hasUsageBased };
}

/**
 * One row's resource-level cost. Mirrors `formatRowCost` from the
 * configuration inventory (apps/web/src/lib/configuration-inventory.ts)
 * but stays narrow: the customer sees only the price-display labels the
 * task brief enumerates, never the helper's "+ unpriced items" expansion.
 * `null` means "no meaningful direct cost" — the table renders "—" then.
 */
export function rowCost(rowId: string, lookup: CostItemLookup): ResourceCostStatus | null {
  const item = lookup.byId.get(rowId);
  if (!item) return null;
  if (item.pricingStatus === 'usage_based') {
    return { kind: 'usage_based', label: 'Usage-based' };
  }
  if (item.pricingStatus === 'unavailable') {
    return { kind: 'unpriced', label: 'Pricing unavailable' };
  }
  if (item.monthlyMin === undefined || item.monthlyMax === undefined) {
    return null;
  }
  return { kind: 'estimated', label: formatRange(item.monthlyMin, item.monthlyMax) };
}

/**
 * The plain-text "Configuration" cell for one resource. Combines the
 * lifecycle disclosure (when persistent/retained) with the runtime sizing
 * the plan's footprint already carries, so the customer sees the same
 * sizing the configuration inventory shows the vendor.
 */
export function resourceConfigurationText(
  resource: DeploymentPlanAwsResource,
  plan: DeploymentPlan | null,
): string {
  const parts: string[] = [];
  // Lifecycle disclosure — the brief allows one compact line per resource.
  if (resource.lifecycle === 'retain') parts.push('Persistent \u00b7 retained');

  // Sizing line — driven by the same footprint rows the vendor sees.
  const footprintRow = plan?.footprint?.resources.find((entry) => entry.id === resource.id);
  if (footprintRow) {
    const sizingParts: string[] = [];
    if (footprintRow.label) sizingParts.push(footprintRow.label);
    const engine = footprintRow.configuration['engine'];
    if (typeof engine === 'string') sizingParts.push(engine);
    if (sizingParts.length > 0) parts.push(sizingParts.join(' \u00b7 '));
  }

  // For the application workload, derive a sizing from the matching
  // `workloads` entry so the table reads "Fargate · Small" / "Fargate".
  if (resource.id === 'ecs_service') {
    const workload = plan?.footprint?.workloads.find((entry) => entry.role === 'web');
    if (workload) {
      parts.push(workload.compute.sizeLabel);
    }
  }

  return parts.length > 0 ? parts.join(' \u00b7 ') : '\u2014';
}

/** Build the customer-facing AWS resources rows, grouped and ordered. */
export function buildAwsResourceSections(
  plan: DeploymentPlan | null,
): AwsResourceGroupSection[] {
  if (!plan || plan.awsResources.length === 0) return [];
  const costLookup = buildCostLookup(plan.costEstimate);
  const groups = new Map<AwsResourceGroup, DeploymentPlanAwsResource[]>();
  for (const resource of plan.awsResources) {
    const bucket = groups.get(resource.group) ?? [];
    bucket.push(resource);
    groups.set(resource.group, bucket);
  }
  const sections: AwsResourceGroupSection[] = [];
  for (const group of AWS_RESOURCE_GROUP_ORDER) {
    const rows = groups.get(group);
    if (!rows || rows.length === 0) continue;
    sections.push({
      group,
      label: AWS_RESOURCE_GROUP_DISPLAY[group],
      rows: rows.map((resource) => ({
        id: resource.id,
        name: resource.name,
        purpose: resource.purpose,
        group: resource.group,
        cost: rowCost(resource.id, costLookup),
        configuration: resourceConfigurationText(resource, plan),
      })),
    });
  }
  return sections;
}

/**
 * Compact lifecycle summary the page renders below the table — "Database
 * and S3 bucket stay in your AWS account." Null when nothing is retained.
 * Avoids the per-row retention messaging the brief asks us to remove.
 */
export function retentionSummary(plan: DeploymentPlan | null): string | null {
  if (!plan) return null;
  const retained = plan.awsResources.filter((resource) => resource.lifecycle === 'retain');
  if (retained.length === 0) return null;
  const names = retained.map((resource) => resource.name);
  const list =
    names.length === 1
      ? names[0]!
      : names.length === 2
        ? `${names[0]} and ${names[1]}`
        : `${names.slice(0, -1).join(', ')}, and ${names[names.length - 1]}`;
  const verb = retained.length === 1 ? 'stays' : 'stay';
  return `Most resources are removed with the deployment. ${list} ${verb} in your AWS account and may continue to incur AWS charges.`;
}

// ── Environment variables ──────────────────────────────────────────────────

export type EnvVarSource = 'customer' | 'publisher' | 'deployz';
export type EnvVarStatus = 'Required' | 'Ready' | 'Optional';

export interface EnvVarRow {
  key: string;
  purpose: string;
  source: EnvVarSource;
  sourceLabel: string;
  status: EnvVarStatus;
}

export interface EnvVarSummary {
  needInput: number;
  configured: number;
  total: number;
  /** "2 need your input · 4 configured" — the customer-facing headline. */
  headline: string;
}

/**
 * Map an EnvVariableClassification into the customer-facing Source column.
 * `customer_required` → You; `deployz_managed` / `deployz_generated` →
 * Deployz; everything else (optional / unknown) → Publisher with a note.
 */
export function envVarSource(classification: string | undefined, secret: boolean): EnvVarSource {
  switch (classification) {
    case 'customer_required':
      return 'customer';
    case 'deployz_managed':
    case 'deployz_generated':
      return 'deployz';
    case 'optional':
    case 'unknown':
      return secret ? 'publisher' : 'publisher';
    default:
      return 'publisher';
  }
}

export function envVarSourceLabel(source: EnvVarSource): string {
  switch (source) {
    case 'customer':
      return 'You';
    case 'publisher':
      return 'Publisher';
    case 'deployz':
      return 'Deployz';
  }
}

/** Status of one env var for the customer surface. */
export function envVarStatus(input: {
  required: boolean;
  hasValue: boolean;
  /** When the value is delivered by Deployz or the publisher, it is not
   *  "Required" — it is already configured before the customer reaches the
   *  page (deployment- / / publish). */
  source: EnvVarSource;
}): EnvVarStatus {
  if (input.source !== 'customer') return 'Ready';
  if (input.required && !input.hasValue) return 'Required';
  if (!input.required && !input.hasValue) return 'Optional';
  return 'Ready';
}

export function buildEnvVarRows(
  rawInputs: ReadonlyArray<{
    key: string;
    required: boolean;
    secret: boolean;
    classification?: string;
    purpose?: string;
    label?: string;
  }>,
): EnvVarRow[] {
  return rawInputs.map((input) => {
    const source = envVarSource(input.classification, input.secret);
    return {
      key: input.key,
      purpose: input.purpose ?? input.label ?? input.key,
      source,
      sourceLabel: envVarSourceLabel(source),
      status: envVarStatus({ required: input.required, hasValue: false, source }),
    };
  });
}

export function summarizeEnvVars(rows: ReadonlyArray<EnvVarRow>): EnvVarSummary {
  let needInput = 0;
  let configured = 0;
  for (const row of rows) {
    if (row.status === 'Required') needInput += 1;
    else if (row.status === 'Ready') configured += 1;
  }
  const total = rows.length;
  const headline =
    total === 0
      ? 'No environment variables required.'
      : needInput === 0
        ? `All ${total} configured`
        : `${needInput} ${needInput === 1 ? 'needs' : 'need'} your input \u00b7 ${configured} configured`;
  return { needInput, configured, total, headline };
}