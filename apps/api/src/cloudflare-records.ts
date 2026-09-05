/**
 * Cloudflare DNS record client — the deployz-zone CNAME surface the
 * default-HTTPS feature uses (Phase 3).
 *
 * Follows the house idiom (narrow injectable seam + real implementation +
 * in-memory fake): one record type (CNAME), four operations (look up a
 * deployment record, upsert/delete a deployment's routing CNAME, upsert/
 * delete its ACM validation CNAME), and an injectable transport so a test
 * never reaches api.cloudflare.com. The single credential is a zone-scoped
 * API token sent as `Authorization: Bearer` — it never appears in an error
 * message or thrown field.
 *
 * Cloudflare has no server-side DNS upsert and create is NOT idempotent (a
 * duplicate POST fails with 81057), so upsert is search → create/update —
 * and a lost concurrent-create race is settled with one re-look-up (2 POSTs
 * max) before falling back to the update path. Every operation resolves the
 * target hostname through the Phase 2 default-hostname model and refuses to
 * touch anything outside `d-*.<zone>` (or an ACM validation name directly
 * beneath one) BEFORE the transport is invoked.
 *
 * The routing CNAME (`d-<id>.<zone>` → ALB) is proxied, so `ttl: 1` is
 * forced. The validation CNAME (`_<label>.d-<id>.<zone>` → ACM value) must
 * NOT be proxied — a proxied record hides the record from ACM's DNS-01
 * validation — and carries its own static comment.
 */

import {
  assertMutableDefaultHostname,
  DEFAULT_HOSTNAME_PREFIX,
  getDefaultDeploymentHostname,
} from './default-https.js';

// ── Name-writer seam (no-op / legacy-adjacent writers) ───────────────────────
//
// A narrow CNAME-writer shape for DNS providers that cannot read records back
// (Phase 16: the real Route53 writer was removed, so the only remaining
// writer is the no-op used when the default-HTTPS flow is off or running
// under the fixture namespace). createDnsClientFromNameWriter adapts it to
// the deployment-keyed CloudflareDnsClient seam.

export interface DnsRecordClient {
  /** Create or overwrite one CNAME record. */
  upsertCname(name: string, value: string): Promise<void>;
  /** Delete one CNAME record; a record that is already gone is not an error. */
  deleteCname(name: string): Promise<void>;
}

/** A no-op writer — DNS fixture mode and the off configuration. */
export const noopDnsRecordClient: DnsRecordClient = {
  async upsertCname() {},
  async deleteCname() {},
};

const DEFAULT_API_BASE_URL = 'https://api.cloudflare.com/client/v4';
const DEFAULT_TIMEOUT_MS = 10_000;

/** Static comment on every Deployz-owned default-HTTPS routing record (no secrets). */
export const CLOUDFLARE_RECORD_COMMENT = 'deployz-default-https';

/** Static comment on every ACM validation record the client writes. */
export const CLOUDFLARE_VALIDATION_RECORD_COMMENT = 'deployz-default-https-validation';

// ── Error taxonomy ──────────────────────────────────────────────────────────

export type CloudflareDnsErrorCode =
  | 'CLOUDFLARE_AUTH_FAILED'
  | 'CLOUDFLARE_PERMISSION_DENIED'
  | 'CLOUDFLARE_RATE_LIMITED'
  | 'CLOUDFLARE_DNS_CONFLICT'
  | 'CLOUDFLARE_UNAVAILABLE';

export class CloudflareDnsError extends Error {
  readonly code: CloudflareDnsErrorCode;
  readonly status?: number;
  readonly retryAfterSeconds?: number;

  constructor(
    message: string,
    code: CloudflareDnsErrorCode,
    details?: { status?: number; retryAfterSeconds?: number },
  ) {
    super(message);
    this.name = 'CloudflareDnsError';
    this.code = code;
    if (details?.status !== undefined) this.status = details.status;
    if (details?.retryAfterSeconds !== undefined) this.retryAfterSeconds = details.retryAfterSeconds;
  }
}

// ── Wire types ──────────────────────────────────────────────────────────────

/** Injectable transport — the real client defaults to global fetch. */
export type CloudflareFetchFn = (url: string, init: RequestInit) => Promise<Response>;

/** The slice of a Cloudflare DNS record this client reads and writes. */
export interface CloudflareDnsRecord {
  readonly id: string;
  readonly type: string;
  readonly name: string;
  readonly content: string;
  readonly ttl: number;
  readonly proxied: boolean;
  readonly comment?: string;
}

