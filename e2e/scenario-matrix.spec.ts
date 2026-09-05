/**
 * Phase 14 scenario-matrix gaps (§18 A–E) at the E2E level, driven through
 * the REAL HTTP API and — where a deployment is actually reachable — the real
 * relay executors over the simulated account:
 *
 *   D — an unsupported repo (deployz-demo/mongodb-app, a MongoDB app) is
 *       blocked at deployment creation with NO AWS provisioning: the POST
 *       /api/deployments gate refuses (422 MANIFEST_NOT_COMPATIBLE), so no
 *       deployment row — and therefore no INSTALL job — can ever exist.
 *   E — a repairable repo (deployz-demo/local-fs-app, persistent local
 *       filesystem writes) is blocked the same way, AND the coding-agent
 *       repair guidance surfaces through the real fix-instructions route.
 *   B — a successful Redis install: deployz-demo/bullmq-worker analysed
 *       through the real analyser (redisRequired from production analysis)
 *       installs to HEALTHY over the redis-success scenario, and a real
 *       DEPLOY_RELEASE carries the migration through the same deployment.
 *   C — a monorepo (deployz-demo/monorepo) classified by the real analyser
 *       is driven through a build+deploy simulated pass to HEALTHY.
 *
 * Unit-level coverage of the D/E gates already exists
 * (apps/api/src/server.test.ts, manifest.test.ts, redis.spec.ts UI passes);
 * these are the E2E proofs that the real analysis + gate + no-provisioning
 * boundary composes.
 */

import type { APIRequestContext } from '@playwright/test';

import { startSimulatedRelay } from './simulation/relay-harness.js';
import { getScenario } from './simulation/scenarios/index.js';
import { API_URL, expect, test } from './simulation/fixtures.js';

interface ReadinessResponse {
  analysisStatus: string;
  state: string;
  requiredCount: number;
  findings: Array<{
    id: string;
    blocking?: boolean;
    title?: string;
    plainEnglishExplanation?: string;
    technicalEvidence?: string;
  }>;
}

interface DeploymentResponse {
  state: string;
  currentReleaseId: string | null;
  applicationId: string;
  healthStatus: string;
}

interface ErrorBody {
  error: { code: string; message: string; details?: { findings?: Array<{ id: string; message?: string }> } };
}

interface InfrastructureResponse {
  components: Array<{ kind: string; status: string }>;
  summary: { technicalResourceCount: number };
}

async function signUp(request: APIRequestContext, suffix: string): Promise<void> {
  const email = `e2e-matrix-${suffix}@example.com`;
  const response = await request.post(`${API_URL}/api/auth/sign-up/email`, {
    data: { name: `Matrix Vendor ${suffix}`, email, password: 'super-secret-1' },
  });
  if (!response.ok()) {
    throw new Error(`sign-up failed: ${response.status()} ${await response.text()}`);
  }
}

async function seedAnalysedApplication(
  request: APIRequestContext,
  repoFullName: string,
  suffix: string,
): Promise<{ applicationId: string }> {
  const appResponse = await request.post(`${API_URL}/api/applications`, {
    data: {
      name: `Matrix App ${suffix}`,
      githubInstallationId: 'e2e-installation',
      repoFullName,
      repoUrl: `https://github.com/${repoFullName}`,
      defaultBranch: 'main',
    },
  });
  if (!appResponse.ok()) {
    throw new Error(`create application failed: ${appResponse.status()} ${await appResponse.text()}`);
  }
  const application = (await appResponse.json()) as { id: string };
  const analyseResponse = await request.post(`${API_URL}/api/applications/${application.id}/analyse`);
  if (!analyseResponse.ok()) {
    throw new Error(`analyse failed: ${analyseResponse.status()} ${await analyseResponse.text()}`);
  }
  return { applicationId: application.id };
}

