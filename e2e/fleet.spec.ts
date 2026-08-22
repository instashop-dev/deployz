import { expect, test, type Page } from '@playwright/test';

// Todo 19 — fleet dashboard + deployment detail + activity feed. The
// deployments API now exists and returns real data; a fresh org sees the
// empty state. Deployment detail pages for fixture (non-UUID) ids still
// fall back to fixture data on the 404 the API correctly returns for them.
// §46 vocabulary: the top-level copy uses the 9 product-language states,
// never raw AWS/CFN/ECS/ALB terms (M14: deployment health only).

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

test('fleet dashboard shows the empty state for a fresh org', async ({ page }) => {
  await signUp(page);

  await expect(page.getByRole('heading', { name: 'Deployments', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'No deployments yet' })).toBeVisible();
});

test('fleet dashboard top-level copy is jargon-free', async ({ page }) => {
  await signUp(page);

  const text = await page.locator('body').innerText();
  expect(text).not.toMatch(JARGON);
});

test('deployment detail page renders fixture data + health signals', async ({ page }) => {
  await signUp(page);

  await page.goto('/dashboard/deployments/deployment-acme-analytics');

  await expect(page.getByRole('heading', { name: 'Acme Analytics' })).toBeVisible();
  await expect(page.getByText('Healthy', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('Acme Corp', { exact: true })).toBeVisible();
  await expect(page.getByText('us-east-1', { exact: true })).toBeVisible();
  await expect(page.getByText('runtime-v1', { exact: true })).toBeVisible();

  await expect(page.getByText('Infrastructure').first()).toBeVisible();
  await expect(page.getByText('Traffic').first()).toBeVisible();
  await expect(page.getByText('Database').first()).toBeVisible();
  await expect(page.getByText('Capacity').first()).toBeVisible();
});

test('deployment detail top-level copy is jargon-free (technical detail collapsed)', async ({ page }) => {
  await signUp(page);

  await page.goto('/dashboard/deployments/deployment-globex-portal');

  const text = await page.locator('body').innerText();
  expect(text).not.toMatch(JARGON);
});

test('activity feed shows the deployment event timeline', async ({ page }) => {
  await signUp(page);

  await page.goto('/dashboard/deployments/deployment-acme-analytics');

  await expect(page.getByRole('heading', { name: 'Activity' })).toBeVisible();

  await expect(page.getByText('Installed and healthy', { exact: true })).toBeVisible();
  await expect(page.getByText('Update started', { exact: true })).toBeVisible();
  await expect(page.getByText('Update complete', { exact: true })).toBeVisible();

  const text = await page.locator('body').innerText();
  expect(text).not.toMatch(JARGON);
});
