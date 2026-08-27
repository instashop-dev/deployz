/**
 * Security hardening test suite — proves the security invariants hold.
 *
 * Four proof areas:
 *   1. Token rotation — the relay's grace-window rotation (packages/relay/src/auth.ts)
 *   2. Permissions boundary — the bootstrap stack's two-phase IAM ceiling
 *   3. Revocation flow — DESTROY workflow's degraded path + ECR revoke
 *   4. Secrets write-through — CONFIG_UPDATE never leaks plaintext secrets
 */

import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { BootstrapStack } from '../src/bootstrap/bootstrap-stack.js';

import {
  DurableRuntime,
  InMemoryStateStore,
  type DurableWorkflow,
} from '../src/durable/durable-runtime.js';

import {
  EventEmitter,
  InMemoryEventStore,
} from '../src/jobs/event-emitter.js';

import {
  InMemoryDeploymentStateStore,
} from '../src/jobs/install-workflow.js';

import {
  createDestroyWorkflow,
  DESTROY_COPY,
  type DestroyInput,
  type DestroyOutput,
  type ResourceDestroyResult,
  type DatabaseDestroyResult,
  type StorageDestroyResult,
  type EcrRevokeResult,
  type BillingStopResult,
} from '../src/jobs/destroy-workflow.js';

import {
  createConfigUpdateWorkflow,
  maskSecrets,
  SECRET_MASK,
  validateConfigKeys,
  type ConfigEntry,
  type ConfigUpdateInput,
  type ConfigUpdateOutput,
  type ConfigValidationResult,
  type ConfigWriteResult,
} from '../src/jobs/config-update-workflow.js';

// ── Token rotation imports (from @deployz/relay) ─────────────────────────

import {
  buildAuthHeaders,
  createAuthState,
  decrementGrace,
  processRotationResponse,
  TOKEN_ROTATION_GRACE_POLLS,
} from '@deployz/relay/auth';

// ═══════════════════════════════════════════════════════════════════════════
// 1. Token rotation proof
// ═══════════════════════════════════════════════════════════════════════════

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

