import { PGlite } from '@electric-sql/pglite';
import crypto from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { applyMigrations, createDb, type Db } from '@deployz/db';
import * as schema from '@deployz/db/schema';

import { createAuth, type Auth } from './auth.js';
import { env } from './env.js';
import { buildServer } from './server.js';

// Phase 2 — targeted installation invitations: a vendor creates an invitation
// WITHOUT a deployment; the customer (already named) selects the final Region
// and confirms; confirmation creates exactly one deployment and consumes the
// invitation.

const FIXTURE_SHA = crypto.randomUUID().replace(/-/g, '').slice(0, 40);

const READY_METADATA = {
  analysisCommitSha: FIXTURE_SHA,
  hasDockerfile: true,
  dockerfilePath: 'Dockerfile',
  framework: 'express',
  port: '3000',
  startupCommands: ['node dist/index.js'],
  hasStartupCommand: true,
  usesPostgresql: false,
  postgres: { required: false, evidence: [] },
  usesRedis: false,
  redis: { required: false, confidence: 'low', purposes: [], evidence: [], connectionEnvVars: [], compatibility: { supported: true } },
  usesS3: false,
  usesLocalFilesystem: false,
  usesWorkerProcesses: false,
  hasMigrationCommand: false,
  hasEnvVars: true,
  hasExternalServices: false,
  hasBuildCommand: false,
  buildCommands: ['npm run build'],
  envVars: [],
  envVarModel: [
    {
      key: 'STRIPE_API_KEY',
      required: true,
      secret: true,
      classification: 'customer_required',
      purpose: 'external_credential',
      confidence: 'high',
      source: ['.env.example'],
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

describe('targeted installation invitations', () => {
  let client: PGlite | undefined;
  let db: Db;
  let auth: Auth;
  let app: FastifyInstance;
  let org: { userId: string; organizationId: string; cookie: string };
  let applicationId: string;
  let customerId: string;

  beforeAll(async () => {
    client = new PGlite();
    await applyMigrations(client);
    db = createDb(client);
    auth = createAuth(db);
    org = await signUpAndGetOrg(auth, db, 'invitation-vendor@example.com');

    const [application] = await db
      .insert(schema.applications)
      .values({
        organizationId: org.organizationId,
        name: 'Invited App',
        repoFullName: `acme/invited-${crypto.randomUUID().slice(0, 8)}`,
        repoUrl: 'https://github.com/acme/invited',
        defaultBranch: 'main',
        detectedMetadata: READY_METADATA,
      })
      .returning();
    applicationId = application!.id;

    await db.insert(schema.releases).values({
      applicationId,
      version: '1.0.0',
      gitSha: crypto.randomUUID().slice(0, 8),
      imageDigest: 'registry.example.com/acme/app@sha256:' + 'a'.repeat(64),
      buildStatus: 'SUCCEEDED',
      releaseStatus: 'READY',
    });

    const [customer] = await db
      .insert(schema.customers)
      .values({ organizationId: org.organizationId, name: 'Target Customer', email: 'target@example.com' })
      .returning();
    customerId = customer!.id;

    await db.insert(schema.billingSubscriptions).values({
      organizationId: org.organizationId,
      providerCustomerId: 'ctm_fixture_invitation',
      providerSubscriptionId: 'sub_fixture_invitation',
      status: 'ACTIVE',
    });

    app = await buildServer({ auth, db });
    // The customer must be able to choose a non-default deployable region.
    (env as { deployableAwsRegions: string[] }).deployableAwsRegions = ['us-east-1', 'eu-west-1'];
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await client?.close();
  });

  async function createInvitation(recommendedRegion?: string) {
    return app.inject({
      method: 'POST',
      url: `/api/customers/${customerId}/invitations`,
      headers: { 'content-type': 'application/json', cookie: org.cookie },
      payload: JSON.stringify({ applicationId, ...(recommendedRegion ? { recommendedRegion } : {}) }),
    });
  }

  async function deploymentCount(): Promise<number> {
    const rows = await db.select({ id: schema.deployments.id }).from(schema.deployments);
    return rows.length;
  }

  it('creates an invitation with a one-time token and NO deployment', async () => {
    const response = await createInvitation('ap-south-1');
    expect(response.statusCode, response.body).toBe(201);
    const body = response.json() as { id: string; token: string; recommendedRegion: string | null };
    expect(body.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.token).toHaveLength(64);
    expect(body.recommendedRegion).toBe('ap-south-1');
    expect(await deploymentCount()).toBe(0);

    // The token is stored only as a hash — never the plaintext.
    const [row] = await db
      .select({ tokenHash: schema.publicInstallLinks.tokenHash })
      .from(schema.publicInstallLinks)
      .where(eq(schema.publicInstallLinks.id, body.id));
    expect(row!.tokenHash).not.toContain(body.token);
  });

  it('requires the secret token to resolve; a missing token 404s', async () => {
    const { id, token } = (await createInvitation()).json() as { id: string; token: string };

    const noToken = await app.inject({ method: 'GET', url: `/api/public-install/${id}` });
    expect(noToken.statusCode).toBe(404);

    const withToken = await app.inject({
      method: 'GET',
      url: `/api/public-install/${id}`,
      headers: { 'x-deployz-token': token },
    });
    expect(withToken.statusCode, withToken.body).toBe(200);
    const body = withToken.json() as { recommendedRegion: string | null; regionSelection: string };
    expect(body.regionSelection).toBe('customer');
    expect(body.recommendedRegion).toBeNull();
  });

  it('confirmation creates exactly one deployment on the target customer and consumes the invitation', async () => {
    const { id, token } = (await createInvitation('us-east-1')).json() as { id: string; token: string };
    const key = crypto.randomUUID();
    const payload = {
      idempotencyKey: key,
      region: 'eu-west-1', // customer overrides the recommendation
      config: [{ key: 'STRIPE_API_KEY', value: 'sk_live_fixture', isSecret: true }],
    };

    const confirm = await app.inject({
      method: 'POST',
      url: `/api/public-install/${id}/confirm`,
      headers: { 'content-type': 'application/json', 'x-deployz-token': token },
      payload: JSON.stringify(payload),
    });
    expect(confirm.statusCode, confirm.body).toBe(201);
    expect(await deploymentCount()).toBe(1);

    const [deployment] = await db
      .select()
      .from(schema.deployments)
      .where(eq(schema.deployments.publicInstallLinkId, id));
    expect(deployment!.customerId).toBe(customerId);
    expect(deployment!.region).toBe('eu-west-1');
    expect(deployment!.source).toBe('public_link');

    const [link] = await db
      .select({ confirmedAt: schema.publicInstallLinks.confirmedAt })
      .from(schema.publicInstallLinks)
      .where(eq(schema.publicInstallLinks.id, id));
    expect(link!.confirmedAt).not.toBeNull();

    // Replay with the SAME key is idempotent (200, same install link id).
    const replay = await app.inject({
      method: 'POST',
      url: `/api/public-install/${id}/confirm`,
      headers: { 'content-type': 'application/json', 'x-deployz-token': token },
      payload: JSON.stringify(payload),
    });
    expect(replay.statusCode, replay.body).toBe(200);
    expect((replay.json() as { installLinkId: string }).installLinkId).toBe(
      (confirm.json() as { installLinkId: string }).installLinkId,
    );

    // A DIFFERENT key on a consumed invitation is refused (410 USED).
    const differentKey = await app.inject({
      method: 'POST',
      url: `/api/public-install/${id}/confirm`,
      headers: { 'content-type': 'application/json', 'x-deployz-token': token },
      payload: JSON.stringify({ ...payload, idempotencyKey: crypto.randomUUID() }),
    });
    expect(differentKey.statusCode).toBe(410);
    expect((differentKey.json() as { error: { code: string } }).error.code).toBe('PUBLIC_INSTALL_LINK_USED');
    expect(await deploymentCount()).toBe(1);
  });
});
