/**
 * Playwright test extension for the simulated-infrastructure scenario suite.
 *
 * Mirrors e2e/deployment-progress.spec.ts's and e2e/stack-events.spec.ts's
 * seeding conventions (sign up a vendor, create an application/customer/
 * deployment via the real API), then performs the launched+register
 * handshake and starts a `SimulatedCustomerAccount`-backed relay
 * (./relay-harness.ts) for the chosen scenario — see
 * docs/testing/discovery/phase1-design-decisions.md D1/D2. No browser is
 * needed: every assertion in e2e/scenario-install.spec.ts goes through the
 * real HTTP API, so this fixture only ever uses Playwright's bare
 * `request` (APIRequestContext), never `page`.
 */

import { test as base, type APIRequestContext, type Page } from '@playwright/test';

import { startSimulatedRelay, type SimulatedRelayHandle } from './relay-harness.js';
import { getScenario } from './scenarios/index.js';

export const API_URL = `http://localhost:${process.env.API_PORT ?? 3001}`;

export interface DeployzApi {
  getDeployment(deploymentId: string): Promise<Record<string, unknown>>;
  /** GET /api/install/:installLinkId — the pre-install public page payload
   *  (resourcesCreated, quickCreateUrl, ...), distinct from `getInstallStatus`
   *  below (the lifecycle-derived `/status` projection). Added for the
   *  redis-failure scenario: `resourcesCreated` reflects `applications.
   *  redisRequired` directly, independent of the deployment's current stage —
   *  see e2e/redis.spec.ts's equivalent "will create" assertion. */
  getInstallInfo(installLinkId: string): Promise<Record<string, unknown>>;
  getInstallStatus(installLinkId: string): Promise<Record<string, unknown>>;
  getStackEvents(deploymentId: string): Promise<unknown[]>;
  getInfrastructure(deploymentId: string): Promise<Record<string, unknown>>;
}

export interface DeployzInstall {
  readonly deploymentId: string;
  readonly installLinkId: string;
  readonly installationId: string;
  readonly enrollmentCode: string;
  /** Absent when the test opted out via `deployzStartRelay: false`
   *  (bootstrap-failure — the relay never registers at all). */
  readonly relay: SimulatedRelayHandle | undefined;
  readonly api: DeployzApi;
}

function buildApi(request: APIRequestContext): DeployzApi {
  return {
    async getDeployment(deploymentId) {
      const response = await request.get(`${API_URL}/api/deployments/${deploymentId}`);
      if (!response.ok()) {
        throw new Error(`GET /api/deployments/${deploymentId} -> ${response.status()}`);
      }
      return (await response.json()) as Record<string, unknown>;
    },
    async getInstallInfo(installLinkId) {
      const response = await request.get(`${API_URL}/api/install/${installLinkId}`);
      if (!response.ok()) {
        throw new Error(`GET /api/install/${installLinkId} -> ${response.status()}`);
      }
      return (await response.json()) as Record<string, unknown>;
    },
    async getInstallStatus(installLinkId) {
      const response = await request.get(`${API_URL}/api/install/${installLinkId}/status`);
      if (!response.ok()) {
        throw new Error(`GET /api/install/${installLinkId}/status -> ${response.status()}`);
      }
      return (await response.json()) as Record<string, unknown>;
    },
    async getStackEvents(deploymentId) {
      const response = await request.get(`${API_URL}/api/deployments/${deploymentId}/stack-events`);
      if (!response.ok()) {
        throw new Error(`GET /api/deployments/${deploymentId}/stack-events -> ${response.status()}`);
      }
      const body = (await response.json()) as { events: unknown[] };
      return body.events;
    },
    async getInfrastructure(deploymentId) {
      const response = await request.get(`${API_URL}/api/deployments/${deploymentId}/infrastructure`);
      if (!response.ok()) {
        throw new Error(`GET /api/deployments/${deploymentId}/infrastructure -> ${response.status()}`);
      }
      return (await response.json()) as Record<string, unknown>;
    },
  };
}

async function signUp(request: APIRequestContext, suffix: string): Promise<void> {
  const email = `e2e-scenario-${suffix}@example.com`;
  const response = await request.post(`${API_URL}/api/auth/sign-up/email`, {
    data: { name: `E2E Scenario Vendor ${suffix}`, email, password: 'super-secret-1' },
  });
  if (!response.ok()) {
    throw new Error(`sign-up failed: ${response.status()} ${await response.text()}`);
  }
}

/** Seeds one real application + customer + deployment for the signed-up
 *  org, then performs the customer's "Deploy to AWS" launch signal — mirrors
 *  seedDeployment in e2e/deployment-progress.spec.ts plus the `/launched`
 *  step from e2e/install.spec.ts.
 *
 *  `repoFullName` is an additive option for the redis-failure scenario: when
 *  given, it also drives the REAL analyser (`POST /api/applications/:id/
 *  analyse`) against that GITHUB_FIXTURE_MODE repo — mirroring
 *  e2e/redis.spec.ts's seedAnalysedApplication — so `redisRequired` (and any
 *  other detected metadata) reflects production analysis instead of a
 *  hand-set flag. The analyse call runs inline (no queue configured
 *  locally), so `analysisStatus` is already COMPLETE by the time it
 *  resolves. */
