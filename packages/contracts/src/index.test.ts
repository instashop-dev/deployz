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
  analysisStatusSchema,
  applicationSchema,
  applicationStackNameForInstallation,
  bootstrapStackName,
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
  jobStateSchema,
  jobTypeSchema,
  organizationSchema,
  redisApplicationTemplateUrl,
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

describe('bootstrapStackName', () => {
  const deploymentId = '1b2e3d4f-5678-4abc-9def-0123456789ab';

  it('derives a readable slug + short-id name for the first attempt', () => {
    expect(bootstrapStackName({ appName: 'Documenso', deploymentId })).toBe(
      'deployz-bootstrap-documenso-1b2e3d4f',
    );
  });

  it('gives two deployments of the same app different names', () => {
    const other = 'ffffffff-0000-4abc-9def-0123456789ab';
    expect(bootstrapStackName({ appName: 'Documenso', deploymentId: other })).not.toBe(
      bootstrapStackName({ appName: 'Documenso', deploymentId }),
    );
  });

  it('appends a fresh attempt suffix from attempt 1 on', () => {
    const first = bootstrapStackName({ appName: 'Documenso', deploymentId, attempt: 0 });
    const retry = bootstrapStackName({ appName: 'Documenso', deploymentId, attempt: 1 });
    expect(first).toBe('deployz-bootstrap-documenso-1b2e3d4f');
    expect(retry).toBe('deployz-bootstrap-documenso-1b2e3d4f-r1');
    expect(bootstrapStackName({ appName: 'Documenso', deploymentId, attempt: 2 })).toBe(
      'deployz-bootstrap-documenso-1b2e3d4f-r2',
    );
  });

  it('is deterministic for the same inputs', () => {
    expect(bootstrapStackName({ appName: 'Documenso', deploymentId, attempt: 1 })).toBe(
      bootstrapStackName({ appName: 'Documenso', deploymentId, attempt: 1 }),
    );
  });

  it('collapses symbols and whitespace in the application name', () => {
    expect(bootstrapStackName({ appName: 'My App!! (v2)', deploymentId })).toBe(
      'deployz-bootstrap-my-app-v2-1b2e3d4f',
    );
  });

  it('caps the slug so the name stays under the CFN 128-char limit', () => {
    const name = bootstrapStackName({ appName: 'a'.repeat(200), deploymentId, attempt: 12 });
    expect(name.length).toBeLessThan(128);
    expect(name).toMatch(/^deployz-bootstrap-a{24}-1b2e3d4f-r12$/);
  });

  it('omits an empty slug rather than emitting a double hyphen', () => {
    expect(bootstrapStackName({ appName: '!!!', deploymentId })).toBe(
      'deployz-bootstrap-1b2e3d4f',
    );
  });

  it('only emits CFN-legal stack-name characters', () => {
    const name = bootstrapStackName({ appName: 'Ünïcødé App 42%', deploymentId, attempt: 3 });
    expect(name).toMatch(/^[a-zA-Z0-9-]+$/);
  });
});

describe('applicationStackNameForInstallation', () => {
  it('derives the app stack name from the installation id', () => {
    expect(
      applicationStackNameForInstallation('9F3AB2C1-1234-4abc-9def-0123456789ab'),
    ).toBe('deployz-app-9f3ab2c1');
  });

  it('gives two installations different app stack names', () => {
    expect(applicationStackNameForInstallation('aaaaaaaa-0000-0000-0000-000000000000')).not.toBe(
      applicationStackNameForInstallation('bbbbbbbb-0000-0000-0000-000000000000'),
    );
  });

  it('keeps only CFN-legal characters from the installation id', () => {
    expect(applicationStackNameForInstallation('i-1a_2b!3c')).toBe('deployz-app-i1a2b3c');
  });

  it('falls back to the default when no installation id is known', () => {
    expect(applicationStackNameForInstallation('')).toBe(DEFAULT_APPLICATION_STACK_NAME);
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

