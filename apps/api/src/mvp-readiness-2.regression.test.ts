import { describe, expect, it } from 'vitest';

import { createCipherStub, type PendingSecretStore, type SecretCipher } from './pending-secrets.js';
import { setConfig, type ConfigEntry, type ConfigDeps, type ConfigSecretWriter, type ConfigStore } from './config.js';
import { buildRelayConfigEntries, type PendingSecretVault } from './install-config.js';

// Phase 0 regression baseline for the public-MVP changes. These tests encode
// the DESIRED behaviour; they are RED until the matching phase lands:
//
//   DEPLOY-027        -> Phase 4 (secure pre-relay secret delivery)
//   region cost/select-> Phase 3 (customer-selected Region + preview)
//   invitations       -> Phase 2 (unified installation invitations)
//   customer-page UX  -> Phase 5 (consolidate customer page)
//
// The DEPLOY-027 case below exercises the new pending-secrets path end-to-end:
// the customer-required secret is encrypted at rest (via the cipher stub)
// when setConfig writes it, materialized into a bound row when the
// deployment is created, and surfaced through the relay config seam when the
// relay polls. The remaining cases are `it.todo` markers so they are tracked
// without referencing APIs that do not exist yet.

const APPLICATION_ID = '00000000-0000-0000-0000-000000000001';
const CUSTOMER_ID = '00000000-0000-0000-0000-000000000002';
const DEPLOYMENT_ID = '00000000-0000-0000-0000-000000000003';

function makeStore(seed: ConfigEntry[] = []): ConfigStore {
  const rows: ConfigEntry[] = [...seed];
  return {
    async applicationExists() {
      return true;
    },
    async list(_applicationId, _customerId) {
      return rows;
    },
    async upsert(_applicationId, _customerId, entry) {
      const index = rows.findIndex((row) => row.key === entry.key);
      if (index >= 0) rows[index] = entry;
      else rows.push(entry);
    },
    async remove(_applicationId, _customerId, key) {
      const index = rows.findIndex((row) => row.key === key);
      if (index >= 0) rows.splice(index, 1);
    },
  };
}

const noopSecretWriter: ConfigSecretWriter = {
  async writeSecrets() {},
  async removeSecrets() {},
};

/** In-memory PendingSecretStore + cipher stub. */
function makePendingSecrets(cipher: SecretCipher): {
  store: PendingSecretStore;
  vault: PendingSecretVault;
} {
  // Two tiers in a single map keyed by `(tier, key)` so the stub matches the
  // real drizzle shape: staged rows have deploymentId null, bound rows have
  // it set. encrypt() produces a non-plaintext ciphertext; decrypt round-trips.
  const staged = new Map<string, { ciphertext: string; encryptionContext: Record<string, string>; expiresAt: Date }>();
  const bound = new Map<
    string,
    { ciphertext: string; encryptionContext: Record<string, string>; deliveryAttempts: number; expiresAt: Date }
  >();

  const store: PendingSecretStore = {
    async upsertStaged(input) {
      staged.set(`s:${input.key}`, {
        ciphertext: input.ciphertext,
        encryptionContext: input.encryptionContext,
        expiresAt: input.expiresAt,
      });
    },
    async upsertBound(input) {
      bound.set(`b:${input.deploymentId}:${input.key}`, {
        ciphertext: input.ciphertext,
        encryptionContext: input.encryptionContext,
        deliveryAttempts: 0,
        expiresAt: input.expiresAt,
      });
    },
    async materializeForDeployment(deployment) {
      const out: Array<{ key: string; plaintext: string }> = [];
      for (const [composite, row] of staged.entries()) {
        if (!composite.startsWith('s:')) continue;
        const plaintext = await cipher.decrypt(row.ciphertext, row.encryptionContext);
        out.push({ key: composite.slice(2), plaintext });
      }
      void deployment;
      return out;
    },
    async listBoundForDeployment(deploymentId) {
      const out: Array<{ key: string; ciphertext: string; encryptionContext: Record<string, string>; deliveryAttempts: number }> = [];
      for (const [composite, row] of bound.entries()) {
        if (!composite.startsWith(`b:${deploymentId}:`)) continue;
        out.push({
          key: composite.slice(`b:${deploymentId}:`.length),
          ciphertext: row.ciphertext,
          encryptionContext: row.encryptionContext,
          deliveryAttempts: row.deliveryAttempts,
        });
      }
      return out;
    },
    async deleteBoundForDeployment(deploymentId) {
      for (const composite of [...bound.keys()]) {
        if (composite.startsWith(`b:${deploymentId}:`)) bound.delete(composite);
      }
    },
    async deleteStagedForScope(input) {
      staged.delete(`s:${input.key}`);
    },
    async sweepExpired(now) {
      let count = 0;
      for (const [composite, row] of [...staged.entries()]) {
        if (row.expiresAt.getTime() < now.getTime()) {
          staged.delete(composite);
          count++;
        };
      }
      for (const [composite, row] of [...bound.entries()]) {
        if (row.expiresAt.getTime() < now.getTime()) {
          bound.delete(composite);
          count++;
        };
      }
      return count;
    },
    async stampDelivery(deploymentId, key) {
      const composite = `b:${deploymentId}:${key}`;
      const row = bound.get(composite);
      if (row !== undefined) row.deliveryAttempts += 1;
    },
  };

  const vault: PendingSecretVault = {
    async readBound(deploymentId, key) {
      const row = bound.get(`b:${deploymentId}:${key}`);
      if (row === undefined) return undefined;
      const plaintext = await cipher.decrypt(row.ciphertext, row.encryptionContext);
      return plaintext;
    },
    async stampDelivery(deploymentId, key) {
      await store.stampDelivery(deploymentId, key);
    },
  };

  return { store, vault };
}

