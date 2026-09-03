/**
 * Fixture-mode default-HTTPS DNS provider (Phase 14 simulated E2E).
 *
 * In production the default-HTTPS machine writes deployz-zone CNAMEs through
 * the Cloudflare client; under the E2E fixture environment (`DOMAIN_FIXTURE_MODE`
 * + `DEPLOYZ_DEFAULT_HTTPS_FIXTURE`) there is no real Cloudflare, so the
 * server assembles THIS provider instead. It is a real `CloudflareDnsClient`
 * backed by the same in-memory store as the unit-level fake
 * (createFakeCloudflareDnsClient), plus three fixture-only affordances that
 * make the running server ASSERTIBLE and FAILURE-SCRIPTABLE for the
 * simulated-provider scenario suite:
 *
 *  - `records()` — a readable snapshot of every record the machine has
 *    written (routing + validation CNAMEs), served to scenarios over the
 *    gated internal endpoint (server.ts `/internal/fixture/default-dns-*`).
 *  - `queueFailures(count, code)` — the next `count` DNS operations fail with
 *    CLOUDFLARE_UNAVAILABLE or CLOUDFLARE_RATE_LIMITED (FIFO), driving the
 *    machine's Phase 12 watchdog and rate-limit handling end to end.
 *  - `plantRecord(name, content)` — seeds a RAW record into the store,
 *    deliberately bypassing the client's namespace guard so a scenario can
 *    model exactly what a hostile/leftover Cloudflare zone might hold
 *    (reserved hostnames, non-uuid `d-*` names) and prove the purge
 *    reconciliation never mutates them.
 *
 * Production-inert: the provider is only ever constructed when both fixture
 * flags are on, and the internal endpoints it backs reply 404 otherwise.
 * Everything here is memory-only — no network, no real Cloudflare.
 */

import {
  CloudflareDnsError,
  CLOUDFLARE_RECORD_COMMENT,
  CLOUDFLARE_VALIDATION_RECORD_COMMENT,
  type CloudflareDnsClient,
  type CloudflareDnsRecord,
} from './cloudflare-records.js';

export type FixtureDnsFailureCode = 'unavailable' | 'rate_limit';

export interface FixtureDnsMutation {
  readonly op: string;
  readonly name: string;
}

export interface DefaultHttpsFixtureProvider {
  /** The CloudflareDnsClient the default-HTTPS machine should use. */
  readonly client: CloudflareDnsClient;
  /** A readable snapshot of every record the provider holds. */
  records(): readonly CloudflareDnsRecord[];
  /** Every write/delete that reached the store, in order (for assertions). */
  mutations(): readonly FixtureDnsMutation[];
  /** Queue `count` failures of the given kind, scoped to ONE deployment's
   *  writes when `deploymentId` is given (the Phase 14 suite runs many
   *  simulated deployments against one shared server, so unscoped failures
   *  would bleed across parallel workers). Consumed FIFO per operation. */
  queueFailures(count: number, code: FixtureDnsFailureCode, deploymentId?: string): void;
  /** How many scripted failures remain unconsumed. */
  remainingFailures(): number;
  /** Plant a raw record, bypassing the namespace guard (simulates leftovers). */
  plantRecord(name: string, content: string, proxied?: boolean): void;
}

