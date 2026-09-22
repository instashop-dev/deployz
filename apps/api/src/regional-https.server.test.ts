import { PGlite } from '@electric-sql/pglite';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { applyMigrations, createDb, type Db } from '@deployz/db';
import * as schema from '@deployz/db/schema';
import { regionalCertificateDomain, scopedDeploymentHostname } from '@deployz/contracts';

import { createAuth, type Auth } from './auth.js';
import {
  createFakeCloudflareDnsClient,
  type FakeCloudflareDnsClient,
} from './cloudflare-records.js';
import type { DefaultHttpsDeps, DefaultHttpsState } from './default-https.js';
import { hashRelayToken } from './relay-store.js';
import { buildServer } from './server.js';

// Server-wiring (lane 3b) tests for regional HTTPS certificates
// (docs/https-regional-certificates.md). Exercises the actual HTTP routes —
// enrollment, command claim, relay result settlement, heartbeat, destroy/
// force-complete/purge, and the retry route — against a fresh in-memory
// PGlite with a fake (in-memory) Cloudflare DNS client. No real network, no
// real AWS.

const READY_MANIFEST = {
  application: { root: '.', runtime: 'node', framework: 'express', dockerfilePath: 'Dockerfile' },
  build: { command: 'npm run build', context: '.' },
  web: { command: 'npm start', port: 3000 },
  health: { path: '/health' },
  database: { postgres: true },
  redis: { required: false, envBindings: [] },
  storage: { required: false, envBindings: [] },
  migration: { command: 'npm run db:migrate' },
  worker: { command: null },
  environment: { variables: [] },
  externalServices: [],
  unsupported: [],
} as const;

const APEX = 'deployz-regional-test.test';
const AWS_ACCOUNT_ID = '123456789012';

async function signUpAndGetOrg(
  auth: Auth,
  db: Db,
  email: string,
): Promise<{ userId: string; organizationId: string; cookie: string }> {
  const password = 'super-secret-1';
  const signup = await auth.api.signUpEmail({ body: { email, password, name: email.split('@')[0]! } });
  const signin = await auth.api.signInEmail({ body: { email, password }, asResponse: true });
  const setCookie = signin.headers.get('set-cookie');
  if (!setCookie) {
    throw new Error('sign-in did not set a session cookie');
  }
  const memberships = await db
    .select({ organizationId: schema.member.organizationId })
    .from(schema.member)
    .where(eq(schema.member.userId, signup.user.id))
    .limit(1);
  const organizationId = memberships[0]?.organizationId;
  if (!organizationId) {
    throw new Error('signup did not provision an organization');
  }
  return { userId: signup.user.id, organizationId, cookie: setCookie };
}

async function insertApplication(
  db: Db,
  organizationId: string,
  overrides: Partial<typeof schema.applications.$inferInsert> = {},
): Promise<typeof schema.applications.$inferSelect> {
  const [row] = await db
    .insert(schema.applications)
    .values({
      organizationId,
      name: 'Test App',
      repoFullName: `acme/regional-app-${crypto.randomUUID().slice(0, 8)}`,
      repoUrl: 'https://github.com/acme/regional-app',
      defaultBranch: 'main',
      ...overrides,
    })
    .returning();
  return row!;
}

async function insertCustomer(
  db: Db,
  organizationId: string,
  overrides: Partial<typeof schema.customers.$inferInsert> = {},
): Promise<typeof schema.customers.$inferSelect> {
  const [row] = await db
    .insert(schema.customers)
    .values({
      organizationId,
      name: 'Test Customer',
      email: `customer-${crypto.randomUUID()}@example.com`,
      ...overrides,
    })
    .returning();
  return row!;
}

async function insertDeployment(
  db: Db,
  organizationId: string,
  applicationId: string,
  customerId: string,
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
      desiredState: { manifest: READY_MANIFEST },
      ...overrides,
    })
    .returning();
  return row!;
}

async function insertRegionalCertificateRow(
  db: Db,
  overrides: Partial<typeof schema.customerRegionalCertificates.$inferInsert> & {
    organizationId: string;
    customerId: string;
  },
): Promise<typeof schema.customerRegionalCertificates.$inferSelect> {
  const [row] = await db
    .insert(schema.customerRegionalCertificates)
    .values({
      awsAccountId: AWS_ACCOUNT_ID,
      region: 'us-east-1',
      certificateDomain: regionalCertificateDomain('placeholder0000', APEX),
      certificateStatus: 'REQUESTING',
      ...overrides,
    })
    .returning();
  return row!;
}

function regionalDefaultHttps(
  deploymentId: string,
  dnsScope: string,
  certificateId: string,
  overrides: Partial<DefaultHttpsState> = {},
): Record<string, unknown> {
  const state: DefaultHttpsState = {
    hostname: scopedDeploymentHostname(deploymentId, dnsScope, { zone: APEX }),
    status: 'PENDING',
    checkCycle: 0,
    lastError: null,
    mode: 'regional',
    dnsScope,
    certificateId,
    bootstrapReadyAt: new Date().toISOString(),
    ...overrides,
  };
  return state as unknown as Record<string, unknown>;
}

function postJson(
  app: FastifyInstance,
  url: string,
  body: unknown,
  extraHeaders: Record<string, string> = {},
) {
  return app.inject({
    method: 'POST',
    url,
    headers: { 'content-type': 'application/json', ...extraHeaders },
    payload: JSON.stringify(body),
  });
}

