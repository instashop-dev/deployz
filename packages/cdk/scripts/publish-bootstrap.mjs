/**
 * Publishes the customer bootstrap template.
 *
 * Synthesizes the bootstrap stack, repacks the template so it is
 * self-contained (no CDK asset bucket, no bootstrap-version rule), ZIPs and
 * uploads the Lambda assets plus the template to the PUBLIC template bucket,
 * and prints the resulting template URL and Quick Create link.
 *
 * Until this has run, no install link can be handed to a customer: the
 * control plane returns `quickCreateUrl: null` and the install page says the
 * publisher has not published a template yet. That is deliberate — a link to
 * a template CloudFormation cannot fetch fails inside the customer's own
 * console with nothing they can act on.
 *
 * Requires `pnpm build` first (imports the compiled @deployz/cdk dist).
 * Usage:
 *   pnpm --filter @deployz/cdk run publish:bootstrap
 *
 * Environment:
 *   TEMPLATE_BUCKET  public bucket to publish into. Defaults to the
 *                    `<stack>-TemplateBucket` output of the deployed control
 *                    plane stack (read via CloudFormation).
 *   API_URL          control-plane URL baked into the link.
 *   AWS_REGION       region of the bucket and the console deep-link.
 */
import { CloudFormationClient, ListExportsCommand } from '@aws-sdk/client-cloudformation';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  BootstrapPublisher,
  createRealS3Client,
  synthesizeBootstrapStack,
} from '../dist/quick-create/publish.js';

const region = process.env.AWS_REGION ?? 'us-east-1';
const controlPlaneUrl = process.env.API_URL ?? 'https://api.deployz.dev';
const stackName = process.env.CONTROL_PLANE_STACK ?? 'Deployz';
const keyPrefix = process.env.TEMPLATE_KEY_PREFIX ?? 'bootstrap/v1';

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
const outdir = mkdtempSync(join(tmpdir(), 'deployz-bootstrap-'));

const synth = await synthesizeBootstrapStack({ outdir, controlPlaneUrl });
const publisher = new BootstrapPublisher(createRealS3Client(), {
  region,
  bucket,
  keyPrefix,
  controlPlaneUrl,
});
const result = await publisher.publish(synth);

console.log(`Published ${synth.assets.length} Lambda asset(s) + the template to ${bucket}`);
console.log(`  template   ${result.templateUrl}`);
console.log(`  size       ${result.templateBytes} bytes, ${result.parameterCount} parameter(s)`);
console.log(`  quickCreate ${result.quickCreateUrl}`);
console.log();
console.log('Set this on the control plane so install links are handed out:');
console.log(`  BOOTSTRAP_TEMPLATE_URL=${result.templateUrl}`);
