import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { synthesizeApplicationStack, synthesizeBootstrapStack } from '../src/quick-create/publish.js';
import { withStableAssetHashes } from './stable-template.js';

/**
 * Guards against the committed `artifacts/*-template-v1.json` drifting from
 * what a fresh synth actually produces — the exact drift that let bootstrap
 * blocker N1 (missing `cloudwatch:PutMetricAlarm` on the CFN execution role)
 * ship: the role's IAM changed in source without the published template
 * being regenerated to match.
 *
 * Whenever a change here fails this test, the fix is to regenerate the
 * artifacts (`pnpm --filter @deployz/cdk run synth:bootstrap` /
 * `synth:app`), not to edit the committed JSON or this test by hand.
 */
describe('committed CFN artifacts match a fresh synth', () => {
  const here = dirname(fileURLToPath(import.meta.url));

  function readArtifact(name: string): unknown {
    return JSON.parse(readFileSync(join(here, '..', 'artifacts', name), 'utf8'));
  }

  it('bootstrap-template-v1.json matches synthesizeBootstrapStack', async () => {
    // scripts/synth-bootstrap.mjs synths with no applicationTemplateUrl, so
    // the committed artifact's ApplicationTemplateUrl default is empty.
    // Matching that here — rather than passing one — is what keeps this
    // test stable instead of failing on a "drift" that isn't one.
    const { template } = await synthesizeBootstrapStack({
      outdir: mkdtempSync(join(tmpdir(), 'deployz-artifact-check-')),
      controlPlaneUrl: 'https://api.deployz.dev',
      stackId: 'DeployzBootstrap',
    });

    expect(withStableAssetHashes(template)).toEqual(
      withStableAssetHashes(readArtifact('bootstrap-template-v1.json')),
    );
  });

  it('application-template-v1.json matches synthesizeApplicationStack', async () => {
    const { template } = await synthesizeApplicationStack({
      outdir: mkdtempSync(join(tmpdir(), 'deployz-artifact-check-')),
    });

    expect(withStableAssetHashes(template)).toEqual(
      withStableAssetHashes(readArtifact('application-template-v1.json')),
    );
  });

  it('application-template-redis-v1.json matches synthesizeApplicationStack with redisRequired', async () => {
    const { template } = await synthesizeApplicationStack({
      outdir: mkdtempSync(join(tmpdir(), 'deployz-artifact-check-')),
      redisRequired: true,
    });

    expect(withStableAssetHashes(template)).toEqual(
      withStableAssetHashes(readArtifact('application-template-redis-v1.json')),
    );
  });
});
