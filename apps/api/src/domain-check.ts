import { lookup, resolveCname } from 'node:dns/promises';
import { isIP } from 'node:net';

// Public-DNS + HTTPS probes behind a seam so tests and E2E runs never do
// real network I/O. Deployz only ever READS public DNS — it never writes
// to a customer's DNS provider.

export interface DomainCheckDeps {
  checkCname(name: string, expectedTarget: string): Promise<boolean>;
  probeHttps(hostname: string): Promise<boolean>;
  minCheckIntervalMs: number;
}

const normalizeTarget = (value: string) => value.trim().toLowerCase().replace(/\.+$/, '');

function parseIPv4Octets(address: string): number[] | null {
  const parts = address.split('.');
  if (parts.length !== 4) return null;
  const octets = parts.map((part) => Number(part));
  if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return null;
  return octets;
}

function isPubliclyRoutableIPv4Octets(octets: number[]): boolean {
  const [a, b, c] = octets as [number, number, number, number];
  if (a === 0) return false; // 0.0.0.0/8
  if (a === 10) return false; // 10.0.0.0/8
  if (a === 100 && b >= 64 && b <= 127) return false; // 100.64.0.0/10 (CGNAT)
  if (a === 127) return false; // 127.0.0.0/8
  if (a === 169 && b === 254) return false; // 169.254.0.0/16
  if (a === 172 && b >= 16 && b <= 31) return false; // 172.16.0.0/12
  if (a === 192 && b === 168) return false; // 192.168.0.0/16
  if (a === 192 && b === 0 && c === 0) return false; // 192.0.0.0/24
  if (a === 192 && b === 0 && c === 2) return false; // 192.0.2.0/24 (TEST-NET-1)
  if (a === 198 && (b === 18 || b === 19)) return false; // 198.18.0.0/15
  if (a === 198 && b === 51 && c === 100) return false; // 198.51.100.0/24 (TEST-NET-2)
  if (a === 203 && b === 0 && c === 113) return false; // 203.0.113.0/24 (TEST-NET-3)
  if (a >= 224 && a <= 239) return false; // 224.0.0.0/4 (multicast)
  if (a >= 240) return false; // 240.0.0.0/4 + 255.255.255.255
  return true;
}

/**
 * Expands an IPv6 address string into its 8 numeric hextets, handling `::`
 * compression and a trailing embedded-IPv4 dotted-quad tail (e.g.
 * `::ffff:10.0.0.1`, `64:ff9b::1.2.3.4`). Returns null if the address isn't
 * well-formed (shouldn't happen for anything `node:net`'s `isIP` accepted,
 * but this stays defensive rather than assuming that).
 */
function expandIPv6Hextets(address: string): number[] | null {
  const lower = address.toLowerCase();
  const doubleColonIndex = lower.indexOf('::');
  const hasDoubleColon = doubleColonIndex !== -1;

  let head: string[];
  let tail: string[];
  if (!hasDoubleColon) {
    head = lower.split(':');
    tail = [];
  } else {
    const before = lower.slice(0, doubleColonIndex);
    const after = lower.slice(doubleColonIndex + 2);
    head = before ? before.split(':') : [];
    tail = after ? after.split(':') : [];
  }

  // An embedded IPv4 dotted-quad always occupies the final group.
  let ipv4Hextets: number[] = [];
  const embeddedGroup = tail.length > 0 ? tail : head;
  const embeddedSide = tail.length > 0 ? 'tail' : 'head';
  if (embeddedGroup.length > 0 && embeddedGroup[embeddedGroup.length - 1]!.includes('.')) {
    const octets = parseIPv4Octets(embeddedGroup[embeddedGroup.length - 1]!);
    if (!octets) return null;
    ipv4Hextets = [(octets[0]! << 8) | octets[1]!, (octets[2]! << 8) | octets[3]!];
    if (embeddedSide === 'tail') tail = tail.slice(0, -1);
    else head = head.slice(0, -1);
  }

  const parseHex = (group: string): number => {
    if (!/^[0-9a-f]{1,4}$/.test(group)) return Number.NaN;
    return Number.parseInt(group, 16);
  };

  const headNums = head.map(parseHex);
  const tailNums = tail.map(parseHex);
  if (headNums.some(Number.isNaN) || tailNums.some(Number.isNaN)) return null;

  const combinedTail = [...tailNums, ...ipv4Hextets];
  const totalKnown = headNums.length + combinedTail.length;
  if (!hasDoubleColon) {
    return totalKnown === 8 ? [...headNums, ...combinedTail] : null;
  }
  const zerosNeeded = 8 - totalKnown;
  if (zerosNeeded < 0) return null;
  return [...headNums, ...Array(zerosNeeded).fill(0), ...combinedTail];
}

