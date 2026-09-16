/**
 * Canary E2E — read-only verification of a persistent installation
 * (docs/testing/discovery/phase1-design-decisions.md D5).
 *
 * Gated on `DEPLOYZ_E2E_MODE === 'canary'` AND
 * `DEPLOYZ_E2E_ALLOW_REAL_AWS === '1'` — `scripts/e2e.mjs` sets both before
 * spawning this suite (`pnpm e2e:canary`); a direct `vitest run` must set
 * them by hand.
 *
 * Creates and deletes NOTHING: `verifyInstallation`, `observeRuntimeHealth`
 * and `listAllStackResources` are all read-only CloudFormation/ECS/ELB
 * reads against the standing canary installation. A canary that finds the
 * environment unhealthy FAILS LOUDLY (with the observed detail printed) —
 * it does not skip or soften the result.
 *
 * The ECS/ELB adapters below are written directly against the AWS SDK
 * rather than imported from `packages/relay/src/index.ts`: that file builds
 * the same `EcsServiceReader`/`TargetHealthReader` shapes, but only as
 * private lazy singletons, not a public export. Per D5's scope, this suite
 * must not touch relay source — recreating the (structurally identical)
 * adapter here reuses the *types* relay already exports from `./ecs-health`
 * without requiring a relay source change.
 */
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import {
  DescribeServicesCommand,
  ECSClient,
} from '@aws-sdk/client-ecs';
import {
  DescribeTargetHealthCommand,
  ElasticLoadBalancingV2Client,
} from '@aws-sdk/client-elastic-load-balancing-v2';
import { beforeAll, describe, expect, it } from 'vitest';

import { DEFAULT_APPLICATION_STACK_NAME } from '@deployz/contracts';
import { observeRuntimeHealth, type EcsServiceReader, type TargetHealthReader } from '@deployz/relay/ecs-health';
import { listAllStackResources } from '@deployz/relay/stack-resources';
import { createCloudFormationReader, verifyInstallation } from '@deployz/relay/verify';

import { createAwsClients } from '../src/integration/aws-clients.js';
import { REGION, STANDING_INSTALLATION_ID, isRealAwsModeActive } from './live-aws-helpers.js';

// ── Real ECS/ELB adapters (see file doc comment for why these live here) ──

function toEcsServiceReader(client: ECSClient): EcsServiceReader {
  return {
    async describeServices(input) {
      const response = await client.send(
        new DescribeServicesCommand({ cluster: input.cluster, services: input.services }),
      );
      return {
        services: (response.services ?? []).map((service) => ({
          desiredCount: service.desiredCount ?? undefined,
          runningCount: service.runningCount ?? undefined,
          deployments: (service.deployments ?? []).map((deployment) => ({
            status: deployment.status ?? undefined,
            rolloutState: deployment.rolloutState ?? undefined,
          })),
        })),
      };
    },
  };
}

function toTargetHealthReader(client: ElasticLoadBalancingV2Client): TargetHealthReader {
  return {
    async describeTargetHealth(input) {
      const response = await client.send(
        new DescribeTargetHealthCommand({ TargetGroupArn: input.targetGroupArn }),
      );
      return {
        targets: (response.TargetHealthDescriptions ?? []).map((description) => ({
          state: description.TargetHealth?.State ?? undefined,
        })),
      };
    },
  };
}

// ── Fake-path unit tests (always run — no AWS credentials required) ─────

describe('canary gate predicate (fake path — no AWS)', () => {
  it('is active only for mode=canary AND the real-AWS opt-in', () => {
    expect(isRealAwsModeActive({ DEPLOYZ_E2E_MODE: 'canary', DEPLOYZ_E2E_ALLOW_REAL_AWS: '1' }, 'canary')).toBe(
      true,
    );
    expect(isRealAwsModeActive({ DEPLOYZ_E2E_MODE: 'canary', DEPLOYZ_E2E_ALLOW_REAL_AWS: '0' }, 'canary')).toBe(
      false,
    );
    expect(isRealAwsModeActive({ DEPLOYZ_E2E_MODE: 'canary' }, 'canary')).toBe(false);
    expect(isRealAwsModeActive({ DEPLOYZ_E2E_ALLOW_REAL_AWS: '1' }, 'canary')).toBe(false);
    expect(isRealAwsModeActive({}, 'canary')).toBe(false);
    // Wrong mode with the flag set must not activate canary.
    expect(isRealAwsModeActive({ DEPLOYZ_E2E_MODE: 'fresh', DEPLOYZ_E2E_ALLOW_REAL_AWS: '1' }, 'canary')).toBe(
      false,
    );
  });
});

// ── Live suite ────────────────────────────────────────────────────────────

const canaryActive = isRealAwsModeActive(process.env, 'canary');
const canaryDescribe = canaryActive ? describe : describe.skip;

