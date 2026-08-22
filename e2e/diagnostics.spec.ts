import { expect, test, type Page } from '@playwright/test';

// Diagnostics surface, against the REAL `GET /api/deployments/:id/diagnostics`
// endpoint (previously pointed nowhere real and always rendered fixture
// cards). That endpoint only returns a classification once a deployment's
// state is FAILED, which is set by a relay/job workflow outside what a
// freshly-seeded deployment can reach in this spec — so this spec proves the
// real "no issues" path (a deployment that hasn't failed) end to end, plus
// the page linking from deployment detail. The what/why/fix card rendering
// itself is covered by DiagnosticCard's own fixture-free presentation logic.

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

async function seedDeployment(page: Page): Promise<string> {
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
  const deployment = (await deploymentResponse.json()) as { id: string };
  return deployment.id;
}

test('detail page links to diagnostics and a non-failed deployment shows the no-issues state', async ({
  page,
}) => {
  await signUp(page);
  const deploymentId = await seedDeployment(page);

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
  const deploymentId = await seedDeployment(page);

  await page.goto(`/dashboard/deployments/${deploymentId}/diagnostics`);
  const text = await page.locator('body').innerText();
  expect(text).not.toMatch(JARGON);
});
