import { expect, test, type Page } from '@playwright/test';

// Redis Support MVP (tasks 1-9): §7 Redis detection + §8 the managed,
// automatic-provisioning path for supported Redis usage. Fixture mode (Task
// 5) ships two purpose-built fixture repos alongside the existing
// deployz-demo/express-api: `bullmq-worker` (fixture-repo-3) is otherwise
// READY-shaped with a direct BullMQ dependency — a supported, high-confidence
// Redis requirement that should analyse as ready with the "Redis detected —
// provisioned automatically on install" passed check, then carry a Redis
// cache through resourcesCreated and the deployment's Infrastructure section.
// `legacy-redis` (fixture-repo-2) depends on Redis Stack modules
// (@redis/json), which fall outside Deployz's managed Redis profile and must
// still hard-reject with "Your app uses Redis features Deployz can't
// provide" (§10). Mirrors
// the signUp/seed-via-page.request conventions of custom-domain.spec.ts and
// the real-analyser conventions of readiness.spec.ts (no fabricated verdicts
// — analysis runs for real against GITHUB_FIXTURE_MODE's fixture file trees).

const API_URL = `http://localhost:${process.env.API_PORT ?? 3001}`;

async function signUp(page: Page): Promise<void> {
  const email = `e2e-redis-${crypto.randomUUID().slice(0, 8)}@example.com`;
  await page.goto('/sign-up');
  await page.getByLabel('Name').fill('E2E Redis Vendor');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill('super-secret-1');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL('/dashboard');
}

/**
 * Creates a real Application from a fixture repo's `fullName` and triggers
 * analysis, exactly as choosing a repo on /dashboard/applications would
 * (RepoRow.onChoose in apps/web). `POST /:id/analyse` runs the real
 * deterministic analyser inline (no queue configured locally), so by the time
 * this resolves `analysisStatus` is already COMPLETE — mirrors the
 * near-instant fixture-mode analysis readiness.spec.ts relies on.
 */
async function seedAnalysedApplication(
  page: Page,
  repoFullName: string,
  suffix: string,
): Promise<{ applicationId: string }> {
  const appResponse = await page.request.post(`${API_URL}/api/applications`, {
    data: {
      name: `Redis Test ${suffix}`,
      githubInstallationId: 'e2e-installation',
      repoFullName,
      repoUrl: `https://github.com/${repoFullName}`,
      defaultBranch: 'main',
    },
  });
  expect(appResponse.ok()).toBeTruthy();
  const application = (await appResponse.json()) as { id: string };

  const analyseResponse = await page.request.post(
    `${API_URL}/api/applications/${application.id}/analyse`,
  );
  expect(analyseResponse.ok()).toBeTruthy();

  return { applicationId: application.id };
}

async function seedCustomerAndDeployment(
  page: Page,
  applicationId: string,
  suffix: string,
): Promise<{ deploymentId: string; installLinkId: string; installationId: string; enrollmentCode: string }> {
  const customerResponse = await page.request.post(`${API_URL}/api/customers`, {
    data: { name: `Redis Customer ${suffix}`, email: `redis-customer-${suffix}@example.com` },
  });
  expect(customerResponse.ok()).toBeTruthy();
  const customer = (await customerResponse.json()) as { id: string };

  const deploymentResponse = await page.request.post(`${API_URL}/api/deployments`, {
    data: { applicationId, customerId: customer.id, region: 'us-east-1' },
  });
  expect(deploymentResponse.ok()).toBeTruthy();
  const deployment = (await deploymentResponse.json()) as {
    id: string;
    installLinkId: string;
    enrollmentCode: string;
  };

  return {
    deploymentId: deployment.id,
    installLinkId: deployment.installLinkId,
    installationId: `inst-${suffix}`,
    enrollmentCode: deployment.enrollmentCode,
  };
}

/**
 * Drives a fresh deployment to HEALTHY via the real relay job workflow —
 * mirrors fleet.spec.ts's `driveDeploymentToHealthy`. The Infrastructure
 * section (including the Redis row) only renders once the deployment is past
 * the pre-install states (see `showInfrastructureRows` in
 * apps/web/src/lib/deployment-vocabulary.ts), so a deployment that was never
 * installed shows the section's empty state instead — no Redis row to find.
 */
async function driveDeploymentToHealthy(
  page: Page,
  installationId: string,
  enrollmentCode: string,
): Promise<void> {
  const authHeaders = { Authorization: `Bearer ${installationId}` };
  const registerResponse = await page.request.post(`${API_URL}/api/relay/register`, {
    headers: authHeaders,
    data: { installationId, enrollmentCode },
  });
  expect(registerResponse.ok()).toBeTruthy();

  const commandsResponse = await page.request.get(
    `${API_URL}/api/relay/commands?installationId=${installationId}`,
    { headers: authHeaders },
  );
  const { commands } = (await commandsResponse.json()) as { commands: { id: string; type: string }[] };
  const installJob = commands.find((command) => command.type === 'INSTALL');
  expect(installJob).toBeDefined();

  const resultResponse = await page.request.post(
    `${API_URL}/api/relay/commands/${installJob!.id}/result`,
    { headers: authHeaders, data: { success: true } },
  );
  expect(resultResponse.ok()).toBeTruthy();
}

