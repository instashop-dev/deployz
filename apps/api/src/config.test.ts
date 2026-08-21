import { describe, expect, it } from 'vitest';

import {
  SECRET_MASK,
  getConfig,
  mergeConfigEntries,
  setConfig,
  setConfigBodySchema,
  toMaskedEntry,
  type ConfigEntry,
  type ConfigSecretWriter,
  type ConfigStore,
} from './config.js';
import { ApiError } from './errors.js';

// Todo 26 — application configuration API logic. The DB boundary
// (ConfigStore) and the §31 relay write-through (ConfigSecretWriter) are
// injectable seams, exercised here with in-memory mocks — no PGlite, no AWS.
// The load-bearing assertions are the secret boundary: the API NEVER returns
// a plaintext secret, and the control-plane store never persists one.

const APP_ID = 'app-1';
const CUSTOMER_ID = 'customer-1';

/** In-memory ConfigStore mock: rows keyed by `${scope}:${key}`. */
function createMockStore(input: {
  exists?: boolean;
  vendorDefaults?: readonly ConfigEntry[];
  overrides?: Record<string, readonly ConfigEntry[]>;
}): ConfigStore & { written: { customerId: string | null; entry: ConfigEntry }[] } {
  const written: { customerId: string | null; entry: ConfigEntry }[] = [];
  const vendorRows = [...(input.vendorDefaults ?? [])];
  const overrideRows = new Map(Object.entries(input.overrides ?? {}));
  return {
    written,
    applicationExists: () => Promise.resolve(input.exists ?? true),
    list: (_applicationId, customerId) => {
      if (customerId === null) return Promise.resolve(vendorRows);
      return Promise.resolve(overrideRows.get(customerId) ?? []);
    },
    upsert: (_applicationId, customerId, entry) => {
      written.push({ customerId, entry });
      const rows = customerId === null ? vendorRows : undefined;
      if (rows) {
        const index = rows.findIndex((row) => row.key === entry.key);
        if (index >= 0) rows[index] = entry;
        else rows.push(entry);
      } else if (customerId !== null) {
        const scoped = overrideRows.get(customerId) ?? [];
        const index = scoped.findIndex((row) => row.key === entry.key);
        if (index >= 0) scoped[index] = entry;
        else scoped.push(entry);
        overrideRows.set(customerId, scoped);
      }
      return Promise.resolve();
    },
  };
}

function createMockWriter(): ConfigSecretWriter & {
  calls: { customerId: string; entries: readonly ConfigEntry[] }[];
} {
  const calls: { customerId: string; entries: readonly ConfigEntry[] }[] = [];
  return {
    calls,
    writeSecrets: (customerId, entries) => {
      calls.push({ customerId, entries });
      return Promise.resolve();
    },
  };
}

const PLAINTEXT_SECRET = 'postgres://fixture-super-secret-password';

describe('config — secret masking (§31 write-only)', () => {
  it('toMaskedEntry strips the value of secret entries entirely', () => {
    expect(toMaskedEntry({ key: 'DATABASE_URL', value: PLAINTEXT_SECRET, isSecret: true })).toStrictEqual({
      key: 'DATABASE_URL',
      isSecret: true,
      value: null,
    });
  });

  it('toMaskedEntry keeps non-secret values readable', () => {
    expect(toMaskedEntry({ key: 'LOG_LEVEL', value: 'info', isSecret: false })).toStrictEqual({
      key: 'LOG_LEVEL',
      isSecret: false,
      value: 'info',
    });
  });

  it('getConfig never returns a plaintext secret — masked entries carry null', async () => {
    const store = createMockStore({
      vendorDefaults: [
        // Even if a row somehow held plaintext, the API boundary masks it.
        { key: 'DATABASE_URL', value: PLAINTEXT_SECRET, isSecret: true },
        { key: 'LOG_LEVEL', value: 'info', isSecret: false },
      ],
    });

    const view = await getConfig(APP_ID, null, store);

    const secret = view.effective.find((entry) => entry.key === 'DATABASE_URL');
    expect(secret).toMatchObject({ isSecret: true, value: null });
    expect(JSON.stringify(view)).not.toContain(PLAINTEXT_SECRET);
  });

  it('getConfig masks customer-override secrets too', async () => {
    const store = createMockStore({
      vendorDefaults: [{ key: 'LOG_LEVEL', value: 'info', isSecret: false }],
      overrides: {
        [CUSTOMER_ID]: [{ key: 'API_KEY', value: PLAINTEXT_SECRET, isSecret: true }],
      },
    });

    const view = await getConfig(APP_ID, CUSTOMER_ID, store);

    const override = view.customerOverrides.find((entry) => entry.key === 'API_KEY');
    expect(override).toMatchObject({ isSecret: true, value: null });
    expect(JSON.stringify(view)).not.toContain(PLAINTEXT_SECRET);
  });
});

