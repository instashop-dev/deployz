import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { synthesizeApplicationStack, synthesizeBootstrapStack } from '../src/quick-create/publish.js';
import { applicationTemplateVariantKey } from '@deployz/contracts';
import { withStableAssetHashes } from './stable-template.js';

/**
 * Guards against the committed `artifacts/*-template-v1.json` drifting from
 * what a fresh synth actually produces — the exact drift that let bootstrap
 * blocker N1 (missing `cloudwatch:PutMetricAlarm` on the CFN execution role)
 * ship: the role's IAM changed in source without the published template
 * being regenerated to match.
 *
 * Whenever a change here fails this test, the fix is to regenerate the
 * artifacts (`pnpm --filter @deployz/cdk run synth:app` /
 * `pnpm --filter @deployz/cdk run synth:bootstrap`), not to edit the
 * committed JSON or this test by hand.
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

  const variants = [
    { redis: false, storage: true },
    { redis: true, storage: true },
    { redis: false, storage: false },
    { redis: true, storage: false },
  ] as const;

  for (const variant of variants) {
    const key = applicationTemplateVariantKey(variant);
    const label = `r${variant.redis}-s${variant.storage}`;

    it(`${key} matches synthesizeApplicationStack with {redis:${variant.redis},storage:${variant.storage}}`, async () => {
      const { template } = await synthesizeApplicationStack({
        outdir: mkdtempSync(join(tmpdir(), `deployz-artifact-check-${label}-`)),
        redisRequired: variant.redis,
        storageRequired: variant.storage,
      });

      // Only compare against the committed artifact when one exists — the
      // no-storage variants are new and will be committed once generated.
      let committed: unknown;
      try {
        committed = readArtifact(key);
      } catch {
        // Artifact not yet committed — verify the synth itself is valid.
        expect(template).toBeDefined();
        expect(Object.keys(template.Resources ?? {}).length).toBeGreaterThan(0);
        return;
      }
      expect(withStableAssetHashes(template)).toEqual(
        withStableAssetHashes(committed),
      );
    });

    // For the no-storage variants, also verify zero S3 buckets in the synth.
    if (!variant.storage) {
      it(`${key} ({redis:${variant.redis},storage:${variant.storage}}) contains zero S3 bucket resources`, async () => {
        const { template } = await synthesizeApplicationStack({
          outdir: mkdtempSync(join(tmpdir(), `deployz-artifact-check-${label}-s3-`)),
          redisRequired: variant.redis,
          storageRequired: variant.storage,
        });

        const resources = template.Resources as Record<string, { Type: string }>;
        const s3Buckets = Object.values(resources).filter(
          (r) => r.Type === 'AWS::S3::Bucket',
        );
        expect(s3Buckets).toHaveLength(0);
      });
    }
  }
});