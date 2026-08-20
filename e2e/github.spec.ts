import { expect, test, type Page } from '@playwright/test';

// Todo 15 — GitHub App repo-selection. The API runs with GITHUB_FIXTURE_MODE
// (see playwright.config.ts), so the fixture org + repos render without a real
// GitHub App. The "Connect GitHub" empty state is exercised by intercepting
// the installations fetch and returning an empty list.

async function signUp(page: Page): Promise<void> {
  const email = `e2e-${crypto.randomUUID().slice(0, 8)}@example.com`;
  await page.goto('/sign-up');
  await page.getByLabel('Name').fill('E2E User');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill('super-secret-1');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL('/dashboard');
}

test('applications page lists the fixture installation and its repositories', async ({ page }) => {
  await signUp(page);
  await page.goto('/dashboard/applications');

  await expect(page.getByRole('heading', { name: 'Applications', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Choose a repository' })).toBeVisible();

  // The fixture org's installation + both §216 fixture repos.
  await expect(page.getByText('deployz-demo', { exact: true })).toBeVisible();
  await expect(page.getByText('express-api', { exact: true })).toBeVisible();
  await expect(page.getByText('legacy-redis', { exact: true })).toBeVisible();
});

test('shows the Connect GitHub empty state when there are no installations', async ({ page }) => {
  await signUp(page);

  await page.route('**/api/github/installations', (route) =>
    route.fulfill({ json: { installations: [], connectUrl: null } }),
  );

  await page.goto('/dashboard/applications');

  await expect(page.getByRole('heading', { name: 'Connect your code' })).toBeVisible();
  await expect(page.getByText('Connect GitHub', { exact: true })).toBeVisible();
  // The honest empty state never fabricates a repo list.
  await expect(page.getByText('express-api', { exact: true })).toHaveCount(0);
});

test('applications page renders for a fresh org without a real App', async ({ page }) => {
  await signUp(page);
  await page.goto('/dashboard/applications');
  // Fixture mode returns the demo installation, so the repo surface renders —
  // but the page header + shell are always present.
  await expect(page.getByRole('heading', { name: 'Applications', exact: true })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Dashboard' })).toBeVisible();
});