canaryDescribe('canary — read-only verification of the standing installation', () => {
  const installationId =
    process.env.DEPLOYZ_E2E_CANARY_INSTALLATION_ID ??
    process.env.DEPLOYZ_LIVE_INSTALLATION_ID ??
    STANDING_INSTALLATION_ID;
  const stackName = process.env.DEPLOYZ_E2E_CANARY_STACK_NAME ?? DEFAULT_APPLICATION_STACK_NAME;
  const redisRequired = process.env.DEPLOYZ_E2E_CANARY_REDIS_REQUIRED === '1';
  // Phase 2: `verifyInstallation` no longer defaults this to true — the
  // standing canary installation runs PostgreSQL, so that stays the default
  // here too, overridable for a stateless standing installation.
  const databaseRequired = process.env.DEPLOYZ_E2E_CANARY_DATABASE_REQUIRED !== '0';

  beforeAll(async () => {
    try {
      await createAwsClients().sts.getCallerIdentity();
    } catch (err) {
      throw new Error(
        'Canary preflight failed: could not resolve AWS credentials via sts.getCallerIdentity ' +
          `(${err instanceof Error ? err.message : String(err)}). Configure credentials through the ` +
          'standard AWS SDK v3 chain (env vars, ~/.aws/credentials, or an IAM role) before running ' +
          'the canary suite.',
      );
    }
  });

  it('verifyInstallation reports the full check ladder passing', async () => {
    const result = await verifyInstallation({
      cfn: createCloudFormationReader(REGION),
      installationId,
      stackName,
      redisRequired,
      databaseRequired,
    });

    if (!result.verified && result.checks.find((c) => c.name === 'stack-exists' && !c.passed)) {
      throw new Error(
        `Canary installation "${installationId}" (stack "${stackName}") does not exist in this account/region.\n\n` +
          `The canary identifies the installation via the DEPLOYZ_E2E_CANARY_INSTALLATION_ID env var\n` +
          `(fallback: DEPLOYZ_LIVE_INSTALLATION_ID, then hardcoded STANDING_INSTALLATION_ID).\n\n` +
          `The persistent canary must be PROVISIONED INTENTIONALLY (a real-AWS bootstrap/create cycle).\n` +
          `e2e:canary will NOT create replacement infrastructure — it is a read-only verification suite.\n` +
          `To create the canary, run e2e:canary:versions core or e2e:fresh with the appropriate setup.`,
      );
    }

    if (!result.verified) {
      throw new Error(
        `Canary verification failed for installation ${installationId}: ${result.reason}\n` +
          JSON.stringify(result.checks, null, 2),
      );
    }
    expect(result.verified).toBe(true);

    const requiredChecks = [
      'stack-exists',
      'stack-complete',
      'stack-tagged',
      'compute',
      'ingress',
      'database',
      'storage',
      ...(redisRequired ? ['cache'] : []),
    ];
    for (const name of requiredChecks) {
      expect(result.checks.find((check) => check.name === name)?.passed, name).toBe(true);
    }
  }, 60_000);

  it('persistent-canary tags are present on the application stack', async () => {
    const cfn = new CloudFormationClient({ region: REGION });
    const response = await cfn.send(new DescribeStacksCommand({ StackName: stackName }));
    const stack = response.Stacks?.[0];
    expect(stack, `Stack "${stackName}" not found for tag check`).toBeDefined();
    const tags = Object.fromEntries((stack!.Tags ?? []).map((t) => [t.Key, t.Value]));

    const expectedTags: Record<string, string> = {
      DeployzEnvironment: 'e2e',
      DeployzTestMode: 'canary',
      DeployzPersistent: 'true',
      DeployzProtected: 'true',
    };

    for (const [key, value] of Object.entries(expectedTags)) {
      const actual = tags[key];
      expect(actual, `Stack tag ${key} expected "${value}", got "${actual ?? 'unset'}"`).toBe(value);
    }
  }, 30_000);

  it('runtime health reports a definitive status (HEALTHY expected)', async () => {
    const health = await observeRuntimeHealth(
      {
        cfn: createCloudFormationReader(REGION),
        ecs: toEcsServiceReader(new ECSClient({ region: REGION })),
        elb: toTargetHealthReader(new ElasticLoadBalancingV2Client({ region: REGION })),
      },
      stackName,
    );

    // A canary that finds the environment sick must fail loudly, not skip —
    // print the full observed detail so the failure is actionable.
    if (health.healthStatus !== 'HEALTHY') {
      throw new Error(
        `Canary found runtime health "${health.healthStatus}" for stack "${stackName}" ` +
          `(expected HEALTHY): ${JSON.stringify(
            {
              components: health.components,
              desiredCount: health.desiredCount,
              runningCount: health.runningCount,
              unhealthyTargetCount: health.unhealthyTargetCount,
              deploymentRolloutState: health.deploymentRolloutState,
            },
            null,
            2,
          )}`,
      );
    }
    expect(health.healthStatus).toBe('HEALTHY');
  }, 60_000);

  it('resource inventory is non-null and includes the verified resource kinds', async () => {
    const inventory = await listAllStackResources(createCloudFormationReader(REGION), stackName);

    expect(inventory, 'listAllStackResources returned null — a partial or failed read').not.toBeNull();
    expect(inventory!.resources.length).toBeGreaterThan(0);

    const observedTypes = new Set(inventory!.resources.map((resource) => resource.type));
    const expectedTypes = [
      'AWS::ECS::Service',
      'AWS::ElasticLoadBalancingV2::LoadBalancer',
      'AWS::RDS::DBInstance',
      'AWS::S3::Bucket',
    ];
    for (const type of expectedTypes) {
      expect(observedTypes.has(type), `expected ${type} in the resource inventory`).toBe(true);
    }
  }, 60_000);
});