async function createCustomer(request: APIRequestContext, suffix: string): Promise<string> {
  const response = await request.post(`${API_URL}/api/customers`, {
    data: { name: `Matrix Customer ${suffix}`, email: `matrix-customer-${suffix}@example.com` },
  });
  if (!response.ok()) {
    throw new Error(`create customer failed: ${response.status()} ${await response.text()}`);
  }
  return ((await response.json()) as { id: string }).id;
}

async function getReadiness(
  request: APIRequestContext,
  applicationId: string,
): Promise<ReadinessResponse> {
  const response = await request.get(`${API_URL}/api/applications/${applicationId}/readiness`);
  if (!response.ok()) {
    throw new Error(`GET readiness failed: ${response.status()} ${await response.text()}`);
  }
  return (await response.json()) as ReadinessResponse;
}

test.describe.configure({ mode: 'parallel' });

test.describe('unsupported-database (D)', () => {
  test('@scenario:unsupported-mongodb a MongoDB app is refused at deployment creation — no deployment, no INSTALL job, no provisioning', async ({
    request,
  }) => {
    test.setTimeout(30_000);
    const suffix = crypto.randomUUID().slice(0, 8);
    await signUp(request, suffix);

    const { applicationId } = await seedAnalysedApplication(request, 'deployz-demo/mongodb-app', suffix);

    // The real analysis classifies the repo as needing changes, with the
    // unsupported database as the ONE blocking finding — the rest of the app
    // (Dockerfile, port, health, start) is ready.
    const readiness = await getReadiness(request, applicationId);
    expect(readiness.analysisStatus).toBe('COMPLETE');
    expect(readiness.state).toBe('NEEDS_CHANGES');
    const mongo = readiness.findings.find((f) => f.id === 'unsupported-database-mongo');
    expect(mongo).toBeDefined();
    expect(mongo?.blocking).toBe(true);
    expect(mongo?.technicalEvidence).toContain('mongoose');

    const customerId = await createCustomer(request, suffix);
    const blocked = await request.post(`${API_URL}/api/deployments`, {
      data: { applicationId, customerId, region: 'us-east-1' },
    });
    expect(blocked.status()).toBe(422);
    const body = (await blocked.json()) as ErrorBody;
    expect(body.error.code).toBe('MANIFEST_NOT_COMPATIBLE');
    expect(body.error.details?.findings?.some((f) => f.message?.includes('MongoDB'))).toBe(true);

    // No deployment row exists for this application — the refusal happens
    // BEFORE any AWS provisioning can start, so no INSTALL job can ever be
    // created for it (an INSTALL job only exists on a deployment row, minted
    // at relay registration).
    const deployments = await request.get(`${API_URL}/api/deployments?applicationId=${applicationId}`);
    expect(deployments.ok()).toBeTruthy();
    expect(((await deployments.json()) as { deployments: unknown[] }).deployments).toEqual([]);
  });
});

