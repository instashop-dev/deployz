import { PGlite } from '@electric-sql/pglite';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { normalizeDeploymentManifest } from '@deployz/analysis';
import {
  requirementsFromSpec,
  type DeploymentManifest,
} from '@deployz/contracts';
import { applyMigrations, createDb, type Db } from '@deployz/db';
import * as schema from '@deployz/db/schema';
import { compactPendingInstallPayload, readDeploymentManifest, readVerifyOptionsFromPayload } from '@deployz/relay';
import {
  verifyInstallation,
  type CloudFormationReader,
  type StackLookup,
  type StackResource,
} from '@deployz/relay/verify';

import { compileDeploymentIntent } from './compiler-artifact.js';
import { createConfigStore } from './config.js';
import { buildInstallPayload } from './install-config.js';
import { applicationToManifestOverrides, readStoredDeploymentSpec, readStoredManifest } from './manifest.js';

// Phase 2 end-to-end contract: the canonical manifest a deployment is created
// with must survive, byte-for-byte in effect, all the way from the control
// plane (API -> INSTALL job payload) to the relay (template URL ->
// verification) — never re-derived from whatever the application's live
// columns say by the time any of this runs.

const INSTALLATION_ID = 'c2dca2bb-a733-470d-8ef0-8e96bc889442';

function reader(lookup: StackLookup, resources: StackResource[] = []): CloudFormationReader {
  return {
    describeStack: async () => lookup,
    describeStackResources: async () => resources,
  };
}

function completeStack(): StackLookup {
  return {
    found: true,
    stack: { stackName: 'deployz-app', status: 'CREATE_COMPLETE', tags: { 'deployz:installation': INSTALLATION_ID } },
  };
}

const COMPUTE_RESOURCE: StackResource = { logicalId: 'Service', type: 'AWS::ECS::Service', status: 'CREATE_COMPLETE' };
const INGRESS_RESOURCE: StackResource = {
  logicalId: 'Alb',
  type: 'AWS::ElasticLoadBalancingV2::LoadBalancer',
  status: 'CREATE_COMPLETE',
};
const DB_RESOURCE: StackResource = { logicalId: 'Db', type: 'AWS::RDS::DBInstance', status: 'CREATE_COMPLETE' };
const STORAGE_RESOURCE: StackResource = { logicalId: 'Bucket', type: 'AWS::S3::Bucket', status: 'CREATE_COMPLETE' };
const CACHE_RESOURCE: StackResource = {
  logicalId: 'Cache',
  type: 'AWS::ElastiCache::ReplicationGroup',
  status: 'CREATE_COMPLETE',
};