describe('config — vendor defaults vs customer overrides (§31 precedence)', () => {
  const vendorDefaults: readonly ConfigEntry[] = [
    { key: 'DATABASE_URL', value: SECRET_MASK, isSecret: true },
    { key: 'LOG_LEVEL', value: 'info', isSecret: false },
    { key: 'MAX_CONNECTIONS', value: '10', isSecret: false },
  ];

  it('customer override wins over the vendor default with the same key', async () => {
    const store = createMockStore({
      vendorDefaults,
      overrides: { [CUSTOMER_ID]: [{ key: 'LOG_LEVEL', value: 'debug', isSecret: false }] },
    });

    const view = await getConfig(APP_ID, CUSTOMER_ID, store);

    const overridden = view.effective.find((entry) => entry.key === 'LOG_LEVEL');
    expect(overridden).toMatchObject({
      value: 'debug',
      source: 'customer',
      vendorValue: 'info',
    });
  });

  it('non-overridden keys keep the vendor default', async () => {
    const store = createMockStore({
      vendorDefaults,
      overrides: { [CUSTOMER_ID]: [{ key: 'LOG_LEVEL', value: 'debug', isSecret: false }] },
    });

    const view = await getConfig(APP_ID, CUSTOMER_ID, store);

    const plain = view.effective.find((entry) => entry.key === 'MAX_CONNECTIONS');
    expect(plain).toMatchObject({ value: '10', source: 'vendor', vendorValue: null });
  });

  it('customer-only keys appear in the effective config', async () => {
    const store = createMockStore({
      vendorDefaults,
      overrides: { [CUSTOMER_ID]: [{ key: 'API_KEY', value: SECRET_MASK, isSecret: true }] },
    });

    const view = await getConfig(APP_ID, CUSTOMER_ID, store);

    const customerOnly = view.effective.find((entry) => entry.key === 'API_KEY');
    expect(customerOnly).toMatchObject({ source: 'customer', isSecret: true, value: null });
  });

  it('without a customer scope the effective config is the vendor defaults', async () => {
    const store = createMockStore({
      vendorDefaults,
      overrides: { [CUSTOMER_ID]: [{ key: 'LOG_LEVEL', value: 'debug', isSecret: false }] },
    });

    const view = await getConfig(APP_ID, null, store);

    expect(view.customerOverrides).toEqual([]);
    const logLevel = view.effective.find((entry) => entry.key === 'LOG_LEVEL');
    expect(logLevel).toMatchObject({ value: 'info', source: 'vendor' });
  });

  it('mergeConfigEntries is stable-ordered: vendor order first, then customer-only keys', () => {
    const merged = mergeConfigEntries(
      [
        { key: 'A', value: '1', isSecret: false },
        { key: 'B', value: '2', isSecret: false },
      ],
      [
        { key: 'B', value: 'override', isSecret: false },
        { key: 'C', value: '3', isSecret: false },
      ],
    );
    expect(merged.map((entry) => entry.key)).toEqual(['A', 'B', 'C']);
    expect(merged[1]).toMatchObject({ value: 'override', source: 'customer', vendorValue: '2' });
  });
});

