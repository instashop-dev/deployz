/**
 * Fresh E2E — a hardened wrapper around the create/destroy bootstrap golden
 * path (docs/testing/discovery/phase1-design-decisions.md D5): deploy →
 * verify relay Active + tags → destroy → verify gone.
 *
 * Gated on `DEPLOYZ_E2E_MODE === 'fresh'` AND
 * `DEPLOYZ_E2E_ALLOW_REAL_AWS === '1'` — `scripts/e2e.mjs` sets both before
 * spawning this suite (`pnpm e2e:fresh`); a direct `vitest run` must set
 * them by hand.
 *
 * Hardening over golden-path-live-aws.test.ts's Block A (per D5):
 *   - a per-run unique bootstrap stack name (`deployz-fresh-<runid>`,
 *     consumed by bin/bootstrap.ts's DEPLOYZ_BOOTSTRAP_STACK_NAME override)
 *     instead of the fixed `DeployzBootstrap` name, so concurrent or
 *     un-torn-down runs cannot collide;
 *   - a pre-flight refusal if that name already exists, instead of a
 *     collision;
 *   - try/finally best-effort `cdk destroy` + wait-for-gone via
 *     `CleanupRegistry`/`runWithTeardown`, so an assertion failing mid-suite
 *     still tears the stack down — not just "the teardown `it` happens to
 *     run last";
 *   - test-identifying tags (`DeployzTestMode=fresh`, `DeployzEnvironment=e2e`)
 *     applied at `cdk deploy` time.
 *
 * The Redis/application provisioning block is NOT part of fresh's default
 * run — see golden-path-live-aws.test.ts's "live AWS Redis cache
 * provisioning" describe block (gated on `DEPLOYZ_LIVE_AWS=1`) for that.
 * Cleanup here only ever targets the exact stack name this run minted —
 * never a broad or account-wide deletion.
 */
import { randomBytes } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CleanupRegistry, runWithTeardown } from '../src/integration/teardown.js';
import { createAwsClients } from '../src/integration/aws-clients.js';
import { REGION, awsCli, cdk, isRealAwsModeActive, waitForStackGone } from './live-aws-helpers.js';

const APP_CMD = 'tsx bin/bootstrap.ts';
const STACK_NAME_ENV = 'DEPLOYZ_BOOTSTRAP_STACK_NAME';

/** Short random id minted once per suite run — printed for postmortems. */
export function mintRunId(): string {
  return randomBytes(4).toString('hex');
}

export function freshStackName(runId: string): string {
  return `deployz-fresh-${runId}`;
}

/**
 * Refuses to proceed when a stack already carries the freshly minted name.
 * `describeStacks` throwing (CloudFormation's ValidationError for "stack
 * does not exist") is the expected, safe-to-proceed case — only a
 * *resolving* call means a collision.
 */
export async function refuseIfStackExists(
  cfn: { describeStacks: (p: { stackName: string; region: string }) => Promise<{ status: string }> },
  stackName: string,
  region: string,
): Promise<void> {
  let existingStatus: string | undefined;
  try {
    const stack = await cfn.describeStacks({ stackName, region });
    existingStatus = stack.status;
  } catch {
    return; // Not found — the expected case for a freshly minted name.
  }
  throw new Error(
    `Refusing to run fresh E2E: a stack named "${stackName}" already exists (status ${existingStatus}). ` +
      'This should not happen with a freshly minted run id — investigate before retrying.',
  );
}

// ── Fake-path unit tests (always run — no AWS credentials required) ─────

