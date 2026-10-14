// Release versions are vendor-chosen strings. The UI shows them with a "v"
// prefix, but a vendor who already names a release "v1.3.0" must not see
// "vv1.3.0".
export function formatReleaseVersion(version: string): string {
  return /^v/i.test(version) ? version : `v${version}`;
}

/**
 * The "Running release" value. A release is shown as running only once relay
 * evidence confirms it; until then it is the last confirmed one, still being
 * verified.
 */
export function runningReleaseDisplay(
  version: string | null,
  confirmed: boolean,
): { text: string; note: string | null } {
  if (version === null) return { text: 'Not deployed yet', note: null };
  if (confirmed) return { text: formatReleaseVersion(version), note: null };
  return { text: `Last confirmed ${formatReleaseVersion(version)}`, note: 'Verifying…' };
}
