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
 *
 * Also contains a second, independent gated suite (Redis MVP) proving the
 * ElastiCache cache lifecycle for a `redisRequired: true` ApplicationStack —
 * see that describe block's doc comment for scope and cost/time notes.
 */
import { spawnSync } from 'node:child_process';
import { App } from 'aws-cdk-lib';
import { describe, expect, it, vi } from 'vitest';

import { createAwsClients, type CacheClusterInfo, type ElastiCacheClient } from '../src/integration/aws-clients.js';
import { ApplicationStack } from '../src/application/application-stack.js';

const STACK_NAME = 'DeployzBootstrap';
const REGION = process.env.AWS_REGION ?? 'us-east-1';
const APP_CMD = 'tsx bin/bootstrap.ts';

/**
 * Redis MVP — standalone application-stack name for the cache-lifecycle
 * proof below. Distinct from the bootstrap stack (STACK_NAME) deployed
 * above: that stack has no cache at all (it only creates the relay Lambda +
 * IAM + SecretsManager + EventBridge). Proving the cache lifecycle requires
 * a real `redisRequired: true` ApplicationStack, which today is reachable
 * ONLY via this direct test path — the relay's INSTALL/DEPLOY_RELEASE
 * executors that would provision one in a real customer account are
 * pre-existing no-op stubs (see docs/redis-mvp-implementation.md, "Known
 * limitations").
 */
const REDIS_STACK_NAME = 'DeployzApplicationRedisLive';

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

// ── Redis MVP: cache-lifecycle helpers ──────────────────────────────────

/**
 * Synthesizes a standalone `ApplicationStack` template with
 * `redisRequired: true` — the programmatic equivalent of
 * `scripts/synth-app.mjs`, which today hardcodes `redisRequired: false`
 * (Known limitation: no caller passes `true` yet). `allowInsecureHttp: true`
 * is required because no ACM `certificateArn` is available for a throwaway
 * live-test stack (§9 refuses a silent HTTP-only fallback otherwise).
 *
 * The template has no bundled Lambda assets (unlike BootstrapStack's relay
 * function), so — unlike the `cdk deploy` shell-out above — it can be
 * created directly through the `aws.cloudFormation.createStack` seam: there
 * is no publisher ZIP-gap to work around here.
 */
function synthRedisApplicationTemplate(): string {
  const app = new App();
  const stack = new ApplicationStack(app, REDIS_STACK_NAME, {
    expressMode: false,
    allowInsecureHttp: true,
    redisRequired: true,
  });
  const assembly = app.synth();
  const artifact = assembly.getStackArtifact(stack.artifactId);
  return JSON.stringify(artifact.template);
}

/**
 * Polls the injectable `ElastiCacheClient` seam until the cluster reaches
 * `available`, matching by endpoint address when one is supplied (so a
 * region with other, unrelated cache clusters doesn't produce a false
 * match). Pure orchestration over the seam — exercised for real by the
 * gated live suite below, unit-tested here with a `vi.fn()` fake so this
 * file's non-live tests keep proving the logic without AWS credentials.
 */
async function waitForCacheAvailable(
  client: ElastiCacheClient,
  region: string,
  options: { endpointAddress?: string; maxAttempts?: number; pollIntervalMs?: number } = {},
): Promise<CacheClusterInfo> {
  const maxAttempts = options.maxAttempts ?? 60;
  const pollIntervalMs = options.pollIntervalMs ?? 10_000;

  let last: CacheClusterInfo | undefined;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const { clusters } = await client.describeCacheClusters({ region });
    const cluster = options.endpointAddress
      ? clusters.find((c) => c.endpointAddress === options.endpointAddress)
      : clusters[0];

    if (cluster !== undefined) {
      last = cluster;
      if (cluster.status === 'available') return cluster;
      if (cluster.status === 'create-failed' || cluster.status === 'incompatible-parameters') {
        throw new Error(`ElastiCache cluster reached terminal failure status: ${cluster.status}`);
      }
    }

    if (pollIntervalMs > 0) await new Promise((r) => setTimeout(r, pollIntervalMs));
  }

  throw new Error(
    `Timed out waiting for ElastiCache cluster to become available (last status: ${last?.status ?? 'not found'})`,
  );
}

