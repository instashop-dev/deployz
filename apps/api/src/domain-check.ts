import { resolveCname } from 'node:dns/promises';

// Public-DNS + HTTPS probes behind a seam so tests and E2E runs never do
// real network I/O. Deployz only ever READS public DNS — it never writes
// to a customer's DNS provider.

export interface DomainCheckDeps {
  checkCname(name: string, expectedTarget: string): Promise<boolean>;
  probeHttps(hostname: string): Promise<boolean>;
  minCheckIntervalMs: number;
}

const normalizeTarget = (value: string) => value.trim().toLowerCase().replace(/\.+$/, '');

export function createRealDomainCheckDeps(): DomainCheckDeps {
  return {
    minCheckIntervalMs: 30_000,
    async checkCname(name, expectedTarget) {
      try {
        const targets = await resolveCname(name);
        return targets.map(normalizeTarget).includes(normalizeTarget(expectedTarget));
      } catch {
        return false; // NXDOMAIN / ENODATA / timeout — record simply not there yet
      }
    },
    async probeHttps(hostname) {
      try {
        // Any completed HTTPS response proves DNS + TLS + routing; the app's
        // own status code (401, 302, …) is its business, not ours.
        await fetch(`https://${hostname}/`, {
          method: 'GET',
          redirect: 'manual',
          signal: AbortSignal.timeout(10_000),
        });
        return true;
      } catch {
        return false;
      }
    },
  };
}

// E2E fixture mode (DOMAIN_FIXTURE_MODE=true): deterministic answers for the
// reserved test namespace, mirroring GITHUB_FIXTURE_MODE.
export function createFixtureDomainCheckDeps(): DomainCheckDeps {
  const isFixture = (name: string) => name.endsWith('.deployz-fixture.test');
  return {
    minCheckIntervalMs: 0,
    checkCname: async (name) => isFixture(name),
    probeHttps: async (hostname) => isFixture(hostname),
  };
}
