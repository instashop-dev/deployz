/**
 * Synthesizes the application stack and writes the versioned CloudFormation
 * artifacts to packages/cdk/artifacts/ for all four infrastructure variants:
 *
 *   - application-template-v1.json               (postgres, no redis)
 *   - application-template-redis-v1.json          (postgres, redis)
 *   - application-template-stateless-v1.json      (no postgres, no redis)
 *   - application-template-stateless-redis-v1.json (no postgres, redis)
 *
 * This is the programmatic equivalent of `cdk synth` — it runs the same
 * App.synth() assembly the CDK CLI drives and emits the identical
 * `<stack>.template.json` payload that `cdk synth` writes to `cdk.out/`.
 *
 * The artifact is committed (versioned) so the INSTALL Durable Function
 * (todo 13) and the §59/§60 desired-vs-observed infrastructure versioning can
 * reference a pinned template (runtime-v1) instead of re-synthesizing at
 * runtime. A release with a new image digest produces a runtime-v2 artifact.
 *
 * Requires `pnpm build` first (imports the compiled @deployz/cdk dist).
 * Usage: pnpm --filter @deployz/cdk run synth:app
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { synthesizeApplicationStack } from '../dist/quick-create/publish.js';
import { applicationTemplateKeyForProfile } from '@deployz/contracts';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '..', 'artifacts');
mkdirSync(outDir, { recursive: true });

/** Synthesize one variant and write its artifact. */
async function synthOne(profile, outdirLabel) {
  const { template } = await synthesizeApplicationStack({
    outdir: mkdtempSync(join(tmpdir(), `deployz-synth-${outdirLabel}-`)),
    ...(profile.postgres === false ? { databaseRequired: false } : {}),
    ...(profile.redis ? { redisRequired: true } : {}),
  });

  const key = applicationTemplateKeyForProfile(profile);
  const outPath = join(outDir, key);
  writeFileSync(outPath, `${JSON.stringify(template, null, 2)}\n`);

  console.log(
    `Wrote ${outPath} — ${Object.keys(template.Resources).length} resources, ` +
      `${Buffer.byteLength(JSON.stringify(template))} bytes (uncompressed)`,
  );
}

const PROFILES = [
  { postgres: true,  redis: false },
  { postgres: true,  redis: true  },
  { postgres: false, redis: false },
  { postgres: false, redis: true  },
];

for (const profile of PROFILES) {
  await synthOne(profile, `${profile.postgres ? 'pg' : 'sl'}-${profile.redis ? 'redis' : 'base'}`);
}