import { describe, it, expect } from 'vitest';
import { checkDeployGate } from '../src/deploy-gate.js';

describe('checkDeployGate', () => {
  it('refuses an environment with no CI marker', () => {
    const result = checkDeployGate({ env: {}, allowLocal: false });

    expect(result.allowed).toBe(false);
  });

  // The near-miss that matters. CI=true is set by a wide range of local
  // tooling, so gating on it would quietly open the gate on a developer
  // machine — which is the exact thing this gate exists to close.
  it('refuses CI=true without GITHUB_ACTIONS', () => {
    const result = checkDeployGate({ env: { CI: 'true' }, allowLocal: false });

    expect(result.allowed).toBe(false);
  });

  it('allows a GitHub Actions runner', () => {
    const result = checkDeployGate({ env: { GITHUB_ACTIONS: 'true' }, allowLocal: false });

    expect(result.allowed).toBe(true);
  });

  it('allows a local run that opted in explicitly', () => {
    const result = checkDeployGate({ env: {}, allowLocal: true });

    expect(result.allowed).toBe(true);
  });

  // The person reading this message was, until this change, following the
  // README — so it has to say where deploys live now and how to keep synth
  // and diff working, not just "no".
  it('names the workflow and the opt-in flag when it refuses', () => {
    const result = checkDeployGate({ env: {}, allowLocal: false });

    expect(result.allowed).toBe(false);
    if (result.allowed) return;
    expect(result.reason).toContain('deploy-api.yml');
    expect(result.reason).toContain('-c local=true');
  });
});