describe('config — unknown application', () => {
  it('getConfig throws a 404 NotFoundError', async () => {
    const store = createMockStore({ exists: false });
    await expect(getConfig('no-such-app', null, store)).rejects.toMatchObject({
      name: 'NotFoundError',
      statusCode: 404,
      code: 'NOT_FOUND',
    });
  });

  it('setConfig throws a 404 NotFoundError before writing anything', async () => {
    const store = createMockStore({ exists: false });
    const secretWriter = createMockWriter();
    await expect(
      setConfig('no-such-app', null, [{ key: 'LOG_LEVEL', value: 'debug', isSecret: false }], {
        store,
        secretWriter,
      }),
    ).rejects.toMatchObject({ statusCode: 404, code: 'NOT_FOUND' });
    expect(store.written).toEqual([]);
    expect(secretWriter.calls).toEqual([]);
  });
});

describe('config — setConfig writes', () => {
  it('writes non-secret entries to the store in plaintext', async () => {
    const store = createMockStore({ vendorDefaults: [] });
    const secretWriter = createMockWriter();

    const view = await setConfig(
      APP_ID,
      null,
      [{ key: 'LOG_LEVEL', value: 'debug', isSecret: false }],
      { store, secretWriter },
    );

    expect(store.written).toEqual([
      { customerId: null, entry: { key: 'LOG_LEVEL', value: 'debug', isSecret: false } },
    ]);
    expect(secretWriter.calls).toEqual([]);
    expect(view.effective.find((entry) => entry.key === 'LOG_LEVEL')).toMatchObject({
      value: 'debug',
    });
  });

  it('§31 write-through: secrets go via the relay; the DB stores only the mask', async () => {
    const store = createMockStore({ vendorDefaults: [] });
    const secretWriter = createMockWriter();

    const view = await setConfig(
      APP_ID,
      CUSTOMER_ID,
      [{ key: 'DATABASE_URL', value: PLAINTEXT_SECRET, isSecret: true }],
      { store, secretWriter },
    );

    // The relay seam receives the plaintext (it writes the customer's
    // Secrets Manager)…
    expect(secretWriter.calls).toEqual([
      { customerId: CUSTOMER_ID, entries: [{ key: 'DATABASE_URL', value: PLAINTEXT_SECRET, isSecret: true }] },
    ]);
    // …but the control-plane DB stores ONLY the mask…
    expect(store.written).toEqual([
      { customerId: CUSTOMER_ID, entry: { key: 'DATABASE_URL', value: SECRET_MASK, isSecret: true } },
    ]);
    expect(JSON.stringify(store.written)).not.toContain(PLAINTEXT_SECRET);
    // …and the API response never carries the plaintext.
    expect(JSON.stringify(view)).not.toContain(PLAINTEXT_SECRET);
    expect(view.effective.find((entry) => entry.key === 'DATABASE_URL')).toMatchObject({
      isSecret: true,
      value: null,
    });
  });

  it('vendor-scope secrets persist as masked placeholders with NO relay write', async () => {
    const store = createMockStore({ vendorDefaults: [] });
    const secretWriter = createMockWriter();

    await setConfig(
      APP_ID,
      null,
      [{ key: 'DATABASE_URL', value: PLAINTEXT_SECRET, isSecret: true }],
      { store, secretWriter },
    );

    // No customer account exists for vendor defaults — nothing to write to.
    expect(secretWriter.calls).toEqual([]);
    expect(store.written).toEqual([
      { customerId: null, entry: { key: 'DATABASE_URL', value: SECRET_MASK, isSecret: true } },
    ]);
  });

  it('untouched secrets (empty value) are skipped — no relay call, no DB write', async () => {
    const store = createMockStore({
      vendorDefaults: [],
      overrides: { [CUSTOMER_ID]: [{ key: 'DATABASE_URL', value: SECRET_MASK, isSecret: true }] },
    });
    const secretWriter = createMockWriter();

    await setConfig(
      APP_ID,
      CUSTOMER_ID,
      [
        { key: 'DATABASE_URL', value: '', isSecret: true },
        { key: 'LOG_LEVEL', value: 'debug', isSecret: false },
      ],
      { store, secretWriter },
    );

    expect(secretWriter.calls).toEqual([]);
    expect(store.written).toEqual([
      { customerId: CUSTOMER_ID, entry: { key: 'LOG_LEVEL', value: 'debug', isSecret: false } },
    ]);
  });

  it('a failed relay write aborts before any DB write (all-or-nothing)', async () => {
    const store = createMockStore({ vendorDefaults: [] });
    const secretWriter: ConfigSecretWriter = {
      writeSecrets: () => Promise.reject(new Error('relay unreachable')),
    };

    await expect(
      setConfig(
        APP_ID,
        CUSTOMER_ID,
        [
          { key: 'DATABASE_URL', value: PLAINTEXT_SECRET, isSecret: true },
          { key: 'LOG_LEVEL', value: 'debug', isSecret: false },
        ],
        { store, secretWriter },
      ),
    ).rejects.toMatchObject({ statusCode: 502, code: 'CONFIG_WRITE_FAILED' });
    expect(store.written).toEqual([]);
  });
});