async function seedAndLaunch(
  request: APIRequestContext,
  suffix: string,
  options: { repoFullName?: string } = {},
): Promise<{ deploymentId: string; installLinkId: string; enrollmentCode: string }> {
  const repoFullName = options.repoFullName ?? `deployz-demo/scenario-${suffix}`;
  const appResponse = await request.post(`${API_URL}/api/applications`, {
    data: {
      name: `Scenario App ${suffix}`,
      githubInstallationId: 'e2e-installation',
      repoFullName,
      repoUrl: `https://github.com/${repoFullName}`,
      defaultBranch: 'main',
      databaseRequired: true,
    },
  });
  if (!appResponse.ok()) {
    throw new Error(`create application failed: ${appResponse.status()} ${await appResponse.text()}`);
  }
  const application = (await appResponse.json()) as { id: string };

  if (options.repoFullName) {
    const analyseResponse = await request.post(`${API_URL}/api/applications/${application.id}/analyse`);
    if (!analyseResponse.ok()) {
      throw new Error(`analyse failed: ${analyseResponse.status()} ${await analyseResponse.text()}`);
    }
  }

  // Phase 2 readiness gate: ensure the test fixture application has a
  // manifest that evaluates to READY. The simulated analysis repo fixtures do
  // not carry a real Dockerfile/start command, so override them.
  const patchResponse = await request.patch(`${API_URL}/api/applications/${application.id}`, {
    data: {
      containerPort: 3000,
      healthPath: '/api/health',
      migrationCommand: 'npm run db:migrate',
      appRoot: '.',
      dockerfilePath: 'Dockerfile',
      buildContext: '.',
      buildCommand: 'npm run build',
      startCommand: 'npm start',
    },
  });
  if (!patchResponse.ok()) {
    throw new Error(`patch application failed: ${patchResponse.status()} ${await patchResponse.text()}`);
  }

  const customerResponse = await request.post(`${API_URL}/api/customers`, {
    data: {
      name: `Scenario Customer ${suffix}`,
      email: `scenario-customer-${suffix}@example.com`,
    },
  });
  if (!customerResponse.ok()) {
    throw new Error(`create customer failed: ${customerResponse.status()} ${await customerResponse.text()}`);
  }
  const customer = (await customerResponse.json()) as { id: string };

  const deploymentResponse = await request.post(`${API_URL}/api/deployments`, {
    data: { applicationId: application.id, customerId: customer.id, region: 'us-east-1' },
  });
  if (!deploymentResponse.ok()) {
    throw new Error(`create deployment failed: ${deploymentResponse.status()} ${await deploymentResponse.text()}`);
  }
  const deployment = (await deploymentResponse.json()) as {
    id: string;
    installLinkId: string;
    enrollmentCode: string;
  };

  const launchResponse = await request.post(
    `${API_URL}/api/install/${deployment.installLinkId}/launched`,
    { data: {} },
  );
  if (!launchResponse.ok()) {
    throw new Error(`launch failed: ${launchResponse.status()} ${await launchResponse.text()}`);
  }

  return {
    deploymentId: deployment.id,
    installLinkId: deployment.installLinkId,
    enrollmentCode: deployment.enrollmentCode,
  };
}

/**
 * Browser-driven sign-up for the page-based fixture below — mirrors
 * e2e/deployment-progress.spec.ts's and e2e/fleet.spec.ts's own `signUp(page)`
 * helpers exactly (same fields/labels/flow), rather than the API-only
 * `signUp` above, so the vendor's session cookie is the one the browser
 * actually holds.
 */
async function signUpViaBrowser(page: Page, suffix: string): Promise<void> {
  const email = `e2e-scenario-ui-${suffix}@example.com`;
  await page.goto('/sign-up');
  await page.getByLabel('Name').fill(`E2E Scenario UI Vendor ${suffix}`);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill('super-secret-1');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL('/dashboard');
}

export interface DeployzRelayOptions {
  /** See relay-harness.ts's `StartSimulatedRelayOptions.stopAfterFirstProgress`. */
  readonly stopAfterFirstProgress?: boolean;
  /** See relay-harness.ts's `StartSimulatedRelayOptions.dieDuringDestroy`. */
  readonly dieDuringDestroy?: boolean;
  /** See relay-harness.ts's `StartSimulatedRelayOptions.failConfigureForHostnameRegex`
   *  (Phase 14 custom-domain failure scenarios). */
  readonly failConfigureForHostnameRegex?: string;
}

