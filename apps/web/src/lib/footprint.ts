// Footprint-driven presentation for the vendor and customer surfaces. Both
// render the `DeploymentFootprint` the API embeds in every `DeploymentPlan`
// — the UI never derives infrastructure intent or sizes itself (see
// docs/ui-system.md). Everything here is generic over `role`/`category`/
// `service`: adding MySQL, a worker or a queue later needs no change here.

import {
  FOOTPRINT_ENGINE_DISPLAY,
  FOOTPRINT_SERVICE_DISPLAY,
  type DeploymentFootprint,
  type FootprintCostEstimate,
  type FootprintResource,
  type FootprintWorkload,
} from '@deployz/contracts';

/** One row of the footprint summary table. */
export interface FootprintRow {
  id: string;
  /** Row heading — the purpose ("Web application", "Database"). */
  title: string;
  /** The resolved sizing line ("1 × Small", "PostgreSQL"). */
  primary: string;
  /** The exact AWS identifiers line ("RDS · db.t4g.micro · 20 GB"). */
  detail: string | null;
  /** Lifecycle wording; null when the row is not material for persistence. */
  lifecycle: string | null;
}

/** "Persistent · retained when the deployment is removed" — and its counterpart. */
export function footprintLifecycleLabel(item: { lifecycle: { persistent: boolean; retainOnDelete: boolean } }): string {
  return item.lifecycle.retainOnDelete
    ? 'Persistent · retained when the deployment is removed'
    : 'Removed with the deployment';
}

function serviceDisplay(service: string): string {
  return FOOTPRINT_SERVICE_DISPLAY[service] ?? service;
}

function engineDisplay(configuration: Record<string, unknown>): string | null {
  const engine = configuration['engine'];
  return typeof engine === 'string' ? (FOOTPRINT_ENGINE_DISPLAY[engine] ?? null) : null;
}

function workloadRow(workload: FootprintWorkload): FootprintRow {
  const vcpu = workload.compute.cpuUnits / 1024;
  const memoryGb = workload.compute.memoryMiB / 1024;
  return {
    id: workload.id,
    title: workload.label,
    primary: `${workload.quantity} × ${workload.compute.sizeLabel}`,
    detail: `${serviceDisplay(workload.compute.service)} · ${vcpu} vCPU · ${memoryGb} GB memory`,
    lifecycle: null,
  };
}

function resourceRow(resource: FootprintResource): FootprintRow {
  const engine = engineDisplay(resource.configuration);
  const instanceType =
    typeof resource.configuration['instanceType'] === 'string' ? resource.configuration['instanceType'] : null;
  const nodeType = typeof resource.configuration['nodeType'] === 'string' ? resource.configuration['nodeType'] : null;
  const storageGb =
    typeof resource.configuration['storageGb'] === 'number' ? resource.configuration['storageGb'] : null;

  const parts = [serviceDisplay(resource.service)];
  if (instanceType !== null) parts.push(String(instanceType));
  if (nodeType !== null) parts.push(String(nodeType));
  if (storageGb !== null) parts.push(`${storageGb} GB`);

  const primary = engine ?? resource.label;
  const detail = parts.join(' · ');
  // Every managed resource states its removal outcome; retained rows add the
  // persistence callout the retention disclosures also use.
  return {
    id: resource.id,
    title: resource.label,
    primary,
    detail: detail.length > 0 ? detail : null,
    lifecycle: footprintLifecycleLabel(resource),
  };
}

/** Workload rows first, then managed resources, in footprint order. */
export function footprintRows(footprint: DeploymentFootprint): FootprintRow[] {
  return [...footprint.workloads.map(workloadRow), ...footprint.resources.map(resourceRow)];
}

/** One row of the simplified "Planned infrastructure" table (vendor Configuration tab). */
export interface FootprintComponentRow {
  id: string;
  /** The item's label, prefixed with "N × " only when more than one is provisioned. */
  component: string;
  /** What it runs as — the resolved engine (with version) or the AWS service name. */
  provisionedAs: string;
  /** Exact meaningful sizing, joined with " · "; null when nothing meaningful exists. */
  configuration: string | null;
  retention: 'Removed' | 'Retained';
}

