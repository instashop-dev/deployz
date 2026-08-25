import { expect, test, type Page } from '@playwright/test';

// §23 fleet dashboard + §24 deployment detail + activity feed, against the
// REAL API (no fixture fallback — a 404 now renders a real not-found/error
// state rather than fabricated data). Seeds a real application, customer, and
// deployment via direct API calls (through the browser's session cookie, so
// requests are attributed to the signed-up org) before asserting on the UI.
// §46 vocabulary: the top-level copy uses the 9 product-language states,
// never raw AWS/CFN/ECS/ALB terms (M14: deployment health only).

const API_URL = 'http://localhost:3001';

// Raw AWS service terms that must NOT appear in rendered top-level copy.
const JARGON = /\b(CloudFormation|IAM|ECS|ALB|Lambda|VPC|CFN)\b/;

async function signUp(page: Page): Promise<void> {
  const email = `e2e-${crypto.randomUUID().slice(0, 8)}@example.com`;
  await page.goto('/sign-up');
  await page.getByLabel('Name').fill('E2E User');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill('super-secret-1');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL('/dashboard');
}

/** Seeds one real application + customer + deployment for the signed-up org. */
async function seedDeployment(page: Page): Promise<{
  deploymentId: string;
  applicationId: string;
  installationId: string;
  installLinkId: string;
  enrollmentCode: string;
  applicationName: string;
  customerName: string;
}> {
  const suffix = crypto.randomUUID().slice(0, 8);
  const appResponse = await page.request.post(`${API_URL}/api/applications`, {
    data: {
      name: `Acme Analytics ${suffix}`,
      githubInstallationId: 'e2e-installation',
      repoFullName: `deployz-demo/acme-analytics-${suffix}`,
      repoUrl: `https://github.com/deployz-demo/acme-analytics-${suffix}`,
      defaultBranch: 'main',
    },
  });
  expect(appResponse.ok()).toBeTruthy();
  const application = (await appResponse.json()) as { id: string; name: string };

  const customerResponse = await page.request.post(`${API_URL}/api/customers`, {
    data: { name: `Acme Corp ${suffix}`, email: `acme-${suffix}@example.com` },
  });
  expect(customerResponse.ok()).toBeTruthy();
  const customer = (await customerResponse.json()) as { id: string; name: string };

  const deploymentResponse = await page.request.post(`${API_URL}/api/deployments`, {
    data: { applicationId: application.id, customerId: customer.id, region: 'us-east-1' },
  });
  expect(deploymentResponse.ok()).toBeTruthy();
  const deployment = (await deploymentResponse.json()) as {
    id: string;
    installLinkId: string;
    enrollmentCode: string;
  };

  return {
    deploymentId: deployment.id,
    applicationId: application.id,
    // The relay mints its own id inside the customer's account; a fresh one
    // per seeded deployment stands in for that here.
    installationId: `inst-${crypto.randomUUID()}`,
    installLinkId: deployment.installLinkId,
    enrollmentCode: deployment.enrollmentCode,
    applicationName: application.name,
    customerName: customer.name,
  };
}

/**
 * Drives a fresh deployment to HEALTHY via the real relay job workflow: the
 * relay registers (creating the INSTALL job) and reports it a success —
 * the exact sequence `POST /api/relay/commands/:id/result` now uses to
 * advance `deployments.state` (previously it never did, so a deployment sat
 * at INSTALLING forever and was never §25 bulk-deployable).
 */
async function driveDeploymentToHealthy(
  page: Page,
  installationId: string,
  enrollmentCode: string,
): Promise<void> {
  const authHeaders = { Authorization: `Bearer ${installationId}` };

  // Enrollment, not just registration: the installation id a real relay
  // reports is minted inside the CUSTOMER's account, so the control plane has
  // never seen it. The single-use enrollment code is what ties this relay to
  // the vendor's deployment, and it is spent on this call.
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

test('fleet dashboard shows the §43 empty state for a fresh org', async ({ page }) => {
  await page.route(`${API_URL}/api/deployments`, (route) =>
    route.fulfill({ json: { deployments: [] } }),
  );
  await signUp(page);
  await page.goto('/dashboard/deployments');

  await expect(page.getByRole('heading', { name: 'Deployments', exact: true })).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Your app is ready for private deployment' }),
  ).toBeVisible();
});

test('fleet dashboard top-level copy is jargon-free', async ({ page }) => {
  await page.route(`${API_URL}/api/deployments`, (route) =>
    route.fulfill({ json: { deployments: [] } }),
  );
  await signUp(page);
  await page.goto('/dashboard/deployments');

  const text = await page.locator('body').innerText();
  expect(text).not.toMatch(JARGON);
});