test.describe('repairable-local-filesystem (E)', () => {
  test('@scenario:repairable-local-fs a local-filesystem app is refused at deployment creation and the coding-agent repair guidance surfaces', async ({
    request,
  }) => {
    test.setTimeout(30_000);
    const suffix = crypto.randomUUID().slice(0, 8);
    await signUp(request, suffix);

    const { applicationId } = await seedAnalysedApplication(request, 'deployz-demo/local-fs-app', suffix);

    // The real analysis classifies the repo as needing changes, with the
    // persistent-local-disk finding as the ONE blocking finding.
    const readiness = await getReadiness(request, applicationId);
    expect(readiness.analysisStatus).toBe('COMPLETE');
    expect(readiness.state).toBe('NEEDS_CHANGES');
    const localFs = readiness.findings.find((f) => f.id === 'local-file-storage');
    expect(localFs).toBeDefined();
    expect(localFs?.blocking).toBe(true);
    expect(localFs?.title).toBe('Files stored on local disk');
    expect(localFs?.technicalEvidence).toContain('VOLUME /data');

    const customerId = await createCustomer(request, suffix);
    const blocked = await request.post(`${API_URL}/api/deployments`, {
      data: { applicationId, customerId, region: 'us-east-1' },
    });
    expect(blocked.status()).toBe(422);
    const body = (await blocked.json()) as ErrorBody;
    expect(body.error.code).toBe('MANIFEST_NOT_COMPATIBLE');
    expect(body.error.details?.findings?.some((f) => f.id === 'unsupported')).toBe(true);

    // The coding-agent repair guidance surfaces through the real
    // fix-instructions route: the deterministic document carries the
    // finding's plain-English explanation and the object-storage outcome.
    const fix = await request.post(`${API_URL}/api/applications/${applicationId}/fix-instructions`);
    expect(fix.ok()).toBeTruthy();
    const { instructions } = (await fix.json()) as { instructions: string };
    expect(instructions).toContain('Files stored on local disk');
    expect(instructions).toContain(
      'Store uploaded and persistent files in object storage instead of the local disk.',
    );
    expect(instructions).toContain('Do not assume Deployz findings are correct');
  });
});

test.describe('redis-success (B)', () => {
  test.use({ deployzScenario: 'redis-success', deployzRepoFullName: 'deployz-demo/bullmq-worker' });

  test('@scenario:redis-success a Redis app installs to HEALTHY and a real deploy runs the migration through the same deployment', async ({
    request,
    deployzInstall,
  }) => {
    test.setTimeout(60_000);
    const { deploymentId, installLinkId, api, relay } = deployzInstall;
    expect(relay).toBeDefined();

    // The analysed bullmq-worker carries a Redis requirement into the install
    // page's "Deployz will create" list (production analysis, not a hand-set
    // flag) and the deployment installs over a Redis-provisioning timeline to
    // HEALTHY — including the ElastiCache resource in the persisted inventory.
    const installInfo = (await api.getInstallInfo(installLinkId)) as { resourcesCreated: string[] };
    expect(installInfo.resourcesCreated).toContain('Redis cache');

    await expect
      .poll(async () => (await api.getDeployment(deploymentId)).state, {
        timeout: 20_000,
        message: 'waiting for the Redis install to reach HEALTHY',
      })
      .toBe('HEALTHY');

    await expect
      .poll(
        async () => {
          const infra = (await api.getInfrastructure(deploymentId)) as unknown as InfrastructureResponse;
          return infra.summary.technicalResourceCount;
        },
        { timeout: 15_000, message: 'waiting for the resource inventory to be persisted' },
      )
      .toBeGreaterThan(0);
    const infra = (await api.getInfrastructure(deploymentId)) as unknown as InfrastructureResponse;
    expect(infra.components.some((c) => c.kind === 'cache' && c.status === 'ready')).toBe(true);

    // A real DEPLOY_RELEASE on the same deployment: the manifest carries the
    // analysed migration command, so the relay's migration stage actually
    // runs a one-off task (the account's migration counter) before the
    // service update — Redis provisioning and migration through one install.
    const installed = (await api.getDeployment(deploymentId)) as unknown as DeploymentResponse;
    const releaseResponse = await request.post(
      `${API_URL}/api/applications/${installed.applicationId}/releases`,
      { data: { version: '1.0.0', gitSha: 'sha-1.0.0' } },
    );
    expect(releaseResponse.ok()).toBeTruthy();
    const release = (await releaseResponse.json()) as { id: string };

    const deploy = await request.post(`${API_URL}/api/deployments/${deploymentId}/deploy`, {
      data: { releaseId: release.id },
    });
    expect(deploy.status()).toBe(202);

    await expect
      .poll(async () => (await api.getDeployment(deploymentId)).currentReleaseId, {
        timeout: 20_000,
        message: 'waiting for the deploy to advance the release pointer',
      })
      .toBe(release.id);
    expect(relay!.account.migrationRuns).toBe(1);
  });
});

