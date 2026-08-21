import { describe, expect, it } from 'vitest';

import { regionEnum } from '@deployz/db';

import { ALLOWED_REGIONS } from '../src/jobs/preflight.js';
import {
  validateRegionForInstall,
  type RegionValidationResult,
} from '../src/jobs/region-enforcement.js';

// ── Allowlist pass ───────────────────────────────────────────────────────

describe('validateRegionForInstall', () => {
  describe('allowlist pass', () => {
    it('accepts every one of the 17 allowed regions', () => {
      for (const region of ALLOWED_REGIONS) {
        const result = validateRegionForInstall(region);
        expect(result.allowed).toBe(true);
      }
    });

    it('returns exactly { allowed: true } with no extra properties', () => {
      const result = validateRegionForInstall('us-east-1');
      expect(result).toEqual({ allowed: true });
    });
  });

  // ── Opt-in region rejection ────────────────────────────────────────────

  describe('opt-in region rejection', () => {
    it('rejects me-south-1 (opt-in region)', () => {
      const result = validateRegionForInstall('me-south-1');
      expect(result.allowed).toBe(false);
      if (!result.allowed) {
        expect(result.message).toContain('me-south-1');
        expect(result.message).toContain('not currently supported');
        expect(result.message).toContain('17 regions');
      }
    });

    it('rejects af-south-1 (opt-in region)', () => {
      const result = validateRegionForInstall('af-south-1');
      expect(result.allowed).toBe(false);
      if (!result.allowed) {
        expect(result.message).toContain('af-south-1');
      }
    });

    it('rejects ap-southeast-3 (opt-in region)', () => {
      const result = validateRegionForInstall('ap-southeast-3');
      expect(result.allowed).toBe(false);
      if (!result.allowed) {
        expect(result.message).toContain('ap-southeast-3');
      }
    });

    it('rejects eu-south-1 (opt-in region)', () => {
      const result = validateRegionForInstall('eu-south-1');
      expect(result.allowed).toBe(false);
    });

    it('rejects a completely made-up region', () => {
      const result = validateRegionForInstall('moon-1');
      expect(result.allowed).toBe(false);
      if (!result.allowed) {
        expect(result.message).toContain('moon-1');
      }
    });
  });

  // ── S2 guard: no enablement guides ─────────────────────────────────────

  describe('S2 guard — no enablement guides', () => {
    const ENABLEMENT_WORDS = [
      'enable',
      'opt-in',
      'request access',
      'contact support to enable',
      'how to add',
      'coming soon',
    ];

    it('rejection message contains none of the forbidden enablement-guide language', () => {
      const result = validateRegionForInstall('me-south-1');
      expect(result.allowed).toBe(false);
      if (!result.allowed) {
        const msg = result.message.toLowerCase();
        for (const word of ENABLEMENT_WORDS) {
          expect(msg).not.toContain(word);
        }
      }
    });

    it('rejection message is a hard "not supported, choose from this list"', () => {
      const result = validateRegionForInstall('af-south-1');
      expect(result.allowed).toBe(false);
      if (!result.allowed) {
        expect(result.message).toContain('not currently supported');
        expect(result.message).toContain('Choose one of these regions');
      }
    });

    it('rejection message lists all 17 regions', () => {
      const result = validateRegionForInstall('me-south-1');
      expect(result.allowed).toBe(false);
      if (!result.allowed) {
        for (const region of ALLOWED_REGIONS) {
          expect(result.message).toContain(region);
        }
      }
    });
  });

  // ── Parity with preflight.ts ────────────────────────────────────────────

  describe('parity with preflight.ts ALLOWED_REGIONS', () => {
    it('uses the same ALLOWED_REGIONS constant as preflight.ts', () => {
      // The 17-region list is exactly the ALLOWED_REGIONS constant.
      // We verify by checking that every region in ALLOWED_REGIONS passes
      // and that the count is 17.
      expect(ALLOWED_REGIONS).toHaveLength(17);

      let passCount = 0;
      for (const region of ALLOWED_REGIONS) {
        if (validateRegionForInstall(region).allowed) {
          passCount++;
        }
      }
      expect(passCount).toBe(17);
    });

    it('ALLOWED_REGIONS matches regionEnum.enumValues (sorted)', () => {
      expect([...ALLOWED_REGIONS].sort()).toEqual(
        [...regionEnum.enumValues].sort(),
      );
    });

    it('regionEnum has exactly 17 values', () => {
      expect(regionEnum.enumValues).toHaveLength(17);
    });
  });

  // ── Type narrowing ─────────────────────────────────────────────────────

  describe('type narrowing', () => {
    it('discriminated union narrows correctly on allowed: true', () => {
      const result: RegionValidationResult = validateRegionForInstall('us-east-1');
      if (result.allowed) {
        // TypeScript narrows to RegionAllowed — no `message` property.
        // This is a compile-time check; at runtime we just verify shape.
        expect('message' in result).toBe(false);
      }
    });

    it('discriminated union narrows correctly on allowed: false', () => {
      const result: RegionValidationResult = validateRegionForInstall('me-south-1');
      if (!result.allowed) {
        // TypeScript narrows to RegionRejected — `message` is required.
        expect(typeof result.message).toBe('string');
        expect(result.message.length).toBeGreaterThan(0);
      }
    });
  });
});