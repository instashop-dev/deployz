/**
 * Relay identity — what the relay reports about itself at enrollment and on
 * every heartbeat, so the control plane can gate UI actions on what the
 * installed relay can actually execute.
 */

import type { RelayCapabilities, RelayIdentity } from '@deployz/contracts';

/**
 * Bumped with each relay release. Drives capability gating and rollout
 * verification ("confirm relayVersion after updating deployz-bootstrap");
 * the relay bundle carries no package metadata at runtime, so this constant
 * is the version.
 */
export const RELAY_VERSION = '0.2.0';

/**
 * What this relay build can execute. Flips to true per capability as the
 * real executors land; until then the dashboard must not offer the action.
 */
export const RELAY_CAPABILITIES: RelayCapabilities = {
  deployRelease: true,
  rollback: true,
  restart: true,
  configUpdate: false,
  destroy: true,
  domainManagement: true,
};

/** Extracts the account id from a Lambda ARN (arn:aws:lambda:REGION:ACCOUNT:...). */
export function accountIdFromArn(arn: string): string | null {
  const parts = arn.split(':');
  return /^\d{12}$/.test(parts[4] ?? '') ? parts[4]! : null;
}

/**
 * The identity to report this invocation. Outside Lambda (local runs, unit
 * tests) the account id and region are absent — reporting nothing is more
 * honest than reporting a guess.
 */
export function readRelayIdentity(context?: {
  invokedFunctionArn?: string;
}): Partial<RelayIdentity> {
  const identity: Partial<RelayIdentity> = {
    relayVersion: RELAY_VERSION,
    bootstrapVersion: process.env['DEPLOYZ_BOOTSTRAP_VERSION'] ?? null,
    capabilities: RELAY_CAPABILITIES,
  };
  const accountId = context?.invokedFunctionArn
    ? accountIdFromArn(context.invokedFunctionArn)
    : null;
  if (accountId) identity.awsAccountId = accountId;
  if (process.env['AWS_REGION']) identity.region = process.env['AWS_REGION'];
  return identity;
}
