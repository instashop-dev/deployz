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
 * see that describe block's doc comment for scope, cost/time, and required
 * image env vars (DEPLOYZ_LIVE_IMAGE_REPOSITORY / DEPLOYZ_LIVE_IMAGE_DIGEST).
 */
import { App } from 'aws-cdk-lib';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createCloudFormationReader, verifyInstallation } from '@deployz/relay/verify';

import { createAwsClients, type CacheClusterInfo, type ElastiCacheClient } from '../src/integration/aws-clients.js';
import { ApplicationStack } from '../src/application/application-stack.js';
import { REGION, STANDING_INSTALLATION_ID, awsCli, cdk, waitForStackGone } from './live-aws-helpers.js';

const STACK_NAME = 'DeployzBootstrap';
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

// ── Redis MVP: cache-lifecycle helpers ──────────────────────────────────

/**
 * Synthesizes a standalone `ApplicationStack` template with
 * `redisRequired: true` — the programmatic equivalent of
 * `scripts/synth-app.mjs`, which today hardcodes `redisRequired: false`
 * (Known limitation: no caller passes `true` yet). `allowInsecureHttp: true`
 * is required because no ACM `certificateArn` is available for a throwaway
 * live-test stack (§9 refuses a silent HTTP-only fallback otherwise).
 *
 * `image` MUST be a real, pullable reference — see `requireLiveImage()`
 * below for why the ApplicationStack placeholder default is unusable here.
 *
 * The template has no bundled Lambda assets (unlike BootstrapStack's relay
 * function), so — unlike the `cdk deploy` shell-out above — it can be
 * created directly through the `aws.cloudFormation.createStack` seam: there
 * is no publisher ZIP-gap to work around here.
 */
function synthRedisApplicationTemplate(image: { imageRepository: string; imageDigest: string }): string {
  const app = new App();
  const stack = new ApplicationStack(app, REDIS_STACK_NAME, {
    expressMode: false,
    allowInsecureHttp: true,
    redisRequired: true,
    imageRepository: image.imageRepository,
    imageDigest: image.imageDigest,
  });
  const assembly = app.synth();
  const artifact = assembly.getStackArtifact(stack.artifactId);
  return JSON.stringify(artifact.template);
}

/**
 * Required when `DEPLOYZ_LIVE_AWS=1`: a real, pullable image reference for
 * the throwaway ApplicationStack this suite deploys. Without it,
 * ApplicationStack falls back to its own placeholder default
 * (`public.ecr.aws/deployz/fixture@sha256:000...000`, see
 * `application-stack.ts`'s `DEFAULT_IMAGE_REPOSITORY`/`DEFAULT_IMAGE_DIGEST`)
 * — a digest ECS cannot actually pull. That makes the ECS service fail to
 * start, the deployment circuit breaker fires, and CloudFormation rolls back
 * the WHOLE stack (cache included) before it ever reaches `CREATE_COMPLETE`.
 * That failure has nothing to do with Redis, ElastiCache, or AWS
 * credentials — it would just look like this suite is broken. Failing fast
 * here, naming exactly what's missing, is cheaper than debugging a rollback.
 *
 * Point these at a real, already-published image — e.g. a published build
 * of `packages/fixture` — not at anything built during this test run.
 */
function requireLiveImage(): { imageRepository: string; imageDigest: string } {
  const imageRepository = process.env.DEPLOYZ_LIVE_IMAGE_REPOSITORY;
  const imageDigest = process.env.DEPLOYZ_LIVE_IMAGE_DIGEST;
  if (!imageRepository || !imageDigest) {
    throw new Error(
      'DEPLOYZ_LIVE_AWS=1 requires DEPLOYZ_LIVE_IMAGE_REPOSITORY and DEPLOYZ_LIVE_IMAGE_DIGEST ' +
        '(a real, pullable image — e.g. a published build of packages/fixture) to be set. Without ' +
        'them, ApplicationStack falls back to its placeholder default image, which ECS cannot pull: ' +
        'the deployment circuit breaker fires and CloudFormation rolls back the whole stack (cache ' +
        'included) before CREATE_COMPLETE — a failure that looks unrelated to Redis or AWS creds ' +
        'but is really just a missing image reference.',
    );
  }
  return { imageRepository, imageDigest };
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
    const templateBody = synthRedisApplicationTemplate({
      imageRepository: 'public.ecr.aws/example/fixture',
      imageDigest: 'sha256:' + '1'.repeat(64),
    });
    const template = JSON.parse(templateBody) as {
      Resources: Record<string, { Type: string }>;
      Outputs?: Record<string, unknown>;
    };

    const cacheResources = Object.values(template.Resources).filter((r) => r.Type === 'AWS::ElastiCache::ReplicationGroup');
    expect(cacheResources).toHaveLength(1);

    const outputKeys = Object.keys(template.Outputs ?? {});
    expect(outputKeys.some((k) => k.endsWith('CacheEndpoint'))).toBe(true);
  });
});

describe('requireLiveImage (fail-fast guard, fake path — no AWS)', () => {
  const ENV_KEYS = ['DEPLOYZ_LIVE_IMAGE_REPOSITORY', 'DEPLOYZ_LIVE_IMAGE_DIGEST'] as const;
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('returns the image when both env vars are set', () => {
    process.env.DEPLOYZ_LIVE_IMAGE_REPOSITORY = 'public.ecr.aws/example/fixture';
    process.env.DEPLOYZ_LIVE_IMAGE_DIGEST = 'sha256:' + '2'.repeat(64);

    const image = requireLiveImage();

    expect(image.imageRepository).toBe('public.ecr.aws/example/fixture');
    expect(image.imageDigest).toBe('sha256:' + '2'.repeat(64));
  });

  it('throws naming both env vars when either is missing', () => {
    delete process.env.DEPLOYZ_LIVE_IMAGE_REPOSITORY;
    delete process.env.DEPLOYZ_LIVE_IMAGE_DIGEST;

    expect(() => requireLiveImage()).toThrow(/DEPLOYZ_LIVE_IMAGE_REPOSITORY/);
    expect(() => requireLiveImage()).toThrow(/DEPLOYZ_LIVE_IMAGE_DIGEST/);

    process.env.DEPLOYZ_LIVE_IMAGE_REPOSITORY = 'public.ecr.aws/example/fixture';
    expect(() => requireLiveImage()).toThrow(/DEPLOYZ_LIVE_IMAGE_DIGEST/);
  });
});

