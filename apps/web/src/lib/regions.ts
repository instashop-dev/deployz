// §12/§41 region options for the "Create customer deployment" screen.
//
// Fetched from the control plane (`GET /api/regions`), never hardcoded: the
// API serves only regions whose regional bootstrap artifacts are confirmed
// published, so the UI cannot offer a region that would fail to install (an
// S3 PermanentRedirect on stack creation — a Lambda must read its code from a
// bucket in its own region). Mirrors the fetch pattern of lib/applications.ts.

import { apiUrl } from '@/lib/api-url';

export interface RegionOption {
  value: string;
  label: string;
}

/** List the deployable regions for the deployment form. */
export async function fetchRegions(): Promise<RegionOption[]> {
  const response = await fetch(`${apiUrl}/api/regions`, {
    credentials: 'include',
    cache: 'no-store',
  });
  if (!response.ok) {
    throw new Error(`Regions request failed (${response.status})`);
  }
  const body = (await response.json()) as { regions?: RegionOption[] };
  return body.regions ?? [];
}

// Display names for the regions a deployment can live in. The AWS code stays
// visible next to the name; this map only makes a list scannable, so an
// unknown code (a region added later) simply shows as the code itself.
const REGION_NAMES: ReadonlyMap<string, string> = new Map([
  ['us-east-1', 'N. Virginia'],
  ['us-east-2', 'Ohio'],
  ['us-west-1', 'N. California'],
  ['us-west-2', 'Oregon'],
  ['ca-central-1', 'Canada'],
  ['sa-east-1', 'São Paulo'],
  ['eu-west-1', 'Ireland'],
  ['eu-west-2', 'London'],
  ['eu-west-3', 'Paris'],
  ['eu-central-1', 'Frankfurt'],
  ['eu-north-1', 'Stockholm'],
  ['ap-northeast-1', 'Tokyo'],
  ['ap-northeast-2', 'Seoul'],
  ['ap-northeast-3', 'Osaka'],
  ['ap-south-1', 'Mumbai'],
  ['ap-southeast-1', 'Singapore'],
  ['ap-southeast-2', 'Sydney'],
]);

/** The friendly name for an AWS region code, or null when it is not a known one. */
export function regionName(code: string): string | null {
  return REGION_NAMES.get(code) ?? null;
}

/** "Mumbai (ap-south-1)" for a known region, the bare code otherwise. */
export function regionOptionLabel(code: string): string {
  const name = regionName(code);
  return name === null ? code : `${name} (${code})`;
}