export type CloudflareDnsUpsertResult = {
  op: 'created' | 'updated' | 'noop';
  record: CloudflareDnsRecord | null;
};

export type CloudflareDnsDeleteResult = { op: 'deleted' | 'noop' };

export interface CloudflareDnsClient {
  /** The CNAME record Cloudflare currently has for the deployment, or null. */
  getRecord(deploymentId: string): Promise<CloudflareDnsRecord | null>;
  /** Search → create/update/no-op so a repeat call never duplicates. */
  upsertDefaultDeploymentRecord(deploymentId: string, target: string): Promise<CloudflareDnsUpsertResult>;
  /** Delete the deployment's record; an already-missing record is a no-op. */
  deleteDefaultDeploymentRecord(deploymentId: string): Promise<CloudflareDnsDeleteResult>;
  /** Reconcile the ACM validation CNAME (`_<label>.d-<id>.<zone>`), unproxied. */
  upsertDefaultValidationRecord(
    deploymentId: string,
    validationName: string,
    validationValue: string,
  ): Promise<CloudflareDnsUpsertResult>;
  /** Delete the deployment's validation CNAME; already-missing is a no-op. */
  deleteDefaultValidationRecord(deploymentId: string, validationName: string): Promise<CloudflareDnsDeleteResult>;
  /** List the zone's CNAMEs under this client's default-hostname prefix
   *  (`d-`), bounded to `perPage` (default 100) records per page and at most
   *  `maxPages` (default 3) pages — the routing-record sweep the purge
   *  orphan reconciliation reads. No mutation, and records are returned
   *  UNGUARDED: a caller must pass each name through its own
   *  `d-<uuid>.<zone>` parse before deleting anything. */
  listDefaultRecords(options?: { perPage?: number; maxPages?: number }): Promise<CloudflareDnsRecord[]>;
}

export interface CloudflareDnsClientOptions {
  readonly token: string;
  readonly zoneId: string;
  /** The registrable zone (`deployz.dev`) — the namespace-guard boundary. */
  readonly zoneName: string;
  readonly prefix?: string;
  readonly fetchFn?: CloudflareFetchFn;
  readonly apiBaseUrl?: string;
  readonly timeoutMs?: number;
}

// ── Namespace guard ─────────────────────────────────────────────────────────

/**
 * Resolves a deployment id to its default hostname and refuses anything that
 * is not a mutable `d-*.<zone>` name (Phase 2 model). Thrown BEFORE any
 * transport call, so reserved/mis-scoped inputs can never reach Cloudflare.
 */
function makeHostnameGuard(prefix: string, zoneName: string) {
  const config = { prefix, zone: zoneName };
  return (deploymentId: string): string => {
    try {
      const hostname = getDefaultDeploymentHostname(deploymentId, config);
      assertMutableDefaultHostname(hostname, config);
      return hostname;
    } catch {
      throw new CloudflareDnsError(
        `Refusing to touch DNS for ${JSON.stringify(deploymentId)}: not a mutable default deployment hostname.`,
        'CLOUDFLARE_DNS_CONFLICT',
      );
    }
  };
}

/**
 * ACM reports its DNS-01 record name as an absolute name with a trailing
 * dot (`_<digest>.d-<id>.<zone>.`), and the relay forwards it verbatim.
 * Cloudflare names records without the dot, and the namespace guard below
 * compares against the dot-less hostname — production-verified: every
 * default-HTTPS DNS write was refused as CLOUDFLARE_DNS_CONFLICT before
 * reaching the transport, so no deployment ever left WAITING_FOR_DNS. One
 * trailing dot is the only thing stripped.
 */
function stripTrailingDot(name: string): string {
  return name.endsWith('.') ? name.slice(0, -1) : name;
}

/**
 * Refuses an ACM validation name unless it is exactly `<label>.<hostname>`
 * where `hostname` is the deployment's already-guarded mutable default
 * hostname. The ACM CNAME for a deployment is always one label beneath the
 * hostname it validates (`_<digest>.d-<id>.<zone>`), so anything else —
 * a reserved hostname, a wrong zone, a multi-label prefix — never reaches
 * the transport. `hostname` MUST already have passed the mutable-hostname
 * guard.
 */
