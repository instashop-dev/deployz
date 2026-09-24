/**
 * Bundling smoke: synthesizes every stack that carries a NodejsFunction with
 * real esbuild bundling, into a temporary directory that is thrown away.
 *
 * The Vitest project skips bundling (packages/cdk/vitest.config.ts), so an
 * unresolved import, a missing `.sql` text asset or an ESM/CJS mismatch in
 * a Lambda entry point would otherwise surface only in `cdk deploy` or
 * `publish:bootstrap`, after the merge. CI runs this for the full regression.
 *
 * Requires `pnpm build` first (imports the compiled @deployz/cdk dist).
 * Usage: pnpm synth:smoke
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { App } from 'aws-cdk-lib';

import { DeployzStack } from '../dist/deployz-stack.js';
import { synthesizeBootstrapStack } from '../dist/quick-create/publish.js';

const outdir = mkdtempSync(join(tmpdir(), 'deployz-bundle-smoke-'));
const started = Date.now();
try {
  // Relay Lambda + InstallId function (the customer-side bootstrap template).
  await synthesizeBootstrapStack({ outdir: join(outdir, 'bootstrap') });
  // API + worker Lambdas (the control plane); no environment is needed to synth.
  const app = new App({ outdir: join(outdir, 'control-plane') });
  new DeployzStack(app, 'DeployzBundleSmoke');
  app.synth();
  console.log(`bundle smoke passed in ${Math.round((Date.now() - started) / 1000)}s`);
} finally {
  rmSync(outdir, { recursive: true, force: true });
}
