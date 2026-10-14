/**
 * Prints the connector build id: the first 12 hex characters of the SHA-256
 * of the bootstrap template. CI runs it before the API deploy so the API and
 * the published template carry the same id.
 *
 * Requires `pnpm build` first (imports the compiled @deployz/cdk dist).
 * Usage: pnpm --filter @deployz/cdk run --silent bootstrap:build-id
 *
 * Environment:
 *   API_URL               control-plane URL baked into the template; use the
 *                         same value as the publisher.
 *   BOOTSTRAP_BUILD_ID    printed as given when set.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveBootstrapBuildId } from '../dist/quick-create/publish.js';

const controlPlaneUrl = process.env.API_URL ?? 'https://api.deployz.dev';
const outdir = mkdtempSync(join(tmpdir(), 'deployz-build-id-'));
try {
  console.log(await resolveBootstrapBuildId({ outdir, controlPlaneUrl }));
} finally {
  rmSync(outdir, { recursive: true, force: true });
}
