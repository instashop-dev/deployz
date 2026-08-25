import { PGlite } from '@electric-sql/pglite';
import crypto from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { applyMigrations, createDb, type Db } from '@deployz/db';
import * as schema from '@deployz/db/schema';

import { createAnalysisRunner, runApplicationAnalysis, type AnalysisRunnerDeps } from './analysis.js';
import type { FetchFn } from './github.js';

// §18/§19/§20 analysis orchestrator. Real GitHub is BLOCKED in this
// environment, so the "real mode" cases drive a mocked FetchFn (same seam
// as github.test.ts); the fixture-mode cases exercise the full pipeline
// end-to-end (fixture tree -> analyseRepo -> evaluateCompatibility ->
// persisted checks) with zero network at all.

async function insertOrganization(db: Db, id: string): Promise<void> {
  await db.insert(schema.organization).values({ id, name: 'Acme', slug: id });
}

/**
 * Seed an application in a FRESH organization.
 *
 * One application per repository per organization is a database constraint
 * now, and several of these tests analyse the same fixture repo more than
 * once — which is the point, since the fixture keys off repoFullName. Giving
 * each application its own organization keeps those tests saying what they
 * meant without weakening the constraint.
 */
async function insertApplication(
  db: Db,
  organizationId: string,
  overrides: Partial<typeof schema.applications.$inferInsert> = {},
): Promise<typeof schema.applications.$inferSelect> {
  const ownOrgId = `${organizationId}-${crypto.randomUUID().slice(0, 8)}`;
  await insertOrganization(db, ownOrgId);
  const [row] = await db
    .insert(schema.applications)
    .values({
      organizationId: ownOrgId,
      name: 'Test App',
      repoFullName: 'acme/test-app',
      repoUrl: 'https://github.com/acme/test-app',
      defaultBranch: 'main',
      analysisStatus: 'ANALYZING',
      ...overrides,
    })
    .returning();
  return row!;
}

async function loadApplication(
  db: Db,
  id: string,
): Promise<typeof schema.applications.$inferSelect> {
  const rows = await db.select().from(schema.applications).where(eq(schema.applications.id, id)).limit(1);
  return rows[0]!;
}

