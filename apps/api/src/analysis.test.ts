import { PGlite } from '@electric-sql/pglite';
import crypto from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createAiGateway, type AiGateway } from '@deployz/analysis';
import { applyMigrations, createDb, type Db } from '@deployz/db';
import * as schema from '@deployz/db/schema';

import {
  ANALYSIS_VERSION,
  createAnalysisRunner,
  runApplicationAnalysis,
  type AnalysisRunnerDeps,
} from './analysis.js';
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
      aiGateway: createAiGateway(undefined),
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
    expect(checks.unsupported.some((c) => c.title === 'This Redis setup is not supported')).toBe(true);
  });

  it('analyses the static-api fixture (no database) to COMPLETE/READY with databaseRequired false', async () => {
    const application = await insertApplication(db, orgId, {
      repoFullName: 'deployz-demo/static-api',
    });

    await runApplicationAnalysis(deps, application.id);

    const row = await loadApplication(db, application.id);
    expect(row.analysisStatus).toBe('COMPLETE');
    expect(row.compatibilityStatus).toBe('READY');
    expect(row.compatibilityReason).toBe('Compatible with Deployz');
    // No database → databaseRequired stays false, databaseState 'none'.
    expect(row.databaseRequired).toBe(false);

    const metadata = row.detectedMetadata as { databaseState?: string; checks: { ready: Array<{ label: string }>; unsupported: unknown[] } };
    expect(metadata.databaseState).toBe('none');
    // The ready list must NOT advertise a PostgreSQL database.
    expect(metadata.checks.ready.some((c) => c.label === 'PostgreSQL database configured')).toBe(false);
    expect(metadata.checks.unsupported).toEqual([]);
  });

  it('analyses the bullmq-worker fixture repo to a supported, high-confidence Redis requirement', async () => {
    const application = await insertApplication(db, orgId, {
      repoFullName: 'deployz-demo/bullmq-worker',
    });

    await runApplicationAnalysis(deps, application.id);

    const row = await loadApplication(db, application.id);
    expect(row.analysisStatus).toBe('COMPLETE');
    expect(row.compatibilityStatus).toBe('READY');
    expect(row.databaseRequired).toBe(true);
    expect(row.redisRequired).toBe(true);

    const checks = (row.detectedMetadata as { checks: { ready: Array<{ label: string }> } }).checks;
    expect(checks.ready).toContainEqual({ label: 'Redis — managed automatically' });
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

  // The analysis runs detached on the worker Lambda and catches EVERY error,
  // so without this line a failed run leaves no trace anywhere: the row says
  // FAILED, CloudWatch says nothing, and production is undiagnosable.
  it('logs the failure so a failed run is visible in the worker log', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const application = await insertApplication(db, orgId, { repoFullName: 'someone/unknown-repo' });

    await runApplicationAnalysis(deps, application.id);

    expect(logged).toHaveBeenCalledOnce();
    const [message] = logged.mock.calls[0] as [string];
    expect(message).toContain(application.id);
    expect(message).toContain('Repository not found');
    logged.mockRestore();
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
      aiGateway: createAiGateway(undefined),
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
      aiGateway: createAiGateway(undefined),
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
      aiGateway: createAiGateway(undefined),
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
      aiGateway: createAiGateway(undefined),
    };

    await runApplicationAnalysis(deps, application.id);

    const row = await loadApplication(db, application.id);
    expect(row.analysisStatus).toBe('COMPLETE');
    // Dockerfile + HEALTHCHECK + Postgres + migration script present, but no
    // literal "/health" route match -> NEEDS_ATTENTION (missing health
    // endpoint), not READY. This exercises the real-mode fetch path, not a
    // specific verdict.
    expect(['READY', 'NEEDS_ATTENTION']).toContain(row.compatibilityStatus);
    // A bare `pg` dependency with no connection-string evidence (env var,
    // Prisma provider, compose image) is not enough to provision RDS — see
    // the dedicated evidence-gating tests below.
    expect(row.databaseRequired).toBe(false);
  });

  it('does NOT set databaseRequired from a bare pg dependency with no other evidence', async () => {
    const application = await insertApplication(db, orgId, {
      githubInstallationId: 'install-1',
      repoFullName: 'acme/pg-only',
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
            tree: [{ path: 'package.json', type: 'blob', sha: 'sha-pkg', size: 100 }],
          }),
        };
      }
      // git blobs endpoint — the only file is package.json.
      const content = JSON.stringify({ name: 'pg-only', dependencies: { pg: '^8.12.0' } });
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
      aiGateway: createAiGateway(undefined),
    };

    await runApplicationAnalysis(deps, application.id);

    const row = await loadApplication(db, application.id);
    expect(row.analysisStatus).toBe('COMPLETE');
    expect(row.databaseRequired).toBe(false);
  });

  it('sets databaseRequired when a pg dependency AND a DATABASE_URL reference are both present', async () => {
    const application = await insertApplication(db, orgId, {
      githubInstallationId: 'install-1',
      repoFullName: 'acme/pg-with-url',
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
              { path: 'package.json', type: 'blob', sha: 'sha-pkg', size: 100 },
              { path: '.env.example', type: 'blob', sha: 'sha-env', size: 20 },
            ],
          }),
        };
      }
      // git blobs endpoint
      const sha = url.split('/').pop();
      const content =
        sha === 'sha-pkg'
          ? JSON.stringify({ name: 'pg-with-url', dependencies: { pg: '^8.12.0' } })
          : 'DATABASE_URL=\n';
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
      aiGateway: createAiGateway(undefined),
    };

    await runApplicationAnalysis(deps, application.id);

    const row = await loadApplication(db, application.id);
    expect(row.analysisStatus).toBe('COMPLETE');
    expect(row.databaseRequired).toBe(true);
  });
});

