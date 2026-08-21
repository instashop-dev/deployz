/**
 * §32 17-region enforcement — the allowlist gate at install creation.
 *
 * This module provides the install-creation rejection logic: when a vendor
 * tries to create a deployment in a non-allowlisted region, the API rejects
 * it with a clear message. Opt-in regions (not in the 17) get a hard
 * rejection — no enablement guides (S2).
 *
 * The all-17 CI suite that runs the full deployment test suite across all
 * 17 regions is PENDING-AWS (no credentials).
 */

import { ALLOWED_REGIONS } from './preflight.js';

// ── Result type ───────────────────────────────────────────────────────────

/** A successful region validation — the region is in the §32 allowlist. */
export interface RegionAllowed {
  readonly allowed: true;
}

/** A failed region validation — the region is NOT in the §32 allowlist. */
export interface RegionRejected {
  readonly allowed: false;
  /** Clear rejection message. Does NOT include enablement guides (S2). */
  readonly message: string;
}

export type RegionValidationResult = RegionAllowed | RegionRejected;

// ── Enforcement ───────────────────────────────────────────────────────────

/**
 * Validate that a region is in the §32 17-region allowlist for install
 * creation.
 *
 * Returns `{ allowed: true }` for any of the 17 allowed regions, or
 * `{ allowed: false, message }` with a clear rejection message for
 * non-allowlisted regions (including opt-in regions).
 *
 * S2: the rejection message is a hard "not supported, choose from this
 * list" — it does NOT include enablement guides (no "enable", "opt-in",
 * "request access", "contact support", "how to add", or "coming soon").
 */
export function validateRegionForInstall(region: string): RegionValidationResult {
  if ((ALLOWED_REGIONS as readonly string[]).includes(region)) {
    return { allowed: true };
  }

  const list = ALLOWED_REGIONS.join(', ');

  return {
    allowed: false,
    message:
      `Region "${region}" is not currently supported. ` +
      `Deployz supports 17 regions: ${list}. ` +
      `Choose one of these regions.`,
  };
}