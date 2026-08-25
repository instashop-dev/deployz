import { PGlite } from '@electric-sql/pglite';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { applyMigrations, createDb, type Db } from '@deployz/db';
import * as schema from '@deployz/db/schema';

import {
  applyDomainJobResult,
  classifyDomainUniqueViolation,
  createCustomDomain,
  ensureConfigureJob,
  findActiveDomain,
  isDomainJobType,
  removeCustomDomain,
  toDomainView,
  type CustomDomainRow,
} from './domains.js';
import { ApiError } from './errors.js';

// Custom-domains MVP — the domain service over a fresh in-memory PGlite (real
// Postgres semantics, full migrations, including the partial unique
// indexes the create/remove race handling depends on).
describe('domains (custom-domain service)', () => {
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
        repoFullName: `acme/test-app-${crypto.randomUUID().slice(0, 8)}`,
        repoUrl: 'https://github.com/acme/test-app',
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

  async function insertDeployment(organizationId: string, applicationId: string, customerId: string) {
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
      })
      .returning();
    return row!;
  }

  /** A full deployment (org + application + customer + deployment), the unit createCustomDomain/removeCustomDomain operate on. */
  async function seedDeployment() {
    const org = await insertOrg();
    const application = await insertApplication(org.id);
    const customer = await insertCustomer(org.id);
    const deployment = await insertDeployment(org.id, application.id, customer.id);
    return { org, deployment };
  }

  async function jobsFor(deploymentId: string) {
    return db.select().from(schema.deploymentJobs).where(eq(schema.deploymentJobs.deploymentId, deploymentId));
  }

  // The active-hostname unique index is global across all of Deployz, and
  // every test below shares one PGlite instance — each test needs its own
  // hostname unless the whole point of the test IS reusing one.
  function freshHostname(label = 'app') {
    return `${label}-${crypto.randomUUID().slice(0, 8)}.customer.com`;
  }

  describe('createCustomDomain', () => {
    it('creates a PENDING row (hostname normalized) with a cycle-0 CONFIGURE_DOMAIN job', async () => {
      const { deployment } = await seedDeployment();
      const hostname = freshHostname();
      const domain = await createCustomDomain(db, deployment, `  ${hostname.toUpperCase()}. `, 'user-1');

      expect(domain.hostname).toBe(hostname);
      expect(domain.status).toBe('PENDING');
      expect(domain.createdBy).toBe('user-1');

      const jobs = await jobsFor(deployment.id);
      expect(jobs).toHaveLength(1);
      expect(jobs[0]!.type).toBe('CONFIGURE_DOMAIN');
      expect(jobs[0]!.idempotencyKey).toBe(`${deployment.id}:CONFIGURE_DOMAIN:${domain.id}:0`);
      expect(jobs[0]!.payload).toMatchObject({ hostname, domainId: domain.id });

      const events = await db
        .select()
        .from(schema.eventLogs)
        .where(eq(schema.eventLogs.deploymentId, deployment.id));
      expect(events).toHaveLength(1);
      expect(events[0]!.eventType).toBe('domain.added');
      expect(events[0]!.actorType).toBe('user');
      expect(events[0]!.actorId).toBe('user-1');
      expect(events[0]!.result).toBe('success');
      expect(events[0]!.payload).toMatchObject({ hostname });
    });

    it('rejects a URL with ApiError 400 URL_ENTERED', async () => {
      const { deployment } = await seedDeployment();
      await expect(createCustomDomain(db, deployment, 'https://app.customer.com', 'user-1')).rejects.toMatchObject({
        statusCode: 400,
        code: 'URL_ENTERED',
      });
    });

    it('rejects an apex domain with ApiError 400 ROOT_DOMAIN', async () => {
      const { deployment } = await seedDeployment();
      await expect(createCustomDomain(db, deployment, 'customer.com', 'user-1')).rejects.toMatchObject({
        statusCode: 400,
        code: 'ROOT_DOMAIN',
      });
    });

    it('rejects a wildcard domain with ApiError 400 WILDCARD_NOT_SUPPORTED', async () => {
      const { deployment } = await seedDeployment();
      await expect(createCustomDomain(db, deployment, '*.customer.com', 'user-1')).rejects.toMatchObject({
        statusCode: 400,
        code: 'WILDCARD_NOT_SUPPORTED',
      });
    });

    it('rejects a second domain on the same deployment with 409 DOMAIN_EXISTS', async () => {
      const { deployment } = await seedDeployment();
      await createCustomDomain(db, deployment, freshHostname(), 'user-1');
      await expect(createCustomDomain(db, deployment, freshHostname(), 'user-1')).rejects.toMatchObject({
        statusCode: 409,
        code: 'DOMAIN_EXISTS',
      });
    });

    it('rejects the same hostname already active on a different deployment (other org) with 409 DOMAIN_TAKEN, never naming the other org', async () => {
      const { deployment: firstDeployment } = await seedDeployment();
      const { deployment: secondDeployment } = await seedDeployment();
      const hostname = freshHostname();
      await createCustomDomain(db, firstDeployment, hostname, 'user-1');

      try {
        await createCustomDomain(db, secondDeployment, hostname, 'user-2');
        expect.unreachable('expected createCustomDomain to throw');
      } catch (error) {
        expect(error).toBeInstanceOf(ApiError);
        const apiError = error as ApiError;
        expect(apiError.statusCode).toBe(409);
        expect(apiError.code).toBe('DOMAIN_TAKEN');
        expect(apiError.message).not.toContain(firstDeployment.id);
        expect(apiError.message).not.toContain(firstDeployment.organizationId);
      }
    });

    it('allows re-creating the same hostname once the prior domain has been removed (removedAt set)', async () => {
      const { deployment } = await seedDeployment();
      const hostname = freshHostname();
      const domain = await createCustomDomain(db, deployment, hostname, 'user-1');

      const removing = await removeCustomDomain(db, deployment, domain);
      const removeJob = (await jobsFor(deployment.id)).find((job) => job.type === 'REMOVE_DOMAIN')!;
      await applyDomainJobResult(db, deployment, removeJob, { success: true });

      const removed = await db
        .select()
        .from(schema.customDomains)
        .where(eq(schema.customDomains.id, removing.id));
      expect(removed[0]!.removedAt).not.toBeNull();

      const recreated = await createCustomDomain(db, deployment, hostname, 'user-1');
      expect(recreated.hostname).toBe(hostname);
      expect(recreated.id).not.toBe(domain.id);
    });
  });

  describe('findActiveDomain', () => {
    it('returns null when there is no active domain', async () => {
      const { deployment } = await seedDeployment();
      expect(await findActiveDomain(db, deployment.id)).toBeNull();
    });

    it('returns the active domain row', async () => {
      const { deployment } = await seedDeployment();
      const domain = await createCustomDomain(db, deployment, freshHostname(), 'user-1');
      const found = await findActiveDomain(db, deployment.id);
      expect(found?.id).toBe(domain.id);
    });
  });

  describe('applyDomainJobResult', () => {
    async function configureJobFor(deploymentId: string) {
      const jobs = await jobsFor(deploymentId);
      const job = jobs.find((row) => row.type === 'CONFIGURE_DOMAIN');
      if (!job) throw new Error('expected a CONFIGURE_DOMAIN job');
      return job;
    }

    async function reload(id: string): Promise<CustomDomainRow> {
      const rows = await db.select().from(schema.customDomains).where(eq(schema.customDomains.id, id));
      return rows[0]!;
    }

    it('CONFIGURE success with validation output moves PENDING -> WAITING_FOR_DNS and stores cert/validation fields', async () => {
      const { deployment } = await seedDeployment();
      const domain = await createCustomDomain(db, deployment, freshHostname(), 'user-1');
      const job = await configureJobFor(deployment.id);

      await applyDomainJobResult(db, deployment, job, {
        success: true,
        output: {
          certificateArn: 'arn:aws:acm:us-east-1:123:certificate/abc',
          validationName: '_abc123.app.customer.com',
          validationValue: '_xyz456.acm-validations.aws.',
        },
      });

      const reloaded = await reload(domain.id);
      expect(reloaded.status).toBe('WAITING_FOR_DNS');
      expect(reloaded.certificateArn).toBe('arn:aws:acm:us-east-1:123:certificate/abc');
      expect(reloaded.validationName).toBe('_abc123.app.customer.com');
      expect(reloaded.validationValue).toBe('_xyz456.acm-validations.aws.');
      expect(reloaded.lastError).toBeNull();
    });

    it('CONFIGURE success with certificateStatus ISSUED + httpsConfigured true moves WAITING_FOR_DNS -> CONFIGURING', async () => {
      const { deployment } = await seedDeployment();
      const domain = await createCustomDomain(db, deployment, freshHostname(), 'user-1');
      const job = await configureJobFor(deployment.id);
      await applyDomainJobResult(db, deployment, job, {
        success: true,
        output: {
          validationName: '_abc.app.customer.com',
          validationValue: '_xyz.acm-validations.aws.',
        },
      });
      expect((await reload(domain.id)).status).toBe('WAITING_FOR_DNS');

      await applyDomainJobResult(db, deployment, job, {
        success: true,
        output: {
          routingTarget: 'alb-123.us-east-1.elb.amazonaws.com',
          certificateStatus: 'ISSUED',
          httpsConfigured: true,
        },
      });

      const reloaded = await reload(domain.id);
      expect(reloaded.status).toBe('CONFIGURING');
      expect(reloaded.routingTarget).toBe('alb-123.us-east-1.elb.amazonaws.com');
      expect(reloaded.lastError).toBeNull();
    });

    it('CONFIGURE failure sets ERROR + lastError CONFIGURE_FAILED and records domain.failed', async () => {
      const { deployment } = await seedDeployment();
      const hostname = freshHostname();
      const domain = await createCustomDomain(db, deployment, hostname, 'user-1');
      const job = await configureJobFor(deployment.id);

      await applyDomainJobResult(db, deployment, job, { success: false, error: 'boom' });

      const reloaded = await reload(domain.id);
      expect(reloaded.status).toBe('ERROR');
      expect(reloaded.lastError).toBe('CONFIGURE_FAILED');

      const events = await db
        .select()
        .from(schema.eventLogs)
        .where(and(eq(schema.eventLogs.deploymentId, deployment.id), eq(schema.eventLogs.eventType, 'domain.failed')));
      expect(events).toHaveLength(1);
      expect(events[0]!.result).toBe('failure');
      expect(events[0]!.payload).toMatchObject({ hostname, error: 'boom' });
    });

    it('CONFIGURE failure with failureCode AWS_PERMISSION_DENIED sets that lastError code', async () => {
      const { deployment } = await seedDeployment();
      const domain = await createCustomDomain(db, deployment, freshHostname(), 'user-1');
      const job = await configureJobFor(deployment.id);

      await applyDomainJobResult(db, deployment, job, {
        success: false,
        error: 'no perms',
        failureCode: 'AWS_PERMISSION_DENIED',
      });

      expect((await reload(domain.id)).lastError).toBe('AWS_PERMISSION_DENIED');
    });

    it('CONFIGURE failure on an ACTIVE domain is ignored (a stale failure must never knock it offline)', async () => {
      const { deployment } = await seedDeployment();
      const domain = await createCustomDomain(db, deployment, freshHostname(), 'user-1');
      const job = await configureJobFor(deployment.id);
      await db
        .update(schema.customDomains)
        .set({ status: 'ACTIVE' })
        .where(eq(schema.customDomains.id, domain.id));

      await applyDomainJobResult(db, deployment, job, { success: false, error: 'stale failure' });

      const reloaded = await reload(domain.id);
      expect(reloaded.status).toBe('ACTIVE');
      expect(reloaded.lastError).toBeNull();

      const events = await db
        .select()
        .from(schema.eventLogs)
        .where(and(eq(schema.eventLogs.deploymentId, deployment.id), eq(schema.eventLogs.eventType, 'domain.failed')));
      expect(events).toHaveLength(0);
    });

    it('CONFIGURE result while REMOVING is ignored (stale result changes nothing)', async () => {
      const { deployment } = await seedDeployment();
      const domain = await createCustomDomain(db, deployment, freshHostname(), 'user-1');
      const configureJob = await configureJobFor(deployment.id);
      await removeCustomDomain(db, deployment, domain);

      await applyDomainJobResult(db, deployment, configureJob, {
        success: true,
        output: { validationName: 'x', validationValue: 'y' },
      });

      const reloaded = await reload(domain.id);
      expect(reloaded.status).toBe('REMOVING');
      expect(reloaded.validationName).toBeNull();
    });

    it('REMOVE success sets removedAt', async () => {
      const { deployment } = await seedDeployment();
      const domain = await createCustomDomain(db, deployment, freshHostname(), 'user-1');
      await removeCustomDomain(db, deployment, domain);
      const removeJob = (await jobsFor(deployment.id)).find((job) => job.type === 'REMOVE_DOMAIN')!;

      await applyDomainJobResult(db, deployment, removeJob, { success: true });

      const reloaded = await reload(domain.id);
      expect(reloaded.removedAt).not.toBeNull();

      const events = await db
        .select()
        .from(schema.eventLogs)
        .where(and(eq(schema.eventLogs.deploymentId, deployment.id), eq(schema.eventLogs.eventType, 'domain.removed')));
      expect(events).toHaveLength(1);
      expect(events[0]!.actorType).toBe('relay');
    });

    it('REMOVE failure keeps REMOVING with lastError REMOVE_FAILED', async () => {
      const { deployment } = await seedDeployment();
      const domain = await createCustomDomain(db, deployment, freshHostname(), 'user-1');
      await removeCustomDomain(db, deployment, domain);
      const removeJob = (await jobsFor(deployment.id)).find((job) => job.type === 'REMOVE_DOMAIN')!;

      await applyDomainJobResult(db, deployment, removeJob, { success: false, error: 'still routing' });

      const reloaded = await reload(domain.id);
      expect(reloaded.status).toBe('REMOVING');
      expect(reloaded.lastError).toBe('REMOVE_FAILED');
    });

    it('returns without error when the deployment has no active domain', async () => {
      const { deployment } = await seedDeployment();
      const fakeJob = {
        id: crypto.randomUUID(),
        deploymentId: deployment.id,
        type: 'CONFIGURE_DOMAIN',
      } as typeof schema.deploymentJobs.$inferSelect;
      await expect(applyDomainJobResult(db, deployment, fakeJob, { success: true })).resolves.toBeUndefined();
    });
  });

  describe('ensureConfigureJob', () => {
    it('calling twice in a row creates exactly one unfinished job; forceNewCycle after it succeeds mints a cycle-1 job', async () => {
      const { deployment } = await seedDeployment();
      const domain = await createCustomDomain(db, deployment, freshHostname(), 'user-1');

      // createCustomDomain already created the cycle-0 job; calling again
      // must not create a second one while it is still unfinished.
      await ensureConfigureJob(db, deployment, domain);
      const jobsAfterSecondCall = (await jobsFor(deployment.id)).filter((job) => job.type === 'CONFIGURE_DOMAIN');
      expect(jobsAfterSecondCall).toHaveLength(1);

      await db
        .update(schema.deploymentJobs)
        .set({ state: 'SUCCEEDED', finishedAt: new Date() })
        .where(eq(schema.deploymentJobs.id, jobsAfterSecondCall[0]!.id));

      await ensureConfigureJob(db, deployment, domain, { forceNewCycle: true });
      const jobsAfterForce = (await jobsFor(deployment.id)).filter((job) => job.type === 'CONFIGURE_DOMAIN');
      expect(jobsAfterForce).toHaveLength(2);
      const cycle1 = jobsAfterForce.find((job) => job.idempotencyKey.endsWith(':1'));
      expect(cycle1).toBeDefined();
      expect(cycle1!.idempotencyKey).toBe(`${deployment.id}:CONFIGURE_DOMAIN:${domain.id}:1`);
    });
  });

  describe('isDomainJobType', () => {
    it('is true for CONFIGURE_DOMAIN and REMOVE_DOMAIN, false otherwise', () => {
      expect(isDomainJobType('CONFIGURE_DOMAIN')).toBe(true);
      expect(isDomainJobType('REMOVE_DOMAIN')).toBe(true);
      expect(isDomainJobType('DEPLOY_RELEASE')).toBe(false);
    });
  });

  describe('classifyDomainUniqueViolation', () => {
    it('classifies the deployment-idx constraint as DOMAIN_EXISTS', () => {
      expect(
        classifyDomainUniqueViolation({ code: '23505', constraint: 'custom_domains_active_deployment_idx' }),
      ).toBe('DOMAIN_EXISTS');
    });

    it('classifies the hostname-idx constraint as DOMAIN_TAKEN', () => {
      expect(
        classifyDomainUniqueViolation({ code: '23505', constraint: 'custom_domains_active_hostname_idx' }),
      ).toBe('DOMAIN_TAKEN');
    });

    it('classifies a 23505 with an unknown or missing constraint as DOMAIN_TAKEN (ambiguous prefers DOMAIN_TAKEN)', () => {
      expect(classifyDomainUniqueViolation({ code: '23505', constraint: 'some_other_idx' })).toBe('DOMAIN_TAKEN');
      expect(classifyDomainUniqueViolation({ code: '23505' })).toBe('DOMAIN_TAKEN');
    });

    it('returns null for a non-23505 error (caller rethrows)', () => {
      expect(classifyDomainUniqueViolation({ code: '23503' })).toBeNull();
      expect(classifyDomainUniqueViolation(new Error('boom'))).toBeNull();
      expect(classifyDomainUniqueViolation(undefined)).toBeNull();
    });
  });

  describe('toDomainView', () => {
    const base: CustomDomainRow = {
      id: 'domain-1',
      deploymentId: 'deployment-1',
      organizationId: 'org-1',
      hostname: 'app.customer.com',
      status: 'PENDING',
      certificateArn: null,
      validationName: null,
      validationValue: null,
      routingTarget: null,
      lastError: null,
      lastCheckedAt: null,
      checkCycle: 0,
      removedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      createdBy: 'user-1',
      updatedBy: null,
    };

    it('lowercases status, has no records, and no url when not ACTIVE', () => {
      const view = toDomainView(base);
      expect(view.status).toBe('pending');
      expect(view.records).toEqual([]);
      expect(view.url).toBeNull();
      expect(view.error).toBeNull();
    });

    it('includes a verification record once validationName+validationValue are known', () => {
      const view = toDomainView({
        ...base,
        status: 'WAITING_FOR_DNS',
        validationName: '_abc.app.customer.com',
        validationValue: '_xyz.acm-validations.aws.',
      });
      expect(view.status).toBe('waiting_for_dns');
      expect(view.records).toEqual([
        {
          purpose: 'verification',
          type: 'CNAME',
          name: '_abc.app.customer.com',
          value: '_xyz.acm-validations.aws.',
        },
      ]);
      expect(view.url).toBeNull();
    });

    it('includes verification then routing records, and a url only when ACTIVE', () => {
      const view = toDomainView({
        ...base,
        status: 'ACTIVE',
        validationName: '_abc.app.customer.com',
        validationValue: '_xyz.acm-validations.aws.',
        routingTarget: 'alb-123.us-east-1.elb.amazonaws.com',
      });
      expect(view.status).toBe('active');
      expect(view.records).toEqual([
        {
          purpose: 'verification',
          type: 'CNAME',
          name: '_abc.app.customer.com',
          value: '_xyz.acm-validations.aws.',
        },
        {
          purpose: 'routing',
          type: 'CNAME',
          name: 'app.customer.com',
          value: 'alb-123.us-east-1.elb.amazonaws.com',
        },
      ]);
      expect(view.url).toBe('https://app.customer.com');
    });

    it('surfaces lastError as error', () => {
      const view = toDomainView({ ...base, status: 'ERROR', lastError: 'CONFIGURE_FAILED' });
      expect(view.error).toBe('CONFIGURE_FAILED');
    });
  });
});
