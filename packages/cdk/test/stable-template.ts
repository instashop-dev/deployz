/**
 * Strip the one thing in a synthesized template that is not a property of the
 * template: the asset hash.
 *
 * `S3Key` carries the content hash of a bundled Lambda asset, and esbuild does
 * not produce byte-identical output across platforms — so the same source
 * synthesizes a different hash on Windows than on the Linux CI runner. Left in
 * the snapshot, the assertion fails for everyone whose machine is not the one
 * the snapshot was written on, and the workaround (regenerating snapshots
 * before the test run) silently accepted every other change to the template
 * too, which is the whole thing the snapshot exists to catch.
 *
 * Replacing just the hash keeps the guard: a resource gaining or losing an
 * asset still shows up, and every other line is compared exactly.
 */
export function withStableAssetHashes(template: unknown): unknown {
  if (Array.isArray(template)) {
    return template.map(withStableAssetHashes);
  }
  if (template !== null && typeof template === 'object') {
    return Object.fromEntries(
      Object.entries(template as Record<string, unknown>).map(([key, value]) => [
        key,
        key === 'S3Key' && typeof value === 'string'
          ? value.replace(/^[0-9a-f]{60,64}\.zip$/, '<asset-hash>.zip')
          : withStableAssetHashes(value),
      ]),
    );
  }
  return template;
}