export const test = base.extend<{
  deployzScenario: string;
  /** Additive option (bootstrap-failure): when false, no relay is ever
   *  started — the deployment never gets past WAITING_FOR_RELAY. */
  deployzStartRelay: boolean;
  /** Additive option (relay-disconnect): extra knobs forwarded verbatim to
   *  `startSimulatedRelay`. */
  deployzRelayOptions: DeployzRelayOptions;
  /** Additive option (redis-failure): when set, the seeded application uses
   *  this GITHUB_FIXTURE_MODE repo and is run through the real analyser
   *  instead of the default synthetic repo name — see `seedAndLaunch`. */
  deployzRepoFullName: string | undefined;
  deployzInstall: DeployzInstall;
  /**
   * Page-based variant of `deployzInstall` for e2e/scenario-ui.spec.ts (Phase
   * E — browser-level UI coverage). Signs the vendor up through the real
   * browser UI (`signUpViaBrowser`, mirroring deployment-progress.spec.ts's
   * `signUp(page)`) instead of the raw API, then seeds the
   * application/customer/deployment and performs launched+register via
   * `page.request` rather than the bare `request` fixture — `seedAndLaunch`
   * and `buildApi` above already take a plain `APIRequestContext`, which
   * `page.request` also is, so no refactor was needed for them to accept it.
   * Using `page.request` (not `request`) is what makes the seeding calls ride
   * the SAME session cookie the browser holds, so the signed-up-in-the-browser
   * org is the one that owns the seeded deployment. Purely additive: the
   * request-based `deployzInstall` above is untouched.
   */
  deployzBrowserInstall: DeployzInstall;
}>({
  // Playwright "option" fixture — settable per file/describe/test with
  // `test.use({ deployzScenario: '...' })`; defaults to the happy path.
  deployzScenario: ['happy-path', { option: true }],
  deployzStartRelay: [true, { option: true }],
  deployzRelayOptions: [{}, { option: true }],
  deployzRepoFullName: [undefined, { option: true }],

  deployzInstall: async (
    { request, deployzScenario, deployzStartRelay, deployzRelayOptions, deployzRepoFullName },
    use,
  ) => {
    const suffix = crypto.randomUUID().slice(0, 8);
    await signUp(request, suffix);
    const { deploymentId, installLinkId, enrollmentCode } = await seedAndLaunch(
      request,
      suffix,
      deployzRepoFullName ? { repoFullName: deployzRepoFullName } : {},
    );

    const installationId = `inst-${suffix}`;
    const relay = deployzStartRelay
      ? startSimulatedRelay({
          scenario: getScenario(deployzScenario),
          apiUrl: API_URL,
          installationId,
          enrollmentCode,
          relayToken: `e2e-scenario-relay-${suffix}`,
          ...deployzRelayOptions,
        })
      : undefined;

    try {
      await use({
        deploymentId,
        installLinkId,
        installationId,
        enrollmentCode,
        relay,
        api: buildApi(request),
      });
    } finally {
      relay?.stop();
    }
  },

  deployzBrowserInstall: async (
    { page, deployzScenario, deployzStartRelay, deployzRelayOptions, deployzRepoFullName },
    use,
  ) => {
    const suffix = crypto.randomUUID().slice(0, 8);
    await signUpViaBrowser(page, suffix);
    const { deploymentId, installLinkId, enrollmentCode } = await seedAndLaunch(
      page.request,
      suffix,
      deployzRepoFullName ? { repoFullName: deployzRepoFullName } : {},
    );

    // Warm the two routes every scenario-ui.spec.ts test hits (the customer
    // install page and the vendor detail page — plus its diagnostics tab)
    // BEFORE starting the timed simulated relay below: Next.js dev compiles
    // each route lazily on first request, which can take several real
    // seconds — long enough to blow through a scenario's whole timeline
    // (e.g. slow-provision's ~3.5s DATABASE_STORAGE window) if that
    // first-ever compile happened to land inside it. Doing it here, before
    // the relay's clock starts, costs fixture setup time but never the
    // scenario's own timing budget.
    await page.goto(`/install/${installLinkId}`);
    await page.goto(`/dashboard/deployments/${deploymentId}`);
    await page.goto(`/dashboard/deployments/${deploymentId}/diagnostics`);

    const installationId = `inst-${suffix}`;
    const relay = deployzStartRelay
      ? startSimulatedRelay({
          scenario: getScenario(deployzScenario),
          apiUrl: API_URL,
          installationId,
          enrollmentCode,
          relayToken: `e2e-scenario-ui-relay-${suffix}`,
          ...deployzRelayOptions,
        })
      : undefined;

    try {
      await use({
        deploymentId,
        installLinkId,
        installationId,
        enrollmentCode,
        relay,
        api: buildApi(page.request),
      });
    } finally {
      relay?.stop();
    }
  },
});

export { expect } from '@playwright/test';
