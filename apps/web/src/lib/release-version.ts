// Release versions are vendor-chosen strings. The UI shows them with a "v"
// prefix, but a vendor who already names a release "v1.3.0" must not see
// "vv1.3.0".
export function formatReleaseVersion(version: string): string {
  return /^v/i.test(version) ? version : `v${version}`;
}
