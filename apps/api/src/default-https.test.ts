import { PGlite } from '@electric-sql/pglite';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { applyMigrations, createDb, type Db } from '@deployz/db';
import * as schema from '@deployz/db/schema';

import {
  applyDefaultHttpsJobResult,
  beginDefaultHttpsRemoval,
  DEFAULT_HTTPS_APEX,
  defaultHttpsHostname,
  ensureDefaultHttpsConfigureJob,
  isDefaultHttpsJob,
  parseDefaultHttps,
  runDefaultHttpsCheck,
  type DefaultHttpsDeps,
} from './default-https.js';
import { createCustomDomain } from './domains.js';
import type { DnsRecordClient } from './route53-records.js';

// Phase 11 — the default-HTTPS state machine over a fresh in-memory PGlite
// (real Postgres semantics, full migrations, including the jsonb column this
// machine lives in). All AWS interaction is behind the injected seams — no
// real Route53, ACM or DNS ever runs.

describe('default-https service', () => {
  let client: PGlite | undefined;
  let db: Db;

  beforeAll(async () => {
    client = new PGlite();
    await applyMigrations(client);
    db = createDb(client);
  }, 60_000);

  afterAll(async () => {
    await client?.close();
  });

  async function insertOrg(overrides: Partial<typeof schema.organization.$inferInsert> = {}) {
    const id = `org-${crypto.randomUUID()}`;
    const [row] = await db
      .insert(schema.organization)
      .values({ id, name: 'Test Org', slug: `test-org-${crypto.randomUUID().slice(0, 8)}`, ...overrides })
      .returning();
    return row!;
  }

  async function insertApplication(organizationId: string) {
    const [row] = await db
      .insert(schema.applications)
      .values({
        organizationId,
        name: 'Test App',
        repoFullName: `acme/https-app-${crypto.randomUUID().slice(0, 8)}`,
        repoUrl: 'https://github.com/acme/https-app',
        defaultBranch: 'main',
      })
      .returning();
    return row!;
  }

  async function insertCustomer(organizationId: string) {
    const [row] = await db
      .insert(schema.customers)
      .values({
        organizationId,
        name: 'Test Customer',
        email: `customer-${crypto.randomUUID()}@example.com`,
      })
      .returning();
    return row!;
  }

  async function seedDeployment(
    overrides: Partial<typeof schema.deployments.$inferInsert> = {},
  ): Promise<typeof schema.deployments.$inferSelect> {
    const org = await insertOrg();
    const application = await insertApplication(org.id);
    const customer = await insertCustomer(org.id);
    const [row] = await db
      .insert(schema.deployments)
      .values({
        organizationId: org.id,
        applicationId: application.id,
        customerId: customer.id,
        region: 'us-east-1',
        state: 'HEALTHY',
        installationId: `inst-${crypto.randomUUID()}`,
        enrollmentCode: crypto.randomUUID(),
        ...overrides,
      })
      .returning();
    return row!;
  }

  async function stateOf(deploymentId: string) {
    const rows = await db
      .select({ defaultHttps: schema.deployments.defaultHttps })
      .from(schema.deployments)
      .where(eq(schema.deployments.id, deploymentId))
      .limit(1);
    return parseDefaultHttps(rows[0]?.defaultHttps ?? null);
  }

  async function jobsFor(deploymentId: string) {
    return db.select().from(schema.deploymentJobs).where(eq(schema.deploymentJobs.deploymentId, deploymentId));
  }

  class FakeDnsClient implements DnsRecordClient {
    upserts: Array<{ name: string; value: string }> = [];
    deletes: string[] = [];
    failUpserts = false;
    async upsertCname(name: string, value: string): Promise<void> {
      if (this.failUpserts) throw new Error('boom');
      this.upserts.push({ name, value });
    }
    async deleteCname(name: string): Promise<void> {
      this.deletes.push(name);
    }
  }

  const apex = 'apps.deployz.test';

  function deps(overrides: Partial<DefaultHttpsDeps> = {}): DefaultHttpsDeps {
    return {
      enabled: true,
      apex,
      dns: new FakeDnsClient(),
      probeHttps: async () => true,
      ...overrides,
    };
  }

  describe('runDefaultHttpsCheck — start', () => {
    it('is a no-op while the feature is disabled', async () => {
      const deployment = await seedDeployment();
      await runDefaultHttpsCheck(db, deployment, deps({ enabled: false }));
      expect(await stateOf(deployment.id)).toBeNull();
      expect(await jobsFor(deployment.id)).toHaveLength(0);
    });

    it('creates a PENDING state + cycle-0 CONFIGURE_DOMAIN job for an installed deployment', async () => {
      const deployment = await seedDeployment();
      await runDefaultHttpsCheck(db, deployment, deps());

      const state = await stateOf(deployment.id);
      expect(state?.status).toBe('PENDING');
      expect(state?.hostname).toBe(defaultHttpsHostname(deployment.id, apex));
      expect(state?.lastError).toBeNull();

      const jobs = await jobsFor(deployment.id);
      expect(jobs).toHaveLength(1);
      expect(jobs[0]!.type).toBe('CONFIGURE_DOMAIN');
      expect(jobs[0]!.idempotencyKey).toBe(`${deployment.id}:CONFIGURE_DOMAIN:default-https:0`);
      expect(jobs[0]!.payload).toMatchObject({
        hostname: defaultHttpsHostname(deployment.id, apex),
        domainId: deployment.id,
      });
    });

    it('does not start while an ACTIVE/CONFIGURING custom domain is the serving URL', async () => {
      const deployment = await seedDeployment();
      await createCustomDomain(db, deployment, `app.${crypto.randomUUID().slice(0, 8)}.customer.com`, 'user-1');
      await db
        .update(schema.customDomains)
        .set({ status: 'ACTIVE' })
        .where(eq(schema.customDomains.deploymentId, deployment.id));
      await runDefaultHttpsCheck(db, deployment, deps());
      expect(await stateOf(deployment.id)).toBeNull();
    });

    it('does nothing for deployments that are not installed', async () => {
      const deployment = await seedDeployment({ state: 'INSTALLING' });
      await runDefaultHttpsCheck(db, deployment, deps());
      expect(await stateOf(deployment.id)).toBeNull();
    });
  });

  describe('runDefaultHttpsCheck — progression', () => {
    async function install() {
      const deployment = await seedDeployment();
      await runDefaultHttpsCheck(db, deployment, deps());
      return deployment;
    }

    async function settleNewestConfigureJob(
      deploymentId: string,
      output: Record<string, unknown>,
      success = true,
    ) {
      const jobs = (await jobsFor(deploymentId)).filter((job) => job.type === 'CONFIGURE_DOMAIN');
      const job = jobs[jobs.length - 1]!;
      await db
        .update(schema.deploymentJobs)
        .set({ state: success ? 'SUCCEEDED' : 'FAILED', finishedAt: new Date() })
        .where(eq(schema.deploymentJobs.id, job.id));
      await applyDefaultHttpsJobResult(db, deploymentId, job, { success, output });
      return job;
    }

    it('an in-flight configure job blocks a duplicate on the next driver pass', async () => {
      const deployment = await install();
      await runDefaultHttpsCheck(db, deployment, deps());
      const jobs = (await jobsFor(deployment.id)).filter((job) => job.type === 'CONFIGURE_DOMAIN');
      expect(jobs).toHaveLength(1);
    });

    it('WAITING_FOR_DNS writes the validation + routing CNAMEs and mints a fresh cycle', async () => {
      const deployment = await install();
      const dns = new FakeDnsClient();
      await settleNewestConfigureJob(deployment.id, {
        certificateArn: 'arn:aws:acm:us-east-1:1:certificate/abc',
        validationName: `_x1.${defaultHttpsHostname(deployment.id, apex)}`,
        validationValue: '_y1.acm-validations.aws.',
        routingTarget: 'alb.us-east-1.elb.amazonaws.com',
      });
      expect((await stateOf(deployment.id))?.status).toBe('WAITING_FOR_DNS');

      await runDefaultHttpsCheck(db, deployment, deps({ dns }));
      expect(dns.upserts).toEqual([
        {
          name: `_x1.${defaultHttpsHostname(deployment.id, apex)}`,
          value: '_y1.acm-validations.aws.',
        },
        { name: defaultHttpsHostname(deployment.id, apex), value: 'alb.us-east-1.elb.amazonaws.com' },
      ]);
      const jobs = (await jobsFor(deployment.id)).filter((job) => job.type === 'CONFIGURE_DOMAIN');
      expect(jobs).toHaveLength(2);
      expect(jobs.some((job) => job.idempotencyKey.endsWith(':1'))).toBe(true);
    });

    it('a DNS write failure records DNS_WRITE_FAILED and mints no new job', async () => {
      const deployment = await install();
      const dns = new FakeDnsClient();
      dns.failUpserts = true;
      await settleNewestConfigureJob(deployment.id, {
        certificateArn: 'arn:aws:acm:us-east-1:1:certificate/abc',
        validationName: `_x1.${defaultHttpsHostname(deployment.id, apex)}`,
        validationValue: '_y1.acm-validations.aws.',
        routingTarget: 'alb.us-east-1.elb.amazonaws.com',
      });

      await runDefaultHttpsCheck(db, deployment, deps({ dns }));
      const state = await stateOf(deployment.id);
      expect(state?.status).toBe('WAITING_FOR_DNS');
      expect(state?.lastError).toBe('DNS_WRITE_FAILED');
      const jobs = (await jobsFor(deployment.id)).filter((job) => job.type === 'CONFIGURE_DOMAIN');
      expect(jobs).toHaveLength(1);
    });

    it('CONFIGURING activates once the HTTPS probe passes', async () => {
      const deployment = await install();
      await settleNewestConfigureJob(deployment.id, {
        certificateArn: 'arn:aws:acm:us-east-1:1:certificate/abc',
        validationName: `_x1.${defaultHttpsHostname(deployment.id, apex)}`,
        validationValue: '_y1.acm-validations.aws.',
      });
      const stateBefore = await stateOf(deployment.id);
      await db
        .update(schema.deployments)
        .set({ defaultHttps: { ...stateBefore, status: 'CONFIGURING' } })
        .where(eq(schema.deployments.id, deployment.id));

      await runDefaultHttpsCheck(db, deployment, deps({ probeHttps: async () => true }));
      const state = await stateOf(deployment.id);
      expect(state?.status).toBe('ACTIVE');
      expect(state?.lastError).toBeNull();
    });

    it('CONFIGURING holds with HTTPS_NOT_REACHABLE while the probe fails', async () => {
      const deployment = await install();
      await settleNewestConfigureJob(deployment.id, {});
      const stateBefore = await stateOf(deployment.id);
      await db
        .update(schema.deployments)
        .set({ defaultHttps: { ...stateBefore, status: 'CONFIGURING' } })
        .where(eq(schema.deployments.id, deployment.id));

      await runDefaultHttpsCheck(db, deployment, deps({ probeHttps: async () => false }));
      const state = await stateOf(deployment.id);
      expect(state?.status).toBe('CONFIGURING');
      expect(state?.lastError).toBe('HTTPS_NOT_REACHABLE');
    });

    it('ERROR retries automatically: falls back and re-runs the earliest stage', async () => {
      const deployment = await install();
      await settleNewestConfigureJob(deployment.id, {
        certificateArn: 'arn:aws:acm:us-east-1:1:certificate/abc',
        validationName: `_x1.${defaultHttpsHostname(deployment.id, apex)}`,
        validationValue: '_y1.acm-validations.aws.',
        routingTarget: 'alb.us-east-1.elb.amazonaws.com',
      });
      await db
        .update(schema.deployments)
        .set({ defaultHttps: { ...(await stateOf(deployment.id))!, status: 'ERROR', lastError: 'CONFIGURE_FAILED' } })
        .where(eq(schema.deployments.id, deployment.id));

      await runDefaultHttpsCheck(db, deployment, deps());
      const state = await stateOf(deployment.id);
      // Records were (re)written and a fresh cycle was minted from the
      // WAITING_FOR_DNS fallback.
      expect(state?.status).toBe('WAITING_FOR_DNS');
      expect(state?.lastError).toBeNull();
      const jobs = (await jobsFor(deployment.id)).filter((job) => job.type === 'CONFIGURE_DOMAIN');
      expect(jobs).toHaveLength(2);
    });
  });

  describe('applyDefaultHttpsJobResult', () => {
    async function seedWithState(extra: Record<string, unknown> = {}) {
      const deployment = await seedDeployment();
      const state = {
        hostname: defaultHttpsHostname(deployment.id, apex),
        status: 'PENDING',
        checkCycle: 0,
        lastError: null,
        ...extra,
      };
      await db
        .update(schema.deployments)
        .set({ defaultHttps: state })
        .where(eq(schema.deployments.id, deployment.id));
      const fakeJob = {
        id: crypto.randomUUID(),
        deploymentId: deployment.id,
        type: 'CONFIGURE_DOMAIN',
      } as typeof schema.deploymentJobs.$inferSelect;
      return { deployment, fakeJob };
    }

    it('applies cert/validation output and moves PENDING -> WAITING_FOR_DNS', async () => {
      const { deployment, fakeJob } = await seedWithState();
      await applyDefaultHttpsJobResult(db, deployment.id, fakeJob, {
        success: true,
        output: {
          certificateArn: 'arn:aws:acm:us-east-1:1:certificate/abc',
          validationName: '_x.apps.deployz.test',
          validationValue: '_y.acm-validations.aws.',
        },
      });
      const state = await stateOf(deployment.id);
      expect(state?.status).toBe('WAITING_FOR_DNS');
      expect(state?.certificateArn).toBe('arn:aws:acm:us-east-1:1:certificate/abc');
      expect(state?.validationName).toBe('_x.apps.deployz.test');
    });

    it('moves WAITING_FOR_DNS -> CONFIGURING when the cert is ISSUED and HTTPS is wired', async () => {
      const { deployment, fakeJob } = await seedWithState({ status: 'WAITING_FOR_DNS' });
      await applyDefaultHttpsJobResult(db, deployment.id, fakeJob, {
        success: true,
        output: { certificateStatus: 'ISSUED', httpsConfigured: true, routingTarget: 'alb.example.com' },
      });
      const state = await stateOf(deployment.id);
      expect(state?.status).toBe('CONFIGURING');
      expect(state?.routingTarget).toBe('alb.example.com');
    });

    it('a configure failure sets ERROR with the classified lastError', async () => {
      const { deployment, fakeJob } = await seedWithState();
      await applyDefaultHttpsJobResult(db, deployment.id, fakeJob, {
        success: false,
        failureCode: 'AWS_PERMISSION_DENIED',
      });
      const state = await stateOf(deployment.id);
      expect(state?.status).toBe('ERROR');
      expect(state?.lastError).toBe('AWS_PERMISSION_DENIED');
    });

    it('a REMOVE_DOMAIN success clears the state', async () => {
      const { deployment } = await seedWithState();
      const fakeRemove = {
        id: crypto.randomUUID(),
        deploymentId: deployment.id,
        type: 'REMOVE_DOMAIN',
      } as typeof schema.deploymentJobs.$inferSelect;
      await applyDefaultHttpsJobResult(db, deployment.id, fakeRemove, { success: true });
      expect(await stateOf(deployment.id)).toBeNull();
    });

    it('a REMOVE_DOMAIN failure keeps REMOVING with REMOVE_FAILED', async () => {
      const { deployment } = await seedWithState({ status: 'REMOVING' });
      const fakeRemove = {
        id: crypto.randomUUID(),
        deploymentId: deployment.id,
        type: 'REMOVE_DOMAIN',
      } as typeof schema.deploymentJobs.$inferSelect;
      await applyDefaultHttpsJobResult(db, deployment.id, fakeRemove, { success: false });
      const state = await stateOf(deployment.id);
      expect(state?.status).toBe('REMOVING');
      expect(state?.lastError).toBe('REMOVE_FAILED');
    });
  });

  describe('beginDefaultHttpsRemoval', () => {
    it('marks REMOVING and mints one REMOVE_DOMAIN job carrying the certificate arn', async () => {
      const deployment = await seedDeployment();
      const state = {
        hostname: defaultHttpsHostname(deployment.id, apex),
        status: 'ACTIVE',
        certificateArn: 'arn:aws:acm:us-east-1:1:certificate/abc',
        checkCycle: 2,
        lastError: null,
      };
      await db
        .update(schema.deployments)
        .set({ defaultHttps: state })
        .where(eq(schema.deployments.id, deployment.id));

      await beginDefaultHttpsRemoval(db, deployment, state);
      expect((await stateOf(deployment.id))?.status).toBe('REMOVING');

      const removeJobs = (await jobsFor(deployment.id)).filter((job) => job.type === 'REMOVE_DOMAIN');
      expect(removeJobs).toHaveLength(1);
      expect(removeJobs[0]!.payload).toMatchObject({
        hostname: defaultHttpsHostname(deployment.id, apex),
        domainId: deployment.id,
        certificateArn: 'arn:aws:acm:us-east-1:1:certificate/abc',
      });
      expect(removeJobs[0]!.idempotencyKey).toBe(`${deployment.id}:REMOVE_DOMAIN:default-https:3`);

      // A repeat call reuses the in-flight job — no retry storm.
      await beginDefaultHttpsRemoval(db, deployment, { ...state, status: 'REMOVING', checkCycle: 3 });
      expect((await jobsFor(deployment.id)).filter((job) => job.type === 'REMOVE_DOMAIN')).toHaveLength(1);
    });
  });

  describe('helpers', () => {
    it('isDefaultHttpsJob recognises the machine namespace and nothing else', () => {
      expect(isDefaultHttpsJob({ idempotencyKey: 'dep-1:CONFIGURE_DOMAIN:default-https:1' })).toBe(true);
      expect(
        isDefaultHttpsJob({ idempotencyKey: 'dep-1:CONFIGURE_DOMAIN:11111111-2222-3333-4444-555555555555:0' }),
      ).toBe(false);
    });

    it('parseDefaultHttps accepts a full state and rejects garbage', () => {
      const hostname = defaultHttpsHostname('dep-1', DEFAULT_HTTPS_APEX);
      const parsed = parseDefaultHttps({ hostname, status: 'ACTIVE', checkCycle: 1, lastError: null });
      expect(parsed?.status).toBe('ACTIVE');
      expect(parseDefaultHttps(null)).toBeNull();
      expect(parseDefaultHttps({ status: 'BOGUS' })).toBeNull();
      expect(parseDefaultHttps({ hostname, status: 'ACTIVE' })).not.toBeNull();
    });

    it('ensureDefaultHttpsConfigureJob with a finished job at the current cycle bumps the cycle', async () => {
      const deployment = await seedDeployment();
      const state = {
        hostname: defaultHttpsHostname(deployment.id, apex),
        status: 'PENDING',
        checkCycle: 0,
        lastError: null,
      };
      await ensureDefaultHttpsConfigureJob(db, deployment, state);
      const jobs = (await jobsFor(deployment.id)).filter((job) => job.type === 'CONFIGURE_DOMAIN');
      expect(jobs).toHaveLength(1);
      await db
        .update(schema.deploymentJobs)
        .set({ state: 'SUCCEEDED', finishedAt: new Date() })
        .where(eq(schema.deploymentJobs.id, jobs[0]!.id));
      // A fresh pass with the same current cycle bumps it to 1 and mints a
      // fresh idempotency key instead of replaying the finished job's.
      await ensureDefaultHttpsConfigureJob(db, deployment, state);
      const after = (await jobsFor(deployment.id)).filter((job) => job.type === 'CONFIGURE_DOMAIN');
      expect(after).toHaveLength(2);
      expect(after.some((job) => job.idempotencyKey.endsWith(':1'))).toBe(true);
      expect((await stateOf(deployment.id))?.checkCycle).toBe(1);
    });

    it('uses the production apex by default', () => {
      expect(defaultHttpsHostname('dep-1', DEFAULT_HTTPS_APEX)).toBe('dep-1.apps.deployz.dev');
    });
  });
});