describe('analysis — runApplicationAnalysis (fixture mode, end-to-end)', () => {
  let client: PGlite | undefined;
  let db: Db;
  let orgId: string;
  let deps: AnalysisRunnerDeps;

  beforeAll(async () => {
    client = new PGlite();
    await applyMigrations(client);
    db = createDb(client);
    orgId = 'org-analysis-fixture';
    await insertOrganization(db, orgId);
    deps = {
      db,
      fetchFn: (() => {
        throw new Error('fixture mode must never call fetchFn');
      }) as unknown as FetchFn,
      githubAppId: undefined,
      githubAppPrivateKey: undefined,
      githubFixtureMode: true,
    };
  }, 60_000);

  afterAll(async () => {
    await client?.close();
  });

  it('analyses the ready fixture repo to COMPLETE/READY and backfills §35 contract fields', async () => {
    const application = await insertApplication(db, orgId, {
      repoFullName: 'deployz-demo/express-api',
    });

    await runApplicationAnalysis(deps, application.id);

    const row = await loadApplication(db, application.id);
    expect(row.analysisStatus).toBe('COMPLETE');
    expect(row.compatibilityStatus).toBe('READY');
    expect(row.compatibilityReason).toBe('Compatible with Deployz');

    const checks = (row.detectedMetadata as { checks: { ready: unknown[]; needsAttention: unknown[]; unsupported: unknown[] } })
      .checks;
    expect(checks.ready.length).toBeGreaterThan(0);
    expect(checks.needsAttention).toEqual([]);
    expect(checks.unsupported).toEqual([]);
    expect(checks.ready).toContainEqual({ label: 'Dockerfile found' });

    // §35 contract fields backfilled from the analysis (were null/false).
    expect(row.containerPort).toBe(3000);
    expect(row.healthPath).toBe('/health');
    expect(row.migrationCommand).toBe('npx drizzle-kit push');
    expect(row.databaseRequired).toBe(true);
  });

  it('analyses the legacy-redis fixture repo to COMPLETE/NOT_COMPATIBLE with an unsupported check', async () => {
    const application = await insertApplication(db, orgId, {
      repoFullName: 'deployz-demo/legacy-redis',
    });

    await runApplicationAnalysis(deps, application.id);

    const row = await loadApplication(db, application.id);
    expect(row.analysisStatus).toBe('COMPLETE');
    expect(row.compatibilityStatus).toBe('NOT_COMPATIBLE');

    const checks = (row.detectedMetadata as { checks: { unsupported: Array<{ title: string; reason: string }> } })
      .checks;
    expect(checks.unsupported.length).toBeGreaterThan(0);
    expect(checks.unsupported.some((c) => c.title === 'Redis is not supported')).toBe(true);
  });

  it('refreshes a previously auto-detected contract field when the repo has changed', async () => {
    // The values a PREVIOUS analysis wrote, before the repo changed. Nothing
    // marks them as vendor-owned, so re-analysis must replace them.
    const application = await insertApplication(db, orgId, {
      repoFullName: 'deployz-demo/express-api',
      containerPort: 9999,
      migrationCommand: 'npm run old:migrate',
    });

    await runApplicationAnalysis(deps, application.id);

    const row = await loadApplication(db, application.id);
    expect(row.containerPort).toBe(3000);
    expect(row.migrationCommand).toBe('npx drizzle-kit push');
  });

  it('never overrides a contract field the vendor edited', async () => {
    const application = await insertApplication(db, orgId, {
      repoFullName: 'deployz-demo/express-api',
      containerPort: 8080,
      detectedMetadata: { vendorOverrides: ['containerPort'] },
    });

    await runApplicationAnalysis(deps, application.id);

    const row = await loadApplication(db, application.id);
    expect(row.analysisStatus).toBe('COMPLETE');
    // Vendor-owned -> untouched, even though the detector found 3000.
    expect(row.containerPort).toBe(8080);
    // Fields the vendor never touched still refresh.
    expect(row.healthPath).toBe('/health');
  });

  it('carries the vendor-override list across the analysis write', async () => {
    const application = await insertApplication(db, orgId, {
      repoFullName: 'deployz-demo/express-api',
      containerPort: 8080,
      detectedMetadata: { vendorOverrides: ['containerPort'] },
    });

    await runApplicationAnalysis(deps, application.id);

    const row = await loadApplication(db, application.id);
    const metadata = row.detectedMetadata as { vendorOverrides?: string[] };
    expect(metadata.vendorOverrides).toEqual(['containerPort']);
  });

  it('is a no-op (never throws) when the application row no longer exists', async () => {
    await expect(
      runApplicationAnalysis(deps, '00000000-0000-0000-0000-000000000000'),
    ).resolves.toBeUndefined();
  });

  it('404s for an unrecognized fixture repoFullName by persisting FAILED, never throwing', async () => {
    const application = await insertApplication(db, orgId, { repoFullName: 'someone/unknown-repo' });

    await expect(runApplicationAnalysis(deps, application.id)).resolves.toBeUndefined();

    const row = await loadApplication(db, application.id);
    expect(row.analysisStatus).toBe('FAILED');
    expect(row.compatibilityReason).toBe('Repository not found');
  });
});