/** Polls a CloudFormation stack until `describeStacks` throws (deleted) or attempts run out. */
async function waitForStackGone(
  cfn: { describeStacks: (p: { stackName: string; region: string }) => Promise<{ status: string }> },
  stackName: string,
  region: string,
  maxAttempts = 60,
  pollIntervalMs = 10_000,
): Promise<boolean> {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const s = await cfn.describeStacks({ stackName, region });
      if (s.status === 'DELETE_COMPLETE') return true;
    } catch {
      return true;
    }
    if (pollIntervalMs > 0) await new Promise((r) => setTimeout(r, pollIntervalMs));
  }
  return false;
}

// ── Fake-path unit tests (always run — no AWS credentials required) ─────

describe('waitForCacheAvailable (ElastiCache seam, fake client)', () => {
  it('returns the cluster once describeCacheClusters reports available', async () => {
    const describeCacheClusters = vi
      .fn()
      .mockResolvedValueOnce({
        clusters: [{ cacheClusterId: 'x', status: 'creating', endpointAddress: undefined, port: undefined }],
      })
      .mockResolvedValueOnce({
        clusters: [{ cacheClusterId: 'x', status: 'available', endpointAddress: 'cache.example.internal', port: 6379 }],
      });
    const fake: ElastiCacheClient = { describeCacheClusters };

    const result = await waitForCacheAvailable(fake, REGION, { pollIntervalMs: 0, maxAttempts: 5 });

    expect(result.status).toBe('available');
    expect(result.endpointAddress).toBe('cache.example.internal');
    expect(describeCacheClusters).toHaveBeenCalledTimes(2);
  });

  it('matches by endpoint address when other clusters are present in the region', async () => {
    const describeCacheClusters = vi.fn().mockResolvedValue({
      clusters: [
        { cacheClusterId: 'other', status: 'available', endpointAddress: 'other.example.internal', port: 6379 },
        { cacheClusterId: 'target', status: 'available', endpointAddress: 'target.example.internal', port: 6379 },
      ],
    });
    const fake: ElastiCacheClient = { describeCacheClusters };

    const result = await waitForCacheAvailable(fake, REGION, {
      endpointAddress: 'target.example.internal',
      pollIntervalMs: 0,
      maxAttempts: 5,
    });

    expect(result.cacheClusterId).toBe('target');
  });

  it('throws on a terminal failure status', async () => {
    const describeCacheClusters = vi.fn().mockResolvedValue({
      clusters: [{ cacheClusterId: 'x', status: 'create-failed', endpointAddress: undefined, port: undefined }],
    });
    const fake: ElastiCacheClient = { describeCacheClusters };

    await expect(waitForCacheAvailable(fake, REGION, { pollIntervalMs: 0, maxAttempts: 5 })).rejects.toThrow(
      /terminal failure/,
    );
  });

  it('times out when the cluster never appears', async () => {
    const describeCacheClusters = vi.fn().mockResolvedValue({ clusters: [] });
    const fake: ElastiCacheClient = { describeCacheClusters };

    await expect(waitForCacheAvailable(fake, REGION, { pollIntervalMs: 0, maxAttempts: 3 })).rejects.toThrow(
      /Timed out/,
    );
    expect(describeCacheClusters).toHaveBeenCalledTimes(3);
  });
});

describe('synthRedisApplicationTemplate (fake path — no AWS)', () => {
  it('synthesizes an ApplicationStack template containing an ElastiCache cache cluster', () => {
    const templateBody = synthRedisApplicationTemplate();
    const template = JSON.parse(templateBody) as {
      Resources: Record<string, { Type: string }>;
      Outputs?: Record<string, unknown>;
    };

    const cacheResources = Object.values(template.Resources).filter((r) => r.Type === 'AWS::ElastiCache::CacheCluster');
    expect(cacheResources).toHaveLength(1);

    const outputKeys = Object.keys(template.Outputs ?? {});
    expect(outputKeys.some((k) => k.endsWith('CacheEndpoint'))).toBe(true);
  });
});

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

