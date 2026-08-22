import { expect, test } from '@playwright/test';

// Todo 5 smoke assertions: the shell renders the auth pages, gates
// /dashboard for anonymous visitors, and shows an authenticated user the §43
// empty state (no fake deployment data anywhere).

const API_URL = 'http://localhost:3001';

test('sign-in page renders', async ({ page }) => {
  await page.goto('/sign-in');
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  await expect(page.getByLabel('Email')).toBeVisible();
  await expect(page.getByLabel('Password')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
});

test('sign-up page renders', async ({ page }) => {
  await page.goto('/sign-up');
  await expect(page.getByRole('heading', { name: 'Sign up' })).toBeVisible();
  await expect(page.getByLabel('Name')).toBeVisible();
  await expect(page.getByLabel('Email')).toBeVisible();
  await expect(page.getByLabel('Password')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Create account' })).toBeVisible();
});

test('unauthenticated visit to /dashboard redirects to /sign-in', async ({ page }) => {
  await page.goto('/dashboard');
  await page.waitForURL('/sign-in');
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
});

test('authenticated user reaches the dashboard and sees the §43 empty state', async ({ page }) => {
  // A fresh org has no deployments; the API returns { deployments: [] }.
  // The mock ensures the empty list is the source of truth even if a
  // prior test created deployments in the shared PGlite database.
  await page.route('**/api/deployments', (route) =>
    route.fulfill({ json: { deployments: [] } }),
  );

  const email = `e2e-${crypto.randomUUID().slice(0, 8)}@example.com`;

  await page.goto('/sign-up');
  await page.getByLabel('Name').fill('E2E User');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill('super-secret-1');
  await page.getByRole('button', { name: 'Create account' }).click();

  await page.waitForURL('/dashboard');
  await expect(page.getByRole('heading', { name: 'Deployments', exact: true })).toBeVisible();
  // §43 exact copy.
  await expect(
    page.getByRole('heading', { name: 'Your app is ready for private deployment' }),
  ).toBeVisible();
  await expect(page.getByText('Give your next customer their own AWS deployment.')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Create Customer Deployment' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'View Test Deployment' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Create Release' })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Dashboard' })).toBeVisible();
});

test('renaming the organization via §41 settings persists to the real API (regression: CORS blocked PATCH)', async ({
  page,
}) => {
  const email = `e2e-${crypto.randomUUID().slice(0, 8)}@example.com`;
  await page.goto('/sign-up');
  await page.getByLabel('Name').fill('E2E User');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill('super-secret-1');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL('/dashboard');

  await page.goto('/dashboard/settings');
  const newName = `Renamed Org ${crypto.randomUUID().slice(0, 8)}`;
  await page.getByLabel('Organization name').fill(newName);
  await page.getByRole('button', { name: 'Update Organization' }).click();
  await expect(page.getByRole('status')).toHaveText('Saved.');

  // Previously the API's CORS config only allowed GET,HEAD,POST, so the
  // browser blocked the PATCH preflight and the rename silently failed in the
  // browser. This reads the name back through the real API to prove the
  // write actually landed.
  const readBack = await page.request.get(`${API_URL}/api/organization`);
  expect(readBack.ok()).toBeTruthy();
  const organization = (await readBack.json()) as { name: string };
  expect(organization.name).toBe(newName);
});
