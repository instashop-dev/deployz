/**
 * Shared shell-out helpers for the live-AWS vitest suites (golden-path,
 * canary, fresh — docs/testing/discovery/phase1-design-decisions.md D5).
 *
 * Extracted from golden-path-live-aws.test.ts so canary-e2e.live.test.ts and
 * fresh-e2e.live.test.ts reuse exactly the same `cdk`/`aws` invocation
 * pattern that file already proved, instead of forking it.
 *
 * Not a `.test.ts` file — vitest will not try to run it as a suite.
 */
import { spawnSync } from 'node:child_process';

export const REGION = process.env.AWS_REGION ?? 'us-east-1';

/**
 * The standing canary installation — a real INSTALL provisioned 2026-08-27,
 * treated as a persistent fixture (see golden-path-live-aws.test.ts's
 * "installation verification (live)" block, which this same literal used to
 * be duplicated in). Shared here so it defaults consistently everywhere
 * without redefining it per file.
 */
export const STANDING_INSTALLATION_ID = 'c2dca2bb-a733-470d-8ef0-8e96bc889442';

/**
 * `shell: true` is required on Windows so spawnSync resolves the pnpm.cmd
 * shim. `extraEnv` is merged over `process.env` (not replacing it) — the
 * fresh suite uses this to set `DEPLOYZ_BOOTSTRAP_STACK_NAME` for one
 * invocation without mutating the real process environment.
 */
export function run(cmd: string, extraEnv: Record<string, string> = {}): string {
  const result = spawnSync(cmd, {
    cwd: process.cwd(),
    encoding: 'utf8',
    timeout: 600_000,
    shell: true,
    env: { ...process.env, ...extraEnv },
  });
  if (result.status !== 0) throw new Error(`${cmd} exited ${result.status}\n${result.stderr}`);
  return result.stdout;
}

export function cdk(args: string[], extraEnv: Record<string, string> = {}): string {
  // The --app value "tsx bin/bootstrap.ts" contains a space; under
  // shell:true it would split into two tokens. Quote it so CDK receives the
  // full string as one argument.
  const quoted = args.map((a) => (a.includes(' ') ? `"${a}"` : a)).join(' ');
  return run(`pnpm --filter @deployz/cdk exec cdk ${quoted}`, extraEnv);
}

export function awsCli(args: string, region: string = REGION): string {
  return run(`aws ${args} --region ${region} --output json`);
}

/** Polls a CloudFormation stack until `describeStacks` throws (deleted) or attempts run out. */
export async function waitForStackGone(
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

/**
 * The mode+flag gate shared by canary and fresh (D3/D5): a real-AWS suite
 * runs only when `DEPLOYZ_E2E_MODE` matches its own mode AND
 * `DEPLOYZ_E2E_ALLOW_REAL_AWS === '1'`. `scripts/e2e.mjs` sets both before
 * spawning these suites; a direct `vitest run` must set them by hand.
 */
export function isRealAwsModeActive(
  env: Pick<NodeJS.ProcessEnv, 'DEPLOYZ_E2E_MODE' | 'DEPLOYZ_E2E_ALLOW_REAL_AWS'>,
  mode: 'canary' | 'fresh',
): boolean {
  return env.DEPLOYZ_E2E_MODE === mode && env.DEPLOYZ_E2E_ALLOW_REAL_AWS === '1';
}