// A customer-required, format-sensitive secret (an external credential) — the
// exact class DEPLOY-027 loses. Not mintable: the relay must not invent a
// value, so the customer-entered value must be retained and delivered.
const MANIFEST = {
  application: { root: '.', runtime: 'node', framework: 'express', dockerfilePath: 'Dockerfile' },
  build: { command: 'npm run build', context: '.' },
  web: { command: 'npm start', port: 3000 },
  health: { path: '/health' },
  database: { postgres: false },
  redis: { required: false, envBindings: [] },
  storage: { required: false, envBindings: [] },
  migration: { command: null },
  worker: { command: null },
  environment: {
    variables: [
      {
        key: 'ADMIN_PASSWORD',
        required: true,
        secret: true,
        source: ['README.md'],
        classification: 'customer_required',
        purpose: 'external_credential',
      },
    ],
  },
  externalServices: [],
  unsupported: [],
};

const db = undefined as unknown as import('@deployz/db').RuntimeDb;

describe('public-MVP regression baseline', () => {
  it('DEPLOY-027: a customer-required secret typed before the relay connects is retained and deliverable', async () => {
    const secretValue = 'correct-horse-battery-staple';
    const cipher = createCipherStub();
    const { store: pendingSecrets, vault } = makePendingSecrets(cipher);
    const store = makeStore();
    const deps: ConfigDeps = {
      store,
      secretWriter: noopSecretWriter,
      pendingSecrets,
      cipher,
      async findScopeDeployments() {
        // Pre-relay: NO deployment exists yet → setConfig persists a staged
        // row that the next createDeploymentRecord materializes.
        return [];
      },
      async findApplicationOrganizationId() {
        return 'org-test';
      },
    };

    await setConfig(APPLICATION_ID, CUSTOMER_ID, [{ key: 'ADMIN_PASSWORD', value: secretValue, isSecret: true }], deps);

    // Materialize the staged rows for the new deployment (the deploy-links.ts
    // materialization hook does this on every creation path).
    const materialize = await pendingSecrets.materializeForDeployment({
      organizationId: 'org-test',
      id: DEPLOYMENT_ID,
      applicationId: APPLICATION_ID,
      customerId: CUSTOMER_ID,
    });
    for (const { key, plaintext } of materialize) {
      const context = {
        organizationId: 'org-test',
        applicationId: APPLICATION_ID,
        deploymentId: DEPLOYMENT_ID,
        key,
        customerId: CUSTOMER_ID,
      };
      const encrypted = await cipher.encrypt(plaintext, context);
      await pendingSecrets.upsertBound({
        organizationId: 'org-test',
        applicationId: APPLICATION_ID,
        deploymentId: DEPLOYMENT_ID,
        key,
        ciphertext: encrypted.ciphertext,
        encryptionContext: encrypted.encryptionContext,
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      });
    }

    const entries = await buildRelayConfigEntries(
      db,
      {
        id: DEPLOYMENT_ID,
        applicationId: APPLICATION_ID,
        customerId: CUSTOMER_ID,
        desiredState: { manifest: MANIFEST },
      },
      store,
      vault,
    );

    const entry = entries.find((candidate) => candidate.key === 'ADMIN_PASSWORD');
    // Desired: the value the customer typed before the relay connected is
    // retained (encrypted at rest) and available to the relay when it enrolls.
    expect(entry?.value).toBe(secretValue);
  });

  it.todo('Region changes re-derive the cost/footprint preview (Phase 3)');
  it.todo('A new production installation never silently fixes the Region (Phase 2/3)');
  it.todo('A vendor-created link never fixes the Region before customer confirmation (Phase 2)');
  it.todo('Duplicate confirmations never create duplicate deployments (Phase 2)');
  it.todo('Customer-level copy never selects an ambiguous deployment (Phase 5)');
  it.todo('Multiple UI actions never create equivalent production deployments (Phase 5)');
});