test.describe('monorepo-classified-deploy (C)', () => {
  test('@scenario:monorepo-deploy a monorepo classified by the real analyser is driven through a build+deploy simulated pass to HEALTHY', async ({
    request,
  }) => {
    test.setTimeout(60_000);
    const suffix = crypto.randomUUID().slice(0, 8);
    await signUp(request, suffix);

    // The application is analysed through the real analyser (no vendor
    // overrides — §35 backfills the detected nested-app container fields), so
    // the manifest the deployment locks in is the genuine monorepo result:
    // app root apps/api, repo-root build context.
    const { applicationId } = await seedAnalysedApplication(request, 'deployz-demo/monorepo', suffix);

    const readiness = await getReadiness(request, applicationId);
    expect(readiness.analysisStatus).toBe('COMPLETE');
    // The classification Phase 7 unit-tests is E2E-real here: ALMOST_READY
    // with the health-check finding only. Phase 5 removed the silent /health
    // default, so the vendor supplies the health path through the override
    // surface; the semantic readiness state is unchanged by the override.
    expect(readiness.state).toBe('ALMOST_READY');
    expect(readiness.findings).toEqual([expect.objectContaining({ id: 'health-check' })]);

    const healthPatch = await request.patch(`${API_URL}/api/applications/${applicationId}`, {
      data: { healthPath: '/health' },
    });
    expect(healthPatch.ok()).toBeTruthy();

    const customerId = await createCustomer(request, suffix);
    const deploymentResponse = await request.post(`${API_URL}/api/deployments`, {
      data: { applicationId, customerId, region: 'us-east-1' },
    });
    expect(deploymentResponse.ok()).toBeTruthy();
    const deployment = (await deploymentResponse.json()) as {
      id: string;
      installLinkId: string;
      enrollmentCode: string;
    };
    const launch = await request.post(`${API_URL}/api/install/${deployment.installLinkId}/launched`, {
      data: {},
    });
    expect(launch.ok()).toBeTruthy();

    // Install + a real DEPLOY_RELEASE settle to HEALTHY with the pointer
    // advanced — the classification result composes all the way through the
    // simulated build+deploy pass.
    const relay = startSimulatedRelay({
      scenario: getScenario('happy-path'),
      apiUrl: API_URL,
      installationId: `inst-${suffix}`,
      enrollmentCode: deployment.enrollmentCode,
      relayToken: `e2e-matrix-relay-${suffix}`,
    });
    try {
      await expect
        .poll(
          async () =>
            ((await request
              .get(`${API_URL}/api/deployments/${deployment.id}`)
              .then((r) => r.json())) as { state: string }).state,
          { timeout: 30_000, message: 'waiting for the monorepo install to reach HEALTHY' },
        )
        .toBe('HEALTHY');

      const releaseResponse = await request.post(`${API_URL}/api/applications/${applicationId}/releases`, {
        data: { version: '1.0.0', gitSha: 'sha-1.0.0' },
      });
      expect(releaseResponse.ok()).toBeTruthy();
      const release = (await releaseResponse.json()) as { id: string };
      const deploy = await request.post(`${API_URL}/api/deployments/${deployment.id}/deploy`, {
        data: { releaseId: release.id },
      });
      expect(deploy.status()).toBe(202);
      await expect
        .poll(
          async () =>
            ((await request
              .get(`${API_URL}/api/deployments/${deployment.id}`)
              .then((r) => r.json())) as { currentReleaseId: string | null }).currentReleaseId,
          { timeout: 20_000, message: 'waiting for the monorepo deploy to advance the release pointer' },
        )
        .toBe(release.id);
      const after = (await request
        .get(`${API_URL}/api/deployments/${deployment.id}`)
        .then((r) => r.json())) as DeploymentResponse;
      expect(after.state).toBe('HEALTHY');
    } finally {
      relay.stop();
    }
  });
});
