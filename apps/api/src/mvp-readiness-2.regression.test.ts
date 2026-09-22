import { describe, expect, it } from 'vitest';

import { buildRelayConfigEntries } from './install-config.js';
import { setConfig, type ConfigEntry, type ConfigSecretWriter, type ConfigStore } from './config.js';

// Phase 0 regression baseline for the public-MVP changes. These tests encode
// the DESIRED behaviour; they are RED until the matching phase lands:
//
//   DEPLOY-027        -> Phase 4 (secure pre-relay secret delivery)
//   region cost/select-> Phase 3 (customer-selected Region + preview)
//   invitations       -> Phase 2 (unified installation invitations)
//   customer-page UX  -> Phase 5 (consolidate customer page)
//
// The DEPLOY-027 case below is a real failing test against current behaviour
// (a customer-required secret typed before the relay connects is write-only
// and lost). The remaining cases are `it.todo` markers so they are tracked
// without referencing APIs that do not exist yet.

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
  // `it.fails` keeps CI green while encoding the DEPLOY-027 gap: the secret is
  // currently lost, so the assertion fails (expected). Phase 4 makes it pass,
  // at which point Vitest reports an UNEXPECTED pass — flip this to a plain
  // `it` then.
  it.fails('DEPLOY-027: a customer-required secret typed before the relay connects is retained and deliverable', async () => {
    const secretValue = 'correct-horse-battery-staple';
    const store = makeStore();
    await setConfig(
      '00000000-0000-0000-0000-000000000001',
      '00000000-0000-0000-0000-000000000002',
      [{ key: 'ADMIN_PASSWORD', value: secretValue, isSecret: true }],
      { store, secretWriter: noopSecretWriter },
    );

    const entries = await buildRelayConfigEntries(
      db,
      {
        applicationId: '00000000-0000-0000-0000-000000000001',
        customerId: '00000000-0000-0000-0000-000000000002',
        desiredState: { manifest: MANIFEST },
      },
      store,
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