function isPubliclyRoutableIPv6(address: string): boolean {
  const h = expandIPv6Hextets(address);
  if (!h) return false;

  // ::ffff:0:0/96 — IPv4-mapped; recurse on the embedded IPv4 address.
  if (h[0] === 0 && h[1] === 0 && h[2] === 0 && h[3] === 0 && h[4] === 0 && h[5] === 0xffff) {
    return isPubliclyRoutableIPv4Octets([h[6]! >> 8, h[6]! & 0xff, h[7]! >> 8, h[7]! & 0xff]);
  }
  // 64:ff9b::/96 — NAT64 well-known prefix; recurse on the embedded IPv4.
  if (h[0] === 0x64 && h[1] === 0xff9b && h[2] === 0 && h[3] === 0 && h[4] === 0 && h[5] === 0) {
    return isPubliclyRoutableIPv4Octets([h[6]! >> 8, h[6]! & 0xff, h[7]! >> 8, h[7]! & 0xff]);
  }

  if (h.every((n) => n === 0)) return false; // :: (unspecified)
  if (h[0] === 0 && h[1] === 0 && h[2] === 0 && h[3] === 0 && h[4] === 0 && h[5] === 0 && h[6] === 0 && h[7] === 1) {
    return false; // ::1 (loopback)
  }
  if (h[0]! >= 0xfc00 && h[0]! <= 0xfdff) return false; // fc00::/7 (unique local)
  if (h[0]! >= 0xfe80 && h[0]! <= 0xfebf) return false; // fe80::/10 (link-local)
  if (h[0]! >= 0xff00 && h[0]! <= 0xffff) return false; // ff00::/8 (multicast)
  if (h[0] === 0x2001 && h[1] === 0x0db8) return false; // 2001:db8::/32 (documentation)

  return true;
}

/**
 * True if `address` is a public, non-reserved IP literal. Used to keep the
 * HTTPS probe from being used as an SSRF primitive against internal
 * infrastructure (cloud metadata endpoints, internal services, etc.) via a
 * customer-controlled hostname's DNS answer.
 */
export function isPubliclyRoutableAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) {
    const octets = parseIPv4Octets(address);
    return octets ? isPubliclyRoutableIPv4Octets(octets) : false;
  }
  if (version === 6) return isPubliclyRoutableIPv6(address);
  return false; // not a valid IP literal at all
}

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
      // SSRF guard: resolve the hostname ourselves first and refuse to probe
      // if it (or any of its answers) points at a private/reserved address —
      // otherwise a customer could point their domain's DNS at
      // 169.254.169.254 or an internal service and use this probe as a blind
      // SSRF primitive. Residual TOCTOU: the `fetch` below re-resolves the
      // hostname itself, so a DNS answer could change between our lookup and
      // the fetch (rebinding). Deliberate MVP trade-off — the probe is
      // boolean-only and blind (the response body/headers are never
      // returned to the caller), which bounds the impact of a successful
      // rebind to "an internal endpoint returns any HTTP response" rather
      // than any data exfiltration.
      try {
        const addresses = await lookup(hostname, { all: true });
        if (addresses.length === 0) return false;
        if (!addresses.every((entry) => isPubliclyRoutableAddress(entry.address))) return false;
      } catch {
        return false; // couldn't resolve — nothing to probe
      }
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