// ═══════════════════════════════════════════════════════════════════════════
// 2. Permissions-boundary verification
// ═══════════════════════════════════════════════════════════════════════════

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
    // it after the relay's first contact. Nothing can: §15 forbids Deployz
    // from holding credentials in the customer's account, so no principal
    // exists that could make the call — which left the relay permanently
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

  it('DENIES log read (§16 data boundary) across the entire template', () => {
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

// ═══════════════════════════════════════════════════════════════════════════
// 3. Revocation flow
// ═══════════════════════════════════════════════════════════════════════════

const FIXED_NOW = new Date('2026-08-20T00:00:00.000Z');

function makeDestroyInput(overrides: Partial<DestroyInput> = {}): DestroyInput {
  return {
    deploymentId: 'deployment-1',
    customerId: 'customer-1',
    organizationId: 'org-1',
    jobId: 'job-1',
    installationId: 'install-1',
    finalSnapshot: true,
    ...overrides,
  };
}

interface DestroyHarness {
  workflow: DurableWorkflow<DestroyInput, DestroyOutput>;
  runtime: DurableRuntime;
  eventStore: InMemoryEventStore;
  deploymentStore: InMemoryDeploymentStateStore;
  resourceDestroyer: Mock<() => Promise<ResourceDestroyResult>>;
  databaseDestroyer: Mock<() => Promise<DatabaseDestroyResult>>;
  storageDestroyer: Mock<() => Promise<StorageDestroyResult>>;
  ecrGrantRevoker: Mock<() => Promise<EcrRevokeResult>>;
  billingStopper: Mock<() => Promise<BillingStopResult>>;
}

function makeDestroyHarness(config: {
  resourceResult?: ResourceDestroyResult;
  databaseResult?: DatabaseDestroyResult;
  storageResult?: StorageDestroyResult;
  ecrResult?: EcrRevokeResult;
  billingResult?: BillingStopResult;
} = {}): DestroyHarness {
  const eventStore = new InMemoryEventStore();
  const emitter = new EventEmitter(eventStore, () => FIXED_NOW);
  const deploymentStore = new InMemoryDeploymentStateStore();

  const resourceDestroyer = vi
    .fn<() => Promise<ResourceDestroyResult>>()
    .mockResolvedValue(config.resourceResult ?? { ok: true });

  const databaseDestroyer = vi
    .fn<() => Promise<DatabaseDestroyResult>>()
    .mockResolvedValue(config.databaseResult ?? { ok: true, snapshotTaken: true });

  const storageDestroyer = vi
    .fn<() => Promise<StorageDestroyResult>>()
    .mockResolvedValue(config.storageResult ?? { ok: true });

  const ecrGrantRevoker = vi
    .fn<() => Promise<EcrRevokeResult>>()
    .mockResolvedValue(config.ecrResult ?? { ok: true, removed: true });

  const billingStopper = vi
    .fn<() => Promise<BillingStopResult>>()
    .mockResolvedValue(config.billingResult ?? { ok: true });

  const workflow = createDestroyWorkflow({
    emitter,
    deploymentStore,
    resourceDestroyer: { destroyResources: resourceDestroyer },
    databaseDestroyer: { destroyDatabase: databaseDestroyer },
    storageDestroyer: { destroyStorage: storageDestroyer },
    ecrGrantRevoker: { revoke: ecrGrantRevoker },
    billingStopper: { stop: billingStopper },
  });

  const runtime = new DurableRuntime(new InMemoryStateStore());

  return {
    workflow,
    runtime,
    eventStore,
    deploymentStore,
    resourceDestroyer,
    databaseDestroyer,
    storageDestroyer,
    ecrGrantRevoker,
    billingStopper,
  };
}

/** Start the destroy workflow up to the confirmation callback, then resume. */
async function runDestroyToCompletion(
  harness: DestroyHarness,
  input: DestroyInput,
  executionId: string,
) {
  const suspended = await harness.runtime.start(harness.workflow, input, executionId);
  expect(suspended.status).toBe('WAITING_CALLBACK');
  return harness.runtime.resume(harness.workflow, executionId, { confirmed: true });
}

describe('Security: revocation flow', () => {
  let harness: DestroyHarness;

  beforeEach(() => {
    harness = makeDestroyHarness();
  });

  it('DESTROY workflow degraded path handles relay-disconnected', async () => {
    await harness.deploymentStore.set('deployment-1', 'DISCONNECTED');

    const input = makeDestroyInput();
    const completed = await runDestroyToCompletion(harness, input, 'exec-degraded-1');

    expect(completed.status).toBe('COMPLETED');
    const output = completed.output as DestroyOutput;
    expect(output.degraded).toBe(true);
    expect(output.status).toBe('DELETED');

    // Customer-account resource destroyers were NEVER called.
    expect(harness.resourceDestroyer).not.toHaveBeenCalled();
    expect(harness.databaseDestroyer).not.toHaveBeenCalled();
    expect(harness.storageDestroyer).not.toHaveBeenCalled();
  });

  it('metadata cleanup + billing stop run even when relay is unreachable', async () => {
    await harness.deploymentStore.set('deployment-1', 'DISCONNECTED');

    const input = makeDestroyInput();
    await runDestroyToCompletion(harness, input, 'exec-degraded-2');

    // Billing stop was called (control-plane-side operation).
    expect(harness.billingStopper).toHaveBeenCalledTimes(1);
    expect(harness.billingStopper).toHaveBeenCalledWith('deployment-1');

    // Deployment is marked DELETED.
    const state = await harness.deploymentStore.get('deployment-1');
    expect(state).toBe('DELETED');
  });

  it('ECR pull grant is revoked even on the degraded path', async () => {
    await harness.deploymentStore.set('deployment-1', 'DISCONNECTED');

    const input = makeDestroyInput();
    await runDestroyToCompletion(harness, input, 'exec-degraded-3');

    // ECR revoke runs even when relay is disconnected (control plane owns ECR).
    expect(harness.ecrGrantRevoker).toHaveBeenCalledTimes(1);
    expect(harness.ecrGrantRevoker).toHaveBeenCalledWith('install-1');
  });

  it('degraded path emits disclosure event about manual cleanup', async () => {
    await harness.deploymentStore.set('deployment-1', 'DISCONNECTED');

    const input = makeDestroyInput();
    await runDestroyToCompletion(harness, input, 'exec-degraded-4');

    // The degraded disclosure event was emitted.
    const degradedEvent = harness.eventStore.events.find(
      (e) => e.eventType === 'destroy.degraded.resources',
    );
    expect(degradedEvent).toBeDefined();
    expect(degradedEvent?.payload).toHaveProperty(
      'reason',
      DESTROY_COPY.degradedRelayDisconnected,
    );
  });

  it('normal path destroys all resources and revokes ECR grant', async () => {
    await harness.deploymentStore.set('deployment-1', 'HEALTHY');

    const input = makeDestroyInput();
    const completed = await runDestroyToCompletion(harness, input, 'exec-normal-1');

    expect(completed.status).toBe('COMPLETED');
    const output = completed.output as DestroyOutput;
    expect(output.degraded).toBe(false);
    expect(output.status).toBe('DELETED');

    // All destroyers were called.
    expect(harness.resourceDestroyer).toHaveBeenCalledTimes(1);
    expect(harness.databaseDestroyer).toHaveBeenCalledTimes(1);
    expect(harness.storageDestroyer).toHaveBeenCalledTimes(1);
    expect(harness.ecrGrantRevoker).toHaveBeenCalledTimes(1);
    expect(harness.billingStopper).toHaveBeenCalledTimes(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. Secrets write-through review
// ═══════════════════════════════════════════════════════════════════════════

const PLAINTEXT_SECRET = 'sk_live_never_leak_this_0123456789';

const CONFIG_ENTRIES: readonly ConfigEntry[] = [
  { key: 'LOG_LEVEL', value: 'info', isSecret: false },
  { key: 'API_KEY', value: PLAINTEXT_SECRET, isSecret: true },
];

const SECRET_ARN = 'arn:aws:secretsmanager:us-east-1:123456789012:secret:deployz/app-1-API_KEY-abc123';

function makeConfigInput(overrides: Partial<ConfigUpdateInput> = {}): ConfigUpdateInput {
  return {
    deploymentId: 'deployment-1',
    customerId: 'customer-1',
    organizationId: 'org-1',
    jobId: 'job-1',
    installationId: 'install-1',
    entries: CONFIG_ENTRIES,
    ...overrides,
  };
}

interface ConfigHarness {
  workflow: DurableWorkflow<ConfigUpdateInput, ConfigUpdateOutput>;
  runtime: DurableRuntime;
  eventStore: InMemoryEventStore;
  deploymentStore: InMemoryDeploymentStateStore;
  validate: Mock<() => Promise<ConfigValidationResult>>;
  write: Mock<() => Promise<ConfigWriteResult>>;
}

function makeConfigHarness(
  config: { validationResult?: ConfigValidationResult; writeResult?: ConfigWriteResult } = {},
): ConfigHarness {
  const eventStore = new InMemoryEventStore();
  const emitter = new EventEmitter(eventStore, () => FIXED_NOW);
  const deploymentStore = new InMemoryDeploymentStateStore();

  const validate = vi
    .fn<() => Promise<ConfigValidationResult>>()
    .mockResolvedValue(config.validationResult ?? { ok: true });
  const write = vi
    .fn<() => Promise<ConfigWriteResult>>()
    .mockResolvedValue(config.writeResult ?? { ok: true, secretArns: [SECRET_ARN] });

  const workflow = createConfigUpdateWorkflow({
    emitter,
    deploymentStore,
    configValidator: { validate },
    configWriter: { write },
  });

  const runtime = new DurableRuntime(new InMemoryStateStore());

  return { workflow, runtime, eventStore, deploymentStore, validate, write };
}

/** Start the config-update workflow, then resume with a healthy health report. */
async function runConfigToCompletion(
  harness: ConfigHarness,
  input: ConfigUpdateInput,
  executionId: string,
) {
  const suspended = await harness.runtime.start(harness.workflow, input, executionId);
  expect(suspended.status).toBe('WAITING_CALLBACK');
  return harness.runtime.resume(harness.workflow, executionId, {
    installationId: input.installationId,
    healthy: true,
  });
}

/** Assert that a plaintext secret never appears in a value (deep string check). */
function expectNoPlaintext(value: unknown): void {
  expect(JSON.stringify(value)).not.toContain(PLAINTEXT_SECRET);
}

describe('Security: secrets write-through', () => {
  it('maskSecrets replaces secret values with SECRET_MASK', () => {
    const masked = maskSecrets(CONFIG_ENTRIES);

    // Non-secret values are unchanged.
    expect(masked[0]!.value).toBe('info');
    expect(masked[0]!.isSecret).toBe(false);

    // Secret values are masked.
    expect(masked[1]!.value).toBe(SECRET_MASK);
    expect(masked[1]!.isSecret).toBe(true);

    // The plaintext secret is NEVER in the masked output.
    const allValues = masked.map((e) => e.value);
    expect(allValues).not.toContain(PLAINTEXT_SECRET);
  });

  it('SECRET_MASK is the literal string "***"', () => {
    expect(SECRET_MASK).toBe('***');
  });

  it('config-update workflow output carries masked values only', async () => {
    const harness = makeConfigHarness();
    await harness.deploymentStore.set('deployment-1', 'HEALTHY');

    const input = makeConfigInput();
    const completed = await runConfigToCompletion(harness, input, 'exec-secrets-1');

    expect(completed.status).toBe('COMPLETED');
    const output = completed.output as ConfigUpdateOutput;

    // Output entries are masked.
    expectNoPlaintext(output);
    expect(output.appliedEntries).toContainEqual({
      key: 'API_KEY',
      value: SECRET_MASK,
      isSecret: true,
    });

    // Secret ARNs are returned (not values).
    expect(output.secretArns).toEqual([SECRET_ARN]);
  });

  it('config-update workflow events carry masked values only', async () => {
    const harness = makeConfigHarness();
    await harness.deploymentStore.set('deployment-1', 'HEALTHY');

    const input = makeConfigInput();
    await runConfigToCompletion(harness, input, 'exec-secrets-2');

    // Every event payload must never contain the plaintext secret.
    for (const event of harness.eventStore.events) {
      expectNoPlaintext(event.payload);
    }

    // The validate event carries masked entries.
    const validateEvent = harness.eventStore.events.find(
      (e) => e.eventType === 'config.validate',
    );
    expect(validateEvent).toBeDefined();
    const validateEntries = validateEvent?.payload?.entries as ConfigEntry[] | undefined;
    expect(validateEntries).toBeDefined();
    const secretEntry = validateEntries?.find((e) => e.isSecret);
    expect(secretEntry?.value).toBe(SECRET_MASK);

    // The write event carries masked entries.
    const writeEvent = harness.eventStore.events.find(
      (e) => e.eventType === 'config.write',
    );
    expect(writeEvent).toBeDefined();
    const writeEntries = writeEvent?.payload?.entries as ConfigEntry[] | undefined;
    expect(writeEntries).toBeDefined();
    const writeSecretEntry = writeEntries?.find((e) => e.isSecret);
    expect(writeSecretEntry?.value).toBe(SECRET_MASK);
  });

  it('config secrets are written to customer Secrets Manager via relay (write-through)', async () => {
    const harness = makeConfigHarness();
    await harness.deploymentStore.set('deployment-1', 'HEALTHY');

    const input = makeConfigInput();
    await runConfigToCompletion(harness, input, 'exec-secrets-3');

    // The ConfigWriter was called with the full entries (including plaintext secrets).
    expect(harness.write).toHaveBeenCalledTimes(1);
    expect(harness.write).toHaveBeenCalledWith('deployment-1', 'install-1', CONFIG_ENTRIES);
  });

  it('validateConfigKeys rejects empty keys', () => {
    const result = validateConfigKeys(
      [{ key: '', value: 'x', isSecret: false }],
      ['allowed'],
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failureCode).toBe('INVALID_CONFIG');
      expect(result.reason).toContain('empty config key');
    }
  });

  it('validateConfigKeys rejects duplicate keys', () => {
    const result = validateConfigKeys(
      [
        { key: 'A', value: '1', isSecret: false },
        { key: 'A', value: '2', isSecret: false },
      ],
      ['A'],
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failureCode).toBe('INVALID_CONFIG');
      expect(result.reason).toContain('duplicate');
    }
  });

  it('validateConfigKeys rejects keys outside allowed set', () => {
    const result = validateConfigKeys(
      [{ key: 'FORBIDDEN', value: 'x', isSecret: false }],
      ['ALLOWED'],
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failureCode).toBe('INVALID_CONFIG');
      expect(result.reason).toContain('not in vendor defaults');
    }
  });

  it('validateConfigKeys accepts valid keys', () => {
    const result = validateConfigKeys(
      [
        { key: 'A', value: '1', isSecret: false },
        { key: 'B', value: '2', isSecret: true },
      ],
      ['A', 'B'],
    );
    expect(result.ok).toBe(true);
  });
});