describe('regional HTTPS certificates — server wiring (docs/https-regional-certificates.md)', () => {
  let client: PGlite | undefined;
  let db: Db;
  let auth: Auth;
  let app: FastifyInstance;
  let fake: FakeCloudflareDnsClient;
  let org: { userId: string; organizationId: string; cookie: string };
  let application: typeof schema.applications.$inferSelect;

  beforeAll(async () => {
    client = new PGlite();
    await applyMigrations(client);
    db = createDb(client);
    auth = createAuth(db);
    fake = createFakeCloudflareDnsClient({ zoneId: 'zone-test', zoneName: APEX });
    const defaultHttpsDeps: DefaultHttpsDeps = {
      enabled: true,
      apex: APEX,
      dns: fake,
      probeHttps: async () => ({ ok: true }),
    };
    app = await buildServer({ auth, db, defaultHttpsDeps });

    org = await signUpAndGetOrg(auth, db, 'regional-owner@example.com');
    application = await insertApplication(db, org.organizationId);
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await client?.close();
  });

  async function seedCustomerDeployment(
    overrides: Partial<typeof schema.deployments.$inferInsert> = {},
  ) {
    const customer = await insertCustomer(db, org.organizationId);
    const deployment = await insertDeployment(db, org.organizationId, application.id, customer.id, {
      installationId: null,
      ...overrides,
    });
    return { customer, deployment };
  }

  // ── (a) enrollment ─────────────────────────────────────────────────────

  describe('enrollment (POST /api/relay/register)', () => {
    it('a matching customerScope creates the certificate row, the ENSURE job, and the regional default_https state', async () => {
      const { customer, deployment } = await seedCustomerDeployment();
      const token = `relay-token-${crypto.randomUUID()}`;
      const installationId = `inst-${crypto.randomUUID()}`;

      const response = await postJson(
        app,
        '/api/relay/register',
        {
          enrollmentCode: deployment.enrollmentCode,
          installationId,
          awsAccountId: AWS_ACCOUNT_ID,
          customerScope: customer.dnsScope,
          capabilities: {
            deployRelease: true,
            rollback: true,
            restart: true,
            configUpdate: true,
            destroy: true,
            domainManagement: true,
            regionalCertificate: true,
          },
        },
        { authorization: `Bearer ${token}` },
      );
      expect(response.statusCode).toBe(200);

      const certRows = await db
        .select()
        .from(schema.customerRegionalCertificates)
        .where(eq(schema.customerRegionalCertificates.customerId, customer.id));
      expect(certRows).toHaveLength(1);
      expect(certRows[0]!.certificateStatus).toBe('REQUESTING');
      expect(certRows[0]!.awsAccountId).toBe(AWS_ACCOUNT_ID);

      const jobs = await db
        .select()
        .from(schema.deploymentJobs)
        .where(eq(schema.deploymentJobs.deploymentId, deployment.id));
      expect(jobs.some((j) => j.type === 'ENSURE_CERTIFICATE')).toBe(true);
      expect(jobs.some((j) => j.type === 'INSTALL')).toBe(true);

      const [dep] = await db.select().from(schema.deployments).where(eq(schema.deployments.id, deployment.id));
      expect(dep!.defaultHttps).toMatchObject({ mode: 'regional', status: 'PENDING', dnsScope: customer.dnsScope });

      // The relayCapabilities column normalizes the optional field to a
      // concrete boolean (the type-fix in the task's step 1).
      expect(dep!.relayCapabilities).toMatchObject({ regionalCertificate: true });
    });

    it('a mismatching customerScope leaves everything on the legacy flow', async () => {
      const { deployment } = await seedCustomerDeployment();
      const token = `relay-token-${crypto.randomUUID()}`;
      const installationId = `inst-${crypto.randomUUID()}`;

      const response = await postJson(
        app,
        '/api/relay/register',
        {
          enrollmentCode: deployment.enrollmentCode,
          installationId,
          awsAccountId: AWS_ACCOUNT_ID,
          customerScope: 'not-the-real-scope',
        },
        { authorization: `Bearer ${token}` },
      );
      expect(response.statusCode).toBe(200);

      const certRows = await db
        .select()
        .from(schema.customerRegionalCertificates)
        .where(eq(schema.customerRegionalCertificates.customerId, deployment.customerId));
      expect(certRows).toHaveLength(0);

      const [dep] = await db.select().from(schema.deployments).where(eq(schema.deployments.id, deployment.id));
      expect(dep!.defaultHttps).toBeNull();
    });

    it('an absent customerScope leaves everything on the legacy flow', async () => {
      const { deployment } = await seedCustomerDeployment();
      const token = `relay-token-${crypto.randomUUID()}`;
      const installationId = `inst-${crypto.randomUUID()}`;

      const response = await postJson(
        app,
        '/api/relay/register',
        { enrollmentCode: deployment.enrollmentCode, installationId, awsAccountId: AWS_ACCOUNT_ID },
        { authorization: `Bearer ${token}` },
      );
      expect(response.statusCode).toBe(200);

      const [dep] = await db.select().from(schema.deployments).where(eq(schema.deployments.id, deployment.id));
      expect(dep!.defaultHttps).toBeNull();
    });
  });

  // ── (b) command claim ordering + regionalCertificateArn injection ──────

  describe('GET /api/relay/commands', () => {
    it('returns ENSURE_CERTIFICATE ahead of INSTALL, and omits regionalCertificateArn while not ISSUED', async () => {
      const { customer, deployment } = await seedCustomerDeployment();
      const token = `relay-token-${crypto.randomUUID()}`;
      const installationId = `inst-${crypto.randomUUID()}`;
      await postJson(
        app,
        '/api/relay/register',
        {
          enrollmentCode: deployment.enrollmentCode,
          installationId,
          awsAccountId: AWS_ACCOUNT_ID,
          customerScope: customer.dnsScope,
        },
        { authorization: `Bearer ${token}` },
      );

      const response = await app.inject({
        method: 'GET',
        url: `/api/relay/commands?installationId=${installationId}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json() as { commands: Array<{ type: string; payload: Record<string, unknown> }> };
      expect(body.commands.length).toBeGreaterThanOrEqual(2);
      expect(body.commands[0]!.type).toBe('ENSURE_CERTIFICATE');
      const install = body.commands.find((c) => c.type === 'INSTALL');
      expect(install).toBeDefined();
      expect(install!.payload).not.toHaveProperty('regionalCertificateArn');
    });

    it('injects regionalCertificateArn into INSTALL once the shared certificate is ISSUED', async () => {
      const { customer, deployment } = await seedCustomerDeployment({ awsAccountId: AWS_ACCOUNT_ID });
      const certRow = await insertRegionalCertificateRow(db, {
        organizationId: org.organizationId,
        customerId: customer.id,
        certificateDomain: regionalCertificateDomain(customer.dnsScope, APEX),
        certificateStatus: 'ISSUED',
        certificateArn: 'arn:aws:acm:us-east-1:123456789012:certificate/issued-1',
      });
      const token = `relay-token-${crypto.randomUUID()}`;
      await db
        .update(schema.deployments)
        .set({
          installationId: `inst-${crypto.randomUUID()}`,
          relayTokenHash: hashRelayToken(token),
          relayStatus: 'CONNECTED',
          defaultHttps: regionalDefaultHttps(deployment.id, customer.dnsScope, certRow.id),
        })
        .where(eq(schema.deployments.id, deployment.id));
      const [freshDeployment] = await db.select().from(schema.deployments).where(eq(schema.deployments.id, deployment.id));
      await db.insert(schema.deploymentJobs).values({
        deploymentId: deployment.id,
        type: 'INSTALL',
        state: 'REQUESTED',
        idempotencyKey: `${deployment.id}:INSTALL`,
        payload: { parameters: {} },
      });

      const response = await app.inject({
        method: 'GET',
        url: `/api/relay/commands?installationId=${freshDeployment!.installationId}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json() as { commands: Array<{ type: string; payload: Record<string, unknown> }> };
      const install = body.commands.find((c) => c.type === 'INSTALL');
      expect(install).toBeDefined();
      expect(install!.payload.regionalCertificateArn).toBe('arn:aws:acm:us-east-1:123456789012:certificate/issued-1');
    });
  });

  // ── (c) ENSURE_CERTIFICATE result ───────────────────────────────────────

  describe('POST /api/relay/commands/:id/result — ENSURE_CERTIFICATE', () => {
    async function seedEnsureJob(certRow: typeof schema.customerRegionalCertificates.$inferSelect, deployment: typeof schema.deployments.$inferSelect, token: string) {
      await db
        .update(schema.deployments)
        .set({ relayTokenHash: hashRelayToken(token), relayStatus: 'CONNECTED' })
        .where(eq(schema.deployments.id, deployment.id));
      const [job] = await db
        .insert(schema.deploymentJobs)
        .values({
          deploymentId: deployment.id,
          type: 'ENSURE_CERTIFICATE',
          state: 'RUNNING',
          idempotencyKey: `${deployment.id}:ENSURE_CERTIFICATE:${certRow.id}:0`,
          payload: {
            certificateDomain: certRow.certificateDomain,
            customerScope: 'x',
            idempotencyToken: certRow.id.replace(/-/g, '').slice(0, 32),
          },
        })
        .returning();
      return job!;
    }

    it('PENDING_VALIDATION result upserts the validation record, moves the row to DNS_VALIDATION_PENDING, and chases a new ENSURE cycle', async () => {
      const { customer, deployment } = await seedCustomerDeployment({ awsAccountId: AWS_ACCOUNT_ID });
      const certRow = await insertRegionalCertificateRow(db, {
        organizationId: org.organizationId,
        customerId: customer.id,
        certificateDomain: regionalCertificateDomain(customer.dnsScope, APEX),
      });
      const token = `relay-token-${crypto.randomUUID()}`;
      const job = await seedEnsureJob(certRow, deployment, token);

      const validationName = `_abc123.c-${customer.dnsScope}.${APEX}`;
      const response = await postJson(
        app,
        `/api/relay/commands/${job.id}/result`,
        {
          success: true,
          output: {
            certificateArn: 'arn:aws:acm:us-east-1:123456789012:certificate/pending-1',
            certificateStatus: 'PENDING_VALIDATION',
            validationRecordName: validationName,
            validationRecordValue: 'validate.acm-validations.aws.',
            validationRecordType: 'CNAME',
          },
        },
        { authorization: `Bearer ${token}` },
      );
      expect(response.statusCode).toBe(200);

      const [updated] = await db
        .select()
        .from(schema.customerRegionalCertificates)
        .where(eq(schema.customerRegionalCertificates.id, certRow.id));
      expect(updated!.certificateStatus).toBe('DNS_VALIDATION_PENDING');
      expect(updated!.validationDnsReadyAt).not.toBeNull();

      // The validation CNAME landed in the fake Cloudflare store, unproxied.
      const record = fake.listRecords().find((r) => r.name.toLowerCase() === validationName.toLowerCase());
      expect(record).toBeDefined();
      expect(record!.proxied).toBe(false);

      // A fresh ENSURE_CERTIFICATE job exists for the next cycle (the row is
      // not yet ISSUED/ERROR).
      const ensureJobs = await db
        .select()
        .from(schema.deploymentJobs)
        .where(and(eq(schema.deploymentJobs.deploymentId, deployment.id), eq(schema.deploymentJobs.type, 'ENSURE_CERTIFICATE')));
      expect(ensureJobs.length).toBeGreaterThanOrEqual(2);
    });

    it('ISSUED result marks the row ISSUED and mints ATTACH_CERTIFICATE for a deployment with a routingTarget', async () => {
      const { customer, deployment } = await seedCustomerDeployment({ awsAccountId: AWS_ACCOUNT_ID, state: 'INSTALLING' });
      const certRow = await insertRegionalCertificateRow(db, {
        organizationId: org.organizationId,
        customerId: customer.id,
        certificateDomain: regionalCertificateDomain(customer.dnsScope, APEX),
      });
      await db
        .update(schema.deployments)
        .set({
          defaultHttps: regionalDefaultHttps(deployment.id, customer.dnsScope, certRow.id, {
            routingTarget: 'alb-test.us-east-1.elb.amazonaws.com',
          }),
        })
        .where(eq(schema.deployments.id, deployment.id));
      const token = `relay-token-${crypto.randomUUID()}`;
      const job = await seedEnsureJob(certRow, deployment, token);

      const response = await postJson(
        app,
        `/api/relay/commands/${job.id}/result`,
        {
          success: true,
          output: {
            certificateArn: 'arn:aws:acm:us-east-1:123456789012:certificate/issued-2',
            certificateStatus: 'ISSUED',
          },
        },
        { authorization: `Bearer ${token}` },
      );
      expect(response.statusCode).toBe(200);

      const [updated] = await db
        .select()
        .from(schema.customerRegionalCertificates)
        .where(eq(schema.customerRegionalCertificates.id, certRow.id));
      expect(updated!.certificateStatus).toBe('ISSUED');
      expect(updated!.issuedAt).not.toBeNull();

      const attachJobs = await db
        .select()
        .from(schema.deploymentJobs)
        .where(and(eq(schema.deploymentJobs.deploymentId, deployment.id), eq(schema.deploymentJobs.type, 'ATTACH_CERTIFICATE')));
      expect(attachJobs).toHaveLength(1);
    });
  });

  // ── (d) INSTALL success (regional) ──────────────────────────────────────

  describe('POST /api/relay/commands/:id/result — INSTALL (regional)', () => {
    it('writes the scoped (unproxied) deployment record and stays PENDING until attach', async () => {
      const { customer, deployment } = await seedCustomerDeployment({ awsAccountId: AWS_ACCOUNT_ID, state: 'INSTALLING' });
      const certRow = await insertRegionalCertificateRow(db, {
        organizationId: org.organizationId,
        customerId: customer.id,
        certificateDomain: regionalCertificateDomain(customer.dnsScope, APEX),
      });
      const token = `relay-token-${crypto.randomUUID()}`;
      await db
        .update(schema.deployments)
        .set({
          relayTokenHash: hashRelayToken(token),
          relayStatus: 'CONNECTED',
          defaultHttps: regionalDefaultHttps(deployment.id, customer.dnsScope, certRow.id),
        })
        .where(eq(schema.deployments.id, deployment.id));
      const [job] = await db
        .insert(schema.deploymentJobs)
        .values({
          deploymentId: deployment.id,
          type: 'INSTALL',
          state: 'RUNNING',
          idempotencyKey: `${deployment.id}:INSTALL`,
          payload: {},
        })
        .returning();

      const response = await postJson(
        app,
        `/api/relay/commands/${job!.id}/result`,
        {
          success: true,
          output: { outputs: { ExportStackPublicEndpoint: 'alb-regional.us-east-1.elb.amazonaws.com' } },
        },
        { authorization: `Bearer ${token}` },
      );
      expect(response.statusCode).toBe(200);

      const hostname = scopedDeploymentHostname(deployment.id, customer.dnsScope, { zone: APEX });
      const record = fake.listRecords().find((r) => r.name.toLowerCase() === hostname.toLowerCase());
      expect(record).toBeDefined();
      expect(record!.proxied).toBe(false);
      expect(record!.content).toBe('alb-regional.us-east-1.elb.amazonaws.com');

      const [dep] = await db.select().from(schema.deployments).where(eq(schema.deployments.id, deployment.id));
      expect((dep!.defaultHttps as { status: string }).status).toBe('PENDING');
    });

    it('an install output carrying regionalCertificate.httpsConfigured moves the machine to CONFIGURING', async () => {
      const { customer, deployment } = await seedCustomerDeployment({ awsAccountId: AWS_ACCOUNT_ID, state: 'INSTALLING' });
      const certRow = await insertRegionalCertificateRow(db, {
        organizationId: org.organizationId,
        customerId: customer.id,
        certificateDomain: regionalCertificateDomain(customer.dnsScope, APEX),
        certificateStatus: 'ISSUED',
        certificateArn: 'arn:aws:acm:us-east-1:123456789012:certificate/pre-attached',
      });
      const token = `relay-token-${crypto.randomUUID()}`;
      await db
        .update(schema.deployments)
        .set({
          relayTokenHash: hashRelayToken(token),
          relayStatus: 'CONNECTED',
          defaultHttps: regionalDefaultHttps(deployment.id, customer.dnsScope, certRow.id),
        })
        .where(eq(schema.deployments.id, deployment.id));
      const [job] = await db
        .insert(schema.deploymentJobs)
        .values({
          deploymentId: deployment.id,
          type: 'INSTALL',
          state: 'RUNNING',
          idempotencyKey: `${deployment.id}:INSTALL`,
          payload: {},
        })
        .returning();

      const response = await postJson(
        app,
        `/api/relay/commands/${job!.id}/result`,
        {
          success: true,
          output: {
            outputs: { ExportStackPublicEndpoint: 'alb-regional-2.us-east-1.elb.amazonaws.com' },
            regionalCertificate: { certificateArn: certRow.certificateArn, httpsConfigured: true },
          },
        },
        { authorization: `Bearer ${token}` },
      );
      expect(response.statusCode).toBe(200);

      const [dep] = await db.select().from(schema.deployments).where(eq(schema.deployments.id, deployment.id));
      expect((dep!.defaultHttps as { status: string }).status).toBe('CONFIGURING');
    });
  });

  // ── (e) ATTACH_CERTIFICATE success → probe → ACTIVE → READY ────────────

  describe('POST /api/relay/commands/:id/result — ATTACH_CERTIFICATE', () => {
    it('success moves CONFIGURING and the probe activates it; vendor status is READY only once ACTIVE, with httpsProgress fully done', async () => {
      const { customer, deployment } = await seedCustomerDeployment({
        awsAccountId: AWS_ACCOUNT_ID,
        state: 'HEALTHY',
        healthStatus: 'HEALTHY',
      });
      const certRow = await insertRegionalCertificateRow(db, {
        organizationId: org.organizationId,
        customerId: customer.id,
        certificateDomain: regionalCertificateDomain(customer.dnsScope, APEX),
        certificateStatus: 'ISSUED',
        certificateArn: 'arn:aws:acm:us-east-1:123456789012:certificate/attach-1',
        issuedAt: new Date(),
        lastVerifiedAt: new Date(),
        validationDnsReadyAt: new Date(),
      });
      const token = `relay-token-${crypto.randomUUID()}`;
      await db
        .update(schema.deployments)
        .set({
          relayTokenHash: hashRelayToken(token),
          relayStatus: 'CONNECTED',
          defaultHttps: regionalDefaultHttps(deployment.id, customer.dnsScope, certRow.id, {
            status: 'PENDING',
            routingTarget: 'alb-attach.us-east-1.elb.amazonaws.com',
          }),
        })
        .where(eq(schema.deployments.id, deployment.id));

      // Before ATTACH: the vendor status is not yet READY.
      const preStatus = await app.inject({
        method: 'GET',
        url: `/api/deployments/${deployment.id}`,
        headers: { cookie: org.cookie },
      });
      expect(preStatus.statusCode).toBe(200);
      const preBody = preStatus.json() as { deploymentStatus: { stage: string } };
      expect(preBody.deploymentStatus.stage).not.toBe('READY');

      const [job] = await db
        .insert(schema.deploymentJobs)
        .values({
          deploymentId: deployment.id,
          type: 'ATTACH_CERTIFICATE',
          state: 'RUNNING',
          idempotencyKey: `${deployment.id}:ATTACH_CERTIFICATE:0`,
          payload: { certificateArn: certRow.certificateArn, hostname: 'placeholder' },
        })
        .returning();

      const response = await postJson(
        app,
        `/api/relay/commands/${job!.id}/result`,
        {
          success: true,
          output: {
            routingTarget: 'alb-attach.us-east-1.elb.amazonaws.com',
            httpsConfigured: true,
          },
        },
        { authorization: `Bearer ${token}` },
      );
      expect(response.statusCode).toBe(200);

      // The probe (defaultHttpsDeps.probeHttps → ok:true) runs immediately
      // after the ATTACH success, so the machine reaches ACTIVE without
      // waiting for the next heartbeat.
      const [dep] = await db.select().from(schema.deployments).where(eq(schema.deployments.id, deployment.id));
      expect((dep!.defaultHttps as { status: string }).status).toBe('ACTIVE');

      const status = await app.inject({
        method: 'GET',
        url: `/api/deployments/${deployment.id}`,
        headers: { cookie: org.cookie },
      });
      expect(status.statusCode).toBe(200);
      const body = status.json() as {
        deploymentStatus: {
          stage: string;
          httpsProgress?: { substeps: Array<{ key: string; state: string }> };
        };
      };
      expect(body.deploymentStatus.stage).toBe('READY');
      expect(body.deploymentStatus.httpsProgress).toBeDefined();
      for (const substep of body.deploymentStatus.httpsProgress!.substeps) {
        expect(substep.state).toBe('done');
      }
    });
    it('failure keeps PENDING and drops the certificate row freshness so the next heartbeat re-verifies the ARN', async () => {
      const { customer, deployment } = await seedCustomerDeployment({
        awsAccountId: AWS_ACCOUNT_ID,
        state: 'HEALTHY',
        healthStatus: 'HEALTHY',
      });
      const certRow = await insertRegionalCertificateRow(db, {
        organizationId: org.organizationId,
        customerId: customer.id,
        certificateDomain: regionalCertificateDomain(customer.dnsScope, APEX),
        certificateStatus: 'ISSUED',
        certificateArn: 'arn:aws:acm:us-east-1:123456789012:certificate/attach-gone',
        issuedAt: new Date(),
        lastVerifiedAt: new Date(),
        validationDnsReadyAt: new Date(),
      });
      const token = `relay-token-${crypto.randomUUID()}`;
      await db
        .update(schema.deployments)
        .set({
          relayTokenHash: hashRelayToken(token),
          relayStatus: 'CONNECTED',
          defaultHttps: regionalDefaultHttps(deployment.id, customer.dnsScope, certRow.id, {
            status: 'PENDING',
            routingTarget: 'alb-attach.us-east-1.elb.amazonaws.com',
          }),
        })
        .where(eq(schema.deployments.id, deployment.id));
      const [job] = await db
        .insert(schema.deploymentJobs)
        .values({
          deploymentId: deployment.id,
          type: 'ATTACH_CERTIFICATE',
          state: 'RUNNING',
          idempotencyKey: `${deployment.id}:ATTACH_CERTIFICATE:0`,
          payload: { certificateArn: certRow.certificateArn, hostname: 'placeholder' },
        })
        .returning();

      const response = await postJson(
        app,
        `/api/relay/commands/${job!.id}/result`,
        { success: false, error: 'CertificateNotFound', failureCode: 'UNKNOWN' },
        { authorization: `Bearer ${token}` },
      );
      expect(response.statusCode).toBe(200);

      const [dep] = await db.select().from(schema.deployments).where(eq(schema.deployments.id, deployment.id));
      expect(dep!.state).toBe('HEALTHY');
      expect((dep!.defaultHttps as { status: string }).status).toBe('PENDING');
      const [row] = await db
        .select()
        .from(schema.customerRegionalCertificates)
        .where(eq(schema.customerRegionalCertificates.id, certRow.id));
      expect(row!.certificateStatus).toBe('ISSUED');
      expect(row!.lastVerifiedAt).toBeNull();
    });
  });

  // ── (f) scope reuse ──────────────────────────────────────────────────────

  describe('scope reuse', () => {
    it('a second deployment in the same customer+account+region reuses the certificate row, no second ENSURE when already ISSUED', async () => {
      const customer = await insertCustomer(db, org.organizationId);
      const first = await insertDeployment(db, org.organizationId, application.id, customer.id, {
        installationId: null,
      });
      const token1 = `relay-token-${crypto.randomUUID()}`;
      await postJson(
        app,
        '/api/relay/register',
        {
          enrollmentCode: first.enrollmentCode,
          installationId: `inst-${crypto.randomUUID()}`,
          awsAccountId: AWS_ACCOUNT_ID,
          customerScope: customer.dnsScope,
        },
        { authorization: `Bearer ${token1}` },
      );
      const firstCertRows = await db
        .select()
        .from(schema.customerRegionalCertificates)
        .where(eq(schema.customerRegionalCertificates.customerId, customer.id));
      expect(firstCertRows).toHaveLength(1);

      // Mark it ISSUED-and-fresh, simulating a completed first ensure cycle.
      await db
        .update(schema.customerRegionalCertificates)
        .set({ certificateStatus: 'ISSUED', certificateArn: 'arn:aws:acm:us-east-1:123456789012:certificate/shared', lastVerifiedAt: new Date(), issuedAt: new Date() })
        .where(eq(schema.customerRegionalCertificates.id, firstCertRows[0]!.id));

      const second = await insertDeployment(db, org.organizationId, application.id, customer.id, {
        installationId: null,
      });
      const token2 = `relay-token-${crypto.randomUUID()}`;
      await postJson(
        app,
        '/api/relay/register',
        {
          enrollmentCode: second.enrollmentCode,
          installationId: `inst-${crypto.randomUUID()}`,
          awsAccountId: AWS_ACCOUNT_ID,
          customerScope: customer.dnsScope,
        },
        { authorization: `Bearer ${token2}` },
      );

      const certRows = await db
        .select()
        .from(schema.customerRegionalCertificates)
        .where(eq(schema.customerRegionalCertificates.customerId, customer.id));
      expect(certRows).toHaveLength(1);
      expect(certRows[0]!.id).toBe(firstCertRows[0]!.id);

      const [secondDep] = await db.select().from(schema.deployments).where(eq(schema.deployments.id, second.id));
      expect((secondDep!.defaultHttps as { certificateId: string }).certificateId).toBe(firstCertRows[0]!.id);

      // No new ENSURE_CERTIFICATE job was minted for an already-ISSUED-and-fresh row.
      const ensureJobs = await db
        .select()
        .from(schema.deploymentJobs)
        .where(eq(schema.deploymentJobs.type, 'ENSURE_CERTIFICATE'));
      const scopedEnsureJobs = ensureJobs.filter((j) => j.idempotencyKey.includes(firstCertRows[0]!.id));
      expect(scopedEnsureJobs).toHaveLength(1);
    });
  });

  // ── (g) DESTROY / PURGE cleanup ─────────────────────────────────────────

  describe('DESTROY and PURGE cleanup', () => {
    it('DESTROY success deletes only the scoped deployment record (never the shared certificate/validation record)', async () => {
      const { customer, deployment } = await seedCustomerDeployment({
        awsAccountId: AWS_ACCOUNT_ID,
        state: 'HEALTHY',
      });
      const certRow = await insertRegionalCertificateRow(db, {
        organizationId: org.organizationId,
        customerId: customer.id,
        certificateDomain: regionalCertificateDomain(customer.dnsScope, APEX),
        certificateStatus: 'ISSUED',
        certificateArn: 'arn:aws:acm:us-east-1:123456789012:certificate/destroy-1',
      });
      const token = `relay-token-${crypto.randomUUID()}`;
      await db
        .update(schema.deployments)
        .set({
          relayTokenHash: hashRelayToken(token),
          relayStatus: 'CONNECTED',
          defaultHttps: regionalDefaultHttps(deployment.id, customer.dnsScope, certRow.id, {
            status: 'ACTIVE',
            routingTarget: 'alb-destroy.us-east-1.elb.amazonaws.com',
          }),
        })
        .where(eq(schema.deployments.id, deployment.id));
      // Seed the scoped routing record directly (as INSTALL would have).
      await fake.upsertScopedDeploymentRecord(deployment.id, customer.dnsScope, 'alb-destroy.us-east-1.elb.amazonaws.com');
      const validationName = `_v1.c-${customer.dnsScope}.${APEX}`;
      await fake.upsertScopeValidationRecord(customer.dnsScope, validationName, 'validate.acm-validations.aws.');

      const destroyResponse = await postJson(
        app,
        `/api/deployments/${deployment.id}/destroy`,
        {},
        { cookie: org.cookie },
      );
      expect(destroyResponse.statusCode).toBe(202);
      const destroyJobs = await db
        .select()
        .from(schema.deploymentJobs)
        .where(and(eq(schema.deploymentJobs.deploymentId, deployment.id), eq(schema.deploymentJobs.type, 'DESTROY')));
      expect(destroyJobs).toHaveLength(1);

      const resultResponse = await postJson(
        app,
        `/api/relay/commands/${destroyJobs[0]!.id}/result`,
        { success: true, output: {} },
        { authorization: `Bearer ${token}` },
      );
      expect(resultResponse.statusCode).toBe(200);

      const hostname = scopedDeploymentHostname(deployment.id, customer.dnsScope, { zone: APEX });
      expect(fake.listRecords().find((r) => r.name.toLowerCase() === hostname.toLowerCase())).toBeUndefined();
      // The shared validation record and the certificate row survive DESTROY.
      expect(fake.listRecords().find((r) => r.name.toLowerCase() === validationName.toLowerCase())).toBeDefined();
      const [survivingCert] = await db
        .select()
        .from(schema.customerRegionalCertificates)
        .where(eq(schema.customerRegionalCertificates.id, certRow.id));
      expect(survivingCert).toBeDefined();
    });

    it('purging the last deployment in a scope carries regionalCertificates and removes the row + validation record on success', async () => {
      const customer = await insertCustomer(db, org.organizationId);
      const certRow = await insertRegionalCertificateRow(db, {
        organizationId: org.organizationId,
        customerId: customer.id,
        certificateDomain: regionalCertificateDomain(customer.dnsScope, APEX),
        certificateStatus: 'ISSUED',
        certificateArn: 'arn:aws:acm:us-east-1:123456789012:certificate/purge-last',
      });
      const validationName = `_v2.c-${customer.dnsScope}.${APEX}`;
      await db
        .update(schema.customerRegionalCertificates)
        .set({ validationRecordName: validationName, validationRecordValue: 'validate.acm-validations.aws.' })
        .where(eq(schema.customerRegionalCertificates.id, certRow.id));
      await fake.upsertScopeValidationRecord(customer.dnsScope, validationName, 'validate.acm-validations.aws.');

      const deployment = await insertDeployment(db, org.organizationId, application.id, customer.id, {
        installationId: null,
        awsAccountId: AWS_ACCOUNT_ID,
        state: 'DELETED',
        deletedAt: new Date(),
        cleanupState: 'SKIPPED_RELAY_OFFLINE',
      });
      const token = `relay-token-${crypto.randomUUID()}`;
      await db
        .update(schema.deployments)
        .set({ relayTokenHash: hashRelayToken(token) })
        .where(eq(schema.deployments.id, deployment.id));

      const purgeResponse = await postJson(app, `/api/deployments/${deployment.id}/purge`, {}, { cookie: org.cookie });
      expect(purgeResponse.statusCode).toBe(202);
      const [purgeJob] = await db
        .select()
        .from(schema.deploymentJobs)
        .where(and(eq(schema.deploymentJobs.deploymentId, deployment.id), eq(schema.deploymentJobs.type, 'PURGE')));
      expect(purgeJob).toBeDefined();
      expect((purgeJob!.payload as { regionalCertificates?: unknown[] }).regionalCertificates).toEqual([
        { certificateArn: certRow.certificateArn },
      ]);

      const resultResponse = await postJson(
        app,
        `/api/relay/commands/${purgeJob!.id}/result`,
        { success: true, output: {} },
        { authorization: `Bearer ${token}` },
      );
      expect(resultResponse.statusCode).toBe(200);

      const remainingCert = await db
        .select()
        .from(schema.customerRegionalCertificates)
        .where(eq(schema.customerRegionalCertificates.id, certRow.id));
      expect(remainingCert).toHaveLength(0);
      expect(fake.listRecords().find((r) => r.name.toLowerCase() === validationName.toLowerCase())).toBeUndefined();
    });

    it('purging a deployment with a live sibling in the same scope carries no regionalCertificates', async () => {
      const customer = await insertCustomer(db, org.organizationId);
      const certRow = await insertRegionalCertificateRow(db, {
        organizationId: org.organizationId,
        customerId: customer.id,
        certificateDomain: regionalCertificateDomain(customer.dnsScope, APEX),
        certificateStatus: 'ISSUED',
        certificateArn: 'arn:aws:acm:us-east-1:123456789012:certificate/purge-sibling',
      });
      // A live sibling in the exact same scope.
      await insertDeployment(db, org.organizationId, application.id, customer.id, {
        installationId: null,
        awsAccountId: AWS_ACCOUNT_ID,
        state: 'HEALTHY',
      });
      const deployment = await insertDeployment(db, org.organizationId, application.id, customer.id, {
        installationId: null,
        awsAccountId: AWS_ACCOUNT_ID,
        state: 'DELETED',
        deletedAt: new Date(),
        cleanupState: 'SKIPPED_RELAY_OFFLINE',
      });
      const token = `relay-token-${crypto.randomUUID()}`;
      await db
        .update(schema.deployments)
        .set({ relayTokenHash: hashRelayToken(token) })
        .where(eq(schema.deployments.id, deployment.id));

      const purgeResponse = await postJson(app, `/api/deployments/${deployment.id}/purge`, {}, { cookie: org.cookie });
      expect(purgeResponse.statusCode).toBe(202);
      const [purgeJob] = await db
        .select()
        .from(schema.deploymentJobs)
        .where(and(eq(schema.deploymentJobs.deploymentId, deployment.id), eq(schema.deploymentJobs.type, 'PURGE')));
      expect(purgeJob).toBeDefined();
      expect((purgeJob!.payload as { regionalCertificates?: unknown[] }).regionalCertificates).toBeUndefined();

      // The shared row is untouched.
      const [stillThere] = await db
        .select()
        .from(schema.customerRegionalCertificates)
        .where(eq(schema.customerRegionalCertificates.id, certRow.id));
      expect(stillThere).toBeDefined();
    });
  });

  // ── (h) retry route ──────────────────────────────────────────────────────

  describe('POST /api/deployments/:id/default-https/retry (regional)', () => {
    it('resets an ERROR certificate row and the machine back to PENDING', async () => {
      const { customer, deployment } = await seedCustomerDeployment({ awsAccountId: AWS_ACCOUNT_ID, state: 'HEALTHY' });
      const certRow = await insertRegionalCertificateRow(db, {
        organizationId: org.organizationId,
        customerId: customer.id,
        certificateDomain: regionalCertificateDomain(customer.dnsScope, APEX),
        certificateStatus: 'ERROR',
        lastError: 'CERTIFICATE_FAILED',
        attempts: 3,
      });
      await db
        .update(schema.deployments)
        .set({
          defaultHttps: regionalDefaultHttps(deployment.id, customer.dnsScope, certRow.id, {
            status: 'ERROR',
            lastError: 'ATTACH_TIMEOUT',
          }),
        })
        .where(eq(schema.deployments.id, deployment.id));

      const response = await postJson(
        app,
        `/api/deployments/${deployment.id}/default-https/retry`,
        {},
        { cookie: org.cookie },
      );
      expect(response.statusCode).toBe(200);

      const [dep] = await db.select().from(schema.deployments).where(eq(schema.deployments.id, deployment.id));
      expect((dep!.defaultHttps as { status: string; lastError: string | null }).status).toBe('PENDING');
      expect((dep!.defaultHttps as { lastError: string | null }).lastError).toBeNull();

      const [updatedCert] = await db
        .select()
        .from(schema.customerRegionalCertificates)
        .where(eq(schema.customerRegionalCertificates.id, certRow.id));
      expect(updatedCert!.certificateStatus).toBe('REQUESTING');
      // retryRegionalCertificate resets the budget to 0, but the retry
      // route's own follow-up immediately calls ensureRegionalCertificate to
      // kick off the next attempt — which mints a fresh ENSURE_CERTIFICATE
      // job and so consumes exactly one attempt right away.
      expect(updatedCert!.attempts).toBe(1);
      expect(updatedCert!.lastError).toBeNull();
    });
  });
});
