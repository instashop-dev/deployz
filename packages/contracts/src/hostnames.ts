/**
 * Regional HTTPS certificates — centralized hostname construction/parsing
 * (docs/https-regional-certificates.md, decision 2). `apps/api`, `apps/web`,
 * `scripts/*` and `e2e/*` import these instead of building the strings
 * themselves, so the shape of a customer namespace or a deployment hostname
 * is defined exactly once.
 *
 * Pure and side-effect free: no I/O here.
 *
 *   Customer namespace       c-<scope>.deployz.dev
 *   Regional ACM certificate *.c-<scope>.deployz.dev
 *   Deployment URL           https://d-<deploymentId>.c-<scope>.deployz.dev
 *
 * The legacy `d-<deploymentId>.deployz.dev` shape (apps/api/src/
 * default-https.ts) is mirrored here too — apps/api delegates to it rather
 * than keeping a second implementation.
 */

/** Default DNS zone the customer namespace and legacy default hostnames are
 *  minted under. */
export const DEFAULT_HTTPS_ZONE = 'deployz.dev';

/** Label prefix for a deployment's hostname, under either the legacy zone or
 *  a customer namespace. */
export const DEFAULT_DEPLOYMENT_LABEL_PREFIX = 'd-';

/** Label prefix for a customer's DNS namespace (`c-<dnsScope>`). */
export const CUSTOMER_SCOPE_LABEL_PREFIX = 'c-';

/** `customers.dns_scope` shape — lowercase alphanumeric, 4-32 characters.
 *  Not tied to any particular minting scheme (the SQL default happens to
 *  produce 12 lowercase hex characters); this is the general validator. */
export const CUSTOMER_DNS_SCOPE_RE = /^[a-z0-9]{4,32}$/;

/** Whether `value` is a well-formed `customers.dns_scope`. */
export function isValidCustomerDnsScope(value: string): boolean {
  return CUSTOMER_DNS_SCOPE_RE.test(value);
}

/** The DNS label for a customer's namespace: `c-<dnsScope>`. Throws on an
 *  invalid scope — the scope is minted by the database, never user input. */
export function customerScopeLabel(dnsScope: string): string {
  if (!isValidCustomerDnsScope(dnsScope)) {
    throw new Error(`Invalid customer DNS scope: ${JSON.stringify(dnsScope)}`);
  }
  return `${CUSTOMER_SCOPE_LABEL_PREFIX}${dnsScope}`;
}

/** The customer's DNS namespace hostname: `c-<dnsScope>.<zone>`. */
export function customerNamespaceHostname(dnsScope: string, zone: string = DEFAULT_HTTPS_ZONE): string {
  return `${customerScopeLabel(dnsScope)}.${zone}`;
}

/** The regional wildcard certificate domain for a customer namespace:
 *  `*.c-<dnsScope>.<zone>` — requested once per customer+account+region and
 *  reused by every deployment in that scope. */
export function regionalCertificateDomain(dnsScope: string, zone: string = DEFAULT_HTTPS_ZONE): string {
  return `*.${customerNamespaceHostname(dnsScope, zone)}`;
}

export interface ScopedDeploymentHostnameConfig {
  /** Registrable zone the hostname is minted under (default `deployz.dev`). */
  zone?: string;
  /** Hostname label prefix (default `d-`). */
  prefix?: string;
}

// A deployment id embedded in a hostname must be DNS-safe — never
// customer-controlled, so anything else is a programming error worth
// throwing over. Mirrors apps/api/src/default-https.ts's DNS_SAFE_ID.
const DNS_SAFE_DEPLOYMENT_ID = /^[a-z0-9-]+$/;

// Deployment ids are uuids (lowercased). Only names that carry a real uuid
// may ever be parsed as owning a live deployment row. Mirrors
// apps/api/src/default-https.ts's UUID_RE.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function normalizedDeploymentId(deploymentId: string): string {
  const normalized = deploymentId.toLowerCase();
  if (!DNS_SAFE_DEPLOYMENT_ID.test(normalized)) {
    throw new Error(`Invalid deployment id for a hostname: ${JSON.stringify(deploymentId)}`);
  }
  return normalized;
}

/** A deployment's hostname scoped to its customer namespace:
 *  `d-<deploymentId>.c-<dnsScope>.<zone>`. */
export function scopedDeploymentHostname(
  deploymentId: string,
  dnsScope: string,
  config: ScopedDeploymentHostnameConfig = {},
): string {
  const prefix = config.prefix ?? DEFAULT_DEPLOYMENT_LABEL_PREFIX;
  const zone = config.zone ?? DEFAULT_HTTPS_ZONE;
  return `${prefix}${normalizedDeploymentId(deploymentId)}.${customerNamespaceHostname(dnsScope, zone)}`;
}

