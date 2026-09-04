import { PGlite } from '@electric-sql/pglite';
import crypto from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { applyMigrations, createDb, type Db } from '@deployz/db';
import * as schema from '@deployz/db/schema';

import { createAuth, type Auth } from './auth.js';
import { GENERATED_SECRET_MASK, SECRET_MASK } from './config.js';
import { ensureGeneratedInternalSecrets } from './internal-secrets.js';
import type { ConfigSecretWriter, ConfigStore } from './config.js';
import { buildServer } from './server.js';

const SECRET_SHAPE = /^[A-Za-z0-9_-]{43}$/;

const GENERATABLE_MANIFEST_METADATA = {
  hasDockerfile: true,
  dockerfilePath: 'Dockerfile',
  framework: 'express',
  port: '3000',
  startupCommands: ['node dist/index.js'],
  hasStartupCommand: true,
  usesPostgresql: false,
  postgres: { required: false, evidence: [] },
  usesRedis: false,
  redis: {
    required: false,
    confidence: 'low',
    purposes: [],
    evidence: [],
    connectionEnvVars: [],
    compatibility: { supported: true },
  },
  usesS3: false,
  usesLocalFilesystem: false,
  usesWorkerProcesses: false,
  hasMigrationCommand: false,
  hasEnvVars: true,
  hasExternalServices: false,
  hasBuildCommand: true,
  buildCommands: ['npm run build'],
  envVars: ['NEXTAUTH_SECRET'],
  envVarModel: [
    {
      key: 'NEXTAUTH_SECRET',
      required: true,
      secret: true,
      source: ['read in src/config.ts'],
      purpose: 'internal_secret',
      confidence: 'medium',
      generatable: true,
    },
  ],
  databaseState: 'none',
  externalServices: [] as string[],
} as Record<string, unknown>;

async function signUpAndGetOrg(
  auth: Auth,
  db: Db,
  email: string,
): Promise<{ userId: string; organizationId: string; cookie: string }> {
  const password = 'super-secret-1';
  const signup = await auth.api.signUpEmail({ body: { email, password, name: email.split('@')[0]! } });
  const signin = await auth.api.signInEmail({ body: { email, password }, asResponse: true });
  const setCookie = signin.headers.get('set-cookie');
  if (!setCookie) throw new Error('sign-in did not set a session cookie');
  const memberships = await db
    .select({ organizationId: schema.member.organizationId })
    .from(schema.member)
    .where(eq(schema.member.userId, signup.user.id))
    .limit(1);
  const organizationId = memberships[0]?.organizationId;
  if (!organizationId) throw new Error('signup did not provision an organization');
  return { userId: signup.user.id, organizationId, cookie: setCookie };
}

async function insertApplication(
  db: Db,
  organizationId: string,
  metadata: Record<string, unknown> | null,
): Promise<string> {
  const [row] = await db
    .insert(schema.applications)
    .values({
      organizationId,
      name: 'Internal Secrets App',
      repoFullName: `acme/internal-secrets-${crypto.randomUUID().slice(0, 8)}`,
      repoUrl: 'https://github.com/acme/internal-secrets',
      defaultBranch: 'main',
      detectedMetadata: metadata,
    })
    .returning();
  return row!.id;
}

async function insertCustomer(db: Db, organizationId: string): Promise<string> {
  const [row] = await db
    .insert(schema.customers)
    .values({
      organizationId,
      name: 'Internal Secrets Customer',
      email: `internal-secrets-${crypto.randomUUID()}@example.com`,
    })
    .returning();
  return row!.id;
}

// ── Unit: the generator helper ──────────────────────────────────────────────

