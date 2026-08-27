/**
 * Publishes the application template — the infrastructure a customer
 * deployment actually runs on.
 *
 * The relay's INSTALL executor calls `CreateStack` with this template's
 * public URL as `TemplateURL`. Until it has run there is nothing to
 * install: the bootstrap template ships with an empty
 * `ApplicationTemplateUrl`, and the executor refuses to guess one rather
 * than hand CloudFormation a URL it cannot fetch.
 *
 * Order matters. Publish the application template FIRST, then republish the
 * bootstrap template with the URL this prints — the bootstrap template
 * carries it as a parameter default, so a bootstrap published before this
 * one points at nothing.
 *
 * The container image is pinned at publish time, not at install time. The
 * stack's own default (`public.ecr.aws/deployz/fixture@sha256:000...000`) is
 * a placeholder ECS cannot pull: the task never starts, the deployment
 * circuit breaker fires, and CloudFormation rolls the whole stack back
 * around 20 minutes in. Pass a real, already-published image.
 *
 * Requires `pnpm build` first (imports the compiled @deployz/cdk dist).
 * Usage:
 *   pnpm --filter @deployz/cdk run publish:application
 *
 * Environment:
 *   APP_IMAGE_REPOSITORY  container repository (no tag) the template runs.
 *   APP_IMAGE_DIGEST      immutable `sha256:...` digest of that image.
 *   APP_PRESET            optional vendor application preset. Only
 *                         `documenso` is recognized; any other value refuses
 *                         to publish rather than silently ignoring it.
 *   TEMPLATE_BUCKET       public bucket to publish into. Defaults to the
 *                         `<stack>-TemplateBucket` output of the deployed
 *                         control plane stack (read via CloudFormation).
 *   AWS_REGION            region of the bucket.
 */
import { CloudFormationClient, ListExportsCommand } from '@aws-sdk/client-cloudformation';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ApplicationPublisher,
  createRealS3Client,
  synthesizeApplicationStack,
} from '../dist/quick-create/publish.js';

const region = process.env.AWS_REGION ?? 'us-east-1';
const stackName = process.env.CONTROL_PLANE_STACK ?? 'Deployz';
const keyPrefix = process.env.APPLICATION_KEY_PREFIX ?? 'application/v1';
const imageRepository = process.env.APP_IMAGE_REPOSITORY;
const imageDigest = process.env.APP_IMAGE_DIGEST;
const preset = process.env.APP_PRESET;

if (!imageRepository || !imageDigest) {
  console.error(
    'APP_IMAGE_REPOSITORY and APP_IMAGE_DIGEST are required.\n' +
      'The application stack falls back to a placeholder digest ECS cannot pull, which fails ' +
      'the install with a CloudFormation rollback ~20 minutes in — a failure that looks ' +
      'nothing like a missing image reference.',
  );
  process.exit(1);
}

const VALID_PRESETS = ['documenso'];
if (preset !== undefined && !VALID_PRESETS.includes(preset)) {
  console.error(
    `APP_PRESET '${preset}' is not recognized. Valid presets: ${VALID_PRESETS.join(', ')}.`,
  );
  process.exit(1);
}

/** Reads the template bucket name from the control plane stack's exports. */
async function resolveBucket() {
  if (process.env.TEMPLATE_BUCKET) return process.env.TEMPLATE_BUCKET;

  const client = new CloudFormationClient({ region });
  const exportName = `${stackName}-TemplateBucket`;
  let nextToken;
  do {
    const page = await client.send(new ListExportsCommand({ NextToken: nextToken }));
    const match = page.Exports?.find((entry) => entry.Name === exportName);
    if (match?.Value) return match.Value;
    nextToken = page.NextToken;
  } while (nextToken);

  throw new Error(
    `Could not find the ${exportName} stack export. Deploy the control plane first, ` +
      'or set TEMPLATE_BUCKET explicitly.',
  );
}

const bucket = await resolveBucket();
const outdir = mkdtempSync(join(tmpdir(), 'deployz-application-'));

const synth = await synthesizeApplicationStack({
  outdir,
  imageRepository,
  imageDigest,
  ...(preset !== undefined ? { preset } : {}),
});
const publisher = new ApplicationPublisher(createRealS3Client(), { region, bucket, keyPrefix });
const result = await publisher.publish(synth);

const resourceCount = Object.keys(synth.template.Resources ?? {}).length;
console.log(`Published the application template to ${bucket}`);
console.log(`  template  ${result.templateUrl}`);
console.log(`  image     ${imageRepository}@${imageDigest}`);
console.log(`  preset    ${preset ?? '(none)'}`);
console.log(
  `  size      ${result.templateBytes} bytes, ${result.parameterCount} parameter(s), ${resourceCount} resource(s)`,
);
console.log();
console.log('Now republish the bootstrap template so new installs point at it:');
console.log(`  APPLICATION_TEMPLATE_URL=${result.templateUrl} pnpm --filter @deployz/cdk run publish:bootstrap`);