/** The `https://` URL for `scopedDeploymentHostname`. */
export function scopedDeploymentUrl(
  deploymentId: string,
  dnsScope: string,
  config?: ScopedDeploymentHostnameConfig,
): string {
  return `https://${scopedDeploymentHostname(deploymentId, dnsScope, config)}`;
}

/** The legacy (pre-regional) default hostname: `d-<deploymentId>.<zone>` —
 *  what apps/api/src/default-https.ts's getDefaultDeploymentHostname
 *  produces. Grandfathered deployments keep resolving through this shape. */
export function legacyDefaultDeploymentHostname(
  deploymentId: string,
  config: ScopedDeploymentHostnameConfig = {},
): string {
  const prefix = config.prefix ?? DEFAULT_DEPLOYMENT_LABEL_PREFIX;
  const zone = config.zone ?? DEFAULT_HTTPS_ZONE;
  return `${prefix}${normalizedDeploymentId(deploymentId)}.${zone}`;
}

/** The deployment id and customer scope embedded in a scoped hostname
 *  (`d-<uuid>.c-<scope>.<zone>`), or null when the name does not parse:
 *  wrong prefix/zone, a non-uuid deployment id, or an invalid scope label.
 *  Case-insensitive. */
export function parseScopedDeploymentHostname(
  hostname: string,
  config: ScopedDeploymentHostnameConfig = {},
): { deploymentId: string; dnsScope: string } | null {
  const prefix = config.prefix ?? DEFAULT_DEPLOYMENT_LABEL_PREFIX;
  const zone = config.zone ?? DEFAULT_HTTPS_ZONE;
  const lower = hostname.toLowerCase();
  const zoneSuffix = `.${zone}`;
  if (!lower.endsWith(zoneSuffix)) return null;
  const withoutZone = lower.slice(0, -zoneSuffix.length);
  const dotIndex = withoutZone.lastIndexOf('.');
  if (dotIndex === -1) return null;
  const deploymentLabel = withoutZone.slice(0, dotIndex);
  const scopeLabel = withoutZone.slice(dotIndex + 1);
  if (!deploymentLabel.startsWith(prefix)) return null;
  const deploymentId = deploymentLabel.slice(prefix.length);
  if (!UUID_RE.test(deploymentId)) return null;
  if (!scopeLabel.startsWith(CUSTOMER_SCOPE_LABEL_PREFIX)) return null;
  const dnsScope = scopeLabel.slice(CUSTOMER_SCOPE_LABEL_PREFIX.length);
  if (!isValidCustomerDnsScope(dnsScope)) return null;
  return { deploymentId, dnsScope };
}

/** The deployment id embedded in a legacy default hostname (`d-<id>.<zone>`),
 *  or null when the name is not a well-formed `d-<uuid>.<zone>` hostname.
 *  Mirrors apps/api/src/default-https.ts's parseDefaultDeploymentId. */
export function parseLegacyDefaultDeploymentHostname(
  hostname: string,
  config: ScopedDeploymentHostnameConfig = {},
): string | null {
  const prefix = config.prefix ?? DEFAULT_DEPLOYMENT_LABEL_PREFIX;
  const zone = config.zone ?? DEFAULT_HTTPS_ZONE;
  const lower = hostname.toLowerCase();
  const zoneSuffix = `.${zone}`;
  if (!lower.startsWith(prefix) || !lower.endsWith(zoneSuffix)) return null;
  const id = lower.slice(prefix.length, -zoneSuffix.length);
  return UUID_RE.test(id) ? id : null;
}

/** Whether `name` is a certificate validation record name that lives exactly
 *  one label under a customer namespace (e.g. `_abc123.c-<scope>.deployz.dev`)
 *  — the only shape the regional ACM validation CNAME may ever take. A
 *  single trailing dot (FQDN form) is tolerated and stripped before
 *  matching; anything left with more than one label under the namespace, or
 *  no label at all, is rejected. */
export function isScopeValidationRecordName(
  name: string,
  dnsScope: string,
  zone: string = DEFAULT_HTTPS_ZONE,
): boolean {
  if (!isValidCustomerDnsScope(dnsScope)) return false;
  const stripped = name.endsWith('.') ? name.slice(0, -1) : name;
  const lower = stripped.toLowerCase();
  const namespaceSuffix = `.${customerNamespaceHostname(dnsScope, zone)}`;
  if (!lower.endsWith(namespaceSuffix)) return false;
  const label = lower.slice(0, -namespaceSuffix.length);
  return label.length > 0 && !label.includes('.');
}
