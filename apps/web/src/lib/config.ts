// §31 application configuration — data access for the config screen. The
// config API masks secrets (value: null for isSecret entries — plaintext
// never crosses the wire); this client mirrors that contract and falls back
// to realistic FIXTURE data on a 404 (same pattern as todo 19/25) so the
// screen renders without seeded backend data. §65: copy is jargon-free.

const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

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

function isNotFound(error: unknown): boolean {
  return error instanceof Error && error.message.includes('(404)');
}

/** Fetch an application's config, falling back to fixture data on 404. */
export async function fetchConfig(
  applicationId: string,
  customerId?: string,
): Promise<ApplicationConfig> {
  try {
    const query = customerId ? `?customerId=${encodeURIComponent(customerId)}` : '';
    return await getJson<ApplicationConfig>(
      `/api/applications/${encodeURIComponent(applicationId)}/config${query}`,
    );
  } catch (error) {
    if (isNotFound(error)) return fixtureConfig(applicationId);
    throw error;
  }
}

/**
 * Write config entries for one scope (vendor defaults when customerId is
 * null, customer overrides otherwise). Secret entries carry the NEW plaintext
 * on the write path only — the response is always masked. Falls back to a
 * locally merged fixture view on 404.
 */
export async function saveConfig(
  applicationId: string,
  customerId: string | null,
  entries: readonly ConfigEntry[],
): Promise<ApplicationConfig> {
  try {
    return await putJson<ApplicationConfig>(
      `/api/applications/${encodeURIComponent(applicationId)}/config`,
      { customerId, entries },
    );
  } catch (error) {
    if (isNotFound(error)) return fixtureSave(applicationId, customerId, entries);
    throw error;
  }
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

// ── Fixture data (§65 jargon-free; secrets masked — never plaintext) ──────

/** The fixture customer the overrides group renders for. */
export const FIXTURE_CONFIG_CUSTOMER_ID = 'fixture-customer-acme';

/**
 * Realistic fixture fallback while an application has no backend rows. The
 * fixture is what the API would return AFTER masking — secret values are
 * null here too, so plaintext never exists anywhere in the client.
 */
export function fixtureConfig(applicationId: string): ApplicationConfig {
  const vendorDefaults: MaskedConfigEntry[] = [
    { key: 'DATABASE_URL', isSecret: true, value: null },
    { key: 'LOG_LEVEL', isSecret: false, value: 'info' },
    { key: 'MAX_CONNECTIONS', isSecret: false, value: '10' },
  ];
  const customerOverrides: MaskedConfigEntry[] = [
    { key: 'LOG_LEVEL', isSecret: false, value: 'debug' },
    { key: 'API_KEY', isSecret: true, value: null },
  ];
  return {
    applicationId,
    customerId: FIXTURE_CONFIG_CUSTOMER_ID,
    vendorDefaults,
    customerOverrides,
    effective: mergeConfig(vendorDefaults, customerOverrides),
  };
}

/**
 * Fixture-mode save: apply the write to the fixture scope and return the
 * updated (masked) view — the same shape the real API returns. Untouched
 * secrets (empty value) are skipped; written secrets come back masked.
 */
function fixtureSave(
  applicationId: string,
  customerId: string | null,
  entries: readonly ConfigEntry[],
): ApplicationConfig {
  const current = fixtureConfig(applicationId);
  const scope = customerId === null ? 'vendorDefaults' : 'customerOverrides';
  const updated = {
    ...current,
    customerId,
    [scope]: applyWrite(current[scope], entries),
  };
  return {
    ...updated,
    effective: mergeConfig(updated.vendorDefaults, updated.customerOverrides),
  };
}

function applyWrite(
  entries: readonly MaskedConfigEntry[],
  writes: readonly ConfigEntry[],
): MaskedConfigEntry[] {
  const rows = entries.map((entry) => ({ ...entry }));
  for (const write of writes) {
    if (write.isSecret && write.value.length === 0) continue; // untouched secret
    const masked: MaskedConfigEntry = write.isSecret
      ? { key: write.key, isSecret: true, value: null }
      : { key: write.key, isSecret: false, value: write.value };
    const index = rows.findIndex((row) => row.key === write.key);
    if (index >= 0) {
      rows[index] = masked;
    } else {
      rows.push(masked);
    }
  }
  return rows;
}
