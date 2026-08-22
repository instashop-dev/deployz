// §12/§44 public customer installation data — server-side fetch for the
// unauthenticated /install/:installationId page. Wired to the real
// (public, no-auth) `GET /api/install/:installationId` endpoint.

const apiUrl = process.env.API_URL ?? process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

export interface InstallData {
  applicationName: string;
  publisherName: string;
  customerName: string;
  region: string;
  /** §44 "Deployz will create" list, e.g. ["Application runtime", "PostgreSQL database", ...]. */
  resourcesCreated: string[];
}

/** Fetch the public install page data. Returns null on a 404 (unknown/invalid link). */
export async function fetchInstallData(installationId: string): Promise<InstallData | null> {
  const response = await fetch(`${apiUrl}/api/install/${encodeURIComponent(installationId)}`, {
    cache: 'no-store',
  });
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`Install request failed (${response.status})`);
  }
  return (await response.json()) as InstallData;
}