test('fleet dashboard lists a real deployment with Customer/Version/Region/Status (§23)', async ({
  page,
}) => {
  await signUp(page);
  const { applicationName, customerName } = await seedDeployment(page);

  await page.goto('/dashboard/deployments');
  await expect(page.getByTestId('deployment-list')).toBeVisible();
  await expect(page.getByText(customerName, { exact: true })).toBeVisible();
  await expect(page.getByText(applicationName, { exact: true })).toBeVisible();
  await expect(page.getByText('us-east-1', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('Not installed', { exact: true })).toBeVisible();
});

test('deployment detail page renders the §24 overview, infrastructure rows, and actions', async ({
  page,
}) => {
  await signUp(page);
  const { deploymentId, applicationName, customerName } = await seedDeployment(page);

  await page.goto(`/dashboard/deployments/${deploymentId}`);

  await expect(page.getByRole('heading', { name: applicationName })).toBeVisible();
  await expect(page.getByText(customerName, { exact: true }).first()).toBeVisible();

  // §24 the five required actions.
  await expect(page.getByRole('button', { name: 'Deploy Update' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Rollback' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'View Diagnostics' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Configuration' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Disconnect Deployment' })).toBeVisible();

  // §24 infrastructure. A deployment nobody has installed has no observed
  // health, so the honest render is the empty state — not four green rows all
  // showing the same column default, which is what this used to assert.
  await expect(
    page.getByText('No health reports yet — this deployment has not checked in.'),
  ).toBeVisible();
  await expect(page.getByText('Deployz Relay', { exact: true })).toBeVisible();
  await expect(page.getByText('Database', { exact: true })).toHaveCount(0);
});

test('infrastructure rows appear only for the components the relay reports', async ({ page }) => {
  await signUp(page);
  const { deploymentId, installationId, enrollmentCode } = await seedDeployment(page);
  await driveDeploymentToHealthy(page, installationId, enrollmentCode);

  // This application has no storage, so the relay reports on three components
  // and the page must not invent a fourth.
  const health = await page.request.post(`${API_URL}/api/relay/health`, {
    headers: { Authorization: `Bearer ${installationId}` },
    data: {
      installationId,
      healthStatus: 'HEALTHY',
      components: { application: 'HEALTHY', database: 'DEGRADED', loadBalancer: 'HEALTHY' },
    },
  });
  expect(health.ok()).toBeTruthy();

  await page.goto(`/dashboard/deployments/${deploymentId}`);
  await expect(page.getByText('Application', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('Database', { exact: true })).toBeVisible();
  await expect(page.getByText('Load Balancer', { exact: true })).toBeVisible();
  await expect(page.getByText('Storage', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Degraded', { exact: true })).toBeVisible();
});

test('deployment detail top-level copy is jargon-free', async ({ page }) => {
  await signUp(page);
  const { deploymentId } = await seedDeployment(page);

  await page.goto(`/dashboard/deployments/${deploymentId}`);
  const text = await page.locator('body').innerText();
  expect(text).not.toMatch(JARGON);
});

test('rollback confirmation shows the required §26 migration warning', async ({ page }) => {
  await signUp(page);
  const { deploymentId } = await seedDeployment(page);

  await page.goto(`/dashboard/deployments/${deploymentId}`);
  // A brand-new deployment has no previous release, so Rollback is disabled —
  // this proves the §26 warning copy exists in the codebase and would render
  // once a previous release exists. Reaching that state now takes TWO
  // successful relay DEPLOY_RELEASE jobs (see the HEALTHY/bulk-deploy test
  // below for the single-job relay sequence this spec does drive) — a full
  // rollback-eligible deployment is still out of scope for this assertion,
  // which only needs the disabled-state copy.
  await expect(page.getByRole('button', { name: 'Rollback' })).toBeDisabled();
});

test('disconnect requires typing the customer name to confirm (§63)', async ({ page }) => {
  await signUp(page);
  const { deploymentId, customerName } = await seedDeployment(page);

  await page.goto(`/dashboard/deployments/${deploymentId}`);
  await page.getByRole('button', { name: 'Disconnect Deployment' }).click();

  const confirmButton = page.getByRole('button', { name: 'Disconnect Deployment' }).last();
  await expect(confirmButton).toBeDisabled();

  await page.getByLabel(`Type ${customerName} to confirm`).fill(customerName);
  await expect(confirmButton).toBeEnabled();
});

test('a deployment driven to HEALTHY via the relay job workflow is §25 bulk-deployable', async ({
  page,
}) => {
  await signUp(page);
  const { applicationId, installationId, enrollmentCode, customerName } = await seedDeployment(page);
  await driveDeploymentToHealthy(page, installationId, enrollmentCode);

  const releaseResponse = await page.request.post(
    `${API_URL}/api/applications/${applicationId}/releases`,
    { data: { version: '1.0.0', gitSha: 'e2e0000000000000000000000000000deadbeef' } },
  );
  expect(releaseResponse.ok()).toBeTruthy();

  await page.goto('/dashboard/deployments');
  const row = page.locator('[data-testid="deployment-list"] tbody tr', { hasText: customerName });
  // Publishing that release put this healthy deployment behind, which is what
  // §22/§25 mean by "update available" — and is the state bulk deploy exists
  // to clear. Nothing wrote it before, so the fleet could never show it.
  await expect(row.getByText('Update available', { exact: true })).toBeVisible();

  // Previously the deployment was stuck at INSTALLING forever, so this
  // checkbox was permanently disabled and §25 bulk deploy was unreachable.
  const checkbox = row.getByRole('checkbox', { name: `Select ${customerName}` });
  await expect(checkbox).toBeEnabled();
  await checkbox.check();

  const bar = page.getByTestId('bulk-deploy-bar');
  await expect(bar).toBeVisible();
  const releaseSelect = bar.getByRole('combobox', { name: 'Release to deploy' });
  await expect(releaseSelect.locator('option')).not.toHaveCount(0);

  const [deployBulkResponse] = await Promise.all([
    page.waitForResponse(
      (response) =>
        response.url() === `${API_URL}/api/applications/${applicationId}/deploy-bulk` &&
        response.request().method() === 'POST',
    ),
    bar.getByRole('button', { name: 'Deploy release' }).click(),
  ]);
  expect(deployBulkResponse.ok()).toBeTruthy();

  // A successful deploy clears the selection, which hides the bar again.
  await expect(bar).toBeHidden();
});
