/**
 * Cloudflare DNS record client — the CNAME surface the default-HTTPS feature
 * uses once the deployz.dev zone's DNS lives on Cloudflare (Phase 3).
 *
 * Mirrors the house idiom of route53-records.ts (narrow injectable seam +
 * real implementation + in-memory fake): one record type (CNAME), three
 * operations (look up, upsert, delete), and an injectable transport so a
 * test never reaches api.cloudflare.com. The single credential is a
 * zone-scoped API token sent as `Authorization: Bearer` — it never appears
 * in an error message or thrown field.
 *
 * Cloudflare has no server-side DNS upsert and create is NOT idempotent (a
 * duplicate POST fails with 81057), so upsert is search → create/update —
 * and a lost concurrent-create race is settled with one re-look-up (2 POSTs
 * max) before falling back to the update path. Every operation resolves the
 * target hostname through the Phase 2 default-hostname model and refuses to
 * touch anything outside `d-*.<zone>` BEFORE the transport is invoked.
 */

import {
  assertMutableDefaultHostname,
  DEFAULT_HOSTNAME_PREFIX,
  getDefaultDeploymentHostname,
} from './default-https.js';

const DEFAULT_API_BASE_URL = 'https://api.cloudflare.com/client/v4';
const DEFAULT_TIMEOUT_MS = 10_000;

/** Static comment on every Deployz-owned default-HTTPS record (no secrets). */
export const CLOUDFLARE_RECORD_COMMENT = 'deployz-default-https';

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

  async function writeRecord(
    method: 'POST' | 'PUT',
    path: string,
    hostname: string,
    target: string,
  ): Promise<CloudflareDnsRecord> {
    const { status, payload, retryAfterSeconds } = await callApi(
      method,
      path,
      JSON.stringify({
        type: 'CNAME',
        name: hostname,
        content: target,
        ttl: 1, // proxied records force TTL auto
        proxied: true,
        comment: CLOUDFLARE_RECORD_COMMENT,
      }),
    );
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

  async function reconcile(hostname: string, existing: CloudflareDnsRecord, target: string) {
    if (existing.content === target && existing.proxied === true) {
      return { op: 'noop' as const, record: existing };
    }
    const record = await writeRecord('PUT', `/zones/${zoneId}/dns_records/${encodeURIComponent(existing.id)}`, hostname, target);
    return { op: 'updated' as const, record };
  }

  async function upsert(hostname: string, target: string): Promise<CloudflareDnsUpsertResult> {
    const existing = await listRecord(hostname);
    if (existing) {
      return reconcile(hostname, existing, target);
    }
    try {
      const record = await writeRecord('POST', `/zones/${zoneId}/dns_records`, hostname, target);
      return { op: 'created', record };
    } catch (error) {
      if (!(error instanceof CloudflareDnsError && error.code === 'CLOUDFLARE_DNS_CONFLICT')) {
        throw error;
      }
      // A lost concurrent-create race (81057). Re-look-up once: adopt the
      // winner if it is now visible, otherwise one more create (2 POSTs max)
      // and let that outcome stand.
      const winner = await listRecord(hostname);
      if (winner) {
        return reconcile(hostname, winner, target);
      }
      const record = await writeRecord('POST', `/zones/${zoneId}/dns_records`, hostname, target);
      return { op: 'created', record };
    }
  }

  async function remove(hostname: string): Promise<CloudflareDnsDeleteResult> {
    const existing = await listRecord(hostname);
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
    upsertDefaultDeploymentRecord: async (deploymentId, target) => upsert(hostnameFor(deploymentId), target),
    deleteDefaultDeploymentRecord: async (deploymentId) => remove(hostnameFor(deploymentId)),
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
  const { zoneId, zoneName, prefix = DEFAULT_HOSTNAME_PREFIX } = options;
  const hostnameFor = makeHostnameGuard(prefix, zoneName);
  const store = new Map<string, CloudflareDnsRecord>();
  let nextId = 1;

  function recordFor(hostname: string): CloudflareDnsRecord | null {
    return store.get(hostname.toLowerCase()) ?? null;
  }

  function save(record: CloudflareDnsRecord): void {
    store.set(record.name.toLowerCase(), record);
  }

  function putRecord(hostname: string, content: string): CloudflareDnsRecord {
    const record: CloudflareDnsRecord = {
      id: `rec-${nextId++}`,
      type: 'CNAME',
      name: hostname,
      content,
      ttl: 1,
      proxied: true,
      comment: CLOUDFLARE_RECORD_COMMENT,
    };
    save(record);
    return record;
  }

  return {
    listRecords: () => [...store.values()],
    getRecord: async (deploymentId) => recordFor(hostnameFor(deploymentId)),
    upsertDefaultDeploymentRecord: async (deploymentId, target) => {
      const hostname = hostnameFor(deploymentId);
      const existing = recordFor(hostname);
      if (!existing) {
        return { op: 'created', record: putRecord(hostname, target) };
      }
      if (existing.content === target && existing.proxied === true) {
        return { op: 'noop', record: existing };
      }
      const updated: CloudflareDnsRecord = { ...existing, content: target, proxied: true };
      save(updated);
      return { op: 'updated', record: updated };
    },
    deleteDefaultDeploymentRecord: async (deploymentId) => {
      const hostname = hostnameFor(deploymentId);
      const existing = recordFor(hostname);
      if (!existing) {
        return { op: 'noop' };
      }
      store.delete(hostname.toLowerCase());
      return { op: 'deleted' };
    },
  };
}