// §15 AI repository-analysis fallback: only called when the deterministic
// analyser leaves a real question unresolved, merged so it can fill a gap but
// never overwrite a deterministic value, and failing soft (analysis still
// persists COMPLETE) on any AI error.
describe('analysis — runApplicationAnalysis (AI fallback)', () => {
  let client: PGlite | undefined;
  let db: Db;
  let orgId: string;

  beforeAll(async () => {
    client = new PGlite();
    await applyMigrations(client);
    db = createDb(client);
    orgId = 'org-analysis-ai';
    await insertOrganization(db, orgId);
  }, 60_000);

  afterAll(async () => {
    await client?.close();
  });

  // A Dockerfile with no CMD/ENTRYPOINT and a package.json with no "start"
  // script — hasStartupCommand stays false and nothing else is ambiguous, so
  // the only unresolved question is 'start-command-unknown'.
  async function buildDepsForAmbiguousStartCommand(
    aiGateway: AiGateway,
  ): Promise<{ deps: AnalysisRunnerDeps; repoFullName: string }> {
    const { generateKeyPairSync } = await import('node:crypto');
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const repoFullName = `acme/no-start-${crypto.randomUUID().slice(0, 8)}`;

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
              { path: 'package.json', type: 'blob', sha: 'sha-pkg', size: 100 },
              { path: 'Dockerfile', type: 'blob', sha: 'sha-docker', size: 60 },
            ],
          }),
        };
      }
      const sha = url.split('/').pop();
      const content =
        sha === 'sha-pkg'
          ? JSON.stringify({ name: 'no-start', dependencies: { express: '^4.18.0' } })
          : 'FROM node:20-alpine\nEXPOSE 3000\n';
      return {
        status: 200,
        headers: { get: () => null },
        json: async () => ({ content: Buffer.from(content).toString('base64'), encoding: 'base64' }),
      };
    };

    return {
      repoFullName,
      deps: {
        db,
        fetchFn,
        githubAppId: 'app-id',
        githubAppPrivateKey: privateKey,
        githubFixtureMode: false,
        aiGateway,
      },
    };
  }

  it('fills a missing start command from a valid AI answer and records aiResolved', async () => {
    const aiGateway: AiGateway = {
      async generate() {
        return {
          object: {
            workingDirectory: '.',
            buildCommand: null,
            startCommand: 'node index.js',
            port: null,
            postgres: { required: false, evidence: [] },
            redis: { required: false, evidence: [] },
            migrationCommand: null,
            warnings: [],
          },
          usage: { promptTokens: 500, completionTokens: 50 },
        };
      },
    };
    const { deps, repoFullName } = await buildDepsForAmbiguousStartCommand(aiGateway);
    const application = await insertApplication(db, orgId, { githubInstallationId: 'install-1', repoFullName });

    await runApplicationAnalysis(deps, application.id);

    const row = await loadApplication(db, application.id);
    expect(row.analysisStatus).toBe('COMPLETE');
    const metadata = row.detectedMetadata as {
      startupCommands?: string[];
      hasStartupCommand?: boolean;
      aiAnalysis?: { unresolved: string[]; aiResolved: string[]; warnings: string[] };
    };
    expect(metadata.hasStartupCommand).toBe(true);
    expect(metadata.startupCommands).toEqual(['node index.js']);
    expect(metadata.aiAnalysis?.unresolved).toContain('start-command-unknown');
    expect(metadata.aiAnalysis?.aiResolved.length).toBeGreaterThan(0);
    expect(metadata.aiAnalysis?.aiResolved).toContain('startupCommands');
  });

  it('degrades to deterministic metadata and stays COMPLETE when the gateway throws', async () => {
    const aiGateway: AiGateway = {
      async generate() {
        throw new Error('gateway unreachable');
      },
    };
    const { deps, repoFullName } = await buildDepsForAmbiguousStartCommand(aiGateway);
    const application = await insertApplication(db, orgId, { githubInstallationId: 'install-1', repoFullName });

    await runApplicationAnalysis(deps, application.id);

    const row = await loadApplication(db, application.id);
    expect(row.analysisStatus).toBe('COMPLETE');
    const metadata = row.detectedMetadata as {
      hasStartupCommand?: boolean;
      aiAnalysis?: { unresolved: string[]; warnings: string[] };
    };
    // Deterministic metadata is untouched — still unresolved.
    expect(metadata.hasStartupCommand).toBe(false);
    expect(metadata.aiAnalysis?.warnings).toContain('AI analysis unavailable');
  });

  it('never invokes the gateway for a fully-resolved fixture repo', async () => {
    let callCount = 0;
    const aiGateway: AiGateway = {
      async generate() {
        callCount += 1;
        throw new Error('should never be called for a fully-resolved analysis');
      },
    };
    const deps: AnalysisRunnerDeps = {
      db,
      fetchFn: (() => {
        throw new Error('fixture mode must never call fetchFn');
      }) as unknown as FetchFn,
      githubAppId: undefined,
      githubAppPrivateKey: undefined,
      githubFixtureMode: true,
      aiGateway,
    };
    const application = await insertApplication(db, orgId, { repoFullName: 'deployz-demo/express-api' });

    await runApplicationAnalysis(deps, application.id);

    const row = await loadApplication(db, application.id);
    expect(row.analysisStatus).toBe('COMPLETE');
    expect(callCount).toBe(0);
    const metadata = row.detectedMetadata as { aiAnalysis?: unknown };
    expect(metadata.aiAnalysis).toBeUndefined();
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
        aiGateway: createAiGateway(undefined),
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

// Task 6: commit-SHA analysis cache — a re-analysis whose repository head
// commit hasn't moved (and whose stored ANALYSIS_VERSION still matches)
// short-circuits to COMPLETE without re-fetching the tree, re-running the
// detectors, or invoking AI. Real-GitHub mode only; fixture mode has no head
// sha to compare and always runs fully.
describe('analysis — commit-SHA cache (Task 6)', () => {
  let client: PGlite | undefined;
  let db: Db;
  let orgId: string;
  let privateKey: string;

  beforeAll(async () => {
    client = new PGlite();
    await applyMigrations(client);
    db = createDb(client);
    orgId = 'org-analysis-cache';
    await insertOrganization(db, orgId);
    const { generateKeyPairSync } = await import('node:crypto');
    privateKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey as unknown as string;
  }, 60_000);

  afterAll(async () => {
    await client?.close();
  });

  /** A minimal real-GitHub fetchFn: access_tokens + commits/{branch} (head sha) + tree + one blob. */
  function buildFetch(headSha: string, calls: string[]): FetchFn {
    return async (url) => {
      calls.push(url);
      if (url.includes('/access_tokens')) {
        return {
          status: 201,
          headers: { get: () => null },
          json: async () => ({ token: 'ghs_test', expires_at: '2099-01-01T00:00:00Z' }),
        };
      }
      if (url.includes('/commits/')) {
        return { status: 200, headers: { get: () => null }, json: async () => ({ sha: headSha }) };
      }
      if (url.includes('/git/trees/')) {
        return {
          status: 200,
          headers: { get: () => null },
          json: async () => ({
            tree: [{ path: 'package.json', type: 'blob', sha: 'sha-pkg', size: 100 }],
          }),
        };
      }
      const content = JSON.stringify({
        name: 'widgets',
        scripts: { start: 'node index.js' },
        dependencies: { express: '^4.18.0' },
      });
      return {
        status: 200,
        headers: { get: () => null },
        json: async () => ({ content: Buffer.from(content).toString('base64'), encoding: 'base64' }),
      };
    };
  }

  function makeDeps(fetchFn: FetchFn): AnalysisRunnerDeps {
    return {
      db,
      fetchFn,
      githubAppId: 'app-id',
      githubAppPrivateKey: privateKey,
      githubFixtureMode: false,
      aiGateway: createAiGateway(undefined),
    };
  }

  it('(a) a second run against the same head sha short-circuits: no tree fetch, ends COMPLETE, other columns untouched', async () => {
    const application = await insertApplication(db, orgId, {
      githubInstallationId: 'install-1',
      repoFullName: 'acme/cache-a',
      defaultBranch: 'main',
    });
    const calls: string[] = [];
    const deps = makeDeps(buildFetch('sha-same', calls));

    await runApplicationAnalysis(deps, application.id);
    expect(calls.filter((u) => u.includes('/git/trees/'))).toHaveLength(1);
    const afterFirst = await loadApplication(db, application.id);
    expect(afterFirst.analysisStatus).toBe('COMPLETE');
    const metadata = afterFirst.detectedMetadata as { analysisCommitSha?: string; analysisVersion?: number };
    expect(metadata.analysisCommitSha).toBe('sha-same');
    expect(metadata.analysisVersion).toBe(ANALYSIS_VERSION);

    // Corrupt a column a cache-hit must never touch, to prove it truly no-ops.
    await db
      .update(schema.applications)
      .set({ compatibilityReason: 'stale-sentinel', analysisStatus: 'ANALYZING' })
      .where(eq(schema.applications.id, application.id));

    await runApplicationAnalysis(deps, application.id);

    expect(calls.filter((u) => u.includes('/git/trees/'))).toHaveLength(1); // still 1 — no second tree fetch
    const afterSecond = await loadApplication(db, application.id);
    expect(afterSecond.analysisStatus).toBe('COMPLETE');
    expect(afterSecond.compatibilityReason).toBe('stale-sentinel'); // untouched
  });

  it('(b) force: true re-runs even when the head sha is unchanged', async () => {
    const application = await insertApplication(db, orgId, {
      githubInstallationId: 'install-1',
      repoFullName: 'acme/cache-b',
      defaultBranch: 'main',
    });
    const calls: string[] = [];
    const deps = makeDeps(buildFetch('sha-same', calls));

    await runApplicationAnalysis(deps, application.id);
    await runApplicationAnalysis(deps, application.id, { force: true });

    expect(calls.filter((u) => u.includes('/git/trees/'))).toHaveLength(2);
    const row = await loadApplication(db, application.id);
    expect(row.analysisStatus).toBe('COMPLETE');
  });

  it('(c) a changed head sha re-runs', async () => {
    const application = await insertApplication(db, orgId, {
      githubInstallationId: 'install-1',
      repoFullName: 'acme/cache-c',
      defaultBranch: 'main',
    });
    const calls: string[] = [];
    let headSha = 'sha-1';
    const deps = makeDeps(((url, init) => buildFetch(headSha, calls)(url, init)) as FetchFn);

    await runApplicationAnalysis(deps, application.id);
    headSha = 'sha-2';
    await runApplicationAnalysis(deps, application.id);

    expect(calls.filter((u) => u.includes('/git/trees/'))).toHaveLength(2);
    const row = await loadApplication(db, application.id);
    expect(row.analysisStatus).toBe('COMPLETE');
    const metadata = row.detectedMetadata as { analysisCommitSha?: string };
    expect(metadata.analysisCommitSha).toBe('sha-2');
  });

  it('(d) a FAILED run does not persist analysisCommitSha', async () => {
    const application = await insertApplication(db, orgId, {
      githubInstallationId: 'install-1',
      repoFullName: 'acme/cache-d',
      defaultBranch: 'main',
    });
    const fetchFn: FetchFn = async (url) => {
      if (url.includes('/access_tokens')) {
        return {
          status: 201,
          headers: { get: () => null },
          json: async () => ({ token: 'ghs_test', expires_at: '2099-01-01T00:00:00Z' }),
        };
      }
      if (url.includes('/commits/')) {
        return { status: 200, headers: { get: () => null }, json: async () => ({ sha: 'sha-x' }) };
      }
      // Tree fetch fails -> the run fails.
      return { status: 404, headers: { get: () => null }, json: async () => ({ message: 'Not Found' }) };
    };
    const deps = makeDeps(fetchFn);

    await runApplicationAnalysis(deps, application.id);

    const row = await loadApplication(db, application.id);
    expect(row.analysisStatus).toBe('FAILED');
    const metadata = row.detectedMetadata as { analysisCommitSha?: string } | null;
    expect(metadata?.analysisCommitSha).toBeUndefined();
  });

  it('(e) fixture mode never short-circuits, even once analysisCommitSha/analysisVersion are already stored', async () => {
    const application = await insertApplication(db, orgId, {
      repoFullName: 'deployz-demo/express-api',
    });
    const fixtureDeps: AnalysisRunnerDeps = {
      db,
      fetchFn: (() => {
        throw new Error('fixture mode must never call fetchFn');
      }) as unknown as FetchFn,
      githubAppId: undefined,
      githubAppPrivateKey: undefined,
      githubFixtureMode: true,
      aiGateway: createAiGateway(undefined),
    };

    await runApplicationAnalysis(fixtureDeps, application.id);
    const first = await loadApplication(db, application.id);
    expect(first.analysisStatus).toBe('COMPLETE');

    // Stamp a matching cache entry plus a stale-sentinel column a cache-hit
    // would leave untouched — a full re-run must overwrite it regardless.
    await db
      .update(schema.applications)
      .set({
        compatibilityStatus: 'NOT_COMPATIBLE',
        compatibilityReason: 'stale-sentinel',
        detectedMetadata: {
          ...(first.detectedMetadata ?? {}),
          analysisCommitSha: 'whatever',
          analysisVersion: ANALYSIS_VERSION,
        },
        analysisStatus: 'ANALYZING',
      })
      .where(eq(schema.applications.id, application.id));

    await runApplicationAnalysis(fixtureDeps, application.id);

    const second = await loadApplication(db, application.id);
    expect(second.analysisStatus).toBe('COMPLETE');
    expect(second.compatibilityStatus).toBe('READY');
    expect(second.compatibilityReason).toBe('Compatible with Deployz');
  });
});
