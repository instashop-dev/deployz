import { describe, expect, it } from 'vitest';
import { ZodError } from 'zod';

import {
  analysisStatusEnum,
  compatibilityStatusEnum,
  deploymentStateEnum,
  failureCodeEnum,
  jobStateEnum,
  jobTypeEnum,
  regionEnum,
  releaseStatusEnum,
  subscriptionStatusEnum,
} from '@deployz/db';

import {
  PACKAGE_NAME,
  analysisStatusSchema,
  applicationSchema,
  compatibilityStatusSchema,
  customerSchema,
  deploymentJobSchema,
  deploymentSchema,
  deploymentStateSchema,
  errorEnvelopeSchema,
  eventLogSchema,
  failureCodeSchema,
  jobStateSchema,
  jobTypeSchema,
  organizationSchema,
  regionSchema,
  releaseSchema,
  releaseStatusSchema,
  subscriptionSchema,
  subscriptionStatusSchema,
  usageRecordSchema,
  userSchema,
} from './index.js';

describe('@deployz/contracts scaffold', () => {
  it('exports the package name placeholder', () => {
    expect(PACKAGE_NAME).toBe('@deployz/contracts');
  });
});

// Parity law: every contracts enum is EXACTLY the live db pgEnum vocabulary —
// sorted comparison so ordering drift in either source is visible but never
// silently absorbed.
describe('enum parity with @deployz/db pgEnums', () => {
  const pairs = [
    ['analysisStatus', analysisStatusSchema, analysisStatusEnum.enumValues],
    ['compatibilityStatus', compatibilityStatusSchema, compatibilityStatusEnum.enumValues],
    ['releaseStatus', releaseStatusSchema, releaseStatusEnum.enumValues],
    ['region', regionSchema, regionEnum.enumValues],
    ['deploymentState', deploymentStateSchema, deploymentStateEnum.enumValues],
    ['jobType', jobTypeSchema, jobTypeEnum.enumValues],
    ['jobState', jobStateSchema, jobStateEnum.enumValues],
    ['failureCode', failureCodeSchema, failureCodeEnum.enumValues],
    ['subscriptionStatus', subscriptionStatusSchema, subscriptionStatusEnum.enumValues],
  ] as const;

  for (const [name, contractsEnum, dbValues] of pairs) {
    it(`${name}: contracts options === db enumValues (sorted)`, () => {
      expect([...contractsEnum.options].sort()).toEqual([...dbValues].sort());
    });
  }
});

describe('failureCodeSchema (§61 stable taxonomy)', () => {
  it('rejects a code outside the taxonomy', () => {
    expect(() => failureCodeSchema.parse('NOT_A_REAL_CODE')).toThrow(ZodError);
  });

  it('parses every real §61 code', () => {
    for (const code of failureCodeEnum.enumValues) {
      expect(failureCodeSchema.parse(code)).toBe(code);
    }
  });
});

