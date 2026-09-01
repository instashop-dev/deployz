import { describe, expect, it } from 'vitest';
import { ZodError } from 'zod';

import {
  analysisStatusEnum,
  cleanupStateEnum,
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
  DEFAULT_APPLICATION_STACK_NAME,
  DEFAULT_BOOTSTRAP_STACK_NAME,
  DESTROY_PENDING_STALE_AFTER_MS,
  PACKAGE_NAME,
  REGION_LABELS,
  SUPPORTED_AWS_REGIONS,
  analysisStatusSchema,
  applicationSchema,
  bootstrapTemplateBucketName,
  cleanupStateSchema,
  compatibilityStatusSchema,
  customerSchema,
  deploymentJobSchema,
  deploymentSchema,
  deploymentStateSchema,
  errorEnvelopeSchema,
  eventLogSchema,
  failureCodeSchema,
  healthComponentsSchema,
  isSupportedRegion,
  jobStateSchema,
  jobTypeSchema,
  organizationSchema,
  redisApplicationTemplateUrl,
  regionSchema,
  releaseSchema,
  releaseStatusSchema,
  resolveBootstrapTemplate,
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
    ['cleanupState', cleanupStateSchema, cleanupStateEnum.enumValues],
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

  // Redis MVP task 3: the two new codes must be present in the contracts
  // mirror explicitly, not merely covered by the generic parity loop above.
  it('includes the two Redis failure codes', () => {
    expect(failureCodeSchema.options).toContain('REDIS_PROVISIONING_FAILED');
    expect(failureCodeSchema.options).toContain('REDIS_CONNECTION_FAILED');
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
        redisRequired: false,
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
        cleanupState: null,
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

describe('stack name constants', () => {
  it('names the application stack', () => {
    expect(DEFAULT_APPLICATION_STACK_NAME).toBe('deployz-app');
  });

  it('does not collide with the bootstrap stack name', () => {
    expect(DEFAULT_APPLICATION_STACK_NAME).not.toBe(DEFAULT_BOOTSTRAP_STACK_NAME);
  });
});

// The §32 supported-region source is the SINGLE canonical list every consumer
// derives from — API/UI validation, bootstrap publishing and the install-link
// resolver. It must stay exactly the 17-region allowlist the db enum already
// locks (regionSchema parity is asserted above); these tests lock the derived
// behavior on top of it.
describe('SUPPORTED_AWS_REGIONS / REGION_LABELS / isSupportedRegion', () => {
  it('keeps the 17-region allowlist', () => {
    expect(SUPPORTED_AWS_REGIONS).toHaveLength(17);
    expect(SUPPORTED_AWS_REGIONS).toContain('us-east-1');
    expect(SUPPORTED_AWS_REGIONS).toContain('us-east-2');
  });

  it('regionSchema is derived from the canonical list (no drift)', () => {
    expect([...regionSchema.options].sort()).toEqual([...SUPPORTED_AWS_REGIONS].sort());
  });

  it('labels every supported region', () => {
    for (const region of SUPPORTED_AWS_REGIONS) {
      expect(REGION_LABELS[region]).toBeDefined();
      expect(REGION_LABELS[region].length).toBeGreaterThan(0);
    }
  });

  it('isSupportedRegion accepts only allowlisted regions', () => {
    expect(isSupportedRegion('us-east-2')).toBe(true);
    expect(isSupportedRegion('eu-west-1')).toBe(true);
    expect(isSupportedRegion('mars-1')).toBe(false);
    expect(isSupportedRegion('')).toBe(false);
  });
});

describe('bootstrapTemplateBucketName', () => {
  it('derives the deterministic regional bucket name', () => {
    expect(bootstrapTemplateBucketName('us-east-1')).toBe('deployz-templates-us-east-1');
    expect(bootstrapTemplateBucketName('us-east-2')).toBe('deployz-templates-us-east-2');
  });
});

describe('resolveBootstrapTemplate', () => {
  it('resolves the regional template URL for a supported region', () => {
    const url = resolveBootstrapTemplate('us-east-2');
    expect(url).toBe(
      'https://deployz-templates-us-east-2.s3.us-east-2.amazonaws.com/bootstrap/v1/bootstrap-template-v1.json',
    );
  });

  it('never resolves an unsupported region (fails closed)', () => {
    expect(resolveBootstrapTemplate('mars-1')).toBeUndefined();
    expect(resolveBootstrapTemplate('us-gov-west-1')).toBeUndefined();
  });

  it('does not resolve a supported-but-unpublished region (fails closed)', () => {
    expect(resolveBootstrapTemplate('us-east-2', { deployableRegions: ['us-east-1'] })).toBeUndefined();
  });

  it('honors the legacy URL for us-east-1 only', () => {
    const legacy = 'https://legacy-bucket.s3.us-east-1.amazonaws.com/bootstrap/v1/bootstrap-template-v1.json';
    expect(resolveBootstrapTemplate('us-east-1', { legacyUrl: legacy })).toBe(legacy);
  });

  it('never lets the legacy URL fall back across regions (no cross-region link)', () => {
    const legacy = 'https://legacy-bucket.s3.us-east-1.amazonaws.com/bootstrap/v1/bootstrap-template-v1.json';
    // us-east-2 must resolve to ITS OWN bucket, not the legacy us-east-1 one.
    expect(resolveBootstrapTemplate('us-east-2', { legacyUrl: legacy })).toBe(
      'https://deployz-templates-us-east-2.s3.us-east-2.amazonaws.com/bootstrap/v1/bootstrap-template-v1.json',
    );
  });

  it('does not fall back to a legacy URL for us-east-1 when the legacy URL is absent', () => {
    expect(resolveBootstrapTemplate('us-east-1')).toBe(
      'https://deployz-templates-us-east-1.s3.us-east-1.amazonaws.com/bootstrap/v1/bootstrap-template-v1.json',
    );
  });

  it('resolves a legacy URL for us-east-1 even when the deployable set is empty', () => {
    // The legacy URL IS the confirmation that us-east-1 is published, so it
    // must not be gated behind the deployable set.
    const legacy = 'https://legacy-bucket.s3.us-east-1.amazonaws.com/bootstrap/v1/bootstrap-template-v1.json';
    expect(resolveBootstrapTemplate('us-east-1', { legacyUrl: legacy, deployableRegions: [] })).toBe(legacy);
  });
});

describe('redisApplicationTemplateUrl', () => {
  it('derives the sibling Redis-enabled template URL', () => {
    expect(
      redisApplicationTemplateUrl(
        'https://bucket.s3.us-east-1.amazonaws.com/application/v1/application-template-v1.json',
      ),
    ).toBe('https://bucket.s3.us-east-1.amazonaws.com/application/v1/application-template-redis-v1.json');
  });

  it('preserves the prefix path exactly', () => {
    expect(redisApplicationTemplateUrl('s3://a/b/c/application-template-v1.json')).toBe(
      's3://a/b/c/application-template-redis-v1.json',
    );
  });

  it('returns undefined for a URL not ending in the base template key', () => {
    expect(redisApplicationTemplateUrl('https://bucket.s3.amazonaws.com/other-template.json')).toBeUndefined();
  });

  it('returns undefined for an empty string', () => {
    expect(redisApplicationTemplateUrl('')).toBeUndefined();
  });
});

describe('healthComponentsSchema', () => {
  it('accepts a redis component', () => {
    expect(healthComponentsSchema.parse({ redis: 'HEALTHY' })).toStrictEqual({
      redis: 'HEALTHY',
    });
  });

  it('still rejects unknown component keys', () => {
    expect(() => healthComponentsSchema.parse({ queue: 'HEALTHY' })).toThrow(ZodError);
  });
});

describe('DESTROY_PENDING_STALE_AFTER_MS', () => {
  it('is the 60-minute escape-hatch threshold', () => {
    expect(DESTROY_PENDING_STALE_AFTER_MS).toBe(60 * 60 * 1000);
  });
});

