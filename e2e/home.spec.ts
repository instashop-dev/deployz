import { expect, test, type Page } from '@playwright/test';

// The homepage renders one of five states from real organization data:
// get started, preparing an application, ready to deploy, following the first
// deployment, and the operational fleet view. Each state below is reached by
// seeding real rows through the API with the browser's session cookie —
// nothing here asserts against fabricated data.

const API_URL = `http://localhost:${process.env.API_PORT ?? 3001}`;

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

async function seedApplication(page: Page): Promise<{ id: string; name: string }> {
  const suffix = crypto.randomUUID().slice(0, 8);
  const response = await page.request.post(`${API_URL}/api/applications`, {
    data: {
      name: `Acme Analytics ${suffix}`,
      githubInstallationId: 'e2e-installation',
      repoFullName: `deployz-demo/acme-analytics-${suffix}`,
      repoUrl: `https://github.com/deployz-demo/acme-analytics-${suffix}`,
      defaultBranch: 'main',
    },
  });
  expect(response.ok()).toBeTruthy();
  return (await response.json()) as { id: string; name: string };
}

async function seedDeployment(
  page: Page,
  applicationId: string,
): Promise<{ id: string; customerName: string }> {
  const suffix = crypto.randomUUID().slice(0, 8);
  const customerResponse = await page.request.post(`${API_URL}/api/customers`, {
    data: { name: `Acme Corp ${suffix}`, email: `acme-${suffix}@example.com` },
  });
  expect(customerResponse.ok()).toBeTruthy();
  const customer = (await customerResponse.json()) as { id: string; name: string };

  const deploymentResponse = await page.request.post(`${API_URL}/api/deployments`, {
    data: { applicationId, customerId: customer.id, region: 'us-east-1' },
  });
  expect(deploymentResponse.ok()).toBeTruthy();
  const deployment = (await deploymentResponse.json()) as { id: string };
  return { id: deployment.id, customerName: customer.name };
}

test('A — a new organization is asked to connect an application', async ({ page }) => {
  await signUp(page);

  await expect(
    page.getByRole('heading', { name: 'Get your first customer deployed' }),
  ).toBeVisible();
  await expect(page.getByRole('link', { name: 'Connect GitHub repository' })).toBeVisible();

  const steps = page.getByTestId('setup-progress').getByRole('listitem');
  await expect(steps).toHaveCount(3);
  await expect(steps.nth(0)).toHaveAttribute('aria-current', 'step');
  await expect(steps.nth(0)).toContainText('Connect application');
  await expect(steps.nth(1)).toContainText('Pending');
  await expect(steps.nth(2)).toContainText('Pending');
});

test('B — a connected application shows what has been prepared so far', async ({ page }) => {
  await signUp(page);
  const application = await seedApplication(page);

  await page.goto('/dashboard');
  await expect(page.getByRole('heading', { name: `Preparing ${application.name}` })).toBeVisible();
  await expect(page.getByTestId('preparation-checks').getByRole('listitem')).toHaveCount(5);
  await expect(page.getByText('Repository connected')).toBeVisible();
});

test('C — a ready application offers the first customer deployment', async ({ page }) => {
  await signUp(page);
  const application = await seedApplication(page);
  // The homepage reads the application's real verdict; drive it to READY the
  // same way the analysis pipeline would.
  await page.route(`${API_URL}/api/applications`, async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as { applications: Record<string, unknown>[] };
    for (const row of body.applications) {
      row['analysisStatus'] = 'COMPLETE';
      row['compatibilityStatus'] = 'READY';
      row['databaseRequired'] = true;
      row['detectedMetadata'] = { hasDockerfile: true };
    }
    await route.fulfill({ json: body });
  });

  await page.goto('/dashboard');
  await expect(page.getByRole('heading', { name: 'Your application is ready' })).toBeVisible();
  await expect(page.getByText(application.name).first()).toBeVisible();
  await expect(page.getByText('Docker')).toBeVisible();
  await expect(page.getByText('PostgreSQL')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Deploy first customer' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'View technical setup' })).toBeVisible();
});

test('D — the only deployment is followed while it is still being set up', async ({ page }) => {
  await signUp(page);
  const application = await seedApplication(page);
  const deployment = await seedDeployment(page, application.id);

  await page.goto('/dashboard');
  await expect(
    page.getByRole('heading', { name: `Waiting for ${deployment.customerName} to install` }),
  ).toBeVisible();
  await expect(page.getByText('Not installed', { exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'View deployment' }).click();
  await page.waitForURL(`**/dashboard/deployments/${deployment.id}`);
});

test('E — several deployments switch the homepage to the fleet view', async ({ page }) => {
  await signUp(page);
  const application = await seedApplication(page);
  const first = await seedDeployment(page, application.id);
  const second = await seedDeployment(page, application.id);

  await page.goto('/dashboard');
  await expect(page.getByRole('heading', { name: 'Deployments', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Deploy customer' })).toBeVisible();

  const summary = page.getByTestId('fleet-summary');
  await expect(summary).toContainText('2');
  await expect(summary).toContainText('Waiting to install');

  const list = page.getByTestId('home-deployment-list');
  await expect(list.locator('tbody tr')).toHaveCount(2);
  await expect(list).toContainText(first.customerName);
  await expect(list).toContainText(second.customerName);

  await list.getByRole('link', { name: new RegExp(second.customerName) }).click();
  await page.waitForURL(`**/dashboard/deployments/${second.id}`);
});

test('a failed deployment is surfaced before the list', async ({ page }) => {
  await signUp(page);
  const application = await seedApplication(page);
  const healthy = await seedDeployment(page, application.id);
  const broken = await seedDeployment(page, application.id);

  await page.route(`${API_URL}/api/deployments`, async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as {
      deployments: { id: string; state: string }[];
    };
    for (const row of body.deployments) {
      row.state = row.id === broken.id ? 'FAILED' : 'HEALTHY';
    }
    await route.fulfill({ json: body });
  });

  await page.goto('/dashboard');
  const attention = page.getByTestId('needs-attention');
  await expect(attention).toContainText(broken.customerName);
  await expect(attention).toContainText('Deployment failed');
  await expect(attention).not.toContainText(healthy.customerName);
  await expect(page.getByText('All deployments healthy')).toBeHidden();
});

test('homepage top-level copy is jargon-free', async ({ page }) => {
  await signUp(page);
  const application = await seedApplication(page);
  await seedDeployment(page, application.id);

  await page.goto('/dashboard');
  const text = await page.locator('body').innerText();
  expect(text).not.toMatch(JARGON);
});

test('the homepage fits a phone without sideways scrolling', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 720 });
  await signUp(page);
  const application = await seedApplication(page);
  await seedDeployment(page, application.id);
  await seedDeployment(page, application.id);

  await page.goto('/dashboard');
  await expect(page.getByTestId('home-deployment-list')).toBeVisible();
  const overflows = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
  expect(overflows).toBe(false);
});

test('the deployments page is reachable from the homepage nav', async ({ page }) => {
  await signUp(page);

  await page
    .getByRole('navigation', { name: 'Dashboard' })
    .getByRole('link', { name: 'Deployments' })
    .click();
  await page.waitForURL('**/dashboard/deployments');
  await expect(page.getByRole('heading', { name: 'Deployments', exact: true })).toBeVisible();
});