function assertValidationRecordName(hostname: string, validationName: string): void {
  const lowerHostname = hostname.toLowerCase();
  const lowerName = validationName.toLowerCase();
  const suffix = `.${lowerHostname}`;
  const label = lowerName.length > suffix.length && lowerName.endsWith(suffix)
    ? lowerName.slice(0, -suffix.length)
    : '';
  if (label.length === 0 || label.includes('.')) {
    throw new CloudflareDnsError(
      `Refusing to touch DNS for ${JSON.stringify(validationName)}: not a validation record of a mutable default deployment hostname.`,
      'CLOUDFLARE_DNS_CONFLICT',
    );
  }
}

// ── Response classification (single place) ─────────────────────────────────

const CONFLICT_API_CODES = new Set([81053, 81057, 81058]);

function apiErrorCodes(payload: unknown): number[] {
  if (typeof payload !== 'object' || payload === null) return [];
  const errors = (payload as Record<string, unknown>)['errors'];
  if (!Array.isArray(errors)) return [];
  const codes: number[] = [];
  for (const entry of errors) {
    if (typeof entry === 'object' && entry !== null) {
      const code = (entry as Record<string, unknown>)['code'];
      if (typeof code === 'number') codes.push(code);
    }
  }
  return codes;
}

function firstApiErrorMessage(payload: unknown): string | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const errors = (payload as Record<string, unknown>)['errors'];
  if (!Array.isArray(errors)) return undefined;
  for (const entry of errors) {
    if (typeof entry === 'object' && entry !== null) {
      const message = (entry as Record<string, unknown>)['message'];
      if (typeof message === 'string' && message.length > 0) return message;
    }
  }
  return undefined;
}

function parseRetryAfterSeconds(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const seconds = Number.parseInt(value, 10);
  return Number.isFinite(seconds) ? seconds : undefined;
}

function asRecord(value: unknown): CloudflareDnsRecord | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  const { id, type, name, content } = record;
  if (
    typeof id !== 'string' ||
    typeof type !== 'string' ||
    typeof name !== 'string' ||
    typeof content !== 'string'
  ) {
    return null;
  }
  return {
    id,
    type,
    name,
    content,
    ttl: typeof record['ttl'] === 'number' ? record['ttl'] : 1,
    proxied: record['proxied'] === true,
    ...(typeof record['comment'] === 'string' ? { comment: record['comment'] } : {}),
  };
}

/** Success ⇔ HTTP 2xx AND `success === true`. */
function isApiSuccess(status: number, payload: unknown): boolean {
  if (status < 200 || status >= 300) return false;
  return (
    typeof payload === 'object' && payload !== null && (payload as { success?: unknown })['success'] === true
  );
}

function classifyFailure(status: number, payload: unknown, retryAfterSeconds?: number): CloudflareDnsError {
  const codes = apiErrorCodes(payload);
  const detail = firstApiErrorMessage(payload);
  if (status === 429) {
    return new CloudflareDnsError(
      'Cloudflare rate limit exceeded.',
      'CLOUDFLARE_RATE_LIMITED',
      { status, ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}) },
    );
  }
  if (codes.includes(9109)) {
    // 9109 = invalid API token. Checked before the 403 branch: Cloudflare can
    // report it with any auth-failing status.
    return new CloudflareDnsError(
      detail ?? 'Cloudflare rejected the API token.',
      'CLOUDFLARE_AUTH_FAILED',
      { status },
    );
  }
  if (status === 401) {
    return new CloudflareDnsError('Cloudflare request was not authenticated.', 'CLOUDFLARE_AUTH_FAILED', {
      status,
    });
  }
  if (status === 403) {
    return new CloudflareDnsError(
      detail ?? 'Cloudflare denied permission for this zone.',
      'CLOUDFLARE_PERMISSION_DENIED',
      { status },
    );
  }
  if (codes.some((code) => CONFLICT_API_CODES.has(code))) {
    return new CloudflareDnsError(
      detail ?? 'Cloudflare reports a conflicting DNS record.',
      'CLOUDFLARE_DNS_CONFLICT',
      { status },
    );
  }
  // Every other failure — unknown 4xx, 5xx, malformed (non-JSON) 5xx body —
  // is "unavailable" to the caller; no invented codes.
  return new CloudflareDnsError(
    detail ?? `Cloudflare API request failed (HTTP ${status}).`,
    'CLOUDFLARE_UNAVAILABLE',
    { status },
  );
}

