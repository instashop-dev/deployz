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
