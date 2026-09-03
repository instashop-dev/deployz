/**
 * Region parameterization for the integration suite.
 *
 * The suite is region-parameterized: spot-check a small subset of regions now
 * (todo 14), expand to all 17 allowed regions in todo 33 (§32 — "every
 * supported region passes the same deployment test suite").
 *
 * Region values come from `SUPPORTED_AWS_REGIONS` in `@deployz/contracts` —
 * the canonical §32 allowlist (17 regions), kept in parity with
 * `packages/db/src/enums.ts` `regionEnum`.
 */

import { SUPPORTED_AWS_REGIONS } from '@deployz/contracts';

/**
 * Spot-check regions for the current run — 3 regions spanning the major
 * partitions (US-East primary, Europe, Asia-Pacific). todo 33 expands to
 * `allRegions()` (the full 17).
 */
export const SPOT_REGIONS = [
  'us-east-1',
  'eu-west-1',
  'ap-southeast-1',
] as const;

export type SpotRegion = (typeof SPOT_REGIONS)[number];

/**
 * The spot-check subset for the current run. Returns a fresh array so callers
 * cannot mutate the constant.
 */
export function spotRegions(): readonly string[] {
  return [...SPOT_REGIONS];
}

/**
 * The full §32 allowlist (all 17 regions). Used by todo 33's all-17 CI run.
 */
export function allRegions(): readonly string[] {
  return [...SUPPORTED_AWS_REGIONS];
}
