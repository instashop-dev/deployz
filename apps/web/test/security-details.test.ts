import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  DENIED_LOG_READ_ACTIONS,
  PASS_ROLE_RESOURCE_ARN,
  PASSED_TO_SERVICE,
  PHASE_1_LOG_WRITE_ACTIONS,
  PHASE_1_SECRET_ACTIONS,
  PHASE_2_APP_RESOURCE_ACTIONS,
  PHASE_2_CREATE_STACK_ACTIONS,
  PHASE_2_MANAGE_STACK_ACTIONS,
  PHASE_2_PASS_ROLE_ACTION,
  REQUEST_TAG_CONDITION,
  RESOURCE_TAG_CONDITION,
  TAG_BOUNDARY_KEY,
} from '../src/lib/security-details';

// §45 copy-truthfulness lock: the Security Details page renders its
// permission claims from src/lib/security-details.ts, and this test reads the
// ACTUAL policy statements in packages/cdk/src/bootstrap/bootstrap-stack.ts
// (the template the customer deploys) and asserts the two can never drift.
// If the bootstrap stack's permissions change, this test fails until the
// trust story is updated to match.

const BOOTSTRAP_STACK_PATH = fileURLToPath(
  new URL('../../../packages/cdk/src/bootstrap/bootstrap-stack.ts', import.meta.url),
);
const source = readFileSync(BOOTSTRAP_STACK_PATH, 'utf8');

/** Extracts a `const NAME = [ 'a', 'b' ] as const;` action list from the source. */
function extractActions(name: string): string[] {
  const match = source.match(new RegExp(`const ${name} = \\[([\\s\\S]*?)\\] as const;`));
  if (!match) {
    throw new Error(`${name} not found in bootstrap-stack.ts — has the source moved?`);
  }
  return [...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

describe('security-details ↔ bootstrap-stack truthfulness', () => {
  it('phase 1 log-write actions match the bootstrap stack exactly', () => {
    expect([...PHASE_1_LOG_WRITE_ACTIONS]).toEqual(extractActions('PHASE_1_LOG_WRITE_ACTIONS'));
  });

  it('phase 1 credential-secret actions match the bootstrap stack exactly', () => {
    expect([...PHASE_1_SECRET_ACTIONS]).toEqual(extractActions('PHASE_1_SECRET_ACTIONS'));
  });

  it('phase 2 create/update actions match the bootstrap stack exactly', () => {
    expect([...PHASE_2_CREATE_STACK_ACTIONS]).toEqual(extractActions('PHASE_2_CREATE_STACK_ACTIONS'));
  });

  it('phase 2 manage/delete actions match the bootstrap stack exactly', () => {
    expect([...PHASE_2_MANAGE_STACK_ACTIONS]).toEqual(extractActions('PHASE_2_MANAGE_STACK_ACTIONS'));
  });

  it('phase 2 application-resource actions match the bootstrap stack exactly', () => {
    expect([...PHASE_2_APP_RESOURCE_ACTIONS]).toEqual(
      extractActions('PHASE_2_APP_RESOURCE_ACTIONS'),
    );
  });

  it('pass-role disclosure matches the bootstrap stack (action, ARN, service)', () => {
    expect(source).toContain(`'${PHASE_2_PASS_ROLE_ACTION}'`);
    expect(source).toContain(`'${PASS_ROLE_RESOURCE_ARN}'`);
    expect(source).toContain(`'iam:PassedToService': '${PASSED_TO_SERVICE}'`);
  });

  it('tag-boundary condition keys match the bootstrap stack', () => {
    expect(source).toContain(`'${REQUEST_TAG_CONDITION}'`);
    expect(source).toContain(`'${RESOURCE_TAG_CONDITION}'`);
    expect(TAG_BOUNDARY_KEY).toBe('deployz:installation');
    expect(source).toContain(`'${TAG_BOUNDARY_KEY}'`);
  });

  it('denied log-read actions are granted NOWHERE in the bootstrap stack (§16)', () => {
    const granted = [
      ...extractActions('PHASE_1_LOG_WRITE_ACTIONS'),
      ...extractActions('PHASE_1_SECRET_ACTIONS'),
      ...extractActions('PHASE_2_CREATE_STACK_ACTIONS'),
      ...extractActions('PHASE_2_MANAGE_STACK_ACTIONS'),
      ...extractActions('PHASE_2_APP_RESOURCE_ACTIONS'),
    ];
    for (const denied of DENIED_LOG_READ_ACTIONS) {
      expect(granted).not.toContain(denied);
    }
  });

  it('two-phase design markers exist in the bootstrap stack (boundary + unattached provisioner)', () => {
    // The page claims: a permissions-boundary ceiling fixed at install time,
    // and a phase-2 provisioner policy defined but not attached at install.
    expect(source).toContain('permissionsBoundary');
    expect(source).toContain('ProvisionerPolicy');
  });
});
