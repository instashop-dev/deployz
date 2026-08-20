import { expect, test } from '@playwright/test';

// Todo 5 smoke assertions: the shell renders the auth pages, gates
// /dashboard for anonymous visitors, and shows an authenticated user the §43
// empty state (no fake deployment data anywhere).
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
  // The fleet dashboard (todo 19) fetches deployments; with none returned the
  // §43 empty state renders. Intercept the (not-yet-implemented) endpoint
  // before signup so the empty list is the source of truth.
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
  await expect(page.getByRole('heading', { name: 'No deployments yet' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Add your first customer' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Learn how it works' })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Dashboard' })).toBeVisible();
});
