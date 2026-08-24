import { expect, test, type Page } from '@playwright/test';

// Diagnostics surface, against the REAL `GET /api/deployments/:id/diagnostics`
// endpoint (previously pointed nowhere real and always rendered fixture
// cards). That endpoint only returns a classification once a deployment's
// state is FAILED. `POST /api/relay/commands/:id/result` now actually
// advances `deployments.state` (previously it never did, so a deployment sat
// at INSTALLING forever and FAILED was unreachable) — so this spec drives a
// real deployment through the relay job workflow to FAILED and asserts the
// real classification, plus proves the "no issues" path (a deployment that
// hasn't failed) end to end and the page linking from deployment detail.

const JARGON = /\b(CloudFormation|IAM|ECS|ALB|Lambda|VPC|CFN|RDS)\b/;
const API_URL = 'http://localhost:3001';

async function signUp(page: Page): Promise<void> {
  const email = `e2e-${crypto.randomUUID().slice(0, 8)}@example.com`;
  await page.goto('/sign-up');
  await page.getByLabel('Name').fill('E2E User');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill('super-secret-1');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL('/dashboard');
}

async function seedDeployment(
  page: Page,
): Promise<{
  deploymentId: string;
  applicationId: string;
  installationId: string;
  installLinkId: string;
  enrollmentCode: string;
}> {
  const suffix = crypto.randomUUID().slice(0, 8);
  const appResponse = await page.request.post(`${API_URL}/api/applications`, {
    data: {
      name: `Globex Portal ${suffix}`,
      githubInstallationId: 'e2e-installation',
      repoFullName: `deployz-demo/globex-portal-${suffix}`,
      repoUrl: `https://github.com/deployz-demo/globex-portal-${suffix}`,
      defaultBranch: 'main',
    },
  });
  const application = (await appResponse.json()) as { id: string };

  const customerResponse = await page.request.post(`${API_URL}/api/customers`, {
    data: { name: `Globex Inc ${suffix}`, email: `globex-${suffix}@example.com` },
  });
  const customer = (await customerResponse.json()) as { id: string };

  const deploymentResponse = await page.request.post(`${API_URL}/api/deployments`, {
    data: { applicationId: application.id, customerId: customer.id, region: 'us-east-1' },
  });
  const deployment = (await deploymentResponse.json()) as {
    id: string;
    installLinkId: string;
    enrollmentCode: string;
  };
  return {
    deploymentId: deployment.id,
    applicationId: application.id,
    // The relay mints its own id; a fresh one per seeded deployment.
    installationId: `inst-${crypto.randomUUID()}`,
    installLinkId: deployment.installLinkId,
    enrollmentCode: deployment.enrollmentCode,
  };
}

/**
 * Drives a fresh deployment to FAILED via the real relay job workflow: the
 * relay registers (creating the INSTALL job), reports it a success (the
 * deployment goes HEALTHY), then a real release is deployed and reported
 * back as a failure — the exact sequence `POST
 * /api/relay/commands/:id/result` now uses to advance `deployments.state`.
 */
async function driveDeploymentToFailed(
  page: Page,
  applicationId: string,
  deploymentId: string,
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

  const installCommands = (await (
    await page.request.get(`${API_URL}/api/relay/commands?installationId=${installationId}`, {
      headers: authHeaders,
    })
  ).json()) as { commands: { id: string; type: string }[] };
  const installJob = installCommands.commands.find((command) => command.type === 'INSTALL');
  expect(installJob).toBeDefined();

  const installResultResponse = await page.request.post(
    `${API_URL}/api/relay/commands/${installJob!.id}/result`,
    { headers: authHeaders, data: { success: true } },
  );
  expect(installResultResponse.ok()).toBeTruthy();

  const releaseResponse = await page.request.post(
    `${API_URL}/api/applications/${applicationId}/releases`,
    { data: { version: '1.0.0', gitSha: 'e2e0000000000000000000000000000deadbeef' } },
  );
  expect(releaseResponse.ok()).toBeTruthy();
  const release = (await releaseResponse.json()) as { id: string };

  const deployResponse = await page.request.post(`${API_URL}/api/deployments/${deploymentId}/deploy`, {
    data: { releaseId: release.id },
  });
  expect(deployResponse.ok()).toBeTruthy();

  const deployCommands = (await (
    await page.request.get(`${API_URL}/api/relay/commands?installationId=${installationId}`, {
      headers: authHeaders,
    })
  ).json()) as { commands: { id: string; type: string }[] };
  const deployJob = deployCommands.commands.find((command) => command.type === 'DEPLOY_RELEASE');
  expect(deployJob).toBeDefined();

  const deployResultResponse = await page.request.post(
    `${API_URL}/api/relay/commands/${deployJob!.id}/result`,
    {
      headers: authHeaders,
      data: {
        success: false,
        error: 'Container failed the health check',
        failureCode: 'HEALTH_CHECK_FAILED',
      },
    },
  );
  expect(deployResultResponse.ok()).toBeTruthy();
}

test('detail page links to diagnostics and a non-failed deployment shows the no-issues state', async ({
  page,
}) => {
  await signUp(page);
  const { deploymentId } = await seedDeployment(page);

  await page.goto(`/dashboard/deployments/${deploymentId}`);
  await page.getByRole('link', { name: 'View Diagnostics' }).click();
  await page.waitForURL(`**/dashboard/deployments/${deploymentId}/diagnostics`);

  await expect(page.getByRole('heading', { name: 'Diagnostics', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'No issues found', exact: true })).toBeVisible();
  await expect(
    page.getByText('This deployment is healthy, so there is nothing to diagnose.'),
  ).toBeVisible();
});

test('diagnostics top-level copy is jargon-free', async ({ page }) => {
  await signUp(page);
  const { deploymentId } = await seedDeployment(page);

  await page.goto(`/dashboard/deployments/${deploymentId}/diagnostics`);
  const text = await page.locator('body').innerText();
  expect(text).not.toMatch(JARGON);
});

test('a deployment failed via the relay job workflow shows a real §29 classification', async ({
  page,
}) => {
  await signUp(page);
  const { deploymentId, applicationId, installationId, enrollmentCode } = await seedDeployment(page);
  await driveDeploymentToFailed(page, applicationId, deploymentId, installationId, enrollmentCode);

  await page.goto(`/dashboard/deployments/${deploymentId}/diagnostics`);

  await expect(page.getByRole('heading', { name: 'Diagnostics', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'No issues found' })).toHaveCount(0);

  const card = page.getByTestId('diagnostic-card');
  await expect(card).toBeVisible();
  await expect(card.getByText('What happened')).toBeVisible();
  await expect(card.getByText('Why it happened')).toBeVisible();
  await expect(card.getByText('How to fix it')).toBeVisible();

  // §65: still jargon-free on the failed path, not just the "no issues" path.
  const text = await page.locator('body').innerText();
  expect(text).not.toMatch(JARGON);
});