test('bullmq-worker: analyses as ready with the managed Redis passed check, then carries a Redis cache through install + deployment detail', async ({
  page,
}) => {
  const suffix = crypto.randomUUID().slice(0, 8);

  // ── 1. Sign up, connect the fixture org (implicit — fixture mode serves
  // it), select bullmq-worker, and trigger analysis.
  await signUp(page);
  const { applicationId } = await seedAnalysedApplication(
    page,
    'deployz-demo/bullmq-worker',
    suffix,
  );

  // ── 2. Readiness UI: the app is deployable, and the Redis check is visible
  // in the collapsed Passed checks group — never a fabricated verdict, this
  // is the real §18/§19 analyser run against the fixture file tree.
  await page.goto(`/dashboard/applications/${applicationId}`);
  await expect(page.getByTestId('readiness-verdict')).toBeVisible();
  await expect(page.getByText('Ready to deploy')).toBeVisible();
  // bullmq usage with no resolved worker start script is a recommended
  // finding ("Background job runner") — recommended findings never block
  // READY (packages/analysis/src/readiness-report.ts), so the state reads as
  // all required checks passed and the finding renders as a recommendation.
  await expect(page.getByTestId('readiness-summary')).toHaveText(
    'Your application passed all required deployment checks.',
  );
  await expect(
    page
      .getByTestId('readiness-recommended-list')
      .getByText('Background job runner', { exact: true }),
  ).toBeVisible();
  // Short passed lists render inline; longer ones collapse behind a count.
  const passedGroup = page.getByTestId('readiness-passed');
  const passedSummary = passedGroup.locator('summary');
  if ((await passedSummary.count()) > 0) {
    await passedSummary.click();
  }
  // Copy per packages/analysis/src/readiness-report.ts's PASSED_LABELS.redis.
  await expect(
    passedGroup.getByText('Redis detected — provisioned automatically on install', {
      exact: true,
    }),
  ).toBeVisible();

  // ── 3. Create a customer + deployment for this application, then open the
  // install link page: the "Deployz will create" list includes a Redis cache
  // because this application's analysed `redisRequired` is true.
  const { deploymentId, installLinkId, installationId, enrollmentCode } =
    await seedCustomerAndDeployment(page, applicationId, suffix);
  await page.goto(`/install/${installLinkId}`);
  const willCreateSection = page.locator('section[aria-labelledby="will-create"]');
  await expect(willCreateSection.getByRole('listitem').getByText('Redis cache', { exact: true })).toBeVisible();

  // ── 4. Deployment detail: the Infrastructure section lists the cache
  // component. That section renders from the persisted resource inventory
  // (§59, apps/web/src/components/infrastructure-section.tsx), not from the
  // `components` health map — so a Redis row only appears once the relay's
  // ListStackResources read (including the ElastiCache replication group) is
  // persisted via persistDeploymentResourceSnapshot
  // (packages/db/src/deployment-resources-persist.ts). It also only renders
  // once the deployment is past the pre-install states (see
  // `showInfrastructureRows`), so drive a real install through the relay job
  // workflow first — the same sequence fleet.spec.ts's
  // `driveDeploymentToHealthy` uses — then report the inventory.
  await driveDeploymentToHealthy(page, installationId, enrollmentCode);
  const health = await page.request.post(`${API_URL}/api/relay/health`, {
    headers: { Authorization: `Bearer ${installationId}` },
    data: {
      installationId,
      healthStatus: 'HEALTHY',
      observedState: {
        infraHealth: {
          inventory: {
            stackId: `arn:aws:cloudformation:us-east-1:123456789012:stack/e2e-redis-${suffix}/${crypto.randomUUID()}`,
            observedAt: new Date().toISOString(),
            resources: [
              {
                logicalId: 'Service',
                type: 'AWS::ECS::Service',
                status: 'CREATE_COMPLETE',
                physicalId: 'arn:aws:ecs:us-east-1:123456789012:service/e2e-redis-app',
              },
              {
                logicalId: 'RedisCache',
                type: 'AWS::ElastiCache::ReplicationGroup',
                status: 'CREATE_COMPLETE',
                physicalId: `redis-${suffix}`,
              },
            ],
          },
        },
      },
    },
  });
  expect(health.ok()).toBeTruthy();

  await page.goto(`/dashboard/deployments/${deploymentId}`);
  const infraSection = page.locator('section[aria-labelledby="infrastructure"]');
  await expect(infraSection.getByText('Cache', { exact: true })).toBeVisible();
});

test('legacy-redis: analyses as unsupported — "Your app uses Redis features Deployz can\'t provide"', async ({
  page,
}) => {
  const suffix = crypto.randomUUID().slice(0, 8);

  await signUp(page);
  const { applicationId } = await seedAnalysedApplication(
    page,
    'deployz-demo/legacy-redis',
    suffix,
  );

  await page.goto(`/dashboard/applications/${applicationId}`);
  await expect(page.getByTestId('readiness-verdict')).toBeVisible();
  // The unsupported Redis setup is a blocking rejection, so the state is
  // NEEDS_CHANGES (packages/analysis/src/readiness-report.ts's REDIS_COPY)
  // and the heading reads out the blocking change count.
  await expect(
    page.getByRole('heading', { name: /needed before deployment/ }),
  ).toBeVisible();
  const requiredList = page.getByTestId('readiness-required-list');
  await expect(
    requiredList.getByText("Your app uses Redis features Deployz can't provide", { exact: true }),
  ).toBeVisible();
});