function componentLabel(label: string, quantity: number): string {
  return quantity > 1 ? `${quantity} × ${label}` : label;
}

/** "PostgreSQL 16", "Redis (Valkey)" — null when the configuration has no known engine. */
function engineProvisionedAs(configuration: Record<string, unknown>): string | null {
  const engine = configuration['engine'];
  if (typeof engine !== 'string') return null;
  const display = FOOTPRINT_ENGINE_DISPLAY[engine];
  if (display === undefined) return null;
  const version = configuration['engineVersion'];
  return typeof version === 'string' || typeof version === 'number' ? `${display} ${version}` : display;
}

// Friendly formatting for the known sizing keys a resource configuration may
// carry. `engine`/`engineVersion` are handled by `engineProvisionedAs` above,
// so they are intentionally absent here; any other key (known scalar or not)
// has no formatter and is silently skipped — configuration never dumps raw
// keys for a resource type this table doesn't know about.
const CONFIGURATION_KEY_FORMATTERS: Readonly<Record<string, (value: unknown) => string | null>> = {
  instanceType: (value) => (typeof value === 'string' ? value : null),
  nodeType: (value) => (typeof value === 'string' ? value : null),
  storageGb: (value) => (typeof value === 'number' ? `${value} GB storage` : null),
  nodes: (value) => (typeof value === 'number' ? `${value} node${value === 1 ? '' : 's'}` : null),
};

function resourceConfigurationParts(configuration: Record<string, unknown>): string[] {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(configuration)) {
    const formatted = CONFIGURATION_KEY_FORMATTERS[key]?.(value) ?? null;
    if (formatted !== null) parts.push(formatted);
  }
  return parts;
}

function workloadComponentRow(workload: FootprintWorkload): FootprintComponentRow {
  const vcpu = workload.compute.cpuUnits / 1024;
  const memoryGb = workload.compute.memoryMiB / 1024;
  return {
    id: workload.id,
    component: componentLabel(workload.label, workload.quantity),
    provisionedAs: serviceDisplay(workload.compute.service),
    configuration: `${vcpu} vCPU · ${memoryGb} GB memory`,
    retention: 'Removed',
  };
}

function resourceComponentRow(resource: FootprintResource): FootprintComponentRow {
  const parts = resourceConfigurationParts(resource.configuration);
  return {
    id: resource.id,
    component: componentLabel(resource.label, resource.quantity),
    provisionedAs: engineProvisionedAs(resource.configuration) ?? serviceDisplay(resource.service),
    configuration: parts.length > 0 ? parts.join(' · ') : null,
    retention: resource.lifecycle.retainOnDelete ? 'Retained' : 'Removed',
  };
}

/**
 * Simplified component rows for the vendor "Planned infrastructure" section —
 * one row per workload, then one per resource, in footprint order. Generic
 * over `service`/`category`: a future resource type renders through this same
 * path with no code change here.
 */
export function footprintComponentRows(footprint: DeploymentFootprint): FootprintComponentRow[] {
  return [...footprint.workloads.map(workloadComponentRow), ...footprint.resources.map(resourceComponentRow)];
}

/** "~$65–95/month"; null parts degrade gracefully to one-sided ranges. */
export function formatMonthlyRange(monthlyMin: number | null, monthlyMax: number | null): string | null {
  const format = (value: number): string => `${Math.round(value)}`;
  if (monthlyMin !== null && monthlyMax !== null) return `~$${format(monthlyMin)}–${format(monthlyMax)}/month`;
  if (monthlyMin !== null) return `~$${format(monthlyMin)}/month`;
  if (monthlyMax !== null) return `~$${format(monthlyMax)}/month`;
  return null;
}

/** One row of the expanded cost breakdown. */
export interface FootprintCostLine {
  id: string;
  label: string;
  range: string | null;
  status: 'estimated' | 'usage_based' | 'unavailable';
}

export function footprintCostLines(estimate: FootprintCostEstimate): FootprintCostLine[] {
  return estimate.items.map((item) => ({
    id: item.resourceId,
    label: item.label,
    range:
      item.monthlyMin !== undefined && item.monthlyMax !== undefined
        ? `~$${Math.round(item.monthlyMin)}–${Math.round(item.monthlyMax)}`
        : null,
    status: item.pricingStatus,
  }));
}