describe('fresh gate predicate (fake path — no AWS)', () => {
  it('is active only for mode=fresh AND the real-AWS opt-in', () => {
    expect(isRealAwsModeActive({ DEPLOYZ_E2E_MODE: 'fresh', DEPLOYZ_E2E_ALLOW_REAL_AWS: '1' }, 'fresh')).toBe(
      true,
    );
    expect(isRealAwsModeActive({ DEPLOYZ_E2E_MODE: 'fresh', DEPLOYZ_E2E_ALLOW_REAL_AWS: '0' }, 'fresh')).toBe(
      false,
    );
    expect(isRealAwsModeActive({ DEPLOYZ_E2E_MODE: 'fresh' }, 'fresh')).toBe(false);
    expect(isRealAwsModeActive({ DEPLOYZ_E2E_ALLOW_REAL_AWS: '1' }, 'fresh')).toBe(false);
    // Wrong mode with the flag set must not activate fresh.
    expect(isRealAwsModeActive({ DEPLOYZ_E2E_MODE: 'canary', DEPLOYZ_E2E_ALLOW_REAL_AWS: '1' }, 'fresh')).toBe(
      false,
    );
  });
});

describe('mintRunId / freshStackName (fake path — no AWS)', () => {
  it('mints an 8-hex-char id', () => {
    expect(mintRunId()).toMatch(/^[0-9a-f]{8}$/);
  });

  it('mints distinct ids across calls', () => {
    expect(mintRunId()).not.toBe(mintRunId());
  });

  it('names the stack deployz-fresh-<runid>', () => {
    expect(freshStackName('abcd1234')).toBe('deployz-fresh-abcd1234');
  });
});