// Round-trip law: a db row (Date objects) crosses the wire as JSON, so the
// contract must parse the JSON form back to EXACTLY the wire object — wire
// types are ISO strings, not Dates.
describe('core-object round-trip (db row -> JSON -> schema.parse -> wire)', () => {
  const created = new Date('2026-08-01T09:00:00.000Z');
  const updated = new Date('2026-08-02T10:30:00.000Z');

  const cases: Array<[string, object, { parse: (input: unknown) => unknown }]> = [
    [
      'Organization',
      {
        id: 'org_01JABC',
        name: 'ada',
        slug: 'ada-12345678',
        logo: null,
        metadata: null,
        stripeCustomerId: null,
        plan: 'FREE',
        createdAt: created,
        updatedAt: updated,
      },
      organizationSchema,
    ],
    [
      'User',
      {
        id: 'user_01JABC',
        name: 'Ada',
        email: 'ada@example.com',
        emailVerified: false,
        image: null,
        createdAt: created,
        updatedAt: updated,
      },
      userSchema,
    ],
    [
      'Application',
      {
        id: crypto.randomUUID(),
        organizationId: 'org_01JABC',
        name: 'shop',
        githubInstallationId: null,
        repoFullName: 'acme/shop',
        repoUrl: 'https://github.com/acme/shop',
        defaultBranch: 'main',
        containerPort: null,
        healthPath: null,
        migrationCommand: null,
        workerCommand: null,
        databaseRequired: false,
        storageRequired: false,
        analysisStatus: 'COMPLETE',
        compatibilityStatus: 'READY',
        compatibilityReason: null,
        detectedMetadata: { framework: 'nextjs', port: 3000 },
        createdAt: created,
        updatedAt: updated,
        createdBy: null,
        updatedBy: null,
      },
      applicationSchema,
    ],
    [
      'Release',
      {
        id: crypto.randomUUID(),
        applicationId: crypto.randomUUID(),
        version: '1.4.2',
        gitSha: '0123456789abcdef',
        imageDigest: 'sha256:deadbeef',
        migrationCommand: null,
        buildStatus: 'PENDING',
        releaseStatus: 'READY',
        createdAt: created,
        updatedAt: updated,
        createdBy: null,
        updatedBy: null,
      },
      releaseSchema,
    ],
    [
      'Customer',
      {
        id: crypto.randomUUID(),
        organizationId: 'org_01JABC',
        name: 'Customer Co',
        email: 'ops@customer.co',
        company: 'Customer Co Ltd',
        externalReference: null,
        createdAt: created,
        updatedAt: updated,
      },
      customerSchema,
    ],
    [
      'Deployment',
      {
        id: crypto.randomUUID(),
        customerId: crypto.randomUUID(),
        applicationId: crypto.randomUUID(),
        organizationId: 'org_01JABC',
        region: 'us-east-1',
        state: 'HEALTHY',
        awsAccountId: null,
        currentReleaseId: null,
        previousReleaseId: null,
        relayStatus: 'CONNECTED',
        healthStatus: 'HEALTHY',
        desiredState: { image: 'shop:1.4.2' },
        observedState: null,
        infraVersion: 'runtime-v1',
        installationId: 'inst_01JABC',
        isTestDeployment: false,
        lastHealthAt: updated,
        deletedAt: null,
        createdAt: created,
        updatedAt: updated,
        createdBy: null,
        updatedBy: null,
      },
      deploymentSchema,
    ],
    [
      'DeploymentJob',
      {
        id: crypto.randomUUID(),
        deploymentId: crypto.randomUUID(),
        type: 'INSTALL',
        state: 'SUCCEEDED',
        idempotencyKey: 'install-01JABC',
        payload: { releaseId: 'abc' },
        result: { ok: true },
        failureCode: null,
        requestedBy: 'user_01JABC',
        startedAt: created,
        finishedAt: updated,
        createdAt: created,
        updatedAt: updated,
        createdBy: null,
        updatedBy: null,
      },
      deploymentJobSchema,
    ],
    [
      'EventLog',
      {
        id: 42,
        occurredAt: created,
        actorType: 'user',
        actorId: 'user_01JABC',
        organizationId: 'org_01JABC',
        customerId: crypto.randomUUID(),
        deploymentId: crypto.randomUUID(),
        jobId: null,
        releaseId: null,
        eventType: 'install.requested',
        previousState: null,
        requestedState: 'NOT_INSTALLED',
        result: null,
        payload: {},
      },
      eventLogSchema,
    ],
    [
      'Subscription',
      {
        id: crypto.randomUUID(),
        organizationId: 'org_01JABC',
        stripeSubscriptionId: 'sub_01JABC',
        stripeBasePriceId: 'price_base',
        stripeMeteredPriceId: 'price_metered',
        status: 'ACTIVE',
        currentPeriodStart: created,
        currentPeriodEnd: updated,
        createdAt: created,
        updatedAt: updated,
      },
      subscriptionSchema,
    ],
    [
      'UsageRecord',
      {
        id: crypto.randomUUID(),
        deploymentId: crypto.randomUUID(),
        usageDate: '2026-08-19',
        quantity: 1,
        stripeUsageRecordId: null,
        reportedAt: null,
        createdAt: created,
        updatedAt: updated,
      },
      usageRecordSchema,
    ],
  ];

  for (const [name, row, schema] of cases) {
    it(`${name}: JSON wire form parses back to itself`, () => {
      const wire = JSON.parse(JSON.stringify(row)) as unknown;
      expect(schema.parse(wire)).toStrictEqual(wire);
    });
  }
});

describe('errorEnvelopeSchema', () => {
  it('parses a minimal envelope (details optional)', () => {
    const envelope = { error: { code: 'UNAUTHORIZED', message: 'Authentication required' } };
    expect(errorEnvelopeSchema.parse(envelope)).toStrictEqual(envelope);
  });

  it('parses an envelope carrying details', () => {
    const envelope = {
      error: { code: 'PORT_MISMATCH', message: 'Port 8080 is not exposed', details: { port: 8080 } },
    };
    expect(errorEnvelopeSchema.parse(envelope)).toStrictEqual(envelope);
  });

  it('rejects an envelope without a message', () => {
    expect(() => errorEnvelopeSchema.parse({ error: { code: 'UNAUTHORIZED' } })).toThrow(ZodError);
  });
});
