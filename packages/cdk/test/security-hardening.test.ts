/**
 * Security hardening test suite â€” proves the security invariants hold.
 *
 * Two proof areas:
 *   1. Token rotation â€” the relay's grace-window rotation (packages/relay/src/auth.ts)
 *   2. Permissions boundary â€” the bootstrap stack's two-phase IAM ceiling
 */

import { describe, expect, it } from 'vitest';
import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { BootstrapStack } from '../src/bootstrap/bootstrap-stack.js';

import {
  buildAuthHeaders,
  createAuthState,
  decrementGrace,
  processRotationResponse,
  TOKEN_ROTATION_GRACE_POLLS,
} from '@deployz/relay/auth';

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// 1. Token rotation proof
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

describe('Security: token rotation', () => {
  it('accepts old token during grace window (TOKEN_ROTATION_GRACE_POLLS = 3)', () => {
    const state = createAuthState('inst-1', 'tok-v1');

    // Rotation triggered.
    processRotationResponse(state, 'tok-v2');
    expect(state.token).toBe('tok-v2');
    expect(state.oldToken).toBe('tok-v1');
    expect(state.gracePollsRemaining).toBe(TOKEN_ROTATION_GRACE_POLLS);

    // During grace: both tokens in headers (old token accepted).
    for (let i = 0; i < TOKEN_ROTATION_GRACE_POLLS; i++) {
      const headers = buildAuthHeaders(state);
      expect(headers.Authorization).toBe('Bearer tok-v2');
      expect(headers['X-Deployz-Old-Token']).toBe('tok-v1');
      decrementGrace(state);
    }
  });

  it('rejects old token after grace expires', () => {
    const state = createAuthState('inst-1', 'tok-v1');
    processRotationResponse(state, 'tok-v2');

    // Exhaust grace.
    for (let i = 0; i < TOKEN_ROTATION_GRACE_POLLS; i++) {
      decrementGrace(state);
    }

    // After grace: old token discarded.
    expect(state.gracePollsRemaining).toBe(0);
    expect(state.oldToken).toBeUndefined();

    const headers = buildAuthHeaders(state);
    expect(headers.Authorization).toBe('Bearer tok-v2');
    expect(headers['X-Deployz-Old-Token']).toBeUndefined();
  });

  it('new token always accepted', () => {
    const state = createAuthState('inst-1', 'tok-v1');
    processRotationResponse(state, 'tok-v2');

    // New token is the current token.
    expect(state.token).toBe('tok-v2');

    // Headers always carry the new token as Authorization.
    const headers = buildAuthHeaders(state);
    expect(headers.Authorization).toBe('Bearer tok-v2');
  });

  it('double rotation during grace collapses correctly', () => {
    const state = createAuthState('inst-1', 'tok-v1');
    processRotationResponse(state, 'tok-v2');
    expect(state.token).toBe('tok-v2');
    expect(state.oldToken).toBe('tok-v1');
    expect(state.gracePollsRemaining).toBe(TOKEN_ROTATION_GRACE_POLLS);

    // Second rotation arrives before grace expires.
    processRotationResponse(state, 'tok-v3');

    // v1 discarded, v2 becomes old, v3 becomes current, grace resets.
    expect(state.token).toBe('tok-v3');
    expect(state.oldToken).toBe('tok-v2');
    expect(state.gracePollsRemaining).toBe(TOKEN_ROTATION_GRACE_POLLS);

    // Headers carry v3 as Authorization, v2 as old token.
    const headers = buildAuthHeaders(state);
    expect(headers.Authorization).toBe('Bearer tok-v3');
    expect(headers['X-Deployz-Old-Token']).toBe('tok-v2');
  });

  it('decrementGrace is idempotent at zero', () => {
    const state = createAuthState('inst-1', 'tok-v1');
    processRotationResponse(state, 'tok-v2');

    // Exhaust grace.
    for (let i = 0; i < TOKEN_ROTATION_GRACE_POLLS; i++) {
      decrementGrace(state);
    }
    expect(state.gracePollsRemaining).toBe(0);
    expect(state.oldToken).toBeUndefined();

    // Extra decrements are no-ops.
    decrementGrace(state);
    expect(state.gracePollsRemaining).toBe(0);
    expect(state.oldToken).toBeUndefined();
  });
});

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// 2. Permissions-boundary verification
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

