/**
 * Stage B phase 4 — Deployz-generated application-INTERNAL secrets.
 *
 * At deployment creation, every manifest variable that is a required,
 * generatable internal secret (AUTH_SECRET / NEXTAUTH_SECRET / … — see the
 * `generatable` flag on the env-var model) with NO configured value in scope
 * gets a cryptographically random value generated ONCE. Delivery uses the
 * EXISTING secret mechanism: the value rides a CONFIG_UPDATE relay
 * write-through (transient transport only, never stored), and the control
 * plane persists only the GENERATED_SECRET_MASK marker so the config API/UI
 * can show "Deployz-generated".
 *
 * Stability semantics:
 *   - Generated ONCE per (application, customer): a row already present for
 *     the key (vendor default, customer override, or a previous generation)
 *     skips generation, so redeploys/reinstalls reuse the value.
 *   - A vendor/customer-configured value always wins — its presence (any
 *     scope) suppresses generation, and a later save overwrites the marker.
 *   - Re-analysis never rotates: generation happens only here.
 *   - The vendor re-arms generation explicitly by deleting the config key
 *     (the existing delete path).
 *
 * The plaintext never reaches a log or a prompt: it is generated into the
 * relay message and the DB row stores only the marker.
 */

import { randomBytes } from 'node:crypto';

import type { ManifestEnvVariable } from '@deployz/contracts';
import type { RuntimeDb } from '@deployz/db';

import {
  createConfigStore,
  createRelaySecretWriter,
  GENERATED_SECRET_MASK,
  type ConfigSecretWriter,
  type ConfigStore,
} from './config.js';

/** Injectable seams (tests) — default to the real store + relay writer. */
export interface InternalSecretSeams {
  readonly store?: ConfigStore;
  readonly writer?: ConfigSecretWriter;
}

/**
 * Generate values for every required+generatable internal secret that has no
 * configured value, persist the masked marker rows at customer scope, and
 * deliver the values through the relay secret write-through. Idempotent: a
 * second call finds the rows it wrote and generates nothing.
 */
export async function ensureGeneratedInternalSecrets(
  db: RuntimeDb,
  params: {
    applicationId: string;
    customerId: string;
    /** The final manifest's env-var model (carries `generatable`). */
    variables: readonly ManifestEnvVariable[];
  },
  seams: InternalSecretSeams = {},
): Promise<void> {
  const generatable = params.variables.filter((variable) => variable.generatable === true);
  if (generatable.length === 0) return;

  const store = seams.store ?? createConfigStore(db);
  const configuredKeys = new Set<string>();
  for (const scope of [null, params.customerId]) {
    for (const entry of await store.list(params.applicationId, scope)) {
      configuredKeys.add(entry.key);
    }
  }

  const missing = generatable.filter((variable) => !configuredKeys.has(variable.key));
  if (missing.length === 0) return;

  const generated = missing.map((variable) => ({
    key: variable.key,
    value: randomBytes(32).toString('base64url'),
    isSecret: true,
  }));

  // Deliver the plaintext to the customer's Secrets Manager (relay
  // CONFIG_UPDATE write-through — transient queue transport, never stored).
  // Without a queue (local dev / tests) this degrades to a no-op, exactly
  // like every other secret write in that environment.
  const writer = seams.writer ?? createRelaySecretWriter();
  await writer.writeSecrets(params.customerId, generated);

  for (const entry of generated) {
    await store.upsert(params.applicationId, params.customerId, {
      key: entry.key,
      value: GENERATED_SECRET_MASK,
      isSecret: true,
    });
  }
}
