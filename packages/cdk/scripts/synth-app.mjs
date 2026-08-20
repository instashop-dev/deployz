/**
 * Synthesizes the application stack and writes the versioned CloudFormation
 * artifact to packages/cdk/artifacts/application-template-v1.json.
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
import { App } from 'aws-cdk-lib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ApplicationStack } from '../dist/application/application-stack.js';

const here = dirname(fileURLToPath(import.meta.url));

const app = new App();
const stack = new ApplicationStack(app, 'DeployzApplication', {
  // Plain Fargate is the default (safe everywhere-available fallback, C3/U3).
  expressMode: false,
});

const assembly = app.synth();
const artifact = assembly.getStackArtifact(stack.artifactId);
const template = artifact.template;

const outDir = join(here, '..', 'artifacts');
mkdirSync(outDir, { recursive: true });
const outPath = join(outDir, 'application-template-v1.json');
writeFileSync(outPath, `${JSON.stringify(template, null, 2)}\n`);

console.log(
  `Wrote ${outPath} — ${Object.keys(template.Resources).length} resources, ` +
    `${Buffer.byteLength(JSON.stringify(template))} bytes (uncompressed)`,
);