export function createDefaultHttpsFixtureProvider(apex: string, prefix = 'd-'): DefaultHttpsFixtureProvider {
  const store = new Map<string, CloudflareDnsRecord>();
  const mutations: FixtureDnsMutation[] = [];
  const failureQueue: Array<{ deploymentId?: string; code: FixtureDnsFailureCode }> = [];
  let nextId = 1;

  function hostnameFor(deploymentId: string): string {
    return `${prefix}${deploymentId}.${apex}`;
  }

  function save(record: CloudflareDnsRecord): void {
    store.set(record.name.toLowerCase(), record);
  }

  function list(): CloudflareDnsRecord[] {
    return [...store.values()];
  }

  /** Pops the oldest failure queued for THIS deployment (a per-deployment
   *  failure queue keeps parallel simulated deployments from consuming each
   *  other's scripts) and throws it. */
  function maybeFail(deploymentId: string): void {
    const index = failureQueue.findIndex((entry) => entry.deploymentId === deploymentId);
    if (index === -1) return;
    const next = failureQueue.splice(index, 1)[0]!;
    if (next.code === 'rate_limit') {
      throw new CloudflareDnsError('Cloudflare rate limit exceeded.', 'CLOUDFLARE_RATE_LIMITED', {
        status: 429,
        retryAfterSeconds: 30,
      });
    }
    throw new CloudflareDnsError('Cloudflare API request failed (network error or timeout).', 'CLOUDFLARE_UNAVAILABLE');
  }

  function opResult(op: string, name: string, outcome: string): void {
    mutations.push({ op: `${op}:${outcome}`, name });
  }

  // The deployment-keyed methods mirror createFakeCloudflareDnsClient but push
  // through maybeFail() first and log every mutation that reached the store.
  const client: CloudflareDnsClient = {
    getRecord: async (deploymentId) => {
      const hostname = hostnameFor(deploymentId);
      return store.get(hostname.toLowerCase()) ?? null;
    },
    upsertDefaultDeploymentRecord: async (deploymentId, target) => {
      maybeFail(deploymentId);
      const name = hostnameFor(deploymentId);
      const existing = store.get(name.toLowerCase());
      if (!existing) {
        const record = {
          id: `rec-${nextId++}`,
          type: 'CNAME' as const,
          name,
          content: target,
          ttl: 1,
          proxied: true,
          comment: CLOUDFLARE_RECORD_COMMENT,
        };
        save(record);
        opResult('routing', name, 'created');
        return { op: 'created' as const, record };
      }
      if (existing.content === target && existing.proxied) {
        opResult('routing', name, 'noop');
        return { op: 'noop' as const, record: existing };
      }
      const updated = { ...existing, content: target, proxied: true };
      save(updated);
      opResult('routing', name, 'updated');
      return { op: 'updated' as const, record: updated };
    },
    deleteDefaultDeploymentRecord: async (deploymentId) => {
      maybeFail(deploymentId);
      const name = hostnameFor(deploymentId);
      const existing = store.get(name.toLowerCase());
      if (!existing) {
        opResult('routing', name, 'noop');
        return { op: 'noop' as const };
      }
      store.delete(name.toLowerCase());
      opResult('routing', name, 'deleted');
      return { op: 'deleted' as const };
    },
    upsertDefaultValidationRecord: async (deploymentId, validationName, validationValue) => {
      maybeFail(deploymentId);
      void deploymentId;
      const existing = store.get(validationName.toLowerCase());
      if (!existing) {
        const record = {
          id: `rec-${nextId++}`,
          type: 'CNAME' as const,
          name: validationName,
          content: validationValue,
          ttl: 1,
          proxied: false,
          comment: CLOUDFLARE_VALIDATION_RECORD_COMMENT,
        };
        save(record);
        opResult('validation', validationName, 'created');
        return { op: 'created' as const, record };
      }
      if (existing.content === validationValue && !existing.proxied) {
        opResult('validation', validationName, 'noop');
        return { op: 'noop' as const, record: existing };
      }
      const updated = { ...existing, content: validationValue, proxied: false };
      save(updated);
      opResult('validation', validationName, 'updated');
      return { op: 'updated' as const, record: updated };
    },
    deleteDefaultValidationRecord: async (deploymentId, validationName) => {
      maybeFail(deploymentId);
      const existing = store.get(validationName.toLowerCase());
      if (!existing) {
        opResult('validation', validationName, 'noop');
        return { op: 'noop' as const };
      }
      store.delete(validationName.toLowerCase());
      opResult('validation', validationName, 'deleted');
      return { op: 'deleted' as const };
    },
    listDefaultRecords: async () =>
      list().filter((record) => record.type === 'CNAME' && record.name.toLowerCase().startsWith(prefix)),
  };

  return {
    client,
    records: () => list(),
    mutations: () => [...mutations],
    queueFailures: (count, code, deploymentId) => {
      for (let i = 0; i < count; i += 1) {
        failureQueue.push(deploymentId === undefined ? { code } : { deploymentId, code });
      }
    },
    remainingFailures: () => failureQueue.length,
    plantRecord: (name, content, proxied = true) => {
      const record = {
        id: `rec-${nextId++}`,
        type: 'CNAME' as const,
        name,
        content,
        ttl: 1,
        proxied,
        comment: CLOUDFLARE_RECORD_COMMENT,
      };
      save(record);
    },
  };
}