type TemplateResource = { Type: string; Properties?: Record<string, unknown> };

function allResources(template: Template): Record<string, TemplateResource> {
  return (template.toJSON() as { Resources: Record<string, TemplateResource> })['Resources'];
}

function collectActions(statements: unknown): string[] {
  const out: string[] = [];
  for (const stmt of (statements as Array<Record<string, unknown>>) ?? []) {
    for (const key of ['Action', 'NotAction']) {
      const value = stmt?.[key];
      if (typeof value === 'string') {
        out.push(value);
      } else if (Array.isArray(value)) {
        for (const item of value) {
          if (typeof item === 'string') out.push(item);
        }
      }
    }
  }
  return out;
}

function synth() {
  const app = new App();
  const stack = new BootstrapStack(app, 'SecurityTest');
  const template = Template.fromStack(stack);
  return { app, stack, template };
}

describe('Security: permissions boundary', () => {
  it('the relay role has a permissions boundary set', () => {
    const { stack } = synth();
    expect(stack.relayRole.permissionsBoundary).toBeDefined();
    const resources = allResources(Template.fromStack(stack));
    const relayRole = Object.values(resources).find(
      (r) => r.Type === 'AWS::IAM::Role' && r.Properties?.['PermissionsBoundary'],
    );
    expect(relayRole).toBeDefined();
  });

  it('the boundary is the UNION of phase 1 + phase 2', () => {
    const { stack } = synth();
    const boundaryActions = collectActions(
      stack.permissionsBoundary.document.toJSON()['Statement'],
    );

    // Phase 1 actions must be in the boundary.
    expect(boundaryActions).toContain('logs:CreateLogGroup');
    expect(boundaryActions).toContain('logs:CreateLogStream');
    expect(boundaryActions).toContain('logs:PutLogEvents');
    expect(boundaryActions).toContain('secretsmanager:GetSecretValue');
    expect(boundaryActions).toContain('secretsmanager:PutSecretValue');

    // Phase 2 actions must be in the boundary.
    expect(boundaryActions).toContain('cloudformation:CreateStack');
    expect(boundaryActions).toContain('cloudformation:DeleteStack');
    expect(boundaryActions).toContain('ecs:UpdateService');
    expect(boundaryActions).toContain('rds:ModifyDBInstance');
    expect(boundaryActions).toContain('iam:PassRole');
  });

  it('the provisioner policy is attached, and capped by the boundary', () => {
    const { stack } = synth();
    const resources = allResources(Template.fromStack(stack));
    const relayRole = Object.values(resources).find(
      (r) => r.Type === 'AWS::IAM::Role' && r.Properties?.['PermissionsBoundary'],
    );

    // The provisioner policy exists as a standalone ManagedPolicy.
    expect(stack.provisionerPolicy).toBeDefined();

    // And it is attached to the relay role. This test used to assert the
    // opposite, on the two-phase theory that the control plane would attach
    // it after the relay's first contact. Nothing can: Â§15 forbids Deployz
    // from holding credentials in the customer's account, so no principal
    // exists that could make the call â€” which left the relay permanently
    // unable to call cloudformation:CreateStack. The security property that
    // matters is not the delay, it is the ceiling: the role still carries
    // the permissions boundary, asserted below and in the next test.
    expect(relayRole?.Properties?.['ManagedPolicyArns']).toBeDefined();
    expect(relayRole?.Properties?.['PermissionsBoundary']).toBeDefined();
  });

  it('the boundary caps the relay role forever (phase 2 cannot exceed it)', () => {
    const { stack } = synth();
    const boundaryActions = new Set(
      collectActions(stack.permissionsBoundary.document.toJSON()['Statement']),
    );
    const provisionerActions = collectActions(
      stack.provisionerPolicy.document.toJSON()['Statement'],
    );

    // Every provisioner action must be within the boundary.
    for (const action of provisionerActions) {
      expect(
        boundaryActions.has(action),
        `provisioner action ${action} must be within the permissions boundary`,
      ).toBe(true);
    }
  });

  it('phase-2 actions are constrained by the deployz: tag boundary', () => {
    const { stack } = synth();
    const statements = stack.provisionerPolicy.document.toJSON()[
      'Statement'
    ] as Array<Record<string, unknown>>;

    const conditions = statements.flatMap((s) => {
      const cond = s['Condition'] as Record<string, Record<string, string>> | undefined;
      return cond ? Object.values(cond).map((c) => Object.keys(c)) : [];
    });

    const flatKeys = conditions.flat();
    expect(flatKeys).toContain('aws:RequestTag/deployz:installation');
    expect(flatKeys).toContain('aws:ResourceTag/deployz:installation');
    expect(flatKeys).toContain('iam:PassedToService');
  });

  it('DENIES log read (Â§16 data boundary) across the entire template', () => {
    const { stack, template } = synth();

    // Check the relay role's own grants.
    const resources = allResources(template);
    let relayLogicalId: string | undefined;
    for (const [logicalId, resource] of Object.entries(resources)) {
      if (resource.Type === 'AWS::IAM::Role' && resource.Properties?.['PermissionsBoundary']) {
        relayLogicalId = logicalId;
        break;
      }
    }
    expect(relayLogicalId).toBeDefined();

    const relayActions: string[] = [];
    for (const resource of Object.values(resources)) {
      if (resource.Type !== 'AWS::IAM::Policy') continue;
      const roles = (resource.Properties?.['Roles'] as Array<{ Ref?: string }>) ?? [];
      const referencesRelay = roles.some((r) => r?.['Ref'] === relayLogicalId);
      if (referencesRelay) {
        relayActions.push(
          ...collectActions(
            (resource.Properties?.['PolicyDocument'] as Record<string, unknown>)?.['Statement'],
          ),
        );
      }
    }

    // Check the boundary.
    const boundaryActions = collectActions(
      stack.permissionsBoundary.document.toJSON()['Statement'],
    );

    // Check the provisioner.
    const provisionerActions = collectActions(
      stack.provisionerPolicy.document.toJSON()['Statement'],
    );

    for (const actions of [relayActions, boundaryActions, provisionerActions]) {
      expect(actions).not.toContain('logs:GetLogEvents');
      expect(actions).not.toContain('logs:FilterLogEvents');
    }

    // Strongest form: NO IAM policy anywhere in the template grants log read.
    function allIamActions(t: Template): string[] {
      const res = allResources(t);
      const out: string[] = [];
      for (const resource of Object.values(res)) {
        const type = resource.Type;
        const props = resource.Properties ?? {};
        if (type === 'AWS::IAM::Role') {
          for (const p of (props['Policies'] as Array<Record<string, unknown>>) ?? []) {
            out.push(
              ...collectActions(
                (p['PolicyDocument'] as Record<string, unknown>)?.['Statement'],
              ),
            );
          }
        }
        if (type === 'AWS::IAM::Policy' || type === 'AWS::IAM::ManagedPolicy') {
          out.push(
            ...collectActions(
              (props['PolicyDocument'] as Record<string, unknown>)?.['Statement'],
            ),
          );
        }
      }
      return out;
    }

    const all = allIamActions(template);
    expect(all).not.toContain('logs:GetLogEvents');
    expect(all).not.toContain('logs:FilterLogEvents');
  });
});