// ── Real client ─────────────────────────────────────────────────────────────

export function createCloudflareDnsClient(options: CloudflareDnsClientOptions): CloudflareDnsClient {
  const {
    token,
    zoneId,
    zoneName,
    prefix = DEFAULT_HOSTNAME_PREFIX,
    apiBaseUrl = DEFAULT_API_BASE_URL,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = options;
  const fetchFn: CloudflareFetchFn =
    options.fetchFn ?? ((url: string, init: RequestInit) => globalThis.fetch(url, init));
  const hostnameFor = makeHostnameGuard(prefix, zoneName);

  async function callApi(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    body?: string,
  ): Promise<{ status: number; payload: unknown; retryAfterSeconds: number | undefined }> {
    let response: Response;
    try {
      response = await fetchFn(`${apiBaseUrl}${path}`, {
        method,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        ...(body === undefined ? {} : { body }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      // Transport throw or AbortSignal timeout — nothing usable came back.
      throw new CloudflareDnsError(
        'Cloudflare API request failed (network error or timeout).',
        'CLOUDFLARE_UNAVAILABLE',
      );
    }
    const retryAfterSeconds = parseRetryAfterSeconds(response.headers.get('retry-after'));
    let payload: unknown = null;
    try {
      payload = await response.json();
    } catch {
      // Non-JSON body (an HTML 5xx page, an empty body) — not a crash.
    }
    return { status: response.status, payload, retryAfterSeconds };
  }

  async function listRecord(hostname: string): Promise<CloudflareDnsRecord | null> {
    const path = `/zones/${zoneId}/dns_records?type=CNAME&name.exact=${encodeURIComponent(hostname)}`;
    const { status, payload, retryAfterSeconds } = await callApi('GET', path);
    if (!isApiSuccess(status, payload)) {
      throw classifyFailure(status, payload, retryAfterSeconds);
    }
    const result = (payload as { result?: unknown })['result'];
    if (!Array.isArray(result)) return null;
    // name.exact already filters; the first exact match is authoritative
    // (defensive against a Cloudflare result that contains look-alikes).
    for (const entry of result) {
      const record = asRecord(entry);
      if (record && record.name.toLowerCase() === hostname.toLowerCase()) return record;
    }
    return null;
  }

  /**
   * The routing-record sweep: every CNAME in the zone whose name starts with
   * the default-hostname prefix. Bounded pagination (per_page=100, at most
   * `maxPages` pages) so a purge pass can never balloon into an unbounded
   * scan. Records are returned unguarded — the orphan reconciliation parses
   * each name itself before it deletes anything.
   */
  async function listDefaultRecordsImpl(options?: {
    perPage?: number;
    maxPages?: number;
  }): Promise<CloudflareDnsRecord[]> {
    const perPage = options?.perPage ?? 100;
    const maxPages = options?.maxPages ?? 3;
    const out: CloudflareDnsRecord[] = [];
    for (let page = 1; page <= maxPages; page += 1) {
      const path =
        `/zones/${zoneId}/dns_records?type=CNAME` +
        `&name.startswith=${encodeURIComponent(prefix)}&per_page=${perPage}&page=${page}`;
      const { status, payload, retryAfterSeconds } = await callApi('GET', path);
      if (!isApiSuccess(status, payload)) {
        throw classifyFailure(status, payload, retryAfterSeconds);
      }
      const result = (payload as { result?: unknown })['result'];
      if (!Array.isArray(result)) break;
      for (const entry of result) {
        const record = asRecord(entry);
        if (record) out.push(record);
      }
      if (result.length < perPage) break; // short page = no more records
    }
    return out;
  }

  /** The CNAME body shared by routing (proxied) and validation (unproxied) writes. */
  function recordBody(name: string, content: string, proxied: boolean, comment: string): string {
    return JSON.stringify({ type: 'CNAME', name, content, ttl: 1, proxied, comment });
  }

  async function writeRecord(method: 'POST' | 'PUT', path: string, body: string): Promise<CloudflareDnsRecord> {
    const { status, payload, retryAfterSeconds } = await callApi(method, path, body);
    if (!isApiSuccess(status, payload)) {
      throw classifyFailure(status, payload, retryAfterSeconds);
    }
    const record = asRecord((payload as { result?: unknown })['result']);
    if (!record) {
      throw new CloudflareDnsError(
        'Cloudflare returned an unrecognisable DNS record.',
        'CLOUDFLARE_UNAVAILABLE',
      );
    }
    return record;
  }

  async function reconcile(
    existing: CloudflareDnsRecord,
    name: string,
    content: string,
    proxied: boolean,
    comment: string,
  ): Promise<CloudflareDnsUpsertResult> {
    if (existing.content === content && existing.proxied === proxied) {
      return { op: 'noop', record: existing };
    }
    const record = await writeRecord(
      'PUT',
      `/zones/${zoneId}/dns_records/${encodeURIComponent(existing.id)}`,
      recordBody(name, content, proxied, comment),
    );
    return { op: 'updated', record };
  }

  async function ensureRecord(
    name: string,
    content: string,
    proxied: boolean,
    comment: string,
  ): Promise<CloudflareDnsUpsertResult> {
    const existing = await listRecord(name);
    if (existing) {
      return reconcile(existing, name, content, proxied, comment);
    }
    try {
      const record = await writeRecord('POST', `/zones/${zoneId}/dns_records`, recordBody(name, content, proxied, comment));
      return { op: 'created', record };
    } catch (error) {
      if (!(error instanceof CloudflareDnsError && error.code === 'CLOUDFLARE_DNS_CONFLICT')) {
        throw error;
      }
      // A lost concurrent-create race (81057). Re-look-up once: adopt the
      // winner if it is now visible, otherwise one more create (2 POSTs max)
      // and let that outcome stand.
      const winner = await listRecord(name);
      if (winner) {
        return reconcile(winner, name, content, proxied, comment);
      }
      const record = await writeRecord('POST', `/zones/${zoneId}/dns_records`, recordBody(name, content, proxied, comment));
      return { op: 'created', record };
    }
  }

  async function removeRecord(name: string): Promise<CloudflareDnsDeleteResult> {
    const existing = await listRecord(name);
    if (!existing) {
      return { op: 'noop' };
    }
    const { status, payload, retryAfterSeconds } = await callApi(
      'DELETE',
      `/zones/${zoneId}/dns_records/${encodeURIComponent(existing.id)}`,
    );
    if (isApiSuccess(status, payload)) {
      return { op: 'deleted' };
    }
    if (apiErrorCodes(payload).includes(81044)) {
      // 81044 "Record does not exist." — already gone, idempotent delete.
      return { op: 'noop' };
    }
    throw classifyFailure(status, payload, retryAfterSeconds);
  }

  return {
    getRecord: async (deploymentId) => listRecord(hostnameFor(deploymentId)),
    upsertDefaultDeploymentRecord: async (deploymentId, target) =>
      ensureRecord(hostnameFor(deploymentId), target, true, CLOUDFLARE_RECORD_COMMENT),
    deleteDefaultDeploymentRecord: async (deploymentId) => removeRecord(hostnameFor(deploymentId)),
    upsertDefaultValidationRecord: async (deploymentId, validationName, validationValue) => {
      const hostname = hostnameFor(deploymentId);
      const name = stripTrailingDot(validationName);
      assertValidationRecordName(hostname, name);
      return ensureRecord(name, validationValue, false, CLOUDFLARE_VALIDATION_RECORD_COMMENT);
    },
    deleteDefaultValidationRecord: async (deploymentId, validationName) => {
      const hostname = hostnameFor(deploymentId);
      const name = stripTrailingDot(validationName);
      assertValidationRecordName(hostname, name);
      return removeRecord(name);
    },
    listDefaultRecords: listDefaultRecordsImpl,
  };
}

// ── In-memory fake ──────────────────────────────────────────────────────────

export interface FakeCloudflareDnsClient extends CloudflareDnsClient {
  /** The full in-memory record set — for fixture-mode assertions. */
  listRecords(): readonly CloudflareDnsRecord[];
}

export function createFakeCloudflareDnsClient(options: {
  readonly zoneId: string;
  readonly zoneName: string;
  readonly prefix?: string;
}): FakeCloudflareDnsClient {
  // `zoneId` is accepted for call-site symmetry with the real client but an
  // in-memory store never needs it.
  const { zoneName, prefix = DEFAULT_HOSTNAME_PREFIX } = options;
  const hostnameFor = makeHostnameGuard(prefix, zoneName);
  const store = new Map<string, CloudflareDnsRecord>();
  let nextId = 1;

  function recordFor(name: string): CloudflareDnsRecord | null {
    return store.get(name.toLowerCase()) ?? null;
  }

  function save(record: CloudflareDnsRecord): void {
    store.set(record.name.toLowerCase(), record);
  }

  function putRecord(name: string, content: string, proxied: boolean, comment: string): CloudflareDnsRecord {
    const record: CloudflareDnsRecord = {
      id: `rec-${nextId++}`,
      type: 'CNAME',
      name,
      content,
      ttl: 1,
      proxied,
      comment,
    };
    save(record);
    return record;
  }

  function upsertRecord(
    name: string,
    content: string,
    proxied: boolean,
    comment: string,
  ): CloudflareDnsUpsertResult {
    const existing = recordFor(name);
    if (!existing) {
      return { op: 'created', record: putRecord(name, content, proxied, comment) };
    }
    if (existing.content === content && existing.proxied === proxied) {
      return { op: 'noop', record: existing };
    }
    const updated: CloudflareDnsRecord = { ...existing, content, proxied };
    save(updated);
    return { op: 'updated', record: updated };
  }

  function deleteRecord(name: string): CloudflareDnsDeleteResult {
    const existing = recordFor(name);
    if (!existing) {
      return { op: 'noop' };
    }
    store.delete(name.toLowerCase());
    return { op: 'deleted' };
  }

  return {
    listRecords: () => [...store.values()],
    getRecord: async (deploymentId) => recordFor(hostnameFor(deploymentId)),
    upsertDefaultDeploymentRecord: async (deploymentId, target) =>
      upsertRecord(hostnameFor(deploymentId), target, true, CLOUDFLARE_RECORD_COMMENT),
    deleteDefaultDeploymentRecord: async (deploymentId) => deleteRecord(hostnameFor(deploymentId)),
    upsertDefaultValidationRecord: async (deploymentId, validationName, validationValue) => {
      const hostname = hostnameFor(deploymentId);
      assertValidationRecordName(hostname, validationName);
      return upsertRecord(validationName, validationValue, false, CLOUDFLARE_VALIDATION_RECORD_COMMENT);
    },
    deleteDefaultValidationRecord: async (deploymentId, validationName) => {
      const hostname = hostnameFor(deploymentId);
      assertValidationRecordName(hostname, validationName);
      return deleteRecord(validationName);
    },
    listDefaultRecords: async (options) => {
      const perPage = options?.perPage ?? 100;
      const maxPages = options?.maxPages ?? 3;
      return [...store.values()]
        .filter((record) => record.type === 'CNAME' && record.name.toLowerCase().startsWith(prefix))
        .slice(0, perPage * maxPages);
    },
  };
}

// ── Name-writer adapter ──────────────────────────────────────────────────────

/**
 * Adapts a name-based record writer (the no-op used when the default-HTTPS
 * flow is off or under the fixture namespace) to the deployment-keyed machine
 * seam. The no-op UPSERT is idempotent per name and cannot be read back, so
 * the deployment ops forward straight to the minted FQDN / given validation
 * name.
 */
export function createDnsClientFromNameWriter(
  writer: DnsRecordClient,
  options: { zoneName: string; prefix?: string },
): CloudflareDnsClient {
  const hostnameFor = makeHostnameGuard(options.prefix ?? DEFAULT_HOSTNAME_PREFIX, options.zoneName);
  return {
    getRecord: async (deploymentId) => {
      hostnameFor(deploymentId); // guard the id even though a name writer cannot read records back
      return null;
    },
    upsertDefaultDeploymentRecord: async (deploymentId, target) => {
      await writer.upsertCname(hostnameFor(deploymentId), target);
      return { op: 'updated', record: null };
    },
    deleteDefaultDeploymentRecord: async (deploymentId) => {
      await writer.deleteCname(hostnameFor(deploymentId));
      return { op: 'deleted' };
    },
    upsertDefaultValidationRecord: async (deploymentId, validationName, validationValue) => {
      hostnameFor(deploymentId); // the name writer itself is unguarded; keep the id valid
      await writer.upsertCname(validationName, validationValue);
      return { op: 'updated', record: null };
    },
    deleteDefaultValidationRecord: async (deploymentId, validationName) => {
      hostnameFor(deploymentId);
      await writer.deleteCname(validationName);
      return { op: 'deleted' };
    },
    // A name-based writer cannot read its records back, so the sweep sees
    // nothing to reconcile; the Cloudflare path does the real reconciliation.
    listDefaultRecords: async () => [],
  };
}
