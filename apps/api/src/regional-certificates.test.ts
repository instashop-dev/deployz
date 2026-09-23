import { PGlite } from '@electric-sql/pglite';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { applyMigrations, createDb, type Db } from '@deployz/db';
import * as schema from '@deployz/db/schema';
import { regionalCertificateDomain } from '@deployz/contracts';

import {
  CloudflareDnsError,
  createFakeCloudflareDnsClient,
  type CloudflareDnsClient,
  type FakeCloudflareDnsClient,
} from './cloudflare-records.js';
import {
  applyEnsureCertificateResult,
  completeRegionalCertificateRemoval,
  ensureRegionalCertificate,
  hasRegionalCertificateTimedOut,
  isRegionalCertificateSlow,
  reconcileValidationRecord,
  regionalCertificatesForPurge,
  remainingScopeDeployments,
  resolveCustomerScope,
  retryRegionalCertificate,
  type RegionalCertificateDeps,
  type RegionalCertificateRow,
} from './regional-certificates.js';

// Regional HTTPS certificates (docs/https-regional-certificates.md) — the
// idempotent reconciler over a fresh in-memory PGlite (real Postgres
// semantics, full migrations). All DNS interaction goes through the
// deployment-keyed fake Cloudflare client — no real network.

describe('regional-certificates service', () => {
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

  const apex = 'deployz.test';
  const AWS_ACCOUNT_ID = '111122223333';

  async function insertOrg() {
    const id = `org-${crypto.randomUUID()}`;
    const [row] = await db
      .insert(schema.organization)
      .values({ id, name: 'Test Org', slug: `test-org-${crypto.randomUUID().slice(0, 8)}` })
      .returning();
    return row!;
  }

  async function insertApplication(organizationId: string) {
    const [row] = await db
      .insert(schema.applications)
      .values({
        organizationId,
        name: 'Test App',
        repoFullName: `acme/regional-app-${crypto.randomUUID().slice(0, 8)}`,
        repoUrl: 'https://github.com/acme/regional-app',
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
    organizationId: string,
    applicationId: string,
    customerId: string,
    overrides: Partial<typeof schema.deployments.$inferInsert> = {},
  ) {
    const [row] = await db
      .insert(schema.deployments)
      .values({
        organizationId,
        applicationId,
        customerId,
        region: 'us-east-1',
        state: 'HEALTHY',
        awsAccountId: AWS_ACCOUNT_ID,
        installationId: `inst-${crypto.randomUUID()}`,
        enrollmentCode: crypto.randomUUID(),
        ...overrides,
      })
      .returning();
    return row!;
  }

  /** A full scope: org + application + customer + one deployment, ready to
   *  drive ensureRegionalCertificate against. */
  async function seedScope(overrides: Partial<typeof schema.deployments.$inferInsert> = {}) {
    const org = await insertOrg();
    const application = await insertApplication(org.id);
    const customer = await insertCustomer(org.id);
    const deployment = await seedDeployment(org.id, application.id, customer.id, overrides);
    return { org, application, customer, deployment };
  }

  function deps(overrides: Partial<RegionalCertificateDeps> = {}): RegionalCertificateDeps {
    return {
      dns: createFakeCloudflareDnsClient({ zoneId: 'zone-test', zoneName: apex }),
      apex,
      ...overrides,
    };
  }

  /** Like deps(), but also hands back the concrete fake so a test can read
   *  its full in-memory record set (listDefaultRecords only returns `d-*`
   *  names — validation records start with `_` and are invisible to it). */
  function depsWithFake(): { deps: RegionalCertificateDeps; fake: FakeCloudflareDnsClient } {
    const fake = createFakeCloudflareDnsClient({ zoneId: 'zone-test', zoneName: apex });
    return { deps: { dns: fake, apex }, fake };
  }

  function ensureInput(
    deployment: typeof schema.deployments.$inferSelect,
    dnsScope: string,
  ) {
    return {
      deployment: {
        id: deployment.id,
        customerId: deployment.customerId,
        organizationId: deployment.organizationId,
        awsAccountId: deployment.awsAccountId!,
        region: deployment.region,
      },
      dnsScope,
    };
  }

  async function certRow(id: string): Promise<RegionalCertificateRow> {
    const rows = await db
      .select()
      .from(schema.customerRegionalCertificates)
      .where(eq(schema.customerRegionalCertificates.id, id))
      .limit(1);
    return rows[0]!;
  }

  async function jobsFor(deploymentId: string, type: 'ENSURE_CERTIFICATE' | 'ATTACH_CERTIFICATE' = 'ENSURE_CERTIFICATE') {
    return db
      .select()
      .from(schema.deploymentJobs)
      .where(eq(schema.deploymentJobs.deploymentId, deploymentId))
      .then((rows) => rows.filter((row) => row.type === type));
  }

  describe('resolveCustomerScope', () => {
    it('returns the customer dns_scope', async () => {
      const { customer } = await seedScope();
      const scope = await resolveCustomerScope(db, customer.id);
      expect(scope).toBe(customer.dnsScope);
      expect(scope).toMatch(/^[a-z0-9]{4,32}$/);
    });
  });

  describe('ensureRegionalCertificate — creation', () => {
    it('creates the row and mints one ENSURE_CERTIFICATE job with the documented payload', async () => {
      const { customer, deployment } = await seedScope();
      const dnsScope = customer.dnsScope;

      const { row, jobCreated } = await ensureRegionalCertificate(db, ensureInput(deployment, dnsScope), deps());

      expect(jobCreated).toBe(true);
      expect(row.certificateStatus).toBe('REQUESTING');
      expect(row.certificateDomain).toBe(regionalCertificateDomain(dnsScope, apex));
      expect(row.attempts).toBe(1);
      expect(row.requestedAt).not.toBeNull();

      const jobs = await jobsFor(deployment.id);
      expect(jobs).toHaveLength(1);
      expect(jobs[0]!.idempotencyKey).toBe(`${deployment.id}:ENSURE_CERTIFICATE:${row.id}:0`);
      expect(jobs[0]!.payload).toMatchObject({
        certificateDomain: row.certificateDomain,
        customerScope: dnsScope,
        idempotencyToken: row.id.replace(/-/g, '').slice(0, 32),
      });
      expect((jobs[0]!.payload as Record<string, unknown>)['certificateArn']).toBeUndefined();
    });

    it('two concurrent calls from the SAME deployment converge on ONE row and ONE job (the idempotency key is the backstop)', async () => {
      const { customer, deployment } = await seedScope();
      const dnsScope = customer.dnsScope;

      const [a, b] = await Promise.all([
        ensureRegionalCertificate(db, ensureInput(deployment, dnsScope), deps()),
        ensureRegionalCertificate(db, ensureInput(deployment, dnsScope), deps()),
      ]);

      expect(a.row.id).toBe(b.row.id);
      const rows = await db
        .select()
        .from(schema.customerRegionalCertificates)
        .where(eq(schema.customerRegionalCertificates.customerId, customer.id));
      expect(rows).toHaveLength(1);

      const jobs = await jobsFor(deployment.id);
      expect(jobs).toHaveLength(1);
      // Exactly one of the two calls actually minted the job; the other's
      // createOrReuseJob hit the unique-idempotency-key conflict and replayed it.
      expect([a.jobCreated, b.jobCreated].filter(Boolean)).toHaveLength(1);
    });

    it('a second deployment joining an already-in-flight scope reuses the row and mints no second job', async () => {
      const { customer, deployment } = await seedScope();
      const second = await seedDeployment(deployment.organizationId, deployment.applicationId, customer.id);
      const dnsScope = customer.dnsScope;

      const first = await ensureRegionalCertificate(db, ensureInput(deployment, dnsScope), deps());
      expect(first.jobCreated).toBe(true);

      const joined = await ensureRegionalCertificate(db, ensureInput(second, dnsScope), deps());
      expect(joined.row.id).toBe(first.row.id);
      expect(joined.jobCreated).toBe(false);

      const rows = await db
        .select()
        .from(schema.customerRegionalCertificates)
        .where(eq(schema.customerRegionalCertificates.customerId, customer.id));
      expect(rows).toHaveLength(1);
      const allJobs = await db
        .select()
        .from(schema.deploymentJobs)
        .where(eq(schema.deploymentJobs.type, 'ENSURE_CERTIFICATE'));
      const scoped = allJobs.filter((job) => job.idempotencyKey.includes(`:ENSURE_CERTIFICATE:${first.row.id}:`));
      expect(scoped).toHaveLength(1);
    });
  });

  describe('ensureRegionalCertificate — reuse and resume', () => {
    it('an ISSUED, recently-verified row is reused with no new job', async () => {
      const { customer, deployment } = await seedScope();
      const { row } = await ensureRegionalCertificate(db, ensureInput(deployment, customer.dnsScope), deps());
      await db
        .update(schema.customerRegionalCertificates)
        .set({ certificateStatus: 'ISSUED', certificateArn: 'arn:aws:acm:us-east-1:1:certificate/x', lastVerifiedAt: new Date() })
        .where(eq(schema.customerRegionalCertificates.id, row.id));

      const { row: reused, jobCreated } = await ensureRegionalCertificate(
        db,
        ensureInput(deployment, customer.dnsScope),
        deps(),
      );
      expect(reused.id).toBe(row.id);
      expect(jobCreated).toBe(false);
      const jobs = await jobsFor(deployment.id);
      expect(jobs).toHaveLength(1); // only the original creation job
    });

    it('an in-flight ENSURE_CERTIFICATE job blocks a duplicate on the next call', async () => {
      const { customer, deployment } = await seedScope();
      await ensureRegionalCertificate(db, ensureInput(deployment, customer.dnsScope), deps());

      const { jobCreated } = await ensureRegionalCertificate(db, ensureInput(deployment, customer.dnsScope), deps());
      expect(jobCreated).toBe(false);
      const jobs = await jobsFor(deployment.id);
      expect(jobs).toHaveLength(1);
    });

    it('mints a fresh cycle once the in-flight job settles', async () => {
      const { customer, deployment } = await seedScope();
      const { row: initial } = await ensureRegionalCertificate(db, ensureInput(deployment, customer.dnsScope), deps());
      const jobs = await jobsFor(deployment.id);
      await db
        .update(schema.deploymentJobs)
        .set({ state: 'FAILED', finishedAt: new Date() })
        .where(eq(schema.deploymentJobs.id, jobs[0]!.id));

      const { row, jobCreated } = await ensureRegionalCertificate(db, ensureInput(deployment, customer.dnsScope), deps());
      expect(jobCreated).toBe(true);
      expect(row.checkCycle).toBe(initial.checkCycle + 1);
      const allJobs = await jobsFor(deployment.id);
      expect(allJobs).toHaveLength(2);
      expect(allJobs[1]!.idempotencyKey.endsWith(':1')).toBe(true);
    });

    it('a terminal ERROR row is left alone — no job, the retry route resets it', async () => {
      const { customer, deployment } = await seedScope();
      const { row } = await ensureRegionalCertificate(db, ensureInput(deployment, customer.dnsScope), deps());
      await db
        .update(schema.customerRegionalCertificates)
        .set({ certificateStatus: 'ERROR', lastError: 'CERTIFICATE_FAILED: CAA_ERROR' })
        .where(eq(schema.customerRegionalCertificates.id, row.id));

      const { jobCreated } = await ensureRegionalCertificate(db, ensureInput(deployment, customer.dnsScope), deps());
      expect(jobCreated).toBe(false);
      const jobs = await jobsFor(deployment.id);
      expect(jobs).toHaveLength(1); // the original job only
    });
  });

  describe('applyEnsureCertificateResult', () => {
    async function ensured() {
      const { customer, deployment } = await seedScope();
      const { row } = await ensureRegionalCertificate(db, ensureInput(deployment, customer.dnsScope), deps());
      const jobs = await jobsFor(deployment.id);
      return { customer, deployment, row, job: jobs[0]! };
    }

    it('PENDING_VALIDATION → DNS_VALIDATION_PENDING, persisting the validation record fields', async () => {
      const { customer, row, job } = await ensured();
      const result = await applyEnsureCertificateResult(db, row.id, job, {
        success: true,
        output: {
          certificateArn: 'arn:aws:acm:us-east-1:1:certificate/abc',
          certificateStatus: 'PENDING_VALIDATION',
          validationRecordName: `_x1.c-${customer.dnsScope}.${apex}.`,
          validationRecordValue: '_y1.acm-validations.aws.',
          validationRecordType: 'CNAME',
        },
      });
      expect(result?.row.certificateStatus).toBe('DNS_VALIDATION_PENDING');
      expect(result?.row.certificateArn).toBe('arn:aws:acm:us-east-1:1:certificate/abc');
      // The trailing dot ACM reports is stripped before it is persisted.
      expect(result?.row.validationRecordName).toBe(`_x1.c-${customer.dnsScope}.${apex}`);
      expect(result?.row.lastError).toBeNull();
    });

    it('refuses a validation record name outside the row namespace (relay output is untrusted)', async () => {
      const { row, job } = await ensured();
      const result = await applyEnsureCertificateResult(db, row.id, job, {
        success: true,
        output: {
          certificateArn: 'arn:aws:acm:us-east-1:1:certificate/abc',
          certificateStatus: 'PENDING_VALIDATION',
          validationRecordName: `_x1.c-victim00.${apex}.`,
          validationRecordValue: '_evil.acm-validations.aws.',
          validationRecordType: 'CNAME',
        },
      });
      expect(result?.row.lastError).toBe('VALIDATION_RECORD_INVALID');
      expect(result?.row.validationRecordName).toBeNull();
      expect(result?.row.validationRecordValue).toBeNull();
      expect(result?.row.certificateArn).toBeNull();
      expect(result?.row.certificateStatus).toBe('REQUESTING');
    });

    it('ISSUED sets issuedAt once and lastVerifiedAt on every success', async () => {
      const { row, job } = await ensured();
      const output = {
        certificateArn: 'arn:aws:acm:us-east-1:1:certificate/abc',
        certificateStatus: 'ISSUED' as const,
      };
      const first = await applyEnsureCertificateResult(db, row.id, job, { success: true, output });
      expect(first?.row.certificateStatus).toBe('ISSUED');
      expect(first?.row.issuedAt).not.toBeNull();
      const issuedAt = first!.row.issuedAt;

      const second = await applyEnsureCertificateResult(db, row.id, job, { success: true, output });
      expect(second?.row.issuedAt?.getTime()).toBe(issuedAt!.getTime());
    });

    it('a different ARN in the result overwrites the stored one and flags the drift as a transition', async () => {
      const { row, job } = await ensured();
      await applyEnsureCertificateResult(db, row.id, job, {
        success: true,
        output: { certificateArn: 'arn:aws:acm:us-east-1:1:certificate/first', certificateStatus: 'ISSUED' },
      });
      const result = await applyEnsureCertificateResult(db, row.id, job, {
        success: true,
        output: { certificateArn: 'arn:aws:acm:us-east-1:1:certificate/second', certificateStatus: 'ISSUED' },
      });
      expect(result?.row.certificateArn).toBe('arn:aws:acm:us-east-1:1:certificate/second');
      expect(result?.transition?.arnReplaced).toBe(true);
      expect(result?.transition?.previousArn).toBe('arn:aws:acm:us-east-1:1:certificate/first');
    });

    it('a terminal FAILED status → ERROR with the ACM reason appended', async () => {
      const { row, job } = await ensured();
      const result = await applyEnsureCertificateResult(db, row.id, job, {
        success: true,
        output: {
          certificateArn: 'arn:aws:acm:us-east-1:1:certificate/abc',
          certificateStatus: 'FAILED',
          failureReason: 'CAA_ERROR',
        },
      });
      expect(result?.row.certificateStatus).toBe('ERROR');
      expect(result?.row.lastError).toBe('CERTIFICATE_FAILED: CAA_ERROR');
      expect(result?.transition?.statusChanged).toBe(true);
    });

    it('a relay failure with AWS_PERMISSION_DENIED sets ERROR immediately', async () => {
      const { row, job } = await ensured();
      const result = await applyEnsureCertificateResult(db, row.id, job, {
        success: false,
        failureCode: 'AWS_PERMISSION_DENIED',
      });
      expect(result?.row.certificateStatus).toBe('ERROR');
      expect(result?.row.lastError).toBe('AWS_PERMISSION_DENIED');
    });

    it('an ordinary relay failure leaves status alone, just records lastError', async () => {
      const { row, job } = await ensured();
      const result = await applyEnsureCertificateResult(db, row.id, job, { success: false });
      expect(result?.row.certificateStatus).toBe('REQUESTING');
      expect(result?.row.lastError).toBe('ENSURE_FAILED');
    });
  });

  describe('reconcileValidationRecord', () => {
    async function pendingValidation() {
      const { customer, deployment } = await seedScope();
      const { row } = await ensureRegionalCertificate(db, ensureInput(deployment, customer.dnsScope), deps());
      const jobs = await jobsFor(deployment.id);
      const validationName = `_x1.c-${customer.dnsScope}.${apex}`;
      const applied = await applyEnsureCertificateResult(db, row.id, jobs[0]!, {
        success: true,
        output: {
          certificateArn: 'arn:aws:acm:us-east-1:1:certificate/abc',
          certificateStatus: 'PENDING_VALIDATION',
          validationRecordName: validationName,
          validationRecordValue: '_y1.acm-validations.aws.',
        },
      });
      return { customer, deployment, row: applied!.row, validationName };
    }

    it('writes the validation CNAME and records validationDnsReadyAt once', async () => {
      const { row } = await pendingValidation();
      const d = deps();
      const updated = await reconcileValidationRecord(db, row, d);
      expect(updated.validationDnsReadyAt).not.toBeNull();
      expect(updated.cloudflareRecordId).not.toBeNull();

      // A second pass is a noop write but must not clear validationDnsReadyAt.
      const again = await reconcileValidationRecord(db, updated, d);
      expect(again.validationDnsReadyAt?.getTime()).toBe(updated.validationDnsReadyAt!.getTime());
    });

    it('an existing record with the SAME value is a no-op (idempotent)', async () => {
      const { row } = await pendingValidation();
      const d = deps();
      await reconcileValidationRecord(db, row, d);
      const second = await reconcileValidationRecord(db, row, d);
      expect(second.lastError).toBeNull();
    });

    it('an existing record with a DIFFERENT value → ERROR DNS_VALIDATION_CONFLICT, never overwritten', async () => {
      const { customer, row, validationName } = await pendingValidation();
      const { deps: d, fake } = depsWithFake();
      // Plant a conflicting record directly (simulating a stray record that
      // predates this reconcile pass) before the row's own write is tried.
      await fake.upsertScopeValidationRecord(customer.dnsScope, validationName, 'conflicting-value.');

      const updated = await reconcileValidationRecord(db, row, d);
      expect(updated.certificateStatus).toBe('ERROR');
      expect(updated.lastError).toBe('DNS_VALIDATION_CONFLICT');
      // Never overwritten — the planted value is still there.
      expect(fake.listRecords().find((r) => r.name === validationName)?.content).toBe('conflicting-value');
    });

    it('a rate-limited write only sets lastError; the next cycle can still succeed', async () => {
      const { row } = await pendingValidation();
      let calls = 0;
      const flaky: CloudflareDnsClient = {
        ...createFakeCloudflareDnsClient({ zoneId: 'z', zoneName: apex }),
        upsertScopeValidationRecord: async () => {
          calls += 1;
          if (calls === 1) {
            throw new CloudflareDnsError('rate limited', 'CLOUDFLARE_RATE_LIMITED', { status: 429 });
          }
          return { op: 'created', record: null };
        },
      };
      const d = deps({ dns: flaky });
      const first = await reconcileValidationRecord(db, row, d);
      expect(first.lastError).toBe('CLOUDFLARE_RATE_LIMITED');
      expect(first.certificateStatus).not.toBe('ERROR');

      const second = await reconcileValidationRecord(db, first, d);
      expect(second.lastError).toBeNull();
    });

    it('a transient unavailable failure sets DNS_WRITE_FAILED and never consumes attempts', async () => {
      const { row } = await pendingValidation();
      const failing: CloudflareDnsClient = {
        ...createFakeCloudflareDnsClient({ zoneId: 'z', zoneName: apex }),
        upsertScopeValidationRecord: async () => {
          throw new CloudflareDnsError('boom', 'CLOUDFLARE_UNAVAILABLE');
        },
      };
      const updated = await reconcileValidationRecord(db, row, deps({ dns: failing }));
      expect(updated.lastError).toBe('DNS_WRITE_FAILED');
      expect(updated.attempts).toBe(row.attempts);
    });
  });

  describe('slow / timeout helpers', () => {
    function rowWithRequestedAt(minutesAgo: number, status: RegionalCertificateRow['certificateStatus'] = 'REQUESTING') {
      const requestedAt = new Date(Date.now() - minutesAgo * 60_000);
      return { certificateStatus: status, requestedAt };
    }

    it('isRegionalCertificateSlow is false under 30 minutes, true over', () => {
      expect(isRegionalCertificateSlow(rowWithRequestedAt(10))).toBe(false);
      expect(isRegionalCertificateSlow(rowWithRequestedAt(31))).toBe(true);
    });

    it('isRegionalCertificateSlow is always false once ISSUED', () => {
      expect(isRegionalCertificateSlow(rowWithRequestedAt(120, 'ISSUED'))).toBe(false);
    });

    it('hasRegionalCertificateTimedOut is false under 4 hours, true over', () => {
      expect(hasRegionalCertificateTimedOut(rowWithRequestedAt(200))).toBe(false);
      expect(hasRegionalCertificateTimedOut(rowWithRequestedAt(241))).toBe(true);
    });
  });

  describe('retryRegionalCertificate', () => {
    it('keeps the certificate when the ERROR was DNS-side (the same certificate can still validate)', async () => {
      const { customer, deployment } = await seedScope();
      const { row } = await ensureRegionalCertificate(db, ensureInput(deployment, customer.dnsScope), deps());
      await db
        .update(schema.customerRegionalCertificates)
        .set({
          certificateStatus: 'ERROR',
          lastError: 'DNS_VALIDATION_CONFLICT',
          certificateArn: 'arn:aws:acm:us-east-1:123456789012:certificate/alive',
          validationRecordName: `_ok.c-${customer.dnsScope}.${apex}`,
          validationRecordValue: '_ok.acm-validations.aws',
          lastVerifiedAt: new Date(),
        })
        .where(eq(schema.customerRegionalCertificates.id, row.id));

      const retried = await retryRegionalCertificate(db, row.id);
      expect(retried.certificateStatus).toBe('REQUESTING');
      expect(retried.lastError).toBeNull();
      expect(retried.certificateArn).toBe('arn:aws:acm:us-east-1:123456789012:certificate/alive');
      expect(retried.validationRecordName).toBe(`_ok.c-${customer.dnsScope}.${apex}`);
      expect(retried.lastVerifiedAt).toBeNull();
    });

    it('resets ERROR → REQUESTING, clears lastError, bumps the cycle', async () => {
      const { customer, deployment } = await seedScope();
      const { row } = await ensureRegionalCertificate(db, ensureInput(deployment, customer.dnsScope), deps());
      await db
        .update(schema.customerRegionalCertificates)
        .set({
          certificateStatus: 'ERROR',
          lastError: 'CERTIFICATE_FAILED: CAA_ERROR',
          attempts: 3,
          certificateArn: 'arn:aws:acm:us-east-1:123456789012:certificate/failed',
          validationRecordName: '_dead.c-scope.deployz.dev',
          validationRecordValue: '_dead.acm-validations.aws',
          requestedAt: new Date(),
        })
        .where(eq(schema.customerRegionalCertificates.id, row.id));

      const retried = await retryRegionalCertificate(db, row.id);
      expect(retried.certificateStatus).toBe('REQUESTING');
      expect(retried.lastError).toBeNull();
      expect(retried.attempts).toBe(0);
      expect(retried.checkCycle).toBe(row.checkCycle + 1);
      // A terminally failed certificate is forgotten so the next ENSURE
      // requests a replacement instead of re-describing the dead ARN.
      expect(retried.certificateArn).toBeNull();
      expect(retried.validationRecordName).toBeNull();
      expect(retried.validationRecordValue).toBeNull();
      expect(retried.requestedAt).toBeNull();
    });
  });

  describe('purge selection and removal', () => {
    it('remainingScopeDeployments excludes the purged deployment and DELETED rows', async () => {
      const { customer, deployment, org, application } = await seedScope();
      const second = await seedDeployment(org.id, application.id, customer.id);
      const deleted = await seedDeployment(org.id, application.id, customer.id, { state: 'DELETED' });
      void deleted;

      const remaining = await remainingScopeDeployments(db, {
        customerId: customer.id,
        awsAccountId: AWS_ACCOUNT_ID,
        region: 'us-east-1',
        excludeDeploymentId: deployment.id,
      });
      expect(remaining).toBe(1); // only `second` — deployment excluded, deleted excluded
      void second;
    });

    it('regionalCertificatesForPurge is empty unless the deployment is the LAST live one in scope', async () => {
      const { customer, deployment, org, application } = await seedScope();
      const second = await seedDeployment(org.id, application.id, customer.id);
      await ensureRegionalCertificate(db, ensureInput(deployment, customer.dnsScope), deps());

      const whileSiblingLive = await regionalCertificatesForPurge(db, {
        id: deployment.id,
        customerId: customer.id,
        awsAccountId: AWS_ACCOUNT_ID,
        region: 'us-east-1',
      });
      expect(whileSiblingLive).toHaveLength(0);

      await db.update(schema.deployments).set({ state: 'DELETED' }).where(eq(schema.deployments.id, second.id));
      const whenLast = await regionalCertificatesForPurge(db, {
        id: deployment.id,
        customerId: customer.id,
        awsAccountId: AWS_ACCOUNT_ID,
        region: 'us-east-1',
      });
      expect(whenLast).toHaveLength(1);
    });

    it('completeRegionalCertificateRemoval deletes the row(s) and, when no sibling row shares the validation name, the DNS record', async () => {
      const { customer, deployment } = await seedScope();
      const { row } = await ensureRegionalCertificate(db, ensureInput(deployment, customer.dnsScope), deps());
      const jobs = await jobsFor(deployment.id);
      const validationName = `_solo.c-${customer.dnsScope}.${apex}`;
      const applied = await applyEnsureCertificateResult(db, row.id, jobs[0]!, {
        success: true,
        output: {
          certificateArn: 'arn:aws:acm:us-east-1:1:certificate/abc',
          certificateStatus: 'PENDING_VALIDATION',
          validationRecordName: validationName,
          validationRecordValue: '_y.acm-validations.aws.',
        },
      });
      const { deps: d, fake } = depsWithFake();
      const reconciled = await reconcileValidationRecord(db, applied!.row, d);

      await completeRegionalCertificateRemoval(db, d, [reconciled]);

      const remainingRows = await db
        .select()
        .from(schema.customerRegionalCertificates)
        .where(eq(schema.customerRegionalCertificates.id, row.id));
      expect(remainingRows).toHaveLength(0);
      expect(fake.listRecords().find((r) => r.name === validationName)).toBeUndefined();
    });

    it('keeps the validation DNS record when another region row still shares the same name', async () => {
      const { customer, deployment } = await seedScope({ region: 'us-east-1' });
      const secondRegionDeployment = await seedDeployment(
        deployment.organizationId,
        deployment.applicationId,
        customer.id,
        { region: 'us-west-2' },
      );
      const validationName = `_shared.c-${customer.dnsScope}.${apex}`;

      const { row: rowA } = await ensureRegionalCertificate(db, ensureInput(deployment, customer.dnsScope), deps());
      const jobsA = await jobsFor(deployment.id);
      await applyEnsureCertificateResult(db, rowA.id, jobsA[0]!, {
        success: true,
        output: {
          certificateArn: 'arn:aws:acm:us-east-1:1:certificate/a',
          certificateStatus: 'PENDING_VALIDATION',
          validationRecordName: validationName,
          validationRecordValue: '_y.acm-validations.aws.',
        },
      });

      const { row: rowB } = await ensureRegionalCertificate(
        db,
        ensureInput(secondRegionDeployment, customer.dnsScope),
        deps(),
      );
      const jobsB = await jobsFor(secondRegionDeployment.id);
      await applyEnsureCertificateResult(db, rowB.id, jobsB[0]!, {
        success: true,
        output: {
          certificateArn: 'arn:aws:acm:us-west-2:1:certificate/b',
          certificateStatus: 'PENDING_VALIDATION',
          // ACM shares one validation record across every region in the
          // account — same name as row A's.
          validationRecordName: validationName,
          validationRecordValue: '_y.acm-validations.aws.',
        },
      });

      const { deps: d, fake } = depsWithFake();
      const freshA = await certRow(rowA.id);
      await reconcileValidationRecord(db, freshA, d);

      // Purge region A's row only — B (the sibling with the same validation
      // name) is untouched, so the DNS record must survive.
      await completeRegionalCertificateRemoval(db, d, [await certRow(rowA.id)]);

      expect(fake.listRecords().find((r) => r.name === validationName)).toBeDefined();
      const remainingA = await db
        .select()
        .from(schema.customerRegionalCertificates)
        .where(eq(schema.customerRegionalCertificates.id, rowA.id));
      expect(remainingA).toHaveLength(0);
    });
  });
});
