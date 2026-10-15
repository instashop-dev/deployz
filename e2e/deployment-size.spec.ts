import { expect, test, type Page } from '@playwright/test';

import { makeApplicationDeployable } from './seed-ready-manifest.js';

// Deployment sizes (docs/infrastructure-profiles.md): the vendor sets a
// default, overrides it on one invitation, and the customer installs a
// different permitted size. The deployment freezes the customer's choice.

const API_URL = `http://localhost:${process.env.API_PORT ?? 3001}`;

async function signUp(page: Page): Promise<void> {
  await page.goto('/sign-up');
  await page.getByLabel('Name').fill('Size Vendor');
  await page.getByLabel('Email').fill(`e2e-size-${crypto.randomUUID().slice(0, 8)}@example.com`);
  await page.getByLabel('Password').fill('super-secret-1');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL('/dashboard');
}

test('the customer installs its chosen size from an invitation with a vendor override', async ({ page }) => {
  test.setTimeout(120_000);
  await signUp(page);
  const suffix = crypto.randomUUID().slice(0, 8);
  const appResponse = await page.request.post(`${API_URL}/api/applications`, {
    data: {
      name: `Size App ${suffix}`,
      githubInstallationId: 'e2e-installation',
      repoFullName: 'deployz-demo/express-api',
      repoUrl: 'https://github.com/deployz-demo/express-api',
      defaultBranch: 'main',
    },
  });
  expect(appResponse.ok()).toBeTruthy();
  const application = (await appResponse.json()) as { id: string };
  expect((await page.request.post(`${API_URL}/api/applications/${application.id}/analyse`, {})).ok()).toBeTruthy();
  await makeApplicationDeployable(page.request, application.id);

  // Vendor: Medium by default, Small allowed; this one customer gets a Large recommendation.
  const sizes = await page.request.patch(`${API_URL}/api/applications/${application.id}`, {
    data: { defaultSizeProfile: 'medium', minimumSizeProfile: 'small' },
  });
  expect(sizes.ok(), await sizes.text()).toBeTruthy();
  const customer = (await page.request
    .post(`${API_URL}/api/customers`, { data: { name: `Size Customer ${suffix}`, email: `size-${suffix}@example.com` } })
    .then((response) => response.json())) as { id: string };
  const invitationResponse = await page.request.post(`${API_URL}/api/customers/${customer.id}/invitations`, {
    data: { applicationId: application.id, recommendedSizeProfile: 'large' },
  });
  expect(invitationResponse.ok()).toBeTruthy();
  const invitation = (await invitationResponse.json()) as { id: string; token: string };

  // Customer: the link's recommendation is preselected and labelled.
  await page.goto(`/install/${invitation.id}#${invitation.token}`);
  const sizeSection = page.locator('section[aria-labelledby="public-size"]');
  await expect(sizeSection).toBeVisible();
  await expect(page.locator('#size-large')).toHaveAttribute('aria-checked', 'true');
  await expect(page.locator('label[for="size-large"]')).toContainText('Vendor recommended');
  await expect(page.locator('#size-small')).toBeVisible();

  await page.locator('section[aria-labelledby="public-region"]').getByRole('combobox').click();
  await page.getByRole('option', { name: 'US East (N. Virginia)' }).click();
  await page.locator('label[for="size-medium"]').click();
  await expect(page.locator('#size-medium')).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByTestId('selected-size')).toContainText('Medium');

  const continueButton = page.getByRole('button', { name: 'Continue to setup' });
  await expect(continueButton).toBeEnabled();
  await continueButton.click();
  await page.waitForURL((url) => /\/install\/[0-9a-f-]{36}$/.test(url.pathname) && !url.pathname.endsWith(invitation.id));

  // The deployment froze the customer's choice, not the recommendation.
  const { deployments } = (await page.request.get(`${API_URL}/api/deployments`).then((response) => response.json())) as {
    deployments: { id: string; customerId: string }[];
  };
  const deployment = deployments.find((row) => row.customerId === customer.id);
  expect(deployment).toBeDefined();
  const detail = (await page.request.get(`${API_URL}/api/deployments/${deployment!.id}`).then((response) => response.json())) as {
    size: { id: string; profileKey: string } | null;
  };
  expect(detail.size).toMatchObject({ id: 'medium', profileKey: 'medium-v1' });

  await page.goto(`/dashboard/deployments/${deployment!.id}`);
  await expect(page.getByTestId('deployment-size-label')).toHaveText('Size: Medium');
});