describe('config — write validation', () => {
  it('rejects duplicate keys within one write', async () => {
    const store = createMockStore({});
    const secretWriter = createMockWriter();
    await expect(
      setConfig(
        APP_ID,
        null,
        [
          { key: 'LOG_LEVEL', value: 'info', isSecret: false },
          { key: 'LOG_LEVEL', value: 'debug', isSecret: false },
        ],
        { store, secretWriter },
      ),
    ).rejects.toMatchObject({ statusCode: 400, code: 'INVALID_CONFIG' });
    expect(store.written).toEqual([]);
  });

  it('rejects empty keys', async () => {
    const store = createMockStore({});
    const secretWriter = createMockWriter();
    await expect(
      setConfig(APP_ID, null, [{ key: '', value: 'x', isSecret: false }], { store, secretWriter }),
    ).rejects.toMatchObject({ statusCode: 400, code: 'INVALID_CONFIG' });
  });

  it('rejects ApiError subclasses carry the structured-envelope fields', async () => {
    const store = createMockStore({});
    const secretWriter = createMockWriter();
    const failure = await setConfig(
      APP_ID,
      null,
      [{ key: '', value: 'x', isSecret: false }],
      { store, secretWriter },
    ).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ApiError);
  });
});

describe('config — request body schema (route boundary)', () => {
  it('accepts a well-formed write body', () => {
    const parsed = setConfigBodySchema.parse({
      customerId: CUSTOMER_ID,
      entries: [{ key: 'DATABASE_URL', value: PLAINTEXT_SECRET, isSecret: true }],
    });
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.customerId).toBe(CUSTOMER_ID);
  });

  it('accepts an absent customerId (vendor-default write)', () => {
    const parsed = setConfigBodySchema.parse({
      entries: [{ key: 'LOG_LEVEL', value: 'info', isSecret: false }],
    });
    expect(parsed.customerId).toBeUndefined();
  });

  it('rejects entries with empty keys, missing values, or non-boolean isSecret', () => {
    expect(() =>
      setConfigBodySchema.parse({ entries: [{ key: '', value: 'x', isSecret: false }] }),
    ).toThrow();
    expect(() =>
      setConfigBodySchema.parse({ entries: [{ key: 'A', isSecret: false }] }),
    ).toThrow();
    expect(() =>
      setConfigBodySchema.parse({ entries: [{ key: 'A', value: 'x', isSecret: 'yes' }] }),
    ).toThrow();
  });
});