describe('ensureGeneratedInternalSecrets', () => {
  it('generates once, persists only the masked marker, and is idempotent', async () => {
    const rows: { key: string; value: string; isSecret: boolean; customerId: string | null }[] = [];
    const store: ConfigStore = {
      async applicationExists() {
        return true;
      },
      async list(_applicationId, customerId) {
        return rows
          .filter((row) => row.customerId === customerId)
          .map(({ key, value, isSecret }) => ({ key, value, isSecret }));
      },
      async upsert(_applicationId, customerId, entry) {
        const existing = rows.find((row) => row.customerId === customerId && row.key === entry.key);
        if (existing) {
          existing.value = entry.value;
          existing.isSecret = entry.isSecret;
        } else {
          rows.push({ key: entry.key, value: entry.value, isSecret: entry.isSecret, customerId });
        }
      },
      async remove() {},
    };
    const writer: ConfigSecretWriter & { writes: { key: string; value: string }[] } = {
      writes: [],
      async writeSecrets(_customerId, entries) {
        this.writes.push(...entries.map(({ key, value }) => ({ key, value })));
      },
      async removeSecrets() {},
    };

    const variables = [
      {
        key: 'NEXTAUTH_SECRET',
        required: true,
        secret: true,
        source: ['read in src/config.ts'],
        purpose: 'internal_secret',
        confidence: 'medium',
        generatable: true,
      },
    ];

    // Mocked db never used because store/writer are injected.
    const db = {} as Db;
    await ensureGeneratedInternalSecrets(db, { applicationId: 'a', customerId: 'c', variables }, { store, writer });
    expect(writer.writes).toHaveLength(1);
    expect(writer.writes[0]!.key).toBe('NEXTAUTH_SECRET');
    expect(writer.writes[0]!.value).toMatch(SECRET_SHAPE);
    // The persisted row is the marker, never the plaintext.
    expect(rows).toEqual([
      {
        key: 'NEXTAUTH_SECRET',
        value: GENERATED_SECRET_MASK,
        isSecret: true,
        customerId: 'c',
      },
    ]);

    // Second call finds the row and generates nothing (stable across redeploys).
    writer.writes = [];
    await ensureGeneratedInternalSecrets(db, { applicationId: 'a', customerId: 'c', variables }, { store, writer });
    expect(writer.writes).toHaveLength(0);
    expect(rows).toHaveLength(1);
  });

  it('never generates when a vendor/customer-configured value exists', async () => {
    const existing = [
      { key: 'SESSION_SECRET', value: SECRET_MASK, isSecret: true, customerId: null as string | null },
    ];
    const store: ConfigStore = {
      async applicationExists() {
        return true;
      },
      async list() {
        return existing.map(({ key, value, isSecret }) => ({ key, value, isSecret }));
      },
      async upsert() {},
      async remove() {},
    };
    const writeSecrets = vi.fn(async () => {});
    const writer: ConfigSecretWriter = {
      writeSecrets,
      async removeSecrets() {},
    };

    await ensureGeneratedInternalSecrets(
      {} as Db,
      {
        applicationId: 'a',
        customerId: 'c',
        variables: [
          {
            key: 'SESSION_SECRET',
            required: true,
            secret: true,
            source: [],
            purpose: 'internal_secret',
            confidence: 'medium',
            generatable: true,
          },
        ],
      },
      { store, writer },
    );
    expect(writeSecrets).not.toHaveBeenCalled();
  });
});

// ── Integration: deployment creation generates at the gate ─────────────────

describe('deployment creation generates internal secrets (Stage B phase 4)', () => {
  let client: PGlite | undefined;
  let db: Db;
  let auth: Auth;
  let app: FastifyInstance;
  let org: { userId: string; organizationId: string; cookie: string };

  function post(path: string, body: unknown) {
    return app.inject({
      method: 'POST',
      url: path,
      headers: { cookie: org.cookie, 'content-type': 'application/json' },
      payload: JSON.stringify(body),
    });
  }

  beforeAll(async () => {
    client = new PGlite();
    await applyMigrations(client);
    db = createDb(client);
    auth = createAuth(db);
    org = await signUpAndGetOrg(auth, db, 'internal-secrets-e2e@example.com');
    app = await buildServer({ auth, db });
  }, 90_000);

  afterAll(async () => {
    await app?.close();
    await client?.close();
  });

  async function configRows(applicationId: string, customerId: string | null) {
    return db
      .select()
      .from(schema.applicationConfigs)
      .where(
        customerId === null
          ? eq(schema.applicationConfigs.customerId, null as unknown as string)
          : eq(schema.applicationConfigs.customerId, customerId),
      );
  }

  it('generates the secret once at first deployment and reuses it on the second', async () => {
    const applicationId = await insertApplication(db, org.organizationId, GENERATABLE_MANIFEST_METADATA);
    const customerId = await insertCustomer(db, org.organizationId);

    const first = await post('/api/deployments', {
      applicationId,
      customerId,
      region: 'us-east-1',
    });
    expect(first.statusCode, first.body).toBe(201);

    const rowsAfterFirst = await configRows(applicationId, customerId);
    expect(rowsAfterFirst).toHaveLength(1);
    expect(rowsAfterFirst[0]!.key).toBe('NEXTAUTH_SECRET');
    expect(rowsAfterFirst[0]!.isSecret).toBe(true);
    // Only the masked marker is persisted — never the plaintext.
    expect(rowsAfterFirst[0]!.value).toBe(GENERATED_SECRET_MASK);

    const second = await post('/api/deployments', {
      applicationId,
      customerId,
      region: 'us-east-1',
    });
    expect(second.statusCode, second.body).toBe(201);
    const rowsAfterSecond = await configRows(applicationId, customerId);
    expect(rowsAfterSecond).toHaveLength(1);
    expect(rowsAfterSecond[0]!.value).toBe(GENERATED_SECRET_MASK);
  });

  it('keeps a vendor-configured value instead of generating', async () => {
    const applicationId = await insertApplication(db, org.organizationId, GENERATABLE_MANIFEST_METADATA);
    const customerId = await insertCustomer(db, org.organizationId);
    await db.insert(schema.applicationConfigs).values({
      applicationId,
      customerId,
      key: 'NEXTAUTH_SECRET',
      value: SECRET_MASK,
      isSecret: true,
    });

    const response = await post('/api/deployments', {
      applicationId,
      customerId,
      region: 'us-east-1',
    });
    expect(response.statusCode, response.body).toBe(201);

    const rows = await configRows(applicationId, customerId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.value).toBe(SECRET_MASK);
  });
});
