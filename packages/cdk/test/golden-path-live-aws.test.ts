/**
 * §67 Golden Path E2E — LIVE AWS proof (Phase 4: steps 11-13, 16, 18).
 *
 * Runs the REAL customer-side bootstrap deployment against the configured
 * AWS account:
 *
 *   synth (cdk synth) → deploy (cdk deploy) → verify CREATE_COMPLETE →
 *   verify relay Lambda Active → verify deployz:installation tags →
 *   destroy (cdk destroy)
 *
 * Gated behind DEPLOYZ_LIVE_AWS=1 so default `pnpm vitest run` skips it
 * (no AWS, no cost). When the flag is set, the configured account is used.
 *
 * Why cdk deploy/destroy (not createAwsClients.createStack directly): the
 * synthesized template references CDK staging-bucket Lambda assets. `cdk
 * deploy` bundles the asset directories into real ZIPs and uploads them to
 * the bootstrapped staging bucket — the production asset-packaging path. A
 * direct createStack from the raw synthesized template would ship bare
 * index.mjs as application/zip (the publisher ZIP-gap, documented in
 * packages/cdk/src/quick-create/publish.ts).
 *
 * `shell: true` is required on Windows so spawnSync resolves the pnpm.cmd
 * shim. Lambda + tag verification use the aws CLI (already on PATH) to
 * avoid pulling in extra SDK client packages; stack state uses the real
 * createAwsClients() seam.
 */
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

import { createAwsClients } from '../src/integration/aws-clients.js';

const STACK_NAME = 'DeployzBootstrap';
const REGION = process.env.AWS_REGION ?? 'us-east-1';
const APP_CMD = 'tsx bin/bootstrap.ts';

function run(cmd: string): string {
  const result = spawnSync(cmd, { cwd: process.cwd(), encoding: 'utf8', timeout: 600_000, shell: true, env: process.env });
  if (result.status !== 0) throw new Error(`${cmd} exited ${result.status}\n${result.stderr}`);
  return result.stdout;
}

function cdk(args: string[]): string {
  // The --app value "tsx bin/bootstrap.ts" contains a space; under
  // shell:true it would split into two tokens. Quote it so CDK receives the
  // full string as one argument.
  const quoted = args.map((a) => (a.includes(' ') ? `"${a}"` : a)).join(' ');
  return run(`pnpm --filter @deployz/cdk exec cdk ${quoted}`);
}

function awsCli(args: string): string {
  return run(`aws ${args} --region ${REGION} --output json`);
}

const liveAws = process.env.DEPLOYZ_LIVE_AWS === '1' ? describe : describe.skip;

liveAws('§67 Phase 4 — live AWS bootstrap golden path', () => {
  const aws = createAwsClients();

  it('step 13: cdk deploy reaches CREATE_COMPLETE', async () => {
    cdk(['deploy', '--app', APP_CMD, '--require-approval', 'never']);
    const stack = await aws.cloudFormation.describeStacks({ stackName: STACK_NAME, region: REGION });
    expect(stack.status).toBe('CREATE_COMPLETE');
    expect(stack.stackName).toBe(STACK_NAME);
  });

  it('step 16: relay Lambda is Active with the installation env wired', async () => {
    const stack = await aws.cloudFormation.describeStacks({ stackName: STACK_NAME, region: REGION });
    const fnArn = stack.outputs.find((o) => o.outputKey.endsWith('RelayFunctionArn'))?.outputValue;
    expect(fnArn).toBeTruthy();

    const cfg = JSON.parse(awsCli(`lambda get-function-configuration --function-name ${fnArn}`));
    expect(cfg.State).toBe('Active');
    expect(cfg.LastUpdateStatus).toBe('Successful');
    expect(cfg.Environment.Variables.DEPLOYZ_INSTALLATION_ID).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it('step 18: deployz:installation tags on every created resource', async () => {
    const stack = await aws.cloudFormation.describeStacks({ stackName: STACK_NAME, region: REGION });
    const installId = stack.outputs.find((o) => o.outputKey.endsWith('InstallationId'))?.outputValue;
    expect(installId).toBeTruthy();

    const res = JSON.parse(
      awsCli(`resourcegroupstaggingapi get-resources --tag-filters Key=deployz:installation,Values=${installId}`),
    );
    const arns = (res.ResourceTagMappingList ?? []).map((m: { ResourceARN: string }) => m.ResourceARN);
    expect(arns.length).toBeGreaterThanOrEqual(3);
    expect(arns.some((a: string) => a.includes('lambda'))).toBe(true);
    expect(arns.some((a: string) => a.includes('secretsmanager'))).toBe(true);
    expect(arns.some((a: string) => a.includes('events'))).toBe(true);
  });

  it('teardown: cdk destroy removes the stack', async () => {
    cdk(['destroy', '--app', APP_CMD, '--force']);
    // describeStacks still resolves during DELETE_IN_PROGRESS; poll until
    // the stack is gone (CloudFormation returns ValidationError once
    // DELETE_COMPLETE resources are fully purged).
    let gone = false;
    for (let i = 0; i < 30; i++) {
      try {
        const s = await aws.cloudFormation.describeStacks({ stackName: STACK_NAME, region: REGION });
        if (s.status === 'DELETE_COMPLETE') { gone = true; break; }
      } catch { gone = true; break; }
      await new Promise((r) => setTimeout(r, 5_000));
    }
    expect(gone).toBe(true);
  });
});
