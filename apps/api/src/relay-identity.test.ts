import { PGlite } from '@electric-sql/pglite';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { applyMigrations, createDb, type Db } from '@deployz/db';
import * as schema from '@deployz/db/schema';

import { createAuth, type Auth } from './auth.js';
import { hashRelayToken } from './relay-store.js';
import { buildServer } from './server.js';

// Phase 1: relay enrollment material never reaches dashboard clients, and
// relay identity (account/version/capabilities) persists at registration and
// on every heartbeat — including self-repair for deployments enrolled before
// those columns existed.
describe('relay identity + deployment serialization', () => {
  let client: PGlite | undefined;
  let db: Db;
  let auth: Auth;
  let app: FastifyInstance;
  let cookie: string;
  let organizationId: string;
  let applicationId: string;
  let customerId: string;

  const CAPABILITIES = {
    deployRelease: false,
    rollback: false,
    restart: false,
    configUpdate: false,
    destroy: false,
    domainManagement: true,
  } as const;

  async function insertDeployment(
    overrides: Partial<typeof schema.deployments.$inferInsert> = {},
  ): Promise<typeof schema.deployments.$inferSelect> {
    const [row] = await db
      .insert(schema.deployments)
      .values({
        organizationId,
        applicationId,
        customerId,
        region: 'us-east-1',
        state: 'NOT_INSTALLED',
        installationId: `inst-${crypto.randomUUID()}`,
        enrollmentCode: crypto.randomUUID(),
        ...overrides,
      })
      .returning();
    return row!;
  }

  beforeAll(async () => {
    client = new PGlite();
    await applyMigrations(client);
    db = createDb(client);
    auth = createAuth(db);

    const email = 'relay-identity@example.com';
    const password = 'super-secret-1';
    await auth.api.signUpEmail({ body: { email, password, name: 'Relay' } });
    const signin = await auth.api.signInEmail({ body: { email, password }, asResponse: true });
    const setCookie = signin.headers.get('set-cookie');
    if (!setCookie) throw new Error('sign-in did not set a session cookie');
    cookie = setCookie;

    app = await buildServer({ auth, db });

    const memberships = await db
      .select({ organizationId: schema.member.organizationId })
      .from(schema.member)
      .limit(1);
    organizationId = memberships[0]!.organizationId;

    const [application] = await db
      .insert(schema.applications)
      .values({
        organizationId,
        name: 'App',
        repoFullName: `acme/app-${crypto.randomUUID().slice(0, 8)}`,
        repoUrl: 'https://github.com/acme/app',
        defaultBranch: 'main',
      })
      .returning();
    applicationId = application!.id;

    const [customer] = await db
      .insert(schema.customers)
      .values({
        organizationId,
        name: 'Cust',
        email: `cust-${crypto.randomUUID()}@example.com`,
      })
      .returning();
    customerId = customer!.id;
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await client?.close();
  });

  it('GET /api/deployments never returns enrollmentCode or relayTokenHash', async () => {
    await insertDeployment({ relayTokenHash: hashRelayToken('token-x') });
    const response = await app.inject({
      method: 'GET',
      url: '/api/deployments',
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    const rows = (response.json() as { deployments: Record<string, unknown>[] }).deployments;
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row).not.toHaveProperty('enrollmentCode');
      expect(row).not.toHaveProperty('relayTokenHash');
    }
  });

  it('GET /api/deployments/:id never returns enrollmentCode or relayTokenHash', async () => {
    const deployment = await insertDeployment({
      relayTokenHash: hashRelayToken('token-y'),
    });
    const response = await app.inject({
      method: 'GET',
      url: `/api/deployments/${deployment.id}`,
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    const row = response.json() as Record<string, unknown>;
    expect(row).not.toHaveProperty('enrollmentCode');
    expect(row).not.toHaveProperty('relayTokenHash');
  });

  it('registration persists relay identity and capabilities', async () => {
    const token = 'reg-token-' + crypto.randomUUID();
    const installationId = 'inst-' + crypto.randomUUID();
    const deployment = await insertDeployment();
    const response = await app.inject({
      method: 'POST',
      url: '/api/relay/register',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: JSON.stringify({
        enrollmentCode: deployment.enrollmentCode,
        installationId,
        awsAccountId: '151955775369',
        region: 'us-east-1',
        relayVersion: '0.2.0',
        bootstrapVersion: '2026-08-28.1',
        capabilities: CAPABILITIES,
      }),
    });
    expect(response.statusCode).toBe(200);

    const [row] = await db
      .select()
      .from(schema.deployments)
      .where(eq(schema.deployments.id, deployment.id))
      .limit(1);
    expect(row!.awsAccountId).toBe('151955775369');
    expect(row!.relayVersion).toBe('0.2.0');
    expect(row!.bootstrapVersion).toBe('2026-08-28.1');
    expect(row!.relayCapabilities).toEqual({ ...CAPABILITIES });
  });

  it('fleet rows expose relay identity for capability gating', async () => {
    const deployment = await insertDeployment({
      relayTokenHash: hashRelayToken('token-z'),
      relayVersion: '0.2.0',
      relayCapabilities: { ...CAPABILITIES },
    });
    const response = await app.inject({
      method: 'GET',
      url: '/api/deployments',
      headers: { cookie },
    });
    const rows = (response.json() as { deployments: Record<string, unknown>[] }).deployments;
    const row = rows.find((r) => r['id'] === deployment.id);
    expect(row?.['relayVersion']).toBe('0.2.0');
    expect(row?.['relayCapabilities']).toEqual({ ...CAPABILITIES });
  });

  it('heartbeat self-repairs a missing account id and capabilities', async () => {
    const token = 'hb-token-' + crypto.randomUUID();
    const installationId = 'inst-' + crypto.randomUUID();
    const deployment = await insertDeployment({
      installationId,
      relayTokenHash: hashRelayToken(token),
      awsAccountId: null,
      relayVersion: null,
      relayCapabilities: null,
    });
    const response = await app.inject({
      method: 'POST',
      url: '/api/relay/health',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: JSON.stringify({
        installationId,
        observedState: { lastPoll: new Date().toISOString() },
        identity: {
          awsAccountId: '151955775369',
          region: 'us-east-1',
          relayVersion: '0.2.0',
          bootstrapVersion: null,
          capabilities: CAPABILITIES,
        },
      }),
    });
    expect(response.statusCode).toBe(200);

    const [row] = await db
      .select()
      .from(schema.deployments)
      .where(eq(schema.deployments.id, deployment.id))
      .limit(1);
    expect(row!.awsAccountId).toBe('151955775369');
    expect(row!.relayVersion).toBe('0.2.0');
    expect(row!.relayCapabilities).toEqual({ ...CAPABILITIES });
  });

  it('heartbeat without identity leaves stored identity untouched', async () => {
    const token = 'hb2-token-' + crypto.randomUUID();
    const installationId = 'inst-' + crypto.randomUUID();
    const deployment = await insertDeployment({
      installationId,
      relayTokenHash: hashRelayToken(token),
      relayVersion: '0.1.9',
      relayCapabilities: { ...CAPABILITIES },
    });
    const response = await app.inject({
      method: 'POST',
      url: '/api/relay/health',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: JSON.stringify({ installationId, observedState: {} }),
    });
    expect(response.statusCode).toBe(200);

    const [row] = await db
      .select()
      .from(schema.deployments)
      .where(eq(schema.deployments.id, deployment.id))
      .limit(1);
    expect(row!.relayVersion).toBe('0.1.9');
    expect(row!.relayCapabilities).toEqual({ ...CAPABILITIES });
  });

  it('heartbeat with a malformed capabilities block keeps the stored value', async () => {
    const token = 'hb3-token-' + crypto.randomUUID();
    const installationId = 'inst-' + crypto.randomUUID();
    const deployment = await insertDeployment({
      installationId,
      relayTokenHash: hashRelayToken(token),
      relayCapabilities: { ...CAPABILITIES },
    });
    const response = await app.inject({
      method: 'POST',
      url: '/api/relay/health',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: JSON.stringify({
        installationId,
        observedState: {},
        identity: { capabilities: { deployRelease: 'yes please' } },
      }),
    });
    expect(response.statusCode).toBe(200);

    const [row] = await db
      .select()
      .from(schema.deployments)
      .where(eq(schema.deployments.id, deployment.id))
      .limit(1);
    expect(row!.relayCapabilities).toEqual({ ...CAPABILITIES });
  });
});
