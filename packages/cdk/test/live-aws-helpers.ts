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
import { spawn } from 'node:child_process';

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
 * `shell: true` is required on Windows so spawn resolves the pnpm.cmd shim.
 * `extraEnv` is merged over `process.env` (not replacing it) — the fresh
 * suite uses this to set `DEPLOYZ_BOOTSTRAP_STACK_NAME` for one invocation
 * without mutating the real process environment.
 *
 * Async on purpose: a multi-minute synchronous `spawnSync` (`cdk deploy`
 * takes ~5 min) blocks the vitest worker's event loop, its RPC heartbeat to
 * the main process starves, and the run dies with `write ECONNABORTED` /
 * "Timeout calling onTaskUpdate" even though the AWS operation succeeded —
 * observed on three consecutive fresh runs whose stacks all reached
 * DELETE_COMPLETE.
 */
export function run(cmd: string, extraEnv: Record<string, string> = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, {
      cwd: process.cwd(),
      timeout: 600_000,
      shell: true,
      env: { ...process.env, ...extraEnv },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString('utf8')));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')));
    child.on('error', (err) => reject(new Error(`${cmd} failed to spawn: ${err.message}`)));
    child.on('close', (status) => {
      if (status !== 0) reject(new Error(`${cmd} exited ${status}\n${stderr}`));
      else resolve(stdout);
    });
  });
}

export function cdk(args: string[], extraEnv: Record<string, string> = {}): Promise<string> {
  // The --app value "tsx bin/bootstrap.ts" contains a space; under
  // shell:true it would split into two tokens. Quote it so CDK receives the
  // full string as one argument.
  const quoted = args.map((a) => (a.includes(' ') ? `"${a}"` : a)).join(' ');
  return run(`pnpm --filter @deployz/cdk exec cdk ${quoted}`, extraEnv);
}

export function awsCli(args: string, region: string = REGION): Promise<string> {
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