describe('bin/bootstrap.ts — DEPLOYZ_BOOTSTRAP_STACK_NAME override (fake path — no AWS)', () => {
  // Synth-level, in the style of bootstrap-stack.test.ts's own synth tests:
  // proves the actual mechanism fresh mode relies on (bin/bootstrap.ts
  // reading the env var at synth time), not a copy of its logic.
  const ENV_KEY = 'DEPLOYZ_BOOTSTRAP_STACK_NAME';
  let saved: string | undefined;

  beforeEach(() => {
    saved = process.env[ENV_KEY];
  });

  afterEach(() => {
    if (saved === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = saved;
  });

  it('defaults to DeployzBootstrap when unset', async () => {
    delete process.env[ENV_KEY];
    vi.resetModules();
    const { stack } = await import('../bin/bootstrap.js');
    expect(stack.stackName).toBe('DeployzBootstrap');
  });

  it('honors the override — the mechanism fresh mode uses for its per-run unique name', async () => {
    process.env[ENV_KEY] = 'deployz-fresh-testoverride';
    vi.resetModules();
    const { stack } = await import('../bin/bootstrap.js');
    expect(stack.stackName).toBe('deployz-fresh-testoverride');
  });
});

describe('refuseIfStackExists (fake path — mocked CloudFormation seam)', () => {
  it('refuses when the stack already exists', async () => {
    const cfn = { describeStacks: vi.fn().mockResolvedValue({ status: 'CREATE_COMPLETE' }) };

    await expect(refuseIfStackExists(cfn, 'deployz-fresh-abcd1234', REGION)).rejects.toThrow(
      /already exists/,
    );
  });

  it('proceeds when describeStacks throws (stack not found)', async () => {
    const cfn = { describeStacks: vi.fn().mockRejectedValue(new Error('ValidationError: does not exist')) };

    await expect(refuseIfStackExists(cfn, 'deployz-fresh-abcd1234', REGION)).resolves.toBeUndefined();
  });
});

describe('teardown-always-runs (fake path — mocked cleanup, no AWS)', () => {
  it('runs the registered cleanup even when the guarded work throws', async () => {
    const registry = new CleanupRegistry();
    const cleanup = vi.fn().mockResolvedValue(undefined);

    await expect(
      runWithTeardown(registry, async () => {
        registry.register('cloudformation-stack', 'deployz-fresh-abcd1234', cleanup);
        throw new Error('assertion failed mid-suite');
      }),
    ).rejects.toThrow('assertion failed mid-suite');

    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(registry.lastResult?.failed).toBe(0);
  });

  it('surfaces a failed cleanup without masking the original error', async () => {
    const registry = new CleanupRegistry();
    const cleanup = vi.fn().mockRejectedValue(new Error('cdk destroy failed'));

    await expect(
      runWithTeardown(registry, async () => {
        registry.register('cloudformation-stack', 'deployz-fresh-abcd1234', cleanup);
        throw new Error('assertion failed mid-suite');
      }),
    ).rejects.toThrow('assertion failed mid-suite');

    expect(registry.lastResult?.failed).toBe(1);
    expect(registry.lastResult?.errors[0]?.message).toBe('cdk destroy failed');
  });
});

// ── Live suite ────────────────────────────────────────────────────────────

const freshActive = isRealAwsModeActive(process.env, 'fresh');
const freshDescribe = freshActive ? describe : describe.skip;

freshDescribe('fresh — hardened bootstrap create/destroy golden path', () => {
  const runId = mintRunId();
  const stackName = freshStackName(runId);
  const aws = createAwsClients();
  // Per-run synth output directory: the CDK CLI refuses to run while another
  // CLI is reading the shared cdk.out ("Other CLIs are currently reading from
  // cdk.out") — an aborted earlier run's lingering process would otherwise
  // block every later fresh run on this machine. Nested under cdk.out/ so it
  // stays gitignored; the CLI's reader lock is per output directory.
  const outDir = `cdk.out/fresh-${runId}`;

  it('preflight: the minted stack name does not already exist', async () => {
    console.log(`[fresh-e2e] run id ${runId} — stack name "${stackName}" — region ${REGION}`);
    await refuseIfStackExists(aws.cloudFormation, stackName, REGION);
  });

  it(
    'deploy -> verify relay Active + tags -> destroy -> verify gone',
    async () => {
      const registry = new CleanupRegistry();

      await runWithTeardown(registry, async () => {
        cdk(
          [
            'deploy',
            '--app',
            APP_CMD,
            '--output',
            outDir,
            '--require-approval',
            'never',
            '--tags',
            'DeployzTestMode=fresh',
            '--tags',
            'DeployzEnvironment=e2e',
          ],
          { [STACK_NAME_ENV]: stackName },
        );

        // Registered immediately after the stack exists, so a failure in any
        // assertion below still tears it down via runWithTeardown's finally
        // — cleanup here never targets anything but this exact stack name.
        registry.register('cloudformation-stack', stackName, async () => {
          cdk(['destroy', '--app', APP_CMD, '--output', outDir, '--force'], {
            [STACK_NAME_ENV]: stackName,
          });
          const gone = await waitForStackGone(aws.cloudFormation, stackName, REGION);
          if (!gone) {
            throw new Error(`fresh-e2e: stack "${stackName}" did not reach DELETE_COMPLETE during teardown`);
          }
        });

        const stack = await aws.cloudFormation.describeStacks({ stackName, region: REGION });
        expect(stack.status).toBe('CREATE_COMPLETE');

        const fnArn = stack.outputs.find((o) => o.outputKey.endsWith('RelayFunctionArn'))?.outputValue;
        expect(fnArn).toBeTruthy();
        const cfg = JSON.parse(awsCli(`lambda get-function-configuration --function-name ${fnArn}`));
        expect(cfg.State).toBe('Active');
        expect(cfg.LastUpdateStatus).toBe('Successful');

        const installId = stack.outputs.find((o) => o.outputKey.endsWith('InstallationId'))?.outputValue;
        expect(installId).toBeTruthy();
        const tagRes = JSON.parse(
          awsCli(
            `resourcegroupstaggingapi get-resources --tag-filters Key=deployz:installation,Values=${installId}`,
          ),
        );
        const arns = (tagRes.ResourceTagMappingList ?? []).map((m: { ResourceARN: string }) => m.ResourceARN);
        expect(arns.length).toBeGreaterThanOrEqual(3);
        expect(arns.some((a: string) => a.includes('lambda'))).toBe(true);
      });

      // runWithTeardown's finally already ran the registered destroy +
      // wait-for-gone above. Confirm it actually succeeded before declaring
      // the run clean.
      expect(registry.lastResult?.failed).toBe(0);

      let stillThere = true;
      try {
        const s = await aws.cloudFormation.describeStacks({ stackName, region: REGION });
        stillThere = s.status !== 'DELETE_COMPLETE';
      } catch {
        stillThere = false;
      }
      expect(stillThere).toBe(false);
    },
    900_000,
  );
});