describe('requirements contract: manifest survives API -> job -> relay unchanged', () => {
  let client: PGlite | undefined;
  let db: Db;
  const organizationId = 'org-req-contract';
  let customerId: string;
  let appCounter = 0;

  beforeAll(async () => {
    client = new PGlite();
    await applyMigrations(client);
    db = createDb(client);
    await db.insert(schema.organization).values({ id: organizationId, name: 'Acme', slug: organizationId });
    const [customer] = await db
      .insert(schema.customers)
      .values({ organizationId, name: 'Customer', email: 'customer@example.com' })
      .returning();
    customerId = customer!.id;
  }, 60_000);

  afterAll(async () => {
    await client?.close();
  });

  async function insertApplication(overrides: {
    databaseRequired: boolean;
    redisRequired: boolean;
    storageRequired: boolean;
  }): Promise<typeof schema.applications.$inferSelect> {
    appCounter += 1;
    const [row] = await db
      .insert(schema.applications)
      .values({
        organizationId,
        name: `Requirements Contract App ${appCounter}`,
        repoFullName: `acme/req-contract-${appCounter}`,
        repoUrl: `https://github.com/acme/req-contract-${appCounter}`,
        defaultBranch: 'main',
        analysisStatus: 'COMPLETE',
        containerPort: 3000,
        healthPath: '/health',
        migrationCommand: overrides.databaseRequired ? 'npm run migrate' : null,
        ...overrides,
      })
      .returning();
    // A built release: the INSTALL payload refuses without one.
    await db.insert(schema.releases).values({
      applicationId: row!.id,
      version: '1.0.0',
      gitSha: 'a'.repeat(40),
      releaseStatus: 'READY',
      imageDigest: `123456789012.dkr.ecr.us-east-1.amazonaws.com/deployz-fixture@sha256:${'b'.repeat(64)}`,
    });
    return row!;
  }

  /** Builds the effective manifest exactly as the deployment-creation path does
   *  (server.ts's computeApplicationRequirements / deploy-links.ts's
   *  createDeploymentRecord via runApplicationPreflight): the real analyser
   *  normalizer over the application's overrides. */
  function effectiveManifestFor(application: typeof schema.applications.$inferSelect): DeploymentManifest {
    return normalizeDeploymentManifest(
      { metadata: (application.detectedMetadata as Record<string, unknown> | null) ?? {} },
      applicationToManifestOverrides(application),
    );
  }

  /** Mirrors createDeploymentRecord's persistence step: the effective manifest
   *  frozen onto desiredState plus the completed compiled spec. */
  async function insertDeployment(
    applicationId: string,
    manifest: DeploymentManifest,
  ): Promise<typeof schema.deployments.$inferSelect> {
    const { spec } = compileDeploymentIntent({ manifest, region: 'us-east-1' });
    const [row] = await db
      .insert(schema.deployments)
      .values({
        organizationId,
        applicationId,
        customerId,
        region: 'us-east-1',
        state: 'NOT_INSTALLED',
        desiredState: { manifest },
        specV2: spec,
        enrollmentCode: crypto.randomUUID(),
      })
      .returning();
    return row!;
  }

  const PROFILES = [
    { label: 'stateless', databaseRequired: false, redisRequired: false },
    { label: 'postgres', databaseRequired: true, redisRequired: false },
    { label: 'stateless+redis', databaseRequired: false, redisRequired: true },
    { label: 'postgres+redis', databaseRequired: true, redisRequired: true },
  ] as const;

  const seenArtifactUrls = new Set<string>();

  for (const profile of PROFILES) {
    for (const storageRequired of [true, false]) {
      it(`${profile.label}, storage=${storageRequired}: resolved template and verify options equal the original requirements`, async () => {
        const application = await insertApplication({
          databaseRequired: profile.databaseRequired,
          redisRequired: profile.redisRequired,
          storageRequired,
        });
        const effectiveManifest = effectiveManifestFor(application);
        expect(effectiveManifest.database.postgres).toBe(profile.databaseRequired);
        expect(effectiveManifest.redis.required).toBe(profile.redisRequired);
        expect(effectiveManifest.storage.required).toBe(storageRequired);

        const deployment = await insertDeployment(application.id, effectiveManifest);

        // The real API function that mints an INSTALL job's payload.
        const payload = await buildInstallPayload(db, deployment, createConfigStore(db));
        expect(payload['manifest']).toEqual(readStoredManifest(deployment.desiredState));

        // Feed the payload into the REAL relay functions — the same ones
        // the relay's settleInstall/observe hook run in production.
        const manifestFromPayload = readDeploymentManifest(payload as Record<string, unknown>);
        expect(manifestFromPayload).toEqual(effectiveManifest);

        // The payload points at the deployment's OWN frozen artifact: one
        // content-addressed compiled template per requirement set.
        const artifactLocation = (deployment.specV2 as { artifactLocation: string }).artifactLocation;
        expect(payload['templateUrl']).toBe(artifactLocation);
        expect(artifactLocation).toMatch(
          /^https:\/\/deployz-templates-us-east-1\.s3\.us-east-1\.amazonaws\.com\/compiler-v2\/[0-9a-f]{64}\.json$/,
        );
        seenArtifactUrls.add(artifactLocation);

        const compacted = compactPendingInstallPayload(payload as Record<string, unknown>);
        expect(compacted['redisRequired']).toBe(profile.redisRequired);
        expect(compacted['databaseRequired']).toBe(profile.databaseRequired);

        const verifyOptions = readVerifyOptionsFromPayload(payload as Record<string, unknown>);
        expect(verifyOptions.redisRequired).toBe(profile.redisRequired);
        expect(verifyOptions.databaseRequired).toBe(profile.databaseRequired);
      });
    }
  }

  it('every distinct requirement set froze its own artifact URL (no shared variant guess)', () => {
    expect(seenArtifactUrls.size).toBe(PROFILES.length);
  });

  // The explicit Redis regression (§established facts) — an application
  // analysed with Redis required must select the redis template variant and
  // verification must actually demand the cache resource, not merely carry
  // a flag nothing reads.
  it('an application analysed with Redis required selects the redis template variant and verify expects the cache', async () => {
    const application = await insertApplication({
      databaseRequired: true,
      redisRequired: true,
      storageRequired: false,
    });
    const manifest = effectiveManifestFor(application);
    expect(manifest.redis.required).toBe(true);
    const deployment = await insertDeployment(application.id, manifest);

    const payload = await buildInstallPayload(db, deployment, createConfigStore(db));
    expect((payload['manifest'] as DeploymentManifest).redis.required).toBe(true);
    // The artifact URL is the deployment's own frozen compiled template.
    expect(payload['templateUrl']).toBe((deployment.specV2 as { artifactLocation: string }).artifactLocation);

    const verifyOptions = readVerifyOptionsFromPayload(payload as Record<string, unknown>);
    expect(verifyOptions.redisRequired).toBe(true);
    expect(verifyOptions.databaseRequired).toBe(true);

    // Verify genuinely demands the cache resource — absent it, verification fails.
    const withoutCache = await verifyInstallation({
      cfn: reader(completeStack(), [COMPUTE_RESOURCE, INGRESS_RESOURCE, DB_RESOURCE, STORAGE_RESOURCE]),
      installationId: INSTALLATION_ID,
      redisRequired: verifyOptions.redisRequired!,
      databaseRequired: verifyOptions.databaseRequired!,
    });
    expect(withoutCache.verified).toBe(false);
    expect(withoutCache.checks.find((c) => c.name === 'cache')?.passed).toBe(false);

    const withCache = await verifyInstallation({
      cfn: reader(completeStack(), [COMPUTE_RESOURCE, INGRESS_RESOURCE, DB_RESOURCE, STORAGE_RESOURCE, CACHE_RESOURCE]),
      installationId: INSTALLATION_ID,
      redisRequired: verifyOptions.redisRequired!,
      databaseRequired: verifyOptions.databaseRequired!,
    });
    expect(withCache.verified).toBe(true);
  });

  // The drift case: once a deployment freezes its manifest, a later change to
  // the application's live columns must never reach the INSTALL payload, the
  // template selection, or verification.
  it('the deployment still installs and verifies as redis even after the application column flips to false (frozen manifest)', async () => {
    const application = await insertApplication({
      databaseRequired: true,
      redisRequired: true,
      storageRequired: false,
    });
    const manifest = effectiveManifestFor(application);
    const deployment = await insertDeployment(application.id, manifest);

    // The vendor (or a later re-analysis) turns Redis off on the LIVE
    // application row — AFTER this deployment already froze its manifest.
    await db.update(schema.applications).set({ redisRequired: false }).where(eq(schema.applications.id, application.id));

    const payload = await buildInstallPayload(db, deployment, createConfigStore(db));
    expect(payload['redisRequired']).toBe(true);
    expect(payload['databaseRequired']).toBe(true);
    expect((payload['manifest'] as DeploymentManifest).redis.required).toBe(true);
    expect(payload['templateUrl']).toBe((deployment.specV2 as { artifactLocation: string }).artifactLocation);

    const verifyOptions = readVerifyOptionsFromPayload(payload as Record<string, unknown>);
    expect(verifyOptions.redisRequired).toBe(true);

    // The poll meta GET /api/relay/commands hands the relay's heartbeat
    // (apps/api/src/server.ts) is derived the same way: from the frozen
    // spec's verification contract, never the live column just flipped above.
    const requirements = requirementsFromSpec(readStoredDeploymentSpec(deployment.specV2)!);
    expect(requirements).toEqual({ databaseRequired: true, redisRequired: true });
  });
});
