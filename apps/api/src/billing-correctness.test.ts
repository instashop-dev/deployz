import { describe, expect, it } from 'vitest';

import { shouldBillForDeployment } from './billing-correctness.js';

// ── shouldBillForDeployment ──────────────────────────────────────────────

describe('shouldBillForDeployment', () => {
  it('HEALTHY + non-test deployment is billable', () => {
    expect(shouldBillForDeployment({ state: 'HEALTHY', isTestDeployment: false })).toBe(true);
  });

  it('UPDATE_AVAILABLE + non-test deployment is billable (a newer release existing does not stop billing)', () => {
    expect(shouldBillForDeployment({ state: 'UPDATE_AVAILABLE', isTestDeployment: false })).toBe(
      true,
    );
  });

  it('HEALTHY + test deployment is NOT billable', () => {
    expect(shouldBillForDeployment({ state: 'HEALTHY', isTestDeployment: true })).toBe(false);
  });

  it('UPDATE_AVAILABLE + test deployment is NOT billable', () => {
    expect(shouldBillForDeployment({ state: 'UPDATE_AVAILABLE', isTestDeployment: true })).toBe(
      false,
    );
  });

  it.each([
    'NOT_INSTALLED',
    'INSTALLING',
    'UPDATING',
    'FAILED',
    'DISCONNECTED',
    'DELETING',
    'DELETED',
  ])('non-HEALTHY/UPDATE_AVAILABLE state %s is NOT billable', (state) => {
    expect(shouldBillForDeployment({ state, isTestDeployment: false })).toBe(false);
  });
});
