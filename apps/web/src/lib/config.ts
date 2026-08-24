// §31 application configuration — data access for the config screen. The
// config API masks secrets (value: null for isSecret entries — plaintext
// never crosses the wire) and this client mirrors that contract. A 404 is
// surfaced, never swallowed: the API now returns 404 for an application the
// caller's organization does not own, and silently rendering placeholder
// config — or reporting a failed save as a success — would be misleading.
// §65: copy is jargon-free.

import { apiUrl } from '@/lib/api-url';

// ── Wire shapes ────────────────────────────────────────────────────────────

/** A config entry as WRITTEN to the API (secrets carry the new plaintext). */
export interface ConfigEntry {
  key: string;
  value: string;
  isSecret: boolean;
}

/** A config entry as the API returns it — secrets NEVER carry a value. */
export interface MaskedConfigEntry {
  key: string;
  isSecret: boolean;
  /** Null for secrets (write-only, §31); the plaintext value otherwise. */
  value: string | null;
}

/** The effective entry after merging vendor defaults with customer overrides. */
export interface EffectiveConfigEntry extends MaskedConfigEntry {
  /** Where the effective value comes from — customer overrides win (§31). */
  source: 'vendor' | 'customer';
  /** The vendor default when a customer override is in effect (null for secrets). */
  vendorValue: string | null;
}

/** Everything the config screen needs for one application + customer scope. */
export interface ApplicationConfig {
  applicationId: string;
  /** Null when viewing vendor defaults; the customer id when scoped. */
  customerId: string | null;
  /** The scoped customer's name — the screen names the customer, never its id. */
  customerName: string | null;
  vendorDefaults: MaskedConfigEntry[];
  customerOverrides: MaskedConfigEntry[];
  effective: EffectiveConfigEntry[];
}

// ── Fetch helpers ──────────────────────────────────────────────────────────

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(`${apiUrl}${path}`, {
    credentials: 'include',
    cache: 'no-store',
  });
  if (!response.ok) {
    throw new Error(`Config request failed (${response.status})`);
  }
  return (await response.json()) as T;
}

async function putJson<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`${apiUrl}${path}`, {
    method: 'PUT',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`Config request failed (${response.status})`);
  }
  return (await response.json()) as T;
}

/** Fetch an application's config. A 404 propagates to the caller. */
export async function fetchConfig(
  applicationId: string,
  customerId?: string,
): Promise<ApplicationConfig> {
  const query = customerId ? `?customerId=${encodeURIComponent(customerId)}` : '';
  return getJson<ApplicationConfig>(
    `/api/applications/${encodeURIComponent(applicationId)}/config${query}`,
  );
}

/**
 * Write config entries for one scope (vendor defaults when customerId is
 * null, customer overrides otherwise). Secret entries carry the NEW plaintext
 * on the write path only — the response is always masked. A failed write
 * throws; it must never be reported to the vendor as a successful save.
 */
export async function saveConfig(
  applicationId: string,
  customerId: string | null,
  entries: readonly ConfigEntry[],
  deletes: readonly string[] = [],
): Promise<ApplicationConfig> {
  return putJson<ApplicationConfig>(
    `/api/applications/${encodeURIComponent(applicationId)}/config`,
    { customerId, entries, deletes },
  );
}

// ── Vendor/customer merge (pure) ───────────────────────────────────────────

/**
 * Merge vendor defaults with customer overrides into the effective config
 * (§31: a customer override takes precedence over the vendor default with the
 * same key). Mirrors the API's merge — secrets stay masked throughout.
 */
export function mergeConfig(
  vendorDefaults: readonly MaskedConfigEntry[],
  customerOverrides: readonly MaskedConfigEntry[],
): EffectiveConfigEntry[] {
  const order: string[] = [];
  const byKey = new Map<string, EffectiveConfigEntry>();

  for (const row of vendorDefaults) {
    order.push(row.key);
    byKey.set(row.key, { ...row, source: 'vendor', vendorValue: null });
  }
  for (const row of customerOverrides) {
    const vendor = byKey.get(row.key);
    if (vendor) {
      byKey.set(row.key, { ...row, source: 'customer', vendorValue: vendor.value });
    } else {
      order.push(row.key);
      byKey.set(row.key, { ...row, source: 'customer', vendorValue: null });
    }
  }

  const merged: EffectiveConfigEntry[] = [];
  for (const key of order) {
    const entry = byKey.get(key);
    if (entry) merged.push(entry);
  }
  return merged;
}
