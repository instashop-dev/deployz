/**
 * Shared shell-out helpers for the live-AWS vitest suites (fresh —
 * docs/testing/simulated-e2e.md D5).
 *
 * fresh-e2e.live.test.ts reuses the `cdk`/`aws` invocation pattern this file
 * carries instead of forking it. The read-only persistent-installation
 * canary and the throwaway golden-path suite this file used to also serve
 * were retired (docs/testing/aws-e2e.md's `profile`/`core`
 * scenarios and `pnpm e2e:fresh` cover the same ground for real).
 *
 * Not a `.test.ts` file — vitest will not try to run it as a suite.
 */
import { spawn } from 'node:child_process';

export const REGION = process.env.AWS_REGION ?? 'us-east-1';

/**
 * The test AWS account every real-AWS suite in this repo refuses to run
 * outside of — the same default `scripts/version-canary/config.ts` uses
 * (`DEPLOYZ_CANARY_EXPECTED_ACCOUNT`).
 */
export const DEFAULT_EXPECTED_ACCOUNT = '151955775369';

export function expectedAccountId(env: NodeJS.ProcessEnv = process.env): string {
  return env['DEPLOYZ_CANARY_EXPECTED_ACCOUNT'] ?? DEFAULT_EXPECTED_ACCOUNT;
}

/**
 * Throws unless `account` is the expected test account — the same guard
 * `scripts/version-canary/steps.ts`'s `preflight` applies before the version
 * canary runs anything. `fresh` and `scripts/customer-reset` apply it too:
 * neither had ever refused a real, differently-numbered AWS account before
 * mutating it.
 */
export function assertExpectedAccount(account: string | undefined, expected: string = expectedAccountId()): void {
  if (account !== expected) {
    throw new Error(
      `AWS account ${account ?? 'unknown'} is not the expected test account ${expected} — refusing to run`,
    );
  }
}

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
 * The mode+flag gate fresh (D3/D5) runs under: a real-AWS suite runs only
 * when `DEPLOYZ_E2E_MODE` matches its own mode AND
 * `DEPLOYZ_E2E_ALLOW_REAL_AWS === '1'`. `scripts/e2e.mjs` sets both before
 * spawning it (`pnpm e2e:fresh`); a direct `vitest run` must set them by
 * hand.
 */
export function isRealAwsModeActive(
  env: Pick<NodeJS.ProcessEnv, 'DEPLOYZ_E2E_MODE' | 'DEPLOYZ_E2E_ALLOW_REAL_AWS'>,
  mode: 'fresh',
): boolean {
  return env.DEPLOYZ_E2E_MODE === mode && env.DEPLOYZ_E2E_ALLOW_REAL_AWS === '1';
}
