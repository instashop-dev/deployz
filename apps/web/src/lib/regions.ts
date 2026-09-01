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