const liveAws = process.env.DEPLOYZ_LIVE_AWS === '1' ? describe : describe.skip;

liveAws('§67 Phase 4 — live AWS bootstrap golden path', () => {
  const aws = createAwsClients();

  it('step 13: cdk deploy reaches CREATE_COMPLETE', async () => {
    await cdk(['deploy', '--app', APP_CMD, '--require-approval', 'never']);
    const stack = await aws.cloudFormation.describeStacks({ stackName: STACK_NAME, region: REGION });
    expect(stack.status).toBe('CREATE_COMPLETE');
    expect(stack.stackName).toBe(STACK_NAME);
  });

  it('step 16: relay Lambda is Active with the installation env wired', async () => {
    const stack = await aws.cloudFormation.describeStacks({ stackName: STACK_NAME, region: REGION });
    const fnArn = stack.outputs.find((o) => o.outputKey.endsWith('RelayFunctionArn'))?.outputValue;
    expect(fnArn).toBeTruthy();

    const cfg = JSON.parse(await awsCli(`lambda get-function-configuration --function-name ${fnArn}`));
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
      await awsCli(
        `resourcegroupstaggingapi get-resources --tag-filters Key=deployz:installation,Values=${installId}`,
      ),
    );
    const arns = (res.ResourceTagMappingList ?? []).map((m: { ResourceARN: string }) => m.ResourceARN);
    expect(arns.length).toBeGreaterThanOrEqual(3);
    expect(arns.some((a: string) => a.includes('lambda'))).toBe(true);
    expect(arns.some((a: string) => a.includes('secretsmanager'))).toBe(true);
    expect(arns.some((a: string) => a.includes('events'))).toBe(true);
  });

  it('teardown: cdk destroy removes the stack', async () => {
    await cdk(['destroy', '--app', APP_CMD, '--force']);
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
 *
 * IMAGE REQUIREMENT: set `DEPLOYZ_LIVE_IMAGE_REPOSITORY` and
 * `DEPLOYZ_LIVE_IMAGE_DIGEST` to a real, already-published, pullable image
 * (e.g. a published build of packages/fixture) before running this with
 * `DEPLOYZ_LIVE_AWS=1` — see `requireLiveImage()`. Skipping this is NOT a
 * safe default: without it, ApplicationStack falls back to its own
 * placeholder image, ECS can't pull it, the deployment circuit breaker
 * fires, and CloudFormation rolls back the WHOLE stack — cache included —
 * before CREATE_COMPLETE. That failure is a missing-image problem, not a
 * Redis or credentials problem; `requireLiveImage()` fails fast up front
 * instead of letting it surface as a confusing rollback 15+ minutes in.
 */
liveAws('§67 Phase 4 — live AWS Redis cache provisioning (redisRequired: true)', () => {
  const aws = createAwsClients();
  let image: { imageRepository: string; imageDigest: string };

  beforeAll(() => {
    image = requireLiveImage();
  });

  it('cache cluster reaches available, endpoint output present, deletion removes it', async () => {
    if (aws.elastiCache === undefined) {
      throw new Error('createAwsClients() did not return an elastiCache client');
    }
    const elastiCache = aws.elastiCache;

    const templateBody = synthRedisApplicationTemplate(image);
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

/**
 * Verification against the real account.
 *
 * On 2026-08-26 installation c2dca2bb reported HEALTHY in the control plane
 * with nothing provisioned behind it, and this suite asserted the verifier
 * called that what it was. On 2026-08-27 a real INSTALL provisioned the
 * stack, so the expectation is updated rather than deleted — as the design
 * note said it should be.
 *
 * What it proves now is the harder half. "Not verified" is easy to be right
 * about when an account is empty; a verifier that always said no would have
 * passed the old test. These two cases pin it down from both sides: the
 * installation that IS provisioned verifies, and an installation that is
 * not still does not.
 */
liveAws('installation verification (live)', () => {
  const INSTALLATION = process.env.DEPLOYZ_LIVE_INSTALLATION_ID ?? STANDING_INSTALLATION_ID;

  it('verifies a provisioned installation', async () => {
    const result = await verifyInstallation({
      cfn: createCloudFormationReader(REGION),
      installationId: INSTALLATION,
    });

    expect(result.reason).toBeUndefined();
    expect(result.verified).toBe(true);
    // Every check that makes an installation real, not just the stack.
    for (const name of ['stack-exists', 'stack-complete', 'stack-tagged', 'compute', 'ingress', 'database', 'storage']) {
      expect(result.checks.find((check) => check.name === name)?.passed, name).toBe(true);
    }
  }, 60_000);

  it('does not verify an installation that was never provisioned', async () => {
    const result = await verifyInstallation({
      cfn: createCloudFormationReader(REGION),
      installationId: INSTALLATION,
      stackName: 'deployz-app-does-not-exist',
    });

    expect(result.verified).toBe(false);
    expect(result.reason).toBeDefined();
    expect(result.checks.find((check) => check.name === 'stack-exists')?.passed).toBe(false);
  }, 60_000);
});
