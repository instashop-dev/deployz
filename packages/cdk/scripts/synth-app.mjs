/**
 * Synthesizes the application stack and writes the versioned CloudFormation
 * artifacts to packages/cdk/artifacts/application-template-v1.json and
 * application-template-redis-v1.json.
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

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '..', 'artifacts');
mkdirSync(outDir, { recursive: true });

// Same synth the publisher runs, so the committed artifact and the template
// customers actually install cannot drift. `synthesizeApplicationStack` is
// what fixes the two choices that matter — plain Fargate (the verifier
// requires an ECS service and an ALB) and no certificate at synth time.
const { template } = await synthesizeApplicationStack({
  outdir: mkdtempSync(join(tmpdir(), 'deployz-synth-app-')),
});

const outPath = join(outDir, 'application-template-v1.json');
writeFileSync(outPath, `${JSON.stringify(template, null, 2)}\n`);

console.log(
  `Wrote ${outPath} — ${Object.keys(template.Resources).length} resources, ` +
    `${Buffer.byteLength(JSON.stringify(template))} bytes (uncompressed)`,
);

const { template: redisTemplate } = await synthesizeApplicationStack({
  outdir: mkdtempSync(join(tmpdir(), 'deployz-synth-app-redis-')),
  stackId: 'DeployzApplicationRedis',
  redisRequired: true,
});

const redisOutPath = join(outDir, 'application-template-redis-v1.json');
writeFileSync(redisOutPath, `${JSON.stringify(redisTemplate, null, 2)}\n`);

console.log(
  `Wrote ${redisOutPath} — ${Object.keys(redisTemplate.Resources).length} resources, ` +
    `${Buffer.byteLength(JSON.stringify(redisTemplate))} bytes (uncompressed)`,
);
