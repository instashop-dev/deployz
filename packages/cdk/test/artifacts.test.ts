import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { synthesizeBootstrapStack } from '../src/quick-create/publish.js';
import { withStableAssetHashes } from './stable-template.js';

/**
 * Guards against the committed `artifacts/bootstrap-template-v1.json`
 * drifting from what a fresh synth actually produces — the exact drift that
 * let bootstrap blocker N1 (missing `cloudwatch:PutMetricAlarm` on the CFN
 * execution role) ship: the role's IAM changed in source without the
 * published template being regenerated to match.
 *
 * Whenever a change here fails this test, the fix is to regenerate the
 * artifact (`pnpm --filter @deployz/cdk run synth:bootstrap`), not to edit
 * the committed JSON or this test by hand.
 */
describe('committed CFN artifacts match a fresh synth', () => {
  const here = dirname(fileURLToPath(import.meta.url));

  function readArtifact(name: string): unknown {
    return JSON.parse(readFileSync(join(here, '..', 'artifacts', name), 'utf8'));
  }

  it('bootstrap-template-v1.json matches synthesizeBootstrapStack', async () => {
    const { template } = await synthesizeBootstrapStack({
      outdir: mkdtempSync(join(tmpdir(), 'deployz-artifact-check-')),
      controlPlaneUrl: 'https://api.deployz.dev',
      stackId: 'DeployzBootstrap',
    });

    expect(withStableAssetHashes(template)).toEqual(
      withStableAssetHashes(readArtifact('bootstrap-template-v1.json')),
    );
  });
});