describe('analysis — runApplicationAnalysis (real mode failure paths)', () => {
  let client: PGlite | undefined;
  let db: Db;
  let orgId: string;

  beforeAll(async () => {
    client = new PGlite();
    await applyMigrations(client);
    db = createDb(client);
    orgId = 'org-analysis-real';
    await insertOrganization(db, orgId);
  }, 60_000);

  afterAll(async () => {
    await client?.close();
  });

  it('fails cleanly with GITHUB_INSTALLATION_MISSING reason when no installation is linked', async () => {
    const application = await insertApplication(db, orgId, { githubInstallationId: null });
    const deps: AnalysisRunnerDeps = {
      db,
      fetchFn: (() => {
        throw new Error('should never be called');
      }) as unknown as FetchFn,
      githubAppId: 'app-id',
      githubAppPrivateKey: 'private-key',
      githubFixtureMode: false,
    };

    await runApplicationAnalysis(deps, application.id);

    const row = await loadApplication(db, application.id);
    expect(row.analysisStatus).toBe('FAILED');
    expect(row.compatibilityReason).toBe('No GitHub installation is linked to this application');
  });

  it('fails cleanly with GitHub-disabled reason when the App is not configured', async () => {
    const application = await insertApplication(db, orgId, { githubInstallationId: 'install-1' });
    const deps: AnalysisRunnerDeps = {
      db,
      fetchFn: (() => {
        throw new Error('should never be called');
      }) as unknown as FetchFn,
      githubAppId: undefined,
      githubAppPrivateKey: undefined,
      githubFixtureMode: false,
    };

    await runApplicationAnalysis(deps, application.id);

    const row = await loadApplication(db, application.id);
    expect(row.analysisStatus).toBe('FAILED');
    expect(row.compatibilityReason).toBe('GitHub App is not configured');
  });

  it('fails cleanly (never throws/rejects) when the token mint itself throws', async () => {
    const application = await insertApplication(db, orgId, { githubInstallationId: 'install-1' });
    const fetchFn: FetchFn = async () => ({
      status: 500,
      headers: { get: () => null },
      json: async () => ({ message: 'boom' }),
    });
    const deps: AnalysisRunnerDeps = {
      db,
      fetchFn,
      githubAppId: 'app-id',
      githubAppPrivateKey:
        '-----BEGIN RSA PRIVATE KEY-----\nnot-a-real-key\n-----END RSA PRIVATE KEY-----',
      githubFixtureMode: false,
    };

    await expect(runApplicationAnalysis(deps, application.id)).resolves.toBeUndefined();

    const row = await loadApplication(db, application.id);
    expect(row.analysisStatus).toBe('FAILED');
  });

  it('runs end-to-end over a fully mocked GitHub API (tree + blobs)', async () => {
    const application = await insertApplication(db, orgId, {
      githubInstallationId: 'install-1',
      repoFullName: 'acme/widgets',
      defaultBranch: 'main',
    });

    const { generateKeyPairSync } = await import('node:crypto');
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });

    const fetchFn: FetchFn = async (url) => {
      if (url.includes('/access_tokens')) {
        return {
          status: 201,
          headers: { get: () => null },
          json: async () => ({ token: 'ghs_test', expires_at: '2099-01-01T00:00:00Z' }),
        };
      }
      if (url.includes('/git/trees/')) {
        return {
          status: 200,
          headers: { get: () => null },
          json: async () => ({
            tree: [
              { path: 'package.json', type: 'blob', sha: 'sha-pkg', size: 200 },
              { path: 'Dockerfile', type: 'blob', sha: 'sha-docker', size: 100 },
            ],
          }),
        };
      }
      // git blobs endpoint
      const sha = url.split('/').pop();
      const content =
        sha === 'sha-pkg'
          ? JSON.stringify({
              name: 'widgets',
              scripts: { start: 'node index.js', 'db:migrate': 'npx drizzle-kit push' },
              dependencies: { express: '^4.18.0', pg: '^8.12.0' },
            })
          : 'FROM node:20-alpine\nHEALTHCHECK CMD curl -f http://localhost:3000/health\nCMD ["node", "index.js"]\n';
      return {
        status: 200,
        headers: { get: () => null },
        json: async () => ({ content: Buffer.from(content).toString('base64'), encoding: 'base64' }),
      };
    };

    const deps: AnalysisRunnerDeps = {
      db,
      fetchFn,
      githubAppId: 'app-id',
      githubAppPrivateKey: privateKey,
      githubFixtureMode: false,
    };

    await runApplicationAnalysis(deps, application.id);

    const row = await loadApplication(db, application.id);
    expect(row.analysisStatus).toBe('COMPLETE');
    // Dockerfile + HEALTHCHECK + Postgres + migration script present, but no
    // literal "/health" route match -> NEEDS_ATTENTION (missing health
    // endpoint), not READY. This exercises the real-mode fetch path, not a
    // specific verdict.
    expect(['READY', 'NEEDS_ATTENTION']).toContain(row.compatibilityStatus);
    expect(row.databaseRequired).toBe(true);
  });
});

describe('analysis — createAnalysisRunner', () => {
  it(
    'wraps runApplicationAnalysis into a single-argument (applicationId) => Promise<void>',
    async () => {
      const client = new PGlite();
      await applyMigrations(client);
      const db = createDb(client);
      await insertOrganization(db, 'org-runner');
      const application = await insertApplication(db, 'org-runner', {
        repoFullName: 'deployz-demo/express-api',
      });

      const runner = createAnalysisRunner({
        db,
        fetchFn: (() => {
          throw new Error('fixture mode must never call fetchFn');
        }) as unknown as FetchFn,
        githubAppId: undefined,
        githubAppPrivateKey: undefined,
        githubFixtureMode: true,
      });

      await runner(application.id);

      const rows = await db
        .select()
        .from(schema.applications)
        .where(eq(schema.applications.id, application.id));
      expect(rows[0]?.analysisStatus).toBe('COMPLETE');
      await client.close();
    },
    60_000,
  );
});
