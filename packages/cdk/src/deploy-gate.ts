/**
 * Decides whether the control-plane CDK app is allowed to run at all.
 *
 * A `cdk deploy Deployz` from a developer machine rebuilds the Lambda
 * environment out of that machine's `.env`: `collectEnvVars()` in
 * deployz-stack.ts REPLACES the deployed environment rather than merging with
 * it, so local values overwrite production and — worse — every allowlisted key
 * the local `.env` happens to lack is deleted from the running function. With
 * API_DOMAIN_NAME among the missing, the api.deployz.dev mapping goes with it.
 *
 * Pure and separate from bin/deployz.ts on purpose: the entrypoint can only be
 * exercised by spawning the CDK CLI, while this can be unit-tested directly.
 */

export interface DeployGateInput {
  /** Process environment to judge. Injected rather than read so it is testable. */
  readonly env: Record<string, string | undefined>;
  /** The `local` CDK context flag — an explicit opt-in for synth and diff. */
  readonly allowLocal: boolean;
}

export type DeployGateResult = { readonly allowed: true } | { readonly allowed: false; readonly reason: string };

/**
 * The refusal text. Exported so the entrypoint and its tests agree on it, and
 * written to teach rather than merely deny: whoever hits this was following
 * the README, which used to document the hand-run deploy as the normal path.
 */
export const DEPLOY_GATE_REFUSAL = [
  'Refusing to run the Deployz control-plane app outside CI.',
  '',
  'Production deploys go through .github/workflows/deploy-api.yml — push to',
  'main, or run it from the Actions tab. A deploy from a developer machine',
  'rebuilds the Lambda environment from the local .env: it ships localhost',
  'origins and DELETES every key the .env does not carry.',
  '',
  'To synth or diff locally:  cdk diff -c local=true',
].join('\n');

/**
 * Allowed on a GitHub Actions runner, or on an explicit local opt-in.
 *
 * The marker is GITHUB_ACTIONS rather than CI because `CI=true` is set by a
 * wide range of local tooling and would quietly open the gate on exactly the
 * machines it is meant to close it on. A GitHub runner is the only thing that
 * sets GITHUB_ACTIONS.
 */
export function checkDeployGate({ env, allowLocal }: DeployGateInput): DeployGateResult {
  if (env.GITHUB_ACTIONS === 'true' || allowLocal) {
    return { allowed: true };
  }
  return { allowed: false, reason: DEPLOY_GATE_REFUSAL };
}