/**
 * Redis MVP — cache-lifecycle proof, independent of the bootstrap-golden-path
 * suite above. Deploys a throwaway, standalone `redisRequired: true`
 * ApplicationStack directly through the `aws.cloudFormation`/`aws.elastiCache`
 * seams (no `cdk deploy` shell-out — see synthRedisApplicationTemplate's
 * doc comment for why that's safe here).
 *
 * COST/TIME WARNING for whoever runs this: the ApplicationStack provisions a
 * full VPC (2 AZs, NAT gateway), RDS PostgreSQL, ALB, ECS Fargate, S3, AND
 * the ElastiCache cache — unconditionally, not just the cache — because
 * there is no lighter-weight standalone way to synth just the cache
 * resources today. Expect this to take on the order of 15-25 minutes to
 * reach CREATE_COMPLETE (RDS dominates) and to incur AWS charges for that
 * window. The RDS instance in this stack is `RemovalPolicy.RETAIN` (a
 * pre-existing ApplicationStack behavior, unrelated to Redis) — stack
 * deletion below will succeed but ORPHAN the RDS instance; delete it
 * manually afterward to avoid ongoing cost. The cache and its subnet group
 * carry no removal-policy override (CloudFormation's implicit "Delete"),
 * matching the "no RETAIN" claim in docs/redis-mvp-implementation.md.
 */
liveAws('§67 Phase 4 — live AWS Redis cache provisioning (redisRequired: true)', () => {
  const aws = createAwsClients();

  it('cache cluster reaches available, endpoint output present, deletion removes it', async () => {
    if (aws.elastiCache === undefined) {
      throw new Error('createAwsClients() did not return an elastiCache client');
    }
    const elastiCache = aws.elastiCache;

    const templateBody = synthRedisApplicationTemplate();
    await aws.cloudFormation.createStack({
      stackName: REDIS_STACK_NAME,
      templateBody,
      region: REGION,
      capabilities: ['CAPABILITY_IAM'],
    });

    // 1. Stack reaches CREATE_COMPLETE (RDS dominates the wait — see the
    // cost/time warning above).
    let stack = await aws.cloudFormation.describeStacks({ stackName: REDIS_STACK_NAME, region: REGION });
    for (let attempt = 0; stack.status !== 'CREATE_COMPLETE' && attempt < 180; attempt++) {
      if (stack.status.includes('FAILED') || stack.status.includes('ROLLBACK')) {
        throw new Error(`stack "${REDIS_STACK_NAME}" reached terminal failure: ${stack.status}`);
      }
      await new Promise((r) => setTimeout(r, 10_000));
      stack = await aws.cloudFormation.describeStacks({ stackName: REDIS_STACK_NAME, region: REGION });
    }
    expect(stack.status).toBe('CREATE_COMPLETE');

    // 2. Endpoint output present.
    const endpointOutput = stack.outputs.find((o) => o.outputKey.endsWith('CacheEndpoint'));
    expect(endpointOutput?.outputValue).toBeTruthy();

    // 3. Cache cluster reaches available, matched by the endpoint the stack
    // output reports (robust even if other clusters exist in this region).
    const cluster = await waitForCacheAvailable(elastiCache, REGION, {
      endpointAddress: endpointOutput?.outputValue,
      maxAttempts: 60,
      pollIntervalMs: 10_000,
    });
    expect(cluster.status).toBe('available');
    expect(cluster.endpointAddress).toBe(endpointOutput?.outputValue);

    // 4. Deletion removes the cache (and the rest of the stack, minus the
    // RETAIN'd RDS instance — see the warning above).
    await aws.cloudFormation.deleteStack({ stackName: REDIS_STACK_NAME, region: REGION });
    const gone = await waitForStackGone(aws.cloudFormation, REDIS_STACK_NAME, REGION, 60, 10_000);
    expect(gone).toBe(true);

    const { clusters: afterDelete } = await elastiCache.describeCacheClusters({ region: REGION });
    expect(afterDelete.find((c) => c.cacheClusterId === cluster.cacheClusterId)).toBeUndefined();
  });
});
